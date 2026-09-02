using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Security.Cryptography;

namespace NovelLibrary.VisualStudio;

internal sealed class BridgeRequestException : InvalidOperationException
{
    internal BridgeRequestException(string code, string message) : base(message) => Code = code;
    internal string Code { get; }
}

internal sealed class NovelLibraryBridge
{
    private const int ClientProtocolVersion = 2;
    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
    private static string InstalledBridgePath;
    private static Process LocalRuntimeProcess;
    private static string ValidatedLocalKey;
    private static string ValidatedDesktopKey;

    internal static void StopLocalRuntime()
    {
        if (LocalRuntimeProcess != null && !LocalRuntimeProcess.HasExited)
        {
            try
            {
                LocalRuntimeProcess.Kill();
                LocalRuntimeProcess.WaitForExit(2000);
            }
            catch { }
        }
        LocalRuntimeProcess = null;
        ValidatedLocalKey = null;
    }

    internal static async Task ShutdownLocalRuntimeAsync()
    {
        try
        {
            var config = ReadDiscovery(NovelLibraryLocalSettings.LocalDiscoveryPath);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{config.Port}/v2/runtime/restart");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            for (var attempt = 0; attempt < 40 && File.Exists(NovelLibraryLocalSettings.LocalDiscoveryPath); attempt++)
                await Task.Delay(50).ConfigureAwait(false);
        }
        catch
        {
            // Fall back to terminating only the process started by this Visual Studio process.
        }
        StopLocalRuntime();
        try
        {
            var active = ReadDiscovery(NovelLibraryLocalSettings.LocalDiscoveryPath);
            if (await ValidateLocalRuntimeAsync(active).ConfigureAwait(false))
                throw new InvalidOperationException("本地 Runtime 仍在运行，无法安全迁移数据目录");
        }
        catch (InvalidOperationException error) when (error.Message.Contains("仍在运行")) { throw; }
        catch { }
    }

    private sealed class BridgeConfig
    {
        public int Port { get; set; }
        public string Token { get; set; } = "";
        public string StorageId { get; set; }
        public string SessionId { get; set; }
    }

    private sealed class ManifestConfig
    {
        public string ProviderType { get; set; }
        public string StorageId { get; set; }
        public int ProtocolVersion { get; set; }
        public int MinimumClientProtocolVersion { get; set; }
        public string[] Capabilities { get; set; }
        public string SessionId { get; set; }
    }

    private sealed class RuntimeStatus
    {
        public string DataDirectory { get; set; }
        public string StorageId { get; set; }
        public int ProtocolVersion { get; set; }
    }

    private sealed class RuntimePayloadManifest
    {
        public string RuntimeVersion { get; set; }
        public int ProtocolVersion { get; set; }
        public int MinimumProtocolVersion { get; set; }
        public RuntimePayloadArtifact[] Artifacts { get; set; }
    }

    private sealed class RuntimePayloadArtifact
    {
        public string Platform { get; set; }
        public string Arch { get; set; }
        public string Sha256 { get; set; }
    }

    private sealed class RuntimeActiveConfig
    {
        public int SchemaVersion { get; set; }
        public string RuntimeVersion { get; set; }
        public int ProtocolVersion { get; set; }
        public int MinimumClientProtocolVersion { get; set; }
        public string Executable { get; set; }
        public string Sha256 { get; set; }
        public string PreviousVersion { get; set; }
        public long UpdatedAt { get; set; }
    }

    private sealed class VerifiedRuntimePayload
    {
        public RuntimePayloadManifest Manifest { get; set; }
        public string Hash { get; set; }
        public string ManifestPath { get; set; }
        public string SidecarPath { get; set; }
    }

    private sealed class ImportJobConfig
    {
        public string Id { get; set; }
        public string State { get; set; }
        public string Message { get; set; }
    }

    private static JavaScriptSerializer CreateSerializer() => new JavaScriptSerializer
    {
        MaxJsonLength = int.MaxValue,
        RecursionLimit = 64
    };

