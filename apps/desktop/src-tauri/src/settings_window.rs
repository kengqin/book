use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn position_update_window(window: &tauri::Window, owner: &tauri::Window) -> Result<(), String> {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn SetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32, value: isize) -> isize;
            fn GetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32) -> isize;
        }
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let owner_hwnd = owner.hwnd().map_err(|error| error.to_string())?.0 as isize;
        // GWLP_HWNDPARENT updates the owner of this top-level window, not its client parent.
        unsafe {
            SetWindowLongPtrW(hwnd, -8, owner_hwnd);
            if GetWindowLongPtrW(hwnd, -8) != owner_hwnd {
                return Err("无法关联更新窗口".into());
            }
        }
    }
    let origin = owner.inner_position().map_err(|error| error.to_string())?;
    let parent_size = owner.inner_size().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(
            origin.x + (parent_size.width as i32 - size.width as i32) / 2,
            origin.y + (parent_size.height as i32 - size.height as i32) / 2,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_application_update_window(
    app: AppHandle,
    webview: tauri::Webview,
    check: Option<bool>,
) -> Result<(), String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let owner = webview.window();
    if let Some(window) = app.get_window("app-update") {
        // A background check must not take an already open update window away from Settings.
        if !check.unwrap_or(false) {
            return Ok(());
        }
        position_update_window(&window, &owner)?;
        if check.unwrap_or(false) {
            app.emit_to("app-update", "application-update-check", ())
                .map_err(|error| error.to_string())?;
        }
        return crate::show_auxiliary_window(&window);
    }
    let origin = webview.url().map_err(|error| error.to_string())?;
    let builder = WebviewWindowBuilder::new(
        &app,
        "app-update",
        WebviewUrl::App(
            format!(
                "index.html#/application-update?check={}",
                u8::from(check.unwrap_or(false))
            )
            .into(),
        ),
    )
    .title("软件更新")
    .inner_size(480.0, 180.0)
    .min_inner_size(440.0, 180.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .visible(false)
    .center()
    .on_navigation(move |url| {
        url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port() == origin.port()
    });
    #[cfg(windows)]
    let builder = builder.owner_raw(owner.hwnd().map_err(|error| error.to_string())?);
    builder.build().map_err(|error| error.to_string())?;
    let window = app.get_window("app-update").ok_or("更新窗口尚未就绪")?;
    position_update_window(&window, &owner)?;
    crate::show_auxiliary_window(&window)
}

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
