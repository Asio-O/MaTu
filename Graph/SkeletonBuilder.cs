using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace 码图.Graph;

/// <summary>
/// L1 语法骨架构建器。分两步：
/// <list type="number">
/// <item><see cref="ParseFile"/> 把一个 .cs 文件解析成可缓存的 <see cref="FileSkeleton"/>；</item>
/// <item><see cref="Compose"/> 把若干 <see cref="FileSkeleton"/> 组装成图（节点 + 边）。</item>
/// </list>
/// 拆分的原因是磁盘缓存按「文件内容哈希 → FileSkeleton」存取，组装阶段必须保持廉价且确定性。
/// </summary>
public static class SkeletonBuilder
{
    /// <summary>全局命名空间（没有 namespace 声明的类型）在此以保持一致的标识。</summary>
    public static string GlobalNamespaceName => SyntaxFacts.GlobalNamespaceName;

    private static readonly HashSet<string> IgnoredBases = new(StringComparer.Ordinal)
    {
        "object", "Object", "ValueType", "Enum", "Delegate", "MulticastDelegate",
        "Array", "Attribute", "Exception", "EventArgs",
        "IDisposable", "IAsyncDisposable",
        "IComparable", "IEquatable",
        "IEnumerable", "ICollection", "IList", "IDictionary",
        "IReadOnlyCollection", "IReadOnlyList", "IReadOnlyDictionary",
        "IAsyncEnumerable", "IAsyncEnumerator",
        "INotifyPropertyChanged", "ICommand",
    };

    private const int MaxFieldsPerNode = 6;
    private const int MaxMethodsPerNode = 8;

    // ==================================================================
    //  第一步：文件 → FileSkeleton
    // ==================================================================

    public static FileSkeleton ParseFile(string file, CancellationToken ct = default)
    {
        var bytes = File.ReadAllBytes(file);
        return ParseBytes(file, bytes, ct);
    }

    /// <summary>解析已经读进内存的字节（磁盘缓存需要先算哈希，避免二次读盘）。</summary>
    public static FileSkeleton ParseBytes(string path, byte[] bytes, CancellationToken ct = default)
        => ParseText(path, Decode(bytes), Hash(bytes), ct);

