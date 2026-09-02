use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, OnceLock,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use regex::Regex;
use roxmltree::{Document, Node};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

const PROTOCOL_VERSION: u32 = 2;
const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EPUB_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EPUB_CHAPTER_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EPUB_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_EPUB_ENTRIES: usize = 20_000;
const MAX_EPUB_COMPRESSION_RATIO: u64 = 1_000;
const SCHEMA_VERSION: i64 = 1;
const IMPORT_CANCELLED: &str = "IMPORT_CANCELLED";
static LOG_LEVEL: OnceLock<String> = OnceLock::new();

static HTML_DANGEROUS_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)<script\b[^>]*>.*?</script\s*>|<style\b[^>]*>.*?</style\s*>|<svg\b[^>]*>.*?</svg\s*>|<iframe\b[^>]*>.*?</iframe\s*>|<object\b[^>]*>.*?</object\s*>",
    )
    .expect("valid dangerous HTML block regex")
});
static HTML_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<[^>]+>").expect("valid HTML tag regex"));
static HTML_BREAK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<br\s*/?>|</(?:p|div|section|article|li|h[1-6])\s*>")
        .expect("valid HTML break regex")
});
static HTML_ENTITY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(?:#([0-9]{1,7})|#(?:x|X)([0-9A-Fa-f]{1,6})|([A-Za-z]+));")
        .expect("valid HTML entity regex")
});
static HTML_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<h[1-6]\b[^>]*>(.*?)</h[1-6]\s*>").expect("valid HTML heading regex")
});
static CHAPTER_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节]\s*[:：、.．—-]?\s*(.*)$",
    )
    .expect("valid chapter heading regex")
});
static VOLUME_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[卷部篇册集]|[卷部篇册集]\s*[0-9零〇一二两三四五六七八九十百千万]+)",
    )
    .expect("valid volume heading regex")
});
static TXT_VOLUME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千万]+)\s*卷[\s　]*(.*)$")
        .expect("valid TXT volume regex")
});
static TXT_SECTION_DIVIDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[=＝_*—-]{4,}$").expect("valid TXT section divider regex"));

