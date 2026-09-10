using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using 码图.Graph;

namespace 码图;

public sealed partial class MainWindow : Window
{
    // —— Debug 环境默认打开的项目路径 ——
#if DEBUG
    private const string DefaultProjectPath =
        @"D:\Users\Administrator\source\repos\码图";
#endif

    private readonly ProjectRegistry _registry;
    private readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private GraphSnapshot? _latest;

    public MainWindow()
    {
        InitializeComponent();
        _registry = new ProjectRegistry(PushSnapshot);
        _ = InitAsync();
    }

    private async Task InitAsync()
    {
        await InitWebViewAsync();
#if DEBUG
        await LoadDefaultProjectAsync();
#endif
    }

    private async Task InitWebViewAsync()
    {
        // 诊断钩子：设置 MATU_CDP_PORT 后 WebView2 会开启远程调试端口。
        // tools/webprobe/probe.js 借此在无人值守的情况下读取页面真实状态、模拟点击，
        // 因为「WebView2 里排查问题的成本远高于普通浏览器」。
        var options = new CoreWebView2EnvironmentOptions();
        var cdpPort = Environment.GetEnvironmentVariable("MATU_CDP_PORT");
        if (!string.IsNullOrWhiteSpace(cdpPort))
        {
            options.AdditionalBrowserArguments =
                $"--remote-debugging-port={cdpPort} --remote-allow-origins=*";
        }

        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(null, null, options);
        await WebView.EnsureCoreWebView2Async(environment);

        WebView.CoreWebView2.Settings.AreDevToolsEnabled = true;
        WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            "app.local", wwwroot, CoreWebView2HostResourceAccessKind.Allow);

        WebView.CoreWebView2.Navigate("http://app.local/index.html");
    }

#if DEBUG
    private async Task LoadDefaultProjectAsync()
    {
        if (!Directory.Exists(DefaultProjectPath))
        {
            StatusText.Text = $"[Debug] 默认项目不存在：{DefaultProjectPath}";
            return;
        }

        StatusText.Text = $"[Debug] 自动加载：{DefaultProjectPath} ...";
        try
        {
            await _registry.SwitchAsync(DefaultProjectPath, CancellationToken.None);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"[Debug] 自动加载失败：{ex.Message}";
            Console.Error.WriteLine($"[debug-load] {ex}");
        }
    }
