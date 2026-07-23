use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, MutexGuard},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

fn decode_process_output(bytes: &[u8]) -> String {
    if let Ok(value) = std::str::from_utf8(bytes) {
        return value.to_string();
    }
    #[cfg(windows)]
    {
        return encoding_rs::GBK.decode(bytes).0.into_owned();
    }
    #[cfg(not(windows))]
    String::from_utf8_lossy(bytes).into_owned()
}

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
    #[serde(default)]
    product_vendor: Option<String>,
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
    #[serde(default)]
    close_running_ide: bool,
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
    verified: bool,
    installed_version: Option<String>,
    message: String,
}

const JETBRAINS_CDS_WARNING: &str =
    "Sharing is only supported for boot loader classes because bootstrap classpath has been appended";

fn clean_installer_diagnostic(kind: &str, output: &[u8]) -> String {
    let decoded = decode_process_output(output);
    decoded
        .lines()
        .filter(|line| kind != "jetbrains" || line.trim() != JETBRAINS_CDS_WARNING)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_jetbrains_cds_warning_only(output: &[u8]) -> bool {
    let decoded = decode_process_output(output);
    decoded
        .lines()
        .any(|line| line.trim() == JETBRAINS_CDS_WARNING)
        && clean_installer_diagnostic("jetbrains", output).is_empty()
}

fn installer_failure(kind: &str, output: &Output, action: &str) -> String {
    let stderr = clean_installer_diagnostic(kind, &output.stderr);
    let stdout = clean_installer_diagnostic(kind, &output.stdout);
    let diagnostics = [stderr.as_str(), stdout.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if diagnostics.is_empty() {
        format!("{action}退出代码：{}", output.status)
    } else {
        diagnostics
    }
}

fn installed_version_matches(expected: &str, actual: &Option<String>) -> bool {
    actual.as_deref() == Some(expected)
}

fn target_executable_is_running(target: &IdeTarget) -> bool {
    #[cfg(windows)]
    {
        let Some(process_name) = Path::new(&target.path)
            .file_stem()
            .and_then(|value| value.to_str())
        else {
            return false;
        };
        let script = "$target=[IO.Path]::GetFullPath($env:NOVEL_LIBRARY_IDE_PATH); $name=$env:NOVEL_LIBRARY_IDE_PROCESS; $running=@(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { try { [IO.Path]::GetFullPath($_.Path) -ieq $target } catch { $false } }); if($running.Count -gt 0){ exit 0 }else{ exit 1 }";
        let Ok(output) = hidden_command("powershell")
            .env("NOVEL_LIBRARY_IDE_PROCESS", process_name)
            .env("NOVEL_LIBRARY_IDE_PATH", &target.path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .output()
        else {
            return false;
        };
        return output.status.success();
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        false
    }
}

fn jetbrains_running_error(target: &IdeTarget) -> String {
    format!(
        "IDE_RUNNING: {} 正在运行，Windows 无法替换正在使用的插件文件。请保存工作并完全关闭该 IDE（包括后台进程），然后再次点击更新；现有插件不会被改动。",
        target.label
    )
}

fn close_target_ide_gracefully(target: &IdeTarget) -> Result<(), String> {
    #[cfg(windows)]
    {
        let process_name = Path::new(&target.path)
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
            .ok_or_else(|| "无法识别目标 IDE 进程名，请手动关闭后重试".to_string())?;
        let script = "$target=[IO.Path]::GetFullPath($env:NOVEL_LIBRARY_IDE_PATH); $name=$env:NOVEL_LIBRARY_IDE_PROCESS; $find={ @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { try { [IO.Path]::GetFullPath($_.Path) -ieq $target } catch { $false } }) }; $processes=& $find; $processes | ForEach-Object { if ($_.MainWindowHandle -ne 0) { [void]$_.CloseMainWindow() } }; $deadline=[DateTime]::UtcNow.AddSeconds(15); do { Start-Sleep -Milliseconds 250; $processes=& $find } while($processes.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline); if($processes.Count -eq 0){ exit 0 }else{ exit 2 }";
        let output = hidden_command("powershell")
            .env("NOVEL_LIBRARY_IDE_PROCESS", process_name)
            .env("NOVEL_LIBRARY_IDE_PATH", &target.path)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script,
            ])
            .output()
            .map_err(|error| format!("无法请求关闭 {}：{error}", target.label))?;
        if output.status.code() == Some(2) {
            return Err(format!(
                "IDE_CLOSE_PENDING: 已向 {} 发送正常关闭请求，但它仍在运行。请在 IDE 中处理未保存文件或确认框，完全退出后再次点击更新；不会强制结束进程。",
                target.label
            ));
        }
        if !output.status.success() {
            return Err(format!(
                "无法请求关闭 {}：{}",
                target.label,
                installer_failure("jetbrains", &output, "关闭请求")
            ));
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("当前系统不支持自动关闭 IDE，请手动关闭后重试".to_string())
    }
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
    decode_process_output(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn vscode_script_process(target: &IdeTarget, arguments: &[&str]) -> Result<Command, String> {
    let launcher = PathBuf::from(target.path.trim().trim_matches('"'));
    let is_script = launcher
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd"));
    if !launcher.is_file() || !is_script {
        return Err("未找到 IDE 官方命令行启动脚本，请重新检测".to_string());
    }
    let mut command = hidden_command("cmd.exe");
    command.args(["/d", "/c", "call"]);
    command.arg(&launcher);
    command.args(arguments);
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
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let (candidate, version) =
            line.split_once('@')
                .map_or((line, None), |(candidate, version)| {
                    (
                        candidate,
                        (!version.is_empty()).then(|| version.to_string()),
                    )
                });
        if candidate.eq_ignore_ascii_case(identifier) {
            return (true, version);
        }
    }
    (false, None)
}

fn vscode_extension_directory_state(
    target: &IdeTarget,
    identifier: &str,
) -> (bool, Option<String>) {
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
    let Ok(mut command) = vscode_script_process(target, &["--list-extensions", "--show-versions"])
    else {
        return vscode_extension_directory_state(target, identifier);
    };
    let Ok(output) = command.output() else {
        return vscode_extension_directory_state(target, identifier);
    };
    if !output.status.success() {
        return vscode_extension_directory_state(target, identifier);
    }
    parse_vscode_extension_state(&decode_process_output(&output.stdout), identifier)
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
    let data_directory_name = product.data_directory_name.trim();
    if data_directory_name.is_empty()
        || data_directory_name.contains(['/', '\\', ':'])
        || data_directory_name.contains("..")
    {
        return Err("JetBrains 插件目录名称无效".to_string());
    }
    let app_data = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA 不可用".to_string())?;
    // Android Studio is distributed by Google and stores its user data under
    // %APPDATA%\Google, while the JetBrains IDE family uses %APPDATA%\JetBrains.
    // product-info.json carries the vendor so both layouts can be resolved.
    let vendor_root = product
        .product_vendor
        .as_deref()
        .filter(|vendor| vendor.eq_ignore_ascii_case("Google"))
        .unwrap_or("JetBrains");
    Ok(app_data
        .join(vendor_root)
        .join(data_directory_name)
        .join("plugins"))
}

fn jetbrains_plugin_location(
    target: &IdeTarget,
    identifier: &str,
) -> Option<(PathBuf, Option<String>)> {
    let root = jetbrains_plugin_root(target).ok()?;
    jetbrains_plugin_location_in_root(&root, identifier)
}

fn is_jetbrains_work_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.starts_with(".novel-library-"))
}

fn jetbrains_plugin_location_in_root(
    root: &Path,
    identifier: &str,
) -> Option<(PathBuf, Option<String>)> {
    // Gradle's IntelliJ packaging uses this stable directory name. Checking it
    // first avoids opening every installed plugin JAR on each status refresh.
    if let Some(preferred) = fs::read_dir(root).ok()?.flatten().find(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_dir())
            && !is_jetbrains_work_directory(&entry.path())
            && entry
                .file_name()
                .to_string_lossy()
                .starts_with("novel-library-intellij")
    }) {
        if let Some(location) = plugin_location_in_directory(&preferred.path(), identifier) {
            return Some(location);
        }
    }
    let plugins = fs::read_dir(root).ok()?;
    for plugin in plugins.flatten() {
        if is_jetbrains_work_directory(&plugin.path())
            || !plugin.path().is_dir()
            || plugin.file_type().is_ok_and(|kind| kind.is_symlink())
        {
            continue;
        }
        if let Some(location) = plugin_location_in_directory(&plugin.path(), identifier) {
            return Some(location);
        }
    }
    None
}

