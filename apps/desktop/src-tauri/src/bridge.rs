use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::Arc,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::{database, models::SaveProgressInput};

const FIRST_PORT: u16 = 49321;
const PORT_TRIES: u16 = 20;
const MAX_BODY: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub protocol_version: u32,
    pub app_version: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    path: String,
    existing_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    book_id: String,
    chapter_number: Option<i64>,
}

fn json_response(status: &str, value: serde_json::Value) -> Vec<u8> {
    let body =
        serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"serialize error\"}".to_vec());
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n",
        body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(body)
    .collect()
}

fn read_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Option<String>, Vec<u8>), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity(8192);
    let header_end;
    loop {
        let mut chunk = [0_u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("请求提前结束".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
        if buffer.len() > 64 * 1024 {
            return Err("请求头过大".to_string());
        }
    }
    let header = String::from_utf8(buffer[..header_end].to_vec())
        .map_err(|_| "请求头编码无效".to_string())?;
    let mut lines = header.split("\r\n");
    let request_line = lines.next().ok_or_else(|| "缺少请求行".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let authorization = lines
        .clone()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.trim().to_string());
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err("请求体过大".to_string());
    }
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0_u8; 8192];
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("请求体不完整".to_string());
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok((method, path, authorization, body))
}

fn valid_book_id(value: &str) -> bool {
    value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn serve(mut stream: TcpStream, app: AppHandle, token: Arc<String>) {
    let response = match read_request(&mut stream) {
        Ok((method, path, authorization, body)) => handle_request(
            &app,
            token.as_str(),
            authorization.as_deref(),
            &method,
            &path,
            &body,
        ),
        Err(error) => json_response("400 Bad Request", json!({ "error": error })),
    };
    let _ = stream.write_all(&response);
}

fn handle_request(
    app: &AppHandle,
    token: &str,
    authorization: Option<&str>,
    method: &str,
    path: &str,
    body: &[u8],
) -> Vec<u8> {
    if method == "OPTIONS" {
        return json_response("204 No Content", json!({}));
    }
    if path == "/v1/health" {
        return json_response("200 OK", json!({ "ok": true }));
    }
    if authorization != Some(&format!("Bearer {token}")) {
        return json_response("401 Unauthorized", json!({ "error": "Bridge token 无效" }));
    }
    if method == "POST" && path == "/v1/show" {
        crate::close_behavior::show_main_window(app);
        return json_response("200 OK", json!({ "ok": true }));
    }
    let state = app.state::<database::DatabaseState>();
    let connection = match state.connect() {
        Ok(connection) => connection,
        Err(error) => return json_response("500 Internal Server Error", json!({ "error": error })),
    };
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    let response = match (method, segments.as_slice()) {
        ("GET", ["v1", "manifest"]) => {
            let bridge = bridge_file_candidates(&state)
                .into_iter()
                .filter_map(|path| std::fs::read(path).ok())
                .find_map(|bytes| serde_json::from_slice::<BridgeInfo>(&bytes).ok());
            json!({
                "protocolVersion": 1,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "port": bridge.as_ref().map(|value| value.port),
                "sessionId": bridge.as_ref().map(|value| value.session_id.clone()),
                "capabilities": ["books", "chapters", "progress", "import", "open", "show"]
            })
        }
        ("GET", ["v1", "books"]) => match database::list_books(&connection) {
            Ok(books) => json!(books),
            Err(error) => {
                return json_response("500 Internal Server Error", json!({ "error": error }))
            }
        },
        ("GET", ["v1", "books", book_id]) if valid_book_id(book_id) => {
            match database::get_book(&connection, book_id) {
                Ok(book) => json!(book),
                Err(error) => {
                    return json_response("500 Internal Server Error", json!({ "error": error }))
                }
            }
        }
        ("GET", ["v1", "books", book_id, "chapters"]) if valid_book_id(book_id) => {
            match database::list_chapters(&connection, book_id) {
                Ok(chapters) => json!(chapters),
                Err(error) => {
                    return json_response("500 Internal Server Error", json!({ "error": error }))
                }
            }
        }
        ("GET", ["v1", "books", book_id, "chapters", number]) if valid_book_id(book_id) => {
            match number.parse::<i64>() {
                Ok(number) => match database::get_chapter(&connection, book_id, number) {
                    Ok(chapter) => json!(chapter),
                    Err(error) => {
                        return json_response(
                            "500 Internal Server Error",
                            json!({ "error": error }),
                        )
                    }
                },
                Err(_) => {
                    return json_response("400 Bad Request", json!({ "error": "章节编号无效" }))
                }
            }
        }
        ("POST", ["v1", "progress"]) => match serde_json::from_slice::<SaveProgressInput>(body) {
            Ok(input) => match database::save_progress(
                &connection,
                &input.book_id,
                input.chapter_number,
                input.chapter_progress,
            ) {
                Ok(()) => {
                    let _ = app.emit("bridge-progress-updated", &input);
                    json!({ "ok": true })
                }
                Err(error) => return json_response("400 Bad Request", json!({ "error": error })),
            },
            Err(error) => {
                return json_response("400 Bad Request", json!({ "error": error.to_string() }))
            }
        },
        ("POST", ["v1", "import"]) => match serde_json::from_slice::<ImportRequest>(body) {
            Ok(request)
                if Path::new(&request.path).is_absolute() && Path::new(&request.path).is_file() =>
            {
                let _ = app.emit(
                    "bridge-import-requested",
                    json!({ "path": request.path, "existingId": request.existing_id }),
                );
                json!({ "accepted": true })
            }
            Ok(_) => {
                return json_response(
                    "400 Bad Request",
                    json!({ "error": "导入路径必须是存在的绝对文件路径" }),
                )
            }
            Err(error) => {
                return json_response("400 Bad Request", json!({ "error": error.to_string() }))
            }
        },
        ("POST", ["v1", "open"]) => match serde_json::from_slice::<OpenRequest>(body) {
            Ok(request) if valid_book_id(&request.book_id) => {
                let _ = app.emit("bridge-open-requested", &request);
                json!({ "accepted": true })
            }
            Ok(_) => return json_response("400 Bad Request", json!({ "error": "书籍编号无效" })),
            Err(error) => {
                return json_response("400 Bad Request", json!({ "error": error.to_string() }))
            }
        },
        _ => return json_response("404 Not Found", json!({ "error": "接口不存在" })),
    };
    json_response("200 OK", response)
}

pub fn start(app: AppHandle) -> Result<BridgeInfo, String> {
    let token = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    let mut listener = None;
    for offset in 0..PORT_TRIES {
        if let Ok(candidate) = TcpListener::bind(("127.0.0.1", FIRST_PORT + offset)) {
            listener = Some((candidate, FIRST_PORT + offset));
            break;
        }
    }
    let (listener, port) = listener.ok_or_else(|| "无法找到可用的本地 Bridge 端口".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let token_for_thread = Arc::new(token.clone());
    let app_for_thread = app.clone();
    thread::spawn(move || loop {
        match listener.accept() {
            Ok((stream, _)) => {
                let app = app_for_thread.clone();
                let token = token_for_thread.clone();
                thread::spawn(move || serve(stream, app, token));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40))
            }
            Err(_) => break,
        }
    });
    let state = app.state::<database::DatabaseState>();
    let (data_directory, database_path) = state.storage_paths()?;
    let info = BridgeInfo {
        protocol_version: 1,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        port,
        token,
        pid: std::process::id(),
        session_id,
        data_directory: Some(data_directory.display().to_string()),
        database_path: Some(database_path.display().to_string()),
    };
    write_bridge_files(&app, &info)?;
    Ok(info)
}

