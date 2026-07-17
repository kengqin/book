use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{self, Read},
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

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
    identifier: String,
    description: String,
    package_type: String,
    supported_ides: Vec<String>,
    file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JetBrainsProductInfo {
    data_directory_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledIdePlugin {
    id: String,
    label: String,
    kind: String,
    version: String,
    identifier: String,
    description: String,
    package_type: String,
    supported_ides: Vec<String>,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeTarget {
    id: String,
    label: String,
    kind: String,
    path: String,
    installed: bool,
    installed_version: Option<String>,
    can_uninstall: bool,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallIdePluginInput {
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
    let manifest_candidates = candidates
        .into_iter()
        .filter(|path| path.join("manifest.json").is_file())
        .collect::<Vec<_>>();
    manifest_candidates
        .iter()
        .find(|path| {
            read_manifest(path)
                .map(|manifest| {
                    manifest
                        .plugins
                        .iter()
                        .all(|plugin| path.join(&plugin.file).is_file())
                })
                .unwrap_or(false)
        })
        .cloned()
        .or_else(|| manifest_candidates.into_iter().next())
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
    let output = hidden_command("where.exe").arg(name).output().ok()?;
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

fn expand_launcher_token(script: &Path, token: &str) -> Option<PathBuf> {
    let relative = token.trim().strip_prefix("%~dp0")?;
    let path = script.parent()?.join(relative);
    path.is_file().then_some(path)
}

fn cli_command(target: &IdeTarget) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let launcher = PathBuf::from(&target.path);
    if launcher
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd"))
    {
        let script = fs::read_to_string(&launcher)
            .map_err(|error| format!("无法读取 IDE 启动脚本：{error}"))?;
        let paths = script
            .lines()
            .flat_map(|line| line.split('"'))
            .filter_map(|token| expand_launcher_token(&launcher, token))
            .collect::<Vec<_>>();
        let executable = paths
            .iter()
            .find(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            })
            .cloned()
            .ok_or_else(|| "无法从 IDE 启动脚本定位可执行文件".to_string())?;
        let prefix = paths
            .into_iter()
            .filter(|path| path != &executable)
            .collect();
        return Ok((executable, prefix));
    }
    if launcher.is_file() {
        Ok((launcher, Vec::new()))
    } else {
        Err("目标 IDE 已被移动或删除，请重新检测".to_string())
    }
}

fn vscode_cli_process(target: &IdeTarget) -> Result<Command, String> {
    let (executable, prefix) = cli_command(target)?;
    let mut command = hidden_command(executable);
    command
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("VSCODE_DEV")
        .args(prefix);
    Ok(command)
}

fn scan_executables(root: &Path, names: &[&str], depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
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

#[cfg(windows)]
fn jetbrains_registry_roots() -> Vec<PathBuf> {
    use winreg::{enums::*, RegKey};

    let uninstall_path = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let mut roots = Vec::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for access in [KEY_READ | KEY_WOW64_64KEY, KEY_READ | KEY_WOW64_32KEY] {
            let Ok(uninstall) = RegKey::predef(hive).open_subkey_with_flags(uninstall_path, access)
            else {
                continue;
            };
            for key_name in uninstall.enum_keys().flatten() {
                let Ok(app) = uninstall.open_subkey_with_flags(&key_name, access) else {
                    continue;
                };
                let display_name = app
                    .get_value::<String, _>("DisplayName")
                    .unwrap_or_default();
                let publisher = app.get_value::<String, _>("Publisher").unwrap_or_default();
                let name = display_name.to_ascii_lowercase();
                let is_jetbrains = publisher.to_ascii_lowercase().contains("jetbrains")
                    || [
                        "intellij",
                        "pycharm",
                        "webstorm",
                        "android studio",
                        "rider",
                        "clion",
                        "goland",
                        "rubymine",
                    ]
                    .iter()
                    .any(|part| name.contains(part));
                if !is_jetbrains {
                    continue;
                }
                if let Ok(install_location) = app.get_value::<String, _>("InstallLocation") {
                    let path = PathBuf::from(install_location.trim_matches(['"', ' ']));
                    if path.is_dir() {
                        roots.push(path);
                    }
                }
            }
        }
    }
    roots
}

#[cfg(not(windows))]
fn jetbrains_registry_roots() -> Vec<PathBuf> {
    Vec::new()
}

fn jetbrains_label(path: &Path) -> String {
    let install_name = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if install_name.contains(' ') || install_name.chars().any(|value| value.is_ascii_digit()) {
        return install_name.to_string();
    }
    match path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim_end_matches("64")
        .to_ascii_lowercase()
        .as_str()
    {
        "idea" => "IntelliJ IDEA".to_string(),
        "pycharm" => "PyCharm".to_string(),
        "webstorm" => "WebStorm".to_string(),
        "studio" => "Android Studio".to_string(),
        "rider" => "Rider".to_string(),
        "clion" => "CLion".to_string(),
        "goland" => "GoLand".to_string(),
        "rubymine" => "RubyMine".to_string(),
        _ => "JetBrains IDE".to_string(),
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
                installed: false,
                installed_version: None,
                can_uninstall: true,
            });
        }
    }

    let mut jetbrains = Vec::new();
    let mut jetbrains_roots = vec![
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| (path.join("JetBrains").join("Toolbox").join("apps"), 6)),
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|path| (path.join("JetBrains"), 4)),
        std::env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .map(|path| (path.join("JetBrains"), 4)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    jetbrains_roots.extend(jetbrains_registry_roots().into_iter().map(|path| (path, 3)));
    for (root, depth) in jetbrains_roots {
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
            depth,
            &mut jetbrains,
        );
    }
    jetbrains.sort();
    jetbrains.dedup();
    for path in jetbrains {
        let label = jetbrains_label(&path);
        targets.push(IdeTarget {
            id: target_id("jetbrains", &path),
            label,
            kind: "jetbrains".to_string(),
            path: path.display().to_string(),
            installed: false,
            installed_version: None,
            can_uninstall: false,
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
                installed: false,
                installed_version: None,
                can_uninstall: false,
            });
        }
    }
    targets
}