#[derive(Clone)]
struct RuntimeState {
    data_dir: PathBuf,
    db_path: PathBuf,
    token: Arc<String>,
    port: u16,
    session_id: String,
    storage_id: String,
    shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParseOptions {
    encoding: String,
    chapter_pattern: String,
    ad_patterns: String,
    merge_wrapped: bool,
    remove_ads: bool,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            encoding: "auto".to_string(),
            chapter_pattern: String::new(),
            ad_patterns:
                "更多精彩小说.*\n手机用户请访问.*\n请记住本书首发域名.*\n本章未完.*点击下一页"
                    .to_string(),
            merge_wrapped: true,
            remove_ads: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThemeSettings {
    preset: String,
    accent: String,
    background: String,
    text: String,
    overlay: f64,
    position_x: f64,
    position_y: f64,
    #[serde(default)]
    cover_asset_id: Option<String>,
}

impl Default for ThemeSettings {
    fn default() -> Self {
        Self {
            preset: "ink".to_string(),
            accent: "#c9a866".to_string(),
            background: "#101719".to_string(),
            text: "#f1f2ef".to_string(),
            overlay: 48.0,
            position_x: 50.0,
            position_y: 50.0,
            cover_asset_id: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChapterInput {
    number: i64,
    original_label: String,
    title: String,
    volume: String,
    #[serde(default = "default_chapter_kind")]
    kind: String,
    content: String,
    #[serde(default)]
    content_text: String,
    #[serde(default = "default_content_format")]
    content_format: String,
    word_count: i64,
}

fn default_chapter_kind() -> String {
    "chapter".to_string()
}
fn default_content_format() -> String {
    "text".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParsedResult {
    metadata: ParsedMetadata,
    chapters: Vec<ChapterInput>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ParsedMetadata {
    title: String,
    author: String,
    description: String,
    encoding: String,
    source_name: String,
    source_size: i64,
    #[serde(default = "default_source_format")]
    source_format: String,
    #[serde(default)]
    cover_data_url: Option<String>,
}

fn default_source_format() -> String {
    "txt".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Book {
    id: String,
    title: String,
    author: String,
    description: String,
    source_name: String,
    source_size: i64,
    encoding: String,
    source_format: String,
    #[serde(default)]
    cover_data_url: Option<String>,
    chapter_count: i64,
    total_words: i64,
    volumes: Vec<String>,
    theme: ThemeSettings,
    parse_options: ParseOptions,
    current_chapter: i64,
    progress: f64,
    chapter_progress: f64,
    created_at: i64,
    updated_at: i64,
    last_read_at: i64,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    managed_source_path: Option<String>,
    #[serde(default)]
    source_hash: Option<String>,
    #[serde(default)]
    revision: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Chapter {
    id: String,
    book_id: String,
    number: i64,
    original_label: String,
    title: String,
    volume: String,
    kind: String,
    content: String,
    content_text: String,
    word_count: i64,
    content_format: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    content_html: String,
    content_text: String,
    is_pinned: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressRequest {
    book_id: String,
    chapter_number: i64,
    chapter_progress: f64,
    #[serde(default)]
    anchor_offset: Option<i64>,
    #[serde(default)]
    paragraph_index: Option<i64>,
    #[serde(default)]
    line_index: Option<i64>,
    #[serde(default)]
    base_revision: Option<i64>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    sequence: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    path: String,
    #[serde(default)]
    existing_id: Option<String>,
    #[serde(default)]
    options: Option<ParseOptions>,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    retain_source: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    path: String,
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default)]
    book_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    source_path: String,
    state: String,
    progress: i64,
    message: String,
    #[serde(default)]
    result_book_id: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn append_runtime_log(state: &RuntimeState, event: &str) {
    if matches!(
        LOG_LEVEL.get().map(String::as_str),
        Some("error") | Some("warn")
    ) {
        return;
    }
    let log_path = state.data_dir.join("logs").join("runtime.log");
    if fs::metadata(&log_path)
        .map(|metadata| metadata.len() > 5 * 1024 * 1024)
        .unwrap_or(false)
    {
        let previous = state.data_dir.join("logs").join("runtime.log.1");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&log_path, previous);
    }
    if let Ok(mut log) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(log, "{} {}", now(), event);
    }
}

fn json_response(status: &str, value: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| {
        b"{\"error\":{\"code\":\"SERIALIZE_ERROR\",\"message\":\"serialize error\"}}".to_vec()
    });
    format!("HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: null\r\nAccess-Control-Allow-Headers: Authorization, Content-Type, X-Request-Id\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n\r\n", body.len()).into_bytes().into_iter().chain(body).collect()
}

fn error_response(
    status: &str,
    code: &str,
    message: impl Into<String>,
    retryable: bool,
) -> Vec<u8> {
    json_response(
        status,
        json!({"error": {"code": code, "message": message.into(), "retryable": retryable, "requestId": Uuid::new_v4().to_string(), "details": {}}}),
    )
}

fn read_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Option<String>, Vec<u8>), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let mut buffer = Vec::with_capacity(8192);
    let header_end;
    loop {
        let mut chunk = [0_u8; 8192];
        let read = stream.read(&mut chunk).map_err(|e| e.to_string())?;
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
        let read = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            return Err("请求体不完整".to_string());
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok((method, path, authorization, body))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn open_db(state: &RuntimeState) -> Result<Connection, String> {
    let connection = Connection::open(&state.db_path).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
        .map_err(|e| e.to_string())?;
    validate_existing_database(&connection)?;
    migrate(&connection)?;
    Ok(connection)
}

fn validate_existing_database(connection: &Connection) -> Result<(), String> {
    let has_metadata = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_meta'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if has_metadata {
        let version = connection
            .query_row(
                "SELECT value FROM library_meta WHERE key='schemaVersion'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(raw) = version {
            let version = raw
                .parse::<i64>()
                .map_err(|_| "本地书库 schemaVersion 无效".to_string())?;
            if version > SCHEMA_VERSION {
                return Err(format!(
                    "本地书库版本 {version} 高于当前 Runtime 支持的版本 {SCHEMA_VERSION}，请升级插件"
                ));
            }
        }
    }
    let has_books = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='books'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !has_books {
        return Ok(());
    }
    let mut statement = connection
        .prepare("PRAGMA table_info(books)")
        .map_err(|e| e.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    let required = [
        "source_path",
        "managed_source_path",
        "source_hash",
        "revision",
    ];
    if required.iter().any(|column| !columns.contains(*column)) {
        return Err(
            "所选目录包含桌面端或不兼容数据库，请使用迁移包导入，不能由本地 Runtime 直接打开"
                .to_string(),
        );
    }
    Ok(())
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
            source_name TEXT NOT NULL DEFAULT '', source_size INTEGER NOT NULL DEFAULT 0, encoding TEXT NOT NULL DEFAULT '',
            source_format TEXT NOT NULL DEFAULT 'txt', cover_data_url TEXT, chapter_count INTEGER NOT NULL DEFAULT 0,
            total_words INTEGER NOT NULL DEFAULT 0, volumes_json TEXT NOT NULL DEFAULT '[]', theme_json TEXT NOT NULL DEFAULT '{}',
            parse_options_json TEXT NOT NULL DEFAULT '{}', current_chapter INTEGER NOT NULL DEFAULT 1, progress REAL NOT NULL DEFAULT 0,
            chapter_progress REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL,
            source_path TEXT, managed_source_path TEXT, source_hash TEXT, revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chapters (
            id TEXT PRIMARY KEY NOT NULL, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE, number INTEGER NOT NULL,
            original_label TEXT NOT NULL, title TEXT NOT NULL, volume TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'chapter',
            content TEXT NOT NULL, content_text TEXT NOT NULL DEFAULT '', word_count INTEGER NOT NULL DEFAULT 0, content_format TEXT NOT NULL DEFAULT 'text',
            UNIQUE(book_id, number)
        );
        CREATE TABLE IF NOT EXISTS reading_progress (
            book_id TEXT PRIMARY KEY NOT NULL REFERENCES books(id) ON DELETE CASCADE, chapter_number INTEGER NOT NULL,
            chapter_progress REAL NOT NULL DEFAULT 0, anchor_offset INTEGER, paragraph_index INTEGER, line_index INTEGER,
            revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '', sequence INTEGER
        );
        CREATE TABLE IF NOT EXISTS import_jobs (
            id TEXT PRIMARY KEY NOT NULL, source_path TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '', result_book_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, content_html TEXT NOT NULL DEFAULT '',
            content_text TEXT NOT NULL DEFAULT '', is_pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chapters_book_number ON chapters(book_id, number);
    "#).map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO library_meta(key, value) VALUES('schemaVersion', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_storage_id(connection: &Connection) -> Result<String, String> {
    let existing = connection
        .query_row(
            "SELECT value FROM library_meta WHERE key='storageId'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(storage_id) = existing.as_ref().filter(|value| valid_id(value)) {
        return Ok(storage_id.clone());
    }
    let storage_id = format!("local-{}", Uuid::new_v4().simple());
    if existing.is_some() {
        connection
            .execute(
                "UPDATE library_meta SET value=?1 WHERE key='storageId'",
                params![storage_id],
            )
            .map_err(|e| e.to_string())?;
        return Ok(storage_id);
    }
    connection
        .execute(
            "INSERT INTO library_meta(key, value) VALUES('storageId', ?1) ON CONFLICT(key) DO NOTHING",
            params![storage_id],
        )
        .map_err(|e| e.to_string())?;
    connection
        .query_row(
            "SELECT value FROM library_meta WHERE key='storageId'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())
}

fn get_book(connection: &Connection, id: &str) -> Result<Option<Book>, String> {
    connection.query_row("SELECT id,title,author,description,source_name,source_size,encoding,source_format,cover_data_url,chapter_count,total_words,volumes_json,theme_json,parse_options_json,current_chapter,progress,chapter_progress,created_at,updated_at,last_read_at,source_path,managed_source_path,source_hash,revision FROM books WHERE id=?1", params![id], |row| {
        let volumes_json: String = row.get(11)?;
        let theme_json: String = row.get(12)?;
        let options_json: String = row.get(13)?;
        Ok(Book {
            id: row.get(0)?, title: row.get(1)?, author: row.get(2)?, description: row.get(3)?, source_name: row.get(4)?, source_size: row.get(5)?, encoding: row.get(6)?, source_format: row.get(7)?, cover_data_url: row.get(8)?, chapter_count: row.get(9)?, total_words: row.get(10)?, volumes: serde_json::from_str(&volumes_json).unwrap_or_default(), theme: serde_json::from_str(&theme_json).unwrap_or_default(), parse_options: serde_json::from_str(&options_json).unwrap_or_default(), current_chapter: row.get(14)?, progress: row.get(15)?, chapter_progress: row.get(16)?, created_at: row.get(17)?, updated_at: row.get(18)?, last_read_at: row.get(19)?, source_path: row.get(20)?, managed_source_path: row.get(21)?, source_hash: row.get(22)?, revision: row.get(23)?,
        })
    }).optional().map_err(|e| e.to_string())
}

fn list_books(connection: &Connection) -> Result<Vec<Book>, String> {
    let mut statement = connection
        .prepare("SELECT id FROM books ORDER BY last_read_at DESC, updated_at DESC")
        .map_err(|e| e.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    ids.iter()
        .map(|id| get_book(connection, id)?.ok_or_else(|| "书籍不存在".to_string()))
        .collect()
}

fn list_chapters(connection: &Connection, book_id: &str) -> Result<Vec<Chapter>, String> {
    let mut statement = connection.prepare("SELECT id,book_id,number,original_label,title,volume,kind,content,content_text,word_count,content_format FROM chapters WHERE book_id=?1 ORDER BY number").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![book_id], |row| {
            Ok(Chapter {
                id: row.get(0)?,
                book_id: row.get(1)?,
                number: row.get(2)?,
                original_label: row.get(3)?,
                title: row.get(4)?,
                volume: row.get(5)?,
                kind: row.get(6)?,
                content: row.get(7)?,
                content_text: row.get(8)?,
                word_count: row.get(9)?,
                content_format: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>();
    rows.map_err(|e| e.to_string())
}

fn list_notes(connection: &Connection) -> Result<Vec<Note>, String> {
    let mut statement = connection
        .prepare("SELECT id,title,content_html,content_text,is_pinned,created_at,updated_at FROM notes ORDER BY is_pinned DESC, updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content_html: row.get(2)?,
                content_text: row.get(3)?,
                is_pinned: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>();
    rows.map_err(|e| e.to_string())
}

fn decode_text(bytes: &[u8], requested: &str) -> (String, String) {
    let (encoding, text) = match requested {
        "utf-16le" => ("utf-16le", UTF_16LE.decode(bytes).0.into_owned()),
        "utf-16be" => ("utf-16be", UTF_16BE.decode(bytes).0.into_owned()),
        "gb18030" => ("gb18030", GB18030.decode(bytes).0.into_owned()),
        "utf-8" => ("utf-8", UTF_8.decode(bytes).0.into_owned()),
        _ if bytes.starts_with(&[0xff, 0xfe]) => {
            ("utf-16le", UTF_16LE.decode(&bytes[2..]).0.into_owned())
        }
        _ if bytes.starts_with(&[0xfe, 0xff]) => {
            ("utf-16be", UTF_16BE.decode(&bytes[2..]).0.into_owned())
        }
        _ if bytes.starts_with(&[0xef, 0xbb, 0xbf]) => {
            ("utf-8", UTF_8.decode(&bytes[3..]).0.into_owned())
        }
        _ if std::str::from_utf8(bytes).is_ok() => ("utf-8", UTF_8.decode(bytes).0.into_owned()),
        _ => ("gb18030", GB18030.decode(bytes).0.into_owned()),
    };
    (
        encoding.to_string(),
        text.trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n"),
    )
}

fn clean_text(lines: &[String], options: &ParseOptions) -> String {
    let patterns = options
        .ad_patterns
        .lines()
        .filter_map(|value| Regex::new(value.trim()).ok())
        .collect::<Vec<_>>();
    let mut paragraphs: Vec<String> = Vec::new();
    for raw in lines {
        let line = raw.trim().to_string();
        if line.is_empty() || TXT_VOLUME_RE.is_match(&line) {
            continue;
        }
        if options.remove_ads && patterns.iter().any(|pattern| pattern.is_match(&line)) {
            continue;
        }
        if let Some(previous) = paragraphs.last_mut() {
            let starts_punctuation = line
                .chars()
                .next()
                .map(|c| "，。！？；：、）》”’…".contains(c))
                .unwrap_or(false);
            let previous_ends = previous
                .chars()
                .last()
                .map(|c| "。！？!?；;：:“”’》）】…".contains(c))
                .unwrap_or(true);
            if starts_punctuation || (options.merge_wrapped && !previous_ends) {
                previous.push_str(&line);
                continue;
            }
        }
        paragraphs.push(line);
    }
    paragraphs.join("\n\n")
}

fn parse_txt(bytes: &[u8], filename: &str, options: &ParseOptions) -> Result<ParsedResult, String> {
    let (encoding, text) = decode_text(bytes, &options.encoding);
    let lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    let source_title = filename
        .strip_suffix(".txt")
        .or_else(|| filename.strip_suffix(".text"))
        .unwrap_or(filename)
        .trim()
        .to_string();
    let header_lines = lines
        .iter()
        .take(160)
        .map(|line| line.trim())
        .collect::<Vec<_>>();
    let header = header_lines
        .iter()
        .copied()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let title = header
        .iter()
        .find_map(|line| {
            Regex::new(r"《([^》]{1,80})》")
                .ok()
                .and_then(|re| re.captures(line).map(|m| m[1].to_string()))
        })
        .unwrap_or(source_title);
    let author = header
        .iter()
        .find_map(|line| {
            Regex::new(r"^(?:作者|作 者)[：:]\s*(.+)$")
                .ok()
                .and_then(|re| re.captures(line).map(|m| m[1].trim().to_string()))
        })
        .unwrap_or_else(|| "佚名".to_string());
    let chapter_re = if !options.chapter_pattern.trim().is_empty() {
        Regex::new(options.chapter_pattern.trim()).map_err(|e| format!("章节正则无效：{e}"))?
    } else {
        Regex::new(r"^第\s*([0-9]{1,5}|[零〇一二两三四五六七八九十百千万]+)\s*[章回节](?:[\s　:：、.．—-]+(.{1,80}))?$").unwrap()
    };
    let special_re =
        Regex::new(r"^(序章|楔子|引子|后记|尾声)(?:[\s　:：、.．—-]+(.{1,80}))?$").unwrap();
    let extra_re = Regex::new(
        r"^(番外(?:篇)?[0-9零〇一二两三四五六七八九十百千万两]*)(?:[\s　:：、.．—-]+(.{1,80}))?$",
    )
    .unwrap();
    let finale_re = Regex::new(
        r"^((?:收官章|终章)[0-9零〇一二两三四五六七八九十百千万两]*|大结局)(?:[\s　:：、.．—-]+(.{1,80}))?$",
    )
    .unwrap();
    let mut headers: Vec<(usize, String, String, String)> = Vec::new();
    let mut volume = String::new();
    for (index, raw) in lines.iter().enumerate() {
        let line = raw.trim();
        if let Some(capture) = TXT_VOLUME_RE.captures(line) {
            volume = if capture
                .get(2)
                .map(|m| !m.as_str().trim().is_empty())
                .unwrap_or(false)
            {
                format!("第{}卷 {}", &capture[1], capture[2].trim())
            } else {
                format!("第{}卷", &capture[1])
            };
            continue;
        }
        if let Some(capture) = chapter_re
            .captures(line)
            .or_else(|| special_re.captures(line))
            .or_else(|| extra_re.captures(line))
            .or_else(|| finale_re.captures(line))
        {
            let label = capture
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| "章节".to_string());
            let title = capture
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| label.to_string());
            headers.push((index, label, title, volume.clone()));
        }
    }
    let mut warnings = Vec::new();
    if headers.is_empty() {
        warnings.push("未检测到章节标题，已将全文作为单章导入".to_string());
        headers.push((
            usize::MAX,
            "正文".to_string(),
            "正文".to_string(),
            String::new(),
        ));
    }
    let mut chapters = Vec::new();
    for (position, header) in headers.iter().enumerate() {
        let start = if header.0 == usize::MAX {
            0
        } else {
            header.0 + 1
        };
        let end = headers
            .get(position + 1)
            .map(|next| next.0)
            .filter(|value| *value != usize::MAX)
            .unwrap_or(lines.len());
        let content = clean_text(
            &lines[start.min(lines.len())..end.min(lines.len())],
            options,
        );
        let word_count = content.chars().filter(|c| !c.is_whitespace()).count() as i64;
        chapters.push(ChapterInput {
            number: (position + 1) as i64,
            original_label: header.1.clone(),
            title: header.2.clone(),
            volume: header.3.clone(),
            kind: "chapter".to_string(),
            content: content.clone(),
            content_text: content,
            content_format: "text".to_string(),
            word_count,
        });
    }
    let intro_index = header_lines
        .iter()
        .position(|line| matches!(line.trim_end_matches(['：', ':']), "内容简介" | "简介"));
    let mut description_lines = Vec::new();
    if let Some(intro_index) = intro_index {
        for line in header_lines.iter().skip(intro_index + 1) {
            let is_heading = chapter_re.is_match(line)
                || special_re.is_match(line)
                || extra_re.is_match(line)
                || finale_re.is_match(line);
            if TXT_SECTION_DIVIDER_RE.is_match(line) || TXT_VOLUME_RE.is_match(line) || is_heading {
                break;
            }
            if line.is_empty() {
                if !description_lines.is_empty() {
                    break;
                }
                continue;
            }
            description_lines.push((*line).to_string());
            if description_lines.len() >= 7 {
                break;
            }
        }
    }
    let description = description_lines
        .join("\n")
        .chars()
        .take(600)
        .collect::<String>();
    let empty = chapters
        .iter()
        .filter(|chapter| chapter.content.is_empty())
        .count();
    let short = chapters
        .iter()
        .filter(|chapter| chapter.word_count > 0 && chapter.word_count < 100)
        .count();
    if empty > 0 {
        warnings.push(format!("有 {empty} 章没有正文，请检查章节规则"));
    }
    if short > 0 {
        warnings.push(format!("有 {short} 章少于 100 字，可能存在误拆分"));
    }
    Ok(ParsedResult {
        metadata: ParsedMetadata {
            title,
            author,
            description,
            encoding,
            source_name: filename.to_string(),
            source_size: bytes.len() as i64,
            source_format: "txt".to_string(),
            cover_data_url: None,
        },
        chapters,
        warnings,
    })
}

fn decode_html_entities(value: &str) -> String {
    HTML_ENTITY_RE
        .replace_all(value, |capture: &regex::Captures<'_>| {
            let decoded = if let Some(decimal) = capture.get(1) {
                decimal
                    .as_str()
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
            } else if let Some(hexadecimal) = capture.get(2) {
                u32::from_str_radix(hexadecimal.as_str(), 16)
                    .ok()
                    .and_then(char::from_u32)
            } else {
                match capture
                    .get(3)
                    .map(|value| value.as_str().to_ascii_lowercase())
                    .as_deref()
                {
                    Some("nbsp") => Some(' '),
                    Some("quot") => Some('"'),
                    Some("apos") => Some('\''),
                    Some("amp") => Some('&'),
                    Some("lt") => Some('<'),
                    Some("gt") => Some('>'),
                    _ => None,
                }
            };
            decoded
                .map(|character| character.to_string())
                .unwrap_or_else(|| capture[0].to_string())
        })
        .into_owned()
}

fn strip_html(value: &str) -> String {
    let without_dangerous = HTML_DANGEROUS_BLOCK_RE.replace_all(value, "");
    let with_breaks = HTML_BREAK_RE.replace_all(&without_dangerous, "\n");
    let without_tags = HTML_TAG_RE.replace_all(&with_breaks, " ");
    decode_html_entities(&without_tags)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn normalized_heading(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

#[derive(Debug, Clone)]
struct ParsedChapterHeading {
    label: String,
    title: String,
}

fn parse_epub_chapter_heading(value: &str) -> Option<ParsedChapterHeading> {
    let capture = CHAPTER_HEADING_RE.captures(value.trim())?;
    let label = capture.get(1)?.as_str().to_string();
    let title = capture
        .get(2)
        .map(|value| {
            value
                .as_str()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| value.split_whitespace().collect::<Vec<_>>().join(" "));
    Some(ParsedChapterHeading { label, title })
}

fn is_epub_volume_title(value: &str) -> bool {
    VOLUME_HEADING_RE.is_match(&value.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn xml_node_text(node: Node<'_, '_>) -> String {
    node.descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn xml_attribute(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.attributes()
        .find(|attribute| attribute.name().eq_ignore_ascii_case(name))
        .map(|attribute| attribute.value().to_string())
}

#[derive(Debug, Clone)]
struct EpubManifestItem {
    path: String,
    media_type: String,
    properties: String,
}

#[derive(Debug, Clone)]
struct EpubNavigationEntry {
    path: String,
    fragment: Option<String>,
    title: String,
    volume: String,
}

fn split_epub_href(base: &Path, href: &str) -> Result<(String, Option<String>), String> {
    let (path, fragment) = href
        .split_once('#')
        .map(|(path, fragment)| (path, Some(percent_decode(fragment))))
        .unwrap_or((href, None));
    Ok((
        normalized_zip_path(base, path)?,
        fragment.filter(|value| !value.is_empty()),
    ))
}

fn direct_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name().eq_ignore_ascii_case(name))
}

fn walk_epub3_navigation(
    list: Node<'_, '_>,
    base: &Path,
    parent_volume: &str,
    output: &mut Vec<EpubNavigationEntry>,
) {
    for item in list
        .children()
        .filter(|child| child.is_element() && child.tag_name().name().eq_ignore_ascii_case("li"))
    {
        let label_node = direct_child(item, "a").or_else(|| direct_child(item, "span"));
        let title = label_node.map(xml_node_text).unwrap_or_default();
        let child_list = direct_child(item, "ol");
        let volume = if child_list.is_some() && is_epub_volume_title(&title) {
            title.clone()
        } else {
            parent_volume.to_string()
        };
        if let Some(href) = label_node.and_then(|node| xml_attribute(node, "href")) {
            if let Ok((path, fragment)) = split_epub_href(base, &href) {
                output.push(EpubNavigationEntry {
                    path,
                    fragment,
                    title: title.clone(),
                    volume: volume.clone(),
                });
            }
        }
        if let Some(children) = child_list {
            walk_epub3_navigation(children, base, &volume, output);
        }
    }
}

fn parse_epub3_navigation(source: &str, path: &str) -> Vec<EpubNavigationEntry> {
    let sanitized = source.replace("&nbsp;", "&#160;");
    let Ok(document) = Document::parse(&sanitized) else {
        return Vec::new();
    };
    let navigation = document
        .descendants()
        .find(|node| {
            node.is_element()
                && node.tag_name().name().eq_ignore_ascii_case("nav")
                && node.attributes().any(|attribute| {
                    attribute.name().eq_ignore_ascii_case("type")
                        && attribute
                            .value()
                            .split_whitespace()
                            .any(|value| value == "toc")
                })
        })
        .or_else(|| {
            document.descendants().find(|node| {
                node.is_element() && node.tag_name().name().eq_ignore_ascii_case("nav")
            })
        });
    let Some(list) = navigation.and_then(|node| direct_child(node, "ol")) else {
        return Vec::new();
    };
    let base = Path::new(path).parent().unwrap_or(Path::new(""));
    let mut output = Vec::new();
    walk_epub3_navigation(list, base, "", &mut output);
    output
}

fn walk_ncx_navigation(
    parent: Node<'_, '_>,
    base: &Path,
    parent_volume: &str,
    output: &mut Vec<EpubNavigationEntry>,
) {
    for point in parent.children().filter(|child| {
        child.is_element() && child.tag_name().name().eq_ignore_ascii_case("navPoint")
    }) {
        let title = direct_child(point, "navLabel")
            .map(xml_node_text)
            .unwrap_or_default();
        let has_children = point.children().any(|child| {
            child.is_element() && child.tag_name().name().eq_ignore_ascii_case("navPoint")
        });
        let volume = if has_children && is_epub_volume_title(&title) {
            title.clone()
        } else {
            parent_volume.to_string()
        };
        if let Some(source) =
            direct_child(point, "content").and_then(|node| xml_attribute(node, "src"))
        {
            if let Ok((path, fragment)) = split_epub_href(base, &source) {
                output.push(EpubNavigationEntry {
                    path,
                    fragment,
                    title: title.clone(),
                    volume: volume.clone(),
                });
            }
        }
        walk_ncx_navigation(point, base, &volume, output);
    }
}

fn parse_ncx_navigation(source: &str, path: &str) -> Vec<EpubNavigationEntry> {
    let Ok(document) = Document::parse(source) else {
        return Vec::new();
    };
    let Some(map) = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("navMap"))
    else {
        return Vec::new();
    };
    let base = Path::new(path).parent().unwrap_or(Path::new(""));
    let mut output = Vec::new();
    walk_ncx_navigation(map, base, "", &mut output);
    output
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn normalized_zip_path(base: &Path, href: &str) -> Result<String, String> {
    let href = href
        .split(['#', '?'])
        .next()
        .map(percent_decode)
        .unwrap_or_default()
        .replace('\\', "/");
    if href.starts_with('/') || href.contains('\0') {
        return Err("EPUB 包含无效的绝对资源路径".to_string());
    }
    let combined = if base.as_os_str().is_empty() {
        href
    } else {
        format!("{}/{}", base.to_string_lossy().replace('\\', "/"), href)
    };
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("EPUB 资源路径越界".to_string());
                }
            }
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return Err("EPUB 资源路径为空".to_string());
    }
    Ok(parts.join("/"))
}

fn read_zip_text(
    archive: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    path: &str,
    maximum: u64,
) -> Result<String, String> {
    let mut file = archive
        .by_name(path)
        .map_err(|_| format!("EPUB 缺少资源：{path}"))?;
    if file.size() > maximum {
        return Err(format!("EPUB 资源过大：{path}"));
    }
    let mut value = String::with_capacity(file.size().min(maximum) as usize);
    file.read_to_string(&mut value)
        .map_err(|e| format!("EPUB 资源编码无效（{path}）：{e}"))?;
    Ok(value)
}

fn read_zip_bytes(
    archive: &mut ZipArchive<std::io::Cursor<&[u8]>>,
    path: &str,
    maximum: u64,
) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_name(path)
        .map_err(|_| format!("EPUB 缺少资源：{path}"))?;
    if file.size() > maximum {
        return Err(format!("EPUB 资源过大：{path}"));
    }
    let mut value = Vec::with_capacity(file.size().min(maximum) as usize);
    file.read_to_end(&mut value)
        .map_err(|error| format!("EPUB 资源读取失败（{path}）：{error}"))?;
    Ok(value)
}

fn first_epub_heading(html: &str) -> Option<String> {
    HTML_HEADING_RE
        .captures_iter(html)
        .filter_map(|capture| capture.get(1).map(|value| strip_html(value.as_str())))
        .find(|value| !value.is_empty())
}

fn first_epub_chapter_heading(html: &str) -> Option<ParsedChapterHeading> {
    HTML_HEADING_RE.captures_iter(html).find_map(|capture| {
        capture
            .get(1)
            .map(|value| strip_html(value.as_str()))
            .and_then(|value| parse_epub_chapter_heading(&value))
    })
}

fn epub_document_title(html: &str) -> Option<String> {
    Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>")
        .expect("valid EPUB title regex")
        .captures(html)
        .and_then(|capture| capture.get(1))
        .map(|value| strip_html(value.as_str()))
        .filter(|value| !value.is_empty())
}

fn strip_epub_content_prefix<'a>(
    html: &'a str,
    source_title: &str,
    chapter_heading: Option<&ParsedChapterHeading>,
) -> &'a str {
    let target = normalized_heading(source_title);
    for capture in HTML_HEADING_RE.captures_iter(html) {
        let Some(whole) = capture.get(0) else {
            continue;
        };
        let heading = capture
            .get(1)
            .map(|value| strip_html(value.as_str()))
            .unwrap_or_default();
        let matches_chapter =
            chapter_heading.is_some() && parse_epub_chapter_heading(&heading).is_some();
        if matches_chapter || normalized_heading(&heading) == target {
            return &html[whole.end()..];
        }
    }
    html
}

fn epub_fragment_offset(html: &str, fragment: &str) -> Option<usize> {
    let escaped = regex::escape(fragment);
    let pattern = Regex::new(&format!(
        r#"(?is)<[A-Za-z][^>]*(?:id|name)\s*=\s*(?:"{escaped}"|'{escaped}')[^>]*>"#
    ))
    .ok()?;
    pattern.find(html).map(|value| value.start())
}

fn parse_epub(bytes: &[u8], filename: &str) -> Result<ParsedResult, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|error| format!("EPUB 解包失败：{error}"))?;
    if archive.len() > MAX_EPUB_ENTRIES {
        return Err(format!("EPUB 文件条目超过 {MAX_EPUB_ENTRIES} 个限制"));
    }
    let expanded_size = (0..archive.len()).try_fold(0_u64, |total, index| {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let size = file.size();
        let compressed = file.compressed_size();
        if size > 10 * 1024 * 1024
            && compressed > 0
            && size / compressed.max(1) > MAX_EPUB_COMPRESSION_RATIO
        {
            return Err("EPUB 包含异常压缩比资源".to_string());
        }
        total
            .checked_add(size)
            .filter(|value| *value <= MAX_EPUB_EXPANDED_BYTES)
            .ok_or_else(|| "EPUB 解压后内容超过 1 GB 限制".to_string())
    })?;
    if expanded_size == 0 {
        return Err("EPUB 内容为空".to_string());
    }

    let container = read_zip_text(
        &mut archive,
        "META-INF/container.xml",
        MAX_EPUB_METADATA_BYTES,
    )?;
    let container_document =
        Document::parse(&container).map_err(|error| format!("EPUB container.xml 无效：{error}"))?;
    let rootfile = container_document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("rootfile"))
        .and_then(|node| xml_attribute(node, "full-path"))
        .ok_or_else(|| "EPUB OPF 路径无效".to_string())?;
    let rootfile = normalized_zip_path(Path::new(""), &rootfile)?;
    let opf = read_zip_text(&mut archive, &rootfile, MAX_EPUB_METADATA_BYTES)?;
    let base = Path::new(&rootfile).parent().unwrap_or(Path::new(""));
    let opf_document = Document::parse(&opf).map_err(|error| format!("EPUB OPF 无效：{error}"))?;
    let metadata = opf_document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("metadata"));
    let metadata_text = |name: &str| {
        metadata
            .and_then(|parent| {
                parent.descendants().find(|node| {
                    node.is_element() && node.tag_name().name().eq_ignore_ascii_case(name)
                })
            })
            .map(xml_node_text)
            .filter(|value| !value.is_empty())
    };
    let title =
        metadata_text("title").unwrap_or_else(|| filename.trim_end_matches(".epub").to_string());
    let author = metadata_text("creator").unwrap_or_else(|| "佚名".to_string());
    let mut description = metadata_text("description").unwrap_or_default();

    let manifest_node = opf_document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("manifest"));
    let mut manifest = HashMap::new();
    if let Some(manifest_node) = manifest_node {
        for item in manifest_node
            .children()
            .filter(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("item"))
        {
            let Some(id) = xml_attribute(item, "id") else {
                continue;
            };
            let Some(href) = xml_attribute(item, "href") else {
                continue;
            };
            manifest.insert(
                id.clone(),
                EpubManifestItem {
                    path: normalized_zip_path(base, &href)?,
                    media_type: xml_attribute(item, "media-type").unwrap_or_default(),
                    properties: xml_attribute(item, "properties").unwrap_or_default(),
                },
            );
        }
    }

    let spine = opf_document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case("spine"));
    let spine_toc_id = spine.and_then(|node| xml_attribute(node, "toc"));
    let mut spine_paths = Vec::new();
    if let Some(spine) = spine {
        for item in spine.children().filter(|node| {
            node.is_element() && node.tag_name().name().eq_ignore_ascii_case("itemref")
        }) {
            if xml_attribute(item, "linear")
                .map(|value| value.eq_ignore_ascii_case("no"))
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(manifest_item) = xml_attribute(item, "idref")
                .and_then(|id| manifest.get(&id))
                .filter(|item| item.media_type.contains("html"))
            {
                spine_paths.push(manifest_item.path.clone());
            }
        }
    }

    let mut navigation = Vec::new();
    if let Some(nav_item) = manifest.values().find(|item| {
        item.properties
            .split_whitespace()
            .any(|property| property.eq_ignore_ascii_case("nav"))
    }) {
        if let Ok(source) = read_zip_text(&mut archive, &nav_item.path, MAX_EPUB_METADATA_BYTES) {
            navigation = parse_epub3_navigation(&source, &nav_item.path);
        }
    }
    if navigation.is_empty() {
        let ncx_item = spine_toc_id
            .as_ref()
            .and_then(|id| manifest.get(id))
            .or_else(|| {
                manifest
                    .values()
                    .find(|item| item.media_type.contains("x-dtbncx"))
            });
        if let Some(ncx_item) = ncx_item {
            if let Ok(source) = read_zip_text(&mut archive, &ncx_item.path, MAX_EPUB_METADATA_BYTES)
            {
                navigation = parse_ncx_navigation(&source, &ncx_item.path);
            }
        }
    }

    let html_paths = manifest
        .values()
        .filter(|item| item.media_type.contains("html"))
        .map(|item| item.path.as_str())
        .collect::<HashSet<_>>();
    navigation.retain(|entry| html_paths.contains(entry.path.as_str()));
    let used_navigation = !navigation.is_empty();
    if navigation.is_empty() {
        navigation = spine_paths
            .into_iter()
            .map(|path| EpubNavigationEntry {
                path,
                fragment: None,
                title: String::new(),
                volume: String::new(),
            })
            .collect();
    }

    let cover_id = metadata.and_then(|parent| {
        parent
            .descendants()
            .find(|node| {
                node.is_element()
                    && node.tag_name().name().eq_ignore_ascii_case("meta")
                    && xml_attribute(*node, "name")
                        .map(|value| value.eq_ignore_ascii_case("cover"))
                        .unwrap_or(false)
            })
            .and_then(|node| xml_attribute(node, "content"))
    });
    let cover_item = manifest
        .values()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property.eq_ignore_ascii_case("cover-image"))
        })
        .or_else(|| cover_id.as_ref().and_then(|id| manifest.get(id)));
    let cover_data_url = cover_item.and_then(|item| {
        read_zip_bytes(&mut archive, &item.path, MAX_EPUB_CHAPTER_BYTES)
            .ok()
            .filter(|bytes| !bytes.is_empty())
            .map(|bytes| {
                format!(
                    "data:{};base64,{}",
                    if item.media_type.is_empty() {
                        "application/octet-stream"
                    } else {
                        item.media_type.as_str()
                    },
                    BASE64_STANDARD.encode(bytes)
                )
            })
    });

    let mut chapters = Vec::new();
    let mut seen_numbered_chapter = false;
    for (index, entry) in navigation.iter().enumerate() {
        let html = read_zip_text(&mut archive, &entry.path, MAX_EPUB_CHAPTER_BYTES)?;
        let start = entry
            .fragment
            .as_deref()
            .and_then(|fragment| epub_fragment_offset(&html, fragment))
            .unwrap_or(0);
        let end = navigation
            .get(index + 1)
            .filter(|next| next.path == entry.path)
            .and_then(|next| next.fragment.as_deref())
            .and_then(|fragment| epub_fragment_offset(&html, fragment))
            .filter(|end| *end > start)
            .unwrap_or(html.len());
        let source = &html[start..end];
        let source_title = if !entry.title.trim().is_empty() {
            entry.title.split_whitespace().collect::<Vec<_>>().join(" ")
        } else {
            first_epub_heading(source)
                .or_else(|| epub_document_title(source))
                .unwrap_or_else(|| format!("未命名内容 {}", index + 1))
        };
        let chapter_heading = parse_epub_chapter_heading(&source_title)
            .or_else(|| first_epub_chapter_heading(source));
        let kind = if chapter_heading.is_some() {
            seen_numbered_chapter = true;
            "chapter"
        } else if is_epub_volume_title(&source_title)
            || (!entry.volume.is_empty()
                && normalized_heading(&source_title) == normalized_heading(&entry.volume))
        {
            "volume"
        } else if !entry.volume.is_empty() {
            seen_numbered_chapter = true;
            "chapter"
        } else if !seen_numbered_chapter {
            "frontmatter"
        } else {
            "appendix"
        };
        let content_source =
            strip_epub_content_prefix(source, &source_title, chapter_heading.as_ref());
        let content_text = strip_html(content_source);
        let word_count = content_text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count() as i64;
        chapters.push(ChapterInput {
            number: (chapters.len() + 1) as i64,
            original_label: chapter_heading
                .as_ref()
                .map(|heading| heading.label.clone())
                .unwrap_or_else(|| source_title.clone()),
            title: chapter_heading
                .map(|heading| heading.title)
                .unwrap_or(source_title),
            volume: if kind == "frontmatter" {
                "前置内容".to_string()
            } else if kind == "appendix" && entry.volume.is_empty() {
                "附加内容".to_string()
            } else {
                entry.volume.clone()
            },
            kind: kind.to_string(),
            content: content_text.clone(),
            content_text,
            content_format: "text".to_string(),
            word_count,
        });
    }
    if chapters.is_empty() {
        return Err("EPUB 没有可阅读章节".to_string());
    }
    if description.trim().is_empty() {
        description = chapters
            .iter()
            .find(|chapter| {
                chapter.kind == "frontmatter"
                    && matches!(
                        normalized_heading(&chapter.title).as_str(),
                        "内容简介" | "内容提要" | "内容介绍" | "简介" | "作品简介"
                    )
                    && !chapter.content_text.trim().is_empty()
            })
            .map(|chapter| chapter.content_text.chars().take(600).collect())
            .unwrap_or_default();
    }
    let mut warnings = Vec::new();
    if !used_navigation {
        warnings.push("EPUB 未提供目录，已按书脊顺序生成章节".to_string());
    }
    Ok(ParsedResult {
        metadata: ParsedMetadata {
            title,
            author,
            description,
            encoding: "utf-8".to_string(),
            source_name: filename.to_string(),
            source_size: bytes.len() as i64,
            source_format: "epub".to_string(),
            cover_data_url,
        },
        chapters,
        warnings,
    })
}

