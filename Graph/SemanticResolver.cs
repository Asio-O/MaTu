using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace 码图.Graph;

/// <summary>一个类型的精确调用解析结果。</summary>
public sealed record TypeResolution(
    string TypeId,
    string TypeFqn,
    bool Precise,
    string? Reason,
    IReadOnlyList<GraphEdge> Calls,
    IReadOnlyList<GraphEdge> TypeCalls,
    int MethodCount,
    int UnresolvedInvocations);

/// <summary>
/// L2 语义解析。按需（点击某个类型时）建立一次 Adhoc Compilation，
/// 用 <see cref="SemanticModel"/> 把该类型的调用精确落到具体方法符号上，
/// 从而消掉 L1 简单名匹配产生的同名方法虚边。
///
/// 它不参与首屏：方案 §11 的原则是「纯语法（秒级、粗）与语义分析（按需、准）分离」。
/// </summary>
public sealed class SemanticResolver
{
    /// <summary>
    /// 代码生成器产生、编译期并不存在的成员。它们必然解析不到，
    /// 但不代表「引用集不全」，不能拿它们把整个类型判成降级。
    /// </summary>
    private static readonly HashSet<string> GeneratedMembers = new(StringComparer.Ordinal)
    {
        "InitializeComponent",     // WinUI / WPF 的 XAML 设计器
        "GetBindingConnector",     // WPF 的 BAML 连接器
        "Connect",                 // 同上
    };

    private readonly object _lock = new();
    private readonly List<MetadataReference> _references;

    private IReadOnlyList<string> _files = [];
    private Dictionary<string, string> _fileStamps = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, HashSet<string>> _declaredByFile = new(StringComparer.OrdinalIgnoreCase);
    private ReverseIndex? _reverseIndex;
    private bool _hasBaseline;
    private CSharpCompilation? _compilation;
    private Dictionary<string, (SyntaxTree Tree, TypeDeclarationSyntax Decl)>? _typeIndex;
    private readonly Dictionary<string, TypeResolution> _cache = new(StringComparer.Ordinal);

    public SemanticResolver(string projectRoot)
    {
        _references = BuildReferences(projectRoot);
    }

    public int ReferenceCount => _references.Count;

    /// <summary>上一次建立编译时用到的文件数（0 表示还没建过）。</summary>
    public int CompiledFileCount { get; private set; }

    /// <summary>最近一次级联失效作废掉的解析结果数量；-1 表示整体作废。</summary>
    public int LastInvalidatedCount { get; private set; }

    /// <summary>最近一次级联失效是否退化成「全部作废」。</summary>
    public bool LastInvalidationWasGlobal { get; private set; }

    /// <summary>
    /// 更新文件集合与解析结果。
    /// <para>文件清单或任一文件的最后写入时间变了就重建编译；</para>
    /// <para>但缓存不是整片清掉——用 <see cref="ReverseIndex"/> 只作废受影响的类型，
    /// 这就是方案 §7.2 的「反向索引与精确级联失效」。</para>
    /// </summary>
    public void UpdateFiles(
        IReadOnlyList<string> files,
        IReadOnlyList<FileSkeleton>? skeletons = null,
        CancellationToken ct = default)
    {
        var nextStamps = new Dictionary<string, string>(files.Count, StringComparer.OrdinalIgnoreCase);
        foreach (var f in files)
        {
            ct.ThrowIfCancellationRequested();
            long ticks = 0;
            try { ticks = File.GetLastWriteTimeUtc(f).Ticks; } catch { /* 刚被删掉，交给下一轮 */ }
            nextStamps[f] = ticks.ToString();
        }

        var nextDeclared = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        if (skeletons is not null)
        {
            foreach (var s in skeletons)
                nextDeclared[s.Path] = new HashSet<string>(s.Types.Select(t => t.Fqn), StringComparer.Ordinal);
        }

        List<string> changed;
        lock (_lock)
        {
            changed = nextStamps
                .Where(kv => !_fileStamps.TryGetValue(kv.Key, out var old) || !string.Equals(old, kv.Value, StringComparison.Ordinal))
                .Select(kv => kv.Key)
                .Concat(_fileStamps.Keys.Where(k => !nextStamps.ContainsKey(k)))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var hadBaseline = _hasBaseline;
            _files = files;
            _fileStamps = nextStamps;
            _hasBaseline = true;

            if (skeletons is not null)
            {
                _reverseIndex = ReverseIndex.Build(skeletons);
                _declaredByFile = nextDeclared;
            }

            if (!hadBaseline || changed.Count == 0) return;

            // 类型被新增/删除/改名属于结构性变化，反向索引当场就不可信了，整体作废。
            var structural = false;
            foreach (var file in changed)
            {
                var before = _declaredByFile.TryGetValue(file, out var b) ? b : [];
                var after = nextDeclared.TryGetValue(file, out var a) ? a : [];
                if (!before.SetEquals(after)) { structural = true; break; }
            }

            var affected = structural ? null : _reverseIndex?.AffectedTypes(changed);

            _compilation = null;
            _typeIndex = null;
            CompiledFileCount = 0;

            if (affected is null)
            {
                LastInvalidationWasGlobal = true;
                LastInvalidatedCount = _cache.Count;
                _cache.Clear();
            }
            else
            {
                LastInvalidationWasGlobal = false;
                var removed = 0;
                foreach (var fqn in affected)
                    if (_cache.Remove(fqn)) removed++;
                LastInvalidatedCount = removed;
            }
        }
    }

