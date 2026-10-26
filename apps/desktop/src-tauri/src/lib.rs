mod bridge;
mod close_behavior;
mod database;
mod floating_layer;
mod ide_integration;
mod models;
mod online;
mod search_browser;
mod settings_window;
mod site_browser;
mod updater;
mod web_browser;
mod window_theme;

use std::{
    fs,
    path::{Path, PathBuf},
};

use database::DatabaseState;
use models::{
    BackupResult, BookListRecord, BookRecord, ChapterRecord, ChapterSummary, LibrarySearchResults,
    NoteRecord, NoteSummary, NotesTransferResult, SaveImportedBookInput, SaveNoteInput,
    SaveProgressInput, SavedBookResult, StorageStatus,
};
use tauri::{Manager, State};
use updater::UpdateDownloadState;

pub(crate) fn background_ui_test() -> bool {
    cfg!(debug_assertions)
        && std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY").is_some()
        && std::env::var_os("NOVEL_LIBRARY_TEST_BACKGROUND").is_some()
}
pub(crate) fn show_auxiliary_window(window: &tauri::Window) -> Result<(), String> {
    if background_ui_test() {
        window
            .set_position(tauri::PhysicalPosition::new(-20000, -20000))
            .map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    if !background_ui_test() {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    window.with_webview(|webview| unsafe {
        let result = webview
            .controller()
            .CoreWebView2()
            .and_then(|core_webview| core_webview.Settings())
            .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
            .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false));

        if let Err(error) = result {
            eprintln!("disable-browser-accelerator-keys-error: {error}");
        }
    })
}

#[cfg(not(windows))]
fn disable_browser_accelerator_keys(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

fn legacy_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let app_data_root = default_directory
        .parent()
        .ok_or_else(|| "无法定位 AppData 目录".to_string())?;
    Ok(app_data_root.join("NovelLibrary"))
}

fn installation_directory() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 NovelLibrary 安装目录".to_string())
}

fn default_data_directory(install_directory: &Path) -> Result<PathBuf, String> {
    Ok(install_directory.join("NovelLibraryData"))
}

#[tauri::command]
fn list_books(state: State<'_, DatabaseState>) -> Result<Vec<BookRecord>, String> {
    database::list_books(&state.connect()?)
}

#[tauri::command]
fn list_book_summaries(state: State<'_, DatabaseState>) -> Result<Vec<BookListRecord>, String> {
    database::list_book_summaries(&state.connect()?)
}

#[tauri::command]
async fn wait_for_startup(state: State<'_, DatabaseState>) -> Result<(), String> {
    state.wait_until_ready()
}

#[tauri::command]
fn get_book(
    state: State<'_, DatabaseState>,
    book_id: String,
) -> Result<Option<BookRecord>, String> {
    database::get_book(&state.connect()?, &book_id)
}

#[tauri::command]
fn list_chapters(
    state: State<'_, DatabaseState>,
    book_id: String,
) -> Result<Vec<ChapterSummary>, String> {
    database::list_chapters(&state.connect()?, &book_id)
}

#[tauri::command]
fn get_chapter(
    state: State<'_, DatabaseState>,
    book_id: String,
    number: i64,
) -> Result<Option<ChapterRecord>, String> {
    database::get_chapter(&state.connect()?, &book_id, number)
}

#[tauri::command]
fn save_imported_book(
    state: State<'_, DatabaseState>,
    input: SaveImportedBookInput,
) -> Result<SavedBookResult, String> {
    let book = database::save_imported_book(&mut state.connect()?, input)?;
    Ok(SavedBookResult { id: book.id })
}

#[tauri::command]
fn save_reading_progress(
    state: State<'_, DatabaseState>,
    input: SaveProgressInput,
) -> Result<(), String> {
    database::save_progress(
        &state.connect()?,
        &input.book_id,
        input.chapter_number,
        input.chapter_progress,
    )
}

#[tauri::command]
fn delete_book(state: State<'_, DatabaseState>, book_id: String) -> Result<(), String> {
    database::delete_book(&state.connect()?, &book_id)
}

#[tauri::command]
fn search_library(
    state: State<'_, DatabaseState>,
    query: String,
) -> Result<LibrarySearchResults, String> {
    database::search(&state.connect()?, &query)
}

