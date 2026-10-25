use crate::database::DatabaseState;
use futures_util::StreamExt;
use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect::Policy,
    Client, Url,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

const MAX_PAGE: usize = 5 * 1024 * 1024;
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub(crate) fn migrate(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS online_books (
        book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
        catalog_url TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle',
        auto_update INTEGER NOT NULL DEFAULT 0, last_checked INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS online_chapters (
        book_id TEXT NOT NULL REFERENCES online_books(book_id) ON DELETE CASCADE,
        number INTEGER NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        error TEXT NOT NULL DEFAULT '', PRIMARY KEY(book_id,number), UNIQUE(book_id,url));
        CREATE INDEX IF NOT EXISTS idx_online_catalog_url ON online_books(catalog_url);",
    )
    .map_err(err)?;
    let mut columns = c.prepare("PRAGMA table_info(online_books)").map_err(err)?;
    let names = columns
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for field in ["task_visible", "catalog_complete"] {
        if !names.iter().any(|name| name == field) {
            c.execute(
                &format!("ALTER TABLE online_books ADD COLUMN {field} INTEGER NOT NULL DEFAULT 1"),
                [],
            )
            .map_err(err)?;
        }
    }
    Ok(())
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let a = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_multicast()
                && !v.is_unspecified()
                && !v.is_broadcast()
                && !v.is_documentation()
                && a[0] != 0
                && a[0] < 224
                && !(a[0] == 100 && (64..=127).contains(&a[1]))
                && !(a[0] == 198 && (a[1] == 18 || a[1] == 19))
        }
        IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_ip(IpAddr::V4(v)))
            .unwrap_or_else(|| {
                // Only global unicast; exclude documentation and transition ranges.
                let s = v.segments();
                (s[0] & 0xe000) == 0x2000
                    && s[0] != 0x2002
                    && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
            }),
    }
}

pub(crate) fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "请输入完整的 http 或 https 链接")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err("仅支持不含账号密码的公开 HTTP/HTTPS 网页（80/443 端口）".into());
    }
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host
            .parse::<IpAddr>()
            .map(|ip| !public_ip(ip))
            .unwrap_or(!host.contains('.'))
    {
        return Err("请输入公开网站的链接".into());
    }
    Ok(url)
}

fn usable_resolved_ip(host: &str, ip: IpAddr) -> bool {
    if public_ip(ip) {
        return true;
    }
    // TUN clients (e.g. Mihomo) return synthetic DNS addresses in 198.18/15.
    // Permit these only for a validated domain, never for an IP literal. The OS
    // routes the synthetic destination through the user's existing TUN network.
    if host.parse::<IpAddr>().is_ok() {
        return false;
    }
    matches!(ip, IpAddr::V4(v) if v.octets()[0] == 198 && (v.octets()[1] == 18 || v.octets()[1] == 19))
}

fn validate_addresses(host: &str, addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, String> {
    if addresses.is_empty() || addresses.iter().any(|a| !usable_resolved_ip(host, a.ip())) {
        return Err("仅允许访问公开网站，不能读取本机或内网地址".into());
    }
    Ok(addresses)
}

struct PublicResolver;
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses = tokio::time::timeout(
                Duration::from_secs(10),
                tokio::net::lookup_host((name.as_str(), 0)),
            )
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "域名解析超时"))??
            .collect();
            let addresses = validate_addresses(name.as_str(), addresses).map_err(|cause| {
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, cause)
            })?;
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

fn build_client(resolver: impl Resolve + 'static) -> Result<Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        // Validate the addresses actually used for every new connection, including redirects.
        .dns_resolver(resolver)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(2)
        .user_agent("NovelLibrary/0.6 (personal reader)")
        .build()
        .map_err(err)
}

fn page_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| build_client(PublicResolver))
        .as_ref()
        .map_err(Clone::clone)
}

async fn fetch(url: &str, token: Option<&str>) -> Result<(String, Vec<u8>, String), String> {
    fetch_with_client(page_client()?, url, token).await
}

