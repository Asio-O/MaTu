# 码图

单用户桌面工具：实时读取本地 C# 项目源码，把类型与方法之间的依赖画成图；源码改动后图自动更新，支持在多个项目间切换。

- 外壳：WinUI 3 + WebView2
- 分析：Roslyn（纯语法 L1 + 按需语义 L2）
- 渲染：Cytoscape.js + cytoscape-node-html-label（mermaid 风格 HTML 卡片）

## 现在能做什么

| 能力 | 说明 |
| --- | --- |
| 首屏骨架 | 打开目录后按「命名空间聚合」显示，大项目首屏只有十几个节点 |
| 逐层展开 | 单击命名空间 / 类型，卡片自己长大成托盘，子节点排在卡片内部（可递归嵌套）；双击空白折叠全部 |
| 类型级依赖 | 继承/实现、类型级调用聚合边；嵌套类型之间画归属虚线 |
| 精确调用 | 点开某个类型时用语义模型精确解析它的调用，消掉 L1 的同名方法虚边 |
| 跳转源码 | 单击方法节点，用 VS Code / Visual Studio 打开对应文件与行 |
| 自动刷新 | 文件保存后 400ms 防抖重建；删除/新增文件同样触发 |
| 搜索 | 工具栏搜索框按类型名 / 命名空间 / 方法名过滤，命中路径自动展开 |
| 调用链 | 选中节点后按「调用链」（或右键节点）追踪上下 N 层调用 |
| 导出 | 当前视图导出 PNG / mermaid 文本 / JSON，经宿主「另存为」落盘 |
| 多项目 | 切换项目时旧项目的监听器、缓存、分析器一律释放 |

## 架构

```
码图.exe                     ← 同一个可执行文件的两种身份
├── 默认         WinUI 界面 + WebView2 宿主
└── --analyzer   stdio 上的分析器进程（JSON 行协议）

Graph/                       分析层（不依赖 WinUI，可被 tools/GraphDump 复用）
├── Models.cs                GraphNode / GraphEdge / GraphSnapshot
├── FileSkeleton.cs          单文件解析结果（L1 磁盘缓存的存储单元）
├── SyntaxFacts.cs           语法层纯函数：类型路径、方法签名、可见性符号
├── SkeletonBuilder.cs       ParseFile → Compose：文件解析 与 图组装 分离
├── SkeletonCache.cs         L1 磁盘缓存：文件哈希 → 解析结果
├── ReverseIndex.cs          名字 → 声明它的文件 / 引用它的文件
├── SemanticResolver.cs      L2 语义精确化 + 精确级联失效
├── IAnalyzer.cs             进程内实现
├── OutOfProcessAnalyzer.cs  进程外实现（子进程 + JSON 行协议）
├── AnalyzerFactory.cs       选择与自动降级
├── AnalyzerServer.cs        --analyzer 模式的服务端
├── SourceWatcher.cs         文件监听 + 防抖
├── SourceNavigator.cs       探测编辑器并跳转到源码位置
├── ProjectContext.cs        单项目生命周期
└── ProjectRegistry.cs       多项目切换

wwwroot/                     渲染层
├── index.html               工具条、卡片样式、脚本加载顺序
├── app.js                   包含树 + 容器内嵌布局 + diff 渲染、搜索、追踪、导出
├── cytoscape.min.js         本地化，避免 CDN 不可达
└── cytoscape-node-html-label.min.js

tools/                       独立诊断与自检工程（不进入主工程编译）
├── GraphDump/               命令行跑一遍分析，打印统计与不变量
└── webprobe/                WebView2 远程调试探针与端到端自检
```

### 三层聚合模型

节点通过 `parentId` 组成一棵包含树：`方法 → 类型 → 外层类型 → 命名空间`。
前端只推导可见性，不重新计算图数据：

```
可见 = 该节点的全部祖先容器都处于展开状态
```

默认一个容器都不展开，所以首屏只剩命名空间聚合节点。切换成「平铺：类型」模式可以退回到传统的类型平铺视图。

### 布局：容器内嵌，不是把子节点甩到四周

展开一个容器**不会**把子节点散落到它周围的环上，而是让容器卡片自己长大成「托盘」，
子节点排在托盘里面 —— 跟 mermaid 的 subgraph 一样，「谁属于谁」是看出来的，不用顺着边猜。
可以递归：命名空间的托盘里放类型卡片，类型的托盘里再放方法芯片。

布局是自底向上算的，每次渲染整棵可见树重算一遍：