fn bridge_file_candidates(state: &database::DatabaseState) -> Vec<std::path::PathBuf> {
    let mut directories = Vec::new();
    if let Ok(path) = std::env::current_exe() {
        if let Some(parent) = path.parent() {
            directories.push(parent.to_path_buf());
        }
    }
    directories.push(state.default_data_directory());
    if let Ok((data_directory, _)) = state.storage_paths() {
        directories.push(data_directory);
    }
    directories
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
        .fold(Vec::new(), |mut paths, directory| {
            let path = directory.join("bridge.json");
            if !paths.contains(&path) {
                paths.push(path);
            }
            paths
        })
}

fn bridge_directories(state: &database::DatabaseState) -> Vec<std::path::PathBuf> {
    bridge_file_candidates(state)
        .into_iter()
        .filter_map(|path| path.parent().map(std::path::Path::to_path_buf))
        .fold(Vec::new(), |mut directories, directory| {
            if !directories.contains(&directory) {
                directories.push(directory);
            }
            directories
        })
}

fn write_bridge_files(app: &AppHandle, info: &BridgeInfo) -> Result<(), String> {
    let state = app.state::<database::DatabaseState>();
    let payload = serde_json::to_vec_pretty(info).map_err(|error| error.to_string())?;
    let mut written = false;
    let mut errors = Vec::new();
    for directory in bridge_directories(&state) {
        if let Err(error) = fs::create_dir_all(&directory)
            .and_then(|_| fs::write(directory.join("bridge.json"), &payload))
        {
            errors.push(format!("{}：{}", directory.display(), error));
        } else {
            written = true;
        }
    }
    if written {
        if let Ok(install_directory) = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
            .ok_or(())
        {
            let locator = state.default_data_directory().join("bridge-location.json");
            let location = json!({
                "schemaVersion": 1,
                "bridgePath": install_directory.join("bridge.json").display().to_string()
            });
            let _ = fs::create_dir_all(&state.default_data_directory()).and_then(|_| {
                fs::write(
                    locator,
                    serde_json::to_vec_pretty(&location).unwrap_or_default(),
                )
            });
        }
        Ok(())
    } else {
        Err(format!("无法写入 Bridge 配置：{}", errors.join("；")))
    }
}

pub fn sync_storage_paths(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<database::DatabaseState>();
    let (data_directory, database_path) = state.storage_paths()?;
    let mut info = bridge_file_candidates(&state)
        .into_iter()
        .filter_map(|path| fs::read(path).ok())
        .find_map(|bytes| serde_json::from_slice::<BridgeInfo>(&bytes).ok())
        .ok_or_else(|| "Bridge 配置尚未启动".to_string())?;
    info.data_directory = Some(data_directory.display().to_string());
    info.database_path = Some(database_path.display().to_string());
    write_bridge_files(app, &info)
}

#[cfg(test)]
mod tests {
    use super::valid_book_id;

    #[test]
    fn accepts_safe_book_ids_only() {
        assert!(valid_book_id("book-123"));
        assert!(!valid_book_id("book/123"));
        assert!(!valid_book_id("book?id=123"));
        assert!(!valid_book_id(&"x".repeat(81)));
    }
}
