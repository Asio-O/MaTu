using System.Collections.Generic;

namespace 码图.Graph;

/// <summary>单个方法在语法层可提取的信息。全部字段可 JSON 往返，供磁盘缓存使用。</summary>
public sealed record MethodSkeleton(
    string Name,
    string Signature,
    int Line,
    IReadOnlyList<string> Calls);

/// <summary>单个类型在语法层可提取的信息。</summary>
/// <param name="ReferencedNames">
/// 该类型正文里出现过的全部类型简单名（基类、字段/属性类型、方法参数与返回类型）与被调用方法名。
/// 反向索引建在它上面，用来做「某个文件变了，哪些类型的 L2 结果需要作废」的级联判断。
/// </param>
public sealed record TypeSkeleton(
    string Fqn,
    string Name,
    string Kind,
    string File,
    int Line,
    string Namespace,
    string? ParentFqn,
    IReadOnlyList<string> Fields,
    IReadOnlyList<string> Methods,
    IReadOnlyList<string> BaseTypes,
    IReadOnlyList<MethodSkeleton> MethodList,
    IReadOnlyList<string> ReferencedNames);

/// <summary>单个 .cs 文件的解析结果——L1 磁盘缓存的存储单元。</summary>
public sealed record FileSkeleton(
    string Path,
    string Hash,
    IReadOnlyList<TypeSkeleton> Types);
