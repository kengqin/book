use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub async fn open_release_history_window(
    app: AppHandle,
    webview: tauri::Webview,
) -> Result<(), String> {
    if let Some(window) = app.get_window("release-history") {
        return crate::show_auxiliary_window(&window);
    }
    let origin = webview.url().map_err(|e| e.to_string())?;
    let builder = WebviewWindowBuilder::new(
        &app,
        "release-history",
        WebviewUrl::App("index.html#/settings/history".into()),
    )
    .title("更新历史 · 小说书库")
    .inner_size(640.0, 680.0)
    .min_inner_size(520.0, 400.0)
    .decorations(false)
    .visible(false)
    .center()
    .on_navigation(move |url| {
        url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port() == origin.port()
    });
    #[cfg(windows)]
    let builder = builder.owner_raw(webview.window().hwnd().map_err(|e| e.to_string())?);
    builder.build().map_err(|e| e.to_string())?;
    crate::show_auxiliary_window(
        &app.get_window("release-history")
            .ok_or("更新历史窗口尚未就绪")?,
    )
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle, section: Option<String>) -> Result<(), String> {
    let section = match section.as_deref() {
        Some("storage") => "storage",
        Some("updates") => "updates",
        _ => "general",
    };
    if let Some(window) = app.get_window("settings") {
        app.emit_to("settings", "settings-section", section)
            .map_err(|e| e.to_string())?;
        return crate::show_auxiliary_window(&window);
    }
    let origin = app
        .get_webview("main")
        .ok_or("主窗口尚未就绪")?
        .url()
        .map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App(format!("index.html#/settings/window?section={section}").into()),
    )
    .title("设置 · 小说书库")
    .inner_size(780.0, 600.0)
    .min_inner_size(680.0, 480.0)
    .decorations(false)
    .visible(false)
    .center()
    .on_navigation(move |url| {
        url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port() == origin.port()
    })
    .build()
    .map_err(|e| e.to_string())?;
    crate::show_auxiliary_window(&app.get_window("settings").ok_or("设置窗口尚未就绪")?)
}