    public void Invalidate()
    {
        lock (_lock) InvalidateLocked();
    }

    private void InvalidateLocked()
    {
        _compilation = null;
        _typeIndex = null;
        CompiledFileCount = 0;
        _cache.Clear();
    }

    public TypeResolution Resolve(string typeId, string typeFqn, CancellationToken ct)
    {
        lock (_lock)
        {
            if (_cache.TryGetValue(typeFqn, out var hit)) return hit;
        }

        var (compilation, index) = EnsureCompilation(ct);
        if (compilation is null || index is null)
            return NotPrecise(typeId, typeFqn, "没有可用的源码文件");

        if (!index.TryGetValue(typeFqn, out var entry))
            return NotPrecise(typeId, typeFqn, "在当前编译里找不到该类型声明");

        var model = compilation.GetSemanticModel(entry.Tree);
        if (model.GetDeclaredSymbol(entry.Decl, ct) is not INamedTypeSymbol)
            return NotPrecise(typeId, typeFqn, "无法取得类型符号");

        var callerTypeId = SkeletonBuilder.SymbolKey(typeFqn);
        var calls = new HashSet<(string Src, string Dst)>();
        var typeCalls = new HashSet<(string Src, string Dst)>();
        var methodCount = 0;
        var unresolved = 0;
        var unresolvedNames = new HashSet<string>(StringComparer.Ordinal);

        foreach (var mds in entry.Decl.Members.OfType<MethodDeclarationSyntax>())
        {
            ct.ThrowIfCancellationRequested();

            var body = (SyntaxNode?)mds.Body ?? mds.ExpressionBody?.Expression;
            if (body is null) continue;
            methodCount++;

            var callerId = SkeletonBuilder.SymbolKey($"{typeFqn}.{SyntaxFacts.Signature(mds)}");

            foreach (var inv in body.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                var info = model.GetSymbolInfo(inv, ct);
                var symbol = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
                if (symbol is null)
                {
                    var name = SyntaxFacts.SimpleCalleeName(inv.Expression);
                    if (name is null || !GeneratedMembers.Contains(name))
                    {
                        unresolved++;
                        if (name is not null) unresolvedNames.Add(name);
                    }
                    continue;
                }

                // 只有源码里声明的方法才在图里；元数据方法（BCL、NuGet）直接跳过。
                var declRef = symbol.DeclaringSyntaxReferences.FirstOrDefault();
                if (declRef is null) continue;
                if (declRef.GetSyntax(ct) is not MethodDeclarationSyntax targetDecl) continue;

                var targetTypeDecl = targetDecl.Ancestors().OfType<TypeDeclarationSyntax>().FirstOrDefault();
                if (targetTypeDecl is null) continue;

                var targetNs = SyntaxFacts.NamespacePath(targetTypeDecl);
                var targetTypeFqn = SyntaxFacts.TypePath(targetTypeDecl, targetNs);
                var targetTypeId = SkeletonBuilder.SymbolKey(targetTypeFqn);
                var targetId = SkeletonBuilder.SymbolKey($"{targetTypeFqn}.{SyntaxFacts.Signature(targetDecl)}");

                if (targetId == callerId) continue;

                calls.Add((callerId, targetId));
                if (targetTypeId != callerTypeId)
                    typeCalls.Add((callerTypeId, targetTypeId));
            }
        }

        // 全部落在编译内、但一条项目内调用都没有 → 可以放心用空集替换 L1 的虚边。
        // 若存在解析不了的调用且一条都没连上，说明引用集不全，宁可保留 L1。
        var precise = calls.Count > 0 || unresolved == 0;
        var reason = precise
            ? null
            : $"有 {unresolved} 处调用无法解析（{string.Join("、", unresolvedNames.Take(3))}" +
              (unresolvedNames.Count > 3 ? " 等" : string.Empty) + "），保留 L1 近似结果";

        var result = new TypeResolution(
            typeId, typeFqn, precise, reason,
            calls.Select(c => new GraphEdge($"calls:{c.Src}->{c.Dst}", c.Src, c.Dst, "calls")).ToList(),
            typeCalls.Select(c => new GraphEdge($"typeCalls:{c.Src}->{c.Dst}", c.Src, c.Dst, "typeCalls")).ToList(),
            methodCount, unresolved);

        lock (_lock) _cache[typeFqn] = result;
        return result;
    }

