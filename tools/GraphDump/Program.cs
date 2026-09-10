using System.Diagnostics;
using System.Text.Json;
using 码图.Graph;

// 用法：GraphDump [项目根目录] [--json 输出文件]
// 作用：不启动 GUI 直接跑一遍 L1 骨架构建，打印节点/边构成与一致性检查。

var rootArg = args.FirstOrDefault(a => !a.StartsWith("--", StringComparison.Ordinal));
var root = Path.GetFullPath(rootArg ?? Directory.GetCurrentDirectory());

var jsonPath = (string?)null;
var jsonIndex = Array.IndexOf(args, "--json");
if (jsonIndex >= 0 && jsonIndex + 1 < args.Length) jsonPath = args[jsonIndex + 1];

var resolveFqn = (string?)null;
var resolveIndex = Array.IndexOf(args, "--resolve");
if (resolveIndex >= 0 && resolveIndex + 1 < args.Length) resolveFqn = args[resolveIndex + 1];
var resolveAll = args.Contains("--resolve-all");
var editorOnly = args.Contains("--editor");
var cacheMode = args.Contains("--cache");
var indexMode = args.Contains("--index");

if (editorOnly)
{
    var editor = SourceNavigator.Detect();
    Console.WriteLine($"首选编辑器    : {(editor is null ? "(未探到，将退化为系统默认程序)" : editor.Kind)}");
    if (editor is not null) Console.WriteLine($"路径          : {editor.Path}");
    return editor is not null ? 0 : 1;
}

if (args.Contains("--refs"))
{
    var probe = new SemanticResolver(root);
    Console.WriteLine($"引用集        : {probe.ReferenceCount} 个程序集");
    const string snippet = """
        using Microsoft.UI.Xaml;
        class Probe
        {
            Window? _window;
            void M() { _window = null; _window?.Activate(); }
        }
        """;
    var diags = probe.ProbeCompile(snippet);
    var errors = diags.Where(d => d.StartsWith("Error", StringComparison.Ordinal)).ToList();
    if (errors.Count == 0)
    {
        Console.WriteLine($"探针编译      : 无错误（{diags.Count} 条警告，WinUI 投影引用可用）");
        foreach (var d in diags.Take(3)) Console.WriteLine($"   {d}");
        return 0;
    }
    Console.WriteLine("探针编译      :");
    foreach (var d in diags) Console.WriteLine($"   {d}");
    return 1;
}

var sep = Path.DirectorySeparatorChar;
var files = Directory
    .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
    .Where(f => !f.Contains($"{sep}obj{sep}") && !f.Contains($"{sep}bin{sep}"))
    .OrderBy(f => f, StringComparer.Ordinal)
    .ToList();

Console.WriteLine($"root    : {root}");
Console.WriteLine($"files   : {files.Count}");

var sw = Stopwatch.StartNew();
var (nodes, edges) = SkeletonBuilder.Build(files);
sw.Stop();

Console.WriteLine($"elapsed : {sw.ElapsedMilliseconds} ms");
Console.WriteLine();
Console.WriteLine($"nodes   : {nodes.Count}");
foreach (var g in nodes.GroupBy(n => n.Kind).OrderByDescending(g => g.Count()))
    Console.WriteLine($"          {g.Key,-10} {g.Count(),6}");

Console.WriteLine($"edges   : {edges.Count}");
foreach (var g in edges.GroupBy(e => e.Kind).OrderByDescending(g => g.Count()))
    Console.WriteLine($"          {g.Key,-14} {g.Count(),6}");

// —— 一致性检查：这些不变量一旦被破坏，前端必然报错或静默丢内容 ——
var ids = new HashSet<string>(nodes.Select(n => n.Id), StringComparer.Ordinal);
var duplicateIds = nodes.GroupBy(n => n.Id).Count(g => g.Count() > 1);
var danglingEdges = edges.Count(e => !ids.Contains(e.Source) || !ids.Contains(e.Target));
var danglingParents = nodes.Count(n => n.ParentId is not null && !ids.Contains(n.ParentId));
var orphanTypes = nodes.Count(n =>
    n.Kind is not ("namespace" or "method") && n.ParentId is null);
var emptyNamespaces = nodes.Count(n => n.Kind == "namespace" && n.Label.Length == 0);

Console.WriteLine();
Console.WriteLine("—— 不变量 ——");
Report("重复节点 ID", duplicateIds);
Report("悬空边", danglingEdges);
Report("悬空 parentId", danglingParents);
Report("没有归属父节点的类型", orphanTypes);
Report("空名命名空间", emptyNamespaces);

