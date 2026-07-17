using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace NovelLibrary.VisualStudio;

internal sealed class NovelLibraryBridge
{
    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };

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
        var payload = File.ReadAllText(Path.Combine(root, "NovelLibrary", "bridge.json"));
        var config = CreateSerializer().Deserialize<BridgeConfig>(payload)
            ?? throw new InvalidOperationException("Bridge config was empty");
        if (config.Port <= 0 || string.IsNullOrWhiteSpace(config.Token))
            throw new InvalidOperationException("Bridge config is invalid");
        return (config.Port, config.Token);
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
