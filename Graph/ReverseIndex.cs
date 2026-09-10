using System;
using System.Collections.Generic;
using System.Linq;

namespace 码图.Graph;

/// <summary>
/// 反向索引：从「名字」回到「声明它的文件」与「引用它的文件」。
/// <para>用途是方案 §7.2 的「精确级联失效」——一个文件改了，不必把整个 L2 缓存清空，
/// 只需要作废「改动的文件自身声明的类型」以及「引用了这些类型的类型」。</para>
/// </summary>
public sealed class ReverseIndex
{
    /// <summary>类型简单名 → 引用了它的文件。</summary>
    private readonly Dictionary<string, HashSet<string>> _referencedByFile = new(StringComparer.Ordinal);

    /// <summary>文件 → 它声明的类型简单名。</summary>
    private readonly Dictionary<string, HashSet<string>> _declaredByFile =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>文件 → 它声明的类型 FQN。</summary>
    private readonly Dictionary<string, HashSet<string>> _typesByFile =
        new(StringComparer.OrdinalIgnoreCase);

    public int ReferencedNames => _referencedByFile.Count;
    public int Files => _typesByFile.Count;

    public static ReverseIndex Build(IEnumerable<FileSkeleton> skeletons)
    {
        var index = new ReverseIndex();
        foreach (var file in skeletons)
        {
            var declared = new HashSet<string>(StringComparer.Ordinal);
            var types = new HashSet<string>(StringComparer.Ordinal);

            foreach (var t in file.Types)
            {
                declared.Add(t.Name);
                types.Add(t.Fqn);
                foreach (var name in t.ReferencedNames)
                {
                    if (!index._referencedByFile.TryGetValue(name, out var set))
                        index._referencedByFile[name] = set = new HashSet<string>(StringComparer.Ordinal);
                    set.Add(file.Path);
                }
            }

            index._declaredByFile[file.Path] = declared;
            index._typesByFile[file.Path] = types;
        }
        return index;
    }

    /// <summary>引用了某个简单名的文件。</summary>
    public IReadOnlyCollection<string> ReferencingFiles(string simpleName)
        => _referencedByFile.TryGetValue(simpleName, out var set) ? set : [];

    /// <summary>某个文件声明的类型 FQN。</summary>
    public IReadOnlyCollection<string> DeclaredTypes(string file)
        => _typesByFile.TryGetValue(file, out var set) ? set : [];

    /// <summary>
    /// 给定变化的文件集合，返回需要重新精确解析的类型 FQN。
    /// 只要有一个变化文件不在索引里（新增或刚被删），就只能保守返回 <c>null</c> 表示「全部作废」。
    /// </summary>
    public IReadOnlyCollection<string>? AffectedTypes(IEnumerable<string> changedFiles)
    {
        var affected = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in changedFiles)
        {
            if (!_declaredByFile.TryGetValue(file, out var declared))
                return null; // 未知文件：无法推断影响面

            if (_typesByFile.TryGetValue(file, out var own))
                affected.UnionWith(own);

            foreach (var name in declared)
            {
                if (!_referencedByFile.TryGetValue(name, out var referrers)) continue;
                foreach (var referrer in referrers)
                    if (_typesByFile.TryGetValue(referrer, out var types))
                        affected.UnionWith(types);
            }
        }

        return affected;
    }
}
