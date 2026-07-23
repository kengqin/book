use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, Window, WindowEvent,
};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    MinimizeToTray,
    Quit,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    close_behavior: CloseBehavior,
}

pub struct CloseBehaviorState {
    behavior: Mutex<CloseBehavior>,
    settings_path: PathBuf,
    prompt_open: AtomicBool,
    force_exit: AtomicBool,
}

impl CloseBehaviorState {
    pub fn load(settings_path: PathBuf) -> Self {
        let behavior = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|value| serde_json::from_str::<AppSettings>(&value).ok())
            .map(|settings| settings.close_behavior)
            .unwrap_or_default();
        Self {
            behavior: Mutex::new(behavior),
            settings_path,
            prompt_open: AtomicBool::new(false),
            force_exit: AtomicBool::new(false),
        }
    }

    fn get(&self) -> CloseBehavior {
        *self.behavior.lock().expect("close behavior lock poisoned")
    }

    fn set(&self, behavior: CloseBehavior) -> Result<(), String> {
        if let Some(parent) = self.settings_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let content = serde_json::to_string_pretty(&AppSettings {
            close_behavior: behavior,
        })
        .map_err(|error| error.to_string())?;
        fs::write(&self.settings_path, content).map_err(|error| error.to_string())?;
        *self.behavior.lock().map_err(|error| error.to_string())? = behavior;
        Ok(())
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示主窗口")
        .separator()
        .text("quit", "退出")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("小说书库")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                app.state::<CloseBehaviorState>()
                    .force_exit
                    .store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let state = window.state::<CloseBehaviorState>();
    if state.force_exit.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_close();
    match state.get() {
        CloseBehavior::Ask => {
            if !state.prompt_open.swap(true, Ordering::SeqCst) {
                let _ = window.emit("close-behavior-requested", ());
            }
        }
        CloseBehavior::MinimizeToTray => {
            state.prompt_open.store(false, Ordering::SeqCst);
            let _ = window.hide();
        }
        CloseBehavior::Quit => {
            state.force_exit.store(true, Ordering::SeqCst);
            window.app_handle().exit(0);
        }
    }
}

#[tauri::command]
pub fn get_close_behavior(state: State<'_, CloseBehaviorState>) -> CloseBehavior {
    state.get()
}

#[tauri::command]
pub fn set_close_behavior(
    state: State<'_, CloseBehaviorState>,
    behavior: CloseBehavior,
) -> Result<CloseBehavior, String> {
    state.set(behavior)?;
    Ok(behavior)
}

#[tauri::command]
pub fn cancel_close_behavior_prompt(state: State<'_, CloseBehaviorState>) {
    state.prompt_open.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn resolve_close_behavior(
    app: AppHandle,
    state: State<'_, CloseBehaviorState>,
    behavior: CloseBehavior,
    remember: bool,
) -> Result<(), String> {
    if behavior == CloseBehavior::Ask {
        return Err("请选择缩小到托盘或直接退出".to_string());
    }
    if remember {
        state.set(behavior)?;
    }
    state.prompt_open.store(false, Ordering::SeqCst);
    match behavior {
        CloseBehavior::MinimizeToTray => {
            if let Some(window) = app.get_webview_window("main") {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        CloseBehavior::Quit => {
            state.force_exit.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        CloseBehavior::Ask => unreachable!(),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, time::SystemTime};

    use super::{CloseBehavior, CloseBehaviorState};

    #[test]
    fn serializes_close_behavior_for_frontend_settings() {
        assert_eq!(
            serde_json::to_string(&CloseBehavior::MinimizeToTray).unwrap(),
            "\"minimizeToTray\""
        );
        assert_eq!(
            serde_json::from_str::<CloseBehavior>("\"quit\"").unwrap(),
            CloseBehavior::Quit
        );
    }

    #[test]
    fn persists_repeated_close_behavior_changes() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "novel-library-close-behavior-{}-{unique}",
            std::process::id()
        ));
        let settings_path = directory.join("app-settings.json");
        let state = CloseBehaviorState::load(settings_path.clone());

        state.set(CloseBehavior::MinimizeToTray).unwrap();
        state.set(CloseBehavior::Quit).unwrap();

        assert_eq!(
            CloseBehaviorState::load(settings_path).get(),
            CloseBehavior::Quit
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