async fn fetch_with_client(
    client: &Client,
    url: &str,
    token: Option<&str>,
) -> Result<(String, Vec<u8>, String), String> {
    let mut current = validate_url(url)?;
    for _ in 0..6 {
        let mut request = client.get(current.clone()).header(
            "Accept",
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        );
        if let Some(key) = token {
            if current.host_str() != Some("api.search.brave.com") {
                return Err("搜索服务发生了非预期跳转".into());
            }
            request = request.header("X-Subscription-Token", key);
        }
        let response = request.send().await.map_err(|error| {
            let mut source: &dyn std::error::Error = &error;
            loop {
                let message = source.to_string();
                for known in ["仅允许访问公开网站，不能读取本机或内网地址", "域名解析超时"]
                {
                    if message.contains(known) {
                        return known.to_string();
                    }
                }
                match source.source() {
                    Some(next) => source = next,
                    None => break,
                }
            }
            "网页请求失败或超时，请检查网络后重试".to_string()
        })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("网站跳转缺少地址")?;
            current = validate_url(current.join(location).map_err(err)?.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!(
                "网站返回 HTTP {}，可能需要登录、验证或稍后重试",
                response.status().as_u16()
            ));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !content_type.is_empty()
            && ![
                "text/",
                "application/xhtml+xml",
                "application/json",
                "application/xml",
            ]
            .iter()
            .any(|t| content_type.starts_with(t))
        {
            return Err("这个链接不是可解析的网页".into());
        }
        if response.content_length().unwrap_or(0) > MAX_PAGE as u64 {
            return Err("网页超过 5 MB，已停止读取".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "网页传输中断，请重试")?;
            if bytes.len() + chunk.len() > MAX_PAGE {
                return Err("网页超过 5 MB，已停止读取".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((current.to_string(), bytes, content_type));
    }
    Err("网页跳转次数过多".into())
}

#[derive(Serialize)]
pub struct FetchedPage {
    url: String,
    html: String,
}

fn decode(bytes: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(8192)]);
    let re = regex::Regex::new(r#"(?i)charset\s*=\s*["']?([a-zA-Z0-9_-]+)"#).unwrap();
    let label = re.captures(content_type).or_else(|| re.captures(&head));
    let encoding = label
        .as_ref()
        .and_then(|c| encoding_rs::Encoding::for_label(c[1].as_bytes()));
    if let Some(enc) = encoding {
        return enc.decode(bytes).0.into_owned();
    }
    String::from_utf8(bytes.to_vec())
        .unwrap_or_else(|_| encoding_rs::GBK.decode(bytes).0.into_owned())
}

#[cfg(debug_assertions)]
fn log_test_request(file: &str, record: serde_json::Value) {
    use std::io::Write;
    static LOG: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if let Some(directory) = std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
        // Serialize the entire record before one append; concurrent requests must not mix JSON fragments.
        let record = format!("{record}\n");
        let Ok(_guard) = LOG.lock() else { return };
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::path::PathBuf::from(directory).join(file))
        {
            let _ = log.write_all(record.as_bytes());
        }
    }
}

