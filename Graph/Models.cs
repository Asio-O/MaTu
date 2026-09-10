using System.Collections.Generic;

namespace 码图.Graph;

/// <summary>
/// 图节点。
/// <para><see cref="Kind"/>：namespace / class / interface / struct / record / type / method。</para>
/// <para><see cref="Line"/>：1 基行号；命名空间节点为 0。</para>
/// <para><see cref="ParentId"/>：包含关系上的父节点——方法指向所属类型，
/// 嵌套类型指向外层类型。</para>
/// </summary>
public sealed record GraphNode(
    string Id,
    string Label,
    string Kind,
    string Fqn,
    string File,
    int Line,
    string? ParentId = null,
    string? Namespace = null,
    IReadOnlyList<string>? Fields = null,
    IReadOnlyList<string>? Methods = null);

/// <summary>
/// 图边。<see cref="Kind"/>：
/// <list type="bullet">
/// <item><c>nsContains</c> 命名空间 → 顶层类型（归属，前端不画线）</item>
/// <item><c>typeContains</c> 外层类型 → 嵌套类型（归属虚线）</item>
/// <item><c>inherits</c> 类型继承/实现</item>
/// <item><c>typeCalls</c> 类型级调用聚合</item>
/// <item><c>nsInherits</c> / <c>nsCalls</c> 命名空间级聚合，折叠时可见</item>
/// <item><c>calls</c> 方法级精确调用，展开后可见</item>
/// </list>
/// </summary>
public sealed record GraphEdge(string Id, string Source, string Target, string Kind);

public sealed record GraphSnapshot(
    string ProjectId,
    string Root,
    long Version,
    IReadOnlyList<GraphNode> Nodes,
    IReadOnlyList<GraphEdge> Edges,
    int FileCount = 0,
    long ElapsedMs = 0,
    bool FromCache = false,
    int CachedFiles = 0,
    string Analyzer = "");