    /// <summary>解析已经在内存里的源码文本（供缓存命中校验与测试使用）。</summary>
    public static FileSkeleton ParseText(string path, string text, string hash, CancellationToken ct = default)
    {
        var tree = CSharpSyntaxTree.ParseText(
            text, new CSharpParseOptions(LanguageVersion.Latest),
            path: path, cancellationToken: ct);
        var root = tree.GetRoot(ct);

        var types = new List<TypeSkeleton>();
        foreach (var t in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
        {
            ct.ThrowIfCancellationRequested();

            var ns = SyntaxFacts.NamespacePath(t);
            var typeFqn = SyntaxFacts.TypePath(t, ns);
            var parentFqn = t.Parent is TypeDeclarationSyntax outer ? SyntaxFacts.TypePath(outer, ns) : null;
            var line = t.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

            var fields = new List<string>();
            var methods = new List<string>();
            var methodList = new List<MethodSkeleton>();
            var referenced = new HashSet<string>(StringComparer.Ordinal);

            foreach (var member in t.Members)
            {
                switch (member)
                {
                    case FieldDeclarationSyntax f:
                        {
                            var acc = SyntaxFacts.Accessibility(f.Modifiers);
                            CollectReferenced(referenced, f.Declaration.Type);
                            foreach (var v in f.Declaration.Variables)
                                fields.Add($"{acc} {v.Identifier.Text}: {f.Declaration.Type}");
                            break;
                        }
                    case PropertyDeclarationSyntax p:
                        {
                            var acc = SyntaxFacts.Accessibility(p.Modifiers);
                            CollectReferenced(referenced, p.Type);
                            fields.Add($"{acc} {p.Identifier.Text}: {p.Type}");
                            break;
                        }
                    case MethodDeclarationSyntax m:
                        {
                            var acc = SyntaxFacts.Accessibility(m.Modifiers);
                            var signature = SyntaxFacts.Signature(m);
                            var name = m.Identifier.Text;

                            methods.Add($"{acc} {signature}: {m.ReturnType}");
                            CollectReferenced(referenced, m.ReturnType);
                            foreach (var pp in m.ParameterList.Parameters)
                                CollectReferenced(referenced, pp.Type);

                            var calls = new List<string>();
                            foreach (var inv in m.DescendantNodes().OfType<InvocationExpressionSyntax>())
                            {
                                var callee = SyntaxFacts.SimpleCalleeName(inv.Expression);
                                if (callee is null) continue;
                                if (!calls.Contains(callee)) calls.Add(callee);
                                referenced.Add(callee);

                                // 接收者名字也要记：SkeletonBuilder.SymbolKey(...) 依赖的是 SkeletonBuilder，
                                // 只记方法名 SymbolKey 会让反向索引漏掉这条边。
                                if (inv.Expression is MemberAccessExpressionSyntax ma &&
                                    ma.Expression is IdentifierNameSyntax receiver)
                                {
                                    referenced.Add(receiver.Identifier.Text);
                                }
                            }

                            methodList.Add(new MethodSkeleton(
                                name, signature,
                                m.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                                calls));
                            break;
                        }
                }
            }

            var bases = new List<string>();
            foreach (var b in t.BaseList?.Types ?? Enumerable.Empty<BaseTypeSyntax>())
            {
                var name = SyntaxFacts.NormalizeTypeName(b.Type.ToString());
                if (name.Length == 0 || IgnoredBases.Contains(name)) continue;
                bases.Add(name);
                referenced.Add(SyntaxFacts.LastSegment(name));
            }

            types.Add(new TypeSkeleton(
                typeFqn, t.Identifier.Text, SyntaxFacts.TypeKindOf(t), path, line, ns, parentFqn,
                fields, methods, bases, methodList,
                referenced.OrderBy(x => x, StringComparer.Ordinal).ToList()));
        }

        return new FileSkeleton(path, hash, types);
    }

    /// <summary>并行解析一批文件。单个文件失败只记录日志，不影响整批。</summary>
    public static List<FileSkeleton> ParseFiles(
        IEnumerable<string> files, CancellationToken ct = default,
        Action<string, Exception>? onError = null)
    {
        var bag = new ConcurrentBag<FileSkeleton>();
        Parallel.ForEach(files, new ParallelOptions
        {
            CancellationToken = ct,
            MaxDegreeOfParallelism = Environment.ProcessorCount
        }, file =>
        {
            try { bag.Add(ParseFile(file, ct)); }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { onError?.Invoke(file, ex); }
        });
        return bag.ToList();
    }

    /// <summary>
    /// 并行解析一批文件，优先命中磁盘 L1 缓存（按文件内容哈希）。
    /// 冷启动是「读文件 + 解析」，热启动只剩「读文件 + 读缓存 JSON」。
    /// </summary>
    public static List<FileSkeleton> ParseFilesCached(
        IEnumerable<string> files, SkeletonCache? cache, CancellationToken ct = default,
        Action<string, Exception>? onError = null)
    {
        if (cache is null || !cache.Enabled) return ParseFiles(files, ct, onError);

        var bag = new ConcurrentBag<FileSkeleton>();
        Parallel.ForEach(files, new ParallelOptions
        {
            CancellationToken = ct,
            MaxDegreeOfParallelism = Environment.ProcessorCount
        }, file =>
        {
            try
            {
                var bytes = File.ReadAllBytes(file);
                var hash = Hash(bytes);

                var hit = cache.TryGet(file, hash);
                if (hit is not null) { bag.Add(hit); return; }

                var parsed = ParseText(file, Decode(bytes), hash, ct);
                cache.Store(parsed);
                bag.Add(parsed);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) { onError?.Invoke(file, ex); }
        });
        return bag.ToList();
    }

    // ==================================================================
    //  第二步：FileSkeleton 集合 → 图
    // ==================================================================

    public static (List<GraphNode> Nodes, List<GraphEdge> Edges) Build(
        IEnumerable<string> files, CancellationToken ct = default)
    {
        var parsed = ParseFiles(files, ct,
            (f, ex) => Console.Error.WriteLine($"[parse] {f}: {ex.Message}"));
        return Compose(parsed, ct);
    }

    /// <summary>与 <see cref="Build"/> 相同，但先过一遍磁盘 L1 缓存。</summary>
    public static (List<GraphNode> Nodes, List<GraphEdge> Edges) BuildCached(
        IEnumerable<string> files, SkeletonCache? cache, CancellationToken ct = default)
    {
        var parsed = ParseFilesCached(files, cache, ct,
            (f, ex) => Console.Error.WriteLine($"[parse] {f}: {ex.Message}"));
        return Compose(parsed, ct);
    }

    public static (List<GraphNode> Nodes, List<GraphEdge> Edges) Compose(
        IEnumerable<FileSkeleton> files, CancellationToken ct = default)
    {
        // —— 1. 合并 partial 声明：同一 FQN 的多个片段拼成一个类型 ——
        var accs = new Dictionary<string, TypeAccumulator>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var f in files)
        {
            foreach (var t in f.Types)
            {
                if (!accs.TryGetValue(t.Fqn, out var acc))
                {
                    acc = new TypeAccumulator(t);
                    accs[t.Fqn] = acc;
                    order.Add(t.Fqn);
                }
                else acc.Merge(t);
            }
        }

        var nodes = new List<GraphNode>();
        var edges = new List<GraphEdge>();
        var edgeIds = new HashSet<string>(StringComparer.Ordinal);

        var fqns = new HashSet<string>(accs.Keys, StringComparer.Ordinal);
        var nsOf = accs.Values.ToDictionary(a => a.Head.Fqn, a => a.Head.Namespace, StringComparer.Ordinal);
        var bySimpleName = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var fqn in accs.Keys)
        {
            var simple = SimpleName(fqn);
            if (!bySimpleName.TryGetValue(simple, out var list))
                bySimpleName[simple] = list = new List<string>();
            list.Add(fqn);
        }
        foreach (var list in bySimpleName.Values) list.Sort(StringComparer.Ordinal);

