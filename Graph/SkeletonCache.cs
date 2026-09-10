using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace 码图.Graph;

/// <summary>
/// L1 磁盘缓存。布局（方案 §7.3）：
/// <code>
/// %LOCALAPPDATA%\码图\cache\&lt;项目根路径哈希&gt;\
///     meta.json         缓存格式版本 / 项目根 / 最后打开时间
///     files.json        文件路径 → 内容哈希
///     skeletons\&lt;哈希&gt;.json   该内容对应的 FileSkeleton
/// </code>
/// 键是「内容哈希」而不是路径：改一个文件只会让它自己多出一份新缓存，
/// 其余文件的解析结果原样复用。
/// </summary>
public sealed class SkeletonCache
{
    /// <summary>
    /// 缓存格式版本。解析逻辑一旦变化（字段增删、语义调整）必须 +1，
    /// 否则会反序列化出一堆空字段——这是方案 §7.3 点名的坑。
    /// </summary>
    public const int FormatVersion = 2;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private sealed record CacheMeta(
        int FormatVersion,
        string Root,
        DateTimeOffset LastOpenUtc,
        int FileCount,
        int SkeletonCount);

    private readonly string _root;
    private readonly string _dir;
    private readonly string _skeletonDir;
    private readonly object _writeLock = new();
    private readonly ConcurrentDictionary<string, FileSkeleton> _memory = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _index = new(StringComparer.OrdinalIgnoreCase);
    private int _hits;
    private int _misses;

    public bool Enabled { get; private set; }
    public string Directory => _dir;
    public int Hits => Volatile.Read(ref _hits);
    public int Misses => Volatile.Read(ref _misses);
    public int KnownFiles => _index.Count;
    public int LoadedFromDisk { get; private set; }
    public int TrimmedFiles { get; private set; }
    public string? LastError { get; private set; }

    public SkeletonCache(string projectRoot)
    {
        _root = projectRoot;
        try
        {
            var normalized = Path.GetFullPath(projectRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                .ToLowerInvariant();
            var key = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes(normalized)))[..16]
                .ToLowerInvariant();

            var baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "码图", "cache", key);

            _dir = baseDir;
            _skeletonDir = Path.Combine(baseDir, "skeletons");
            System.IO.Directory.CreateDirectory(_skeletonDir);
            Enabled = true;
        }
        catch (Exception ex)
        {
            _dir = string.Empty;
            _skeletonDir = string.Empty;
            Enabled = false;
            LastError = ex.Message;
            Console.Error.WriteLine($"[cache] 初始化失败：{ex.Message}");
            return;
        }

        LoadIndex();
        Trim();
    }

    public FileSkeleton? TryGet(string path, string hash)
    {
        if (!Enabled) return null;

        if (!_index.TryGetValue(path, out var known) || !string.Equals(known, hash, StringComparison.Ordinal))
        {
            Interlocked.Increment(ref _misses);
            return null;
        }

        if (_memory.TryGetValue(hash, out var inMemory))
        {
            Interlocked.Increment(ref _hits);
            return inMemory with { Path = path };
        }

        try
        {
            var file = Path.Combine(_skeletonDir, hash + ".json");
            if (!File.Exists(file))
            {
                Interlocked.Increment(ref _misses);
                return null;
            }

            var skeleton = JsonSerializer.Deserialize<FileSkeleton>(File.ReadAllText(file), Json);
            if (skeleton?.Types is null)
            {
                Interlocked.Increment(ref _misses);
                return null;
            }

            _memory[hash] = skeleton;
            Interlocked.Increment(ref _hits);
            return skeleton with { Path = path };
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Interlocked.Increment(ref _misses);
            return null;
        }
    }

    public void Store(FileSkeleton skeleton)
    {
        if (!Enabled) return;
        try
        {
            // 先登记索引再落盘：Trim 只删「索引里没有」的哈希文件，顺序反了会误删。
            _index[skeleton.Path] = skeleton.Hash;
            _memory[skeleton.Hash] = skeleton;

            var file = Path.Combine(_skeletonDir, skeleton.Hash + ".json");
            if (File.Exists(file)) return;

            lock (_writeLock)
            {
                if (File.Exists(file)) return;
                var tmp = file + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(skeleton, Json));
                File.Move(tmp, file, overwrite: true);
            }
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Console.Error.WriteLine($"[cache] 写入失败：{ex.Message}");
        }
    }

    /// <summary>把索引与元数据写回磁盘。字典很小，直接整体覆盖，不做增量。</summary>
    public void Save()
    {
        if (!Enabled) return;
        try
        {
            var meta = new CacheMeta(
                FormatVersion, _root, DateTimeOffset.UtcNow, _index.Count, _memory.Count);
            File.WriteAllText(Path.Combine(_dir, "meta.json"), JsonSerializer.Serialize(meta, Json));
            File.WriteAllText(
                Path.Combine(_dir, "files.json"),
                JsonSerializer.Serialize(new SortedDictionary<string, string>(_index, StringComparer.OrdinalIgnoreCase), Json));
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Console.Error.WriteLine($"[cache] 保存失败：{ex.Message}");
        }
    }

    private void LoadIndex()
    {
        try
        {
            var metaPath = Path.Combine(_dir, "meta.json");
            var indexPath = Path.Combine(_dir, "files.json");
            if (!File.Exists(metaPath) || !File.Exists(indexPath)) return;

            var meta = JsonSerializer.Deserialize<CacheMeta>(File.ReadAllText(metaPath), Json);
            if (meta is null || meta.FormatVersion != FormatVersion)
            {
                Reset($"缓存格式版本不匹配（磁盘 {meta?.FormatVersion.ToString() ?? "?"} / 期望 {FormatVersion}）");
                return;
            }

            var index = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(indexPath), Json);
            if (index is null)
            {
                Reset("索引文件为空");
                return;
            }

            foreach (var kv in index) _index[kv.Key] = kv.Value;
            LoadedFromDisk = _index.Count;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Reset($"索引读取失败：{ex.Message}");
        }
    }

    /// <summary>版本不符或索引损坏时整目录清掉重扫——绝不尝试「尽量复用」半个缓存。</summary>
    private void Reset(string reason)
    {
        Console.Error.WriteLine($"[cache] {reason}，清空重建");
        _index.Clear();
        _memory.Clear();
        LoadedFromDisk = 0;
        try
        {
            if (System.IO.Directory.Exists(_dir))
                System.IO.Directory.Delete(_dir, recursive: true);
            System.IO.Directory.CreateDirectory(_skeletonDir);
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Enabled = false;
        }
    }

    /// <summary>启动时清掉索引里已经没有的哈希文件，避免缓存目录无限长大。</summary>
    private void Trim()
    {
        if (!Enabled) return;
        try
        {
            var keep = new HashSet<string>(_index.Values.Select(h => h + ".json"), StringComparer.Ordinal);
            var removed = 0;
            foreach (var f in System.IO.Directory.EnumerateFiles(_skeletonDir, "*.json"))
            {
                if (keep.Contains(Path.GetFileName(f))) continue;
                try { File.Delete(f); removed++; } catch { /* 被占用就算了，下次再说 */ }
            }
            TrimmedFiles = removed;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[cache] 清理失败：{ex.Message}");
        }
    }

    public override string ToString()
        => Enabled
            ? $"{_dir}（已知 {_index.Count} 文件，命中 {Hits} / 未命中 {Misses}，清理 {TrimmedFiles}）"
            : $"不可用：{LastError}";
}