fn parse_vscode_extension_state(output: &str, identifier: &str) -> (bool, Option<String>) {
    for line in output.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (candidate, version) = line
            .split_once('@')
            .map_or((line, None), |(candidate, version)| {
                (candidate, (!version.is_empty()).then(|| version.to_string()))
            });
        if candidate.eq_ignore_ascii_case(identifier) {
            return (true, version);
        }
    }
    (false, None)
}

fn vscode_extension_directory_state(target: &IdeTarget, identifier: &str) -> (bool, Option<String>) {
    let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) else {
        return (false, None);
    };
    let extension_root = if target.label == "Cursor" {
        home.join(".cursor").join("extensions")
    } else {
        home.join(".vscode").join("extensions")
    };
    let folder_prefix = format!("{identifier}-");
    let version = fs::read_dir(extension_root)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter_map(|name| name.strip_prefix(&folder_prefix).map(str::to_string))
        .max_by(|left, right| compare_versions(left, right));
    (version.is_some(), version)
}

fn vscode_extension_state(target: &IdeTarget, identifier: &str) -> (bool, Option<String>) {
    let Ok(mut command) = vscode_cli_process(target) else {
        return vscode_extension_directory_state(target, identifier);
    };
    let Ok(output) = command
        .arg("--list-extensions")
        .arg("--show-versions")
        .output()
    else {
        return vscode_extension_directory_state(target, identifier);
    };
    if !output.status.success() {
        return vscode_extension_directory_state(target, identifier);
    }
    parse_vscode_extension_state(&String::from_utf8_lossy(&output.stdout), identifier)
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |value: &str| {
        value
            .split(['.', '-', '+'])
            .map(|part| part.parse::<u64>().unwrap_or_default())
            .collect::<Vec<_>>()
    };
    let left = parse(left);
    let right = parse(right);
    let length = left.len().max(right.len());
    for index in 0..length {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or_default()
            .cmp(&right.get(index).copied().unwrap_or_default());
        if !ordering.is_eq() {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

fn xml_tag_value(payload: &str, tag: &str) -> Option<String> {
    let start = payload.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = payload[start..].find(&format!("</{tag}>"))? + start;
    Some(payload[start..end].trim().to_string())
}

fn jetbrains_plugin_root(target: &IdeTarget) -> Result<PathBuf, String> {
    let executable = PathBuf::from(&target.path);
    let install_root = executable
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "无法定位 JetBrains IDE 安装目录".to_string())?;
    let payload = fs::read(install_root.join("product-info.json"))
        .map_err(|error| format!("无法读取 JetBrains 产品信息：{error}"))?;
    let product: JetBrainsProductInfo = serde_json::from_slice(&payload)
        .map_err(|error| format!("JetBrains 产品信息无效：{error}"))?;
    if product.data_directory_name.trim().is_empty()
        || product.data_directory_name.contains(['/', '\\'])
        || product.data_directory_name.contains("..")
    {
        return Err("JetBrains 插件目录名称无效".to_string());
    }
    let app_data = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA 不可用".to_string())?;
    Ok(app_data
        .join("JetBrains")
        .join(product.data_directory_name)
        .join("plugins"))
}

fn jetbrains_plugin_location(
    target: &IdeTarget,
    identifier: &str,
) -> Option<(PathBuf, Option<String>)> {
    let root = jetbrains_plugin_root(target).ok()?;
    let plugins = fs::read_dir(&root).ok()?;
    for plugin in plugins.flatten() {
        if !plugin.path().is_dir() || plugin.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
        let mut metadata = Vec::new();
        scan_files_named(&plugin.path(), "plugin.xml", 4, &mut metadata);
        let mut jars = Vec::new();
        scan_files_with_extension(&plugin.path(), "jar", 4, &mut jars);
        let payloads = metadata
            .into_iter()
            .filter_map(|file| fs::read_to_string(file).ok())
            .chain(jars.into_iter().filter_map(read_plugin_xml_from_jar));
        for payload in payloads {
            if xml_tag_value(&payload, "id").as_deref() == Some(identifier) {
                return Some((plugin.path(), xml_tag_value(&payload, "version")));
            }
        }
    }
    None
}

fn read_plugin_xml_from_jar(path: PathBuf) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("META-INF/plugin.xml").ok()?;
    let mut payload = String::new();
    entry.read_to_string(&mut payload).ok()?;
    Some(payload)
}

fn install_jetbrains_plugin(target: &IdeTarget, plugin_path: &Path) -> Result<String, String> {
    let plugin_root = jetbrains_plugin_root(target)?;
    fs::create_dir_all(&plugin_root)
        .map_err(|error| format!("无法创建 JetBrains 插件目录：{error}"))?;

    let archive_file = File::open(plugin_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("JetBrains 插件包无效：{error}"))?;
    let temporary = plugin_root.join(format!(".novel-library-install-{}", std::process::id()));
    if temporary.exists() {
        fs::remove_dir_all(&temporary).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&temporary).map_err(|error| error.to_string())?;

    let extract_result = (|| -> Result<String, String> {
        let mut top_level: Option<String> = None;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("无法读取 JetBrains 插件包：{error}"))?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| "JetBrains 插件包包含不安全路径".to_string())?;
            let first = enclosed
                .components()
                .next()
                .and_then(|value| value.as_os_str().to_str())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "JetBrains 插件包目录结构无效".to_string())?;
            if top_level.as_deref().is_some_and(|value| value != first) {
                return Err("JetBrains 插件包必须只有一个顶层目录".to_string());
            }
            top_level.get_or_insert_with(|| first.to_string());
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("JetBrains 插件包不能包含符号链接".to_string());
            }
            let destination = temporary.join(enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            } else {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let mut output = File::create(&destination).map_err(|error| error.to_string())?;
                io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            }
        }
        top_level.ok_or_else(|| "JetBrains 插件包为空".to_string())
    })();

    let top_level = match extract_result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_dir_all(&temporary);
            return Err(error);
        }
    };
    let staged = temporary.join(&top_level);
    let destination = plugin_root.join(&top_level);
    if destination.exists() {
        fs::remove_dir_all(&destination)
            .map_err(|error| format!("无法替换已安装的 JetBrains 插件：{error}"))?;
    }
    fs::rename(&staged, &destination)
        .map_err(|error| format!("无法写入 JetBrains 插件目录：{error}"))?;
    let _ = fs::remove_dir_all(&temporary);
    Ok("本地插件已部署，重启 IDE 后生效".to_string())
}

