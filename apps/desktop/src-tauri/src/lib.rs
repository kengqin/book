mod bridge;
mod close_behavior;
mod database;
mod ide_integration;
mod models;
mod updater;

use std::{fs, path::PathBuf};

use database::DatabaseState;
use models::{
    BackupResult, BookRecord, ChapterRecord, ChapterSummary, NoteRecord, NoteSummary,
    NotesTransferResult, SaveImportedBookInput, SaveNoteInput, SaveProgressInput, SearchResult,
    StorageStatus,
};
use tauri::{Manager, State};
use updater::UpdateDownloadState;

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

fn default_data_directory(install_directory: &PathBuf) -> Result<PathBuf, String> {
    Ok(install_directory.join("NovelLibraryData"))
}

#[tauri::command]
fn list_books(state: State<'_, DatabaseState>) -> Result<Vec<BookRecord>, String> {
    database::list_books(&state.connect()?)
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
) -> Result<BookRecord, String> {
    database::save_imported_book(&mut state.connect()?, input)
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
) -> Result<Vec<SearchResult>, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let legacy_directory = legacy_data_directory(app.handle())?;
            let install_directory = installation_directory()?;
            let data_directory = default_data_directory(&install_directory)?;
            let old_settings = legacy_directory.join("app-settings.json");
            let new_settings = data_directory.join("app-settings.json");
            if !new_settings.exists() && old_settings.is_file() {
                fs::create_dir_all(&data_directory)?;
                let _ = fs::copy(&old_settings, &new_settings);
                let _ = fs::remove_file(old_settings);
            }
            app.manage(close_behavior::CloseBehaviorState::load(
                data_directory.join("app-settings.json"),
            ));
            close_behavior::setup_tray(app)?;
            let database = DatabaseState::initialize_for_installation(
                data_directory.clone(),
                install_directory.join("NovelLibrary.storage.json"),
                legacy_directory,
            )?;
            app.manage(database);
            bridge::start(app.handle().clone())?;
            app.manage(UpdateDownloadState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
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
            updater::check_application_update,
            updater::download_application_update,
            updater::cancel_application_update_download,
            updater::install_downloaded_application_update,
            updater::dismiss_application_update,
            close_behavior::get_close_behavior,
            close_behavior::set_close_behavior,
            close_behavior::cancel_close_behavior_prompt,
            close_behavior::resolve_close_behavior
        ])
        .on_window_event(close_behavior::handle_window_event)
        .run(tauri::generate_context!())
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
