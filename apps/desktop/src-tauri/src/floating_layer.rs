use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Webview, WebviewUrl,
    WebviewWindowBuilder,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum LayerKind {
    Message,
    Tooltip,
    Progress,
}
impl LayerKind {
    fn label(self) -> &'static str {
        match self {
            Self::Message => "app-message",
            Self::Tooltip => "app-tooltip",
            Self::Progress => "app-progress",
        }
    }
    fn from_label(label: &str) -> Option<Self> {
        match label {
            "app-message" => Some(Self::Message),
            "app-tooltip" => Some(Self::Tooltip),
            "app-progress" => Some(Self::Progress),
            _ => None,
        }
    }
    fn width(self) -> f64 {
        match self {
            Self::Message => 640.0,
            Self::Tooltip => 360.0,
            Self::Progress => 480.0,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    right: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerInput {
    id: u64,
    text: String,
    tone: Option<String>,
    variant: Option<String>,
    subtitle: Option<String>,
    action: Option<String>,
    anchor: Option<Anchor>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerState {
    kind: LayerKind,
    owner: String,
    input: LayerInput,
}
fn layers() -> &'static Mutex<HashMap<LayerKind, LayerState>> {
    static LAYERS: OnceLock<Mutex<HashMap<LayerKind, LayerState>>> = OnceLock::new();
    LAYERS.get_or_init(Default::default)
}
fn mutations() -> &'static tokio::sync::Mutex<()> {
    static MUTATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    MUTATIONS.get_or_init(Default::default)
}
pub fn is_layer(label: &str) -> bool {
    LayerKind::from_label(label).is_some()
}

#[tauri::command]
pub async fn show_floating_layer(
    app: AppHandle,
    webview: Webview,
    kind: LayerKind,
    input: LayerInput,
) -> Result<(), String> {
    if !matches!(
        webview.label(),
        "main" | "settings" | "release-history" | "web-browser" | "web-browser-menu"
    ) {
        return Err("浮层来源无效".into());
    }
    if input.text.trim().is_empty() || input.text.chars().count() > 4000 {
        return Err("浮层内容无效".into());
    }
    if let Some(a) = &input.anchor {
        if ![a.x, a.y, a.width, a.height].iter().all(|v| v.is_finite()) {
            return Err("浮层位置无效".into());
        }
    }
    let _guard = mutations().lock().await;
    let value = LayerState {
        kind,
        owner: webview.window().label().to_string(),
        input,
    };
    let updating_progress = kind == LayerKind::Progress
        && layers()
            .lock()
            .map_err(|e| e.to_string())?
            .get(&kind)
            .is_some_and(|previous| previous.input.id == value.input.id);
    layers()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(kind, value.clone());
    if let Some(window) = app.get_window(kind.label()) {
        if !updating_progress {
            let _ = window.hide();
            window
                .set_size(LogicalSize::new(kind.width(), 260.0))
                .map_err(|e| e.to_string())?;
        }
    } else {
        let builder = WebviewWindowBuilder::new(
            &app,
            kind.label(),
            WebviewUrl::App(
                format!(
                    "index.html#/overlay/{}",
                    if kind == LayerKind::Message {
                        "message"
                    } else if kind == LayerKind::Progress {
                        "progress"
                    } else {
                        "tooltip"
                    }
                )
                .into(),
            ),
        )
        .title("小说书库提示")
        .inner_size(kind.width(), 260.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .focusable(kind == LayerKind::Progress)
        .focused(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false);
        #[cfg(windows)]
        let builder = if kind == LayerKind::Progress {
            builder.owner_raw(webview.window().hwnd().map_err(|e| e.to_string())?)
        } else {
            builder
        };
        builder.build().map_err(|e| e.to_string())?;
    }
    if kind == LayerKind::Tooltip {
        if let Some(window) = app.get_window(kind.label()) {
            let _ = window.set_ignore_cursor_events(true);
        }
    }
    app.emit_to(kind.label(), "floating-layer-state", Some(&value))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_floating_layer(webview: Webview) -> Option<LayerState> {
    let kind = LayerKind::from_label(webview.label())?;
    layers().lock().ok()?.get(&kind).cloned()
}

#[tauri::command]
pub async fn resize_floating_layer(
    app: AppHandle,
    webview: Webview,
    id: u64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let kind = LayerKind::from_label(webview.label()).ok_or("浮层窗口无效")?;
    if !width.is_finite() || !height.is_finite() || width < 24.0 || height < 24.0 {
        return Err("浮层大小无效".into());
    }
    let _guard = mutations().lock().await;
    let value = layers()
        .lock()
        .map_err(|e| e.to_string())?
        .get(&kind)
        .cloned();
    let Some(value) = value.filter(|v| v.input.id == id) else {
        return Ok(());
    };
    let Some(owner) = app.get_window(&value.owner) else {
        return Ok(());
    };
    let window = app.get_window(kind.label()).ok_or("浮层窗口尚未就绪")?;
    if !owner.is_visible().unwrap_or(false) || owner.is_minimized().unwrap_or(false) {
        let _ = window.hide();
        return Ok(());
    }
    let width = width.min(kind.width());
    let height = height.min(300.0);
    let scale = owner.scale_factor().map_err(|e| e.to_string())?;
    let origin = owner.inner_position().map_err(|e| e.to_string())?;
    let owner_size = owner.inner_size().map_err(|e| e.to_string())?;
    let w = (width * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let (mut x, mut y) = if kind == LayerKind::Message {
        (
            origin.x + (owner_size.width as i32 - w) / 2,
            origin.y + (40.0 * scale) as i32,
        )
    } else if kind == LayerKind::Progress {
        (
            origin.x + (owner_size.width as i32 - w) / 2,
            origin.y + (owner_size.height as i32 - h) / 2,
        )
    } else if let Some(a) = &value.input.anchor {
        (
            origin.x
                + ((if a.right {
                    a.x + a.width - 8.0
                } else {
                    a.x + a.width / 2.0 - width / 2.0
                }) * scale)
                    .round() as i32,
            origin.y
                + ((if a.right {
                    a.y + a.height / 2.0 - height / 2.0
                } else {
                    a.y + a.height - 7.0
                }) * scale)
                    .round() as i32,
        )
    } else {
        return Err("悬浮提示缺少位置".into());
    };
    if let Some(monitor) = owner
        .current_monitor()
        .ok()
        .flatten()
        .filter(|_| !crate::background_ui_test())
    {
        let p = monitor.position();
        let s = monitor.size();
        x = x.clamp(p.x, (p.x + s.width as i32 - w).max(p.x));
        y = y.clamp(p.y, (p.y + s.height as i32 - h).max(p.y));
    }
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let focus = kind == LayerKind::Progress && !window.is_visible().unwrap_or(false);
    window.show().map_err(|e| e.to_string())?;
    if focus && !crate::background_ui_test() {
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_floating_layer(app: AppHandle, webview: Webview, kind: LayerKind, id: u64) {
    let _guard = mutations().lock().await;
    let mut values = match layers().lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(value) = values.get(&kind) else {
        return;
    };
    if value.input.id != id
        || (webview.label() != kind.label() && webview.window().label() != value.owner)
    {
        return;
    }
    let owner = value.owner.clone();
    values.remove(&kind);
    drop(values);
    if let Some(window) = app.get_window(kind.label()) {
        let _ = window.hide();
    }
    let _ = app.emit_to(
        kind.label(),
        "floating-layer-state",
        Option::<LayerState>::None,
    );
    if kind == LayerKind::Message && webview.label() == kind.label() {
        let _ = app.emit_to(&owner, "floating-message-dismissed", id);
    }
    if kind == LayerKind::Progress && webview.label() == kind.label() {
        let _ = app.emit_to(&owner, "floating-progress-cancelled", id);
    }
}

pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let destroyed = matches!(event, tauri::WindowEvent::Destroyed);
    let reposition = matches!(
        event,
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
    );
    if destroyed || reposition || matches!(event, tauri::WindowEvent::Focused(_)) {
        let app = window.app_handle().clone();
        let owner = window.label().to_string();
        tauri::async_runtime::spawn(async move {
            let _guard = mutations().lock().await;
            let visible = !destroyed
                && app.get_window(&owner).is_some_and(|window| {
                    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
                });
            let affected = if let Ok(mut values) = layers().lock() {
                let affected: Vec<_> = values
                    .iter()
                    .filter(|(_, layer)| layer.owner == owner)
                    .map(|(kind, layer)| (*kind, layer.clone()))
                    .collect();
                if !visible {
                    values.retain(|kind, layer| {
                        layer.owner != owner || (*kind == LayerKind::Progress && !destroyed)
                    });
                }
                affected
            } else {
                return;
            };
            for (kind, layer) in affected {
                let Some(layer_window) = app.get_window(kind.label()) else {
                    continue;
                };
                if !visible {
                    let _ = layer_window.hide();
                    if kind != LayerKind::Progress || destroyed {
                        let _ = app.emit_to(
                            kind.label(),
                            "floating-layer-state",
                            Option::<LayerState>::None,
                        );
                    }
                } else if reposition
                    || (kind == LayerKind::Progress && !layer_window.is_visible().unwrap_or(false))
                {
                    let _ = app.emit_to(kind.label(), "floating-layer-state", Some(layer));
                }
            }
        });
        if destroyed {
            return;
        }
    }
    if window.label() != "app-progress" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let value = layers()
            .lock()
            .ok()
            .and_then(|v| v.get(&LayerKind::Progress).cloned());
        if let Some(value) = value {
            let app = window.app_handle().clone();
            if let Some(webview) = app.get_webview("app-progress") {
                tauri::async_runtime::spawn(async move {
                    hide_floating_layer(app, webview, LayerKind::Progress, value.input.id).await;
                });
            }
        }
    }
}