// —— 首屏规模：默认只画命名空间，这个数字决定大项目能不能秒开 ——
var nsNodes = nodes.Where(n => n.Kind == "namespace").ToList();
var nsEdges = edges.Count(e => e.Kind is "nsInherits" or "nsCalls");
Console.WriteLine();
Console.WriteLine($"首屏（命名空间聚合）: {nsNodes.Count} 节点 / {nsEdges} 边");
Console.WriteLine($"类型总数            : {nodes.Count(n => n.Kind is not ("namespace" or "method"))}");
Console.WriteLine($"方法总数            : {nodes.Count(n => n.Kind == "method")}");

foreach (var ns in nsNodes.OrderByDescending(n => n.Label).Take(10))
    Console.WriteLine($"   {ns.Label}");

var biggest = nodes
    .Where(n => n.Kind is not ("namespace" or "method"))
    .OrderByDescending(n => (n.Methods?.Count ?? 0) + (n.Fields?.Count ?? 0))
    .Take(5);
Console.WriteLine();
Console.WriteLine("—— 最“重”的类型卡片 ——");
foreach (var n in biggest)
    Console.WriteLine($"   {n.Fqn}  ({n.Methods?.Count ?? 0} 方法 / {n.Fields?.Count ?? 0} 字段)");

if (jsonPath is not null)
{
    var opts = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };
    var snapshot = new GraphSnapshot("dump", root, 1, nodes, edges, files.Count, sw.ElapsedMilliseconds, false);
    await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(snapshot, opts));
    Console.WriteLine();
    Console.WriteLine($"JSON 已写入 {jsonPath}");
}

if (cacheMode)
{
    Console.WriteLine();
    Console.WriteLine("—— 磁盘 L1 缓存（冷 / 热）——");

    var probe = new SkeletonCache(root);
    Console.WriteLine($"缓存目录      : {probe.Directory}");
    if (Directory.Exists(probe.Directory)) Directory.Delete(probe.Directory, recursive: true);

    var cold = new SkeletonCache(root);
    var coldWatch = Stopwatch.StartNew();
    var coldResult = SkeletonBuilder.ParseFilesCached(files, cold);
    coldWatch.Stop();
    cold.Save();
    Console.WriteLine($"冷启动        : {coldWatch.ElapsedMilliseconds} ms" +
                      $"（命中 {cold.Hits} / 未命中 {cold.Misses} / 写盘后索引 {cold.KnownFiles} 条）");

    // 重新构造一个实例，等价于「关掉应用再打开」
    var warm = new SkeletonCache(root);
    var warmWatch = Stopwatch.StartNew();
    var warmResult = SkeletonBuilder.ParseFilesCached(files, warm);
    warmWatch.Stop();
    Console.WriteLine($"热启动        : {warmWatch.ElapsedMilliseconds} ms" +
                      $"（命中 {warm.Hits} / 未命中 {warm.Misses} / 从磁盘读回索引 {warm.LoadedFromDisk} 条）");
    Console.WriteLine($"加速比        : {(warmWatch.Elapsed.TotalMilliseconds <= 0 ? 0 : coldWatch.Elapsed.TotalMilliseconds / warmWatch.Elapsed.TotalMilliseconds):F1}x");

    var byPath = warmResult.ToDictionary(x => x.Path, StringComparer.OrdinalIgnoreCase);
    var identical = coldResult.Count == warmResult.Count && coldResult.All(c =>
        byPath.TryGetValue(c.Path, out var w) &&
        w.Hash == c.Hash &&
        w.Types.Count == c.Types.Count &&
        w.Types.Sum(t => t.MethodList.Count) == c.Types.Sum(t => t.MethodList.Count));
    Console.WriteLine($"结果一致      : {(identical ? "是" : "否（缓存不可信）")}");

    // 内容改了必须失效。注意这一步会故意制造一次未命中，
    // 所以要在核对「热启动零未命中」之后再跑。
    var noMissesOnWarmRun = warm.Misses == 0;
    var victim = files.FirstOrDefault(f => f.EndsWith(".cs", StringComparison.OrdinalIgnoreCase));
    var invalidated = true;
    if (victim is not null)
    {
        var rewritten = warm.TryGet(victim, SkeletonBuilder.Hash(File.ReadAllBytes(victim)));
        var bogus = warm.TryGet(victim, "0000000000000000000000000000000000000000");
        invalidated = rewritten is not null && bogus is null;
        Console.WriteLine($"哈希校验      : {(invalidated ? "OK（哈希不符即未命中）" : "FAIL")}");
    }

    return identical && noMissesOnWarmRun && invalidated ? 0 : 1;
}

