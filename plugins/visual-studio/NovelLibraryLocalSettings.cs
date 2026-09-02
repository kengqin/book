using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Linq;
using System.Web.Script.Serialization;

namespace NovelLibrary.VisualStudio;

internal sealed class PendingProgressRecord
{
    internal string Key { get; set; }
    internal string Route { get; set; }
    internal string Body { get; set; }
}

internal static class NovelLibraryLocalSettings
{
    private sealed class SettingsPayload
    {
        public bool? UseDesktopLibrary { get; set; }
        public string LocalDataDirectory { get; set; }
        public string ProgressClientId { get; set; }
        public long? ProgressSequence { get; set; }
        public string LogLevel { get; set; }
        public bool? RetainManagedSource { get; set; }
        public Dictionary<string, PendingProgressPayload> PendingProgress { get; set; }
        public Dictionary<string, string> ProviderStorageIds { get; set; }
    }

    private sealed class PendingProgressPayload
    {
        public string Route { get; set; }
        public string Body { get; set; }
        public long SavedAt { get; set; }
    }

    private static readonly object Gate = new object();
    private static readonly string ProgressClientId = $"visual-studio-{Guid.NewGuid():N}";
    private static long ProgressSequence;
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "NovelLibrary",
        "visual-studio-settings.json");

    private static SettingsPayload Read()
    {
        lock (Gate)
        {
            try
            {
                if (File.Exists(SettingsPath))
                    return new JavaScriptSerializer().Deserialize<SettingsPayload>(File.ReadAllText(SettingsPath)) ?? new SettingsPayload();
            }
            catch
            {
                // Corrupt settings fall back to safe defaults.
            }
            return new SettingsPayload();
        }
    }

    private static void Write(SettingsPayload payload)
    {
        lock (Gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
            var temp = SettingsPath + ".tmp";
            File.WriteAllText(temp, new JavaScriptSerializer().Serialize(payload));
            if (File.Exists(SettingsPath)) File.Replace(temp, SettingsPath, null);
            else File.Move(temp, SettingsPath);
        }
    }

    internal static bool UseDesktopLibrary => Read().UseDesktopLibrary ?? true;

    internal static string DefaultLocalDataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "NovelLibrary",
        "local-data");

    internal static string LocalDataDirectory =>
        string.IsNullOrWhiteSpace(Read().LocalDataDirectory) ? DefaultLocalDataDirectory : Path.GetFullPath(Read().LocalDataDirectory);

    internal static string LocalDiscoveryPath => Path.Combine(LocalDataDirectory, "local-runtime.json");
    internal static string LogLevel => string.IsNullOrWhiteSpace(Read().LogLevel) ? "info" : Read().LogLevel;
    internal static bool RetainManagedSource => Read().RetainManagedSource ?? true;

    internal static string BeginMigration(string directory)
    {
        var root = Path.GetFullPath(directory);
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "migration.lock");
        if (File.Exists(path))
        {
            if (DateTime.UtcNow - File.GetLastWriteTimeUtc(path) < TimeSpan.FromMinutes(10))
                throw new InvalidOperationException("本地书库正在被其他客户端迁移");
            File.Delete(path);
        }
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(stream))
            writer.Write($"{Process.GetCurrentProcess().Id}:{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}");
        return path;
    }

    internal static void EndMigration(string path)
    {
        if (!string.IsNullOrWhiteSpace(path))
        {
            try { File.Delete(path); } catch { }
        }
    }

    internal static void SetUseDesktopLibrary(bool value)
    {
        var payload = Read();
        payload.UseDesktopLibrary = value;
        Write(payload);
    }

    internal static void SetLogLevel(string value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "info" : value.Trim().ToLowerInvariant();
        if (Array.IndexOf(new[] { "error", "warn", "info", "debug" }, normalized) < 0)
            throw new InvalidOperationException("日志级别必须是 error、warn、info 或 debug");
        var payload = Read();
        payload.LogLevel = normalized;
        Write(payload);
    }

    internal static void SetRetainManagedSource(bool value)
    {
        var payload = Read();
        payload.RetainManagedSource = value;
        Write(payload);
    }

    internal static (string ClientId, long Sequence) NextProgressIdentity()
    {
        return (ProgressClientId, System.Threading.Interlocked.Increment(ref ProgressSequence));
    }

    private static string LocalStorageLocator => Path.GetFullPath(LocalDataDirectory).ToLowerInvariant();

    private static string LegacyProgressProviderKey => UseDesktopLibrary ? "desktop" : "local:" + LocalStorageLocator;

    private static string TryReadDiscoveryStorageId()
    {
        try
        {
            if (!File.Exists(LocalDiscoveryPath)) return null;
            var discovery = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(LocalDiscoveryPath));
            return discovery != null && discovery.TryGetValue("storageId", out var value) ? value?.ToString() : null;
        }
        catch { return null; }
    }

    private static string ProgressProviderKey
    {
        get
        {
            var payload = Read();
            payload.ProviderStorageIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (UseDesktopLibrary)
                return "desktop:" + (payload.ProviderStorageIds.TryGetValue("desktop", out var desktopId) && !string.IsNullOrWhiteSpace(desktopId) ? desktopId : "unresolved");
            var storageId = TryReadDiscoveryStorageId();
            if (string.IsNullOrWhiteSpace(storageId)) payload.ProviderStorageIds.TryGetValue(LocalStorageLocator, out storageId);
            return "local:" + (string.IsNullOrWhiteSpace(storageId) ? "unresolved" : storageId);
        }
    }

    internal static void RememberProgressStorageId(string providerType, string storageId)
    {
        if (string.IsNullOrWhiteSpace(storageId)) return;
        var payload = Read();
        payload.ProviderStorageIds ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.Equals(providerType, "desktop", StringComparison.Ordinal)) payload.ProviderStorageIds["desktop"] = storageId;
        else if (string.Equals(providerType, "local", StringComparison.Ordinal)) payload.ProviderStorageIds[LocalStorageLocator] = storageId;
        else return;
        Write(payload);
    }

    internal static IReadOnlyList<PendingProgressRecord> GetPendingProgress()
    {
        var payload = Read();
        if (payload.PendingProgress == null) return Array.Empty<PendingProgressRecord>();
        var prefix = ProgressProviderKey + "::";
        var legacyKey = LegacyProgressProviderKey;
        return payload.PendingProgress
            .Where(item => (item.Key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(item.Key, legacyKey, StringComparison.OrdinalIgnoreCase)) &&
                !string.IsNullOrWhiteSpace(item.Value?.Route) && !string.IsNullOrWhiteSpace(item.Value?.Body))
            .Select(item => new PendingProgressRecord { Key = item.Key, Route = item.Value.Route, Body = item.Value.Body })
            .ToArray();
    }

    internal static void SavePendingProgress(string bookId, string route, string body)
    {
        var payload = Read();
        payload.PendingProgress ??= new Dictionary<string, PendingProgressPayload>(StringComparer.OrdinalIgnoreCase);
        payload.PendingProgress[$"{ProgressProviderKey}::{bookId}"] = new PendingProgressPayload
        {
            Route = route,
            Body = body,
            SavedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };
        payload.PendingProgress = payload.PendingProgress
            .OrderByDescending(item => item.Value?.SavedAt ?? 0L)
            .Take(100)
            .ToDictionary(item => item.Key, item => item.Value, StringComparer.OrdinalIgnoreCase);
        Write(payload);
    }

    internal static void ClearPendingProgress(string key)
    {
        var payload = Read();
        if (payload.PendingProgress == null || !payload.PendingProgress.Remove(key)) return;
        Write(payload);
    }

    internal static void ClearPendingProgressForBook(string bookId)
    {
        var payload = Read();
        if (payload.PendingProgress == null) return;
        var changed = payload.PendingProgress.Remove($"{ProgressProviderKey}::{bookId}");
        changed |= payload.PendingProgress.Remove(LegacyProgressProviderKey);
        if (!changed) return;
        Write(payload);
    }

    internal static string SetLocalDataDirectory(string directory, string copyFrom)
    {
        var target = Path.GetFullPath(directory);
        var source = string.IsNullOrWhiteSpace(copyFrom) ? null : Path.GetFullPath(copyFrom);
        if (source != null && !string.Equals(source, target, StringComparison.OrdinalIgnoreCase) && (
            target.StartsWith(source + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            source.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("本地书库目录不能是源目录或其子目录");
        Directory.CreateDirectory(target);
        if (source != null && File.Exists(Path.Combine(source, "library.db")) &&
            !File.Exists(Path.Combine(target, "library.db")))
        {
            CopyDirectory(source, target);
        }
        var payload = Read();
        payload.LocalDataDirectory = target;
        payload.UseDesktopLibrary = false;
        Write(payload);
        return target;
    }

    private static void CopyDirectory(string source, string target)
    {
        source = Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        target = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var ignored = new[] { "runtime.lock", "migration.lock", "local-runtime.json", "local-runtime.json.tmp" };
        foreach (var directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(target + directory.Substring(source.Length));
        foreach (var file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            if (Array.IndexOf(ignored, Path.GetFileName(file)) >= 0) continue;
            var destination = target + file.Substring(source.Length);
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.Copy(file, destination, false);
        }
    }
}
