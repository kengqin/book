use std::sync::{Arc, Mutex};

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

fn allowed_download_url(url: &tauri::Url, version: &str) -> bool {
    let version = version.strip_prefix('v').unwrap_or(version);
    let expected_prefix = format!("/kengqin/book/releases/download/v{version}/");
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.path().starts_with(&expected_prefix)
        && url.path()[expected_prefix.len()..].ends_with("-setup.exe")
        && !url.path()[expected_prefix.len()..].contains('/')
        && url.query().is_none()
        && url.fragment().is_none()
}

fn classified_download_error(error: &str) -> String {
    if error.to_ascii_lowercase().contains("signature")
        || error.to_ascii_lowercase().contains("minisign")
    {
        "SIGNATURE_ERROR: 更新包签名校验失败".to_string()
    } else {
        "DOWNLOAD_ERROR: 更新包下载失败".to_string()
    }
}

#[tauri::command]
pub async fn check_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<Option<ApplicationUpdate>, String> {
    {
        let inner = lock_state(&state)?;
        if inner.cancel.is_some() || inner.downloaded.is_some() {
            return Err("UPDATE_BUSY: 当前更新任务尚未完成".to_string());
        }
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("MANIFEST_NOT_READY: 无法读取签名更新清单: {error}"))?;

    if let Some(update) = update.as_ref() {
        if !allowed_download_url(&update.download_url, &update.version) {
            return Err("DOWNLOAD_URL_NOT_ALLOWED: 更新安装包地址不在官方固定版本目录".to_string());
        }
    }

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
    let announced_total = Arc::new(Mutex::new(None::<u64>));
    let progress_total = announced_total.clone();
    let mut downloaded = 0_u64;
    let download = update.download(
        move |chunk_length, content_length| {
            downloaded += chunk_length as u64;
            if let Some(total) = content_length {
                if let Ok(mut announced) = progress_total.lock() {
                    *announced = Some(total);
                }
            }
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
            let message = classified_download_error(&error.to_string());
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
            let total = announced_total.lock().ok().and_then(|value| *value);
            if total.is_some_and(|expected| expected != bytes.len() as u64) {
                let message = "DOWNLOAD_ERROR: 更新包长度与服务器声明不一致".to_string();
                emit_progress(
                    &app,
                    DownloadProgress {
                        status: "error".to_string(),
                        downloaded: bytes.len() as u64,
                        total,
                        message: Some(message.clone()),
                    },
                );
                return Err(message);
            }
            let downloaded = bytes.len() as u64;
            inner.downloaded = Some((update, bytes));
            emit_progress(
                &app,
                DownloadProgress {
                    status: "downloaded".to_string(),
                    downloaded,
                    total: total.or(Some(downloaded)),
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
        return Err(format!("INSTALL_ERROR: {message}"));
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
    use super::{allowed_download_url, classified_download_error};

    #[test]
    fn only_accepts_installer_from_the_expected_official_tag() {
        let valid = tauri::Url::parse(
            "https://github.com/kengqin/book/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe",
        )
        .unwrap();
        let wrong_tag = tauri::Url::parse(
            "https://github.com/kengqin/book/releases/download/v0.4.1/NovelLibrary_0.4.0_x64-setup.exe",
        )
        .unwrap();
        let wrong_host = tauri::Url::parse(
            "https://example.com/kengqin/book/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe",
        )
        .unwrap();
        assert!(allowed_download_url(&valid, "0.4.0"));
        assert!(!allowed_download_url(&wrong_tag, "0.4.0"));
        assert!(!allowed_download_url(&wrong_host, "0.4.0"));
    }

    #[test]
    fn classifies_signature_failures_without_exposing_internal_paths() {
        assert_eq!(
            classified_download_error("minisign signature invalid at C:\\private\\cache"),
            "SIGNATURE_ERROR: 更新包签名校验失败"
        );
    }
}
