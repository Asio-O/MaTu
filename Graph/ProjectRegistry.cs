using System;
using System.Threading;
using System.Threading.Tasks;

namespace 码图.Graph;

public sealed class ProjectRegistry
{
    private readonly Action<GraphSnapshot> _onUpdated;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private ProjectContext? _active;

    public ProjectRegistry(Action<GraphSnapshot> onUpdated) => _onUpdated = onUpdated;
    public ProjectContext? Active => _active;

    public async Task SwitchAsync(string root, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (_active?.Root == root) return;

            if (_active is not null)
            {
                _active.Deactivate();
                _active.Dispose();
                _active = null;
            }

            var id = Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar));
            var ctx = new ProjectContext(id, root, _onUpdated);
            await ctx.LoadAsync(ct);
            ctx.Activate();
            _active = ctx;
        }
        finally { _gate.Release(); }
    }
}