    private (CSharpCompilation? Compilation,
             Dictionary<string, (SyntaxTree Tree, TypeDeclarationSyntax Decl)>? Index) EnsureCompilation(CancellationToken ct)
    {
        IReadOnlyList<string> files;
        lock (_lock)
        {
            if (_compilation is not null && _typeIndex is not null)
                return (_compilation, _typeIndex);
            files = _files;
        }
        if (files.Count == 0) return (null, null);

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        var trees = new List<SyntaxTree>(files.Count);
        foreach (var f in files)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var text = File.ReadAllText(f);
                trees.Add(CSharpSyntaxTree.ParseText(text, parseOptions, path: f, cancellationToken: ct));
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[l2-parse] {f}: {ex.Message}");
            }
        }

        var compilation = CSharpCompilation.Create(
            "码图.L2", trees, _references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: true,
                nullableContextOptions: NullableContextOptions.Enable));

        var index = new Dictionary<string, (SyntaxTree Tree, TypeDeclarationSyntax Decl)>(StringComparer.Ordinal);
        foreach (var tree in trees)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var t in tree.GetRoot(ct).DescendantNodes().OfType<TypeDeclarationSyntax>())
            {
                var ns = SyntaxFacts.NamespacePath(t);
                index[SyntaxFacts.TypePath(t, ns)] = (tree, t);
            }
        }

        lock (_lock)
        {
            _compilation = compilation;
            _typeIndex = index;
            CompiledFileCount = trees.Count;
        }
        return (compilation, index);
    }

    private static TypeResolution NotPrecise(string typeId, string typeFqn, string reason)
        => new(typeId, typeFqn, false, reason, [], [], 0, 0);

    /// <summary>
    /// 诊断用：拿当前引用集编译一段源码并回传诊断。
    /// 「引用集不全导致解析降级」是这套设计里最难排查的一类问题，留一个能直接问的入口。
    /// </summary>
    public IReadOnlyList<string> ProbeCompile(string source)
    {
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest), path: "probe.cs");
        var compilation = CSharpCompilation.Create(
            "码图.Probe", [tree], _references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return compilation.GetDiagnostics()
            .Where(d => d.Severity >= DiagnosticSeverity.Warning)
            .Take(20)
            .Select(d => $"{d.Severity} {d.Id}: {d.GetMessage()}")
            .ToList();
    }

    /// <summary>
    /// 引用集：当前进程的可信平台程序集 + 应用目录下的 DLL。
    /// 不去解析工程的 NuGet 依赖图——那是 MSBuildWorkspace 的路线，方案 §2 已经否掉了。
    /// 引用缺失只会让解析退化成「不精确」，不会给出错误结果。
    /// </summary>
    /// <param name="projectRoot">
    /// 被分析项目的根目录。同名输出程序集（<c>&lt;根目录名&gt;.dll</c>）必须排除，
    /// 否则编译里会出现「源码声明的类型」与「元数据里的同名类型」两份，
    /// 解析可能落到元数据上，导致 DeclaringSyntaxReferences 为空、边被整片丢掉。
    /// </param>
    private static List<MetadataReference> BuildReferences(string projectRoot)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var refs = new List<MetadataReference>();
        var selfName = Path.GetFileName(projectRoot.TrimEnd(Path.DirectorySeparatorChar));

        void Add(string path)
        {
            var name = Path.GetFileNameWithoutExtension(path);
            if (string.IsNullOrEmpty(name)) return;
            if (name.Equals(selfName, StringComparison.OrdinalIgnoreCase)) return;
            if (name.EndsWith(".resources", StringComparison.OrdinalIgnoreCase)) return;
            if (seen.Contains(name)) return;
            // bin 目录里混着大量原生 DLL，它们没有托管元数据，
            // 加进去只会给编译塞一堆 CS0009，先把它们挡在门外。
            if (!HasManagedMetadata(path)) return;
            if (!seen.Add(name)) return;

            try { refs.Add(MetadataReference.CreateFromFile(path)); }
            catch (Exception ex)
            {
                // 静默吞掉会让「引用集不全」变成无法诊断的玄学，至少留下痕迹
                Console.Error.WriteLine($"[l2-refs] 跳过 {Path.GetFileName(path)}：{ex.Message}");
                seen.Remove(name);
            }
        }

        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            foreach (var p in tpa.Split(Path.PathSeparator))
                if (p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) Add(p);
        }

        try
        {
            foreach (var p in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll"))
                Add(p);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[l2-refs] {ex.Message}");
        }

        // 被分析项目自己 bin 目录里的 DLL：只要它构建过一次，第三方依赖（NuGet、
        // WinUI 之类的框架投影）就在这里，能显著提高解析成功率。加不进去也不会更糟。
        try
        {
            var binRoot = Path.Combine(projectRoot, "bin");
            if (Directory.Exists(binRoot))
            {
                var budget = 800;
                foreach (var p in Directory.EnumerateFiles(binRoot, "*.dll", SearchOption.AllDirectories))
                {
                    if (budget-- <= 0) break;
                    Add(p);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[l2-refs] 扫描项目 bin 失败：{ex.Message}");
        }

        return refs;
    }

    /// <summary>一个 DLL 是否带托管元数据。用 AssemblyName 读一下头即可，不加载程序集本体。</summary>
    private static bool HasManagedMetadata(string path)
    {
        try
        {
            System.Reflection.AssemblyName.GetAssemblyName(path);
            return true;
        }
        catch (BadImageFormatException) { return false; }  // 原生 DLL / 资源 DLL
        catch (Exception) { return false; }
    }
}
