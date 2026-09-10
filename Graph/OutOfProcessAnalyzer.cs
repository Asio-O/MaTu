using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace 码图.Graph;

/// <summary>
/// 进程外实现：把分析器拉到一个同名的子进程里跑（<c>码图.exe --analyzer</c>），
/// 宿主只负责发命令、收 JSON。大项目下宿主进程的内存与 GC 压力因此与分析规模解耦。
/// <para>子进程崩溃、启动失败或协议超时都会被识别出来，由 <see cref="AnalyzerFactory"/>
/// 决定退回进程内实现，绝不把「分析器挂了」变成「应用挂了」。</para>
/// </summary>
public sealed class OutOfProcessAnalyzer : IAnalyzer
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _exePath;
    private readonly object _lock = new();
    private readonly ConcurrentDictionary<long, TaskCompletionSource<AnalyzerResponse>> _pending = new();

    private Process? _process;
    private long _seq;
    private bool _disposed;

    public OutOfProcessAnalyzer(string? exePath = null)
    {
        _exePath = exePath ?? Environment.ProcessPath
            ?? throw new InvalidOperationException("拿不到当前可执行文件路径，无法启动分析器进程");
    }

    public string Describe => $"独立进程（pid {SafePid()}）";

    public bool IsRunning
    {
        get { lock (_lock) return _process is { HasExited: false }; }
    }

    public GraphSnapshot Analyze(string projectId, string root, CancellationToken ct)
    {
        var response = SendAsync(new AnalyzerRequest(0, "analyze", projectId, root), ct, TimeSpan.FromMinutes(10))
            .GetAwaiter().GetResult();
        if (!response.Ok || response.Snapshot is null)
            throw new InvalidOperationException(response.Error ?? "分析器没有返回快照");
        return response.Snapshot;
    }

    public TypeResolution Resolve(string typeId, string fqn, CancellationToken ct)
    {
        var response = SendAsync(new AnalyzerRequest(0, "resolve", TypeId: typeId, Fqn: fqn), ct, TimeSpan.FromMinutes(5))
            .GetAwaiter().GetResult();
        if (!response.Ok || response.Resolution is null)
            throw new InvalidOperationException(response.Error ?? "分析器没有返回解析结果");
        return response.Resolution;
    }

    private async Task<AnalyzerResponse> SendAsync(AnalyzerRequest template, CancellationToken ct, TimeSpan timeout)
    {
        var process = EnsureStarted();
        var id = Interlocked.Increment(ref _seq);
        var request = template with { Id = id };

        var tcs = new TaskCompletionSource<AnalyzerResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        try
        {
            var line = JsonSerializer.Serialize(request, Json);
            await process.StandardInput.WriteLineAsync(line.AsMemory(), ct).ConfigureAwait(false);
            await process.StandardInput.FlushAsync(ct).ConfigureAwait(false);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            await using var registration = cts.Token.Register(() => tcs.TrySetCanceled(ct)).ConfigureAwait(false);
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    private Process EnsureStarted()
    {
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_process is { HasExited: false }) return _process;

            var psi = new ProcessStartInfo(_exePath, "--analyzer")
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
            };

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => OnLine(e.Data);
            process.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data)) Console.Error.WriteLine($"[analyzer] {e.Data}");
            };
            process.Exited += (_, _) => OnExited();

            if (!process.Start())
                throw new InvalidOperationException("分析器进程启动失败");

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            Console.WriteLine($"[analyzer] 已启动独立分析器进程 pid={process.Id}");
            return process;
        }
    }

    private void OnLine(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        AnalyzerResponse? response;
        try
        {
            response = JsonSerializer.Deserialize<AnalyzerResponse>(line, Json);
        }
        catch (JsonException)
        {
            // 子进程的杂项输出（非协议行）不该打断解析
            Console.Error.WriteLine($"[analyzer] 非协议输出：{Truncate(line)}");
            return;
        }
        if (response is null) return;
        if (_pending.TryRemove(response.Id, out var tcs))
            tcs.TrySetResult(response);
    }

    private void OnExited()
    {
        Console.Error.WriteLine("[analyzer] 分析器进程已退出");
        foreach (var kv in _pending)
        {
            if (_pending.TryRemove(kv.Key, out var tcs))
                tcs.TrySetException(new InvalidOperationException("分析器进程意外退出"));
        }
        lock (_lock) _process = null;
    }

    private string SafePid()
    {
        lock (_lock) return _process is { HasExited: false } p ? p.Id.ToString() : "未启动";
    }

    private static string Truncate(string s) => s.Length <= 200 ? s : s[..200] + "…";

    public void Dispose()
    {
        Process? process;
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            process = _process;
            _process = null;
        }
        if (process is null) return;

        try
        {
            if (!process.HasExited)
            {
                try
                {
                    process.StandardInput.WriteLine(JsonSerializer.Serialize(
                        new AnalyzerRequest(Interlocked.Increment(ref _seq), "shutdown"), Json));
                    process.StandardInput.Flush();
                }
                catch { /* 已经断开就没什么可告别的 */ }

                if (!process.WaitForExit(3000)) process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[analyzer] 关闭失败：{ex.Message}");
        }
        finally
        {
            process.Dispose();
        }
    }
}