#endif

    // ================================================================
    //  前端 → 后端
    // ================================================================

    private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var doc = JsonDocument.Parse(args.WebMessageAsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeEl)) return;

            switch (typeEl.GetString())
            {
                case "ready":
                    // 前端可能比首次快照晚就绪，这里补推一次，消掉竞态
                    if (_latest is not null) PushSnapshot(_latest);
                    break;

                case "devtools":
                    WebView.CoreWebView2?.OpenDevToolsWindow();
                    break;

                case "resolve":
                    _ = ResolveTypeAsync(root);
                    break;

                case "goto":
                    NavigateToSource(root);
                    break;

                case "export":
                    _ = ExportAsync(root);
                    break;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[webmsg] {ex}");
        }
    }

    /// <summary>
    /// L2：把某个类型的调用精确化。走后台线程，结果异步推回前端；
    /// 解析期间先回一条 resolving，让界面能给出反馈。
    /// </summary>
    private async Task ResolveTypeAsync(JsonElement root)
    {
        var typeId = GetString(root, "typeId");
        var fqn = GetString(root, "fqn");
        var ctx = _registry.Active;
        if (typeId is null || fqn is null || ctx is null) return;

        Post(new { type = "resolving", typeId });
        var sw = Stopwatch.StartNew();

        TypeResolution result;
        try
        {
            result = await Task.Run(() => ctx.Analyzer.Resolve(typeId, fqn, CancellationToken.None));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[l2] {fqn}: {ex}");
            Post(new { type = "resolved", typeId, precise = false, reason = ex.Message, edges = Array.Empty<object>() });
            return;
        }
        sw.Stop();

        Post(new
        {
            type = "resolved",
            typeId = result.TypeId,
            fqn = result.TypeFqn,
            precise = result.Precise,
            reason = result.Reason,
            edges = result.Calls,
            typeCalls = result.TypeCalls,
            methodCount = result.MethodCount,
            unresolved = result.UnresolvedInvocations,
            elapsedMs = sw.ElapsedMilliseconds,
        });
    }

    private void NavigateToSource(JsonElement root)
    {
        var file = GetString(root, "file");
        if (string.IsNullOrWhiteSpace(file)) return;
        var line = root.TryGetProperty("line", out var l) && l.TryGetInt32(out var n) ? n : 1;

        var result = SourceNavigator.Open(file, line);
        StatusText.Text = result.Success
            ? $"已用 {result.Target} 打开 {result.Message}"
            : $"跳转失败：{result.Message}";

        Post(new
        {
            type = "navigated",
            success = result.Success,
            target = result.Target,
            message = result.Message,
        });
    }

    /// <summary>
    /// 导出：前端把内容做出来，宿主只负责弹「另存为」并落盘。
    /// 这样 PNG 用不着在 C# 里重画一遍，mermaid / JSON 也只是字符串搬运。
    /// </summary>
    private async Task ExportAsync(JsonElement root)
    {
        try
        {
            var format = GetString(root, "format") ?? "json";
            var content = GetString(root, "content");
            var name = GetString(root, "name") ?? "codemap";
            var isBase64 = root.TryGetProperty("base64", out var b) && b.ValueKind == JsonValueKind.True;
            if (content is null) { Post(new { type = "exported", ok = false, message = "导出内容为空" }); return; }

            var (extension, description) = format switch
            {
                "png" => (".png", "PNG 图片"),
                "mermaid" => (".mmd", "Mermaid 文本"),
                _ => (".json", "JSON 数据"),
            };

            var picker = new Windows.Storage.Pickers.FileSavePicker
            {
                SuggestedFileName = Path.GetFileNameWithoutExtension(name),
                SuggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.DocumentsLibrary,
            };
            picker.FileTypeChoices.Add(description, new List<string> { extension });
            WinRT.Interop.InitializeWithWindow.Initialize(
                picker, WinRT.Interop.WindowNative.GetWindowHandle(this));

            var file = await picker.PickSaveFileAsync();
            if (file is null)
            {
                Post(new { type = "exported", ok = false, message = "已取消" });
                return;
            }

            var bytes = isBase64 ? Convert.FromBase64String(content) : Encoding.UTF8.GetBytes(content);
            await Windows.Storage.FileIO.WriteBytesAsync(file, bytes);

            StatusText.Text = $"已导出 {format.ToUpperInvariant()} · {file.Path}";
            Post(new { type = "exported", ok = true, path = file.Path });
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[export] {ex}");
            Post(new { type = "exported", ok = false, message = ex.Message });
        }
    }

    // ================================================================
    //  后端 → 前端
    // ================================================================

    private void PushSnapshot(GraphSnapshot snap)
    {
        _latest = snap;
        DispatcherQueue.TryEnqueue(() =>
        {
            StatusText.Text =
                $"{snap.ProjectId} · v{snap.Version} · {snap.FileCount} 文件 · " +
                $"{snap.Nodes.Count} 节点 · {snap.Edges.Count} 边 · {snap.ElapsedMs} ms" +
                (snap.FromCache ? $" · L1 缓存 {snap.CachedFiles} 文件" : string.Empty) +
                (snap.Analyzer.Length > 0 ? $" · 分析：{snap.Analyzer}" : string.Empty);
            if (WebView.CoreWebView2 is null) return;
            var payload = JsonSerializer.Serialize(new { type = "snapshot", snapshot = snap }, _json);
            WebView.CoreWebView2.PostWebMessageAsJson(payload);
        });
    }

    private void Post(object payload)
    {
        var json = JsonSerializer.Serialize(payload, _json);
        DispatcherQueue.TryEnqueue(() =>
        {
            if (WebView.CoreWebView2 is null) return;
            WebView.CoreWebView2.PostWebMessageAsJson(json);
        });
    }

    private static string? GetString(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()
            : null;

    private async void OnOpenClicked(object sender, RoutedEventArgs e)
    {
        var picker = new Windows.Storage.Pickers.FolderPicker();
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
        picker.FileTypeFilter.Add("*");

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;

        StatusText.Text = $"加载中：{folder.Path} ...";
        await _registry.SwitchAsync(folder.Path, CancellationToken.None);
    }
}