fn jetbrains_plugin_directories(root: &Path, identifier: &str) -> Vec<PathBuf> {
    let mut locations = Vec::new();
    let Ok(plugins) = fs::read_dir(root) else {
        return locations;
    };
    for plugin in plugins.flatten() {
        let path = plugin.path();
        if is_jetbrains_work_directory(&path)
            || !plugin.file_type().is_ok_and(|kind| kind.is_dir())
            || plugin.file_type().is_ok_and(|kind| kind.is_symlink())
        {
            continue;
        }
        if plugin_location_in_directory(&path, identifier).is_some() {
            locations.push(path);
        }
    }
    locations
}

fn same_existing_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn plugin_location_in_directory(
    directory: &Path,
    identifier: &str,
) -> Option<(PathBuf, Option<String>)> {
    let mut metadata = Vec::new();
    scan_files_named(directory, "plugin.xml", 4, &mut metadata);
    let mut jars = Vec::new();
    scan_files_with_extension(directory, "jar", 4, &mut jars);
    let payloads = metadata
        .into_iter()
        .filter_map(|file| fs::read_to_string(file).ok())
        .chain(jars.into_iter().filter_map(read_plugin_xml_from_jar));
    for payload in payloads {
        if xml_tag_value(&payload, "id").as_deref() == Some(identifier) {
            return Some((directory.to_path_buf(), xml_tag_value(&payload, "version")));
        }
    }
    None
}

