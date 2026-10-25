use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{mpsc, Mutex};

const LABEL: &str = "online-search-browser";
static SEARCH: Mutex<String> = Mutex::const_new(String::new());
static READY: AtomicBool = AtomicBool::new(false);

fn search_url(value: &str) -> Result<reqwest::Url, String> {
    let url = crate::online::validate_url(value)?;
    let host = url.host_str().unwrap_or("");
    if ![
        "bing.com",
        "baidu.com",
        "google.com",
        "google.com.hk",
        "sogou.com",
        "so.com",
        "duckduckgo.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return Err("网页搜索窗口仅支持已配置的搜索引擎".into());
    }
    Ok(url)
}

// Read rendered search content through the host callback. Remote pages receive no
// application capabilities and never send their HTML through an injected IPC bridge.
const SNAPSHOT: &str = r#"(() => {
 const text = document.body?.innerText || '';
 const title = document.title;
 const error = /^(?:403 Forbidden|404 Not Found|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\s*$/i.test(title)
   ? title : document.querySelector('#main-frame-error #error-code,.neterror .error-code')?.textContent || '';
 const blocked = /安全验证|人机验证|Just a moment|Access denied|Robot Check/i.test(title)
   || !!document.querySelector('#challenge-form,form[action*="anomaly.js"],form[action*="/sorry"],.g-recaptcha')
   || /unusual traffic from your computer|我们的系统检测到|此验证码用于确认/i.test(text);
 const selector = location.hostname.endsWith('duckduckgo.com') ? '.result__a[href],[data-testid="result-title-a"][href]' : location.hostname.includes('google.') ? 'a[href]:has(h3)' : '.b_algo h2 a[href],.result h3 a[href],.c-container h3 a[href],.vrwrap h3 a[href],.rb h3 a[href],.vr-title a[href],.res-list h3 a[href],.res-title a[href]';
 const count = document.querySelectorAll(selector).length;
 return { url: location.href, html: document.documentElement.outerHTML, blocked, count, error, more: !!document.querySelector('button#more-results'),
   empty: /没有找到.*相关|未找到.*相关|找不到.*相关|did not match any documents|No results found/i.test(text),
   ready: document.readyState === 'complete' };
})()"#;

#[derive(Deserialize)]
struct Snapshot {
    url: String,
    html: String,
    blocked: bool,
    count: usize,
    empty: bool,
    ready: bool,
    more: bool,
    error: String,
}
#[derive(Serialize)]
pub struct BrowserPage {
    url: String,
    html: String,
}

