mod database;
mod models;

use std::path::PathBuf;

use database::DatabaseState;
use models::{
    BackupResult, BookRecord, ChapterRecord, ChapterSummary, SaveImportedBookInput,
    SaveProgressInput, SearchResult, StorageStatus,
};
use tauri::{Manager, State};

fn desktop_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let default_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let app_data_root = default_directory
        .parent()
        .ok_or_else(|| "无法定位 AppData 目录".to_string())?;
    Ok(app_data_root.join("NovelLibrary"))
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
    state: State<'_, DatabaseState>,
    data_directory: String,
) -> Result<StorageStatus, String> {
    state.change_data_directory(PathBuf::from(data_directory))?;
    let (data_directory, database_path) = state.storage_paths()?;
    Ok(StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    })
}

#[tauri::command]
fn reset_data_directory(state: State<'_, DatabaseState>) -> Result<StorageStatus, String> {
    state.reset_to_default_directory()?;
    let (data_directory, database_path) = state.storage_paths()?;
    Ok(StorageStatus {
        database_ready: database::database_exists(&database_path),
        data_directory: data_directory.display().to_string(),
        database_path: database_path.display().to_string(),
    })
}

#[tauri::command]
fn change_database_file(
    state: State<'_, DatabaseState>,
    database_path: String,
) -> Result<StorageStatus, String> {
    state.change_database_file(PathBuf::from(database_path))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_directory = desktop_data_directory(app.handle())?;
            let database = DatabaseState::initialize(data_directory)?;
            app.manage(database);
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
            get_storage_status,
            change_data_directory,
            reset_data_directory,
            change_database_file,
            export_backup,
            import_backup
        ])
        .run(tauri::generate_context!())
        .expect("failed to run novel library desktop application");
}