const MAX_JETBRAINS_PLUGIN_BYTES: u64 = 512 * 1024 * 1024;
static JETBRAINS_PLUGIN_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn lock_jetbrains_plugin_mutation() -> Result<MutexGuard<'static, ()>, String> {
    JETBRAINS_PLUGIN_MUTATION_LOCK
        .lock()
        .map_err(|_| "JetBrains 插件操作锁不可用，请重启桌面端后重试".to_string())
}

struct RemoveDirectoryOnDrop {
    path: PathBuf,
    armed: bool,
}

impl RemoveDirectoryOnDrop {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RemoveDirectoryOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn restore_jetbrains_backups(backups: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (original, backup) in backups.iter().rev() {
        if backup.exists() {
            if original.exists() {
                return Err(format!(
                    "无法恢复原 JetBrains 插件目录，目标已被占用：{}",
                    original.display()
                ));
            }
            fs::rename(backup, original)
                .map_err(|error| format!("无法恢复原 JetBrains 插件目录：{error}"))?;
        }
    }
    Ok(())
}

/// Install a bundled local JetBrains ZIP without going through
/// the IDE's command-line plugin installer. Current IDE builds treat a local
/// path passed to that flow as a Marketplace ID (`unknown plugins: [<path>]`).
fn install_jetbrains_plugin(
    target: &IdeTarget,
    plugin_path: &Path,
    identifier: &str,
    expected_version: &str,
) -> Result<String, String> {
    let plugin_root = jetbrains_plugin_root(target)?;
    install_jetbrains_plugin_at(&plugin_root, plugin_path, identifier, expected_version)
}

fn install_jetbrains_plugin_at(
    plugin_root: &Path,
    plugin_path: &Path,
    identifier: &str,
    expected_version: &str,
) -> Result<String, String> {
    let _mutation_guard = lock_jetbrains_plugin_mutation()?;
    fs::create_dir_all(plugin_root)
        .map_err(|error| format!("无法创建 JetBrains 插件目录：{error}"))?;

    let archive_file = File::open(plugin_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("JetBrains 插件包无效：{error}"))?;
    let staging_root = plugin_root.parent().unwrap_or(plugin_root);
    let temporary = staging_root.join(format!(".novel-library-install-{}", uuid::Uuid::new_v4()));
    let _temporary_cleanup = RemoveDirectoryOnDrop::new(temporary.clone());
    fs::create_dir_all(&temporary).map_err(|error| error.to_string())?;

    let top_level = (|| -> Result<String, String> {
        let mut top_level: Option<String> = None;
        let mut extracted_bytes = 0u64;
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
                .filter(|value| {
                    !value.is_empty()
                        && *value != "."
                        && *value != ".."
                        && !value.contains(['/', '\\', ':'])
                        && !value.starts_with(".novel-library-")
                })
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
            let declared_total = extracted_bytes
                .checked_add(entry.size())
                .ok_or_else(|| "JetBrains 插件包大小溢出".to_string())?;
            if declared_total > MAX_JETBRAINS_PLUGIN_BYTES {
                return Err("JetBrains 插件包解压后超过 512 MB 限制".to_string());
            }
            let destination = temporary.join(&enclosed);
            if !destination.starts_with(&temporary) {
                return Err("JetBrains 插件包包含不安全路径".to_string());
            }
            if entry.is_dir() {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
            } else {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                let mut output = File::create(&destination).map_err(|error| error.to_string())?;
                let remaining = MAX_JETBRAINS_PLUGIN_BYTES
                    .checked_sub(extracted_bytes)
                    .ok_or_else(|| "JetBrains 插件包解压后超过 512 MB 限制".to_string())?;
                let copied = io::copy(&mut entry.by_ref().take(remaining + 1), &mut output)
                    .map_err(|error| error.to_string())?;
                if copied > remaining {
                    return Err("JetBrains 插件包解压后超过 512 MB 限制".to_string());
                }
                extracted_bytes = extracted_bytes
                    .checked_add(copied)
                    .ok_or_else(|| "JetBrains 插件包大小溢出".to_string())?;
            }
        }
        top_level.ok_or_else(|| "JetBrains 插件包为空".to_string())
    })()?;
    let staged = temporary.join(&top_level);
    let staged_state = plugin_location_in_directory(&staged, identifier)
        .ok_or_else(|| "JetBrains 插件包中未找到目标插件元数据".to_string())?;
    let staged_version = staged_state
        .1
        .as_deref()
        .ok_or_else(|| "JetBrains 插件包未声明版本，无法验证安装内容".to_string())?;
    if staged_version != expected_version {
        return Err(format!(
            "JetBrains 插件包版本为 {staged_version}，预期版本为 {expected_version}"
        ));
    }

