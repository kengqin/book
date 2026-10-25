use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Session {
    busy: tokio::sync::Mutex<()>,
    ready: AtomicBool,
}
#[derive(Default)]
struct Job {
    cancelled: Arc<AtomicBool>,
    label: Option<String>,
}
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}
fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}
fn label(host: &str) -> String {
    format!("online-site-{:x}", Sha256::digest(host.as_bytes()))
}

fn site_host(host: &str) -> &str {
    ["www.", "wap.", "m."]
        .iter()
        .find_map(|prefix| host.strip_prefix(prefix))
        .unwrap_or(host)
}

fn allowed_navigation(source: &str, value: &str) -> bool {
    let Ok(url) = crate::online::validate_url(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let site = site_host(source);
    host == site
        || host.ends_with(&format!(".{site}"))
        || [
            "challenges.cloudflare.com",
            "geetest.com",
            "hcaptcha.com",
            "recaptcha.net",
            "captcha.qq.com",
        ]
        .iter()
        .any(|provider| host == *provider || host.ends_with(&format!(".{provider}")))
        || (host == "www.google.com" && url.path().starts_with("/recaptcha/"))
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Verification {
    request_id: String,
    url: String,
    waiting: bool,
}
fn notify(app: &AppHandle, id: &str, url: &str, waiting: bool) {
    let _ = app.emit_to(
        "main",
        "online-site-verification",
        Verification {
            request_id: id.into(),
            url: url.into(),
            waiting,
        },
    );
}

// Host-only evaluation; remote pages never receive a reader IPC bridge or local data capabilities.
const SNAPSHOT: &str = r#"(() => {
 const text = document.body?.innerText || '', title = document.title;
 const blocked = /^(?:安全验证|人机验证|真人验证|访问验证|请稍候|請稍候|正在验证|安全检查|浏览器检查|Just a moment|Checking your browser|Verify you are human|Robot Check|Attention Required.*Cloudflare)/i.test(title.trim())
   || !!document.querySelector('#challenge-form,#challenge-running,#cf-challenge-running,script[src*="challenge-platform/"][src*="orchestrate/"]')
   || /请完成人机验证|请先完成安全验证|正在进行安全验证|Verifying you are human|Checking if the site connection is secure/i.test(text.slice(0, 3000));
 const error = /^(?:403 Forbidden|404 Not Found|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\s*$/i.test(title)
   ? title : document.querySelector('#main-frame-error #error-code,.neterror .error-code')?.textContent || '';
 const html = document.documentElement?.outerHTML || '';
 const pending = [...document.querySelectorAll('#BookText,#chaptercontent,.chaptercontent,.read-content,.reader-content')]
   .some(element => /^(?:正在为您转码|正在加载|加载中|Loading)[\s.…!！]*$/i.test((element.textContent || '').trim()));
 return { url: location.href, html: html.length <= 5242880 ? html : '', tooLarge: html.length > 5242880,
   blocked, pending, error, ready: document.readyState === 'complete', size: text.length,
   usable: text.trim().length >= 40 || document.querySelectorAll('a[href]').length >= 2 };
})()"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    url: String,
    html: String,
    blocked: bool,
    pending: bool,
    error: String,
    ready: bool,
    size: usize,
    usable: bool,
    too_large: bool,
}
#[derive(Serialize)]
pub struct BrowserPage {
    url: String,
    html: String,
}