fn scan_files_named(root: &Path, name: &str, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            scan_files_named(&path, name, depth - 1, output);
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(name))
        {
            output.push(path);
        }
    }
}

fn scan_files_with_extension(
    root: &Path,
    extension: &str,
    depth: usize,
    output: &mut Vec<PathBuf>,
) {
    if depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_symlink()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            scan_files_with_extension(&path, extension, depth - 1, output);
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            output.push(path);
        }
    }
}

fn apply_installed_states(targets: &mut [IdeTarget], plugins: &[PluginDefinition]) {
    for target in targets {
        if let Some(plugin) = plugins.iter().find(|plugin| plugin.kind == target.kind) {
            if target.kind == "vscode" {
                let (installed, version) = vscode_extension_state(target, &plugin.identifier);
                target.installed = installed;
                target.installed_version = version;
            } else if target.kind == "jetbrains" {
                let state = jetbrains_plugin_location(target, &plugin.identifier);
                target.installed = state.is_some();
                target.installed_version = state.and_then(|(_, version)| version);
                target.can_uninstall = target.installed;
            }
        }
    }
}

pub fn status(app: &AppHandle) -> Result<IdeIntegrationStatus, String> {
    let directory = plugin_directory(app)?;
    let manifest = read_manifest(&directory)?;
    let definitions = manifest.plugins;
    let mut targets = detect_targets();
    apply_installed_states(&mut targets, &definitions);
    let plugins = definitions
        .iter()
        .map(|plugin| BundledIdePlugin {
            available: directory.join(&plugin.file).is_file(),
            id: plugin.id.clone(),
            label: plugin.label.clone(),
            kind: plugin.kind.clone(),
            version: plugin.version.clone(),
            identifier: plugin.identifier.clone(),
            description: plugin.description.clone(),
            package_type: plugin.package_type.clone(),
            supported_ides: plugin.supported_ides.clone(),
        })
        .collect();
    Ok(IdeIntegrationStatus { plugins, targets })
}