if (indexMode)
{
    Console.WriteLine();
    Console.WriteLine("—— 反向索引与级联失效 ——");
    var skeletons = SkeletonBuilder.ParseFiles(files);
    var index = ReverseIndex.Build(skeletons);
    Console.WriteLine($"被引用名      : {index.ReferencedNames}");
    Console.WriteLine($"建索引文件    : {index.Files}");

    foreach (var probe in new[]
             {
                 files.FirstOrDefault(f => f.EndsWith("SkeletonBuilder.cs", StringComparison.OrdinalIgnoreCase)),
                 files.FirstOrDefault(f => f.EndsWith("Models.cs", StringComparison.OrdinalIgnoreCase)),
             })
    {
        if (probe is null) continue;
        var affected = index.AffectedTypes([probe]);
        Console.WriteLine();
        Console.WriteLine($"假设变更      : {Path.GetFileName(probe)}");
        Console.WriteLine($"级联作废类型  : {(affected is null ? "全部（保守）" : affected.Count.ToString())}" +
                          $" / 项目共 {skeletons.Sum(s => s.Types.Count)} 个类型");
        if (affected is not null)
            foreach (var t in affected.Take(12)) Console.WriteLine($"     {t}");
    }

    var missing = index.AffectedTypes([Path.Combine(root, "不存在的文件.cs")]);
    Console.WriteLine();
    Console.WriteLine($"未知文件      : {(missing is null ? "OK（保守返回全部作废）" : "FAIL（不该给出局部结果）")}");
    return missing is null ? 0 : 1;
}

if (resolveAll || resolveFqn is not null)
{
    Console.WriteLine();
    Console.WriteLine("—— L2 语义解析 ——");
    var resolver = new SemanticResolver(root);
    Console.WriteLine($"引用集        : {resolver.ReferenceCount} 个程序集");
    resolver.UpdateFiles(files);

    var typeNodes = nodes.Where(n => n.Kind is not ("namespace" or "method")).ToList();
    var targets = resolveFqn is not null
        ? typeNodes.Where(n => n.Fqn == resolveFqn).ToList()
        : typeNodes;

    if (targets.Count == 0)
    {
        Console.WriteLine($"找不到类型：{resolveFqn}");
        return 1;
    }

    var l2 = Stopwatch.StartNew();
    var precise = 0;
    var downgraded = 0;
    var downgradedWithL1 = 0;
    var totalCalls = 0;
    var totalTypeCalls = 0;

    var l1CallsByType = edges
        .Where(e => e.Kind == "calls")
        .Select(e => nodes.FirstOrDefault(n => n.Id == e.Source)?.ParentId)
        .Where(p => p is not null)
        .ToHashSet();

    foreach (var t in targets)
    {
        var r = resolver.Resolve(t.Id, t.Fqn, CancellationToken.None);
        totalCalls += r.Calls.Count;
        totalTypeCalls += r.TypeCalls.Count;
        if (r.Precise) precise++;
        else
        {
            downgraded++;
            // 只有「L1 本来有边、L2 却拿不出结果」才是真问题
            if (l1CallsByType.Contains(t.Id)) downgradedWithL1++;
            if (resolveFqn is not null || downgraded <= 3)
                Console.WriteLine($"  [降级] {r.TypeFqn}: {r.Reason}");
        }
        if (resolveFqn is not null)
        {
            Console.WriteLine($"  {r.TypeFqn}");
            Console.WriteLine($"    方法 {r.MethodCount} 个 · 精确调用 {r.Calls.Count} 条 · " +
                              $"类型调用 {r.TypeCalls.Count} 条 · 无法解析 {r.UnresolvedInvocations} 处");
            foreach (var e in r.Calls.Take(25))
                Console.WriteLine($"      {Short(e.Source)} → {Short(e.Target)}");
            if (r.Calls.Count > 25) Console.WriteLine($"      … 还有 {r.Calls.Count - 25} 条");
        }
    }
    l2.Stop();

    Console.WriteLine($"编译文件数    : {resolver.CompiledFileCount}");
    Console.WriteLine($"解析类型      : {targets.Count}（精确 {precise} / 降级 {downgraded}，" +
                      $"其中本来有 L1 边的降级 {downgradedWithL1}）");
    Console.WriteLine($"精确调用边    : {totalCalls} 条方法 / {totalTypeCalls} 条类型");
    Console.WriteLine($"耗时          : {l2.ElapsedMilliseconds} ms");

    var l1Calls = edges.Count(e => e.Kind == "calls");
    var l1TypeCalls = edges.Count(e => e.Kind == "typeCalls");
    Console.WriteLine($"对比 L1       : {l1Calls} 条方法调用 / {l1TypeCalls} 条类型调用（含同名虚边）");

    if (resolveFqn is not null || resolveAll)
        return downgradedWithL1 == 0 && duplicateIds == 0 && danglingEdges == 0 ? 0 : 1;
}

return duplicateIds == 0 && danglingEdges == 0 && danglingParents == 0 ? 0 : 1;

string Short(string id)
{
    var node = nodes.FirstOrDefault(n => n.Id == id);
    return node is null ? id : $"{node.Fqn}@{node.Line}";
}

void Report(string label, int count)
{
    var mark = count == 0 ? "OK  " : "FAIL";
    Console.WriteLine($"  [{mark}] {label,-22} {count}");
}
