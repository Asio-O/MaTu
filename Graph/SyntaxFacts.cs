using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace 码图.Graph;

/// <summary>
/// 语法层的纯函数事实提取。L1（<see cref="SkeletonBuilder"/>）与 L2（<see cref="SemanticResolver"/>）
/// 共用这里的实现，保证两边算出的类型路径、方法签名与节点 ID 完全一致——
/// 只要有一处不一致，L2 就会把边连到不存在的节点上。
/// </summary>
internal static class SyntaxFacts
{
    /// <summary>命名空间节点在显示层使用的名字。</summary>
    public const string GlobalNamespaceName = "<global>";

    public static string NamespacePath(SyntaxNode node)
    {
        var parts = new List<string>();
        foreach (var n in node.Ancestors().OfType<BaseNamespaceDeclarationSyntax>())
            parts.Add(n.Name.ToString());
        parts.Reverse();
        return parts.Count == 0 ? string.Empty : string.Join(".", parts);
    }

    public static string TypePath(TypeDeclarationSyntax type, string ns)
    {
        var parts = new List<string>();
        SyntaxNode? cur = type;
        while (cur is TypeDeclarationSyntax td)
        {
            parts.Insert(0, td.Identifier.Text);
            cur = td.Parent;
        }
        var path = string.Join(".", parts);
        return ns.Length == 0 ? path : $"{ns}.{path}";
    }

    /// <summary>方法签名，形如 <c>Foo(int, string)</c>。节点 ID 由类型 FQN + 它拼成。</summary>
    public static string Signature(MethodDeclarationSyntax m)
    {
        var parameters = string.Join(", ", m.ParameterList.Parameters.Select(p => p.Type?.ToString() ?? "?"));
        return $"{m.Identifier.Text}({parameters})";
    }

    public static string Accessibility(SyntaxTokenList mods)
    {
        if (mods.Any(m => m.IsKind(SyntaxKind.PublicKeyword))) return "+";
        if (mods.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword))) return "#";
        if (mods.Any(m => m.IsKind(SyntaxKind.InternalKeyword))) return "~";
        return "-"; // private 或无修饰符
    }

    public static string TypeKindOf(TypeDeclarationSyntax t) => t switch
    {
        RecordDeclarationSyntax => "record",
        InterfaceDeclarationSyntax => "interface",
        StructDeclarationSyntax => "struct",
        ClassDeclarationSyntax => "class",
        _ => "type"
    };

    /// <summary>去掉泛型参数、可空、数组、指针与 global:: 限定，只留可匹配的类型名。</summary>
    public static string NormalizeTypeName(string raw)
    {
        var name = raw.Trim();
        if (name.StartsWith("global::", StringComparison.Ordinal)) name = name[8..];
        var lt = name.IndexOf('<');
        if (lt >= 0) name = name[..lt];
        name = name.TrimEnd('?', '[', ']', '*', ' ', ')');
        return name.Trim();
    }

    /// <summary>
    /// 取类型名里最后一个命名空间分隔点之后的部分，忽略泛型参数内部的点。
    /// <c>System.Collections.Generic.List&lt;System.Int32&gt;</c> → <c>List&lt;System.Int32&gt;</c>
    /// </summary>
    public static string LastSegment(string name)
    {
        var depth = 0;
        var cut = -1;
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (c == '<') depth++;
            else if (c == '>') depth = Math.Max(0, depth - 1);
            else if (c == '.' && depth == 0) cut = i;
        }
        return cut < 0 ? name : name[(cut + 1)..];
    }

    public static string? SimpleCalleeName(ExpressionSyntax expr) => expr switch
    {
        IdentifierNameSyntax id => id.Identifier.Text,
        MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
        GenericNameSyntax g => g.Identifier.Text,
        _ => null
    };
}
