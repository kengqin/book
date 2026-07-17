using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Diagnostics;

namespace NovelLibrary.VisualStudio;

internal sealed class NovelLibraryBridge
{
    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
    private static string InstalledBridgePath;

    private sealed class BridgeConfig
    {
        public int Port { get; set; }
        public string Token { get; set; } = "";
    }

    private static JavaScriptSerializer CreateSerializer() => new JavaScriptSerializer
    {
        MaxJsonLength = int.MaxValue,
        RecursionLimit = 64
    };

    private static (int Port, string Token) ReadConfig()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var legacyDirectory = Path.Combine(root, "NovelLibrary");
        var legacyBridge = Path.Combine(legacyDirectory, "bridge.json");
        var bridgePath = FindInstalledBridge() ?? legacyBridge;
        var payload = File.ReadAllText(bridgePath);
        var config = CreateSerializer().Deserialize<BridgeConfig>(payload)
            ?? throw new InvalidOperationException("Bridge config was empty");
        if (config.Port <= 0 || string.IsNullOrWhiteSpace(config.Token))
            throw new InvalidOperationException("Bridge config is invalid");
        return (config.Port, config.Token);
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

    private static async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string route,
        HttpContent content,
        CancellationToken cancellationToken)
    {
        var config = ReadConfig();
        using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{config.Port}{route}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.Token);
        request.Headers.ConnectionClose = true;
        request.Content = content;
        var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return response;
    }
}