```
卡片自然尺寸（叶子：标题 + 成员列表；方法：按标签宽度量出来的芯片）
  ↓ 自底向上
容器尺寸 = 标题条 + 内边距×2 + 子节点打包结果
  ↓ 自顶向下
绝对坐标（顶层从固定原点向右下铺，展开一个容器只把它后面的东西推开）
```

两种打包方式：

- **方法芯片**按列排 —— 一列读起来就是一张成员表；超过 22 个才开第二列。
- **类型卡片**用货架打包，但「一行铺多宽」不拍系数：试几组候选宽度，
  挑铺出来最接近正方形的那组。拍系数的话，卡片高度稍有变化就会在
  「挤成一列」和「铺成一条」之间反复横跳。

尺寸和位置都带过渡动画：容器长大是在 `requestAnimationFrame` 里补间 `data(w/h)`
（`cytoscape-node-html-label` 每帧跟着重排卡片），被挤开的邻居同时平移到新位置。

### 分析的两条路线

- **L1（纯语法）**：只为首屏服务。并行解析所有 `.cs`，秒级完成，产出类型、成员签名、继承与同名调用。
  同名方法会产生虚边——这是 L1 的固有代价。
- **L2（语义，按需）**：用户点开某个类型时才建立一次 Adhoc Compilation，用 `SemanticModel`
  把调用精确落到具体方法符号上，返回精确的 `calls` / `typeCalls` 边替换该类型的 L1 近似。

### 进程内 / 进程外

`AnalyzerFactory` 按 `MATU_ANALYZER` 环境变量或项目规模选择：

| 取值 | 行为 |
| --- | --- |
| `auto`（默认） | 项目 `.cs` 文件数 ≥ 1500 时用独立进程 |
| `1` / `on` | 总是独立进程 |
| `0` / `off` | 总是进程内 |

独立进程失败会自动降级回进程内，并把原因写进日志——分析器的故障最多让当次分析重做一遍。

### 缓存

```
%LOCALAPPDATA%\码图\cache\<项目根路径哈希>\
    meta.json                 格式版本 / 项目根 / 最后打开时间
    files.json                文件路径 → 内容哈希
    skeletons\<哈希>.json      该内容对应的解析结果
```

键是**内容哈希**而不是路径：改一个文件只会让它自己多出一份新缓存。
`meta.json` 里的格式版本不匹配就整目录清掉重扫，绝不尝试复用半个缓存。

改动文件后 L2 缓存不做整体清空，而是用反向索引只作废受影响的类型
（例如改 `Models.cs` 只作废 22 个类型里的 5 个）。

## 构建与运行

```powershell
# 默认：非打包 + 自带 Windows App Runtime，构建完直接运行
dotnet build 码图.csproj -c Debug -p:Platform=x64
.\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\码图.exe

# 需要 MSIX 打包形态时
dotnet build 码图.csproj -c Debug -p:Platform=x64 -p:Unpackaged=false
```

> 之所以默认非打包：纯打包形态的 exe 需要机器上已注册 Windows App Runtime，
> 否则直接双击会以 `REGDB_E_CLASSNOTREG` 退出。自带运行时后 exe 可以直接分发运行。

## 快捷操作

| 操作 | 效果 |
| --- | --- |
| 单击命名空间 / 类型 | 卡片长大成托盘（子节点排到里面）或折叠回去 |
| 单击方法 | 在编辑器里跳到该方法的源码位置 |
| 右键节点 | 按当前方向与深度追踪调用链 |
| 双击空白 | 折叠全部并退出聚焦 |
| `/` | 聚焦搜索框 |
| `t` | 对选中节点追踪调用链 |
| `0` / `+` / `-` | 适配全部 / 放大 / 缩小 |
| `Esc` | 退出聚焦 + 折叠全部 |
| `F12` | 打开开发者工具 |

## 自检

```powershell
# 项目统计与不变量（重复节点 ID、悬空边、悬空 parentId…）
dotnet run --project tools/GraphDump -- <项目根>

# 磁盘缓存冷/热启动对比
dotnet run --project tools/GraphDump -- <项目根> --cache

# 反向索引与级联失效
dotnet run --project tools/GraphDump -- <项目根> --index

# L2 语义解析（全部类型或单个类型）
dotnet run --project tools/GraphDump -- <项目根> --resolve-all
dotnet run --project tools/GraphDump -- <项目根> --resolve 命名空间.类型名

# 编辑器探测
dotnet run --project tools/GraphDump -- <项目根> --editor

# 端到端：分析器子进程冒烟 + 真实 WebView2 里模拟点击 + 文件监听热更新
.\tools\webprobe\run.ps1 -Analyzer proc
```

`run.ps1` 的可选参数：`-Port`、`-Configuration`、`-Analyzer auto|inproc|proc`、`-KeepOpen`。

