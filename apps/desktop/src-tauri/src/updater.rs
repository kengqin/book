use std::sync::Mutex;

use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const DOWNLOAD_EVENT: &str = "application-update-download";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/kengqin/book/releases/download";

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

fn versioned_update_endpoint(version: &str) -> Result<tauri::Url, String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    let valid = !version.is_empty()
        && version.len() <= 64
        && version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        });
    if !valid {
        return Err("更新版本号格式无效".to_string());
    }

    tauri::Url::parse(&format!("{RELEASE_DOWNLOAD_BASE}/v{version}/latest.json"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn check_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
    expected_version: Option<String>,
) -> Result<Option<ApplicationUpdate>, String> {
    let updater = if let Some(version) = expected_version.as_deref() {
        app.updater_builder()
            .endpoints(vec![versioned_update_endpoint(version)?])
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?
    } else {
        app.updater().map_err(|error| error.to_string())?
    };
    let update = updater.check().await.map_err(|error| error.to_string())?;

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

#[cfg(test)]
mod tests {
    use super::versioned_update_endpoint;

    #[test]
    fn builds_version_specific_update_endpoint() {
        let endpoint = versioned_update_endpoint("0.3.1").expect("valid endpoint");
        assert_eq!(
            endpoint.as_str(),
            "https://github.com/kengqin/book/releases/download/v0.3.1/latest.json"
        );
    }

    #[test]
    fn accepts_prefixed_version_without_duplicate_prefix() {
        let endpoint = versioned_update_endpoint("v0.3.1").expect("valid endpoint");
        assert!(endpoint.as_str().contains("/v0.3.1/latest.json"));
        assert!(!endpoint.as_str().contains("/vv0.3.1/"));
    }

    #[test]
    fn rejects_version_that_can_escape_the_release_path() {
        assert!(versioned_update_endpoint("../latest").is_err());
        assert!(versioned_update_endpoint("0.3.1/latest").is_err());
    }
}