    private static async Task<BridgeConfig> ReadConfigAsync(CancellationToken cancellationToken)
    {
        if (!NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            await EnsureLocalRuntimeAsync(cancellationToken).ConfigureAwait(false);
            return ReadDiscovery(NovelLibraryLocalSettings.LocalDiscoveryPath);
        }
        var root = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var legacyDirectory = Path.Combine(root, "NovelLibrary");
        var legacyBridge = Path.Combine(legacyDirectory, "bridge.json");
        var bridgePath = FindInstalledBridge() ?? legacyBridge;
        var payload = File.ReadAllText(bridgePath);
        var config = CreateSerializer().Deserialize<BridgeConfig>(payload)
            ?? throw new InvalidOperationException("Bridge config was empty");
        if (config.Port <= 0 || string.IsNullOrWhiteSpace(config.Token))
            throw new InvalidOperationException("Bridge config is invalid");
        if (!await ValidateDesktopBridgeAsync(config, cancellationToken).ConfigureAwait(false))
            throw new InvalidOperationException("桌面端 Bridge 协议不兼容或会话已失效，请更新桌面端后重试");
        return config;
    }

    private static async Task<bool> ValidateDesktopBridgeAsync(
        BridgeConfig config,
        CancellationToken cancellationToken = default)
    {
        var key = $"{config.Port}:{config.SessionId ?? ""}:{config.StorageId ?? ""}:{config.Token}";
        if (string.Equals(ValidatedDesktopKey, key, StringComparison.Ordinal)) return true;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{config.Port}/v1/manifest");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return false;
            var manifest = CreateSerializer().Deserialize<ManifestConfig>(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            var required = new[] { "books", "chapters", "progress" };
            var valid = manifest != null &&
                (string.IsNullOrWhiteSpace(manifest.ProviderType) || string.Equals(manifest.ProviderType, "desktop", StringComparison.Ordinal)) &&
                manifest.ProtocolVersion >= 1 && manifest.MinimumClientProtocolVersion <= ClientProtocolVersion &&
                manifest.Capabilities != null && !Array.Exists(required, capability => Array.IndexOf(manifest.Capabilities, capability) < 0) &&
                (string.IsNullOrWhiteSpace(config.StorageId) || string.IsNullOrWhiteSpace(manifest.StorageId) ||
                    string.Equals(config.StorageId, manifest.StorageId, StringComparison.Ordinal)) &&
                (string.IsNullOrWhiteSpace(config.SessionId) || string.IsNullOrWhiteSpace(manifest.SessionId) ||
                    string.Equals(config.SessionId, manifest.SessionId, StringComparison.Ordinal));
            if (valid)
            {
                ValidatedDesktopKey = key;
                NovelLibraryLocalSettings.RememberProgressStorageId("desktop", manifest.StorageId ?? config.StorageId);
            }
            return valid;
        }
        catch
        {
            return false;
        }
    }

    private static BridgeConfig ReadDiscovery(string path)
    {
        var payload = File.ReadAllText(path);
        var config = CreateSerializer().Deserialize<BridgeConfig>(payload)
            ?? throw new InvalidOperationException("Runtime discovery was empty");
        if (config.Port <= 0 || string.IsNullOrWhiteSpace(config.Token))
            throw new InvalidOperationException("Runtime discovery is invalid");
        return config;
    }

    private static async Task EnsureLocalRuntimeAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(NovelLibraryLocalSettings.LocalDataDirectory);
        if (await TryReadLocalDiscoveryAsync(cancellationToken).ConfigureAwait(false)) return;
        if (File.Exists(NovelLibraryLocalSettings.LocalDiscoveryPath))
        {
            BridgeConfig existing = null;
            try { existing = ReadDiscovery(NovelLibraryLocalSettings.LocalDiscoveryPath); } catch { }
            if (existing != null && await LocalRuntimeRequiresNewerClientAsync(existing, cancellationToken).ConfigureAwait(false))
                throw new InvalidOperationException("本地 Runtime 需要更新版插件，当前插件不会覆盖或终止它");
            await ShutdownLocalRuntimeAsync().ConfigureAwait(false);
        }
        try { File.Delete(NovelLibraryLocalSettings.LocalDiscoveryPath); } catch { }
        StopLocalRuntime();
        if (LocalRuntimeProcess == null || LocalRuntimeProcess.HasExited)
        {
            var executable = ResolveLocalRuntime();
            LocalRuntimeProcess = Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = $"serve --data-dir \"{NovelLibraryLocalSettings.LocalDataDirectory}\" --port 0 --log-level {NovelLibraryLocalSettings.LogLevel}",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(executable)
            });
        }
        for (var attempt = 0; attempt < 30; attempt++)
        {
            if (await TryReadLocalDiscoveryAsync(cancellationToken).ConfigureAwait(false)) return;
            await Task.Delay(100, cancellationToken).ConfigureAwait(false);
        }
        throw new InvalidOperationException($"本地书库 Runtime 启动超时：{NovelLibraryLocalSettings.LocalDataDirectory}");
    }

    private static async Task<bool> TryReadLocalDiscoveryAsync(CancellationToken cancellationToken)
    {
        try
        {
            var config = ReadDiscovery(NovelLibraryLocalSettings.LocalDiscoveryPath);
            var key = $"{config.Port}:{config.Token}:{config.StorageId ?? ""}:{Path.GetFullPath(NovelLibraryLocalSettings.LocalDataDirectory)}";
            if (string.Equals(ValidatedLocalKey, key, StringComparison.Ordinal)) return true;
            var valid = await ValidateLocalRuntimeAsync(config, cancellationToken).ConfigureAwait(false);
            if (valid) ValidatedLocalKey = key;
            return valid;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> ValidateLocalRuntimeAsync(
        BridgeConfig config,
        CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        using var manifestRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{config.Port}/v2/manifest");
        manifestRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        using var manifestResponse = await Http.SendAsync(manifestRequest, timeout.Token).ConfigureAwait(false);
        if (!manifestResponse.IsSuccessStatusCode) return false;
        var manifest = CreateSerializer().Deserialize<ManifestConfig>(await manifestResponse.Content.ReadAsStringAsync().ConfigureAwait(false));
        if (manifest == null || !string.Equals(manifest.ProviderType, "local", StringComparison.Ordinal) ||
            manifest.ProtocolVersion < ClientProtocolVersion || manifest.MinimumClientProtocolVersion > ClientProtocolVersion ||
            string.IsNullOrWhiteSpace(manifest.StorageId) || !string.Equals(config.StorageId, manifest.StorageId, StringComparison.Ordinal)) return false;
        var required = new[] { "books.read", "chapters.read", "progress.v2", "import.jobs", "import.idempotency", "backup.transfer", "runtime.diagnostics", "runtime.check-database", "epub.structure.v2" };
        if (manifest.Capabilities == null || Array.Exists(required, capability => Array.IndexOf(manifest.Capabilities, capability) < 0)) return false;

        using var statusRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{config.Port}/v2/runtime/status");
        statusRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        using var statusResponse = await Http.SendAsync(statusRequest, timeout.Token).ConfigureAwait(false);
        if (!statusResponse.IsSuccessStatusCode) return false;
        var status = CreateSerializer().Deserialize<RuntimeStatus>(await statusResponse.Content.ReadAsStringAsync().ConfigureAwait(false));
        var valid = status != null && !string.IsNullOrWhiteSpace(status.DataDirectory) &&
            status.ProtocolVersion == manifest.ProtocolVersion && string.Equals(status.StorageId, manifest.StorageId, StringComparison.Ordinal) &&
            string.Equals(Path.GetFullPath(status.DataDirectory), Path.GetFullPath(NovelLibraryLocalSettings.LocalDataDirectory), StringComparison.OrdinalIgnoreCase);
        if (valid) NovelLibraryLocalSettings.RememberProgressStorageId("local", manifest.StorageId);
        return valid;
    }

    private static async Task<bool> LocalRuntimeRequiresNewerClientAsync(BridgeConfig config, CancellationToken cancellationToken)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{config.Port}/v2/manifest");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return false;
            var manifest = CreateSerializer().Deserialize<ManifestConfig>(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            return manifest != null && manifest.MinimumClientProtocolVersion > ClientProtocolVersion;
        }
        catch { return false; }
    }

    private static string ResolveLocalRuntime()
    {
        var configured = Environment.GetEnvironmentVariable("NOVEL_LIBRARY_RUNTIME");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!File.Exists(configured)) throw new InvalidOperationException("配置的本地 Runtime 不存在");
            return configured;
        }
        var extensionRoot = Path.GetDirectoryName(typeof(NovelLibraryBridge).Assembly.Location);
        var bundled = Path.Combine(extensionRoot, "runtime", "win32-x64", "novel-library-runtime.exe");
        if (!File.Exists(bundled)) throw new InvalidOperationException("插件内 Runtime 缺失，请重新安装插件");
        var verified = VerifyBundledRuntime(extensionRoot, bundled);
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NovelLibrary", "runtime");
        string installLock = null;
        try
        {
            installLock = AcquireRuntimeInstallLock(root);
            var active = ReadActiveRuntime(root);
            if (active != null && CompareRuntimeVersions(active.RuntimeVersion, verified.Manifest.RuntimeVersion) > 0)
            {
                if (IsRuntimeCompatible(active)) return active.Executable;
                throw new InvalidOperationException("已安装的共享 Runtime 需要更新版插件，当前插件不会覆盖或终止它");
            }
            var versionDirectory = Path.Combine(root, "versions", verified.Manifest.RuntimeVersion);
            var target = Path.Combine(versionDirectory, "novel-library-runtime.exe");
            if (!ValidateRuntimeExecutable(target, verified.Manifest.RuntimeVersion, verified.Hash))
            {
                Directory.CreateDirectory(Path.Combine(root, "versions"));
                var temporaryDirectory = Path.Combine(root, "versions", $".{verified.Manifest.RuntimeVersion}.{Process.GetCurrentProcess().Id}.{Guid.NewGuid():N}.tmp");
                Directory.CreateDirectory(temporaryDirectory);
                var temporaryRuntime = Path.Combine(temporaryDirectory, "novel-library-runtime.exe");
                File.Copy(bundled, temporaryRuntime, false);
                File.Copy(verified.SidecarPath, temporaryRuntime + ".sha256", false);
                File.Copy(verified.ManifestPath, Path.Combine(temporaryDirectory, "runtime-manifest.json"), false);
                if (!ValidateRuntimeExecutable(temporaryRuntime, verified.Manifest.RuntimeVersion, verified.Hash))
                    throw new InvalidOperationException("共享 Runtime 临时制品校验失败");
                if (Directory.Exists(versionDirectory))
                    Directory.Move(versionDirectory, versionDirectory + $".invalid.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
                Directory.Move(temporaryDirectory, versionDirectory);
            }
            WriteActiveRuntime(root, new RuntimeActiveConfig
            {
                SchemaVersion = 1,
                RuntimeVersion = verified.Manifest.RuntimeVersion,
                ProtocolVersion = verified.Manifest.ProtocolVersion,
                MinimumClientProtocolVersion = verified.Manifest.MinimumProtocolVersion,
                Executable = Path.GetFullPath(target),
                Sha256 = verified.Hash,
                PreviousVersion = active != null && !string.Equals(active.RuntimeVersion, verified.Manifest.RuntimeVersion, StringComparison.Ordinal)
                    ? active.RuntimeVersion : active?.PreviousVersion,
                UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
            return target;
        }
        catch
        {
            var fallback = ReadActiveRuntime(root);
            if (fallback != null && IsRuntimeCompatible(fallback)) return fallback.Executable;
            throw;
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(installLock)) { try { File.Delete(installLock); } catch { } }
        }
    }

    private static string RuntimeHash(string executable)
    {
        using var stream = File.OpenRead(executable);
        using var sha = SHA256.Create();
        return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static string ReportedRuntimeVersion(string executable)
    {
        try
        {
            using var version = Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = "version",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            });
            if (version == null || !version.WaitForExit(3000))
            {
                try { version?.Kill(); } catch { }
                return null;
            }
            return version.ExitCode == 0 ? version.StandardOutput.ReadToEnd().Trim() : null;
        }
        catch { return null; }
    }

    private static bool ValidateRuntimeExecutable(string executable, string expectedVersion, string expectedHash)
    {
        try
        {
            return File.Exists(executable) && string.Equals(RuntimeHash(executable), expectedHash, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(ReportedRuntimeVersion(executable), expectedVersion, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static int CompareRuntimeVersions(string left, string right)
    {
        Version Parse(string value)
        {
            var core = (value ?? "0.0.0").Split('-', '+')[0];
            return Version.TryParse(core, out var parsed) ? parsed : new Version(0, 0, 0);
        }
        return Parse(left).CompareTo(Parse(right));
    }

    private static bool IsRuntimeCompatible(RuntimeActiveConfig runtime) =>
        runtime.ProtocolVersion >= ClientProtocolVersion &&
        (runtime.MinimumClientProtocolVersion <= 0 ? 1 : runtime.MinimumClientProtocolVersion) <= ClientProtocolVersion;

    private static RuntimeActiveConfig ReadActiveRuntime(string root)
    {
        try
        {
            var active = CreateSerializer().Deserialize<RuntimeActiveConfig>(File.ReadAllText(Path.Combine(root, "active.json")));
            if (active == null || string.IsNullOrWhiteSpace(active.RuntimeVersion) || string.IsNullOrWhiteSpace(active.Sha256)) return null;
            var expected = Path.GetFullPath(Path.Combine(root, "versions", active.RuntimeVersion, "novel-library-runtime.exe"));
            if (!string.Equals(Path.GetFullPath(active.Executable ?? ""), expected, StringComparison.OrdinalIgnoreCase) ||
                !ValidateRuntimeExecutable(expected, active.RuntimeVersion, active.Sha256)) return null;
            active.Executable = expected;
            return active;
        }
        catch { return null; }
    }

    private static string AcquireRuntimeInstallLock(string root)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "install.lock");
        for (var attempt = 0; attempt < 100; attempt++)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var writer = new StreamWriter(stream);
                writer.Write($"{Process.GetCurrentProcess().Id}:{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
                return path;
            }
            catch (IOException)
            {
                try
                {
                    if (DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > TimeSpan.FromMinutes(2)) File.Delete(path);
                }
                catch { }
                Thread.Sleep(50);
            }
        }
        throw new InvalidOperationException("等待共享 Runtime 安装锁超时");
    }

    private static void WriteActiveRuntime(string root, RuntimeActiveConfig active)
    {
        var target = Path.Combine(root, "active.json");
        var temporary = target + $".{Process.GetCurrentProcess().Id}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, CreateSerializer().Serialize(active));
        if (File.Exists(target)) File.Replace(temporary, target, null);
        else File.Move(temporary, target);
    }

    private static VerifiedRuntimePayload VerifyBundledRuntime(string extensionRoot, string executable)
    {
        var manifestPath = Path.Combine(extensionRoot, "runtime-manifest.json");
        var sidecarPath = executable + ".sha256";
        if (!File.Exists(manifestPath) || !File.Exists(sidecarPath))
            throw new InvalidOperationException("插件内 Runtime 缺少完整性清单");
        var manifest = CreateSerializer().Deserialize<RuntimePayloadManifest>(File.ReadAllText(manifestPath));
        var artifact = manifest?.Artifacts == null ? null : Array.Find(manifest.Artifacts,
            item => string.Equals(item.Platform, "win32", StringComparison.OrdinalIgnoreCase) && string.Equals(item.Arch, "x64", StringComparison.OrdinalIgnoreCase));
        var hash = RuntimeHash(executable);
        var sidecarHash = File.ReadAllText(sidecarPath).Trim().Split((char[])null, StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
        if (artifact == null || manifest.ProtocolVersion < ClientProtocolVersion ||
            manifest.MinimumProtocolVersion > ClientProtocolVersion || manifest.MinimumProtocolVersion > manifest.ProtocolVersion ||
            !string.Equals(artifact.Sha256, hash, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(sidecarHash, hash, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(manifest.RuntimeVersion, ReportedRuntimeVersion(executable), StringComparison.Ordinal))
            throw new InvalidOperationException("插件内 Runtime 完整性或版本校验失败");
        return new VerifiedRuntimePayload { Manifest = manifest, Hash = hash, ManifestPath = manifestPath, SidecarPath = sidecarPath };
    }

    private static string FindInstalledBridge()
    {
        if (!string.IsNullOrWhiteSpace(InstalledBridgePath) && File.Exists(InstalledBridgePath))
            return InstalledBridgePath;
        foreach (var processName in new[] { "novel-library-desktop", "NovelLibrary" })
        {
            foreach (var process in Process.GetProcessesByName(processName))
            {
                try
                {
                    var executable = process.MainModule?.FileName;
                    if (!string.IsNullOrWhiteSpace(executable))
                    {
                        var candidate = Path.Combine(Path.GetDirectoryName(executable)!, "bridge.json");
                        if (File.Exists(candidate))
                        {
                            InstalledBridgePath = candidate;
                            return candidate;
                        }
                    }
                }
                catch
                {
                    // Process path access can be denied; continue with the other candidates.
                }
                finally
                {
                    process.Dispose();
                }
            }
        }
        return null;
    }

    public async Task<T> GetAsync<T>(string route, CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync(HttpMethod.Get, route, null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        return CreateSerializer().Deserialize<T>(payload)
            ?? throw new InvalidOperationException("Bridge response was empty");
    }

    public async Task PostAsync(string route, object body, CancellationToken cancellationToken = default)
    {
        using var content = new StringContent(CreateSerializer().Serialize(body), Encoding.UTF8, "application/json");
        using var response = await SendAsync(HttpMethod.Post, route, content, cancellationToken).ConfigureAwait(false);
    }

    public async Task ReplayPendingProgressAsync(CancellationToken cancellationToken = default)
    {
        foreach (var pending in NovelLibraryLocalSettings.GetPendingProgress())
        {
            try
            {
                using var content = new StringContent(pending.Body, Encoding.UTF8, "application/json");
                using var response = await SendAsync(HttpMethod.Post, pending.Route, content, cancellationToken).ConfigureAwait(false);
                NovelLibraryLocalSettings.ClearPendingProgress(pending.Key);
            }
            catch (BridgeRequestException error) when (string.Equals(error.Code, "PROGRESS_CONFLICT", StringComparison.Ordinal))
            {
                NovelLibraryLocalSettings.ClearPendingProgress(pending.Key);
            }
            catch
            {
                // Keep the storage- and book-scoped record for the next successful connection.
            }
        }
    }

    public async Task<T> PostForResultAsync<T>(string route, object body, CancellationToken cancellationToken = default)
    {
        using var content = new StringContent(CreateSerializer().Serialize(body), Encoding.UTF8, "application/json");
        using var response = await SendAsync(HttpMethod.Post, route, content, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        return CreateSerializer().Deserialize<T>(payload)
            ?? throw new InvalidOperationException("Bridge response was empty");
    }

    public async Task ImportFileAsync(string path, CancellationToken cancellationToken = default)
    {
        ImportJobConfig queued;
        using (var content = new StringContent(CreateSerializer().Serialize(new { path, retainSource = NovelLibraryLocalSettings.RetainManagedSource, idempotencyKey = $"visual-studio-{Guid.NewGuid()}" }), Encoding.UTF8, "application/json"))
        using (var response = await SendAsync(HttpMethod.Post, "/v2/import-jobs", content, cancellationToken).ConfigureAwait(false))
        {
            queued = CreateSerializer().Deserialize<ImportJobConfig>(await response.Content.ReadAsStringAsync().ConfigureAwait(false))
                ?? throw new InvalidOperationException("导入任务响应为空");
        }
        if (string.IsNullOrWhiteSpace(queued.Id)) throw new InvalidOperationException("导入任务编号缺失");
        await WaitForImportJobAsync(queued.Id, cancellationToken).ConfigureAwait(false);
    }

    private async Task WaitForImportJobAsync(string jobId, CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 1500; attempt++)
        {
            var job = await GetAsync<ImportJobConfig>($"/v2/import-jobs/{Uri.EscapeDataString(jobId)}", cancellationToken).ConfigureAwait(false);
            if (string.Equals(job.State, "completed", StringComparison.Ordinal)) return;
            if (string.Equals(job.State, "failed", StringComparison.Ordinal) || string.Equals(job.State, "cancelled", StringComparison.Ordinal))
                throw new InvalidOperationException(string.IsNullOrWhiteSpace(job.Message) ? "导入失败" : job.Message);
            await Task.Delay(200, cancellationToken).ConfigureAwait(false);
        }
        throw new TimeoutException("导入任务等待超时");
    }

    public async Task DeleteBookAsync(string bookId, CancellationToken cancellationToken = default)
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary) throw new InvalidOperationException("删除书籍仅适用于本地书库");
        using var response = await SendAsync(HttpMethod.Delete, $"/v2/books/{Uri.EscapeDataString(bookId)}", null, cancellationToken).ConfigureAwait(false);
    }

    public async Task ReparseBookAsync(string bookId, CancellationToken cancellationToken = default)
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary) throw new InvalidOperationException("重新解析仅适用于本地书库");
        ImportJobConfig queued;
        using (var content = new StringContent("{}", Encoding.UTF8, "application/json"))
        using (var response = await SendAsync(HttpMethod.Post, $"/v2/books/{Uri.EscapeDataString(bookId)}/reparse", content, cancellationToken).ConfigureAwait(false))
        {
            queued = CreateSerializer().Deserialize<ImportJobConfig>(await response.Content.ReadAsStringAsync().ConfigureAwait(false))
                ?? throw new InvalidOperationException("重新解析任务响应为空");
        }
        if (string.IsNullOrWhiteSpace(queued.Id)) throw new InvalidOperationException("重新解析任务编号缺失");
        await WaitForImportJobAsync(queued.Id, cancellationToken).ConfigureAwait(false);
    }

    public async Task ExportLibraryAsync(string path, CancellationToken cancellationToken = default) =>
        await PostAsync("/v2/transfers/export", new { path }, cancellationToken).ConfigureAwait(false);

    public async Task ImportLibraryAsync(string path, string strategy, CancellationToken cancellationToken = default) =>
        await PostAsync("/v2/transfers/import", new { path, strategy }, cancellationToken).ConfigureAwait(false);

    public async Task<string> GetDiagnosticsAsync(CancellationToken cancellationToken = default)
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary) throw new InvalidOperationException("Runtime 诊断仅适用于本地书库");
        using var response = await SendAsync(HttpMethod.Get, "/v2/runtime/diagnostics", null, cancellationToken).ConfigureAwait(false);
        return await response.Content.ReadAsStringAsync().ConfigureAwait(false);
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string route,
        HttpContent content,
        CancellationToken cancellationToken)
    {
        var config = await ReadConfigAsync(cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{config.Port}{route}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        request.Headers.ConnectionClose = true;
        request.Content = content;
        var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var payload = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            string detail = null;
            string code = null;
            try
            {
                var root = CreateSerializer().DeserializeObject(payload) as Dictionary<string, object>;
                if (root != null && root.TryGetValue("error", out var error))
                {
                    if (error is Dictionary<string, object> structured)
                    {
                        if (structured.TryGetValue("message", out var message)) detail = message?.ToString();
                        if (structured.TryGetValue("code", out var errorCode)) code = errorCode?.ToString();
                    }
                    else detail = error?.ToString();
                }
            }
            catch { }
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new BridgeRequestException(code, string.IsNullOrWhiteSpace(detail) ? $"Bridge 请求失败：HTTP {status}" : detail);
        }
        return response;
    }
}