    let destination = plugin_root.join(&top_level);
    let mut existing = jetbrains_plugin_directories(plugin_root, identifier);
    if destination.exists()
        && !existing
            .iter()
            .any(|path| same_existing_path(path, &destination))
    {
        return Err(format!(
            "JetBrains 插件目标目录已被其他内容占用：{}",
            destination.display()
        ));
    }
    existing.sort();
    existing.dedup_by(|left, right| same_existing_path(left, right));

    let backup_root = staging_root.join(format!(".novel-library-backup-{}", uuid::Uuid::new_v4()));
    let mut backup_cleanup = RemoveDirectoryOnDrop::new(backup_root.clone());
    fs::create_dir_all(&backup_root)
        .map_err(|error| format!("无法创建 JetBrains 插件备份目录：{error}"))?;
    let mut backups = Vec::new();
    for (index, installed) in existing.iter().enumerate() {
        let backup = backup_root.join(format!("{index}"));
        if let Err(error) = fs::rename(installed, &backup) {
            let restore_error = restore_jetbrains_backups(&backups).err();
            if restore_error.is_some() {
                backup_cleanup.disarm();
            }
            let access_hint = if error.kind() == io::ErrorKind::PermissionDenied {
                "；插件文件可能正被 IDE 占用，请保存工作并完全关闭对应 JetBrains IDE 后重试"
            } else {
                ""
            };
            return Err(match restore_error {
                Some(restore_error) => format!(
                    "无法暂存已安装的 JetBrains 插件：{error}{access_hint}；{restore_error}；备份保留在 {}",
                    backup_root.display()
                ),
                None => format!(
                    "无法暂存已安装的 JetBrains 插件：{error}{access_hint}；现有插件未被改动"
                ),
            });
        }
        backups.push((installed.clone(), backup));
    }

    if let Err(error) = fs::rename(&staged, &destination) {
        let restore_error = restore_jetbrains_backups(&backups).err();
        if restore_error.is_some() {
            backup_cleanup.disarm();
        }
        return Err(match restore_error {
            Some(restore_error) => format!(
                "无法写入 JetBrains 插件目录：{error}；{restore_error}；备份保留在 {}",
                backup_root.display()
            ),
            None => format!("无法写入 JetBrains 插件目录：{error}"),
        });
    }
    drop(backup_cleanup);
    Ok(if backup_root.exists() {
        format!(
            "本地插件已部署，旧版本备份未能清理：{}；重启 IDE 后生效",
            backup_root.display()
        )
    } else {
        "本地插件已部署，重启 IDE 后生效".to_string()
    })
}