fn parse_file(path: &Path, options: &ParseOptions) -> Result<(ParsedResult, Vec<u8>), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取文件失败：{e}"))?;
    if !metadata.is_file() {
        return Err("导入路径不是普通文件".to_string());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("导入文件超过 512 MB 限制".to_string());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("import");
    let result = if filename.to_ascii_lowercase().ends_with(".epub") {
        parse_epub(&bytes, filename)?
    } else if filename.to_ascii_lowercase().ends_with(".txt")
        || filename.to_ascii_lowercase().ends_with(".text")
    {
        parse_txt(&bytes, filename, options)?
    } else {
        return Err("只支持 TXT 和 EPUB 文件".to_string());
    };
    Ok((result, bytes))
}

fn save_book(
    connection: &mut Connection,
    result: &ParsedResult,
    options: &ParseOptions,
    source_path: &Path,
    managed_path: Option<&Path>,
    source_hash: &str,
    existing_id: Option<String>,
) -> Result<Book, String> {
    if result.chapters.is_empty() {
        return Err("没有可保存的章节".to_string());
    }
    let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = get_book(connection, &id)?;
    let created = previous
        .as_ref()
        .map(|book| book.created_at)
        .unwrap_or_else(now);
    let current_chapter = previous
        .as_ref()
        .map(|book| book.current_chapter)
        .unwrap_or(1)
        .max(1)
        .min(result.chapters.len() as i64);
    let chapter_progress = previous
        .as_ref()
        .map(|book| book.chapter_progress)
        .unwrap_or(0.0);
    let timestamp = now();
    let volumes = result
        .chapters
        .iter()
        .filter(|chapter| chapter.kind != "frontmatter")
        .map(|chapter| chapter.volume.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let total_words = result
        .chapters
        .iter()
        .map(|chapter| chapter.word_count)
        .sum::<i64>();
    let progress = ((current_chapter - 1) as f64 + chapter_progress / 100.0)
        / (result.chapters.len() as f64)
        * 100.0;
    let theme = previous
        .as_ref()
        .map(|book| book.theme.clone())
        .unwrap_or_default();
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM chapters WHERE book_id=?1", params![id])
        .map_err(|e| e.to_string())?;
    transaction.execute("INSERT INTO books(id,title,author,description,source_name,source_size,encoding,source_format,cover_data_url,chapter_count,total_words,volumes_json,theme_json,parse_options_json,current_chapter,progress,chapter_progress,created_at,updated_at,last_read_at,source_path,managed_source_path,source_hash,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,description=excluded.description,source_name=excluded.source_name,source_size=excluded.source_size,encoding=excluded.encoding,source_format=excluded.source_format,cover_data_url=excluded.cover_data_url,chapter_count=excluded.chapter_count,total_words=excluded.total_words,volumes_json=excluded.volumes_json,theme_json=excluded.theme_json,parse_options_json=excluded.parse_options_json,current_chapter=excluded.current_chapter,progress=excluded.progress,chapter_progress=excluded.chapter_progress,updated_at=excluded.updated_at,source_path=excluded.source_path,managed_source_path=excluded.managed_source_path,source_hash=excluded.source_hash", params![id, result.metadata.title.trim(), if result.metadata.author.trim().is_empty() { "佚名" } else { result.metadata.author.trim() }, result.metadata.description.trim(), result.metadata.source_name, result.metadata.source_size, result.metadata.encoding, result.metadata.source_format, result.metadata.cover_data_url, result.chapters.len() as i64, total_words, serde_json::to_string(&volumes).unwrap_or_else(|_| "[]".to_string()), serde_json::to_string(&theme).unwrap_or_else(|_| "{}".to_string()), serde_json::to_string(options).unwrap_or_else(|_| "{}".to_string()), current_chapter, progress, chapter_progress, created, timestamp, previous.as_ref().map(|book| book.last_read_at).unwrap_or(timestamp), source_path.to_string_lossy(), managed_path.map(|path| path.to_string_lossy().into_owned()), source_hash, previous.as_ref().map(|book| book.revision).unwrap_or(0)]).map_err(|e| e.to_string())?;
    for chapter in &result.chapters {
        transaction.execute("INSERT INTO chapters(id,book_id,number,original_label,title,volume,kind,content,content_text,word_count,content_format) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![format!("{}:{}", id, chapter.number), id, chapter.number, chapter.original_label, chapter.title, chapter.volume, chapter.kind, chapter.content, chapter.content_text, chapter.word_count, chapter.content_format]).map_err(|e| e.to_string())?;
    }
    transaction.execute("INSERT INTO reading_progress(book_id,chapter_number,chapter_progress,revision,updated_at,updated_by) VALUES(?1,?2,?3,?4,?5,'import') ON CONFLICT(book_id) DO UPDATE SET chapter_number=excluded.chapter_number,chapter_progress=excluded.chapter_progress,revision=reading_progress.revision+1,updated_at=excluded.updated_at,updated_by='import'", params![id, current_chapter, chapter_progress, previous.as_ref().map(|book| book.revision).unwrap_or(0), timestamp]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    get_book(connection, &id)?.ok_or_else(|| "保存后无法读取书籍".to_string())
}

fn legacy_epub_needs_upgrade(chapters: &[Chapter]) -> bool {
    if chapters.is_empty() || chapters.iter().any(|chapter| chapter.kind != "chapter") {
        return false;
    }
    chapters.iter().take(10).any(|chapter| {
        let title = normalized_heading(&chapter.title);
        let preview =
            normalized_heading(&chapter.content_text.chars().take(80).collect::<String>());
        matches!(
            title.as_str(),
            "封面" | "版权信息" | "内容简介" | "内容提要" | "内容介绍" | "简介" | "作品简介"
        ) || [
            "Cover",
            "封面",
            "版权信息",
            "内容简介",
            "内容提要",
            "内容介绍",
        ]
        .iter()
        .any(|prefix| preview.starts_with(prefix))
    }) || chapters.iter().any(|chapter| {
        parse_epub_chapter_heading(&chapter.title).is_some()
            && chapter
                .content_text
                .trim_start()
                .starts_with(chapter.title.trim())
    })
}

fn repair_legacy_epub_chapters(
    connection: &mut Connection,
    book: &Book,
    mut chapters: Vec<Chapter>,
) -> Result<(), String> {
    let mut seen_numbered_chapter = false;
    for chapter in &mut chapters {
        let original_title = chapter.title.trim().to_string();
        let normalized_title = normalized_heading(&original_title);
        let content_preview =
            normalized_heading(&chapter.content_text.chars().take(80).collect::<String>());
        let known_frontmatter = matches!(
            normalized_title.as_str(),
            "封面" | "版权信息" | "内容简介" | "内容提要" | "内容介绍" | "简介" | "作品简介"
        ) || [
            "Cover",
            "封面",
            "版权信息",
            "内容简介",
            "内容提要",
            "内容介绍",
        ]
        .iter()
        .any(|prefix| content_preview.starts_with(prefix));
        let heading = if known_frontmatter {
            None
        } else {
            parse_epub_chapter_heading(&original_title)
        };
        if let Some(heading) = heading {
            seen_numbered_chapter = true;
            chapter.kind = "chapter".to_string();
            chapter.original_label = heading.label;
            chapter.title = heading.title;
        } else if is_epub_volume_title(&original_title) {
            chapter.kind = "volume".to_string();
            chapter.original_label = original_title.clone();
            chapter.volume = original_title.clone();
        } else if !seen_numbered_chapter {
            chapter.kind = "frontmatter".to_string();
            chapter.original_label = original_title.clone();
            chapter.volume = "前置内容".to_string();
            if normalized_title.starts_with('第') {
                if let Some(first_line) = chapter
                    .content_text
                    .lines()
                    .find(|line| !line.trim().is_empty())
                {
                    chapter.title = first_line.trim().to_string();
                }
            }
        } else {
            chapter.kind = "appendix".to_string();
            chapter.original_label = original_title.clone();
            chapter.volume = "附加内容".to_string();
        }
        let trimmed = chapter.content_text.trim_start();
        if trimmed.starts_with(&original_title) {
            let remainder = trimmed[original_title.len()..].trim_start().to_string();
            chapter.content_text = remainder.clone();
            chapter.content = remainder;
        }
        chapter.word_count = chapter
            .content_text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count() as i64;
    }
    let description = if book.description.trim().is_empty() {
        chapters
            .iter()
            .find(|chapter| {
                chapter.kind == "frontmatter"
                    && matches!(
                        normalized_heading(&chapter.title).as_str(),
                        "内容简介" | "内容提要" | "内容介绍" | "简介" | "作品简介"
                    )
            })
            .map(|chapter| chapter.content_text.chars().take(600).collect::<String>())
            .unwrap_or_default()
    } else {
        book.description.clone()
    };
    let total_words = chapters
        .iter()
        .map(|chapter| chapter.word_count)
        .sum::<i64>();
    let volumes = chapters
        .iter()
        .filter(|chapter| chapter.kind != "frontmatter")
        .map(|chapter| chapter.volume.trim())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for chapter in &chapters {
        transaction
            .execute(
                "UPDATE chapters SET original_label=?2,title=?3,volume=?4,kind=?5,content=?6,content_text=?7,word_count=?8 WHERE id=?1",
                params![chapter.id,chapter.original_label,chapter.title,chapter.volume,chapter.kind,chapter.content,chapter.content_text,chapter.word_count],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE books SET description=?2,total_words=?3,volumes_json=?4,updated_at=?5 WHERE id=?1",
            params![book.id, description, total_words, serde_json::to_string(&volumes).unwrap_or_else(|_| "[]".to_string()), now()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn save_job(connection: &Connection, job: &Job) -> Result<(), String> {
    connection.execute("INSERT INTO import_jobs(id,source_path,state,progress,message,result_book_id,error_code,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET state=excluded.state,progress=excluded.progress,message=excluded.message,result_book_id=excluded.result_book_id,error_code=excluded.error_code,updated_at=excluded.updated_at", params![job.id, job.source_path, job.state, job.progress, job.message, job.result_book_id, job.error_code, job.created_at, job.updated_at]).map_err(|e| e.to_string())?;
    Ok(())
}

fn recover_interrupted_jobs(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE import_jobs SET state='failed',progress=100,message='Runtime 重启导致导入中断',error_code='IMPORT_INTERRUPTED',updated_at=?1 WHERE state NOT IN ('completed','failed','cancelled')",
            params![now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_import_active(connection: &Connection, job_id: &str) -> Result<(), String> {
    let state = connection
        .query_row(
            "SELECT state FROM import_jobs WHERE id=?1",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match state.as_deref() {
        Some("cancelled") => Err(IMPORT_CANCELLED.to_string()),
        Some(_) => Ok(()),
        None => Err("导入任务不存在".to_string()),
    }
}

fn read_job(connection: &Connection, job_id: &str) -> Result<Option<Job>, String> {
    connection
        .query_row("SELECT id,source_path,state,progress,message,result_book_id,error_code,created_at,updated_at FROM import_jobs WHERE id=?1", params![job_id], |row| Ok(Job { id:row.get(0)?,source_path:row.get(1)?,state:row.get(2)?,progress:row.get(3)?,message:row.get(4)?,result_book_id:row.get(5)?,error_code:row.get(6)?,created_at:row.get(7)?,updated_at:row.get(8)? }))
        .optional()
        .map_err(|e| e.to_string())
}

fn cancel_import_job(connection: &Connection, job_id: &str) -> Result<Job, String> {
    let changed = connection
        .execute(
            "UPDATE import_jobs SET state='cancelled',progress=100,message='导入已取消',error_code=?2,updated_at=?3 WHERE id=?1 AND state IN ('queued','parsing','hashing','copying','validating')",
            params![job_id, IMPORT_CANCELLED, now()],
        )
        .map_err(|e| e.to_string())?;
    let job = read_job(connection, job_id)?.ok_or_else(|| "JOB_NOT_FOUND".to_string())?;
    if changed > 0 || job.state == "cancelled" {
        Ok(job)
    } else {
        Err("JOB_NOT_CANCELLABLE".to_string())
    }
}

fn enqueue_import(state: &RuntimeState, request: ImportRequest) -> Result<Job, String> {
    let path = PathBuf::from(&request.path);
    if !path.is_absolute() {
        return Err("导入路径必须是绝对路径".to_string());
    }
    if !path.is_file() {
        return Err("导入文件不存在".to_string());
    }
    if request
        .existing_id
        .as_deref()
        .map(|id| !valid_id(id))
        .unwrap_or(false)
    {
        return Err("待覆盖书籍编号无效".to_string());
    }
    if request
        .idempotency_key
        .as_deref()
        .map(|key| key.is_empty() || key.len() > 200)
        .unwrap_or(false)
    {
        return Err("idempotencyKey 无效".to_string());
    }
    let id = request
        .idempotency_key
        .as_deref()
        .map(|key| format!("import-{}", &sha256(key.as_bytes())[..32]))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let timestamp = now();
    let connection = open_db(state)?;
    if let Some(existing) = read_job(&connection, &id)? {
        return Ok(existing);
    }
    let job = Job {
        id,
        source_path: request.path.clone(),
        state: "queued".to_string(),
        progress: 0,
        message: "等待导入".to_string(),
        result_book_id: None,
        error_code: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    save_job(&connection, &job)?;
    let worker_state = state.clone();
    let worker_job = job.clone();
    thread::spawn(move || run_import_job(worker_state, request, worker_job));
    Ok(job)
}

fn run_import_job(state: RuntimeState, request: ImportRequest, mut job: Job) {
    let result = (|| -> Result<String, String> {
        let path = PathBuf::from(&request.path);
        let mut connection = open_db(&state)?;
        job.state = "parsing".to_string();
        job.progress = 10;
        job.message = "正在读取文件".to_string();
        job.updated_at = now();
        save_job(&connection, &job)?;

        let options = request.options.clone().unwrap_or_default();
        let (parsed, bytes) = parse_file(&path, &options)?;
        ensure_import_active(&connection, &job.id)?;
        job.state = "hashing".to_string();
        job.progress = 45;
        job.message = "正在校验源文件".to_string();
        job.updated_at = now();
        save_job(&connection, &job)?;
        let source_hash = sha256(&bytes);
        if request.existing_id.is_none() {
            if let Some(existing_id) = connection
                .query_row(
                    "SELECT id FROM books WHERE source_hash=?1 LIMIT 1",
                    params![source_hash],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
            {
                return Ok(existing_id);
            }
        }
        let book_id = request
            .existing_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let retain_source = request.retain_source.unwrap_or(true);
        job.state = "copying".to_string();
        job.progress = 55;
        job.message = if retain_source {
            "正在保存受管源文件".to_string()
        } else {
            "正在准备书籍数据".to_string()
        };
        job.updated_at = now();
        save_job(&connection, &job)?;
        ensure_import_active(&connection, &job.id)?;
        let source_dir = state.data_dir.join("sources").join(&book_id);
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("txt");
        let managed = source_dir.join(format!("source.{extension}"));
        let temp = source_dir.join(format!("source.{}.tmp", Uuid::new_v4()));
        let previous_managed = get_book(&connection, &book_id)?
            .and_then(|book| book.managed_source_path)
            .map(PathBuf::from);
        job.state = "saving".to_string();
        job.progress = 75;
        job.message = "正在保存书籍".to_string();
        job.updated_at = now();
        save_job(&connection, &job)?;
        let managed_backup =
            managed.with_extension(format!("{extension}.previous.{}", Uuid::new_v4()));
        let mut had_managed = false;
        if retain_source {
            fs::create_dir_all(&source_dir).map_err(|e| e.to_string())?;
            fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
            had_managed = managed.is_file();
            if had_managed {
                fs::rename(&managed, &managed_backup).map_err(|e| {
                    let _ = fs::remove_file(&temp);
                    format!("无法暂存原受管源文件：{e}")
                })?;
            }
            if let Err(error) = fs::rename(&temp, &managed) {
                if had_managed {
                    let _ = fs::rename(&managed_backup, &managed);
                }
                let _ = fs::remove_file(&temp);
                return Err(format!("无法保存受管源文件：{error}"));
            }
        }
        let saved = save_book(
            &mut connection,
            &parsed,
            &options,
            &path,
            retain_source.then_some(managed.as_path()),
            &source_hash,
            Some(book_id),
        );
        match saved {
            Ok(book) => {
                if had_managed {
                    let _ = fs::remove_file(&managed_backup);
                }
                if let Some(previous) =
                    previous_managed.filter(|value| !retain_source || value != &managed)
                {
                    let _ = fs::remove_file(previous);
                }
                if !retain_source {
                    let _ = fs::remove_dir_all(&source_dir);
                }
                Ok(book.id)
            }
            Err(error) => {
                if retain_source {
                    let _ = fs::remove_file(&managed);
                    if had_managed {
                        let _ = fs::rename(&managed_backup, &managed);
                    }
                }
                Err(error)
            }
        }
    })();

    match result {
        Ok(book_id) => {
            job.state = "completed".to_string();
            job.progress = 100;
            job.message = "导入完成".to_string();
            job.result_book_id = Some(book_id);
            job.error_code = None;
        }
        Err(error) => {
            job.state = if error == IMPORT_CANCELLED {
                "cancelled".to_string()
            } else {
                "failed".to_string()
            };
            job.progress = 100;
            job.message = if error == IMPORT_CANCELLED {
                "导入已取消".to_string()
            } else {
                error
            };
            job.error_code = Some(if job.state == "cancelled" {
                IMPORT_CANCELLED.to_string()
            } else {
                "IMPORT_FAILED".to_string()
            });
        }
    }
    job.updated_at = now();
    if let Ok(connection) = open_db(&state) {
        let _ = save_job(&connection, &job);
    }
}

fn export_transfer(state: &RuntimeState, request: TransferRequest) -> Result<Value, String> {
    let target = PathBuf::from(&request.path);
    if !target.is_absolute() {
        return Err("迁移目标必须是绝对路径".to_string());
    }
    let connection = open_db(state)?;
    let mut books = list_books(&connection)?;
    let selected_export = request.book_ids.is_some();
    if let Some(book_ids) = request.book_ids.as_ref() {
        let requested = book_ids.iter().collect::<HashSet<_>>();
        if book_ids.is_empty()
            || requested.len() != book_ids.len()
            || book_ids.iter().any(|id| !valid_id(id))
        {
            return Err("selected 导出的 bookIds 无效".to_string());
        }
        books.retain(|book| requested.contains(&book.id));
        if books.len() != requested.len() {
            return Err("selected 导出包含不存在的书籍".to_string());
        }
    }
    let mut chapters = Vec::new();
    for book in &books {
        chapters.extend(list_chapters(&connection, &book.id)?);
    }
    // Notes do not currently carry a bookId, so a selected-book package must
    // not accidentally leak or restore unrelated library-wide notes.
    let notes = if selected_export {
        Vec::new()
    } else {
        list_notes(&connection)?
    };
    let book_count = books.len();
    let chapter_count = chapters.len();
    let note_count = notes.len();
    let mut payload = json!({"format":"novel-library-backup","version":4,"createdAt":now(),"sourceProviderType":"local","sourceStorageId":state.storage_id,"schemaVersion":SCHEMA_VERSION,"books":books,"chapters":chapters,"notes":notes});
    let checksum = sha256(&serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    payload["checksumSha256"] = json!(checksum);
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = target.with_extension(format!(
        "{}.{}.tmp",
        target
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("transfer"),
        Uuid::new_v4()
    ));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    Ok(
        json!({"path": target, "bookCount": book_count, "chapterCount": chapter_count, "noteCount": note_count}),
    )
}

fn transfer_chapter_fingerprint(chapters: &[Chapter]) -> Result<String, String> {
    let mut chapters = chapters.iter().collect::<Vec<_>>();
    chapters.sort_by_key(|chapter| (chapter.number, chapter.id.as_str()));
    let payload = chapters
        .into_iter()
        .map(|chapter| {
            (
                chapter.number,
                chapter.original_label.as_str(),
                chapter.title.as_str(),
                chapter.volume.as_str(),
                chapter.kind.as_str(),
                chapter.content.as_str(),
                chapter.content_text.as_str(),
                chapter.content_format.as_str(),
            )
        })
        .collect::<Vec<_>>();
    Ok(sha256(
        &serde_json::to_vec(&payload).map_err(|error| error.to_string())?,
    ))
}

fn import_transfer(state: &RuntimeState, request: TransferRequest) -> Result<Value, String> {
    if !Path::new(&request.path).is_absolute() {
        return Err("迁移源必须是绝对路径".to_string());
    }
    let metadata = fs::metadata(&request.path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
        return Err("迁移包不存在、不是普通文件或超过 512 MB 限制".to_string());
    }
    let bytes = fs::read(&request.path).map_err(|e| e.to_string())?;
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("迁移包格式无效：{e}"))?;
    if let Some(expected) = payload.get("checksumSha256").and_then(Value::as_str) {
        if expected.len() != 64
            || !expected
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("迁移包 checksum 格式无效".to_string());
        }
        let mut unsigned = payload.clone();
        unsigned
            .as_object_mut()
            .expect("transfer payload is an object")
            .remove("checksumSha256");
        let actual = sha256(&serde_json::to_vec(&unsigned).map_err(|e| e.to_string())?);
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err("迁移包 checksum 校验失败，文件可能已损坏或被修改".to_string());
        }
    }
    let format = payload.get("format").and_then(Value::as_str);
    let version = payload.get("version").and_then(Value::as_u64);
    let supported = matches!((format, version), (Some("novel-library-transfer"), Some(1)))
        || matches!(
            (format, version),
            (Some("novel-library-backup"), Some(1..=4))
        );
    if !supported {
        return Err("不支持的迁移包格式或版本".to_string());
    }
    let strategy = request.strategy.unwrap_or_else(|| "merge".to_string());
    if !matches!(strategy.as_str(), "merge" | "replace" | "selected") {
        return Err("不支持的迁移策略".to_string());
    }
    let selected_book_ids = request.book_ids.unwrap_or_default();
    if strategy == "selected"
        && (selected_book_ids.is_empty() || selected_book_ids.iter().any(|id| !valid_id(id)))
    {
        return Err("selected 导入必须提供有效的 bookIds".to_string());
    }
    let mut books: Vec<Book> =
        serde_json::from_value(payload.get("books").cloned().unwrap_or_else(|| json!([])))
            .map_err(|e| e.to_string())?;
    let mut chapters: Vec<Chapter> = serde_json::from_value(
        payload
            .get("chapters")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| e.to_string())?;
    let mut notes: Vec<Note> =
        serde_json::from_value(payload.get("notes").cloned().unwrap_or_else(|| json!([])))
            .map_err(|e| e.to_string())?;
    // Enforce limits on the package itself before applying a selected filter;
    // otherwise a huge unselected section could bypass the safety boundary.
    if books.len() > 10_000 || chapters.len() > 2_000_000 || notes.len() > 100_000 {
        return Err("迁移包记录数量超过安全限制".to_string());
    }
    if strategy == "selected" {
        let selected = selected_book_ids.iter().collect::<HashSet<_>>();
        if selected.len() != selected_book_ids.len() {
            return Err("selected 导入的 bookIds 不能重复".to_string());
        }
        let available = books.iter().map(|book| &book.id).collect::<HashSet<_>>();
        if selected.iter().any(|id| !available.contains(id)) {
            return Err("selected 导入包含迁移包中不存在的书籍".to_string());
        }
        books.retain(|book| selected.contains(&book.id));
        chapters.retain(|chapter| selected.contains(&chapter.book_id));
        notes.clear();
    }
    let incoming_ids = books
        .iter()
        .map(|book| book.id.clone())
        .collect::<HashSet<_>>();
    let chapter_ids = chapters
        .iter()
        .map(|chapter| chapter.id.clone())
        .collect::<HashSet<_>>();
    let chapter_numbers = chapters
        .iter()
        .map(|chapter| (chapter.book_id.clone(), chapter.number))
        .collect::<HashSet<_>>();
    if incoming_ids.len() != books.len()
        || chapter_ids.len() != chapters.len()
        || chapter_numbers.len() != chapters.len()
        || books.iter().any(|book| !valid_id(&book.id))
        || notes.iter().any(|note| !valid_id(&note.id))
        || chapters.iter().any(|chapter| {
            chapter.id.is_empty()
                || chapter.id.len() > 180
                || chapter.number <= 0
                || !valid_id(&chapter.book_id)
                || !incoming_ids.contains(&chapter.book_id)
        })
    {
        return Err("迁移包包含无效的书籍或章节引用".to_string());
    }
    for book in &mut books {
        let book_chapters = chapters
            .iter()
            .filter(|chapter| chapter.book_id == book.id)
            .collect::<Vec<_>>();
        book.chapter_count = book_chapters.len() as i64;
        book.total_words = book_chapters
            .iter()
            .map(|chapter| chapter.word_count.max(0))
            .sum();
        book.current_chapter = book.current_chapter.max(1).min(book.chapter_count.max(1));
        book.chapter_progress = book.chapter_progress.clamp(0.0, 100.0);
        book.progress = book.progress.clamp(0.0, 100.0);
    }
    let automatic_backup = if strategy == "replace" {
        let path = state
            .data_dir
            .join("backups")
            .join(format!("pre-restore-{}.json", now()));
        export_transfer(
            state,
            TransferRequest {
                path: path.to_string_lossy().into_owned(),
                strategy: None,
                book_ids: None,
            },
        )?;
        Some(path)
    } else {
        None
    };
    let mut connection = open_db(state)?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    if strategy == "replace" {
        transaction
            .execute_batch(
                "DELETE FROM chapters; DELETE FROM reading_progress; DELETE FROM books; DELETE FROM notes;",
            )
            .map_err(|e| e.to_string())?;
    }
    if strategy != "replace" {
        for book in &mut books {
            let Some(existing) = get_book(&transaction, &book.id)? else {
                continue;
            };
            let existing_chapters = list_chapters(&transaction, &book.id)?;
            let incoming_chapters = chapters
                .iter()
                .filter(|chapter| chapter.book_id == book.id)
                .cloned()
                .collect::<Vec<_>>();
            if transfer_chapter_fingerprint(&existing_chapters)?
                != transfer_chapter_fingerprint(&incoming_chapters)?
            {
                let previous_id = book.id.clone();
                let replacement_id = Uuid::new_v4().to_string();
                book.id = replacement_id.clone();
                book.title = format!("{}（导入副本）", book.title);
                for chapter in chapters
                    .iter_mut()
                    .filter(|chapter| chapter.book_id == previous_id)
                {
                    chapter.book_id = replacement_id.clone();
                    chapter.id = format!("{replacement_id}-{}", chapter.number);
                }
            } else {
                if (
                    existing.revision,
                    existing.last_read_at,
                    existing.updated_at,
                ) > (book.revision, book.last_read_at, book.updated_at)
                {
                    book.current_chapter = existing.current_chapter;
                    book.progress = existing.progress;
                    book.chapter_progress = existing.chapter_progress;
                    book.revision = existing.revision;
                    book.last_read_at = existing.last_read_at;
                }
                book.created_at = book.created_at.min(existing.created_at);
                book.source_path = existing.source_path;
                book.managed_source_path = existing.managed_source_path;
                book.source_hash = existing.source_hash.or_else(|| book.source_hash.clone());
            }
        }
        let existing_notes = list_notes(&transaction)?;
        for note in &mut notes {
            if let Some(existing) = existing_notes.iter().find(|item| item.id == note.id) {
                if existing.content_html != note.content_html
                    || existing.content_text != note.content_text
                {
                    note.id = Uuid::new_v4().to_string();
                    note.title = format!("{}（导入冲突副本）", note.title);
                } else if existing.updated_at > note.updated_at {
                    *note = existing.clone();
                }
            }
        }
    }
    for mut book in books {
        if strategy == "replace" || get_book(&transaction, &book.id)?.is_none() {
            book.source_path = None;
            book.managed_source_path = None;
        }
        transaction.execute("INSERT INTO books(id,title,author,description,source_name,source_size,encoding,source_format,cover_data_url,chapter_count,total_words,volumes_json,theme_json,parse_options_json,current_chapter,progress,chapter_progress,created_at,updated_at,last_read_at,source_path,managed_source_path,source_hash,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,description=excluded.description,source_name=excluded.source_name,source_size=excluded.source_size,encoding=excluded.encoding,source_format=excluded.source_format,cover_data_url=excluded.cover_data_url,chapter_count=excluded.chapter_count,total_words=excluded.total_words,volumes_json=excluded.volumes_json,theme_json=excluded.theme_json,parse_options_json=excluded.parse_options_json,current_chapter=excluded.current_chapter,progress=excluded.progress,chapter_progress=excluded.chapter_progress,created_at=excluded.created_at,updated_at=excluded.updated_at,last_read_at=excluded.last_read_at,source_path=excluded.source_path,managed_source_path=excluded.managed_source_path,source_hash=excluded.source_hash,revision=excluded.revision", params![book.id,book.title,book.author,book.description,book.source_name,book.source_size,book.encoding,book.source_format,book.cover_data_url,book.chapter_count,book.total_words,&serde_json::to_string(&book.volumes).unwrap_or_else(|_| "[]".to_string()),&serde_json::to_string(&book.theme).unwrap_or_else(|_| "{}".to_string()),&serde_json::to_string(&book.parse_options).unwrap_or_else(|_| "{}".to_string()),book.current_chapter,book.progress,book.chapter_progress,book.created_at,book.updated_at,book.last_read_at,book.source_path,book.managed_source_path,book.source_hash,book.revision]).map_err(|e| e.to_string())?;
    }
    for chapter in chapters {
        transaction.execute("INSERT OR REPLACE INTO chapters(id,book_id,number,original_label,title,volume,kind,content,content_text,word_count,content_format) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![chapter.id,chapter.book_id,chapter.number,chapter.original_label,chapter.title,chapter.volume,chapter.kind,chapter.content,chapter.content_text,chapter.word_count,chapter.content_format]).map_err(|e| e.to_string())?;
    }
    let note_count = notes.len();
    for note in notes {
        transaction.execute("INSERT INTO notes(id,title,content_html,content_text,is_pinned,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content_html=excluded.content_html,content_text=excluded.content_text,is_pinned=excluded.is_pinned,created_at=excluded.created_at,updated_at=excluded.updated_at", params![note.id,note.title,note.content_html,note.content_text,note.is_pinned,note.created_at,note.updated_at]).map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    if strategy == "replace" {
        let sources = state.data_dir.join("sources");
        if let Ok(entries) = fs::read_dir(&sources) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Ok(
        json!({"imported": true, "strategy": strategy, "bookCount": incoming_ids.len(), "noteCount": note_count, "automaticBackupPath": automatic_backup}),
    )
}

fn handle(
    state: &RuntimeState,
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
) -> Vec<u8> {
    if method == "OPTIONS" {
        return json_response("204 No Content", json!({}));
    }
    if path == "/v1/health" || path == "/v2/health" {
        return json_response(
            "200 OK",
            json!({"ok":true,"providerType":"local","runtimeVersion":RUNTIME_VERSION}),
        );
    }
    if authorization != Some(&format!("Bearer {}", state.token)) {
        return error_response(
            "401 Unauthorized",
            "UNAUTHORIZED",
            "Runtime token 无效",
            false,
        );
    }
    if path == "/v1/manifest" || path == "/v2/manifest" {
        return json_response(
            "200 OK",
            json!({"protocolVersion":PROTOCOL_VERSION,"minimumClientProtocolVersion":2,"providerType":"local","providerVersion":RUNTIME_VERSION,"runtimeVersion":RUNTIME_VERSION,"appVersion":RUNTIME_VERSION,"storageId":state.storage_id,"sessionId":state.session_id,"schemaVersion":SCHEMA_VERSION,"capabilities":["books.read","chapters.read","progress.v2","import.jobs","import.idempotency","books.delete","books.reparse","backup.transfer","runtime.diagnostics","runtime.check-database","epub.structure.v2"]}),
        );
    }
    let mut connection = match open_db(state) {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                "500 Internal Server Error",
                "DATABASE_OPEN_FAILED",
                error,
                false,
            )
        }
    };
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match (method, segments.as_slice()) {
        ("GET", ["v1", "books"]) | ("GET", ["v2", "books"]) => match list_books(&connection) {
            Ok(books) => json_response("200 OK", serde_json::to_value(books).unwrap_or_default()),
            Err(error) => error_response(
                "500 Internal Server Error",
                "DATABASE_READ_FAILED",
                error,
                true,
            ),
        },
        ("GET", ["v1", "books", id]) | ("GET", ["v2", "books", id]) if valid_id(id) => {
            match get_book(&connection, id) {
                Ok(Some(book)) => {
                    json_response("200 OK", serde_json::to_value(book).unwrap_or_default())
                }
                Ok(None) => error_response("404 Not Found", "BOOK_NOT_FOUND", "书籍不存在", false),
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_READ_FAILED",
                    error,
                    true,
                ),
            }
        }
        ("GET", ["v1", "books", id, "chapters"]) | ("GET", ["v2", "books", id, "chapters"])
            if valid_id(id) =>
        {
            match list_chapters(&connection, id) {
                Ok(chapters) => {
                    let summaries = chapters.into_iter().map(|chapter| json!({"id":chapter.id,"bookId":chapter.book_id,"number":chapter.number,"originalLabel":chapter.original_label,"title":chapter.title,"volume":chapter.volume,"kind":chapter.kind,"wordCount":chapter.word_count,"contentFormat":chapter.content_format})).collect::<Vec<_>>();
                    json_response("200 OK", json!(summaries))
                }
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_READ_FAILED",
                    error,
                    true,
                ),
            }
        }
        ("GET", ["v1", "books", id, "chapters", number])
        | ("GET", ["v2", "books", id, "chapters", number])
            if valid_id(id) =>
        {
            match number.parse::<i64>().ok().and_then(|number| {
                list_chapters(&connection, id).ok().and_then(|chapters| {
                    chapters
                        .into_iter()
                        .find(|chapter| chapter.number == number)
                })
            }) {
                Some(chapter) => {
                    json_response("200 OK", serde_json::to_value(chapter).unwrap_or_default())
                }
                None => error_response("404 Not Found", "CHAPTER_NOT_FOUND", "章节不存在", false),
            }
        }
        ("POST", ["v1", "progress"]) | ("POST", ["v2", "progress"]) => {
            match serde_json::from_slice::<ProgressRequest>(body) {
                Ok(input) => save_progress(&mut connection, &input),
                Err(error) => error_response(
                    "400 Bad Request",
                    "INVALID_REQUEST",
                    error.to_string(),
                    false,
                ),
            }
        }
        ("POST", ["v1", "import"]) => match serde_json::from_slice::<ImportRequest>(body)
            .map_err(|e| e.to_string())
            .and_then(|request| enqueue_import(state, request))
        {
            Ok(job) => json_response(
                "202 Accepted",
                json!({"accepted":true,"jobId":job.id,"state":job.state,"resultBookId":job.result_book_id}),
            ),
            Err(error) => error_response("400 Bad Request", "IMPORT_FAILED", error, false),
        },
        ("POST", ["v2", "import-jobs"]) => match serde_json::from_slice::<ImportRequest>(body)
            .map_err(|e| e.to_string())
            .and_then(|request| enqueue_import(state, request))
        {
            Ok(job) => json_response(
                "202 Accepted",
                serde_json::to_value(job).unwrap_or_default(),
            ),
            Err(error) => error_response("400 Bad Request", "IMPORT_FAILED", error, false),
        },
        ("GET", ["v2", "import-jobs", id]) => match read_job(&connection, id) {
            Ok(Some(job)) => json_response("200 OK", serde_json::to_value(job).unwrap_or_default()),
            Ok(None) => error_response("404 Not Found", "JOB_NOT_FOUND", "导入任务不存在", false),
            Err(error) => error_response(
                "500 Internal Server Error",
                "DATABASE_READ_FAILED",
                error,
                true,
            ),
        },
        ("DELETE", ["v2", "import-jobs", id]) => match cancel_import_job(&connection, id) {
            Ok(job) => json_response("200 OK", serde_json::to_value(job).unwrap_or_default()),
            Err(error) if error == "JOB_NOT_FOUND" => {
                error_response("404 Not Found", "JOB_NOT_FOUND", "导入任务不存在", false)
            }
            Err(error) if error == "JOB_NOT_CANCELLABLE" => error_response(
                "409 Conflict",
                "JOB_NOT_CANCELLABLE",
                "导入任务已进入保存阶段或已经结束",
                false,
            ),
            Err(error) => error_response(
                "500 Internal Server Error",
                "DATABASE_WRITE_FAILED",
                error,
                true,
            ),
        },
        ("DELETE", ["v2", "books", id]) if valid_id(id) => {
            match connection.execute("DELETE FROM books WHERE id=?1", params![id]) {
                Ok(0) => error_response("404 Not Found", "BOOK_NOT_FOUND", "书籍不存在", false),
                Ok(_) => {
                    let _ = fs::remove_dir_all(state.data_dir.join("sources").join(id));
                    json_response("200 OK", json!({"deleted":true}))
                }
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_WRITE_FAILED",
                    error.to_string(),
                    true,
                ),
            }
        }
        ("POST", ["v2", "books", id, "reparse"]) if valid_id(id) => {
            match get_book(&connection, id) {
                Ok(Some(book)) => {
                    let source_path = book
                        .managed_source_path
                        .clone()
                        .filter(|path| Path::new(path).is_file())
                        .or_else(|| {
                            book.source_path
                                .clone()
                                .filter(|path| Path::new(path).is_file())
                        });
                    if let Some(path) = source_path {
                        match enqueue_import(
                            state,
                            ImportRequest {
                                path,
                                existing_id: Some(id.to_string()),
                                options: Some(book.parse_options),
                                idempotency_key: None,
                                retain_source: Some(book.managed_source_path.is_some()),
                            },
                        ) {
                            Ok(job) => json_response(
                                "202 Accepted",
                                serde_json::to_value(job).unwrap_or_default(),
                            ),
                            Err(error) => {
                                error_response("400 Bad Request", "IMPORT_FAILED", error, false)
                            }
                        }
                    } else {
                        match list_chapters(&connection, id) {
                            Ok(chapters) if legacy_epub_needs_upgrade(&chapters) => {
                                match repair_legacy_epub_chapters(&mut connection, &book, chapters)
                                {
                                    Ok(()) => {
                                        let timestamp = now();
                                        let job = Job {
                                            id: Uuid::new_v4().to_string(),
                                            source_path: "legacy-epub-maintenance".to_string(),
                                            state: "completed".to_string(),
                                            progress: 100,
                                            message: "旧版 EPUB 章节结构修复完成".to_string(),
                                            result_book_id: Some(id.to_string()),
                                            error_code: None,
                                            created_at: timestamp,
                                            updated_at: timestamp,
                                        };
                                        match save_job(&connection, &job) {
                                            Ok(()) => json_response(
                                                "202 Accepted",
                                                serde_json::to_value(job).unwrap_or_default(),
                                            ),
                                            Err(error) => error_response(
                                                "500 Internal Server Error",
                                                "DATABASE_WRITE_FAILED",
                                                error,
                                                true,
                                            ),
                                        }
                                    }
                                    Err(error) => error_response(
                                        "400 Bad Request",
                                        "REPARSE_FAILED",
                                        error,
                                        false,
                                    ),
                                }
                            }
                            Ok(_) => error_response(
                                "409 Conflict",
                                "IMPORT_SOURCE_NOT_FOUND",
                                "书籍没有可用的源文件",
                                false,
                            ),
                            Err(error) => error_response(
                                "500 Internal Server Error",
                                "DATABASE_READ_FAILED",
                                error,
                                true,
                            ),
                        }
                    }
                }
                Ok(None) => error_response("404 Not Found", "BOOK_NOT_FOUND", "书籍不存在", false),
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_READ_FAILED",
                    error,
                    true,
                ),
            }
        }
        ("POST", ["v2", "transfers", "export"]) => {
            match serde_json::from_slice::<TransferRequest>(body)
                .map_err(|e| e.to_string())
                .and_then(|request| export_transfer(state, request))
            {
                Ok(value) => json_response("200 OK", value),
                Err(error) => error_response("400 Bad Request", "TRANSFER_FAILED", error, false),
            }
        }
        ("POST", ["v2", "transfers", "import"]) => {
            match serde_json::from_slice::<TransferRequest>(body)
                .map_err(|e| e.to_string())
                .and_then(|request| import_transfer(state, request))
            {
                Ok(value) => json_response("200 OK", value),
                Err(error) => error_response("400 Bad Request", "TRANSFER_FAILED", error, false),
            }
        }
        ("GET", ["v2", "runtime", "status"]) => json_response(
            "200 OK",
            json!({"providerType":"local","runtimeVersion":RUNTIME_VERSION,"protocolVersion":PROTOCOL_VERSION,"storageId":state.storage_id,"dataDirectory":state.data_dir,"databasePath":state.db_path,"databaseReady":true,"port":state.port,"pid":std::process::id()}),
        ),
        ("GET", ["v2", "runtime", "diagnostics"]) => {
            match runtime_diagnostics(state, &connection) {
                Ok(value) => json_response("200 OK", value),
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_CHECK_FAILED",
                    error,
                    true,
                ),
            }
        }
        ("POST", ["v2", "runtime", "check-database"]) => {
            match connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())
            {
                Ok(integrity) => json_response(
                    "200 OK",
                    json!({"ok":integrity.eq_ignore_ascii_case("ok"),"integrity":integrity,"checkedAt":now()}),
                ),
                Err(error) => error_response(
                    "500 Internal Server Error",
                    "DATABASE_CHECK_FAILED",
                    error,
                    true,
                ),
            }
        }
        ("POST", ["v2", "runtime", "restart"]) => {
            state.shutdown.store(true, Ordering::SeqCst);
            json_response("200 OK", json!({"accepted":true}))
        }
        _ => error_response("404 Not Found", "NOT_FOUND", "接口不存在", false),
    }
}

fn runtime_diagnostics(state: &RuntimeState, connection: &Connection) -> Result<Value, String> {
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let schema_version = connection
        .query_row(
            "SELECT value FROM library_meta WHERE key='schemaVersion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    let book_count = connection
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    let pending_jobs = connection
        .query_row(
            "SELECT COUNT(*) FROM import_jobs WHERE state NOT IN ('completed','failed','cancelled')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    let storage_id_suffix = state
        .storage_id
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Ok(json!({
        "ok": integrity.eq_ignore_ascii_case("ok"),
        "integrity": integrity,
        "schemaVersion": schema_version,
        "storageIdSuffix": storage_id_suffix,
        "runtimeVersion": RUNTIME_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "dataDirectory": state.data_dir,
        "logDirectory": state.data_dir.join("logs"),
        "bookCount": book_count,
        "pendingImportJobs": pending_jobs,
        "pid": std::process::id(),
        "port": state.port
    }))
}

fn save_progress(connection: &mut Connection, input: &ProgressRequest) -> Vec<u8> {
    let transaction = match connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                "500 Internal Server Error",
                "DATABASE_WRITE_FAILED",
                error.to_string(),
                true,
            )
        }
    };
    let book = match get_book(&transaction, &input.book_id) {
        Ok(Some(value)) => value,
        Ok(None) => return error_response("404 Not Found", "BOOK_NOT_FOUND", "书籍不存在", false),
        Err(error) => {
            return error_response(
                "500 Internal Server Error",
                "DATABASE_READ_FAILED",
                error,
                true,
            )
        }
    };
    let current_revision = book.revision;
    let existing_progress = transaction
        .query_row(
            "SELECT revision,updated_by,sequence FROM reading_progress WHERE book_id=?1",
            params![input.book_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional();
    let existing_progress = match existing_progress {
        Ok(value) => value,
        Err(error) => {
            return error_response(
                "500 Internal Server Error",
                "DATABASE_READ_FAILED",
                error.to_string(),
                true,
            )
        }
    };
    let has_client_id = input.client_id.is_some();
    let has_sequence = input.sequence.is_some();
    if has_client_id != has_sequence
        || input.sequence.map(|value| value <= 0).unwrap_or(false)
        || input
            .client_id
            .as_deref()
            .map(|value| value.trim().is_empty() || value.len() > 120)
            .unwrap_or(false)
    {
        return error_response(
            "400 Bad Request",
            "INVALID_REQUEST",
            "clientId 或 sequence 无效",
            false,
        );
    }
    if let (Some(client_id), Some(sequence), Some((_, updated_by, stored_sequence))) = (
        input.client_id.as_deref(),
        input.sequence,
        existing_progress.as_ref(),
    ) {
        if client_id == updated_by
            && stored_sequence
                .map(|value| sequence <= value)
                .unwrap_or(false)
        {
            return json_response(
                "200 OK",
                json!({"revision":current_revision,"chapterNumber":book.current_chapter,"chapterProgress":book.chapter_progress,"progress":book.progress,"updatedBy":updated_by,"deduplicated":true}),
            );
        }
    }
    if let Some(base_revision) = input.base_revision {
        let same_client_advance = match (
            input.client_id.as_deref(),
            input.sequence,
            existing_progress.as_ref(),
        ) {
            (Some(client_id), Some(sequence), Some((_, updated_by, stored_sequence))) => {
                client_id == updated_by
                    && stored_sequence
                        .map(|stored| sequence > stored)
                        .unwrap_or(true)
                    && base_revision <= current_revision
            }
            _ => false,
        };
        if base_revision != current_revision && !same_client_advance {
            return error_response(
                "409 Conflict",
                "PROGRESS_CONFLICT",
                "阅读进度已被其他客户端更新",
                false,
            );
        }
    }
    let chapter = input.chapter_number.max(1).min(book.chapter_count.max(1));
    let progress = input.chapter_progress.clamp(0.0, 100.0);
    let overall = (((chapter - 1) as f64 + progress / 100.0) / book.chapter_count.max(1) as f64
        * 100.0)
        .clamp(0.0, 100.0);
    let revision = current_revision + 1;
    let timestamp = now();
    let updated_by = input
        .client_id
        .clone()
        .unwrap_or_else(|| "unknown-client".to_string());
    let result = transaction.execute("UPDATE books SET current_chapter=?2,progress=?3,chapter_progress=?4,last_read_at=?5,revision=?6 WHERE id=?1", params![input.book_id, chapter, overall, progress, timestamp, revision]).and_then(|_| transaction.execute("INSERT INTO reading_progress(book_id,chapter_number,chapter_progress,anchor_offset,paragraph_index,line_index,revision,updated_at,updated_by,sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(book_id) DO UPDATE SET chapter_number=excluded.chapter_number,chapter_progress=excluded.chapter_progress,anchor_offset=excluded.anchor_offset,paragraph_index=excluded.paragraph_index,line_index=excluded.line_index,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by,sequence=excluded.sequence", params![input.book_id, chapter, progress, input.anchor_offset, input.paragraph_index, input.line_index, revision, timestamp, updated_by, input.sequence])).and_then(|_| transaction.commit());
    match result {
        Ok(_) => json_response(
            "200 OK",
            json!({"revision":revision,"chapterNumber":chapter,"chapterProgress":progress,"progress":overall,"updatedAt":timestamp,"updatedBy":updated_by,"merged":input.base_revision.map(|base| base < current_revision).unwrap_or(false)}),
        ),
        Err(error) => error_response(
            "500 Internal Server Error",
            "DATABASE_WRITE_FAILED",
            error.to_string(),
            true,
        ),
    }
}

fn serve(mut stream: TcpStream, state: Arc<RuntimeState>) {
    let mut request_summary = "invalid-request".to_string();
    // A non-blocking listener can yield non-blocking accepted sockets on Windows.
    // Small GET requests often arrive in one read, which hid this until a client
    // (notably PowerShell/IntelliJ) sent HTTP headers and the POST body separately.
    // Put each client socket back into blocking mode; read_request already applies
    // a bounded timeout so a stalled localhost client cannot hold the thread forever.
    let response = match stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())
        .and_then(|_| read_request(&mut stream))
    {
        Ok((method, path, authorization, body)) => {
            request_summary = format!("{} {}", method, path.split('?').next().unwrap_or("/"));
            handle(&state, &method, &path, authorization.as_deref(), &body)
        }
        Err(error) => error_response("400 Bad Request", "INVALID_REQUEST", error, false),
    };
    let status = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or("HTTP status unknown")
        .to_string();
    append_runtime_log(&state, &format!("request {request_summary} {status}"));
    let _ = stream.write_all(&response);
}

fn write_discovery(state: &RuntimeState, path: &Path) -> Result<(), String> {
    let payload = json!({"schemaVersion":1,"providerType":"local","protocolVersion":PROTOCOL_VERSION,"runtimeVersion":RUNTIME_VERSION,"port":state.port,"token":state.token.as_str(),"pid":std::process::id(),"sessionId":state.session_id,"storageId":state.storage_id,"startedAt":now()});
    let temp = path.with_extension("json.tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn harden_data_directory_acl(path: &Path) -> Result<(), String> {
    let username =
        std::env::var("USERNAME").map_err(|_| "无法读取当前 Windows 用户名".to_string())?;
    let account = std::env::var("USERDOMAIN")
        .ok()
        .filter(|domain| !domain.trim().is_empty())
        .map(|domain| format!("{domain}\\{username}"))
        .unwrap_or(username);
    let output = Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r"])
        .arg(format!("{account}:(OI)(CI)F"))
        .arg("*S-1-5-18:(OI)(CI)F")
        .arg("*S-1-5-32-544:(OI)(CI)F")
        .output()
        .map_err(|error| format!("无法启动 Windows ACL 工具：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("无法限制本地书库目录权限：{message}"))
    }
}

#[cfg(not(windows))]
fn harden_data_directory_acl(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn serve_runtime(data_dir: PathBuf, requested_port: u16) -> Result<(), String> {
    let data_dir = if data_dir.is_absolute() {
        data_dir
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(data_dir)
    };
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(data_dir.join("sources")).map_err(|e| e.to_string())?;
    fs::create_dir_all(data_dir.join("backups")).map_err(|e| e.to_string())?;
    fs::create_dir_all(data_dir.join("logs")).map_err(|e| e.to_string())?;
    harden_data_directory_acl(&data_dir)?;
    let migration_lock = data_dir.join("migration.lock");
    if migration_lock.is_file() {
        let stale = fs::metadata(&migration_lock)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .map(|age| age > Duration::from_secs(10 * 60))
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(&migration_lock);
        } else {
            return Err("本地书库正在迁移，请稍后重试".to_string());
        }
    }
    let db_path = data_dir.join("library.db");
    let lock_path = data_dir.join("runtime.lock");
    if lock_path.is_file() {
        let stale = fs::read_to_string(&lock_path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .map(|pid| !process_is_alive(pid))
            .unwrap_or(true);
        if stale {
            let _ = fs::remove_file(&lock_path);
        }
    }
    let mut lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|error| format!("本地书库 Runtime 已被其他进程占用：{error}"))?;
    writeln!(lock, "{}", std::process::id()).map_err(|error| error.to_string())?;
    let mut bootstrap = RuntimeState {
        data_dir: data_dir.clone(),
        db_path: db_path.clone(),
        token: Arc::new(Uuid::new_v4().to_string()),
        port: 0,
        session_id: Uuid::new_v4().to_string(),
        storage_id: String::new(),
        shutdown: Arc::new(AtomicBool::new(false)),
    };
    let connection = open_db(&bootstrap)?;
    let quick_check = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    if !quick_check.eq_ignore_ascii_case("ok") {
        return Err(format!("本地书库完整性检查失败：{quick_check}"));
    }
    bootstrap.storage_id = ensure_storage_id(&connection)?;
    recover_interrupted_jobs(&connection)?;
    drop(connection);
    let listener = TcpListener::bind(("127.0.0.1", requested_port))
        .map_err(|e| format!("无法绑定本地 Runtime 端口：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = Arc::new(RuntimeState { port, ..bootstrap });
    let discovery = data_dir.join("local-runtime.json");
    write_discovery(&state, &discovery)?;
    append_runtime_log(
        &state,
        &format!(
            "runtime started version={} protocol={} pid={} port={}",
            RUNTIME_VERSION,
            PROTOCOL_VERSION,
            std::process::id(),
            port
        ),
    );
    println!(
        "{{\"port\":{},\"discovery\":\"{}\",\"storageId\":\"{}\"}}",
        port,
        discovery.display(),
        state.storage_id
    );
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    while !state.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = state.clone();
                thread::spawn(move || serve(stream, state));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("Runtime accept error: {error}")),
        }
    }
    let _ = fs::remove_file(discovery);
    let _ = fs::remove_file(lock_path);
    append_runtime_log(&state, "runtime stopped");
    Ok(())
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let expected_name = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_name()
                    .map(|value| value.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "novel-library-runtime.exe".to_string());
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                    let fields = line.split(',').collect::<Vec<_>>();
                    fields.len() > 1
                        && fields[0]
                            .trim()
                            .trim_matches('"')
                            .eq_ignore_ascii_case(&expected_name)
                        && fields[1].trim().trim_matches('"') == pid.to_string()
                })
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

fn doctor_runtime(data_dir: PathBuf) -> Result<(), String> {
    let data_dir = if data_dir.is_absolute() {
        data_dir
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(data_dir)
    };
    let db_path = data_dir.join("library.db");
    if !db_path.is_file() {
        println!(
            "{}",
            json!({
                "ok": true,
                "initialized": false,
                "runtimeVersion": RUNTIME_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "dataDirectory": data_dir,
                "databasePath": db_path
            })
        );
        return Ok(());
    }
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    validate_existing_database(&connection)?;
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let schema_version = connection
        .query_row(
            "SELECT value FROM library_meta WHERE key='schemaVersion'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let storage_id = connection
        .query_row(
            "SELECT value FROM library_meta WHERE key='storageId'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let book_count = connection
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())?;
    let ok = integrity.eq_ignore_ascii_case("ok");
    println!(
        "{}",
        json!({
            "ok": ok,
            "initialized": true,
            "integrity": integrity,
            "schemaVersion": schema_version,
            "storageId": storage_id,
            "runtimeVersion": RUNTIME_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "dataDirectory": data_dir,
            "databasePath": db_path,
            "bookCount": book_count
        })
    );
    if ok {
        Ok(())
    } else {
        Err("本地书库完整性检查失败".to_string())
    }
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("version") {
        println!("{RUNTIME_VERSION}");
        return;
    }
    let command = args.first().map(String::as_str);
    if !matches!(command, Some("serve") | Some("doctor")) {
        eprintln!("usage: novel-library-runtime <serve|doctor> --data-dir <path> [--port <port>]");
        std::process::exit(2);
    }
    let mut data_dir = None;
    let mut port = 0_u16;
    let mut log_level = "info".to_string();
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--data-dir" => {
                index += 1;
                data_dir = args.get(index).map(PathBuf::from);
            }
            "--port" => {
                index += 1;
                port = args
                    .get(index)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
            }
            "--log-level" => {
                index += 1;
                log_level = args
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| "info".to_string());
            }
            _ => {}
        }
        index += 1;
    }
    let data_dir = data_dir
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|root| root.join("NovelLibrary").join("local-data"))
        })
        .unwrap_or_else(|| PathBuf::from(".novel-library-local"));
    if !matches!(log_level.as_str(), "error" | "warn" | "info" | "debug") {
        eprintln!("invalid --log-level; expected error, warn, info or debug");
        std::process::exit(2);
    }
    let _ = LOG_LEVEL.set(log_level);
    let result = if command == Some("doctor") {
        doctor_runtime(data_dir)
    } else {
        serve_runtime(data_dir, port)
    };
    if let Err(error) = result {
        eprintln!("runtime error: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn wait_for_job(state: &RuntimeState, id: &str) -> Job {
        for _ in 0..100 {
            let connection = open_db(state).expect("database");
            let job = connection
                .query_row("SELECT id,source_path,state,progress,message,result_book_id,error_code,created_at,updated_at FROM import_jobs WHERE id=?1", params![id], |row| Ok(Job { id:row.get(0)?,source_path:row.get(1)?,state:row.get(2)?,progress:row.get(3)?,message:row.get(4)?,result_book_id:row.get(5)?,error_code:row.get(6)?,created_at:row.get(7)?,updated_at:row.get(8)? }))
                .expect("job");
            if matches!(job.state.as_str(), "completed" | "failed" | "cancelled") {
                return job;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("import job timeout")
    }

    #[test]
    fn reads_a_delayed_post_body_from_a_nonblocking_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        let address = listener.local_addr().expect("listener address");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");

        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("client connection");
            stream
                .write_all(b"POST /v2/import-jobs HTTP/1.1\r\nContent-Length: 11\r\n\r\n")
                .expect("request headers");
            thread::sleep(Duration::from_millis(50));
            stream.write_all(br#"{"ok":true}"#).expect("request body");
        });

        let mut accepted = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        };
        accepted
            .set_nonblocking(false)
            .expect("blocking accepted stream");
        let (method, path, _, body) = read_request(&mut accepted).expect("complete request");
        client.join().expect("client thread");

        assert_eq!(method, "POST");
        assert_eq!(path, "/v2/import-jobs");
        assert_eq!(body, br#"{"ok":true}"#);
    }

    #[test]
    fn decodes_utf8_and_extracts_chapters() {
        let options = ParseOptions::default();
        let result = parse_txt(
            "《测试书》\n作者：作者\n第一章 开始\n正文一\n第二章 继续\n正文二".as_bytes(),
            "test.txt",
            &options,
        )
        .expect("parse");
        assert_eq!(result.metadata.title, "测试书");
        assert_eq!(result.metadata.author, "作者");
        assert_eq!(result.chapters.len(), 2);
        assert_eq!(result.chapters[1].title, "继续");
    }

    #[test]
    fn matches_desktop_txt_metadata_volume_and_special_chapter_rules() {
        let result = parse_txt(
            "《山海书》\n作者：测试作者\n内容简介\n这是简介。\n\n第一卷 初见\n第一章 起程\n第一段没有句号\n接续内容。\n更多精彩小说尽在这里\n番外篇一 山外\n番外正文。\n终章 归途\n终章正文。"
                .as_bytes(),
            "备用书名.txt",
            &ParseOptions::default(),
        )
        .expect("parse");

        assert_eq!(result.metadata.title, "山海书");
        assert_eq!(result.metadata.author, "测试作者");
        assert_eq!(result.metadata.description, "这是简介。");
        assert_eq!(
            result
                .chapters
                .iter()
                .map(|chapter| chapter.title.as_str())
                .collect::<Vec<_>>(),
            ["起程", "山外", "归途"]
        );
        assert_eq!(result.chapters[0].volume, "第一卷 初见");
        assert_eq!(result.chapters[0].content, "第一段没有句号接续内容。");
        assert!(!result.chapters[0].content.contains("第一卷"));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("少于 100 字")));
    }

    #[test]
    fn parses_epub_with_arbitrary_attribute_order_and_removes_active_content() {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .expect("container entry");
        writer
            .write_all(br#"<?xml version="1.0"?><container><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="OPS/content.opf"/></rootfiles></container>"#)
            .expect("container");
        writer
            .start_file("OPS/content.opf", options)
            .expect("opf entry");
        writer
            .write_all(r#"<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>测试 EPUB</dc:title><dc:creator>作者</dc:creator><dc:description>简介</dc:description></metadata><manifest><item media-type="application/xhtml+xml" href="chapter%201.xhtml" id="chapter-one"/></manifest><spine><itemref linear="yes" idref="chapter-one"/></spine></package>"#.as_bytes())
            .expect("opf");
        writer
            .start_file("OPS/chapter 1.xhtml", options)
            .expect("chapter entry");
        writer
            .write_all(r#"<html><body><h1>第一章 开始</h1><script>alert('x')</script><p>安全正文</p><style>bad</style></body></html>"#.as_bytes())
            .expect("chapter");
        let bytes = writer.finish().expect("finish zip").into_inner();

        let parsed = parse_epub(&bytes, "test.epub").expect("parse epub");
        assert_eq!(parsed.metadata.title, "测试 EPUB");
        assert_eq!(parsed.metadata.author, "作者");
        assert_eq!(parsed.metadata.description, "简介");
        assert_eq!(parsed.chapters.len(), 1);
        assert_eq!(parsed.chapters[0].title, "开始");
        assert_eq!(parsed.chapters[0].original_label, "一");
        assert_eq!(parsed.chapters[0].kind, "chapter");
        assert_eq!(parsed.chapters[0].content_text, "安全正文");
        assert!(!parsed.chapters[0].content_text.contains("alert"));
        assert_eq!(parsed.chapters[0].content_format, "text");
        assert_eq!(parsed.warnings, ["EPUB 未提供目录，已按书脊顺序生成章节"]);
    }

    #[test]
    fn parses_epub3_navigation_and_keeps_only_body_entries_readable() {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .expect("container entry");
        writer
            .write_all(br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>"#)
            .expect("container");
        writer
            .start_file("OPS/content.opf", options)
            .expect("opf entry");
        writer
            .write_all(r#"<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>结构测试</dc:title><dc:creator>作者</dc:creator><dc:description></dc:description></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover-image" href="Images/cover.png" media-type="image/png" properties="cover-image"/><item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="intro" href="Text/intro.xhtml" media-type="application/xhtml+xml"/><item id="volume" href="Text/volume.xhtml" media-type="application/xhtml+xml"/><item id="one" href="Text/one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/><item id="after" href="Text/after.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="intro"/><itemref idref="volume"/><itemref idref="one"/><itemref idref="two"/><itemref idref="after"/></spine></package>"#.as_bytes())
            .expect("opf");
        writer.start_file("OPS/nav.xhtml", options).expect("nav");
        writer
            .write_all(r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="Text/cover.xhtml">封面</a></li><li><a href="Text/intro.xhtml">内容简介</a></li><li><a href="Text/volume.xhtml">第一卷 起程</a><ol><li><a href="Text/one.xhtml">第一章 初见</a></li><li><a href="Text/two.xhtml">第二章 风雨</a></li></ol></li><li><a href="Text/after.xhtml">后记</a></li></ol></nav></body></html>"#.as_bytes())
            .expect("nav");
        for (path, body) in [
            ("OPS/Text/cover.xhtml", "<html><head><title>封面</title></head><body><p>Cover</p></body></html>"),
            ("OPS/Text/intro.xhtml", "<html><body><h1>内容简介</h1><p>这是内容简介。</p></body></html>"),
            ("OPS/Text/volume.xhtml", "<html><body><h1>第一卷 起程</h1></body></html>"),
            ("OPS/Text/one.xhtml", "<html><body><h2>第一卷 起程</h2><p>卷首装饰</p><h1>第一章 初见</h1><script>bad()</script><p>第一章正文。</p></body></html>"),
            ("OPS/Text/two.xhtml", "<html><body><h1>第二章 风雨</h1><p>第二章正文。</p></body></html>"),
            ("OPS/Text/after.xhtml", "<html><body><h1>后记</h1><p>附加内容。</p></body></html>"),
        ] {
            writer.start_file(path, options).expect("content entry");
            writer.write_all(body.as_bytes()).expect("content");
        }
        writer
            .start_file("OPS/Images/cover.png", options)
            .expect("cover image");
        writer.write_all(&[1, 2, 3, 4]).expect("cover bytes");
        let bytes = writer.finish().expect("finish zip").into_inner();

        let parsed = parse_epub(&bytes, "structure.epub").expect("parse epub3");
        assert_eq!(
            parsed
                .chapters
                .iter()
                .map(|chapter| chapter.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "frontmatter",
                "frontmatter",
                "volume",
                "chapter",
                "chapter",
                "appendix"
            ]
        );
        assert_eq!(parsed.metadata.description, "这是内容简介。");
        assert!(parsed
            .metadata
            .cover_data_url
            .as_deref()
            .is_some_and(|value| value.starts_with("data:image/png;base64,")));
        assert_eq!(parsed.chapters[3].title, "初见");
        assert_eq!(parsed.chapters[3].original_label, "一");
        assert_eq!(parsed.chapters[3].volume, "第一卷 起程");
        assert_eq!(parsed.chapters[3].content_text, "第一章正文。");
        assert_eq!(parsed.chapters[5].volume, "附加内容");
    }

    #[test]
    fn parses_epub2_ncx_frontmatter_and_body_boundaries() {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();
        writer
            .start_file("META-INF/container.xml", options)
            .expect("container entry");
        writer
            .write_all(br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#)
            .expect("container");
        writer
            .start_file("OEBPS/content.opf", options)
            .expect("opf entry");
        writer
            .write_all(r#"<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>NCX 测试</dc:title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="intro" href="Text/intro.xhtml" media-type="application/xhtml+xml"/><item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="cover"/><itemref idref="intro"/><itemref idref="chapter"/></spine></package>"#.as_bytes())
            .expect("opf");
        writer.start_file("OEBPS/toc.ncx", options).expect("ncx");
        writer
            .write_all(r#"<ncx><navMap><navPoint><navLabel><text>封面</text></navLabel><content src="Text/cover.xhtml"/></navPoint><navPoint><navLabel><text>内容简介</text></navLabel><content src="Text/intro.xhtml"/></navPoint><navPoint><navLabel><text>第1章 开始</text></navLabel><content src="Text/chapter.xhtml"/></navPoint></navMap></ncx>"#.as_bytes())
            .expect("ncx");
        for (path, body) in [
            (
                "OEBPS/Text/cover.xhtml",
                "<html><body><p>Cover</p></body></html>",
            ),
            (
                "OEBPS/Text/intro.xhtml",
                "<html><body><h1>内容简介</h1><p>简介正文</p></body></html>",
            ),
            (
                "OEBPS/Text/chapter.xhtml",
                "<html><body><h1>第1章 开始</h1><p>真正正文</p></body></html>",
            ),
        ] {
            writer.start_file(path, options).expect("content entry");
            writer.write_all(body.as_bytes()).expect("content");
        }
        let bytes = writer.finish().expect("finish zip").into_inner();

        let parsed = parse_epub(&bytes, "ncx.epub").expect("parse epub2");
        assert_eq!(
            parsed
                .chapters
                .iter()
                .map(|chapter| chapter.kind.as_str())
                .collect::<Vec<_>>(),
            ["frontmatter", "frontmatter", "chapter"]
        );
        assert_eq!(parsed.chapters[2].number, 3);
        assert_eq!(parsed.chapters[2].title, "开始");
        assert_eq!(parsed.chapters[2].content_text, "真正正文");
    }

    #[test]
    fn parses_real_epub_with_desktop_equivalent_structure_when_requested() {
        let Ok(path) = std::env::var("EPUB_TEST_FILE") else {
            return;
        };
        let bytes = fs::read(path).expect("real epub fixture");
        let parsed = parse_epub(&bytes, "real.epub").expect("parse real epub");
        let frontmatter = parsed
            .chapters
            .iter()
            .filter(|chapter| chapter.kind == "frontmatter")
            .count();
        let body = parsed
            .chapters
            .iter()
            .filter(|chapter| chapter.kind == "chapter")
            .count();
        assert!(frontmatter > 0);
        assert!(body > 1000);
        let first = parsed
            .chapters
            .iter()
            .find(|chapter| chapter.kind == "chapter")
            .expect("first body chapter");
        assert_ne!(first.original_label, first.number.to_string());
        assert!(!first
            .content_text
            .starts_with(&format!("第{}章", first.original_label)));
        assert!(parsed.metadata.cover_data_url.is_some());
        if parsed.metadata.title == "斗破苍穹" {
            assert_eq!(parsed.chapters.len(), 1649);
            assert_eq!(frontmatter, 3);
            assert_eq!(body, 1646);
            assert_eq!(first.number, 4);
            assert_eq!(first.title, "陨落的天才");
            assert!(first.content_text.starts_with("“斗之力，三段！”"));
            println!(
                "REAL_EPUB_RUNTIME_RESULT chapters={} frontmatter={} body={} first_body_number={} first_body_title={}",
                parsed.chapters.len(), frontmatter, body, first.number, first.title
            );
        }
    }

    #[test]
    fn explicitly_repairs_legacy_epub_rows_without_source_files() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let mut connection = open_db(&state).expect("database");
        connection.execute("INSERT INTO books(id,title,author,description,source_name,source_size,encoding,source_format,chapter_count,total_words,volumes_json,theme_json,parse_options_json,current_chapter,progress,chapter_progress,created_at,updated_at,last_read_at,revision) VALUES('legacy','旧 EPUB','作者','','legacy.epub',100,'utf-8','epub',3,100,'[]','{}','{}',3,0,0,1,1,1,0)", []).expect("legacy book");
        for (number, title, content) in [
            (1, "第1章", "版权信息\n\n出版社"),
            (2, "内容简介", "内容简介\n\n故事简介"),
            (3, "第1章 开始", "第1章 开始\n\n真正正文"),
        ] {
            connection.execute("INSERT INTO chapters(id,book_id,number,original_label,title,volume,kind,content,content_text,word_count,content_format) VALUES(?1,'legacy',?2,?3,?4,'','chapter',?5,?5,10,'text')", params![format!("legacy:{number}"), number, number.to_string(), title, content]).expect("legacy chapter");
        }

        let book = get_book(&connection, "legacy")
            .expect("book")
            .expect("legacy book");
        let legacy = list_chapters(&connection, "legacy").expect("legacy chapters");
        assert!(legacy_epub_needs_upgrade(&legacy));
        repair_legacy_epub_chapters(&mut connection, &book, legacy).expect("repair");
        let chapters = list_chapters(&connection, "legacy").expect("chapters");
        assert_eq!(
            chapters
                .iter()
                .map(|chapter| chapter.kind.as_str())
                .collect::<Vec<_>>(),
            ["frontmatter", "frontmatter", "chapter"]
        );
        assert_eq!(chapters[2].title, "开始");
        assert_eq!(chapters[2].original_label, "1");
        assert_eq!(chapters[2].content_text, "真正正文");
        assert_eq!(
            get_book(&connection, "legacy")
                .expect("book")
                .expect("legacy book")
                .description,
            "故事简介"
        );
        assert!(!legacy_epub_needs_upgrade(&chapters));
    }

    #[test]
    fn preserves_storage_identity_and_rejects_newer_schema() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: String::new(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let connection = open_db(&state).expect("database");
        let first = ensure_storage_id(&connection).expect("storage id");
        let second = ensure_storage_id(&connection).expect("stable storage id");
        assert_eq!(first, second);
        drop(connection);
        let moved_directory = tempdir().expect("moved tempdir");
        fs::copy(&state.db_path, moved_directory.path().join("library.db"))
            .expect("copy migrated database");
        let moved_state = RuntimeState {
            data_dir: moved_directory.path().to_path_buf(),
            db_path: moved_directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: String::new(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let moved_connection = open_db(&moved_state).expect("moved database");
        assert_eq!(
            ensure_storage_id(&moved_connection).expect("moved storage id"),
            first
        );
        drop(moved_connection);
        let connection = open_db(&state).expect("reopen database");
        connection
            .execute(
                "UPDATE library_meta SET value='99' WHERE key='schemaVersion'",
                [],
            )
            .expect("newer schema fixture");
        drop(connection);
        assert!(open_db(&state)
            .expect_err("newer schema must be rejected")
            .contains("高于当前 Runtime"));
    }

    #[test]
    fn creates_runtime_database_and_discovery() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        open_db(&state).expect("database");
        let path = directory.path().join("local-runtime.json");
        write_discovery(&state, &path).expect("discovery");
        assert!(path.is_file());
    }

    #[test]
    fn marks_non_terminal_import_jobs_failed_after_restart() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let connection = open_db(&state).expect("database");
        let job = Job {
            id: "job".to_string(),
            source_path: "C:\\book.txt".to_string(),
            state: "parsing".to_string(),
            progress: 25,
            message: "parsing".to_string(),
            result_book_id: None,
            error_code: None,
            created_at: now(),
            updated_at: now(),
        };
        save_job(&connection, &job).expect("save job");
        recover_interrupted_jobs(&connection).expect("recover jobs");
        let state: String = connection
            .query_row("SELECT state FROM import_jobs WHERE id='job'", [], |row| {
                row.get(0)
            })
            .expect("job state");
        assert_eq!(state, "failed");
        let cancellable = Job {
            id: "cancel-job".to_string(),
            source_path: "C:\\book.txt".to_string(),
            state: "queued".to_string(),
            progress: 0,
            message: "queued".to_string(),
            result_book_id: None,
            error_code: None,
            created_at: now(),
            updated_at: now(),
        };
        save_job(&connection, &cancellable).expect("save cancellable job");
        assert_eq!(
            cancel_import_job(&connection, &cancellable.id)
                .expect("cancel job")
                .state,
            "cancelled"
        );
    }

    #[test]
    fn import_idempotency_returns_the_original_persisted_job() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let source = directory.path().join("idempotent.txt");
        fs::write(&source, "第一章 开始\n正文").expect("source");
        let enqueue = || {
            enqueue_import(
                &state,
                ImportRequest {
                    path: source.to_string_lossy().to_string(),
                    existing_id: None,
                    options: None,
                    idempotency_key: Some("same-client-request".to_string()),
                    retain_source: Some(false),
                },
            )
            .expect("enqueue")
        };
        let first = enqueue();
        let repeated = enqueue();
        assert_eq!(repeated.id, first.id);
        assert_eq!(wait_for_job(&state, &first.id).state, "completed");
        let after_completion = enqueue();
        assert_eq!(after_completion.id, first.id);
        assert_eq!(after_completion.state, "completed");
        let books = list_books(&open_db(&state).expect("database")).expect("books");
        assert_eq!(books.len(), 1);
        assert!(books[0].managed_source_path.is_none());
        assert!(!directory.path().join("sources").join(&books[0].id).exists());
    }

    #[test]
    fn refuses_to_open_a_desktop_database_as_local_storage() {
        let directory = tempdir().expect("tempdir");
        let database = directory.path().join("library.db");
        let connection = Connection::open(&database).expect("desktop fixture");
        connection
            .execute_batch(
                "CREATE TABLE books (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);",
            )
            .expect("desktop books");
        drop(connection);
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: database,
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        assert!(open_db(&state)
            .expect_err("desktop database must be rejected")
            .contains("不能由本地 Runtime 直接打开"));
    }

    #[test]
    fn imports_book_tracks_progress_and_exports_transfer() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let source = directory.path().join("book.txt");
        fs::write(&source, "《集成书》\n第一章 开始\n正文\n第二章 继续\n正文").expect("source");
        let queued = enqueue_import(
            &state,
            ImportRequest {
                path: source.to_string_lossy().to_string(),
                existing_id: None,
                options: None,
                idempotency_key: None,
                retain_source: None,
            },
        )
        .expect("import");
        assert_eq!(queued.state, "queued");
        let job = wait_for_job(&state, &queued.id);
        assert_eq!(job.state, "completed");
        let mut connection = open_db(&state).expect("database");
        let books = list_books(&connection).expect("books");
        assert_eq!(books.len(), 1);
        connection.execute("INSERT INTO notes(id,title,content_html,content_text,is_pinned,created_at,updated_at) VALUES('note-1','测试笔记','<p>内容</p>','内容',1,1,1)", []).expect("note fixture");
        for invalid_identity in [
            (Some("missing-sequence".to_string()), None),
            (None, Some(1)),
        ] {
            let invalid_response = save_progress(
                &mut connection,
                &ProgressRequest {
                    book_id: books[0].id.clone(),
                    chapter_number: 1,
                    chapter_progress: 0.0,
                    anchor_offset: None,
                    paragraph_index: None,
                    line_index: None,
                    base_revision: Some(0),
                    client_id: invalid_identity.0,
                    sequence: invalid_identity.1,
                },
            );
            assert!(
                String::from_utf8_lossy(&invalid_response).starts_with("HTTP/1.1 400 Bad Request")
            );
        }
        let response = save_progress(
            &mut connection,
            &ProgressRequest {
                book_id: books[0].id.clone(),
                chapter_number: 2,
                chapter_progress: 25.0,
                anchor_offset: Some(10),
                paragraph_index: None,
                line_index: Some(3),
                base_revision: Some(0),
                client_id: Some("test".to_string()),
                sequence: Some(1),
            },
        );
        assert!(String::from_utf8_lossy(&response).contains("\"revision\":1"));
        let duplicate_response = save_progress(
            &mut connection,
            &ProgressRequest {
                book_id: books[0].id.clone(),
                chapter_number: 1,
                chapter_progress: 0.0,
                anchor_offset: None,
                paragraph_index: None,
                line_index: None,
                base_revision: Some(0),
                client_id: Some("test".to_string()),
                sequence: Some(1),
            },
        );
        assert!(String::from_utf8_lossy(&duplicate_response).contains("\"deduplicated\":true"));
        let conflict_response = save_progress(
            &mut connection,
            &ProgressRequest {
                book_id: books[0].id.clone(),
                chapter_number: 1,
                chapter_progress: 0.0,
                anchor_offset: None,
                paragraph_index: None,
                line_index: None,
                base_revision: Some(0),
                client_id: Some("other-client".to_string()),
                sequence: Some(1),
            },
        );
        assert!(String::from_utf8_lossy(&conflict_response).starts_with("HTTP/1.1 409 Conflict"));
        let transfer = directory.path().join("book.novellibrary-transfer");
        export_transfer(
            &state,
            TransferRequest {
                path: transfer.to_string_lossy().to_string(),
                strategy: None,
                book_ids: None,
            },
        )
        .expect("export");
        export_transfer(
            &state,
            TransferRequest {
                path: transfer.to_string_lossy().to_string(),
                strategy: None,
                book_ids: None,
            },
        )
        .expect("replace existing export atomically");
        assert!(transfer.is_file());
        let mut payload: Value =
            serde_json::from_slice(&fs::read(&transfer).expect("transfer bytes")).expect("json");
        assert_eq!(payload["format"], "novel-library-backup");
        for book in payload["books"].as_array_mut().expect("books") {
            let object = book.as_object_mut().expect("book object");
            object.remove("sourcePath");
            object.remove("managedSourcePath");
            object.remove("sourceHash");
            object.remove("revision");
        }
        payload
            .as_object_mut()
            .expect("payload")
            .remove("checksumSha256");
        fs::write(
            &transfer,
            serde_json::to_vec(&payload).expect("desktop backup"),
        )
        .expect("desktop backup file");
        let imported_directory = tempdir().expect("imported tempdir");
        let imported_state = RuntimeState {
            data_dir: imported_directory.path().to_path_buf(),
            db_path: imported_directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "imported-storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        import_transfer(
            &imported_state,
            TransferRequest {
                path: transfer.to_string_lossy().to_string(),
                strategy: Some("replace".to_string()),
                book_ids: None,
            },
        )
        .expect("import desktop backup");
        let imported_connection = open_db(&imported_state).expect("imported database");
        assert_eq!(
            list_books(&imported_connection)
                .expect("imported books")
                .len(),
            1
        );
        assert_eq!(
            list_notes(&imported_connection)
                .expect("imported notes")
                .len(),
            1
        );
    }

    #[test]
    fn transfer_checksum_and_selected_book_boundaries_are_enforced() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        for (name, title) in [("one.txt", "第一本"), ("two.txt", "第二本")] {
            let source = directory.path().join(name);
            fs::write(&source, format!("《{title}》\n第一章 开始\n正文")).expect("source");
            let queued = enqueue_import(
                &state,
                ImportRequest {
                    path: source.to_string_lossy().to_string(),
                    existing_id: None,
                    options: None,
                    idempotency_key: None,
                    retain_source: None,
                },
            )
            .expect("enqueue");
            assert_eq!(wait_for_job(&state, &queued.id).state, "completed");
        }
        let connection = open_db(&state).expect("database");
        connection.execute("INSERT INTO notes(id,title,content_html,content_text,is_pinned,created_at,updated_at) VALUES('note-1','私有笔记','<p>内容</p>','内容',0,1,1)", []).expect("note");
        let books = list_books(&connection).expect("books");
        assert_eq!(books.len(), 2);
        let selected_id = books[0].id.clone();

        let full_transfer = directory.path().join("full.json");
        export_transfer(
            &state,
            TransferRequest {
                path: full_transfer.to_string_lossy().to_string(),
                strategy: None,
                book_ids: None,
            },
        )
        .expect("full export");
        let mut tampered: Value =
            serde_json::from_slice(&fs::read(&full_transfer).expect("full bytes"))
                .expect("full payload");
        tampered["books"][0]["title"] = json!("被篡改");
        let tampered_path = directory.path().join("tampered.json");
        fs::write(
            &tampered_path,
            serde_json::to_vec(&tampered).expect("tampered bytes"),
        )
        .expect("tampered transfer");
        assert!(import_transfer(
            &state,
            TransferRequest {
                path: tampered_path.to_string_lossy().to_string(),
                strategy: Some("merge".to_string()),
                book_ids: None,
            },
        )
        .expect_err("checksum mismatch")
        .contains("checksum 校验失败"));

        let selected_transfer = directory.path().join("selected.json");
        export_transfer(
            &state,
            TransferRequest {
                path: selected_transfer.to_string_lossy().to_string(),
                strategy: None,
                book_ids: Some(vec![selected_id.clone()]),
            },
        )
        .expect("selected export");
        let selected_payload: Value =
            serde_json::from_slice(&fs::read(&selected_transfer).expect("selected bytes"))
                .expect("selected payload");
        assert_eq!(
            selected_payload["books"].as_array().expect("books").len(),
            1
        );
        assert!(selected_payload["notes"]
            .as_array()
            .expect("notes")
            .is_empty());
        assert!(export_transfer(
            &state,
            TransferRequest {
                path: directory
                    .path()
                    .join("missing.json")
                    .to_string_lossy()
                    .to_string(),
                strategy: None,
                book_ids: Some(vec!["missing-book".to_string()]),
            },
        )
        .is_err());

        let imported_directory = tempdir().expect("imported tempdir");
        let imported_state = RuntimeState {
            data_dir: imported_directory.path().to_path_buf(),
            db_path: imported_directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "imported-storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        import_transfer(
            &imported_state,
            TransferRequest {
                path: full_transfer.to_string_lossy().to_string(),
                strategy: Some("selected".to_string()),
                book_ids: Some(vec![selected_id.clone()]),
            },
        )
        .expect("selected import");
        let imported = open_db(&imported_state).expect("imported database");
        let imported_books = list_books(&imported).expect("imported books");
        assert_eq!(imported_books.len(), 1);
        assert_eq!(imported_books[0].id, selected_id);
        assert!(list_notes(&imported).expect("imported notes").is_empty());
        assert!(import_transfer(
            &imported_state,
            TransferRequest {
                path: full_transfer.to_string_lossy().to_string(),
                strategy: Some("selected".to_string()),
                book_ids: Some(vec!["missing-book".to_string()]),
            },
        )
        .is_err());
    }

    #[test]
    fn merge_transfer_preserves_existing_book_when_same_id_has_different_content() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let source = directory.path().join("merge.txt");
        fs::write(&source, "《合并测试》\n第一章 开始\n原始正文").expect("source");
        let queued = enqueue_import(
            &state,
            ImportRequest {
                path: source.to_string_lossy().to_string(),
                existing_id: None,
                options: None,
                idempotency_key: None,
                retain_source: Some(true),
            },
        )
        .expect("enqueue");
        assert_eq!(wait_for_job(&state, &queued.id).state, "completed");
        let original = list_books(&open_db(&state).expect("database"))
            .expect("books")
            .remove(0);
        assert!(original.managed_source_path.is_some());

        let transfer = directory.path().join("merge.json");
        export_transfer(
            &state,
            TransferRequest {
                path: transfer.to_string_lossy().to_string(),
                strategy: None,
                book_ids: None,
            },
        )
        .expect("export");
        let mut payload: Value =
            serde_json::from_slice(&fs::read(&transfer).expect("transfer")).expect("payload");
        payload
            .as_object_mut()
            .expect("payload object")
            .remove("checksumSha256");
        payload["chapters"][0]["content"] = json!("导入版本正文");
        payload["chapters"][0]["contentText"] = json!("导入版本正文");
        fs::write(&transfer, serde_json::to_vec(&payload).expect("serialize"))
            .expect("write modified transfer");

        import_transfer(
            &state,
            TransferRequest {
                path: transfer.to_string_lossy().to_string(),
                strategy: Some("merge".to_string()),
                book_ids: None,
            },
        )
        .expect("merge");
        let connection = open_db(&state).expect("database after merge");
        let books = list_books(&connection).expect("merged books");
        assert_eq!(books.len(), 2);
        let preserved = get_book(&connection, &original.id)
            .expect("original book")
            .expect("original remains");
        assert_eq!(preserved.managed_source_path, original.managed_source_path);
        assert_eq!(
            list_chapters(&connection, &original.id).expect("original chapters")[0].content_text,
            "原始正文"
        );
        let copy = books
            .iter()
            .find(|book| book.id != original.id)
            .expect("import copy");
        assert!(copy.title.ends_with("（导入副本）"));
        assert_eq!(
            list_chapters(&connection, &copy.id).expect("copy chapters")[0].content_text,
            "导入版本正文"
        );
    }

    #[test]
    fn database_check_and_diagnostics_are_available_without_sensitive_identifiers() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage-secret-123456".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        open_db(&state).expect("initialize database");
        let check = String::from_utf8(handle(
            &state,
            "POST",
            "/v2/runtime/check-database",
            Some("Bearer token"),
            b"{}",
        ))
        .expect("check response");
        assert!(check.starts_with("HTTP/1.1 200 OK"));
        assert!(check.contains("\"ok\":true"));
        let diagnostics = String::from_utf8(handle(
            &state,
            "GET",
            "/v2/runtime/diagnostics",
            Some("Bearer token"),
            &[],
        ))
        .expect("diagnostics response");
        assert!(diagnostics.contains("\"storageIdSuffix\":\"123456\""));
        assert!(!diagnostics.contains("storage-secret-123456"));
        assert!(!diagnostics.contains("databasePath"));
    }

    #[test]
    fn replace_transfer_rolls_back_when_chapters_are_invalid() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let source = directory.path().join("book.txt");
        fs::write(&source, "第一章 开始\n原书正文").expect("source");
        let queued = enqueue_import(
            &state,
            ImportRequest {
                path: source.to_string_lossy().to_string(),
                existing_id: None,
                options: None,
                idempotency_key: None,
                retain_source: None,
            },
        )
        .expect("enqueue");
        assert_eq!(wait_for_job(&state, &queued.id).state, "completed");

        let invalid = directory.path().join("invalid.json");
        fs::write(
            &invalid,
            serde_json::to_vec(&json!({
                "format": "novel-library-transfer",
                "version": 1,
                "books": [],
                "chapters": [{
                    "id": "chapter-1", "bookId": "missing", "number": 1,
                    "originalLabel": "第一章", "title": "坏章节", "volume": "",
                    "kind": "chapter", "content": "x", "contentText": "x",
                    "wordCount": 1, "contentFormat": "text"
                }]
            }))
            .expect("payload"),
        )
        .expect("invalid transfer");
        assert!(import_transfer(
            &state,
            TransferRequest {
                path: invalid.to_string_lossy().to_string(),
                strategy: Some("replace".to_string()),
                book_ids: None,
            },
        )
        .is_err());
        let connection = open_db(&state).expect("database");
        assert_eq!(list_books(&connection).expect("books").len(), 1);
    }

    #[test]
    fn rejects_requests_without_runtime_token() {
        let directory = tempdir().expect("tempdir");
        let state = RuntimeState {
            data_dir: directory.path().to_path_buf(),
            db_path: directory.path().join("library.db"),
            token: Arc::new("token".to_string()),
            port: 1234,
            session_id: "session".to_string(),
            storage_id: "storage".to_string(),
            shutdown: Arc::new(AtomicBool::new(false)),
        };
        let response = handle(&state, "GET", "/v1/books", None, &[]);
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 401 Unauthorized"));
        let response = handle(
            &state,
            "POST",
            "/v2/runtime/restart",
            Some("Bearer token"),
            &[],
        );
        assert!(String::from_utf8_lossy(&response).contains("\"accepted\":true"));
        assert!(state.shutdown.load(Ordering::SeqCst));
    }
}
