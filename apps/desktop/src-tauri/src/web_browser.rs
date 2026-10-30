use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

const SHELL: &str = "web-browser";
const PAGE: &str = "web-browser-content";
const MENU: &str = "web-browser-menu";

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserMode {
    #[default]
    Window,
    Side,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    open: bool,
    mode: BrowserMode,
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    menu_open: bool,
    side_suspended: bool,
    page_visible: bool,
    zoom_factor: Option<f64>,
    tabs: Vec<BrowserTab>,
    active_tab: Option<u64>,
    #[serde(skip)]
    bounds: Option<BrowserBounds>,
    #[serde(skip)]
    menu_bounds: Option<BrowserBounds>,
    #[serde(skip)]
    menu_ready: bool,
    #[serde(skip)]
    viewport_visible: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    id: u64,
    url: String,
    title: String,
    favicon: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    zoom_factor: f64,
}
fn page_label(id: u64) -> String {
    format!("{PAGE}-{id}")
}
fn active_page(app: &AppHandle) -> Option<Webview> {
    snapshot()
        .active_tab
        .and_then(|id| app.get_webview(&page_label(id)))
}
fn same_document_navigation(previous: &str, target: &reqwest::Url) -> bool {
    let Ok(mut previous) = reqwest::Url::parse(previous) else {
        return false;
    };
    if previous.fragment() == target.fragment() {
        return false;
    }
    let mut target = target.clone();
    previous.set_fragment(None);
    target.set_fragment(None);
    previous == target
}
fn project_active(value: &mut BrowserState) {
    if let Some(tab) = value.tabs.iter().find(|t| Some(t.id) == value.active_tab) {
        value.url = tab.url.clone();
        value.title = tab.title.clone();
        value.loading = tab.loading;
        value.can_go_back = tab.can_go_back;
        value.can_go_forward = tab.can_go_forward;
        value.zoom_factor = Some(tab.zoom_factor);
    } else {
        value.url.clear();
        value.title.clear();
        value.loading = false;
        value.can_go_back = false;
        value.can_go_forward = false;
        value.page_visible = false;
    }
}
fn update_tab(app: &AppHandle, id: u64, change: impl FnOnce(&mut BrowserTab)) {
    update(app, |s| {
        if let Some(tab) = s.tabs.iter_mut().find(|t| t.id == id) {
            change(tab);
        }
    });
}

fn state() -> &'static Mutex<BrowserState> {
    static STATE: OnceLock<Mutex<BrowserState>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn mutations() -> &'static tokio::sync::Mutex<()> {
    static MUTATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    MUTATIONS.get_or_init(Default::default)
}
fn snapshot() -> BrowserState {
    state().lock().unwrap_or_else(|e| e.into_inner()).clone()
}
fn update(app: &AppHandle, change: impl FnOnce(&mut BrowserState)) {
    let value = {
        let mut value = state().lock().unwrap_or_else(|e| e.into_inner());
        change(&mut value);
        project_active(&mut value);
        value.clone()
    };
    let _ = app.emit_to("main", "web-browser-state", &value);
    let _ = app.emit_to(SHELL, "web-browser-state", &value);
    let _ = app.emit_to(MENU, "web-browser-state", &value);
}
fn host(mode: BrowserMode) -> &'static str {
    if mode == BrowserMode::Window {
        SHELL
    } else {
        "main"
    }
}

fn ensure_shell(app: &AppHandle, mode: BrowserMode) -> Result<(), String> {
    if mode == BrowserMode::Side {
        return Ok(());
    }
    let window = if let Some(window) = app.get_window(SHELL) {
        window
    } else {
        WebviewWindowBuilder::new(app, SHELL, WebviewUrl::App("index.html#/browser".into()))
            .title("网页浏览 · library-manage")
            .inner_size(1120.0, 780.0)
            .min_inner_size(620.0, 440.0)
            .decorations(false)
            .visible(false)
            .center()
            .build()
            .map_err(|e| e.to_string())?;
        app.get_window(SHELL).ok_or("网页窗口尚未就绪")?
    };
    crate::show_auxiliary_window(&window)
}