#[tauri::command]
pub async fn fetch_search_browser(
    app: AppHandle,
    url: String,
    interactive: bool,
) -> Result<BrowserPage, String> {
    let mut target = search_url(&url)?;
    let offset = target
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("reader-offset="))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if offset > 10000
        || (offset > 0 && !target.host_str().unwrap_or("").ends_with("duckduckgo.com"))
    {
        return Err("搜索分页地址无效".into());
    }
    target.set_fragment(None);
    let mut previous = SEARCH.try_lock().map_err(|_| "正在加载网页搜索，请稍候")?;
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        let continue_more = offset > 0
            && window.url().ok().is_some_and(|current| {
                current.host_str().unwrap_or("").ends_with("duckduckgo.com")
                    && current
                        .query_pairs()
                        .find(|(key, _)| key == "q")
                        .map(|(_, value)| value.into_owned())
                        == target
                            .query_pairs()
                            .find(|(key, _)| key == "q")
                            .map(|(_, value)| value.into_owned())
            });
        // Keep the current challenge and its session when the user opens it.
        if !continue_more && (!interactive || *previous != url) {
            READY.store(false, Ordering::SeqCst);
            window.navigate(target).map_err(|e| e.to_string())?;
        }
        window
    } else {
        READY.store(false, Ordering::SeqCst);
        let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(target));
        #[cfg(debug_assertions)]
        let builder = match std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
            Some(directory) => {
                builder.data_directory(std::path::PathBuf::from(directory).join("webview"))
            }
            None => builder,
        };
        builder
            .title("网页搜索 · 小说书库")
            .inner_size(1050.0, 740.0)
            .min_inner_size(760.0, 560.0)
            .center()
            .visible(interactive)
            .focused(interactive)
            .on_navigation(|url| search_url(url.as_str()).is_ok())
            .on_page_load(|_, payload| {
                READY.store(
                    matches!(payload.event(), tauri::webview::PageLoadEvent::Finished),
                    Ordering::SeqCst,
                )
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|e| e.to_string())?
    };
    *previous = url;
    if interactive {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    } else {
        let _ = window.hide();
    }
    let started = Instant::now();
    let limit = Duration::from_secs(if interactive { 180 } else { 20 });
    let mut clicked_count: Option<usize> = None;
    let mut ready_count: Option<usize> = None;
    while started.elapsed() < limit {
        if app.get_webview_window(LABEL).is_none() {
            return Err("网页搜索已取消".into());
        }
        if !READY.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(300)).await;
            continue;
        }
        let (sender, mut receiver) = mpsc::unbounded_channel();
        window
            .eval_with_callback(SNAPSHOT, move |value| {
                let _ = sender.send(value);
            })
            .map_err(|e| e.to_string())?;
        if let Ok(Some(raw)) = tokio::time::timeout(Duration::from_secs(3), receiver.recv()).await {
            if let Ok(snapshot) = serde_json::from_str::<Snapshot>(&raw) {
                if snapshot.url == "about:blank" {
                    continue;
                }
                search_url(&snapshot.url)?;
                if !snapshot.error.is_empty() {
                    let _ = window.hide();
                    return Err(format!(
                        "搜索网页无法访问（{}），请稍后重试或切换引擎。",
                        snapshot.error
                    ));
                }
                if snapshot.html.len() > 5 * 1024 * 1024 {
                    return Err("搜索页面超过 5 MB，已停止读取".into());
                }
                if snapshot.blocked && !interactive {
                    return Err("该引擎需要网页确认，请打开搜索窗口后继续。".into());
                }
                if !snapshot.blocked && snapshot.ready && (snapshot.count > 0 || snapshot.empty) {
                    if snapshot.count <= offset && snapshot.more {
                        if clicked_count.is_none_or(|count| snapshot.count > count) {
                            window.eval("document.querySelector('button#more-results:not([disabled])')?.click()").map_err(|e| e.to_string())?;
                            clicked_count = Some(snapshot.count);
                        }
                        ready_count = None;
                        tokio::time::sleep(Duration::from_millis(600)).await;
                        continue;
                    }
                    if ready_count != Some(snapshot.count) {
                        ready_count = Some(snapshot.count);
                        tokio::time::sleep(Duration::from_millis(600)).await;
                        continue;
                    }
                    let _ = window.hide();
                    if interactive {
                        if let Some(main) = app.get_window("main") {
                            let _ = main.set_focus();
                        }
                    }
                    let mut result_url = search_url(&snapshot.url)?;
                    if offset > 0 {
                        result_url.set_fragment(Some(&format!("reader-offset={offset}")));
                    }
                    return Ok(BrowserPage {
                        url: result_url.into(),
                        html: snapshot.html,
                    });
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    Err("网页搜索尚未就绪，可打开搜索窗口查看并继续，或切换引擎。".into())
}

#[tauri::command]
pub fn cancel_search_browser(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_window_accepts_only_known_engine_domains() {
        for value in [
            "https://www.baidu.com/s?wd=山河",
            "https://wappass.baidu.com/static/captcha/",
            "https://www.google.com/search?q=novel",
            "https://www.google.com.hk/search?q=novel",
            "https://cn.bing.com/search?q=novel",
        ] {
            assert!(search_url(value).is_ok(), "{value}");
        }
        for value in [
            "https://baidu.com.evil.example/search",
            "https://yandex.com/search/?text=novel",
            "https://yandex.ru/search/?text=novel",
            "http://localhost/search",
            "file:///secret",
            "https://example.com",
            "https://user:pass@bing.com",
        ] {
            assert!(search_url(value).is_err(), "{value}");
        }
    }
}