#[tauri::command]
fn list_notes(
    state: State<'_, DatabaseState>,
    query: Option<String>,
) -> Result<Vec<NoteSummary>, String> {
    database::list_notes(&state.connect()?, query.as_deref().unwrap_or_default())
}

#[tauri::command]
fn get_note(
    state: State<'_, DatabaseState>,
    note_id: String,
) -> Result<Option<NoteRecord>, String> {
    database::get_note(&state.connect()?, &note_id)
}

#[tauri::command]
fn create_note(state: State<'_, DatabaseState>, title: String) -> Result<NoteRecord, String> {
    database::create_note(&state.connect()?, &title)
}

#[tauri::command]
fn save_note(state: State<'_, DatabaseState>, input: SaveNoteInput) -> Result<NoteRecord, String> {
    database::save_note(&state.connect()?, input)
}

#[tauri::command]
fn set_note_pinned(
    state: State<'_, DatabaseState>,
    note_id: String,
    is_pinned: bool,
) -> Result<(), String> {
    database::set_note_pinned(&state.connect()?, &note_id, is_pinned)
}

#[tauri::command]
fn duplicate_note(state: State<'_, DatabaseState>, note_id: String) -> Result<NoteRecord, String> {
    database::duplicate_note(&state.connect()?, &note_id)
}

#[tauri::command]
fn delete_note(state: State<'_, DatabaseState>, note_id: String) -> Result<(), String> {
    database::delete_note(&state.connect()?, &note_id)
}

#[tauri::command]
fn export_notes(
    state: State<'_, DatabaseState>,
    target_path: String,
) -> Result<NotesTransferResult, String> {
    database::export_notes(&state.connect()?, std::path::Path::new(&target_path))
}

#[tauri::command]
fn import_notes(
    state: State<'_, DatabaseState>,
    source_path: String,
) -> Result<NotesTransferResult, String> {
    database::import_notes(&mut state.connect()?, std::path::Path::new(&source_path))
}

#[tauri::command]
fn write_note_export(target_path: String, content: String) -> Result<String, String> {
    database::write_text_file(std::path::Path::new(&target_path), &content)
}

#[tauri::command]
fn get_storage_status(state: State<'_, DatabaseState>) -> StorageStatus {
    let (data_directory, database_path) = state.storage_paths().unwrap_or_default();
    StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    }
}

#[tauri::command]
fn change_data_directory(
    app: tauri::AppHandle,
    state: State<'_, DatabaseState>,
    data_directory: String,
) -> Result<StorageStatus, String> {
    state.change_data_directory(PathBuf::from(data_directory))?;
    bridge::sync_storage_paths(&app)?;
    let (data_directory, database_path) = state.storage_paths()?;
    Ok(StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    })
}

#[tauri::command]
fn reset_data_directory(
    app: tauri::AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<StorageStatus, String> {
    state.reset_to_default_directory()?;
    bridge::sync_storage_paths(&app)?;
    let (data_directory, database_path) = state.storage_paths()?;
    Ok(StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    })
}

#[tauri::command]
fn change_database_file(
    app: tauri::AppHandle,
    state: State<'_, DatabaseState>,
    database_path: String,
) -> Result<StorageStatus, String> {
    state.change_database_file(PathBuf::from(database_path))?;
    bridge::sync_storage_paths(&app)?;
    let (data_directory, database_path) = state.storage_paths()?;
    Ok(StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    })
}

#[tauri::command]
fn export_backup(
    state: State<'_, DatabaseState>,
    target_path: String,
) -> Result<BackupResult, String> {
    database::export_backup(&state.connect()?, std::path::Path::new(&target_path))
}

