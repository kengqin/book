use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifest {
    schema_version: u32,
    plugins: Vec<PluginDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDefinition {
    id: String,
    label: String,
    kind: String,
    version: String,
    file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledIdePlugin {
    id: String,
    label: String,
    kind: String,
    version: String,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeTarget {
    id: String,
    label: String,
    kind: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeIntegrationStatus {
    plugins: Vec<BundledIdePlugin>,
    targets: Vec<IdeTarget>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIdePluginInput {
    target_id: String,
    plugin_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeInstallResult {
    target: String,
    plugin: String,
    installed: bool,
    message: String,
}

fn target_id(kind: &str, path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    kind.hash(&mut hasher);
    path.hash(&mut hasher);
    format!("{kind}-{:x}", hasher.finish())
}

fn plugin_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let candidates = [
        resource_dir.join("resources").join("ide-plugins"),
        resource_dir.join("ide-plugins"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ide-plugins"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("manifest.json").is_file())
        .ok_or_else(|| "未找到随桌面端提供的 IDE 插件清单".to_string())
}

fn read_manifest(directory: &Path) -> Result<PluginManifest, String> {
    let payload = fs::read(directory.join("manifest.json")).map_err(|error| error.to_string())?;
    let manifest: PluginManifest =
        serde_json::from_slice(&payload).map_err(|error| error.to_string())?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "不支持的 IDE 插件清单版本：{}",
            manifest.schema_version
        ));
    }
    Ok(manifest)
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let output = Command::new("where.exe").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn scan_executables(root: &Path, names: &[&str], depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_executables(&path, names, depth - 1, output);
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| names.iter().any(|name| value.eq_ignore_ascii_case(name)))
        {
            output.push(path);
        }
    }
}

fn detect_targets() -> Vec<IdeTarget> {
    let mut targets = Vec::new();
    for (command, label) in [("code.cmd", "Visual Studio Code"), ("cursor.cmd", "Cursor")] {
        if let Some(path) = find_on_path(command) {
            targets.push(IdeTarget {
                id: target_id("vscode", &path),
                label: label.to_string(),
                kind: "vscode".to_string(),
                path: path.display().to_string(),
            });
        }
    }

    let mut jetbrains = Vec::new();
    for root in [
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("JetBrains").join("Toolbox").join("apps")),
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|path| path.join("JetBrains")),
        std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .map(|path| path.join("JetBrains")),
    ]
    .into_iter()
    .flatten()
    {
        scan_executables(
            &root,
            &[
                "idea64.exe",
                "pycharm64.exe",
                "webstorm64.exe",
                "studio64.exe",
                "rider64.exe",
                "clion64.exe",
                "goland64.exe",
                "rubymine64.exe",
            ],
            8,
            &mut jetbrains,
        );
    }
    jetbrains.sort();
    jetbrains.dedup();
    for path in jetbrains {
        let label = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("JetBrains IDE")
            .trim_end_matches("64")
            .to_string();
        targets.push(IdeTarget {
            id: target_id("jetbrains", &path),
            label,
            kind: "jetbrains".to_string(),
            path: path.display().to_string(),
        });
    }

    for root in [
        std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        std::env::var_os("ProgramFiles").map(PathBuf::from),
    ]
    .into_iter()
    .flatten()
    {
        let path = root
            .join("Microsoft Visual Studio")
            .join("Installer")
            .join("VSIXInstaller.exe");
        if path.is_file() {
            targets.push(IdeTarget {
                id: target_id("visual-studio", &path),
                label: "Visual Studio 2022".to_string(),
                kind: "visual-studio".to_string(),
                path: path.display().to_string(),
            });
        }
    }
    targets
}

pub fn status(app: &AppHandle) -> Result<IdeIntegrationStatus, String> {
    let directory = plugin_directory(app)?;
    let manifest = read_manifest(&directory)?;
    let plugins = manifest
        .plugins
        .into_iter()
        .map(|plugin| BundledIdePlugin {
            available: directory.join(&plugin.file).is_file(),
            id: plugin.id,
            label: plugin.label,
            kind: plugin.kind,
            version: plugin.version,
        })
        .collect();
    Ok(IdeIntegrationStatus {
        plugins,
        targets: detect_targets(),
    })
}

fn run_installer(target: &IdeTarget, plugin_path: &Path) -> Result<String, String> {
    let executable = PathBuf::from(&target.path);
    if !executable.is_file() {
        return Err("目标 IDE 已被移动或删除，请重新检测".to_string());
    }
    let output = match target.kind.as_str() {
        "vscode" => Command::new("cmd.exe")
            .arg("/c")
            .arg(&executable)
            .arg("--install-extension")
            .arg(plugin_path)
            .arg("--force")
            .output(),
        "jetbrains" => Command::new(&executable)
            .arg("installPlugins")
            .arg(plugin_path)
            .output(),
        "visual-studio" => Command::new(&executable)
            .arg("/quiet")
            .arg(plugin_path)
            .output(),
        _ => return Err("不支持的 IDE 类型".to_string()),
    }
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("安装器退出代码：{}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn install(app: &AppHandle, input: InstallIdePluginInput) -> Result<IdeInstallResult, String> {
    let directory = plugin_directory(app)?;
    let manifest = read_manifest(&directory)?;
    let plugin = manifest
        .plugins
        .into_iter()
        .find(|plugin| plugin.id == input.plugin_id)
        .ok_or_else(|| "未找到指定插件".to_string())?;
    let target = detect_targets()
        .into_iter()
        .find(|target| target.id == input.target_id)
        .ok_or_else(|| "未找到指定 IDE，请重新检测".to_string())?;
    if target.kind != plugin.kind {
        return Err("插件类型与目标 IDE 不匹配".to_string());
    }
    let plugin_path = directory.join(&plugin.file);
    if !plugin_path.is_file() {
        return Err(format!("桌面安装包未包含插件文件：{}", plugin.file));
    }
    let output = run_installer(&target, &plugin_path)?;
    Ok(IdeInstallResult {
        target: target.label,
        plugin: plugin.label,
        installed: true,
        message: if output.is_empty() {
            "安装命令已完成，重启 IDE 后生效".to_string()
        } else {
            output
        },
    })
}

#[cfg(test)]
mod tests {
    use super::target_id;
    use std::path::Path;

    #[test]
    fn creates_stable_target_ids() {
        let first = target_id("vscode", Path::new("C:/Code/code.cmd"));
        let second = target_id("vscode", Path::new("C:/Code/code.cmd"));
        assert_eq!(first, second);
        assert_ne!(first, target_id("jetbrains", Path::new("C:/Code/code.cmd")));
    }
}
