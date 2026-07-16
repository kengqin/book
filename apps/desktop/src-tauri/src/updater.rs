use std::sync::Mutex;

use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const DOWNLOAD_EVENT: &str = "application-update-download";

#[derive(Default)]
pub struct UpdateDownloadState {
    inner: Mutex<UpdateDownloadInner>,
}

#[derive(Default)]
struct UpdateDownloadInner {
    available: Option<Update>,
    downloaded: Option<(Update, Vec<u8>)>,
    cancel: Option<AbortHandle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUpdate {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    status: String,
    downloaded: u64,
    total: Option<u64>,
    message: Option<String>,
}

fn lock_state(
    state: &UpdateDownloadState,
) -> Result<std::sync::MutexGuard<'_, UpdateDownloadInner>, String> {
    state.inner.lock().map_err(|_| "更新状态不可用".to_string())
}

fn emit_progress(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit(DOWNLOAD_EVENT, progress);
}

#[tauri::command]
pub async fn check_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<Option<ApplicationUpdate>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let mut inner = lock_state(&state)?;
    inner.available = update.clone();
    inner.downloaded = None;

    Ok(update.map(|update| ApplicationUpdate {
        current_version: update.current_version,
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
pub async fn download_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<bool, String> {
    let update = {
        let inner = lock_state(&state)?;
        inner
            .available
            .clone()
            .ok_or_else(|| "没有可下载的更新".to_string())?
    };

    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut inner = lock_state(&state)?;
        if let Some(previous) = inner.cancel.replace(abort_handle) {
            previous.abort();
        }
        inner.downloaded = None;
    }

    emit_progress(
        &app,
        DownloadProgress {
            status: "started".to_string(),
            downloaded: 0,
            total: None,
            message: None,
        },
    );

    let progress_app = app.clone();
    let mut downloaded = 0_u64;
    let download = update.download(
        move |chunk_length, content_length| {
            downloaded += chunk_length as u64;
            emit_progress(
                &progress_app,
                DownloadProgress {
                    status: "downloading".to_string(),
                    downloaded,
                    total: content_length,
                    message: None,
                },
            );
        },
        || {},
    );

    let result = Abortable::new(download, abort_registration).await;
    let mut inner = lock_state(&state)?;
    inner.cancel = None;

    match result {
        Err(_) => {
            emit_progress(
                &app,
                DownloadProgress {
                    status: "cancelled".to_string(),
                    downloaded: 0,
                    total: None,
                    message: None,
                },
            );
            Ok(false)
        }
        Ok(Err(error)) => {
            let message = error.to_string();
            emit_progress(
                &app,
                DownloadProgress {
                    status: "error".to_string(),
                    downloaded: 0,
                    total: None,
                    message: Some(message.clone()),
                },
            );
            Err(message)
        }
        Ok(Ok(bytes)) => {
            inner.downloaded = Some((update, bytes));
            emit_progress(
                &app,
                DownloadProgress {
                    status: "downloaded".to_string(),
                    downloaded: 0,
                    total: None,
                    message: None,
                },
            );
            Ok(true)
        }
    }
}

#[tauri::command]
pub fn cancel_application_update_download(
    state: State<'_, UpdateDownloadState>,
) -> Result<bool, String> {
    let mut inner = lock_state(&state)?;
    if let Some(cancel) = inner.cancel.take() {
        cancel.abort();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn install_downloaded_application_update(
    state: State<'_, UpdateDownloadState>,
) -> Result<(), String> {
    let downloaded = {
        let mut inner = lock_state(&state)?;
        inner
            .downloaded
            .take()
            .ok_or_else(|| "更新尚未下载完成".to_string())?
    };

    if let Err(error) = downloaded.0.install(&downloaded.1) {
        let message = error.to_string();
        let mut inner = lock_state(&state)?;
        inner.downloaded = Some(downloaded);
        return Err(message);
    }

    Ok(())
}

#[tauri::command]
pub fn dismiss_application_update(state: State<'_, UpdateDownloadState>) -> Result<(), String> {
    let mut inner = lock_state(&state)?;
    if let Some(cancel) = inner.cancel.take() {
        cancel.abort();
    }
    inner.available = None;
    inner.downloaded = None;
    Ok(())
}