// This page has no local application capabilities. Only the local toolbar can invoke commands.
fn create_page(
    app: &AppHandle,
    mode: BrowserMode,
    bounds: Rect,
    tab: &BrowserTab,
) -> Result<Webview, String> {
    let target = crate::online::validate_url(&tab.url)?;
    let id = tab.id;
    let navigation_app = app.clone();
    let title_app = app.clone();
    let load_app = app.clone();
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(page_label(id), WebviewUrl::External(target))
        .focused(false)
        .initialization_script(include_str!("web_browser_page.js"))
        .on_navigation(move |url| {
            if crate::online::validate_url(url.as_str()).is_err() {
                return false;
            }
            update_tab(&navigation_app, id, |t| {
                t.url = url.to_string();
                t.loading = true;
                t.favicon = None;
            });
            true
        })
        .on_document_title_changed(move |_, title| {
            update_tab(&title_app, id, |t| t.title = title);
        })
        .on_page_load(move |_, payload| {
            update_tab(&load_app, id, |t| {
                t.url = payload.url().to_string();
                t.loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            });
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let app = load_app.clone();
                tauri::async_runtime::spawn(async move {
                    refresh_metadata(&app, id).await;
                });
            }
        })
        .on_new_window(move |url, _| {
            if crate::online::validate_url(url.as_str()).is_ok()
                && snapshot().active_tab == Some(id)
            {
                let app = popup_app.clone();
                tauri::async_runtime::spawn(async move {
                    let mode = snapshot().mode;
                    let _ = open_web_browser(app, url.to_string(), mode, Some(true)).await;
                });
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_download(|_, _| false);
    #[cfg(debug_assertions)]
    let builder = match std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
        Some(directory) => {
            builder.data_directory(std::path::PathBuf::from(directory).join("webview"))
        }
        None => builder,
    };
    let page = app
        .get_window(host(mode))
        .ok_or("网页窗口尚未就绪")?
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let focus_app = app.clone();
        page.with_webview(move |webview| unsafe {
            let handler = webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| {
                let current = snapshot();
                if current.active_tab == Some(id) {
                    #[link(name = "user32")]
                    extern "system" {
                        fn GetAsyncKeyState(key: i32) -> i16;
                        fn GetForegroundWindow() -> *mut std::ffi::c_void;
                    }
                    // Page scripts and controller creation can focus the page without a user click.
                    let owner_is_foreground = focus_app
                        .get_window(host(current.mode))
                        .and_then(|window| window.hwnd().ok())
                        .is_some_and(|hwnd| hwnd.0 == GetForegroundWindow());
                    if current.menu_open && owner_is_foreground && GetAsyncKeyState(1) < 0 {
                        hide_menu(&focus_app);
                    }
                    let _ = focus_app.emit_to(host(current.mode), "web-browser-page-focused", ());
                }
                Ok(())
            }));
            let mut token = 0;
            let _ = webview.controller().add_GotFocus(&handler, &mut token);
        })
        .map_err(|e| e.to_string())?;
    }
    page.set_zoom(tab.zoom_factor).map_err(|e| e.to_string())?;
    Ok(page)
}

async fn refresh_metadata(app: &AppHandle, id: u64) {
    let Some(page) = app.get_webview(&page_label(id)) else {
        return;
    };
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let script = "(()=>{const icons=[...document.querySelectorAll('link[rel]')].filter(x=>/^(?:shortcut )?icon$/i.test(x.rel));let icon=icons.at(-1)?.href;return {url:location.href,title:document.title,icon:icon||new URL('/favicon.ico',location.href).href}})()";
    if page
        .eval_with_callback(script, move |raw| {
            let _ = sender.send(raw);
        })
        .is_err()
    {
        return;
    }
    if let Ok(Some(raw)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv()).await
    {
        #[derive(Deserialize)]
        struct Metadata {
            url: String,
            title: String,
            icon: String,
        }
        if let Ok(metadata) = serde_json::from_str::<Metadata>(&raw) {
            let icon = if metadata.icon.len() < 200_000 && metadata.icon.starts_with("data:image/")
            {
                Some(metadata.icon)
            } else {
                read_favicon(&page).await
            };
            update_tab(app, id, |tab| {
                if tab.url == metadata.url {
                    tab.title = metadata.title;
                    tab.favicon = icon;
                }
            });
        }
    }
}