#[tauri::command]
pub async fn fetch_online_browser(
    app: AppHandle,
    url: String,
    request_id: String,
    interactive: bool,
) -> Result<BrowserPage, String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "网页请求标识无效")?;
    let target = crate::online::validate_url(&url)?;
    let host = target.host_str().ok_or("链接缺少域名")?.to_lowercase();
    let session = sessions()
        .lock()
        .map_err(|_| "无法打开网页窗口")?
        .entry(host.clone())
        .or_default()
        .clone();
    let cancelled = jobs()
        .lock()
        .map_err(|_| "无法打开网页窗口")?
        .entry(request_id.clone())
        .or_default()
        .cancelled
        .clone();
    let result = async {
        let _busy = session.busy.lock().await;
        if cancelled.load(Ordering::SeqCst) {
            return Err("网页验证已取消".into());
        }
        let window_label = label(&host);
        jobs()
            .lock()
            .map_err(|_| "无法打开网页窗口")?
            .get_mut(&request_id)
            .ok_or("网页验证已取消")?
            .label = Some(window_label.clone());
        session.ready.store(false, Ordering::SeqCst);
        let window = if let Some(window) = app.get_webview_window(&window_label) {
            window.navigate(target).map_err(|e| e.to_string())?;
            window
        } else {
            let state = session.clone();
            let source_host = host.clone();
            let builder =
                WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::External(target));
            #[cfg(debug_assertions)]
            let builder = match std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
                Some(directory) => {
                    builder.data_directory(std::path::PathBuf::from(directory).join("webview"))
                }
                None => builder,
            };
            builder
                .title(format!("网站验证 · {host}"))
                .inner_size(1050.0, 740.0)
                .min_inner_size(760.0, 560.0)
                .center()
                .visible(false)
                .focused(false)
                .on_navigation(move |url| allowed_navigation(&source_host, url.as_str()))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_page_load(move |_, payload| {
                    state.ready.store(
                        matches!(payload.event(), tauri::webview::PageLoadEvent::Finished),
                        Ordering::SeqCst,
                    )
                })
                .build()
                .map_err(|e| e.to_string())?
        };
        let started = Instant::now();
        let mut shown: Option<Instant> = None;
        let mut stable: Option<(String, usize)> = None;
        loop {
            if cancelled.load(Ordering::SeqCst) || app.get_webview_window(&window_label).is_none() {
                return Err("网页验证已取消".into());
            }
            if interactive && shown.is_none() {
                window.show().map_err(|e| e.to_string())?;
                let _ = window.unminimize();
                let _ = window.set_focus();
                shown = Some(Instant::now());
                notify(&app, &request_id, &url, true);
            }
            if shown.map_or(started.elapsed() > Duration::from_secs(25), |at| {
                at.elapsed() > Duration::from_secs(180)
            }) {
                return Err(if shown.is_some() {
                    "网页验证超时，请继续下载或重新解析以重试"
                } else {
                    "网页加载超时，请稍后重试"
                }
                .into());
            }
            if !session.ready.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            window
                .eval_with_callback(SNAPSHOT, move |raw| {
                    let _ = sender.send(raw);
                })
                .map_err(|e| e.to_string())?;
            if let Ok(Some(raw)) =
                tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await
            {
                if let Ok(snapshot) = serde_json::from_str::<Snapshot>(&raw) {
                    if snapshot.url == "about:blank" {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        continue;
                    }
                    crate::online::validate_url(&snapshot.url)?;
                    if !allowed_navigation(&host, &snapshot.url) {
                        return Err("网页跳转到了其他网站，请使用该小说的直接链接".into());
                    }
                    if snapshot.too_large {
                        return Err("网页超过 5 MB，已停止读取".into());
                    }
                    if snapshot.blocked {
                        stable = None;
                        if shown.is_none() {
                            window.show().map_err(|e| e.to_string())?;
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                            shown = Some(Instant::now());
                            notify(&app, &request_id, &url, true);
                        }
                    } else if !snapshot.error.is_empty() {
                        return Err(format!("原网页无法访问（{}），请稍后重试", snapshot.error));
                    } else if snapshot.pending {
                        stable = None;
                    } else if snapshot.ready && snapshot.usable {
                        let signature = (snapshot.url.clone(), snapshot.size);
                        if stable.as_ref() == Some(&signature) {
                            if shown.is_some() {
                                if let Some(main) = app.get_window("main") {
                                    let _ = main.set_focus();
                                }
                            }
                            return Ok(BrowserPage {
                                url: snapshot.url,
                                html: snapshot.html,
                            });
                        }
                        stable = Some(signature);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }
    .await;
    notify(&app, &request_id, &url, false);
    if let Ok(mut jobs) = jobs().lock() {
        jobs.remove(&request_id);
    }
    if let Some(window) = app.get_webview_window(&label(&host)) {
        let _ = window.hide();
    }
    result
}

#[tauri::command]
pub fn cancel_online_browser(app: AppHandle, request_id: String) -> Result<(), String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "网页请求标识无效")?;
    let window_label = {
        let mut jobs = jobs().lock().map_err(|_| "无法取消网页验证")?;
        let job = jobs.entry(request_id).or_default();
        job.cancelled.store(true, Ordering::SeqCst);
        job.label.clone()
    };
    if let Some(window) = window_label.and_then(|label| app.get_webview_window(&label)) {
        let _ = window.destroy();
    }
    Ok(())
}

#[tauri::command]
pub fn show_online_browser(app: AppHandle, request_id: String) -> Result<(), String> {
    let window_label = jobs()
        .lock()
        .map_err(|_| "无法打开验证窗口")?
        .get(&request_id)
        .and_then(|job| job.label.clone())
        .ok_or("验证任务已结束")?;
    let window = app
        .get_webview_window(&window_label)
        .ok_or("验证窗口已关闭")?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_window_stays_on_the_source_site_or_known_challenge_providers() {
        for url in [
            "https://wap.kanshushi.com/shu/237504/",
            "https://www.kanshushi.com/book/1",
            "https://kanshushi.com/book/1",
            "https://challenges.cloudflare.com/turnstile/",
            "https://t.captcha.qq.com/widget",
        ] {
            assert!(allowed_navigation("wap.kanshushi.com", url), "{url}");
        }
        for url in [
            "https://xsxsapp.com/pfgg/download.html",
            "https://kanshushi.com.evil.example/ad",
            "http://127.0.0.1/",
            "file:///secret",
            "https://www.google.com/search?q=ad",
            "https://wap.kanshushi.com:8080/",
            "https://user:pass@wap.kanshushi.com/",
        ] {
            assert!(!allowed_navigation("wap.kanshushi.com", url), "{url}");
        }
    }
}
