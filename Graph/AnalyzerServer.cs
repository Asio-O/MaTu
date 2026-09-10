using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace 码图.Graph;

/// <summary>宿主 → 分析器进程的一行 JSON。</summary>
public sealed record AnalyzerRequest(
    long Id,
    string Cmd,
    string? ProjectId = null,
    string? Root = null,
    string? TypeId = null,
    string? Fqn = null);

/// <summary>分析器进程 → 宿主的一行 JSON。</summary>
public sealed record AnalyzerResponse(
    long Id,
    bool Ok,
    string Kind,
    string? Error = null,
    GraphSnapshot? Snapshot = null,
    TypeResolution? Resolution = null,
    AnalyzerStats? Stats = null);

public sealed record AnalyzerStats(
    int Files,
    int CachedFiles,
    int CacheHits,
    int CacheMisses,
    int References,
    int InvalidatedTypes,
    bool GlobalInvalidation,
    long ElapsedMs);

/// <summary>
/// 分析器进程的服务端。协议是「一行一个 JSON」，与 <c>CodeGraph.Analyzer</c> 客户端一一对应。
/// <para>刻意做成串行处理：分析内部本来就并行，而串行让「重建」与「精确解析」不会交叉，
/// 省掉一整类状态竞争。</para>
/// </summary>
public static class AnalyzerServer
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>作为独立进程运行。返回进程退出码。</summary>
    public static int Run()
    {
        // 只让 JSON 走 stdout，其它一切（Roslyn 诊断、异常）都去 stderr，
        // 否则宿主按行解析时会被噪声打断。
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);

        SkeletonCache? cache = null;
        SemanticResolver? resolver = null;
        string? currentRoot = null;

        Write(stdout, new AnalyzerResponse(0, true, "hello",
            Stats: new AnalyzerStats(0, 0, 0, 0, 0, 0, false, 0)));

        while (stdin.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            AnalyzerRequest? request = null;
            try
            {
                request = JsonSerializer.Deserialize<AnalyzerRequest>(line, Json);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[analyzer] 请求解析失败：{ex.Message}");
                Write(stdout, new AnalyzerResponse(0, false, "error", Error: ex.Message));
                continue;
            }
            if (request is null) continue;

            if (string.Equals(request.Cmd, "shutdown", StringComparison.OrdinalIgnoreCase))
            {
                Write(stdout, new AnalyzerResponse(request.Id, true, "bye"));
                break;
            }

            if (string.Equals(request.Cmd, "ping", StringComparison.OrdinalIgnoreCase))
            {
                Write(stdout, new AnalyzerResponse(request.Id, true, "pong"));
                continue;
            }

            try
            {
                switch (request.Cmd)
                {
                    case "analyze":
                        {
                            var root = request.Root ?? currentRoot
                                ?? throw new InvalidOperationException("analyze 缺少 root");
                            if (!string.Equals(root, currentRoot, StringComparison.OrdinalIgnoreCase) || resolver is null)
                            {
                                cache = new SkeletonCache(root);
                                resolver = new SemanticResolver(root);
                                currentRoot = root;
                            }

                            var activeCache = cache ??= new SkeletonCache(root);
                            var activeResolver = resolver;
                            var sw = System.Diagnostics.Stopwatch.StartNew();
                            var files = AnalyzerFiles.Enumerate(root);

                            var hitsBefore = activeCache.Hits;
                            var missesBefore = activeCache.Misses;
                            var skeletons = SkeletonBuilder.ParseFilesCached(files, activeCache, default);
                            var (nodes, edges) = SkeletonBuilder.Compose(skeletons, default);
                            activeResolver.UpdateFiles(files, skeletons, default);
                            activeCache.Save();
                            sw.Stop();

                            var hits = activeCache.Hits - hitsBefore;
                            var misses = activeCache.Misses - missesBefore;
                            var snapshot = new GraphSnapshot(
                                request.ProjectId ?? string.Empty, root, 0, nodes, edges, files.Count, 0,
                                FromCache: activeCache.Enabled && hits > 0 && misses == 0,
                                CachedFiles: hits);

                            Write(stdout, new AnalyzerResponse(request.Id, true, "snapshot",
                                Snapshot: snapshot,
                                Stats: new AnalyzerStats(
                                    files.Count, hits, activeCache.Hits, activeCache.Misses,
                                    activeResolver.ReferenceCount, activeResolver.LastInvalidatedCount,
                                    activeResolver.LastInvalidationWasGlobal, sw.ElapsedMilliseconds)));
                            break;
                        }

                    case "resolve":
                        {
                            if (resolver is null)
                                throw new InvalidOperationException("还没有 analyze 过，无法解析");
                            var typeId = request.TypeId ?? string.Empty;
                            var fqn = request.Fqn ?? string.Empty;
                            var resolution = resolver.Resolve(typeId, fqn, default);
                            Write(stdout, new AnalyzerResponse(request.Id, true, "resolution",
                                Resolution: resolution));
                            break;
                        }

                    default:
                        Write(stdout, new AnalyzerResponse(request.Id, false, "error",
                            Error: $"未知命令 {request.Cmd}"));
                        break;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[analyzer] {request.Cmd}: {ex}");
                Write(stdout, new AnalyzerResponse(request.Id, false, "error", Error: ex.Message));
            }
        }

        return 0;
    }

    private static void Write(StreamWriter stdout, AnalyzerResponse response)
    {
        stdout.WriteLine(JsonSerializer.Serialize(response, Json));
        stdout.Flush();
    }
}
