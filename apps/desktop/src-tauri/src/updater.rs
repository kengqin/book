use futures_util::future::{AbortHandle, Abortable};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const STATE_EVENT: &str = "application-update-state";

#[derive(Default)]
pub struct UpdateDownloadState {
    inner: Arc<Mutex<UpdateDownloadInner>>,
}

#[derive(Default)]
struct UpdateDownloadInner {
    available: Option<Update>,
    downloaded: Option<(Update, Vec<u8>)>,
    cancel: Option<AbortHandle>,
    task: ApplicationUpdateState,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUpdate {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
}
impl From<&Update> for ApplicationUpdate {
    fn from(update: &Update) -> Self {
        Self {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            date: update.date.map(|date| date.to_string()),
            body: update.body.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum UpdateStage {
    #[default]
    Idle,
    Available,
    Downloading,
    Cancelling,
    Downloaded,
    Installing,
    Installed,
    DownloadError,
    SignatureError,
    InstallError,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationUpdateState {
    revision: u64,
    stage: UpdateStage,
    update: Option<ApplicationUpdate>,
    downloaded_bytes: u64,
    total_bytes: u64,
    message: String,
    error: String,
    prompt_dismissed: bool,
}
impl ApplicationUpdateState {
    fn busy(&self) -> bool {
        matches!(
            self.stage,
            UpdateStage::Downloading
                | UpdateStage::Cancelling
                | UpdateStage::Downloaded
                | UpdateStage::Installing
                | UpdateStage::Installed
                | UpdateStage::InstallError
        )
    }
    fn transition(&mut self, stage: UpdateStage, message: &str, error: &str) {
        self.revision += 1;
        self.stage = stage;
        self.message = message.to_string();
        self.error = error.to_string();
    }
}
impl UpdateDownloadInner {
    fn apply_check(&mut self, revision: u64, update: Option<Update>) -> bool {
        // A late check must not replace another window's task or verified installer.
        if self.task.busy() || self.task.revision != revision {
            return false;
        }
        let metadata = update.as_ref().map(ApplicationUpdate::from);
        if self.task.update.as_ref().map(|value| &value.version)
            != metadata.as_ref().map(|value| &value.version)
        {
            self.task.prompt_dismissed = false;
        }
        self.task.update = metadata;
        self.available = update;
        self.task.downloaded_bytes = 0;
        self.task.total_bytes = 0;
        let stage = if self.available.is_some() {
            UpdateStage::Available
        } else {
            UpdateStage::Idle
        };
        self.task.transition(stage, "", "");
        true
    }
}
fn lock_state(
    state: &UpdateDownloadState,
) -> Result<std::sync::MutexGuard<'_, UpdateDownloadInner>, String> {
    state.inner.lock().map_err(|_| "更新状态不可用".to_string())
}
fn emit_state(app: &AppHandle, snapshot: ApplicationUpdateState) {
    let _ = app.emit(STATE_EVENT, snapshot);
}

fn allowed_download_url(url: &tauri::Url, version: &str) -> bool {
    let version = version.strip_prefix('v').unwrap_or(version);
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        // Published signed manifests may still refer to the repository's old name.
        && ["kengqin/library-manage", "kengqin/book"]
            .iter()
            .any(|repository| {
                let prefix = format!("/{repository}/releases/download/v{version}/");
                url.path().strip_prefix(&prefix).is_some_and(|filename| {
                    filename.ends_with("-setup.exe") && !filename.contains('/')
                })
            })
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
pub fn get_application_update_state(
    state: State<'_, UpdateDownloadState>,
) -> Result<ApplicationUpdateState, String> {
    Ok(lock_state(&state)?.task.clone())
}

#[tauri::command]
pub async fn check_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<Option<ApplicationUpdate>, String> {
    let revision = {
        let inner = lock_state(&state)?;
        if inner.task.busy() {
            return Ok(inner.task.update.clone());
        }
        inner.task.revision
    };
    let updater = app.updater().map_err(|error| error.to_string())?;
    let result = updater.check().await;
    let mut inner = lock_state(&state)?;
    if inner.task.busy() || inner.task.revision != revision {
        return Ok(inner.task.update.clone());
    }
    let update =
        result.map_err(|error| format!("MANIFEST_NOT_READY: 无法读取签名更新清单: {error}"))?;
    if let Some(update) = update.as_ref() {
        if !allowed_download_url(&update.download_url, &update.version) {
            return Err("DOWNLOAD_URL_NOT_ALLOWED: 更新安装包地址不在官方固定版本目录".to_string());
        }
    }
    inner.apply_check(revision, update);
    let snapshot = inner.task.clone();
    let update = snapshot.update.clone();
    drop(inner);
    emit_state(&app, snapshot);
    Ok(update)
}

#[tauri::command]
pub async fn download_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<bool, String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    let (update, snapshot) = {
        let mut inner = lock_state(&state)?;
        if inner.task.busy() {
            return Ok(inner.downloaded.is_some());
        }
        let update = inner.available.clone().ok_or("没有可下载的更新")?;
        inner.cancel = Some(abort_handle);
        inner.task.prompt_dismissed = false;
        inner.task.downloaded_bytes = 0;
        inner.task.total_bytes = 0;
        inner.task.transition(UpdateStage::Downloading, "", "");
        (update, inner.task.clone())
    };
    emit_state(&app, snapshot);
    let progress_app = app.clone();
    let progress_state = state.inner.clone();
    let download = update.download(
        move |chunk_length, content_length| {
            let snapshot = if let Ok(mut inner) = progress_state.lock() {
                inner.task.downloaded_bytes += chunk_length as u64;
                if let Some(total) = content_length {
                    inner.task.total_bytes = total;
                }
                inner.task.revision += 1;
                Some(inner.task.clone())
            } else {
                None
            };
            if let Some(snapshot) = snapshot {
                emit_state(&progress_app, snapshot);
            }
        },
        || {},
    );
    let result = Abortable::new(download, abort_registration).await;
    let mut inner = lock_state(&state)?;
    inner.cancel = None;
    let outcome = match result {
        Err(_) => {
            inner.task.downloaded_bytes = 0;
            inner.task.total_bytes = 0;
            inner
                .task
                .transition(UpdateStage::Available, "下载已取消", "");
            Ok(false)
        }
        Ok(Err(error)) => {
            let message = classified_download_error(&error.to_string());
            let stage = if message.starts_with("SIGNATURE_ERROR") {
                UpdateStage::SignatureError
            } else {
                UpdateStage::DownloadError
            };
            inner.task.transition(stage, "", &message);
            Err(message)
        }
        Ok(Ok(bytes)) => {
            if inner.task.total_bytes > 0 && inner.task.total_bytes != bytes.len() as u64 {
                let message = "DOWNLOAD_ERROR: 更新包长度与服务器声明不一致".to_string();
                inner
                    .task
                    .transition(UpdateStage::DownloadError, "", &message);
                Err(message)
            } else {
                inner.task.downloaded_bytes = bytes.len() as u64;
                inner.task.total_bytes = bytes.len() as u64;
                inner.downloaded = Some((update, bytes));
                inner
                    .task
                    .transition(UpdateStage::Downloaded, "下载完成，等待安装", "");
                Ok(true)
            }
        }
    };
    let snapshot = inner.task.clone();
    drop(inner);
    emit_state(&app, snapshot);
    outcome
}

#[tauri::command]
pub fn cancel_application_update_download(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<bool, String> {
    let mut inner = lock_state(&state)?;
    let Some(cancel) = inner.cancel.as_ref() else {
        return Ok(false);
    };
    cancel.abort();
    inner
        .task
        .transition(UpdateStage::Cancelling, "正在取消下载...", "");
    let snapshot = inner.task.clone();
    drop(inner);
    emit_state(&app, snapshot);
    Ok(true)
}

#[tauri::command]
pub fn install_downloaded_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<(), String> {
    let downloaded = {
        let mut inner = lock_state(&state)?;
        let downloaded = inner.downloaded.take().ok_or("更新尚未下载完成")?;
        inner
            .task
            .transition(UpdateStage::Installing, "正在安装更新...", "");
        let snapshot = inner.task.clone();
        drop(inner);
        emit_state(&app, snapshot);
        downloaded
    };
    if let Err(error) = downloaded.0.install(&downloaded.1) {
        let message = format!("INSTALL_ERROR: {error}");
        let mut inner = lock_state(&state)?;
        inner.downloaded = Some(downloaded);
        inner.task.transition(
            UpdateStage::InstallError,
            "更新已下载，可重新安装",
            &message,
        );
        let snapshot = inner.task.clone();
        drop(inner);
        emit_state(&app, snapshot);
        return Err(message);
    }
    let mut inner = lock_state(&state)?;
    inner
        .task
        .transition(UpdateStage::Installed, "更新已安装，等待重启", "");
    let snapshot = inner.task.clone();
    drop(inner);
    emit_state(&app, snapshot);
    Ok(())
}

#[tauri::command]
pub fn dismiss_application_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<(), String> {
    let mut inner = lock_state(&state)?;
    // Deferring the prompt must retain an active download or verified installer.
    inner.task.prompt_dismissed = true;
    inner.task.revision += 1;
    let snapshot = inner.task.clone();
    drop(inner);
    emit_state(&app, snapshot);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_accepts_installer_from_the_expected_official_tag() {
        let valid = tauri::Url::parse("https://github.com/kengqin/library-manage/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe").unwrap();
        let wrong_tag = tauri::Url::parse("https://github.com/kengqin/library-manage/releases/download/v0.4.1/NovelLibrary_0.4.0_x64-setup.exe").unwrap();
        let wrong_host = tauri::Url::parse("https://example.com/kengqin/library-manage/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe").unwrap();
        let legacy = tauri::Url::parse("https://github.com/kengqin/book/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe").unwrap();
        let wrong_repository = tauri::Url::parse("https://github.com/someone/library-manage/releases/download/v0.4.0/NovelLibrary_0.4.0_x64-setup.exe").unwrap();
        assert!(allowed_download_url(&valid, "0.4.0"));
        assert!(allowed_download_url(&legacy, "0.4.0"));
        assert!(!allowed_download_url(&wrong_tag, "0.4.0"));
        assert!(!allowed_download_url(&wrong_host, "0.4.0"));
        assert!(!allowed_download_url(&wrong_repository, "0.4.0"));
    }
    #[test]
    fn classifies_signature_failures_without_exposing_internal_paths() {
        assert_eq!(
            classified_download_error("minisign signature invalid at C:\\private\\cache"),
            "SIGNATURE_ERROR: 更新包签名校验失败"
        );
    }
    #[test]
    fn a_late_check_cannot_replace_a_downloaded_or_running_task() {
        for stage in [
            UpdateStage::Downloading,
            UpdateStage::Cancelling,
            UpdateStage::Downloaded,
            UpdateStage::Installing,
            UpdateStage::Installed,
            UpdateStage::InstallError,
        ] {
            let mut inner = UpdateDownloadInner::default();
            inner.task.transition(stage, "pending update", "");
            inner.task.downloaded_bytes = 1234;
            let before = inner.task.clone();
            assert!(!inner.apply_check(inner.task.revision, None));
            assert_eq!(inner.task, before);
        }
    }
    #[test]
    fn a_check_started_before_cancellation_or_dismissal_is_discarded() {
        let mut inner = UpdateDownloadInner::default();
        let revision = inner.task.revision;
        inner
            .task
            .transition(UpdateStage::Available, "下载已取消", "");
        let before = inner.task.clone();
        assert!(!inner.apply_check(revision, None));
        assert_eq!(inner.task, before);
    }
    #[test]
    fn a_new_window_snapshot_contains_version_progress_and_ready_stage() {
        let mut task = ApplicationUpdateState {
            update: Some(ApplicationUpdate {
                current_version: "0.7.0".into(),
                version: "0.7.1".into(),
                date: None,
                body: None,
            }),
            downloaded_bytes: 1234,
            total_bytes: 1234,
            ..Default::default()
        };
        task.transition(UpdateStage::Downloaded, "下载完成，等待安装", "");
        let snapshot = serde_json::to_value(&task).unwrap();
        assert_eq!(snapshot["stage"], "downloaded");
        assert_eq!(snapshot["update"]["version"], "0.7.1");
        assert_eq!(snapshot["downloadedBytes"], 1234);
        assert!(snapshot.get("installer").is_none());
    }
}
