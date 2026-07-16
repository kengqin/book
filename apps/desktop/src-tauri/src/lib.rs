mod bridge;
mod database;
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
            updater::check_application_update,
            updater::download_application_update,
            updater::cancel_application_update_download,
            updater::install_downloaded_application_update,
            updater::dismiss_application_update
        ])
        .run(tauri::generate_context!())
        .expect("failed to run novel library desktop application");
}
