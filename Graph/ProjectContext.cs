using System;
using System.Threading;
using System.Threading.Tasks;

namespace 码图.Graph;

/// <summary>
/// 单项目生命周期：图数据、文件监听、版本号、分析器。
/// <para>分析跑在进程内还是进程外由 <see cref="AnalyzerFactory"/> 决定，本类不关心。</para>
/// </summary>
public sealed class ProjectContext : IDisposable
{
    public string Id { get; }
    public string Root { get; }
    public GraphSnapshot Snapshot { get; private set; } =
        new("", "", 0, [], [], 0, 0, false);

    /// <summary>L1 骨架构建与 L2 语义解析的统一入口。</summary>
    public IAnalyzer Analyzer { get; }

    private readonly Action<GraphSnapshot> _onUpdated;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private SourceWatcher? _watcher;
    private CancellationTokenSource? _cts;
    private int _pending;
    private long _version;

    public ProjectContext(string id, string root, Action<GraphSnapshot> onUpdated)
    {
        Id = id; Root = root; _onUpdated = onUpdated;
        Analyzer = AnalyzerFactory.Create(root);
    }

    public Task LoadAsync(CancellationToken ct) => RebuildAsync(ct);

    public void Activate()
    {
        _watcher?.Dispose();
        _cts = new CancellationTokenSource();
        _watcher = new SourceWatcher(Root, OnSourceChanged);
    }

    public void Deactivate()
    {
        _watcher?.Dispose();
        _watcher = null;
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
    }

    private void OnSourceChanged()
    {
        var cts = _cts;
        if (cts is null) return;
        _ = RebuildAsync(cts.Token);
    }

    private async Task RebuildAsync(CancellationToken ct)
    {
        if (Interlocked.Exchange(ref _pending, 1) == 1) return;
        do
        {
            Interlocked.Exchange(ref _pending, 0);
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var version = Interlocked.Increment(ref _version);
                var analyzer = Analyzer;
                var id = Id;
                var root = Root;

                var sw = System.Diagnostics.Stopwatch.StartNew();
                var snapshot = await Task.Run(
                    () => analyzer.Analyze(id, root, ct), ct).ConfigureAwait(false);
                sw.Stop();

                Snapshot = snapshot with
                {
                    ProjectId = id,
                    Root = root,
                    Version = version,
                    ElapsedMs = sw.ElapsedMilliseconds,
                    Analyzer = analyzer.Describe,
                };
                _onUpdated(Snapshot);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex) { Console.Error.WriteLine($"[rebuild] {ex}"); }
            finally { _gate.Release(); }
        }
        while (Volatile.Read(ref _pending) == 1);
    }

    public void Dispose()
    {
        Deactivate();
        Analyzer.Dispose();
        _gate.Dispose();
    }
}
