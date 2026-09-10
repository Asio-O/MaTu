using System;
using System.Collections.Generic;
using System.Threading;

namespace 码图.Graph;

/// <summary>
/// 分析器的统一门面。进程内与进程外两种实现共用它，
/// 上层的 <see cref="ProjectContext"/> 因此完全不需要知道分析跑在哪里。
/// </summary>
public interface IAnalyzer : IDisposable
{
    /// <summary>人类可读的运行位置描述，用于日志与界面。</summary>
    string Describe { get; }

    /// <summary>扫描根目录下的 .cs 文件，构建图快照。版本号由调用方赋值。</summary>
    GraphSnapshot Analyze(string projectId, string root, CancellationToken ct);

    /// <summary>对某个类型做 L2 语义精确化。</summary>
    TypeResolution Resolve(string typeId, string fqn, CancellationToken ct);
}

/// <summary>进程内实现：直接从宿主进程调 Roslyn。</summary>
public sealed class InProcessAnalyzer : IAnalyzer
{
    private readonly SkeletonCache _cache;
    private readonly SemanticResolver _resolver;

    public InProcessAnalyzer(string root)
    {
        _cache = new SkeletonCache(root);
        _resolver = new SemanticResolver(root);
    }

    public string Describe => _cache.Enabled
        ? "进程内 · L1 缓存已启用"
        : $"进程内 · L1 缓存不可用（{_cache.LastError}）";

    public GraphSnapshot Analyze(string projectId, string root, CancellationToken ct)
    {
        var files = AnalyzerFiles.Enumerate(root);
        var hitsBefore = _cache.Hits;
        var missesBefore = _cache.Misses;

        var skeletons = SkeletonBuilder.ParseFilesCached(files, _cache, ct);
        var (nodes, edges) = SkeletonBuilder.Compose(skeletons, ct);

        _resolver.UpdateFiles(files, skeletons, ct);
        _cache.Save();

        var hits = _cache.Hits - hitsBefore;
        var misses = _cache.Misses - missesBefore;
        return new GraphSnapshot(
            projectId, root, 0, nodes, edges, files.Count, 0,
            FromCache: _cache.Enabled && hits > 0 && misses == 0,
            CachedFiles: hits);
    }

    public TypeResolution Resolve(string typeId, string fqn, CancellationToken ct)
        => _resolver.Resolve(typeId, fqn, ct);

    public void Dispose() { }
}

/// <summary>扫描规则与宿主、分析器进程共用，保证两边看到的文件集合完全一致。</summary>
public static class AnalyzerFiles
{
    public static List<string> Enumerate(string root)
    {
        var sep = System.IO.Path.DirectorySeparatorChar;
        var files = new List<string>();
        foreach (var f in System.IO.Directory.EnumerateFiles(root, "*.cs", System.IO.SearchOption.AllDirectories))
        {
            if (f.Contains($"{sep}obj{sep}") || f.Contains($"{sep}bin{sep}")) continue;
            files.Add(f);
        }
        return files;
    }
}