fn read_plugin_xml_from_jar(path: PathBuf) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("META-INF/plugin.xml").ok()?;
    let mut payload = String::new();
    entry.read_to_string(&mut payload).ok()?;
    Some(payload)
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
    // CLI-backed checks can each take a few seconds on Windows. Run the
    // independent IDE checks concurrently so one slow installation does not
    // hold up every other target in the integration page.
    std::thread::scope(|scope| {
        for target in targets.iter_mut() {
            let Some(plugin) = plugins.iter().find(|plugin| plugin.kind == target.kind) else {
                continue;
            };
            let identifier = plugin.identifier.clone();
            scope.spawn(move || {
                if target.kind == "vscode" {
                    let (installed, version) = vscode_extension_state(target, &identifier);
                    target.installed = installed;
                    target.installed_version = version;
                } else if target.kind == "jetbrains" {
                    let state = jetbrains_plugin_location(target, &identifier);
                    target.installed = state.is_some();
                    target.installed_version = state.and_then(|(_, version)| version);
                    target.can_uninstall = target.installed;
                }
            });
        }
    });
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

fn run_installer(target: &IdeTarget, plugin_path: &Path) -> Result<Output, String> {
    let executable = PathBuf::from(&target.path);
    if !executable.is_file() {
        return Err("目标 IDE 已被移动或删除，请重新检测".to_string());
    }
    let plugin_argument = plugin_path.display().to_string();
    let output = match target.kind.as_str() {
        "vscode" => vscode_script_process(
            target,
            &["--install-extension", plugin_argument.as_str(), "--force"],
        )?
        .output(),
        "visual-studio" => hidden_command(&executable)
            .arg("/quiet")
            .arg(plugin_path)
            .output(),
        _ => return Err("不支持的 IDE 类型".to_string()),
    }
    .map_err(|error| error.to_string())?;
    Ok(output)
}