#[cfg(windows)]
async fn read_favicon(page: &Webview) -> Option<String> {
    use base64::Engine;
    use webview2_com::{
        GetFaviconCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_15, COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
        },
    };
    use windows_core::Interface;
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    page.with_webview(move |view| unsafe {
        let Ok(core) = view
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_15>())
        else {
            return;
        };
        let handler = GetFaviconCompletedHandler::create(Box::new(move |status, stream| {
            let mut bytes = Vec::new();
            if status.is_ok() {
                if let Some(stream) = stream {
                    loop {
                        let mut block = [0u8; 4096];
                        let mut read = 0;
                        let result = stream.Read(
                            block.as_mut_ptr().cast(),
                            block.len() as u32,
                            Some(&mut read),
                        );
                        if result.is_err() || read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&block[..read as usize]);
                        if bytes.len() > 262144 {
                            bytes.clear();
                            break;
                        }
                    }
                }
            }
            let icon = bytes.starts_with(b"\x89PNG\r\n\x1a\n").then(|| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            });
            let _ = sender.send(icon);
            Ok(())
        }));
        let _ = core.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &handler);
    })
    .ok()?;
    tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
        .await
        .ok()
        .flatten()
        .flatten()
}
#[cfg(not(windows))]
async fn read_favicon(_: &Webview) -> Option<String> {
    None
}

