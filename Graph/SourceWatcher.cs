using System;
using System.IO;
using System.Threading;

namespace 码图.Graph;

public sealed class SourceWatcher : IDisposable
{
    private readonly FileSystemWatcher _fsw;
    private readonly Action _onChanged;
    private readonly TimeSpan _debounce;
    private readonly object _lock = new();
    private Timer? _timer;

    public SourceWatcher(string root, Action onChanged, TimeSpan? debounce = null)
    {
        _onChanged = onChanged;
        _debounce = debounce ?? TimeSpan.FromMilliseconds(400);

        _fsw = new FileSystemWatcher(root, "*.cs")
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
            InternalBufferSize = 64 * 1024,
            EnableRaisingEvents = true
        };
        _fsw.Changed += OnAny;
        _fsw.Created += OnAny;
        _fsw.Deleted += OnAny;
        _fsw.Renamed += OnAny;
        _fsw.Error += (_, e) => Console.Error.WriteLine($"[watcher] {e.GetException()}");
    }

    private void OnAny(object sender, FileSystemEventArgs e)
    {
        var p = e.FullPath;
        var sep = Path.DirectorySeparatorChar;
        if (p.Contains($"{sep}obj{sep}") || p.Contains($"{sep}bin{sep}")) return;

        lock (_lock)
        {
            _timer?.Dispose();
            _timer = new Timer(_ => _onChanged(), null, _debounce, Timeout.InfiniteTimeSpan);
        }
    }

    public void Dispose()
    {
        _fsw.Dispose();
        lock (_lock) _timer?.Dispose();
    }
}