#[tauri::command]
pub async fn fetch_online_page(url: String) -> Result<FetchedPage, String> {
    #[cfg(debug_assertions)]
    let started = std::time::Instant::now();
    #[cfg(debug_assertions)]
    log_test_request(
        "network-requests.jsonl",
        serde_json::json!({"url": url, "at": now()}),
    );
    let fetched = fetch(&url, None).await;
    #[cfg(debug_assertions)]
    log_test_request(
        "network-timings.jsonl",
        serde_json::json!({"url": url, "finishedAt": now(), "elapsedMs": started.elapsed().as_secs_f64() * 1000.0, "ok": fetched.is_ok()}),
    );
    let (url, bytes, content_type) = fetched?;
    let page = FetchedPage {
        url,
        html: decode(&bytes, &content_type),
    };
    #[cfg(debug_assertions)]
    if reqwest::Url::parse(&page.url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| {
            ["baidu.com", "sogou.com", "so.com"]
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
    {
        log_test_request(
            "search-responses.jsonl",
            serde_json::json!({"url": page.url, "html": page.html, "at": now()}),
        );
    }
    Ok(page)
}

#[derive(Serialize)]
pub struct SearchHit {
    title: String,
    url: String,
    description: String,
}

#[tauri::command]
pub async fn search_online_books(
    query: String,
    api_key: String,
    offset: Option<u8>,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() || query.len() > 1800 {
        return Err("请输入有效的搜索关键词".into());
    }
    if api_key.trim().is_empty() {
        return Err("请填写 Brave Search API 密钥，或使用浏览器搜索后粘贴链接".into());
    }
    let mut url = Url::parse("https://api.search.brave.com/res/v1/web/search").unwrap();
    url.query_pairs_mut()
        .append_pair("q", query.trim())
        .append_pair("count", "10")
        .append_pair("offset", &offset.unwrap_or(0).min(9).to_string());
    let (_, bytes, _) = fetch(url.as_str(), Some(api_key.trim())).await?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "搜索服务返回了无法识别的数据")?;
    let hits = value["web"]["results"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let url = row["url"].as_str()?;
                    validate_url(url).ok()?;
                    Some(SearchHit {
                        title: row["title"].as_str().unwrap_or(url).into(),
                        url: url.into(),
                        description: row["description"].as_str().unwrap_or("").into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogChapter {
    pub title: String,
    pub url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInput {
    pub title: String,
    pub author: String,
    pub description: String,
    pub catalog_url: String,
    pub chapters: Vec<CatalogChapter>,
    #[serde(default = "visible_task")]
    pub complete: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineChapter {
    number: i64,
    title: String,
    url: String,
    status: String,
    error: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBook {
    pub book_id: String,
    title: String,
    catalog_url: String,
    state: String,
    auto_update: bool,
    last_checked: i64,
    error: String,
    #[serde(default = "visible_task")]
    task_visible: bool,
    #[serde(default = "visible_task")]
    catalog_complete: bool,
    chapters: Vec<OnlineChapter>,
}
fn visible_task() -> bool {
    true
}

pub fn save_catalog(connection: &mut Connection, input: CatalogInput) -> Result<String, String> {
    validate_url(&input.catalog_url)?;
    if input.title.trim().is_empty() || input.chapters.is_empty() || input.chapters.len() > 30000 {
        return Err("目录为空或章节数量异常".into());
    }
    let mut urls = std::collections::HashSet::new();
    for chapter in &input.chapters {
        validate_url(&chapter.url)?;
        if chapter.title.trim().is_empty() || !urls.insert(&chapter.url) {
            return Err("目录包含空标题或重复地址".into());
        }
    }
    let tx = connection.transaction().map_err(err)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT book_id FROM online_books WHERE catalog_url=?1",
            [&input.catalog_url],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let id = existing
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let old: Vec<String> = {
        let mut s = tx
            .prepare("SELECT url FROM online_chapters WHERE book_id=?1 ORDER BY number")
            .map_err(err)?;
        let rows = s
            .query_map([&id], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        rows
    };
    if (input.complete && old.len() > input.chapters.len())
        || old
            .iter()
            .zip(&input.chapters)
            .any(|(url, chapter)| url != &chapter.url)
    {
        return Err(
            "网站目录顺序或地址发生变化，已保留原书和阅读进度；请检查来源，不会自动覆盖".into(),
        );
    }
    // An early page of the same directory must not shrink an already imported book.
    if !input.complete && existing.is_some() && old.len() >= input.chapters.len() {
        tx.commit().map_err(err)?;
        return Ok(id);
    }
    if existing.is_none() {
        let theme = serde_json::json!({"preset":"ink","accent":"#c9a866","background":"#101719","text":"#f1f2ef","overlay":48,"positionX":50,"positionY":50});
        let options = serde_json::json!({"encoding":"auto","chapterPattern":"","adPatterns":"","mergeWrapped":true,"removeAds":true});
        tx.execute("INSERT INTO books (id,title,author,description,source_name,source_format,encoding,theme_json,parse_options_json,created_at,updated_at,last_read_at) VALUES (?1,?2,?3,?4,?5,'web','utf-8',?6,?7,?8,?8,?8)", params![id,input.title.trim(),input.author,input.description,input.catalog_url,theme.to_string(),options.to_string(),now()]).map_err(err)?;
        tx.execute(
            "INSERT INTO online_books(book_id,catalog_url) VALUES(?1,?2)",
            params![id, input.catalog_url],
        )
        .map_err(err)?;
    }
    for (index, chapter) in input.chapters.iter().enumerate().skip(old.len()) {
        let number = index as i64 + 1;
        tx.execute("INSERT INTO chapters(id,book_id,number,original_label,title,content) VALUES(?1,?2,?3,?4,?4,'')", params![format!("{id}:{number}"),id,number,chapter.title]).map_err(err)?;
        tx.execute(
            "INSERT INTO online_chapters(book_id,number,url) VALUES(?1,?2,?3)",
            params![id, number, chapter.url],
        )
        .map_err(err)?;
    }
    tx.execute("UPDATE books SET chapter_count=?2,updated_at=?3,progress=((current_chapter-1)+chapter_progress/100.0)/?2*100 WHERE id=?1", params![id,input.chapters.len() as i64,now()]).map_err(err)?;
    tx.execute(
        "UPDATE online_books SET last_checked=?2,error='',catalog_complete=?3 WHERE book_id=?1",
        params![id, now(), input.complete],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(id)
}

#[tauri::command]
pub fn save_online_catalog(
    state: State<'_, DatabaseState>,
    input: CatalogInput,
) -> Result<String, String> {
    save_catalog(&mut state.connect()?, input)
}

#[tauri::command]
pub fn list_online_books(state: State<'_, DatabaseState>) -> Result<Vec<OnlineBook>, String> {
    list_books(&state.connect()?)
}

pub(crate) fn list_books(c: &Connection) -> Result<Vec<OnlineBook>, String> {
    let mut s = c.prepare("SELECT o.book_id,b.title,o.catalog_url,o.state,o.auto_update,o.last_checked,o.error,o.task_visible,o.catalog_complete FROM online_books o JOIN books b ON b.id=o.book_id ORDER BY b.created_at DESC").map_err(err)?;
    let mut books = s
        .query_map([], |r| {
            Ok(OnlineBook {
                book_id: r.get(0)?,
                title: r.get(1)?,
                catalog_url: r.get(2)?,
                state: r.get(3)?,
                auto_update: r.get(4)?,
                last_checked: r.get(5)?,
                error: r.get(6)?,
                task_visible: r.get(7)?,
                catalog_complete: r.get(8)?,
                chapters: vec![],
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    for book in &mut books {
        let mut s = c.prepare("SELECT o.number,c.title,o.url,o.status,o.error FROM online_chapters o JOIN chapters c ON c.book_id=o.book_id AND c.number=o.number WHERE o.book_id=?1 ORDER BY o.number").map_err(err)?;
        book.chapters = s
            .query_map([&book.book_id], |r| {
                Ok(OnlineChapter {
                    number: r.get(0)?,
                    title: r.get(1)?,
                    url: r.get(2)?,
                    status: r.get(3)?,
                    error: r.get(4)?,
                })
            })
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
    }
    Ok(books)
}

pub(crate) fn restore_books(c: &Connection, books: &[OnlineBook]) -> Result<(), String> {
    for book in books {
        validate_url(&book.catalog_url)?;
        // Restored tasks never silently start network requests. The user can resume them.
        c.execute("INSERT INTO online_books(book_id,catalog_url,state,last_checked,task_visible,catalog_complete) VALUES(?1,?2,'paused',?3,?4,?5) ON CONFLICT(book_id) DO UPDATE SET catalog_url=excluded.catalog_url,state='paused',auto_update=0,last_checked=excluded.last_checked,task_visible=excluded.task_visible,catalog_complete=excluded.catalog_complete", params![book.book_id, book.catalog_url, book.last_checked,book.task_visible,book.catalog_complete]).map_err(err)?;
        c.execute(
            "DELETE FROM online_chapters WHERE book_id=?1",
            [&book.book_id],
        )
        .map_err(err)?;
        for chapter in &book.chapters {
            validate_url(&chapter.url)?;
            let content: String = c
                .query_row(
                    "SELECT content FROM chapters WHERE book_id=?1 AND number=?2",
                    params![book.book_id, chapter.number],
                    |r| r.get(0),
                )
                .map_err(err)?;
            c.execute(
                "INSERT INTO online_chapters(book_id,number,url,status) VALUES(?1,?2,?3,?4)",
                params![
                    book.book_id,
                    chapter.number,
                    chapter.url,
                    if content.trim().is_empty() {
                        "pending"
                    } else {
                        "cached"
                    }
                ],
            )
            .map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn store_online_chapter(
    state: State<'_, DatabaseState>,
    book_id: String,
    number: i64,
    content: String,
    error: String,
) -> Result<(), String> {
    store_chapter(&mut state.connect()?, &book_id, number, &content, &error)
}

fn store_chapter(
    c: &mut Connection,
    id: &str,
    number: i64,
    content: &str,
    error: &str,
) -> Result<(), String> {
    if content.len() > MAX_PAGE {
        return Err("章节正文过大".into());
    }
    let tx = c.transaction().map_err(err)?;
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM online_chapters WHERE book_id=?1 AND number=?2",
            params![id, number],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let status = status.ok_or("在线章节不存在或已删除")?;
    if status == "cached" {
        return Ok(());
    }
    if error.is_empty() && content.trim().is_empty() {
        return Err("正文为空，不能标记下载成功".into());
    }
    if error.is_empty() {
        let duplicate: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM chapters WHERE book_id=?1 AND number<>?2 AND content_text=?3)", params![id,number,content], |r| r.get(0)).map_err(err)?;
        if duplicate {
            return Err("正文与已有章节完全重复，可能是网站返回了错误内容".into());
        }
        tx.execute("UPDATE chapters SET content=?3,content_text=?3,word_count=?4,content_format='text' WHERE book_id=?1 AND number=?2", params![id,number,content,content.chars().filter(|c| !c.is_whitespace()).count() as i64]).map_err(err)?;
        tx.execute("UPDATE books SET total_words=(SELECT COALESCE(SUM(word_count),0) FROM chapters WHERE book_id=?1),updated_at=?2 WHERE id=?1",params![id,now()]).map_err(err)?;
    }
    tx.execute(
        "UPDATE online_chapters SET status=?3,error=?4 WHERE book_id=?1 AND number=?2",
        params![
            id,
            number,
            if error.is_empty() { "cached" } else { "failed" },
            error
        ],
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

#[tauri::command]
pub fn set_online_state(
    state: State<'_, DatabaseState>,
    book_id: String,
    status: Option<String>,
    auto_update: Option<bool>,
    error: Option<String>,
    task_visible: Option<bool>,
) -> Result<(), String> {
    if let Some(s) = &status {
        if ![
            "idle",
            "downloading",
            "paused",
            "cancelled",
            "complete",
            "failed",
        ]
        .contains(&s.as_str())
        {
            return Err("无效的任务状态".into());
        }
    }
    state.connect()?.execute("UPDATE online_books SET state=COALESCE(?2,state),auto_update=COALESCE(?3,auto_update),error=COALESCE(?4,error),task_visible=COALESCE(?5,task_visible) WHERE book_id=?1",params![book_id,status,auto_update,error,task_visible]).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires public network access; run explicitly"]
    fn live_public_search_and_fetch() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (_, bytes, _) = fetch("https://www.bing.com/search?format=rss&q=novel", None)
                .await
                .unwrap();
            assert!(
                String::from_utf8_lossy(&bytes).contains("<rss"),
                "public search did not return RSS"
            );
            let page = fetch_online_page("https://example.com".into())
                .await
                .unwrap();
            assert!(page.html.contains("Example Domain"));
        });
    }
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::database::migrate(&c).unwrap();
        c
    }
    fn catalog(count: usize) -> CatalogInput {
        CatalogInput {
            complete: true,
            title: "山河".into(),
            author: "某作者".into(),
            description: "".into(),
            catalog_url: "https://example.com/book".into(),
            chapters: (1..=count)
                .map(|n| CatalogChapter {
                    title: format!("第{n}章"),
                    url: format!("https://example.com/{n}"),
                })
                .collect(),
        }
    }
    #[test]
    fn upgrades_an_existing_current_schema_library() {
        let mut c = db();
        c.execute_batch("DROP TABLE online_chapters; DROP TABLE online_books;")
            .unwrap();
        crate::database::migrate(&c).unwrap();
        assert!(save_catalog(&mut c, catalog(2)).is_ok());
    }
    #[test]
    fn incremental_catalog_preserves_content_ids_and_progress() {
        let mut c = db();
        let id = save_catalog(&mut c, catalog(2)).unwrap();
        store_chapter(&mut c, &id, 1, "第一章正文", "").unwrap();
        crate::database::save_progress(&c, &id, 1, 52.0).unwrap();
        assert_eq!(save_catalog(&mut c, catalog(3)).unwrap(), id);
        let book = crate::database::get_book(&c, &id).unwrap().unwrap();
        assert_eq!(book.chapter_count, 3);
        assert_eq!(book.chapter_progress, 52.0);
        assert_eq!(
            crate::database::get_chapter(&c, &id, 1)
                .unwrap()
                .unwrap()
                .content,
            "第一章正文"
        );
        let mut changed = catalog(3);
        changed.chapters.swap(0, 1);
        assert!(save_catalog(&mut c, changed).is_err());
        assert_eq!(list_books(&c).unwrap()[0].chapters.len(), 3);
    }
    #[test]
    fn empty_or_failed_fetch_never_overwrites_cached_content() {
        let mut c = db();
        let id = save_catalog(&mut c, catalog(2)).unwrap();
        assert!(store_chapter(&mut c, &id, 1, "", "").is_err());
        store_chapter(&mut c, &id, 1, "", "网络失败").unwrap();
        assert_eq!(list_books(&c).unwrap()[0].chapters[0].status, "failed");
        store_chapter(&mut c, &id, 1, "正常正文", "").unwrap();
        store_chapter(&mut c, &id, 1, "", "过期请求失败").unwrap();
        assert_eq!(list_books(&c).unwrap()[0].chapters[0].status, "cached");
        crate::database::delete_book(&c, &id).unwrap();
        assert!(list_books(&c).unwrap().is_empty());
        assert!(store_chapter(&mut c, &id, 1, "过期请求", "").is_err());
    }
    #[test]
    fn partial_directory_reuses_complete_book_without_shrinking_it() {
        let mut c = db();
        let id = save_catalog(&mut c, catalog(3)).unwrap();
        store_chapter(&mut c, &id, 2, "已有正文", "").unwrap();
        crate::database::save_progress(&c, &id, 2, 52.0).unwrap();
        let mut partial = catalog(1);
        partial.complete = false;
        assert_eq!(save_catalog(&mut c, partial).unwrap(), id);
        let books = list_books(&c).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].chapters.len(), 3);
        assert!(books[0].catalog_complete);
        assert_eq!(books[0].chapters[1].status, "cached");
        assert_eq!(
            crate::database::get_book(&c, &id)
                .unwrap()
                .unwrap()
                .chapter_progress,
            52.0
        );
        assert!(save_catalog(&mut c, catalog(1)).is_err());
    }
    #[test]
    fn backup_roundtrip_keeps_remote_urls_and_partial_cache() {
        let mut c = db();
        let id = save_catalog(&mut c, catalog(2)).unwrap();
        store_chapter(&mut c, &id, 1, "已有正文", "").unwrap();
        c.execute(
            "UPDATE online_books SET task_visible=0 WHERE book_id=?1",
            [&id],
        )
        .unwrap();
        let path =
            std::env::temp_dir().join(format!("online-backup-{}.json", uuid::Uuid::new_v4()));
        crate::database::export_backup(&c, &path).unwrap();
        let mut target = db();
        crate::database::import_backup_with_strategy(&mut target, &path, false).unwrap();
        let books = list_books(&target).unwrap();
        assert_eq!(books[0].chapters[0].status, "cached");
        assert_eq!(books[0].chapters[1].status, "pending");
        assert_eq!(books[0].chapters[1].url, "https://example.com/2");
        assert_eq!(books[0].state, "paused");
        assert!(!books[0].task_visible);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn rejects_private_and_special_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.1.2.3",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(validate_url("file:///secret").is_err());
        assert!(validate_url("https://user:pass@example.com").is_err());
        assert!(validate_url("http://198.18.0.84").is_err());
        assert!(validate_url("http://localhost").is_err());
        assert!(usable_resolved_ip(
            "www.bing.com",
            "198.18.0.84".parse().unwrap()
        ));
        assert!(!usable_resolved_ip(
            "198.18.0.84",
            "198.18.0.84".parse().unwrap()
        ));
        assert!(!usable_resolved_ip(
            "example.com",
            "192.168.1.2".parse().unwrap()
        ));
    }
    #[test]
    fn detects_chinese_page_encoding() {
        let (bytes, _, _) = encoding_rs::GBK.encode("<meta charset=gbk>第一章 山河");
        assert!(decode(&bytes, "text/html").contains("第一章 山河"));
    }

    #[test]
    fn rejects_empty_or_mixed_dns_answers_before_connecting() {
        assert!(validate_addresses("example.com", vec![]).is_err());
        assert!(validate_addresses(
            "example.com",
            vec!["8.8.8.8:0".parse().unwrap(), "127.0.0.1:0".parse().unwrap()]
        )
        .is_err());
        assert!(validate_addresses(
            "example.com",
            vec![
                "8.8.8.8:0".parse().unwrap(),
                "198.18.0.84:0".parse().unwrap()
            ]
        )
        .is_ok());
        assert!(validate_addresses("198.18.0.84", vec!["198.18.0.84:0".parse().unwrap()]).is_err());
    }

    // Only the test client resolves this fixture domain to loopback. Production always uses PublicResolver.
    struct FixtureResolver {
        address: SocketAddr,
        lookups: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Resolve for FixtureResolver {
        fn resolve(&self, name: Name) -> Resolving {
            assert_eq!(name.as_str(), "pool.example");
            self.lookups
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let address = self.address;
            Box::pin(async move { Ok(Box::new(std::iter::once(address)) as Addrs) })
        }
    }

    fn http_fixture(responses: Vec<String>) -> (SocketAddr, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut requests = Vec::new();
            // All responses must use this one TCP connection; a new connection fails the test.
            for response in responses {
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert!(!first.is_empty());
                requests.push(first);
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    assert!(!header.is_empty());
                }
                stream.write_all(response.as_bytes()).unwrap();
                stream.flush().unwrap();
            }
            requests
        });
        (address, thread)
    }

    #[test]
    fn reuses_one_connection_and_dns_lookup_across_redirect_and_chapters() {
        let (address, server) = http_fixture(vec![
            "HTTP/1.1 302 Found\r\nLocation: /one\r\nContent-Length: 0\r\n\r\n".into(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 3\r\n\r\none".into(),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 3\r\n\r\ntwo".into(),
        ]);
        let lookups = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let client = build_client(FixtureResolver {
                address,
                lookups: lookups.clone(),
            })
            .unwrap();
            let base = "http://pool.example";
            let (url, body, _) = fetch_with_client(&client, &format!("{base}/redirect"), None)
                .await
                .unwrap();
            assert_eq!(url, format!("{base}/one"));
            assert_eq!(body, b"one");
            let (_, body, _) = fetch_with_client(&client, &format!("{base}/two"), None)
                .await
                .unwrap();
            assert_eq!(body, b"two");
        });
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(lookups.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(requests[0].starts_with("GET /redirect "));
        assert!(requests[2].starts_with("GET /two "));
    }

    #[test]
    fn pooled_client_still_rejects_a_redirect_to_a_private_address() {
        let (address, server) = http_fixture(vec![
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n"
                .into(),
        ]);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let client = build_client(FixtureResolver {
                address,
                lookups: Default::default(),
            })
            .unwrap();
            let error = fetch_with_client(&client, "http://pool.example/redirect", None)
                .await
                .unwrap_err();
            assert_eq!(error, "请输入公开网站的链接");
        });
        assert_eq!(server.join().unwrap().len(), 1);
    }
}
