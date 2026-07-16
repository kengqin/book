using System;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace NovelLibrary.VisualStudio;

public sealed class NovelLibraryBridge
{
    private readonly HttpClient _http = new();
    private (int Port, string Token) ReadConfig()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "NovelLibrary", "bridge.json")));
        var value = document.RootElement;
        return (value.GetProperty("port").GetInt32(), value.GetProperty("token").GetString() ?? throw new InvalidOperationException("Bridge token missing"));
    }

    public async Task<string> GetAsync(string route)
    {
        var config = ReadConfig();
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{config.Port}{route}");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", config.Token);
        return await (await _http.SendAsync(request)).Content.ReadAsStringAsync();
    }

    public async Task<string> ImportAsync(string path)
    {
        var config = ReadConfig();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{config.Port}/v1/import");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", config.Token);
        request.Content = new StringContent(JsonSerializer.Serialize(new { path }), Encoding.UTF8, "application/json");
        return await (await _http.SendAsync(request)).Content.ReadAsStringAsync();
    }
}