#[tauri::command]
fn import_backup(
    state: State<'_, DatabaseState>,
    source_path: String,
) -> Result<BackupResult, String> {
    database::import_backup(&mut state.connect()?, std::path::Path::new(&source_path))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalFile {
    name: String,
    bytes: Vec<u8>,
}

#[tauri::command]
fn read_external_file(path: String) -> Result<ExternalFile, String> {
    let source = PathBuf::from(&path);
    if !source.is_absolute() || !source.is_file() {
        return Err("文件不存在或路径不是绝对路径".to_string());
    }
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if metadata.len() > 512 * 1024 * 1024 {
        return Err("文件超过 512 MB，暂不支持导入".to_string());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法读取文件名".to_string())?
        .to_string();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "txt" && extension != "epub" {
        return Err("只支持导入 TXT 或 EPUB 文件".to_string());
    }
    Ok(ExternalFile {
        name,
        bytes: fs::read(source).map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
async fn get_ide_integration_status(
    app: tauri::AppHandle,
) -> Result<ide_integration::IdeIntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(move || ide_integration::status(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn install_ide_plugin(
    app: tauri::AppHandle,
    input: ide_integration::InstallIdePluginInput,
) -> Result<ide_integration::IdeInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || ide_integration::install(&app, input))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn uninstall_ide_plugin(
    app: tauri::AppHandle,
    input: ide_integration::UninstallIdePluginInput,
) -> Result<ide_integration::IdeInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || ide_integration::uninstall(&app, input))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_code_oss_wheel_injection(
    input: ide_integration::SetCodeOssWheelInjectionInput,
) -> Result<ide_integration::CodeOssWheelInjectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ide_integration::set_code_oss_wheel_injection(input)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn set_window_palette(window: tauri::Window, palette: Option<String>) -> Result<(), String> {
    window_theme::set_window_palette(&window, palette.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Some(directory) = std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY") {
        // Keep automated desktop checks separate from the user's cookies and settings.
        for window in &mut context.config_mut().app.windows {
            window.data_directory = Some(PathBuf::from(&directory).join("webview"));
            window.visible = false;
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remote pages open managed tabs through on_new_window. The opener's global
        // click script would swallow those links and attempt a denied remote IPC call.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window("main") {
                disable_browser_accelerator_keys(&main_window)?;
            }
            if let Some(main_window) = app.get_window("main") {
                if let Err(error) = window_theme::set_window_palette(&main_window, Some("startup"))
                {
                    eprintln!("startup-window-theme-error: {error}");
                }
            }
            let legacy_directory = legacy_data_directory(app.handle())?;
            let install_directory = installation_directory()?;
            let isolated = cfg!(debug_assertions)
                .then(|| std::env::var_os("NOVEL_LIBRARY_TEST_DATA_DIRECTORY"))
                .flatten()
                .map(PathBuf::from);
            let data_directory = isolated
                .clone()
                .unwrap_or(default_data_directory(&install_directory)?);
            let old_settings = legacy_directory.join("app-settings.json");
            let new_settings = data_directory.join("app-settings.json");
            if isolated.is_none() && !new_settings.exists() && old_settings.is_file() {
                fs::create_dir_all(&data_directory)?;
                let _ = fs::copy(&old_settings, &new_settings);
                let _ = fs::remove_file(old_settings);
            }
            app.manage(close_behavior::CloseBehaviorState::load(
                data_directory.join("app-settings.json"),
            ));
            close_behavior::setup_tray(app)?;
            let database = if isolated.is_some() {
                if let Some(window) = app.get_window("main") {
                    window.set_title("小说书库 · 联网验证")?;
                    if background_ui_test() { window.set_position(tauri::PhysicalPosition::new(-20000, -20000))?; }
                }
                DatabaseState::initialize(data_directory.clone())?
            } else {
                DatabaseState::prepare_for_installation(
                    data_directory.clone(),
                    install_directory.join("NovelLibrary.storage.json"),
                    &legacy_directory,
                )?
            };
            app.manage(database);
            app.manage(UpdateDownloadState::default());
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if isolated.is_some() {
                    return;
                }
                let state = app_handle.state::<DatabaseState>();
                if let Err(error) = state.initialize_for_installation_background(&legacy_directory)
                {
                    eprintln!("database-startup-error: {error}");
                    return;
                }
                if let Err(error) = bridge::start(app_handle.clone()) {
                    eprintln!("bridge-start-error: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(|invoke| {
            if floating_layer::is_layer(invoke.message.webview_ref().label()) {
                let layer_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![floating_layer::get_floating_layer, floating_layer::resize_floating_layer, floating_layer::hide_floating_layer];
                return layer_handler(invoke);
            }
            if invoke.message.webview_ref().label() == "release-history" {
                let history_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![set_window_palette, floating_layer::show_floating_layer, floating_layer::hide_floating_layer];
                return history_handler(invoke);
            }
            if matches!(invoke.message.webview_ref().label(), "web-browser" | "web-browser-menu") {
                let browser_handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![floating_layer::show_floating_layer, floating_layer::hide_floating_layer, web_browser::open_web_browser, web_browser::get_web_browser_state, web_browser::set_web_browser_mode, web_browser::set_web_browser_bounds, web_browser::web_browser_action, web_browser::set_web_browser_zoom, web_browser::close_web_browser, web_browser::switch_web_browser_tab, web_browser::close_web_browser_tab, web_browser::show_web_browser_menu, web_browser::close_web_browser_menu];
                return browser_handler(invoke);
            }
            if invoke.message.webview_ref().label() == "app-update" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                    updater::get_application_update_state, updater::check_application_update,
                    updater::download_application_update, updater::cancel_application_update_download,
                    updater::install_downloaded_application_update, updater::dismiss_application_update,
                    floating_layer::show_floating_layer, floating_layer::hide_floating_layer,
                    settings_window::open_release_history_window,
                    set_window_palette
                ];
                return handler(invoke);
            }
            if !matches!(invoke.message.webview_ref().label(), "main" | "settings") {
                invoke.resolver.reject("网页窗口没有本地数据访问权限");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                floating_layer::show_floating_layer,
                floating_layer::hide_floating_layer,
                settings_window::open_settings_window,
                settings_window::open_application_update_window,
                settings_window::open_release_history_window,
                web_browser::set_web_browser_suspended,
                web_browser::open_web_browser,
                web_browser::get_web_browser_state,
                web_browser::set_web_browser_mode,
                web_browser::set_web_browser_bounds,
                web_browser::web_browser_action,
                web_browser::set_web_browser_zoom,
                web_browser::close_web_browser,
                web_browser::switch_web_browser_tab,
                web_browser::close_web_browser_tab,
                web_browser::show_web_browser_menu,
                web_browser::close_web_browser_menu,
                search_browser::fetch_search_browser,
                search_browser::cancel_search_browser,
                site_browser::fetch_online_browser,
                site_browser::cancel_online_browser,
                site_browser::show_online_browser,
                online::fetch_online_page,
                online::search_online_books,
                online::save_online_catalog,
                online::list_online_books,
                online::store_online_chapter,
                online::set_online_state,
                list_books,
                list_book_summaries,
                get_book,
                list_chapters,
                get_chapter,
                save_imported_book,
                save_reading_progress,
                delete_book,
                search_library,
                list_notes,
                get_note,
                create_note,
                save_note,
                set_note_pinned,
                duplicate_note,
                delete_note,
                export_notes,
                import_notes,
                write_note_export,
                get_storage_status,
                change_data_directory,
                reset_data_directory,
                change_database_file,
                export_backup,
                import_backup,
                read_external_file,
                get_ide_integration_status,
                install_ide_plugin,
                uninstall_ide_plugin,
                set_code_oss_wheel_injection,
                set_window_palette,
                updater::check_application_update,
                updater::get_application_update_state,
                updater::download_application_update,
                updater::cancel_application_update_download,
                updater::install_downloaded_application_update,
                updater::dismiss_application_update,
                close_behavior::get_close_behavior,
                close_behavior::set_close_behavior,
                close_behavior::cancel_close_behavior_prompt,
                close_behavior::resolve_close_behavior,
                wait_for_startup
            ];
            handler(invoke)
        })
        .on_window_event(|window, event| {
            if window.label() == "app-update" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let _ = updater::dismiss_application_update(app.clone(), app.state::<UpdateDownloadState>());
            }
            web_browser::handle_window_event(window, event);
            floating_layer::handle_window_event(window, event);
            close_behavior::handle_window_event(window, event);
        })
        .run(context)
        .expect("failed to run novel library desktop application");
}

#[cfg(test)]
mod tests {
    use super::default_data_directory;
    use std::path::PathBuf;

    #[test]
    fn default_data_directory_is_inside_the_selected_install_directory() {
        let install_directory = PathBuf::from(r"D:\Software\NovelLibrary");
        assert_eq!(
            default_data_directory(&install_directory).expect("default data path"),
            PathBuf::from(r"D:\Software\NovelLibrary\NovelLibraryData")
        );
    }
}