pub fn install(app: &AppHandle, input: InstallIdePluginInput) -> Result<IdeInstallResult, String> {
    let (directory, plugin, target) =
        resolve_target_plugin(app, &input.target_id, &input.plugin_id)?;
    let plugin_path = directory.join(&plugin.file);
    if !plugin_path.is_file() {
        return Err(format!("桌面安装包未包含插件文件：{}", plugin.file));
    }
    if target.kind == "jetbrains" {
        if target_executable_is_running(&target) {
            if input.close_running_ide {
                close_target_ide_gracefully(&target)?;
            } else {
                return Err(jetbrains_running_error(&target));
            }
        }
        let message =
            install_jetbrains_plugin(&target, &plugin_path, &plugin.identifier, &plugin.version)?;
        let (verified, installed_version) = jetbrains_plugin_location(&target, &plugin.identifier)
            .map(|(_, version)| (true, version))
            .unwrap_or((false, None));
        if !verified {
            return Err("本地插件已部署，但复检未发现插件；请重启 IDE 后重试".to_string());
        }
        if !installed_version_matches(&plugin.version, &installed_version) {
            return Err(format!(
                "插件已发现，但版本为 {}，预期安装版本为 {}；请重试安装",
                installed_version.as_deref().unwrap_or("未知"),
                plugin.version
            ));
        }
        return Ok(IdeInstallResult {
            target: target.label,
            plugin: plugin.label,
            installed: true,
            verified,
            installed_version,
            message,
        });
    }
    let output = run_installer(&target, &plugin_path)?;
    let output_message = clean_installer_diagnostic(&target.kind, &output.stdout);
    let (verified, installed_version) = match target.kind.as_str() {
        "vscode" => vscode_extension_state(&target, &plugin.identifier),
        "jetbrains" => jetbrains_plugin_location(&target, &plugin.identifier)
            .map(|(_, version)| (true, version))
            .unwrap_or((false, None)),
        "visual-studio" => (true, None),
        _ => (false, None),
    };
    // A few JetBrains/JBR builds return non-zero with only the harmless CDS
    // warning on stderr. Accept that narrow case only after the expected
    // plugin is found; all real installer failures remain visible.
    let jetbrains_warning_only = target.kind == "jetbrains"
        && !output.status.success()
        && is_jetbrains_cds_warning_only(&output.stderr);
    let accepted = output.status.success() || (jetbrains_warning_only && verified);
    if !accepted {
        return Err(installer_failure(&target.kind, &output, "安装器"));
    }
    if !verified {
        return Err("安装命令已完成，但复检未发现插件；请重载或重启 IDE 后重试".to_string());
    }
    if target.kind == "vscode"
        && installed_version.is_some()
        && !installed_version_matches(&plugin.version, &installed_version)
    {
        return Err(format!(
            "插件已发现，但版本为 {}，预期安装版本为 {}；请重试安装",
            installed_version.as_deref().unwrap_or("未知"),
            plugin.version
        ));
    }
    Ok(IdeInstallResult {
        target: target.label,
        plugin: plugin.label,
        installed: true,
        verified,
        installed_version,
        message: if output_message.is_empty() {
            "安装命令已完成，重启 IDE 后生效".to_string()
        } else {
            output_message
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
        if target_executable_is_running(&target) {
            return Err(format!(
                "IDE_RUNNING: {} 正在运行，Windows 无法删除正在使用的插件文件。请保存工作并完全关闭该 IDE（包括后台进程），然后再次点击卸载；现有插件不会被改动。",
                target.label
            ));
        }
        let _mutation_guard = lock_jetbrains_plugin_mutation()?;
        let root = jetbrains_plugin_root(&target)?;
        let directories = jetbrains_plugin_directories(&root, &plugin.identifier);
        if directories.is_empty() {
            return Err("未找到已安装的 JetBrains 插件".to_string());
        }
        for directory in directories {
            fs::remove_dir_all(&directory)
                .map_err(|error| format!("无法卸载 JetBrains 插件：{error}"))?;
        }
        if jetbrains_plugin_location_in_root(&root, &plugin.identifier).is_some() {
            return Err("JetBrains 插件目录仍存在，请关闭 IDE 后重试卸载".to_string());
        }
        return Ok(IdeInstallResult {
            target: target.label,
            plugin: plugin.label,
            installed: false,
            verified: true,
            installed_version: None,
            message: "本地插件已卸载，重启 IDE 后生效".to_string(),
        });
    }
    if !target.can_uninstall {
        return Err("此 IDE 请在其内置插件管理器中卸载".to_string());
    }
    let output = vscode_script_process(
        &target,
        &["--uninstall-extension", plugin.identifier.as_str()],
    )?
    .output()
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(installer_failure("vscode", &output, "VS Code 卸载器"));
    }
    let (installed, _) = vscode_extension_state(&target, &plugin.identifier);
    if installed {
        return Err(if output.status.success() {
            "IDE 仍报告插件已安装，请关闭 IDE 后重试".to_string()
        } else {
            installer_failure("vscode", &output, "VS Code 卸载器")
        });
    }
    Ok(IdeInstallResult {
        target: target.label,
        plugin: plugin.label,
        installed: false,
        verified: true,
        installed_version: None,
        message: "已从 IDE 扩展清单移除；重载或重启 IDE 后，活动栏和扩展页面会同步消失".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        clean_installer_diagnostic, compare_versions, detect_targets, install_jetbrains_plugin_at,
        installed_version_matches, is_jetbrains_cds_warning_only,
        jetbrains_plugin_location_in_root, parse_vscode_extension_state, read_plugin_xml_from_jar,
        target_id, vscode_extension_state, vscode_script_process, xml_tag_value, IdeTarget,
        InstallIdePluginInput, JETBRAINS_CDS_WARNING,
    };
    use std::{
        collections::HashSet,
        fs::{self, File},
        io::{Cursor, Write},
        path::Path,
        time::Instant,
    };

    #[test]
    fn creates_stable_target_ids() {
        let first = target_id("vscode", Path::new("C:/Code/code.cmd"));
        let second = target_id("vscode", Path::new("C:/Code/code.cmd"));
        assert_eq!(first, second);
        assert_ne!(first, target_id("jetbrains", Path::new("C:/Code/code.cmd")));
    }

    #[test]
    fn defaults_to_manual_ide_close_and_accepts_an_explicit_graceful_close() {
        let manual: InstallIdePluginInput =
            serde_json::from_str(r#"{"targetId":"jetbrains-a","pluginId":"intellij"}"#)
                .expect("deserialize manual close input");
        assert!(!manual.close_running_ide);
        let automatic: InstallIdePluginInput = serde_json::from_str(
            r#"{"targetId":"jetbrains-a","pluginId":"intellij","closeRunningIde":true}"#,
        )
        .expect("deserialize automatic close input");
        assert!(automatic.close_running_ide);
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
    fn executes_detected_vscode_launchers_with_real_paths() {
        for target in detect_targets()
            .into_iter()
            .filter(|target| target.kind == "vscode")
        {
            let output = vscode_script_process(&target, &["--list-extensions"])
                .expect("official launcher command")
                .output()
                .expect("run official launcher command");
            assert!(
                output.status.success(),
                "{} launcher failed: {}",
                target.label,
                String::from_utf8_lossy(&output.stderr)
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
    fn deploys_local_jetbrains_zip_and_rejects_unsafe_paths() {
        let root =
            std::env::temp_dir().join(format!("novel-library-plugin-{}", uuid::Uuid::new_v4()));
        let plugin_root = root.join("plugins");
        fs::create_dir_all(&root).expect("create plugin fixture root");

        let mut inner = zip::ZipWriter::new(Cursor::new(Vec::new()));
        inner
            .start_file(
                "META-INF/plugin.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start plugin metadata");
        inner
            .write_all(
                b"<idea-plugin><id>com.kengqin.novellibrary.reader</id><version>0.4.5</version></idea-plugin>",
            )
            .expect("write plugin metadata");
        let inner_bytes = inner.finish().expect("finish plugin jar").into_inner();

        let archive_path = root.join("plugin.zip");
        let archive_file = File::create(&archive_path).expect("create plugin archive");
        let mut archive = zip::ZipWriter::new(archive_file);
        archive
            .add_directory(
                "novel-library-intellij/",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start plugin directory");
        archive
            .start_file(
                "novel-library-intellij/lib/plugin.jar",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start plugin jar");
        archive.write_all(&inner_bytes).expect("write plugin jar");
        archive.finish().expect("finish plugin archive");

        install_jetbrains_plugin_at(
            &plugin_root,
            &archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .expect("deploy local plugin");
        assert!(plugin_root
            .join("novel-library-intellij/lib/plugin.jar")
            .is_file());
        assert!(plugin_root.join("novel-library-intellij").is_dir());

        // A previous release may have used a different archive directory name.
        // Reinstalling must remove every copy with the same plugin ID, not just
        // the current stable directory name.
        let legacy = plugin_root.join("novel-library-intellij-legacy");
        fs::create_dir_all(legacy.join("lib")).expect("create legacy plugin directory");
        fs::copy(
            plugin_root.join("novel-library-intellij/lib/plugin.jar"),
            legacy.join("lib/plugin.jar"),
        )
        .expect("copy legacy plugin jar");
        install_jetbrains_plugin_at(
            &plugin_root,
            &archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .expect("replace legacy plugin");
        assert!(!legacy.exists());

        // Staging directories are outside the plugin root, and stale ones are
        // ignored if a previous process left one behind.
        let stale = plugin_root.join(".novel-library-install-stale");
        fs::create_dir_all(stale.join("lib")).expect("create stale staging directory");
        fs::copy(
            plugin_root.join("novel-library-intellij/lib/plugin.jar"),
            stale.join("lib/plugin.jar"),
        )
        .expect("copy stale plugin jar");
        let installed = plugin_root.join("novel-library-intellij");
        fs::remove_dir_all(&installed).expect("remove installed plugin for stale scan");
        assert!(
            jetbrains_plugin_location_in_root(&plugin_root, "com.kengqin.novellibrary.reader")
                .is_none()
        );
        install_jetbrains_plugin_at(
            &plugin_root,
            &archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .expect("install while stale staging exists");
        assert!(installed.is_dir());
        fs::remove_dir_all(&stale).expect("remove stale staging directory");

        let unsafe_archive_path = root.join("unsafe.zip");
        let unsafe_file = File::create(&unsafe_archive_path).expect("create unsafe archive");
        let mut unsafe_archive = zip::ZipWriter::new(unsafe_file);
        unsafe_archive
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .expect("start unsafe entry");
        unsafe_archive
            .write_all(b"must not be extracted")
            .expect("write unsafe entry");
        unsafe_archive.finish().expect("finish unsafe archive");
        assert!(install_jetbrains_plugin_at(
            &root.join("unsafe-plugins"),
            &unsafe_archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .is_err());
        assert!(!root.join("escape.txt").exists());

        let invalid_archive_path = root.join("invalid.zip");
        let invalid_file = File::create(&invalid_archive_path).expect("create invalid archive");
        let mut invalid_archive = zip::ZipWriter::new(invalid_file);
        invalid_archive
            .start_file(
                "novel-library-intellij/README.txt",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start invalid plugin file");
        invalid_archive
            .write_all(b"not a plugin")
            .expect("write invalid plugin file");
        invalid_archive.finish().expect("finish invalid archive");
        assert!(install_jetbrains_plugin_at(
            &root.join("invalid-plugins"),
            &invalid_archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .is_err());
        assert!(fs::read_dir(&root)
            .expect("read fixture root")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".novel-library-")));

        let missing_version_path = root.join("missing-version.zip");
        let missing_version_file =
            File::create(&missing_version_path).expect("create missing-version archive");
        let mut missing_version = zip::ZipWriter::new(missing_version_file);
        missing_version
            .start_file(
                "novel-library-intellij/META-INF/plugin.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("start missing-version metadata");
        missing_version
            .write_all(b"<idea-plugin><id>com.kengqin.novellibrary.reader</id></idea-plugin>")
            .expect("write missing-version metadata");
        missing_version
            .finish()
            .expect("finish missing-version archive");
        assert!(install_jetbrains_plugin_at(
            &plugin_root,
            &missing_version_path,
            "com.kengqin.novellibrary.reader",
            "0.4.5",
        )
        .is_err());
        assert!(plugin_root
            .join("novel-library-intellij/lib/plugin.jar")
            .is_file());

        fs::remove_dir_all(root).expect("remove plugin fixture root");
    }

    #[test]
    fn deploys_the_bundled_jetbrains_artifact_with_real_plugin_metadata() {
        let archive_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ide-plugins")
            .join("novel-library-intellij-0.4.7.zip");
        if !archive_path.is_file() {
            eprintln!(
                "skipping bundled JetBrains artifact check; release ZIP is not present: {}",
                archive_path.display()
            );
            return;
        }
        let root =
            std::env::temp_dir().join(format!("novel-library-real-{}", uuid::Uuid::new_v4()));
        let plugin_root = root.join("plugins");
        install_jetbrains_plugin_at(
            &plugin_root,
            &archive_path,
            "com.kengqin.novellibrary.reader",
            "0.4.7",
        )
        .expect("deploy bundled JetBrains plugin");
        assert!(plugin_root
            .join("novel-library-intellij/lib/novel-library-intellij-0.4.7.jar")
            .is_file());
        fs::remove_dir_all(root).expect("remove real plugin fixture");
    }

    #[test]
    fn compares_numeric_plugin_versions() {
        assert!(compare_versions("0.4.2", "0.4.1").is_gt());
        assert!(compare_versions("0.4.10", "0.4.2").is_gt());
        assert!(compare_versions("1.0", "1.0.0").is_eq());
    }

    #[test]
    fn filters_only_jetbrains_cds_warnings_from_diagnostics() {
        let warning = format!("{JETBRAINS_CDS_WARNING}\r\n{JETBRAINS_CDS_WARNING}\r\n");
        assert!(clean_installer_diagnostic("jetbrains", warning.as_bytes()).is_empty());
        assert_eq!(
            clean_installer_diagnostic("jetbrains", format!("{warning}real failure").as_bytes()),
            "real failure"
        );
        assert!(clean_installer_diagnostic("vscode", warning.as_bytes())
            .contains(JETBRAINS_CDS_WARNING));
        assert!(is_jetbrains_cds_warning_only(warning.as_bytes()));
        assert!(!is_jetbrains_cds_warning_only(b""));
        assert!(!is_jetbrains_cds_warning_only(
            format!("{warning}real failure").as_bytes()
        ));
    }

    #[test]
    fn verifies_installed_plugin_version_when_metadata_provides_one() {
        assert!(installed_version_matches(
            "0.4.5",
            &Some("0.4.5".to_string())
        ));
        assert!(!installed_version_matches(
            "0.4.5",
            &Some("0.4.4".to_string())
        ));
        assert!(!installed_version_matches("0.4.5", &None));
    }

    #[test]
    fn detects_only_existing_unique_ide_targets() {
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
        eprintln!(
            "detected {} IDE target(s) in {:?}",
            targets.len(),
            started.elapsed()
        );
    }

    #[test]
    fn vscode_and_cursor_installation_never_constructs_a_cli_js_file_argument() {
        let forbidden = concat!("cli", ".js");
        assert!(!include_str!("ide_integration.rs").contains(forbidden));
        let launcher =
            std::env::temp_dir().join(format!("novel-library-{}.cmd", uuid::Uuid::new_v4()));
        File::create(&launcher).expect("create launcher fixture");
        let target = IdeTarget {
            id: "vscode-test".to_string(),
            label: "Cursor".to_string(),
            kind: "vscode".to_string(),
            path: launcher.display().to_string(),
            installed: false,
            installed_version: None,
            can_uninstall: true,
        };
        let command =
            vscode_script_process(&target, &["--install-extension", "fixture.vsix", "--force"])
                .expect("official launcher command");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!args.join(" ").contains(forbidden));
        std::fs::remove_file(launcher).expect("remove launcher fixture");
    }
}
