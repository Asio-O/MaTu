using System;
using System.Diagnostics;
using System.IO;

namespace 码图.Graph;

/// <summary>
/// 决定分析跑在进程内还是进程外，并在进程外方案失效时**自动降级**。
/// <para>策略（可用环境变量 <c>MATU_ANALYZER</c> 覆盖）：</para>
/// <list type="bullet">
/// <item><c>1</c> / <c>on</c>：总是用独立进程</item>
/// <item><c>0</c> / <c>off</c>：总是用进程内</item>
/// <item>未设置或 <c>auto</c>：项目文件数超过 <see cref="AutoThreshold"/> 时用独立进程</item>
/// </list>
/// </summary>
public static class AnalyzerFactory
{
    /// <summary>自动模式的阈值。低于此规模时进程内更快（省掉一次进程启动与序列化）。</summary>
    public const int AutoThreshold = 1500;

    public static IAnalyzer Create(string root)
    {
        var mode = (Environment.GetEnvironmentVariable("MATU_ANALYZER") ?? "auto").Trim().ToLowerInvariant();

        var useOutOfProcess = mode switch
        {
            "1" or "on" or "true" or "yes" => true,
            "0" or "off" or "false" or "no" => false,
            _ => CountFiles(root) >= AutoThreshold,
        };

        if (!useOutOfProcess)
        {
            var inProcess = new InProcessAnalyzer(root);
            Console.WriteLine($"[analyzer] 模式：进程内（{mode}）");
            return inProcess;
        }

        try
        {
            var outOfProcess = new OutOfProcessAnalyzer();
            Console.WriteLine($"[analyzer] 模式：独立进程（{mode}）· {outOfProcess.Describe}");
            return new FallbackAnalyzer(outOfProcess, root);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[analyzer] 独立进程不可用（{ex.Message}），退回进程内");
            return new InProcessAnalyzer(root);
        }
    }

    private static int CountFiles(string root)
    {
        try
        {
            _ = Stopwatch.StartNew();
            var sep = Path.DirectorySeparatorChar;
            var count = 0;
            foreach (var f in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
            {
                if (f.Contains($"{sep}obj{sep}") || f.Contains($"{sep}bin{sep}")) continue;
                if (++count >= AutoThreshold) return count;
            }
            return count;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[analyzer] 统计文件数失败：{ex.Message}");
            return 0;
        }
    }
}

/// <summary>
/// 把「独立进程」包一层：任何一次调用失败就永久退回进程内实现，并把原因写进日志。
/// 这样分析器进程的故障最多让当次分析重做一遍，不会让整个工具不可用。
/// </summary>
public sealed class FallbackAnalyzer : IAnalyzer
{
    private readonly string _root;
    private IAnalyzer _primary;
    private IAnalyzer? _fallback;

    public FallbackAnalyzer(IAnalyzer primary, string root)
    {
        _primary = primary;
        _root = root;
    }

    public string Describe => _fallback is null ? _primary.Describe : $"{_fallback.Describe}（已从独立进程降级）";

    public GraphSnapshot Analyze(string projectId, string root, System.Threading.CancellationToken ct)
        => Guard(a => a.Analyze(projectId, root, ct));

    public TypeResolution Resolve(string typeId, string fqn, System.Threading.CancellationToken ct)
        => Guard(a => a.Resolve(typeId, fqn, ct));

    private T Guard<T>(Func<IAnalyzer, T> action)
    {
        if (_fallback is not null) return action(_fallback);

        try
        {
            return action(_primary);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[analyzer] 独立进程调用失败：{ex.Message}，本会话退回进程内");
            try { _primary.Dispose(); } catch { /* 已经坏了，忽略 */ }

            _fallback = new InProcessAnalyzer(_root);
            return action(_fallback);
        }
    }

    public void Dispose()
    {
        try { _primary.Dispose(); } catch { }
        _fallback?.Dispose();
    }
}
