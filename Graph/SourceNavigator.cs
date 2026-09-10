using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

namespace 码图.Graph;

public sealed record NavigationResult(bool Success, string Target, string Message);

/// <summary>只做探测、不启动任何进程，供自检与「跳转失败」提示使用。</summary>
public sealed record EditorCandidate(string Kind, string Path);

/// <summary>
/// 把「点击方法节点」变成「在编辑器里打开对应行」。
/// 优先级：VS Code → Visual Studio → 系统默认程序。
/// 探测失败不抛异常，只把原因回传给前端显示——方案 §11 的防御式渲染。
/// </summary>
public static class SourceNavigator
{
    /// <summary>当前机器上探测到的首选编辑器；没有则返回 null（会退化成系统默认程序）。</summary>
    public static EditorCandidate? Detect()
    {
        var code = FindVsCode();
        if (code is not null) return new EditorCandidate("VS Code", code);
        var vs = FindVisualStudio();
        if (vs is not null) return new EditorCandidate("Visual Studio", vs);
        return null;
    }

    public static NavigationResult Open(string file, int line)
    {
        if (string.IsNullOrWhiteSpace(file) || !File.Exists(file))
            return new NavigationResult(false, string.Empty, $"文件不存在：{file}");

        var line1 = Math.Max(1, line);
        var errors = new System.Collections.Generic.List<string>();
        var codeErr = string.Empty;
        var vsErr = string.Empty;

        var code = FindVsCode();
        if (code is not null && TryStart(code, $"--goto \"{file}\":{line1}", out codeErr))
            return new NavigationResult(true, "VS Code", $"{Path.GetFileName(file)}:{line1}");
        if (code is null) errors.Add("未找到 VS Code");
        else errors.Add($"VS Code 启动失败：{codeErr}");

        var devenv = FindVisualStudio();
        if (devenv is not null && TryStart(devenv, $"/edit \"{file}\" /command \"Edit.Goto {line1}\"", out vsErr))
            return new NavigationResult(true, "Visual Studio", $"{Path.GetFileName(file)}:{line1}");
        if (devenv is null) errors.Add("未找到 Visual Studio");
        else errors.Add($"Visual Studio 启动失败：{vsErr}");

        try
        {
            Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
            return new NavigationResult(true, "系统默认程序", Path.GetFileName(file));
        }
        catch (Exception ex)
        {
            errors.Add(ex.Message);
        }

        return new NavigationResult(false, string.Empty, string.Join("；", errors));
    }

    private static bool TryStart(string exe, string arguments, out string error)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe, arguments)
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(exe) ?? string.Empty,
            });
            error = string.Empty;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    private static string? FindVsCode()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var candidates = new[]
        {
            Path.Combine(local, "Programs", "Microsoft VS Code", "Code.exe"),
            Path.Combine(local, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Microsoft VS Code", "Code.exe"),
        };
        foreach (var c in candidates)
            if (File.Exists(c)) return c;

        return FindOnPath("code.exe") ?? FindOnPath("code.cmd");
    }

    private static string? FindVisualStudio()
    {
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        var vswhere = Path.Combine(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
        if (File.Exists(vswhere))
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo(vswhere,
                    "-latest -prerelease -products * -property productPath")
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                if (p is not null)
                {
                    var path = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(5000);
                    if (path.Length > 0 && File.Exists(path)) return path;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[vswhere] {ex.Message}");
            }
        }

        // 兜底：直接扫安装目录，devenv.exe 的层级固定
        foreach (var root in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     pf86,
                 })
        {
            var vsRoot = Path.Combine(root, "Microsoft Visual Studio");
            if (!Directory.Exists(vsRoot)) continue;
            try
            {
                foreach (var edition in Directory.EnumerateDirectories(vsRoot))
                {
                    var devenv = Path.Combine(edition, "Common7", "IDE", "devenv.exe");
                    if (File.Exists(devenv)) return devenv;

                    foreach (var version in Directory.EnumerateDirectories(edition))
                    {
                        devenv = Path.Combine(version, "Common7", "IDE", "devenv.exe");
                        if (File.Exists(devenv)) return devenv;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[vs-scan] {ex.Message}");
            }
        }

        return null;
    }

    private static string? FindOnPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(path)) return null;
        foreach (var dir in path.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var full = Path.Combine(dir.Trim(), fileName);
                if (File.Exists(full)) return full;
            }
            catch { /* PATH 里有非法项，跳过 */ }
        }
        return null;
    }
}
