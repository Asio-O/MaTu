using System;
using System.Linq;
using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace 码图;

/// <summary>
/// 手写入口点，取代 WinUI 生成的那个（项目文件里用 DISABLE_XAML_GENERATED_MAIN 关掉了生成）。
/// <para>这样同一个可执行文件可以有两种身份：</para>
/// <list type="bullet">
/// <item>默认：正常启动 WinUI 界面；</item>
/// <item><c>--analyzer</c>：完全不碰 WinUI，作为 stdio 上的分析器进程运行。</item>
/// </list>
/// 复用同一个 exe 的好处是独立进程不需要另建工程、另配部署——它天然带着全部依赖与 runtimeconfig。
/// </summary>
public static class Program
{
    [System.Runtime.InteropServices.DllImport("Microsoft.ui.xaml.dll")]
    private static extern void XamlCheckProcessRequirements();

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Any(a => string.Equals(a, "--analyzer", StringComparison.OrdinalIgnoreCase)))
        {
            Environment.Exit(Graph.AnalyzerServer.Run());
            return;
        }

        XamlCheckProcessRequirements();
        global::WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(_ =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            new App();
        });
    }
}