fn reparent_pages(app: &AppHandle, mode: BrowserMode) -> Result<(), String> {
    let parent = app.get_window(host(mode)).ok_or("网页窗口尚未就绪")?;
    for tab in snapshot().tabs {
        if let Some(page) = app.get_webview(&page_label(tab.id)) {
            page.hide().map_err(|e| e.to_string())?;
            if page.window().label() != parent.label() {
                page.reparent(&parent).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
fn display_active(app: &AppHandle) -> Result<(), String> {
    let current = snapshot();
    for tab in &current.tabs {
        if Some(tab.id) != current.active_tab {
            if let Some(page) = app.get_webview(&page_label(tab.id)) {
                let _ = page.hide();
            }
        }
    }
    let visible = current.open
        && current.viewport_visible
        && !(current.mode == BrowserMode::Side && current.side_suspended);
    if let Some(tab) = current
        .tabs
        .iter()
        .find(|t| Some(t.id) == current.active_tab)
    {
        if let Some(bounds) = &current.bounds {
            let page = match app.get_webview(&page_label(tab.id)) {
                Some(page) => Some(page),
                None if visible => Some(create_page(app, current.mode, bounds.rect(), tab)?),
                None => None,
            };
            if let Some(page) = page {
                page.set_bounds(bounds.rect()).map_err(|e| e.to_string())?;
                if visible { page.show() } else { page.hide() }.map_err(|e| e.to_string())?;
            }
        }
    }
    if current.page_visible != visible {
        update(app, |s| s.page_visible = visible);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_web_browser(
    app: AppHandle,
    url: String,
    mode: BrowserMode,
    new_tab: Option<bool>,
) -> Result<(), String> {
    let target = crate::online::validate_url(&url)?;
    let _guard = mutations().lock().await;
    ensure_shell(&app, mode)?;
    hide_menu(&app);
    let previous = snapshot();
    if previous.mode != mode {
        reparent_pages(&app, mode)?;
    }
    static NEXT_TAB: AtomicU64 = AtomicU64::new(1);
    let existing = if new_tab == Some(false) {
        previous.active_tab
    } else {
        None
    };
    let same_document = existing
        .and_then(|id| previous.tabs.iter().find(|tab| tab.id == id))
        .is_some_and(|tab| same_document_navigation(&tab.url, &target));
    let id = existing.unwrap_or_else(|| NEXT_TAB.fetch_add(1, Ordering::Relaxed));
    update(&app, |s| {
        s.open = true;
        s.mode = mode;
        if previous.mode != mode {
            s.bounds = None;
            s.viewport_visible = false;
        }
        if let Some(tab) = s.tabs.iter_mut().find(|t| t.id == id) {
            tab.url = target.to_string();
            if !same_document {
                tab.title.clear();
                tab.favicon = None;
            }
            tab.loading = !same_document;
        } else {
            s.tabs.push(BrowserTab {
                id,
                url: target.to_string(),
                title: String::new(),
                favicon: None,
                loading: true,
                can_go_back: false,
                can_go_forward: false,
                zoom_factor: 1.0,
            });
        }
        s.active_tab = Some(id);
    });
    if let Some(page) = existing.and_then(|id| app.get_webview(&page_label(id))) {
        page.navigate(target).map_err(|e| e.to_string())?;
    }
    display_active(&app)?;
    if mode == BrowserMode::Side {
        if let Some(shell) = app.get_window(SHELL) {
            let _ = shell.hide();
        }
        if let Some(main) = app.get_window("main") {
            let _ = crate::show_auxiliary_window(&main);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_web_browser_mode(app: AppHandle, mode: BrowserMode) -> Result<(), String> {
    let _guard = mutations().lock().await;
    hide_menu(&app);
    ensure_shell(&app, mode)?;
    if snapshot().mode == mode {
        return display_active(&app);
    }
    reparent_pages(&app, mode)?;
    update(&app, |s| {
        s.mode = mode;
        s.bounds = None;
        s.viewport_visible = false;
        s.page_visible = false;
    });
    if mode == BrowserMode::Side {
        if let Some(shell) = app.get_window(SHELL) {
            let _ = shell.hide();
        }
        if let Some(main) = app.get_window("main") {
            let _ = crate::show_auxiliary_window(&main);
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl BrowserBounds {
    fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.x >= 0.0
            && self.y >= 0.0
            && self.width >= 1.0
            && self.height >= 1.0
            && self.x + self.width <= 20000.0
            && self.y + self.height <= 20000.0
    }
    fn rect(&self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        }
    }
}

#[tauri::command]
pub async fn set_web_browser_bounds(
    app: AppHandle,
    webview: Webview,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<(), String> {
    if !bounds.valid() {
        return Err("网页显示区域无效".into());
    }
    let _guard = mutations().lock().await;
    let current = snapshot();
    if !current.open || webview.label() != host(current.mode) {
        return Ok(());
    }
    {
        let mut value = state().lock().map_err(|e| e.to_string())?;
        value.bounds = Some(bounds);
        value.viewport_visible = visible;
    }
    display_active(&app)
}

#[tauri::command]
pub async fn set_web_browser_suspended(app: AppHandle, suspended: bool) -> Result<(), String> {
    let _guard = mutations().lock().await;
    update(&app, |s| s.side_suspended = suspended);
    if suspended && snapshot().mode == BrowserMode::Side {
        for tab in snapshot().tabs {
            if let Some(page) = app.get_webview(&page_label(tab.id)) {
                page.hide().map_err(|e| e.to_string())?;
            }
        }
        update(&app, |s| s.page_visible = false);
        hide_menu(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_web_browser_state(app: AppHandle) -> Result<BrowserState, String> {
    #[cfg(windows)]
    if let Some((id, page)) = snapshot()
        .active_tab
        .and_then(|id| app.get_webview(&page_label(id)).map(|page| (id, page)))
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        page.with_webview(move |webview| {
            let result = unsafe {
                webview.controller().CoreWebView2().map(|core| {
                    let mut back = windows_core::BOOL::default();
                    let mut forward = windows_core::BOOL::default();
                    let mut visible = windows_core::BOOL::default();
                    let mut zoom = 1.0;
                    let _ = core.CanGoBack(&mut back);
                    let _ = core.CanGoForward(&mut forward);
                    let _ = webview.controller().IsVisible(&mut visible);
                    let _ = webview.controller().ZoomFactor(&mut zoom);
                    (back.as_bool(), forward.as_bool(), visible.as_bool(), zoom)
                })
            };
            let _ = sender.send(result.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
        if let Ok(Ok(Ok((back, forward, visible, zoom)))) =
            tokio::time::timeout(std::time::Duration::from_secs(2), receiver).await
        {
            update(&app, |value| {
                if let Some(tab) = value.tabs.iter_mut().find(|t| t.id == id) {
                    tab.can_go_back = back;
                    tab.can_go_forward = forward;
                    tab.zoom_factor = zoom;
                }
                if value.active_tab == Some(id) {
                    value.page_visible = visible;
                }
            });
            refresh_metadata(&app, id).await;
        }
    }
    let _ = app;
    Ok(snapshot())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
    Stop,
    External,
}

#[tauri::command]
pub fn set_web_browser_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    if !factor.is_finite() || !(0.5..=2.0).contains(&factor) {
        return Err("网页缩放范围为 50% 到 200%".into());
    }
    let id = snapshot().active_tab.ok_or("请先打开网页")?;
    let page = app.get_webview(&page_label(id)).ok_or("请先打开网页")?;
    page.set_zoom(factor).map_err(|e| e.to_string())?;
    update_tab(&app, id, |t| t.zoom_factor = factor);
    Ok(())
}

#[tauri::command]
pub async fn web_browser_action(app: AppHandle, action: BrowserAction) -> Result<(), String> {
    let current = snapshot();
    if !current.open {
        return Err("请先打开网页".into());
    }
    if matches!(action, BrowserAction::External) {
        let target = crate::online::validate_url(&current.url)?;
        return app
            .opener()
            .open_url(target.as_str(), None::<&str>)
            .map_err(|e| e.to_string());
    }
    let page = active_page(&app).ok_or("网页尚未就绪")?;
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        page.with_webview(move |webview| {
            let result = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| match action {
                        BrowserAction::Back => core.GoBack(),
                        BrowserAction::Forward => core.GoForward(),
                        BrowserAction::Reload => core.Reload(),
                        BrowserAction::Stop => core.Stop(),
                        BrowserAction::External => unreachable!(),
                    })
            };
            let _ = sender.send(result.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
            .await
            .map_err(|_| "网页操作超时")?
            .map_err(|_| "网页已关闭")??;
    }
    #[cfg(not(windows))]
    page.eval(match action {
        BrowserAction::Back => "history.back()",
        BrowserAction::Forward => "history.forward()",
        BrowserAction::Reload => "location.reload()",
        BrowserAction::Stop => "window.stop()",
        BrowserAction::External => unreachable!(),
    })
    .map_err(|e| e.to_string())?;
    if matches!(action, BrowserAction::Stop) {
        if let Some(id) = current.active_tab {
            update_tab(&app, id, |t| t.loading = false);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn close_web_browser(app: AppHandle) -> Result<(), String> {
    let _guard = mutations().lock().await;
    hide_menu(&app);
    close_all(&app);
    Ok(())
}

fn close_all(app: &AppHandle) {
    for tab in snapshot().tabs {
        if let Some(page) = app.get_webview(&page_label(tab.id)) {
            let _ = page.close();
        }
    }
    if let Some(shell) = app.get_window(SHELL) {
        let _ = shell.hide();
    }
    update(app, |s| {
        s.open = false;
        s.tabs.clear();
        s.active_tab = None;
        s.page_visible = false;
    });
}

#[tauri::command]
pub async fn switch_web_browser_tab(app: AppHandle, tab_id: u64) -> Result<(), String> {
    let _guard = mutations().lock().await;
    if !snapshot().tabs.iter().any(|t| t.id == tab_id) {
        return Err("网页标签已关闭".into());
    }
    hide_menu(&app);
    update(&app, |s| s.active_tab = Some(tab_id));
    display_active(&app)?;
    if let Some(page) = active_page(&app) {
        page.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_web_browser_tab(app: AppHandle, tab_id: u64) -> Result<(), String> {
    let _guard = mutations().lock().await;
    let current = snapshot();
    let Some(index) = current.tabs.iter().position(|t| t.id == tab_id) else {
        return Ok(());
    };
    hide_menu(&app);
    if current.tabs.len() == 1 {
        close_all(&app);
        return Ok(());
    }
    if let Some(page) = app.get_webview(&page_label(tab_id)) {
        let _ = page.close();
    }
    update(&app, |s| {
        s.tabs.retain(|t| t.id != tab_id);
        if s.active_tab == Some(tab_id) {
            s.active_tab = Some(s.tabs[index.min(s.tabs.len() - 1)].id);
        }
    });
    display_active(&app)
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if snapshot().menu_open
        && window
            .app_handle()
            .get_webview(MENU)
            .is_some_and(|menu| menu.window().label() == window.label())
        && matches!(
            event,
            tauri::WindowEvent::Focused(false)
                | tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::CloseRequested { .. }
        )
    {
        hide_menu(window.app_handle());
    }
    if window.label() != SHELL {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = close_web_browser(app).await;
        });
    }
}

#[cfg_attr(debug_assertions, track_caller)]
fn hide_menu(app: &AppHandle) {
    #[cfg(debug_assertions)]
    if snapshot().menu_open {
        if let Some(directory) = std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
            let _ = std::fs::write(
                std::path::PathBuf::from(directory).join("last-browser-menu-close.txt"),
                std::panic::Location::caller().to_string(),
            );
        }
    }
    if let Some(menu) = app.get_webview(MENU) {
        let _ = menu.hide();
    }
    update(app, |s| s.menu_open = false);
}

#[tauri::command]
pub fn close_web_browser_menu(app: AppHandle) {
    hide_menu(&app);
}

async fn display_menu(app: &AppHandle) -> Result<(), String> {
    let current = snapshot();
    if !current.menu_open || !current.menu_ready {
        return Ok(());
    }
    let menu = app.get_webview(MENU).ok_or("网页菜单尚未就绪")?;
    let bounds = current.menu_bounds.ok_or("网页菜单位置无效")?;
    menu.set_bounds(bounds.rect())
        .map_err(|error| error.to_string())?;
    menu.show().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        menu.with_webview(move |view| unsafe {
            #[link(name = "user32")]
            extern "system" {
                fn SetWindowPos(
                    hwnd: *mut std::ffi::c_void,
                    after: *mut std::ffi::c_void,
                    x: i32,
                    y: i32,
                    width: i32,
                    height: i32,
                    flags: u32,
                ) -> i32;
            }
            let mut hwnd = Default::default();
            let result = view
                .controller()
                .ParentWindow(&mut hwnd)
                .map_err(|error| error.to_string())
                .and_then(|_| {
                    // Raise only this child above the page, without activating or restyling the owner window.
                    if SetWindowPos(hwnd.0, std::ptr::null_mut(), 0, 0, 0, 0, 0x0213) == 0 {
                        Err("无法显示网页菜单".to_string())
                    } else {
                        Ok(())
                    }
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
            .await
            .map_err(|_| "网页菜单显示超时")?
            .map_err(|_| "网页菜单已关闭")??;
    }
    Ok(())
}

#[tauri::command]
pub async fn web_browser_menu_ready(app: AppHandle, webview: Webview) -> Result<(), String> {
    if webview.label() != MENU {
        return Err("网页菜单来源无效".into());
    }
    let _guard = mutations().lock().await;
    update(&app, |state| state.menu_ready = true);
    display_menu(&app).await
}

fn menu_bounds(viewport: &BrowserBounds, x: f64, y: f64) -> BrowserBounds {
    let width = viewport.width.min(368.0);
    let height = viewport.height.min(224.0);
    BrowserBounds {
        x: x.clamp(
            viewport.x,
            (viewport.x + viewport.width - width).max(viewport.x),
        ),
        y: y.clamp(
            viewport.y,
            (viewport.y + viewport.height - height).max(viewport.y),
        ),
        width,
        height,
    }
}

#[tauri::command]
pub async fn show_web_browser_menu(
    app: AppHandle,
    webview: Webview,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("菜单位置无效".into());
    }
    let _guard = mutations().lock().await;
    let current = snapshot();
    if current.menu_open {
        hide_menu(&app);
        return Ok(());
    }
    let parent = webview.window();
    if parent.label() != host(current.mode) {
        return Err("网页窗口无效".into());
    }
    let bounds = menu_bounds(current.bounds.as_ref().ok_or("网页尚未就绪")?, x, y);
    update(&app, |state| {
        state.menu_open = true;
        state.menu_bounds = Some(bounds.clone());
    });
    if let Some(menu) = app.get_webview(MENU) {
        if menu.window().label() != parent.label() {
            menu.reparent(&parent).map_err(|error| error.to_string())?;
        }
    } else {
        update(&app, |state| state.menu_ready = false);
        let origin = webview.url().map_err(|error| error.to_string())?;
        let builder = WebviewBuilder::new(MENU, WebviewUrl::App("index.html#/browser/menu".into()))
            .transparent(true)
            .focused(false)
            .on_navigation(move |url| {
                url.scheme() == origin.scheme()
                    && url.host_str() == origin.host_str()
                    && url.port() == origin.port()
            });
        if let Err(error) = parent.add_child(
            builder,
            LogicalPosition::new(-10000.0, -10000.0),
            bounds.rect().size,
        ) {
            hide_menu(&app);
            return Err(error.to_string());
        }
    }
    display_menu(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menus_stay_inside_the_browser_viewport_even_in_a_narrow_pane() {
        for (width, left) in [
            (310.5, 602.5),
            (310.2, 602.1),
            (440.0, 602.5),
            (900.0, 602.5),
        ] {
            let viewport = BrowserBounds {
                x: left,
                y: 82.0,
                width,
                height: 600.0,
            };
            for (x, y) in [(-1000.0, -1000.0), (5000.0, 5000.0), (720.0, 83.0)] {
                let menu = menu_bounds(&viewport, x, y);
                assert!(menu.x >= viewport.x && menu.y >= viewport.y);
                assert!(menu.x + menu.width <= viewport.x + viewport.width);
                assert!(menu.y + menu.height <= viewport.y + viewport.height);
                assert!(menu.valid());
            }
        }
    }
    #[test]
    fn fragment_navigation_does_not_wait_for_a_new_document_load() {
        let original = "https://example.com/book?q=1#first";
        for (next, expected) in [
            ("https://example.com/book?q=1#second", true),
            ("https://example.com/book?q=1", true),
            (original, false),
            ("https://example.com/book?q=2#second", false),
            ("https://example.com/other#second", false),
        ] {
            assert_eq!(
                same_document_navigation(original, &reqwest::Url::parse(next).unwrap()),
                expected
            );
        }
    }
    #[test]
    fn default_is_a_separate_window() {
        assert!(BrowserMode::default() == BrowserMode::Window);
    }
    #[test]
    fn remote_child_never_inherits_a_parent_windows_capabilities() {
        for source in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/web-browser.json"),
        ] {
            let value: serde_json::Value = serde_json::from_str(source).unwrap();
            assert!(value.get("windows").is_none());
            assert!(!value["webviews"]
                .as_array()
                .unwrap()
                .iter()
                .any(|label| label == PAGE));
        }
    }
    #[test]
    fn bounds_must_be_finite_and_visible() {
        assert!(BrowserBounds {
            x: 10.0,
            y: 50.0,
            width: 600.0,
            height: 400.0
        }
        .valid());
        for width in [0.0, -1.0, f64::NAN, f64::INFINITY, 30000.0] {
            assert!(!BrowserBounds {
                x: 0.0,
                y: 0.0,
                width,
                height: 400.0
            }
            .valid());
        }
    }
}