fn resolve_target_plugin(
    app: &AppHandle,
    target_id: &str,
    plugin_id: &str,
) -> Result<(PathBuf, PluginDefinition, IdeTarget), String> {
    let directory = plugin_directory(app)?;
    let manifest = read_manifest(&directory)?;
    let plugin = manifest
        .plugins
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| "未找到指定插件".to_string())?;
    let target = detect_targets()
        .into_iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| "未找到指定 IDE，请重新检测".to_string())?;
    if target.kind != plugin.kind {
        return Err("插件类型与目标 IDE 不匹配".to_string());
    }
    Ok((directory, plugin, target))
}

fn run_installer(target: &IdeTarget, plugin_path: &Path) -> Result<String, String> {
    let executable = PathBuf::from(&target.path);
    if !executable.is_file() {
        return Err("目标 IDE 已被移动或删除，请重新检测".to_string());
    }
    let output = match target.kind.as_str() {
        "vscode" => {
            vscode_cli_process(target)?
                .arg("--install-extension")
                .arg(plugin_path)
                .arg("--force")
                .output()
        }
        "jetbrains" => return install_jetbrains_plugin(target, plugin_path),
        "visual-studio" => hidden_command(&executable)
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
    let (directory, plugin, target) =
        resolve_target_plugin(app, &input.target_id, &input.plugin_id)?;
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

pub fn uninstall(
    app: &AppHandle,
    input: UninstallIdePluginInput,
) -> Result<IdeInstallResult, String> {
    let (_directory, plugin, target) =
        resolve_target_plugin(app, &input.target_id, &input.plugin_id)?;
    if target.kind == "jetbrains" {
        let (directory, _) = jetbrains_plugin_location(&target, &plugin.identifier)
            .ok_or_else(|| "未找到已安装的 JetBrains 插件".to_string())?;
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("无法卸载 JetBrains 插件：{error}"))?;
        return Ok(IdeInstallResult {
            target: target.label,
            plugin: plugin.label,
            installed: false,
            message: "插件目录已删除，重启 IDE 后生效".to_string(),
        });
    }
    if !target.can_uninstall {
        return Err("此 IDE 请在其内置插件管理器中卸载".to_string());
    }
    let output = vscode_cli_process(&target)?
        .arg("--uninstall-extension")
        .arg(&plugin.identifier)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let (installed, _) = vscode_extension_state(&target, &plugin.identifier);
    if installed {
        return Err("IDE 仍报告插件已安装，请关闭 IDE 后重试卸载".to_string());
    }
    Ok(IdeInstallResult {
        target: target.label,
        plugin: plugin.label,
        installed: false,
        message: "已从 IDE 扩展清单移除；重载或重启 IDE 后，活动栏和扩展页面会同步消失"
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        compare_versions, detect_targets, parse_vscode_extension_state, read_plugin_xml_from_jar,
        target_id, vscode_extension_state, xml_tag_value,
    };
    use std::{collections::HashSet, fs::File, io::Write, path::Path, time::Instant};

    #[test]
    fn creates_stable_target_ids() {
        let first = target_id("vscode", Path::new("C:/Code/code.cmd"));
        let second = target_id("vscode", Path::new("C:/Code/code.cmd"));
        assert_eq!(first, second);
        assert_ne!(first, target_id("jetbrains", Path::new("C:/Code/code.cmd")));
    }

    #[test]
    fn reads_vscode_cli_extension_state_without_trusting_stale_directories() {
        assert_eq!(
            parse_vscode_extension_state(
                "publisher.other@1.0.0\nnovel-library.novel-library-reader@0.4.3\n",
                "novel-library.novel-library-reader",
            ),
            (true, Some("0.4.3".to_string()))
        );
        assert_eq!(
            parse_vscode_extension_state(
                "publisher.other@1.0.0\n",
                "novel-library.novel-library-reader",
            ),
            (false, None)
        );
    }

    #[test]
    fn queries_detected_vscode_clis_without_launching_the_ide_runtime() {
        for target in detect_targets()
            .into_iter()
            .filter(|target| target.kind == "vscode")
        {
            let started = Instant::now();
            let _ = vscode_extension_state(&target, "novel-library.novel-library-reader");
            assert!(
                started.elapsed().as_secs() < 5,
                "{} CLI query took too long",
                target.label
            );
        }
    }

    #[test]
    fn reads_jetbrains_metadata_from_plugin_jar() {
        let path = std::env::temp_dir().join(format!("novel-library-{}.jar", uuid::Uuid::new_v4()));
        let file = File::create(&path).expect("create test plugin jar");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "META-INF/plugin.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start plugin metadata");
        archive
            .write_all(b"<idea-plugin><id>com.kengqin.novellibrary.reader</id><version>0.4.1</version></idea-plugin>")
            .expect("write plugin metadata");
        archive.finish().expect("finish plugin jar");

        let payload = read_plugin_xml_from_jar(path.clone()).expect("read plugin metadata");
        assert_eq!(
            xml_tag_value(&payload, "id").as_deref(),
            Some("com.kengqin.novellibrary.reader")
        );
        assert_eq!(xml_tag_value(&payload, "version").as_deref(), Some("0.4.1"));
        std::fs::remove_file(path).expect("remove test plugin jar");
    }

    #[test]
    fn compares_numeric_plugin_versions() {
        assert!(compare_versions("0.4.2", "0.4.1").is_gt());
        assert!(compare_versions("0.4.10", "0.4.2").is_gt());
        assert!(compare_versions("1.0", "1.0.0").is_eq());
    }

    #[test]
    fn detects_only_existing_unique_ide_targets_promptly() {
        let started = Instant::now();
        let targets = detect_targets();
        let mut ids = HashSet::new();
        for target in &targets {
            assert!(
                Path::new(&target.path).is_file(),
                "missing IDE target: {}",
                target.path
            );
            assert!(
                ids.insert(&target.id),
                "duplicate IDE target: {}",
                target.path
            );
        }
        assert!(
            started.elapsed().as_secs() < 8,
            "IDE detection exceeded UI timeout"
        );
        eprintln!(
            "detected {} IDE target(s) in {:?}",
            targets.len(),
            started.elapsed()
        );
    }
}