它依赖两个约定：

- 宿主设置 `MATU_CDP_PORT=<端口>` 后，WebView2 会开远程调试端口；`tools/webprobe` 通过 CDP
  读写页面里的 `window.__codemap` 诊断句柄，从而在不看界面的情况下核对渲染结果。
- 热更新自检会在项目根目录造一个 `__matu_probe_tmp.cs` 再删掉；用临时文件而不是改现有文件，
  是为了在任何一步失败时都不留下半改的源码。

## 踩过的坑

按方案 §8 的格式记一笔，都是这套架构里真实踩到、并且已经用回归断言钉住的：

| 现象 | 根因 | 解法 |
| --- | --- | --- |
| 展开后所有子节点叠在容器上 | cytoscape 的 `position()` 交出的是元素内部那个 position 对象本身，`add()` 又会直接引用传进去的对象。子节点都从「父节点的 `position()`」出生，于是整批共用一个对象——动一个等于动全部 | 传进 `add()` / `animate()` 的坐标一律先复制（`copyPos`） |
| 花括号里全被糊住 / 托盘是空的 | 卡片整层 DOM（`z-index: 10`）盖在 canvas 之上，托盘一旦有底色就把画在 canvas 上的子节点全遮了 | 托盘背景透明，嵌套关系只靠边框和标题表达 |
| 卡片比节点大一圈，节点从边框下露出 | `width/height` 写死不等于 `getBoundingClientRect()` —— 默认 `box-sizing: content-box`，边框要另加 | 给卡片加 `box-sizing: border-box` |
| 卡片底下露出纯黑矩形 | cytoscape 填充背景时忽略 `background-color` 自带的 alpha，只看 `background-opacity`（默认 1），于是 `transparent` 被画成不透明黑 | 显式写 `background-opacity: 0`，不要依赖 `background-color: transparent` |
| 每个卡片都套了一圈虚线边 | `node[isType]:hover` —— cytoscape 没有 `:hover` 伪类，未知伪类被当成恒真条件匹配所有节点 | 去掉伪类，改用 `mouseover`/`mouseout` 事件加 `.hovered` 类 |
| 卡片盖不满节点，边角露出底色 | HTML 排版高度与按公式估算的节点高度对不上 | 把卡片渲染到离屏容器里实测一次，并按内容签名缓存结果 |
| 改一个文件却把整个 L2 缓存清空 | 失效粒度太粗 | 反向索引只作废「改动文件声明的类型」与「引用它们的类型」 |
| 出现「源码与元数据同名类型」两份 | 引用集里混进了项目自身的输出程序集 | 按项目根目录名排除同名 DLL，同时扫描项目 `bin` 补全第三方依赖 |
| 编译里塞进一堆 CS0009 | `bin` 下的原生 DLL 被当成元数据引用 | 用 `AssemblyName.GetAssemblyName` 过滤掉没有托管元数据的文件 |
| 打包形态的 exe 双击就退 | 机器上没有注册 Windows App Runtime | 默认改为非打包 + 自带运行时 |

前六条各自对应 `tools/webprobe/probe.js` 里的一条断言，坏了会被自检直接抓出来：
「卡片节点自身不被绘制」「节点尺寸与卡片实测尺寸一致」「没有节点叠在一起」
「各自持有独立的 position 对象」「子节点都排在容器内部」「展开后容器卡片长大了」。

## 已知限制

- L1 的同名方法调用是近似结果，展开某个类型后才会被 L2 替换成精确边。
- L2 的引用集是「当前进程的框架程序集 + 应用目录 DLL + 被分析项目 `bin` 下的托管 DLL」，
  不解析工程的 NuGet 依赖图（那是 MSBuildWorkspace 的路线，首屏代价不可接受）。
  项目自身输出程序集会被排除，以免编译里出现「源码与元数据同名类型」两份。
  引用缺失时该类型降级保留 L1 结果；`dotnet run --project tools/GraphDump -- <根> --refs`
  可以直接问「当前引用集够不够」。
- 导出 PNG 是自己用 canvas 重画的静态图：类型卡片由 `cytoscape-node-html-label` 渲染成 DOM，
  不在 cytoscape 画布里，直接 `cy.png()` 会得到没有文字的框。
- 内嵌布局是「整棵树重排」：展开一个容器会把它后面的东西推开，所以位置不是手工定格之后就不再变的。
  腾挪都用动画过渡，不会硬跳。
- 暂不支持分析 VB / F# / TypeScript。
- 默认按非打包形态构建：机器上若已注册 Windows App Runtime，用 `-p:Unpackaged=false` 可以回到 MSIX。