        // —— 2. 命名空间节点 ——
        var namespaces = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var a in accs.Values) namespaces.Add(a.Head.Namespace);
        foreach (var ns in namespaces)
            nodes.Add(new GraphNode(
                NamespaceId(ns), DisplayNamespace(ns), "namespace", ns, string.Empty, 0,
                Namespace: ns));

        // —— 3. 类型节点 ——
        var typeIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var fqnById = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var fqn in order)
        {
            ct.ThrowIfCancellationRequested();
            var acc = accs[fqn];
            var t = acc.Head;
            var id = SymbolKey(fqn);
            typeIds[fqn] = id;
            fqnById[id] = fqn;

            var parentId = t.ParentFqn is not null && fqns.Contains(t.ParentFqn)
                ? SymbolKey(t.ParentFqn)
                : NamespaceId(t.Namespace);

            nodes.Add(new GraphNode(
                id, t.Name, t.Kind, fqn, t.File, t.Line,
                parentId, t.Namespace,
                Truncate(acc.Fields, MaxFieldsPerNode, "… 还有 {0} 项"),
                Truncate(acc.Methods, MaxMethodsPerNode, "… 还有 {0} 个")));

            if (t.ParentFqn is not null && fqns.Contains(t.ParentFqn))
            {
                var outerId = SymbolKey(t.ParentFqn);
                AddEdge(edges, edgeIds, outerId, id, "typeContains");
            }
            else
            {
                AddEdge(edges, edgeIds, NamespaceId(t.Namespace), id, "nsContains");
            }
        }

        // —— 4. 方法节点（ID 含签名，重载互不冲突）——
        var methodIdsBySimpleName = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var fqn in order)
        {
            var acc = accs[fqn];
            var typeId = typeIds[fqn];
            foreach (var m in acc.MethodList)
            {
                var methodId = SymbolKey($"{fqn}.{m.Signature}");
                nodes.Add(new GraphNode(
                    methodId, m.Name, "method", $"{fqn}.{m.Signature}",
                    acc.Head.File, m.Line, typeId, acc.Head.Namespace));

                if (!methodIdsBySimpleName.TryGetValue(m.Name, out var list))
                    methodIdsBySimpleName[m.Name] = list = new List<string>();
                list.Add(methodId);
            }
        }

        var nodeIds = new HashSet<string>(nodes.Select(n => n.Id), StringComparer.Ordinal);
        var parentOf = nodes.ToDictionary(n => n.Id, n => n.ParentId, StringComparer.Ordinal);

        // —— 5. inherits ——
        var inherits = new List<(string Src, string Dst)>();
        foreach (var fqn in order)
        {
            var acc = accs[fqn];
            var dst = typeIds[fqn];
            foreach (var raw in acc.BaseTypes)
            {
                foreach (var target in ResolveTypeName(raw, acc.Head.Namespace, fqns, nsOf, bySimpleName))
                {
                    var src = typeIds[target];
                    if (src == dst) continue;
                    if (!nodeIds.Contains(src)) continue;
                    inherits.Add((src, dst));
                }
            }
        }
        foreach (var (src, dst) in inherits.Distinct())
            AddEdge(edges, edgeIds, src, dst, "inherits");

        // —— 6. calls（L1 简单名匹配，天然的虚边由 L2 精确化）——
        var calls = new List<(string Src, string Dst)>();
        foreach (var fqn in order)
        {
            var acc = accs[fqn];
            foreach (var m in acc.MethodList)
            {
                var callerId = SymbolKey($"{fqn}.{m.Signature}");
                foreach (var callee in m.Calls)
                {
                    if (!methodIdsBySimpleName.TryGetValue(callee, out var targets)) continue;
                    foreach (var targetId in targets)
                    {
                        if (targetId == callerId) continue;
                        if (!nodeIds.Contains(targetId)) continue;
                        calls.Add((callerId, targetId));
                    }
                }
            }
        }
        foreach (var (src, dst) in calls.Distinct())
            AddEdge(edges, edgeIds, src, dst, "calls");

        // —— 7. 逐级聚合：方法 → 类型 → 命名空间 ——
        var typeCalls = new HashSet<(string Src, string Dst)>();
        foreach (var (src, dst) in calls)
        {
            var st = parentOf.GetValueOrDefault(src);
            var dt = parentOf.GetValueOrDefault(dst);
            if (st is null || dt is null || st == dt) continue;
            typeCalls.Add((st, dt));
        }
        foreach (var (src, dst) in typeCalls.OrderBy(x => x.Src, StringComparer.Ordinal)
                                            .ThenBy(x => x.Dst, StringComparer.Ordinal))
            AddEdge(edges, edgeIds, src, dst, "typeCalls");

        var nsInherits = new HashSet<(string Src, string Dst)>();
        foreach (var (src, dst) in inherits)
        {
            if (!fqnById.TryGetValue(src, out var sf) || !fqnById.TryGetValue(dst, out var df)) continue;
            var sn = NamespaceId(nsOf[sf]);
            var dn = NamespaceId(nsOf[df]);
            if (sn == dn) continue;
            nsInherits.Add((sn, dn));
        }
        foreach (var (src, dst) in nsInherits)
            AddEdge(edges, edgeIds, src, dst, "nsInherits");

        var nsCalls = new HashSet<(string Src, string Dst)>();
        foreach (var (src, dst) in typeCalls)
        {
            if (!fqnById.TryGetValue(src, out var sf) || !fqnById.TryGetValue(dst, out var df)) continue;
            var sn = NamespaceId(nsOf[sf]);
            var dn = NamespaceId(nsOf[df]);
            if (sn == dn) continue;
            nsCalls.Add((sn, dn));
        }
        foreach (var (src, dst) in nsCalls)
            AddEdge(edges, edgeIds, src, dst, "nsCalls");

        return (nodes, edges);
    }

    // ==================================================================
    //  工具
    // ==================================================================

    private sealed class TypeAccumulator
    {
        public TypeSkeleton Head { get; }
        public List<string> Fields { get; } = [];
        public List<string> Methods { get; } = [];
        public List<MethodSkeleton> MethodList { get; } = [];
        public List<string> BaseTypes { get; } = [];

        public TypeAccumulator(TypeSkeleton head)
        {
            Head = head;
            Fields.AddRange(head.Fields);
            Methods.AddRange(head.Methods);
            MethodList.AddRange(head.MethodList);
            BaseTypes.AddRange(head.BaseTypes);
        }

        public void Merge(TypeSkeleton part)
        {
            Fields.AddRange(part.Fields);
            Methods.AddRange(part.Methods);
            MethodList.AddRange(part.MethodList);
            BaseTypes.AddRange(part.BaseTypes);
        }
    }

    private static void AddEdge(
        List<GraphEdge> edges, HashSet<string> seen, string src, string dst, string kind)
    {
        var id = $"{kind}:{src}->{dst}";
        if (!seen.Add(id)) return;
        edges.Add(new GraphEdge(id, src, dst, kind));
    }

    private static IReadOnlyList<string> Truncate(List<string> items, int max, string moreFormat)
    {
        if (items.Count <= max) return items;
        var result = items.Take(max).ToList();
        result.Add(string.Format(moreFormat, items.Count - max));
        return result;
    }

    private static string TypeKindOf(TypeDeclarationSyntax t) => SyntaxFacts.TypeKindOf(t);

    private static void CollectReferenced(HashSet<string> into, TypeSyntax? type)
    {
        if (type is null) return;
        var name = SyntaxFacts.LastSegment(SyntaxFacts.NormalizeTypeName(type.ToString()));
        if (name.Length > 0) into.Add(name);
    }

    private static string BuildNamespacePath(SyntaxNode node) => SyntaxFacts.NamespacePath(node);

    private static string BuildTypePath(TypeDeclarationSyntax t, string ns) => SyntaxFacts.TypePath(t, ns);

    private static string NormalizeTypeName(string raw) => SyntaxFacts.NormalizeTypeName(raw);

    private static string SimpleName(string fqn) => SyntaxFacts.LastSegment(fqn);

    /// <summary>类型名 → 候选 FQN。优先同命名空间，其次全名后缀匹配，最后同名兜底。</summary>
    private static IReadOnlyList<string> ResolveTypeName(
        string raw, string fromNamespace,
        HashSet<string> allFqns,
        Dictionary<string, string> nsOf,
        Dictionary<string, List<string>> bySimpleName)
    {
        var name = NormalizeTypeName(raw);
        if (name.Length == 0) return [];

        if (allFqns.Contains(name)) return [name];

        var last = SimpleName(name);
        if (!bySimpleName.TryGetValue(last, out var candidates) || candidates.Count == 0)
            return [];

        if (name.Contains('.'))
        {
            var suffix = "." + name;
            var bySuffix = candidates.Where(c => c.EndsWith(suffix, StringComparison.Ordinal)).ToList();
            if (bySuffix.Count > 0) return bySuffix;
        }

        var sameNs = candidates.Where(c => nsOf.TryGetValue(c, out var ns) && ns == fromNamespace).ToList();
        return sameNs.Count > 0 ? sameNs : candidates;
    }

    public static string DisplayNamespace(string ns) => ns.Length == 0 ? GlobalNamespaceName : ns;

    public static string NamespaceId(string ns) => SymbolKey("ns:" + ns);

    public static string SymbolKey(string fqn)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(fqn));
        return Convert.ToHexString(bytes)[..16].ToLowerInvariant();
    }

    public static string Hash(byte[] bytes)
    {
        var h = SHA1.HashData(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    private static string Decode(byte[] b)
    {
        if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF)
            return Encoding.UTF8.GetString(b, 3, b.Length - 3);
        if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE)
            return Encoding.Unicode.GetString(b, 2, b.Length - 2);
        if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2);
        return Encoding.UTF8.GetString(b);
    }
}
