/*  码图 —— 前端渲染层
 *
 *  三条不变式：
 *   1. 后端把「包含关系」编码进节点的 parentId（方法 → 类型 → 外层类型 → 命名空间）。
 *      前端只做可见性推导，不重新计算图数据。
 *   2. 可见性 = 节点的全部祖先容器都处于展开状态。默认一个容器都不展开，
 *      所以首屏只剩命名空间聚合节点。
 *   3. 渲染是 diff：「新增淡入、消失淡出、内容变化就地刷新」。
 *      除首次加载、切换聚合模式、按 0 键与批量展开展开外，绝不重置相机。
 */
(function () {
    'use strict';

    // ================================================================
    //  基础设施
    // ================================================================

    const hint = document.getElementById('hint');
    const statsEl = document.getElementById('stats');
    const modeBtn = document.getElementById('modeBtn');
    const modeLabel = document.getElementById('modeLabel');
    const searchEl = document.getElementById('search');
    const searchWrap = document.getElementById('searchWrap');
    const searchClearBtn = document.getElementById('searchClear');
    const resultsEl = document.getElementById('results');
    const focusBar = document.getElementById('focusBar');
    const focusLabel = document.getElementById('focusLabel');
    const focusClear = document.getElementById('focusClear');
    const traceDirEl = document.getElementById('traceDir');
    const traceDepthEl = document.getElementById('traceDepth');
    const crumbsEl = document.getElementById('crumbs');
    const progressEl = document.getElementById('progress');
    const welcomeEl = document.getElementById('welcome');
    const welcomeOpenBtn = document.getElementById('welcomeOpen');
    const legendEl = document.getElementById('legend');
    const legendBody = document.getElementById('legendBody');
    const legendToggle = document.getElementById('legendToggle');
    const helpEl = document.getElementById('help');
    const helpRows = document.getElementById('helpRows');
    const helpBtn = document.getElementById('helpBtn');
    const exportWrap = document.getElementById('exportWrap');
    const exportMenu = document.getElementById('exportMenu');
    const zoomValueEl = document.getElementById('zoomValue');
    const themeBtn = document.getElementById('themeBtn');
    const themeIconLight = document.getElementById('themeIconLight');
    const themeIconDark = document.getElementById('themeIconDark');

    // ================================================================
    //  主题
    // ================================================================

    /*
     * 配色只有这一张表。它同时喂三个地方：
     *   1. 写成 CSS 变量挂到 <html> 上 —— 工具条、浮层、卡片样式全用 var(--…)
     *   2. TYPE_COLORS / EDGE_COLOR —— cytoscape 样式、卡片模板、导出重绘取它
     *   3. 图例 —— 直接从同一份表渲染，改色不用再找第二处
     * 深浅两套同名同结构，切主题就是换一张表。
     */
    const THEMES = {
        light: {
            dark: false,
            surface: '#ffffff',
            pngBg: '#f4f6f9',
            kinds: {
                namespace: '#5b6b7f', class: '#3b82f6', interface: '#0f9d76',
                struct: '#d98411', record: '#8b5cf6', type: '#94a3b8',
            },
            edges: {
                inherits: '#f43f5e', nsInherits: '#f43f5e',
                typeCalls: '#3b82f6', nsCalls: '#3b82f6',
                typeContains: '#cbd5e1', calls: '#94a3b8',
            },
            vars: {
                '--bg': '#f4f6f9',
                '--grid': 'rgba(15, 23, 42, .05)',
                '--surface': '#ffffff',
                '--surface-2': 'rgba(255, 255, 255, .82)',
                '--surface-3': '#f4f6fa',
                '--border': '#e4e8ef',
                '--border-strong': '#d3dae4',
                '--divider': '#edf0f5',
                '--ink': '#131a26',
                '--ink-2': '#4a5568',
                '--ink-3': '#8792a2',
                '--brand': '#3d6df6',
                '--brand-soft': 'rgba(61, 109, 246, .10)',
                '--brand-ink': '#ffffff',
                '--danger': '#e5484d',
                '--danger-soft': 'rgba(229, 72, 77, .12)',
                '--ok': '#12a594',
                '--shadow-1': '0 1px 2px rgba(16, 24, 40, .06), 0 1px 3px rgba(16, 24, 40, .05)',
                '--shadow-2': '0 6px 16px -4px rgba(16, 24, 40, .12), 0 14px 32px -16px rgba(16, 24, 40, .24)',
                '--shadow-3': '0 24px 64px -20px rgba(16, 24, 40, .40)',
                '--ring': '0 0 0 3px rgba(61, 109, 246, .28)',
            },
        },
        dark: {
            dark: true,
            surface: '#161d29',
            pngBg: '#0e131c',
            kinds: {
                namespace: '#94a3b8', class: '#60a5fa', interface: '#34d399',
                struct: '#fbbf24', record: '#a78bfa', type: '#64748b',
            },
            edges: {
                inherits: '#fb7185', nsInherits: '#fb7185',
                typeCalls: '#60a5fa', nsCalls: '#60a5fa',
                typeContains: '#33415a', calls: '#64748b',
            },
            vars: {
                '--bg': '#0e131c',
                '--grid': 'rgba(255, 255, 255, .035)',
                '--surface': '#161d29',
                '--surface-2': 'rgba(19, 26, 38, .82)',
                '--surface-3': '#1b2431',
                '--border': '#273143',
                '--border-strong': '#35415a',
                '--divider': '#212b3b',
                '--ink': '#e8edf6',
                '--ink-2': '#a9b4c6',
                '--ink-3': '#6f7c92',
                '--brand': '#6b8dff',
                '--brand-soft': 'rgba(107, 141, 255, .16)',
                '--brand-ink': '#0b1020',
                '--danger': '#ff6b6b',
                '--danger-soft': 'rgba(255, 107, 107, .16)',
                '--ok': '#3ecfb2',
                '--shadow-1': '0 1px 2px rgba(0, 0, 0, .45)',
                '--shadow-2': '0 8px 20px -6px rgba(0, 0, 0, .55), 0 18px 44px -22px rgba(0, 0, 0, .80)',
                '--shadow-3': '0 28px 72px -24px rgba(0, 0, 0, .85)',
                '--ring': '0 0 0 3px rgba(107, 141, 255, .30)',
            },
        },
    };

    const THEME_KEY = 'matu.theme';

    /** 显式选过就听用户的，否则跟随系统。 */
    function resolveInitialTheme() {
        let saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* 无存储权限就用系统值 */ }
        if (saved === 'light' || saved === 'dark') return saved;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark' : 'light';
    }

    let themeName = resolveInitialTheme();
    function theme() { return THEMES[themeName]; }

    // 可变引用：切主题时就地改这张表，所有拿着它的人自动跟着变
    const TYPE_COLORS = Object.assign({}, THEMES.light.kinds);
    const EDGE_COLOR = Object.assign({}, THEMES.light.edges);

    /** 两色按比例混合，返回 rgb()。用来看得住深色底上的标题/描边。 */
    function mix(a, b, t) {
        const pa = hexTriplet(a), pb = hexTriplet(b);
        if (!pa || !pb) return a;
        const c = i => Math.round(pa[i] + (pb[i] - pa[i]) * t);
        return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
    }

    function hexTriplet(s) {
        let h = String(s).trim().replace(/^#/, '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }

    /**
     * 卡片的四个派生色。放在内联样式里而不是 CSS 里算：
     * color-mix() 要 WebView2 141+，而这里必须能跑在任何一台装了 WebView2 的机器上。
     */
    function accentVars(accent) {
        const t = theme();
        return `--accent:${accent};` +
            `--accent-deep:${mix(accent, '#000000', t.dark ? 0.30 : 0.20)};` +
            // 后两个数都是「往底色里掺多少」：掺得多才是淡底，掺得少是描边
            `--accent-soft:${mix(accent, t.surface, t.dark ? 0.80 : 0.88)};` +
            `--accent-border:${mix(accent, t.surface, t.dark ? 0.55 : 0.68)};` +
            `--accent-ink:${mix(accent, t.dark ? '#ffffff' : '#0b1020', 0.30)};`;
    }

    /** 把主题写进 DOM 变量 + 两张颜色表。不碰需要重建的东西（那是 setTheme 的事）。 */
    function applyThemeVars(name) {
        themeName = THEMES[name] ? name : 'light';
        const t = theme();
        const root = document.documentElement;
        root.setAttribute('data-theme', themeName);
        for (const k in t.vars) root.style.setProperty(k, t.vars[k]);
        Object.assign(TYPE_COLORS, t.kinds);
        Object.assign(EDGE_COLOR, t.edges);

        if (themeIconLight) themeIconLight.style.display = t.dark ? 'none' : '';
        if (themeIconDark) themeIconDark.style.display = t.dark ? '' : 'none';
        if (themeBtn) themeBtn.title = t.dark ? '切换到浅色主题' : '切换到深色主题';
        renderLegend();
    }

    // ================================================================
    //  通知 / 进度
    // ================================================================

    let hintTimer = null;

    /*
     * 提示条。原来的版本把提示当常驻文字挂在左上角，一屏幕都是操作说明；
     * 现在当 toast 用：出现几秒自己退场，只有错误的 textContent 会留着
     * （探针的 snapshotSummary() 会读它，所以隐藏靠 class 而不是清空）。
     */
    function setHint(text, isErr) {
        clearTimeout(hintTimer);
        if (!text) { hint.classList.remove('show'); return; }
        hint.textContent = text;
        hint.className = (isErr ? 'err ' : '') + 'show';
        hintTimer = setTimeout(() => hint.classList.remove('show'), isErr ? 9000 : 3400);
    }

    /** 顶部那条细进度条：L2 解析这类「正在忙」的时刻。 */
    function setBusy(on) {
        if (progressEl) progressEl.classList.toggle('on', !!on);
    }

    // —— 图例与快捷键说明的数据表 ——
    // 放在主题表旁边：它们只描述「界面上要展示什么」，渲染逻辑在文件后半段。
    const LEGEND_KINDS = [
        ['class', '类'], ['interface', '接口'], ['struct', '结构'],
        ['record', '记录'], ['namespace', '命名空间'],
    ];
    const LEGEND_EDGES = [
        ['inherits', '继承 / 实现', 2.2, false],
        ['typeCalls', '类型级调用', 1.8, false],
        ['calls', '方法级调用', 1.0, false],
        ['typeContains', '嵌套归属', 1.2, true],
    ];
    const HELP_ROWS = [
        [['/'], '聚焦搜索框'],
        [['↑', '↓', 'Enter'], '在搜索结果里选择并定位'],
        [['T'], '对选中节点追踪调用链'],
        [['0'], '适配全部，并清掉手动拖动'],
        [['F'], '适配全部'],
        [['+', '-'], '放大 / 缩小'],
        [['单击卡片'], '命名空间 / 类型就地长成托盘，子节点排到卡片里'],
        [['双击容器'], '把它下面的容器一层层一起展开'],
        [['单击方法'], '在编辑器里跳到这个方法的源码'],
        [['拖动卡片'], '整块一起走，松手后停在拖到的位置'],
        [['右键节点'], '按工具栏的方向与深度追踪调用链'],
        [['双击空白'], '折叠全部并退出聚焦'],
        [['Esc'], '退出聚焦 / 折叠全部'],
        [['?'], '打开这张说明'],
        [['F12'], '打开开发者工具'],
    ];

    // 先把主题落到 DOM 上：cytoscape 的样式表紧跟着就要按当前配色构建
    applyThemeVars(themeName);

    if (typeof cytoscape === 'undefined') {
        setHint('cytoscape.min.js 未加载', true);
        return;
    }

    const CARD_WIDTH = 232;

    const ANIM = {
        growDuration: 420,
        shrinkDuration: 300,
        fadeDuration: 240,
        moveDuration: 340,
        easing: 'ease-out',
    };

    // 展开一个容器 = 容器卡片自己长大成「托盘」，子节点排在托盘内部（可以递归嵌套），
    // 而不是散落到容器四周的环上。这样「谁属于谁」是看出来的，不用靠边去猜。
    const BOX = {
        pad: 16,          // 托盘内边距
        gapX: 18,         // 子项水平间距
        gapY: 16,         // 子项垂直间距
        rootGapX: 64,     // 顶层托盘/卡片之间的间距
        rootGapY: 56,
        chipH: 22,        // 方法芯片高度
        chipPadX: 24,     // 方法芯片两侧留白
        chipFontSize: 10,
        maxRow: 1400,     // 一行最多铺多宽
        perColumn: 22,    // 方法芯片一列最多放几个，超了就多开一列
    };

    // 方法芯片的字体要和 cytoscape 样式里写的完全一致，否则量出来的宽度是错的
    const CHIP_FONT = `${BOX.chipFontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;

    const labelCtx = document.createElement('canvas').getContext('2d');
    const labelWidth = new Map();

    /** 量一段文字在方法芯片字号下的宽度。 */
    function measureLabelWidth(text) {
        const key = String(text == null ? '' : text);
        let w = labelWidth.get(key);
        if (w !== undefined) return w;
        labelCtx.font = CHIP_FONT;
        w = labelCtx.measureText(key).width;
        if (labelWidth.size > 4000) labelWidth.clear();
        labelWidth.set(key, w);
        return w;
    }

    function chipWidth(n) {
        return Math.max(46, Math.ceil(measureLabelWidth(n.label)) + BOX.chipPadX);
    }

    /** 方法芯片的底色/悬停底色与字色：跟着主题和父类型的主色走。 */
    function chipColors(color) {
        const t = theme();
        return {
            ink: t.dark ? '#dbe3f0' : '#33475b',
            chipBg: mix(color, t.surface, t.dark ? 0.86 : 0.93),
            chipHover: mix(color, t.surface, t.dark ? 0.66 : 0.80),
        };
    }

    // 各类边的目标透明度
    const EDGE_OPACITY = {
        inherits: 0.95,
        nsInherits: 0.9,
        typeCalls: 0.5,
        nsCalls: 0.55,
        typeContains: 0.55,
        calls: 0.5,
    };

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ================================================================
    //  卡片模板
    // ================================================================

    /*
     * 卡片外壳。两种形态：
     *   叶子卡：宽度固定，高度由内容撑开 —— 折叠的命名空间/类型就是这种
     *   托盘：  宽高都由布局算好后写死，正文留空 —— 子节点是独立的 cytoscape 节点，
     *          排在托盘内部，卡片只负责画个框和标题
     *
     * 注意「选中 / 悬停」这两个状态是写进模板的，不是在 DOM 上加类：
     * cytoscape-node-html-label 每次收到 data / style 事件都会重建卡片节点，
     * 加在外面的类会被下一次重建抹掉，只有走 data 才能活到下一次渲染。
     */
    const KIND_GLYPH = {
        namespace: 'N', class: 'C', interface: 'I', struct: 'S', record: 'R', type: 'T',
    };

    const CHEVRON_SVG = '<svg class="mermaid-chev" width="10" height="10" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" ' +
        'stroke-linejoin="round"><path d="M9 5l7 7-7 7"></path></svg>';

    /** 标题条：展开箭头 + 类型徽标 + 名字 + 子项计数。 */
    function headerHtml(kind, label, count) {
        return '<div class="mermaid-header">' + CHEVRON_SVG +
            `<span class="mermaid-glyph">${KIND_GLYPH[kind] || 'T'}</span>` +
            `<span class="mermaid-title">${escapeHtml(label)}</span>` +
            (count ? `<span class="mermaid-count">${count}</span>` : '') +
            '</div>';
    }

    function cardAttrs(color, kindClass, data) {
        const cls = ['mermaid-card', kindClass, data.tray ? 'tray' : '',
            data.selected ? 'selected' : '', data.hovered ? 'hovered' : ''].filter(Boolean).join(' ');
        const size = data.tray
            ? `width:${Math.round(data.w)}px;height:${Math.round(data.h)}px;` : '';
        return `class="${cls}" style="${accentVars(color)}${size}"`;
    }

    function typeCardTpl(data) {
        const color = data.color || TYPE_COLORS.class;
        const kind = data.kind || 'type';
        const fields = data.fields || [];
        const methods = data.methods || [];
        const count = data.tray
            ? (data.childCount || 0)
            : (fields.length + methods.length);

        // 托盘正文必须留空：子节点是画在 canvas 上的独立节点，排在这个框里面
        if (data.tray) {
            return `<div ${cardAttrs(color, 'type-tray', data)}>` +
                headerHtml(kind, data.label, count) + '</div>';
        }

        let body = '';
        if (fields.length > 0) {
            body += '<div class="mermaid-section">'
                + fields.map(f => `<div class="mermaid-line">${escapeHtml(f)}</div>`).join('')
                + '</div>';
        }
        if (methods.length > 0) {
            body += '<div class="mermaid-section">'
                + methods.map(m => `<div class="mermaid-line strong">${escapeHtml(m)}</div>`).join('')
                + '</div>';
        }
        if (!body) {
            body = '<div class="mermaid-section"><div class="mermaid-line mermaid-empty">（无成员）</div></div>';
        }

        return `<div ${cardAttrs(color, '', data)}>` + headerHtml(kind, data.label, count) + body + '</div>';
    }

    function nsCardTpl(data) {
        const color = data.color || TYPE_COLORS.namespace;
        const preview = data.preview || [];

        if (data.tray) {
            return `<div ${cardAttrs(color, 'ns', data)}>` +
                headerHtml('namespace', data.label, data.childCount || 0) + '</div>';
        }

        let body = `<div class="mermaid-section"><div class="mermaid-line strong">${data.childCount} 个类型</div>`;
        for (const line of preview) {
            body += `<div class="mermaid-line"><span class="dim">${escapeHtml(line)}</span></div>`;
        }
        body += '</div>';
        body += '<div class="mermaid-hint">' +
            (data.expanded ? '已展开 · 点击折叠' : '点击展开 · 类型排到卡片里') + '</div>';

        return `<div ${cardAttrs(color, 'ns', data)}>` +
            headerHtml('namespace', data.label, data.childCount || 0) + body + '</div>';
    }

    function estimateSize(n) {
        if (n.kind === 'method') return { w: chipWidth(n), h: BOX.chipH };
        if (n.kind === 'namespace') {
            const previewLines = Math.min((n.preview || []).length, 6);
            const h = 36 + 18 + (previewLines > 0 ? previewLines * 17 + 10 : 0) + 16;
            return { w: CARD_WIDTH, h };
        }
        const fields = (n.fields || []).length;
        const methods = (n.methods || []).length;
        const sections = (fields > 0 ? 1 : 0) + (methods > 0 ? 1 : 0);
        const lines = Math.max(1, fields + methods);
        return { w: CARD_WIDTH, h: 26 + lines * 17 + sections * 10 + 6 };
    }

    // —— 卡片尺寸测量 ——
    // HTML 排版与 cytoscape 的节点尺寸是两套系统，纯靠公式估算一定会有偏差。
    // 偏差落在「卡片比节点矮」这一侧时，节点就会从卡片底下露出来。
    // 这里把卡片真的渲染到离屏容器里量一次，并按内容缓存。
    const sizeHost = document.createElement('div');
    sizeHost.setAttribute('aria-hidden', 'true');
    sizeHost.style.cssText =
        `position:absolute;left:-100000px;top:0;width:${CARD_WIDTH}px;visibility:hidden;pointer-events:none;`;
    document.body.appendChild(sizeHost);
    const sizeCache = new Map();

    function cardData(n) {
        if (n.kind === 'namespace') {
            return {
                label: n.label,
                kind: 'namespace',
                color: TYPE_COLORS.namespace,
                childCount: n.childCount || 0,
                preview: n.preview || [],
                expanded: isContainerExpanded(n.id) ? 1 : 0,
                tray: n.tray ? 1 : 0, w: n.boxW || 0, h: n.boxH || 0,
            };
        }
        return {
            label: n.label,
            kind: n.kind,
            color: TYPE_COLORS[n.kind] || TYPE_COLORS.type,
            fields: n.fields || [],
            methods: n.methods || [],
            childCount: (state.childrenOf.get(n.id) || []).length,
            tray: n.tray ? 1 : 0, w: n.boxW || 0, h: n.boxH || 0,
        };
    }

    function measureSize(n) {
        if (n.kind === 'method') return { w: chipWidth(n), h: BOX.chipH };
        const html = n.kind === 'namespace' ? nsCardTpl(cardData(n)) : typeCardTpl(cardData(n));
        const cached = sizeCache.get(html);
        if (cached) return cached;

        sizeHost.innerHTML = html;
        const card = sizeHost.firstElementChild;
        let size;
        if (card) {
            const rect = card.getBoundingClientRect();
            size = { w: Math.ceil(rect.width), h: Math.ceil(rect.height) };
        } else {
            size = estimateSize(n);   // 模板没产出元素时退回公式估算
        }
        sizeHost.innerHTML = '';

        if (sizeCache.size > 2000) sizeCache.clear();
        sizeCache.set(html, size);
        return size;
    }

    // ================================================================
    //  Cytoscape 实例
    // ================================================================

    /*
     * 样式表按当前主题现算。深色下如果沿用浅色那套线和字，画布会糊成一片灰，
     * 所以切主题时整张表重建一次（见 setTheme）。
     */
    function buildStyle() {
        const t = theme();
        const e = t.edges;
        return [
            {
                selector: 'node[isType], node[isNs]',
                style: {
                    width: 'data(w)',
                    height: 'data(h)',
                    // 卡片由 DOM 层绘制，节点本身必须完全不画。
                    // 不能只写 background-color: transparent —— 这个 cytoscape 版本
                    // 填充背景时忽略颜色自带的 alpha，只看 background-opacity，
                    // 结果就是一整块纯黑矩形从卡片底下露出来。
                    'background-opacity': 0,
                    'background-color': t.surface,
                    'border-width': 0,
                    'border-style': 'solid',
                    'overlay-opacity': 0,
                    label: '',
                    shape: 'rectangle',
                }
            },
            {
                // 方法在展开后的类型托盘里是一枚芯片：圆角胶囊 + 主色描边 + 淡色底。
                // 尺寸由 measureSize()/chipWidth() 算好放进 data(w)/data(h)，
                // 字体族必须和 CHIP_FONT 一致，否则量出来的宽度对不上。
                selector: 'node[isMethod]',
                style: {
                    label: 'data(label)',
                    'font-family': 'Segoe UI, Microsoft YaHei, sans-serif',
                    'font-size': 10, color: 'data(ink)',
                    'text-valign': 'center', 'text-halign': 'center',
                    'text-wrap': 'none',
                    shape: 'round-rectangle',
                    width: 'data(w)', height: 'data(h)',
                    'background-color': 'data(chipBg)',
                    'background-opacity': 1,
                    'border-width': 1, 'border-color': 'data(color)',
                    'transition-property': 'background-color, border-width, border-color, color',
                    'transition-duration': '150ms',
                }
            },
            {
                // hovered / sel 走 data 而不是 class：卡片那层 DOM 会被
                // cytoscape-node-html-label 按 data 重建，只有 data 上的状态活得下来。
                selector: 'node[isMethod][hovered = 1]',
                style: { 'background-color': 'data(chipHover)', 'border-width': 1.8, 'z-index': 998 }
            },
            {
                selector: 'node[isMethod][sel = 1]',
                style: {
                    'background-color': 'data(chipHover)', 'border-width': 2,
                    'border-color': 'data(color)', 'z-index': 999,
                }
            },
            {
                selector: 'edge[kind="inherits"]',
                style: {
                    'curve-style': 'bezier', width: 2.2,
                    'line-color': e.inherits,
                    'target-arrow-color': e.inherits,
                    'target-arrow-shape': 'triangle', 'arrow-scale': 1.1,
                }
            },
            {
                selector: 'edge[kind="nsInherits"]',
                style: {
                    'curve-style': 'bezier', width: 2.6,
                    'line-color': e.nsInherits,
                    'line-style': 'solid',
                    'target-arrow-color': e.nsInherits,
                    'target-arrow-shape': 'triangle', 'arrow-scale': 1.2,
                }
            },
            {
                selector: 'edge[kind="typeCalls"]',
                style: {
                    'curve-style': 'bezier', width: 1.8,
                    'line-color': e.typeCalls,
                    'target-arrow-color': e.typeCalls,
                    'target-arrow-shape': 'vee', 'arrow-scale': 1.0,
                }
            },
            {
                selector: 'edge[kind="nsCalls"]',
                style: {
                    'curve-style': 'bezier', width: 2.2,
                    'line-color': e.nsCalls,
                    'target-arrow-color': e.nsCalls,
                    'target-arrow-shape': 'vee', 'arrow-scale': 1.1,
                }
            },
            {
                selector: 'edge[kind="typeContains"]',
                style: {
                    'curve-style': 'bezier', width: 1.2,
                    'line-color': e.typeContains,
                    'line-style': 'dashed',
                    'target-arrow-shape': 'none',
                }
            },
            {
                selector: 'edge[kind="calls"]',
                style: {
                    'curve-style': 'bezier', width: 1.0,
                    'line-color': e.calls,
                    'target-arrow-color': e.calls,
                    'target-arrow-shape': 'vee', 'arrow-scale': 0.7,
                }
            },
        ];
    }

    const cy = cytoscape({
        container: document.getElementById('cy'),
        wheelSensitivity: 0.3,
        style: buildStyle(),
    });

    if (typeof cy.nodeHtmlLabel !== 'function') {
        setHint('node-html-label 扩展未生效，检查 cytoscape-node-html-label.min.js 是否在 cytoscape.min.js 之后加载', true);
        return;
    }
    cy.nodeHtmlLabel([
        { query: 'node[isType]', tpl: typeCardTpl },
        { query: 'node[isNs]', tpl: nsCardTpl },
    ]);

    // ================================================================
    //  状态
    // ================================================================

    const state = {
        projectId: null,
        version: -1,
        root: '',
        mode: 'namespace',          // 'namespace' | 'type'
        nodes: [],
        edges: [],
        nodeById: new Map(),
        childrenOf: new Map(),      // parentId -> [nodeId]
        expanded: new Set(),        // 已展开的容器（命名空间或类型）
        preciseByType: new Map(),   // typeId -> 精确解析出的边（L2）
        requested: new Set(),       // 已请求过语义解析的类型
        resolutions: new Map(),     // typeId -> 解析元信息（是否精确、耗时、原因）
        typeSig: new Map(),         // typeId -> 方法/字段签名，用于判断 L2 结果是否失效
        filter: null,               // 聚焦过滤器：{nodes:Set, edges:Set|null, autoExpand, kind, label}
        preFilterExpanded: null,    // 进入聚焦前的展开集合，退出时还原
        selected: null,             // 最近点击过的节点 id
        edgeList: [],
        renderEdges: new Map(),     // 投影之后的边（真正画到画布上的那一份）
        offsets: new Map(),         // 节点 id -> 用户拖出来的位移（相对布局位置）
        drag: { el: null, last: null, riders: [], moved: false },
        renderGen: 0,               // 渲染代次：异步收尾动作靠它判断自己是不是过期了
        reconcileTimer: null,       // 落地校正的定时器
        lastLayout: null,           // 最近一次布局结果，拖动时拿它算位移基准
        lastPureLayout: null,       // 同一份布局的「不含位移」坐标，拖动记位移用
        stats: null,
        drawn: null,
        shell: null,                // 宿主外壳（标题栏那一条）的主题回执，见 shell-theme
    };

    function isTypeNode(n) { return n.kind !== 'namespace' && n.kind !== 'method'; }

    function indexSnapshot() {
        state.nodeById = new Map();
        state.childrenOf = new Map();
        for (const n of state.nodes) state.nodeById.set(n.id, n);
        for (const n of state.nodes) {
            if (!n.parentId) continue;
            let arr = state.childrenOf.get(n.parentId);
            if (!arr) state.childrenOf.set(n.parentId, arr = []);
            arr.push(n.id);
        }
        // 命名空间卡片的预览行 + 子类型计数
        for (const n of state.nodes) {
            if (n.kind !== 'namespace') continue;
            const kids = (state.childrenOf.get(n.id) || [])
                .map(id => state.nodeById.get(id))
                .filter(k => k && isTypeNode(k));
            n.childCount = kids.length;
            n.preview = kids.slice(0, 6).map(k => k.label);
            if (kids.length > 6) n.preview.push(`… 还有 ${kids.length - 6} 个`);
        }
    }

    function refreshEdgeList() {
        const out = [];
        for (const e of state.edges) {
            if (e.kind === 'calls') {
                const src = state.nodeById.get(e.source);
                // 源类型已做语义精确化，用精确边替换 L1 的简单名虚边
                if (src && src.parentId && state.preciseByType.has(src.parentId)) continue;
            } else if (e.kind === 'typeCalls') {
                if (state.preciseByType.has(e.source)) continue;
            }
            out.push(e);
        }
        for (const list of state.preciseByType.values()) {
            for (const e of list) out.push(e);
        }
        state.edgeList = out;
    }

    // ================================================================
    //  可见性推导
    // ================================================================

    // 聚焦过滤器（搜索 / 调用链）激活时，命中的容器一律视为已展开，
    // 这样不用改动用户自己的展开状态就能把命中路径显出来。
    function isContainerExpanded(id) {
        if (state.filter && state.filter.autoExpand && state.filter.nodes.has(id)) return true;
        return state.expanded.has(id);
    }

    function isVisible(n) {
        if (state.filter && !state.filter.nodes.has(n.id)) return false;

        if (state.mode === 'type') {
            if (n.kind === 'method') return isContainerExpanded(n.parentId);
            return n.kind !== 'namespace';
        }
        // 命名空间聚合模式
        if (n.kind === 'namespace') return true;
        const p = n.parentId ? state.nodeById.get(n.parentId) : null;
        if (!p) return true;
        return isVisible(p) && isContainerExpanded(p.id);
    }

    /** 基础边要不要参与投影：结构边不画，「聚焦」时只放行命中的边。 */
    function edgeInScope(e) {
        if (e.kind === 'nsContains') return false;
        if (state.filter && state.filter.edges && !state.filter.edges.has(e.id)) return false;
        return true;
    }

    // ================================================================
    //  边的「下沉」：容器展开后，聚合边改挂到里面真正参与的子节点上
    // ================================================================

    /*
     * 后端的边是逐级聚合出来的：
     *     calls（方法→方法） → typeCalls（类型→类型） → nsCalls（命名空间→命名空间）
     *     inherits（类型→类型） → nsInherits（命名空间→命名空间）
     *
     * 全折叠时画聚合边是对的 —— 聚合边就是那一层的摘要。但容器一旦展开，摘要就该让位：
     * 原来连在父卡片上的线，要改连到里面真正调用的那个子节点上。
     *
     * 做法：先把这条聚合边顺着聚合链展开到最细一层（nsCalls → typeCalls → calls），
     * 然后从聚合边的端点沿着路径往下走，只在「这一层容器确实展开了、下一层又在画布上」
     * 时才往下走一步：
     *
     *   走到明细里那个具体节点 → 线的这一端改挂到它身上
     *   走不动（没展开 / 被聚焦过滤掉）→ 仍然挂在原来的父节点上
     *
     * 两端都走下去了，说明明细边自己已经在画同一件事 —— 聚合边整条退场，
     * 否则会在同一对节点之间画出一条粗的聚合边加一条细的明细边。
     */

    // 聚合边 → 它的明细边
    const DRILL = { nsCalls: 'typeCalls', nsInherits: 'inherits', typeCalls: 'calls' };

    /** 从任意节点往上找它所属的命名空间。 */
    function namespaceOf(id) {
        let n = state.nodeById.get(id);
        while (n && n.kind !== 'namespace') n = n.parentId ? state.nodeById.get(n.parentId) : null;
        return n ? n.id : null;
    }

    function pushPair(map, key, a, b) {
        let list = map.get(key);
        if (!list) map.set(key, list = []);
        list.push([a, b]);
    }

    /*
     * 下钻索引：聚合边的两端 → 明细边。
     * 按「明细边的两端各自的祖先是不是这条聚合边的两端」建索引，
     * 所以展开后能一条不落地找到参与其中的子节点。
     */
    function buildDrillIndex() {
        const nsPair = new Map();     // "明细类型|ns1|ns2" -> [[t1,t2], ...]
        const typePair = new Map();   // "t1|t2"             -> [[m1,m2], ...]
        for (const e of state.edgeList) {
            if (e.kind === 'typeCalls' || e.kind === 'inherits') {
                const s = namespaceOf(e.source), t = namespaceOf(e.target);
                if (s && t) pushPair(nsPair, `${e.kind}|${s}|${t}`, e.source, e.target);
            } else if (e.kind === 'calls') {
                const s = state.nodeById.get(e.source), t = state.nodeById.get(e.target);
                if (s && s.parentId && t && t.parentId) {
                    pushPair(typePair, `${s.parentId}|${t.parentId}`, e.source, e.target);
                }
            }
        }
        return { nsPair: nsPair, typePair: typePair };
    }

    function lookupDetail(idx, kind, a, b) {
        if (kind === 'typeCalls') return idx.typePair.get(`${a}|${b}`) || null;
        return idx.nsPair.get(`${DRILL[kind]}|${a}|${b}`) || null;
    }

    /*
     * 一条聚合边展开到最细一层（calls / inherits）的端点对。
     * 三级聚合表下来的路径是 nsCalls → typeCalls → calls，逐级替换端点即可。
     * 某一级查不到明细就保留原样 —— L1 的调用边被 L2 精确结果顶掉之后，
     * 聚合边可能找不到明细了，这时候宁可留着聚合边，也不能把这条线弄丢。
     */
    function terminalPairs(e, idx) {
        let level = [[e.source, e.target]];
        let kind = e.kind;
        for (let depth = 0; depth < 3 && DRILL[kind]; depth++) {
            const next = [];
            let grew = false;
            for (const [a, b] of level) {
                const pairs = lookupDetail(idx, kind, a, b);
                if (!pairs) { next.push([a, b]); continue; }
                for (const p of pairs) next.push(p);
                grew = true;
            }
            level = next;
            kind = DRILL[kind];
            if (!grew) break;
        }
        return level;
    }

    /**
     * 从聚合边的端点往下走，走到明细里那个具体节点上。
     * 只在「这一层容器确实展开了、而且下一层就在画布上」时才往下走一步；
     * 走不动就停在父节点上 —— 那条线于是仍然挂在父卡片上。
     *
     * 展开一个命名空间，线会一路挂到方法上（如果类型也展开着），
     * 而不是停在中间那一层 —— 用户看的是「这条线到底谁在调谁」。
     */
    function descendTo(base, terminal) {
        if (base === terminal) return base;

        // terminal → base 的路径（reverse 之后 base 的直接子节点在最前）
        const path = [];
        let cur = state.nodeById.get(terminal);
        while (cur && cur.id !== base) {
            path.push(cur.id);
            cur = cur.parentId ? state.nodeById.get(cur.parentId) : null;
        }
        if (!cur) return base;          // terminal 不在 base 底下（不该发生）
        path.reverse();

        let at = base;
        for (const step of path) {
            if (!canDescend(at) || !isNodeVisible(step)) break;
            at = step;
        }
        return at;
    }

    /** 这一端的容器展开了吗，展开出来的那一层又确实在画布上吗。 */
    function canDescend(id) {
        const n = state.nodeById.get(id);
        if (!n || !isContainerExpanded(id)) return false;
        return isVisible(n) && (state.childrenOf.get(id) || []).length > 0;
    }

    function isNodeVisible(id) {
        const n = state.nodeById.get(id);
        return !!n && isVisible(n);
    }

    /**
     * 把整张图的边投影成「真正要画的那几条」。
     * 返回 Map<渲染 id, {id, source, target, kind, bases}>，bases 是这条线对应的基础边 id ——
     * 「聚焦」过滤器是按基础边命中的，投影后一条线可能对应好几条基础边。
     *
     * 渲染时用的还是**基础边自己的类型**：线换了端点，但看上去还是原来那条线
     * （聚合过来的调用边仍然是聚合调用边的粗细和颜色），一眼能认出「就是它挪过去了」。
     */
    function projectEdges() {
        const idx = buildDrillIndex();
        const out = new Map();

        for (const e of state.edgeList) {
            if (!edgeInScope(e)) continue;

            for (const [a, b] of terminalPairs(e, idx)) {
                const s = descendTo(e.source, a);
                const t = descendTo(e.target, b);
                if (s === t) continue;
                // 沉下去的那一端本身也得在画布上（对面那个命名空间还折叠着时就是这样）
                if (!isNodeVisible(s) || !isNodeVisible(t)) continue;
                // 两端都沉下去了 —— 明细边自己已经在画同一件事，这条聚合边退场，
                // 否则同一对节点之间会同时出现一条粗的聚合边和一条细的明细边
                if (s !== e.source && t !== e.target) continue;

                const id = `${e.kind}|${s}|${t}`;
                let r = out.get(id);
                if (!r) out.set(id, r = { id: id, source: s, target: t, kind: e.kind, bases: [] });
                if (r.bases.indexOf(e.id) < 0) r.bases.push(e.id);
            }
        }
        return out;
    }

    /** 聚焦时「这条画出来的线对不对得上命中的基础边」。 */
    function renderEdgeInFilter(r) {
        if (!state.filter || !state.filter.edges) return true;
        return r.bases.some(id => state.filter.edges.has(id));
    }

    // ================================================================
    //  布局与位置
    // ================================================================

    function copyPos(p) { return { x: p.x, y: p.y }; }

    // —— 容器标题条的高度：从卡片模板里实测一次，别拍脑袋写常数 ——
    const headerCache = new Map();

    function headerHeight(kind) {
        let h = headerCache.get(kind);
        if (h !== undefined) return h;
        const probe = kind === 'namespace'
            ? nsCardTpl({ label: 'M', color: '#000', childCount: 0, preview: [], tray: 1, w: 220, h: 200 })
            : typeCardTpl({ label: 'M', color: '#000', tray: 1, w: 220, h: 200 });
        sizeHost.innerHTML = probe;
        const card = sizeHost.firstElementChild;
        const head = card && card.querySelector('.mermaid-header');
        h = head ? Math.ceil(head.getBoundingClientRect().height) : 28;
        sizeHost.innerHTML = '';
        headerCache.set(kind, h);
        return h;
    }

    /** 可见的直接子节点，按「文件 → 行号 → 名字」排序，保证每次重建的位置都一样。 */
    function visibleChildrenOf(n) {
        return (state.childrenOf.get(n.id) || [])
            .map(id => state.nodeById.get(id))
            .filter(k => k && isVisible(k))
            .sort((a, b) => String(a.file || '').localeCompare(String(b.file || ''))
                || (a.line || 0) - (b.line || 0)
                || String(a.label).localeCompare(String(b.label)));
    }

    /**
     * 这个节点在布局树里的父节点。
     * 父节点不可见、或者父容器没展开时，自己就是一棵树的根
     * （平铺模式下所有类型都是根，除非它外面的类型被展开了）。
     */
    function layoutParentOf(n) {
        if (!n.parentId) return null;
        const p = state.nodeById.get(n.parentId);
        if (!p || !isVisible(p) || !isContainerExpanded(p.id)) return null;
        return p;
    }

    /** 货架打包：一行一行铺，行内高度对齐。返回内容尺寸与每项的左上角偏移。 */
    function shelfPack(items, maxWidth, gapX, gapY) {
        const rows = [];
        let cur = [], curW = 0, curH = 0;
        for (const it of items) {
            if (cur.length && curW + gapX + it.w > maxWidth) {
                rows.push({ items: cur, w: curW, h: curH });
                cur = []; curW = 0; curH = 0;
            }
            curW += (cur.length ? gapX : 0) + it.w;
            curH = Math.max(curH, it.h);
            cur.push(it);
        }
        if (cur.length) rows.push({ items: cur, w: curW, h: curH });

        const w = rows.reduce((a, r) => Math.max(a, r.w), 0);
        const h = rows.reduce((a, r) => a + r.h, 0) + gapY * Math.max(0, rows.length - 1);

        const placed = [];
        let y = 0;
        for (const r of rows) {
            let x = 0;
            for (const it of r.items) {
                placed.push({ it: it, x: x, y: y + (r.h - it.h) / 2 });
                x += it.w + gapX;
            }
            y += r.h + gapY;
        }
        return { w: w, h: h, placed: placed };
    }

    /** 分列排布：先填满一列再开下一列。方法芯片用它，读起来就是一张成员表。 */
    function columnPack(items, cols, gapX, gapY) {
        const per = Math.ceil(items.length / cols);
        const columns = [];
        for (let i = 0; i < items.length; i += per) columns.push(items.slice(i, i + per));

        const colW = columns.map(c => c.reduce((a, it) => Math.max(a, it.w), 0));
        const colH = columns.map(c => c.reduce((a, it) => a + it.h, 0) + gapY * Math.max(0, c.length - 1));

        const w = colW.reduce((a, x) => a + x, 0) + gapX * Math.max(0, columns.length - 1);
        const h = colH.reduce((a, x) => Math.max(a, x), 0);

        const placed = [];
        let x = 0;
        columns.forEach((c, ci) => {
            let y = 0;
            for (const it of c) {
                placed.push({ it: it, x: x, y: y });
                y += it.h + gapY;
            }
            x += colW[ci] + gapX;
        });
        return { w: w, h: h, placed: placed };
    }

    /**
     * 一组子节点的排布。
     *
     * 方法芯片按「列」排 —— 一列读起来最像成员表；几十个方法时再多开几列，
     * 免得托盘被拉成一根竖条。
     *
     * 其它情况用货架打包，但「一行铺多宽」不拍一个系数：试几组候选宽度，
     * 挑铺出来最接近目标长宽比的那一组。
     * 拍系数的话，卡片高度稍有变化就会在「挤成一列」和「铺成一条」之间反复横跳。
     *
     * 目标长宽比分两种：**顶层跟着画布走** —— 内容要铺满整个工作区，
     * 宽窗口里挤成一根竖条是没意义的（两边全是空白，字还小）；
     * 容器内部仍然尽量接近正方形，免得一个托盘被拉成一条横幅。
     */
    function packGroup(items, isRoot) {
        const gapX = isRoot ? BOX.rootGapX : BOX.gapX;
        const gapY = isRoot ? BOX.rootGapY : BOX.gapY;

        if (!isRoot && items.every(it => it.n.kind === 'method')) {
            const cols = Math.max(1, Math.min(4, Math.ceil(items.length / BOX.perColumn)));
            return columnPack(items, cols, gapX, gapY);
        }

        let maxW = 0, area = 0;
        for (const it of items) {
            maxW = Math.max(maxW, it.w);
            area += (it.w + gapX) * (it.h + gapY);
        }

        const targetAspect = isRoot ? viewportAspect() : 1;
        const cap = isRoot ? Infinity : BOX.maxRow;

        const base = Math.max(maxW, Math.sqrt(area));
        const candidates = [base, base * 1.25, base * 1.6, base * 2.1];
        // 每个「一行放几列」的宽度都算一个候选：卡片宽度基本一致，
        // 这样能把可选的列数全试一遍，而不是只试头几个
        const maxCols = Math.min(items.length, 40);
        for (let cols = 1; cols <= maxCols; cols++) {
            candidates.push(maxW * cols + gapX * (cols - 1));
        }
        if (isRoot && items.length > maxCols) {
            candidates.push(items.length * maxW + gapX * (items.length - 1));
        }

        let best = null;
        for (const cand of candidates) {
            const width = Math.max(maxW, Math.min(cand, cap));
            const packed = shelfPack(items, width, gapX, gapY);
            const ratio = (packed.w + gapX) / (packed.h + gapY);
            const score = Math.abs(Math.log(ratio / targetAspect));
            if (!best || score < best.score) best = { score: score, packed: packed };
        }
        return best.packed;
    }

    /**
     * 工作区的长宽比：画布尺寸扣掉顶部工具条（它浮在画布上）。
     * 顶层打包按这个比例铺，内容才会铺满工作区。
     */
    function viewportAspect() {
        const w = cy.width();
        const toolbarEl = document.getElementById('toolbar');
        const h = cy.height() - (toolbarEl ? toolbarEl.offsetHeight : 48);
        if (!(w > 0) || !(h > 0)) return 1.6;   // 还没量出尺寸时给个常见的宽屏比例
        return w / h;
    }

    /** 自底向上算一棵子树的尺寸，子节点偏移在 kid.dx / kid.dy 里（相对本节点中心）。 */
    function buildBox(n) {
        const kids = isContainerExpanded(n.id) ? visibleChildrenOf(n) : [];
        if (kids.length === 0) {
            // 叶子：卡片是普通的「标题 + 成员列表」
            delete n.tray;
            const s = measureSize(n);
            return { n: n, w: s.w, h: s.h, kids: null };
        }

        const built = kids.map(buildBox);
        const head = headerHeight(n.kind);
        const inner = packGroup(built, false);
        const w = Math.max(CARD_WIDTH, Math.ceil(inner.w + BOX.pad * 2));
        const h = Math.ceil(head + BOX.pad * 2 + inner.h);

        // 托盘：尺寸写死进卡片模板，正文留空给子节点
        n.tray = true;
        n.boxW = w;
        n.boxH = h;

        const placed = inner.placed.map(p => {
            const b = p.it;
            return {
                box: b,
                dx: -inner.w / 2 + p.x + b.w / 2,
                dy: -h / 2 + head + BOX.pad + p.y + b.h / 2,
            };
        });
        return { n: n, w: w, h: h, kids: placed };
    }

    /** 把盒子树的绝对坐标写进结果表。 */
    function placeBox(box, cx, cy, out, pure, bounds) {
        // 用户拖动过的节点，位移在这里生效。挂在父节点上的位移会被子节点自动继承 ——
        // 子节点的坐标本来就是从父节点中心推出来的，不需要逐个记。
        const off = state.offsets.get(box.n.id);
        let x = cx + (off ? off.dx : 0);
        let y = cy + (off ? off.dy : 0);

        // 纯布局坐标（不含位移）单独记一份：拖动记位移时要拿它当基准，
        // 用「已经叠加过位移的坐标」当基准的话，第二次拖动会把上一次的位移吞掉。
        pure.set(box.n.id, { x: cx, y: cy });

        // 子节点不许被拖出父容器：越界就贴边站住
        if (bounds) {
            x = clampAxis(x, bounds.left + box.w / 2, bounds.right - box.w / 2);
            y = clampAxis(y, bounds.top + box.h / 2, bounds.bottom - box.h / 2);
        }

        out.set(box.n.id, { x: x, y: y, w: box.w, h: box.h, tray: !!box.kids });
        if (!box.kids) return;

        // 容器给子节点划出的可落范围：左右留内边距，上边让开标题条
        const inner = {
            left: x - box.w / 2 + BOX.pad,
            right: x + box.w / 2 - BOX.pad,
            top: y - box.h / 2 + headerHeight(box.n.kind) + BOX.pad * 0.5,
            bottom: y + box.h / 2 - BOX.pad,
        };
        for (const k of box.kids) placeBox(k.box, x + k.dx, y + k.dy, out, pure, inner);
    }

    /** 夹在 [lo, hi] 之间；范围本身反了就取中点（容器比子节点还小的情况）。 */
    function clampAxis(v, lo, hi) {
        if (hi < lo) return (lo + hi) / 2;
        return Math.min(Math.max(v, lo), hi);
    }

    /**
     * 整张图的布局。
     *
     * 顶层从固定原点向右下铺：展开一个容器只会把后面的东西推开，
     * 不会让整个画面重新居中 —— 用户记住的相对位置还在。
     */
    function computeLayout() {
        const out = new Map();
        const pure = new Map();
        const roots = state.nodes.filter(n => isVisible(n) && !layoutParentOf(n));
        state.lastLayout = out;
        state.lastPureLayout = pure;
        if (roots.length === 0) return out;

        const built = roots.map(buildBox);
        const inner = packGroup(built, true);
        const originX = -inner.w / 2;
        const originY = -inner.h / 2;
        for (const p of inner.placed) {
            placeBox(p.it, originX + p.x + p.it.w / 2, originY + p.y + p.it.h / 2, out, pure, null);
        }
        return out;
    }

    function fitView(duration) {
        cy.resize();
        if (cy.nodes().length === 0) return;
        cy.animate({ fit: { padding: 60 } }, { duration: duration || 500, easing: 'ease-out' });
    }

    // ================================================================
    //  渲染（diff）
    // ================================================================

    function nodeData(n, position, box) {
        const sel = state.selected === n.id ? 1 : 0;
        if (n.kind === 'namespace') {
            return {
                data: {
                    id: n.id, label: n.label, kind: 'namespace', fqn: n.fqn,
                    color: TYPE_COLORS.namespace, isNs: 1,
                    childCount: n.childCount || 0,
                    preview: n.preview || [],
                    expanded: isContainerExpanded(n.id) ? 1 : 0,
                    tray: box.tray ? 1 : 0,
                    hovered: 0, sel: sel,
                    w: box.w, h: box.h,
                },
                position: position,
            };
        }
        if (n.kind === 'method') {
            const parent = state.nodeById.get(n.parentId);
            const color = parent ? (TYPE_COLORS[parent.kind] || TYPE_COLORS.type) : TYPE_COLORS.type;
            return {
                data: {
                    id: n.id, label: n.label, kind: 'method', fqn: n.fqn,
                    color: color, ...chipColors(color),
                    isMethod: 1, parentId: n.parentId,
                    file: n.file, line: n.line,
                    hovered: 0, sel: sel,
                    w: box.w, h: box.h,
                },
                position: position,
            };
        }
        return {
            data: {
                id: n.id, label: n.label, kind: n.kind, fqn: n.fqn,
                color: TYPE_COLORS[n.kind] || TYPE_COLORS.type, isType: 1,
                childCount: (state.childrenOf.get(n.id) || []).length,
                fields: n.fields || [], methods: n.methods || [],
                file: n.file, line: n.line,
                tray: box.tray ? 1 : 0,
                hovered: 0, sel: sel,
                w: box.w, h: box.h,
            },
            position: position,
        };
    }

    function refreshNodeData(el, n, box) {
        // 只刷新会变的部分，避免 position 之类的字段被误改
        // 顺便掐掉可能还在跑的尺寸补间：它会把 w/h 写回上一轮布局的值
        el.data('tweenGen', null);
        const d = nodeData(n, el.position(), box).data;
        el.data('label', d.label);
        el.data('fields', d.fields);
        el.data('methods', d.methods);
        el.data('childCount', d.childCount);
        el.data('preview', d.preview);
        el.data('expanded', d.expanded);
        el.data('file', d.file);
        el.data('line', d.line);
        el.data('tray', d.tray);
        // 颜色也要跟着主题走：换了主题之后 canvas 上的芯片得重新上色
        el.data('color', d.color);
        if (d.chipBg) {
            el.data('ink', d.ink);
            el.data('chipBg', d.chipBg);
            el.data('chipHover', d.chipHover);
        }
        el.data('w', d.w);
        el.data('h', d.h);
    }

    function kill(el) {
        if (el.empty()) return;
        el.data('dying', 1);
        el.animate({ style: { opacity: 0 } },
            { duration: ANIM.fadeDuration, easing: 'ease-in', complete: () => el.remove() });
    }

    /**
     * 让一个元素平滑地变成「不透明 + 落到目标位置」。
     * 正在淡出的元素要先把淡出动画掐掉，否则 remove() 的回调还会把它删掉。
     */
    function settle(el, target, reviving, duration) {
        el.stop(true);
        if (reviving) el.data('dying', 0);
        const props = {};
        if (target) props.position = copyPos(target);
        if (reviving) {
            el.style({ opacity: 0 });
            props.style = { opacity: 1 };
        }
        el.animate(props, { duration: duration, easing: ANIM.easing });
    }

    /**
     * 容器「长大」的过程要看得见 —— 直接改 data(w/h) 会让卡片瞬间跳到最终大小，
     * 展开就变成了「啪」的一下。这里在 rAF 里补间，每帧写一次 data，
     * cytoscape-node-html-label 会跟着把卡片重排到当前尺寸。
     */
    function tweenBox(el, from, to, duration) {
        // 连续展开/折叠会叠加多条补间，用代次号把旧的踢掉，否则尺寸会被两边来回抢
        const gen = (state.tweenGen = (state.tweenGen || 0) + 1);
        const t0 = performance.now();
        const step = () => {
            if (el.removed() || el.data('tweenGen') !== gen) return;
            const k = Math.min(1, (performance.now() - t0) / duration);
            const e = 1 - Math.pow(1 - k, 3);
            el.data('w', from.w + (to.w - from.w) * e);
            el.data('h', from.h + (to.h - from.h) * e);
            if (k < 1) requestAnimationFrame(step);
        };
        el.data('tweenGen', gen);
        requestAnimationFrame(step);
    }

    function render(opts) {
        opts = opts || {};
        const animate = opts.animate !== false;

        // 这一轮的代次号。异步的收尾动作（出生动画、落地校正）靠它判断自己是不是已经过期：
        // 过期的写入会把节点钉在「上一轮布局」的位置上，那正是「子节点跑到父容器外面」的成因。
        const renderGen = state.renderGen = (state.renderGen || 0) + 1;

        const want = new Set();
        for (const n of state.nodes) if (isVisible(n)) want.add(n.id);

        // 布局先算：每个可见节点的大小和位置都在这一份结果里。
        // 展开一个容器会让它的卡片长大，容器后面的东西跟着重排 —— 这是内嵌布局的必然，
        // 靠下面的位置动画把这次重排演出来，而不是让画面「跳」一下。
        const layout = computeLayout();

        // —— 节点：淘汰 ——
        cy.nodes().forEach(el => {
            if (want.has(el.id())) return;
            if (animate) kill(el);
            else el.remove();
        });

        // —— 先处理已经在画布上的节点：刷新尺寸/内容 + 平滑过渡到新位置 ——
        const born = [];
        for (const n of state.nodes) {
            if (!want.has(n.id)) continue;
            const el = cy.getElementById(n.id);
            if (el.empty()) { born.push(n); continue; }

            const box = layout.get(n.id);
            if (!box) continue;
            const reviving = !!el.data('dying');
            const prev = { w: el.data('w'), h: el.data('h') };
            refreshNodeData(el, n, box);

            const grew = Math.abs(prev.w - box.w) > 0.5 || Math.abs(prev.h - box.h) > 0.5;
            const cur = el.position();
            const moved = Math.abs(cur.x - box.x) > 0.5 || Math.abs(cur.y - box.y) > 0.5;
            // 正在被拖的节点，位置归鼠标管，别让补间动画跟它抢。
            // 判据里必须有 state.drag.moved：cytoscape 的事件顺序是 grab → tap → free，
            // 而「点开一个容器」的那次渲染正好发生在 tap 里 —— 那时鼠标当然还按在这个
            // 节点上。只看「鼠标按着」的话，这一轮会跳过它的落位：卡片留在原地，
            // 子节点却按新布局散开，看起来就是「子节点掉在父容器外面」。
            const beingDragged = state.drag.moved &&
                !!state.drag.el && !state.drag.el.removed() && state.drag.el.id() === n.id;

            if (!animate) {
                if (moved && !beingDragged) el.position(copyPos(box));
                // 非动画渲染要把不透明度拉回 1：上一次的淡入可能正卡在半路
                //（刚展开就又切了主题/又点了一次展开），不纠正的话这个节点会一直半透明
                el.stop(true);
                if (reviving) el.data('dying', 0);
                el.style({ opacity: 1 });
                continue;
            }
            if (!moved && !reviving && !grew) continue;

            if (moved && !beingDragged) settle(el, box, reviving, ANIM.moveDuration);
            else if (reviving) settle(el, null, true, ANIM.moveDuration);
            if (grew) tweenBox(el, prev, { w: box.w, h: box.h }, ANIM.growDuration);
        }

        // —— 新增节点：从容器中心「长」到自己的位置 ——
        // 注意 position 一定要复制：cytoscape 的 position() 交出的是元素内部那个
        // position 对象，add() 又会直接引用传进去的对象。共用同一个对象的话，
        // 动一个等于动全部，整批子节点会全叠在容器上。
        born.forEach((n, i) => {
            const box = layout.get(n.id);
            if (!box) return;

            const parent = layoutParentOf(n);
            const parentEl = parent ? cy.getElementById(parent.id) : null;
            const center = parentEl && !parentEl.empty()
                ? copyPos(parentEl.position())
                : { x: box.x, y: box.y };
            const start = {
                x: center.x + (box.x - center.x) * 0.3,
                y: center.y + (box.y - center.y) * 0.3,
            };

            let el;
            try {
                el = cy.add(nodeData(n, copyPos(animate ? start : box), box));
            } catch (err) {
                console.warn('[码图] 跳过节点', n, err);
                return;
            }

            if (!animate) return;
            el.style({ opacity: 0 });
            const delay = Math.min(i * 12, 120);
            const myGen = renderGen;
            const run = () => {
                if (el.removed()) return;
                // 出生动画是延迟起的：这中间只要又渲染过一轮（保存触发的重建、L2 回来、
                // 切主题、改窗口大小），这一轮就作废 —— 否则它会拿着上一轮布局的坐标
                // 把节点钉在那儿，看起来就是「子节点没待在父容器里」。
                if (state.renderGen !== myGen) return;
                el.animate(
                    { position: copyPos(box), style: { opacity: 1 } },
                    { duration: ANIM.growDuration, easing: ANIM.easing });
            };
            if (delay > 0) setTimeout(run, delay);
            else run();
        });

        // —— 边 ——
        // 先投影再比：容器展开后，聚合边会改挂到里面真正参与的子节点上，
        // 所以「同一批数据」在展开前后画出来的端点可能完全不同。
        refreshEdgeList();
        const all = projectEdges();
        const wantEdges = new Map();
        for (const [id, r] of all) {
            if (renderEdgeInFilter(r)) wantEdges.set(id, r);
        }
        state.renderEdges = wantEdges;

        cy.edges().forEach(el => {
            const e = wantEdges.get(el.id());
            if (e) return;
            if (animate) kill(el);
            else el.remove();
        });

        for (const [id, e] of wantEdges) {
            const el = cy.getElementById(id);
            if (!el.empty()) {
                const target = EDGE_OPACITY[e.kind] || 0.6;
                if (el.data('dying')) {
                    el.stop(true);
                    el.data('dying', 0);
                    el.animate({ style: { opacity: target } },
                        { duration: 150, easing: 'ease-out' });
                } else if (!animate) {
                    // 同理：淡入到一半被非动画渲染打断的边，会永远停在半透明（甚至全透明）上
                    el.stop(true);
                    el.style({ opacity: target });
                }
                continue;
            }
            if (cy.getElementById(e.source).empty()) continue;
            if (cy.getElementById(e.target).empty()) continue;
            const opacity = EDGE_OPACITY[e.kind] || 0.6;
            let added;
            try {
                added = cy.add({
                    data: {
                        id: e.id, source: e.source, target: e.target,
                        kind: e.kind, bases: e.bases,
                    },
                });
            } catch (err) {
                console.warn('[码图] 跳过边', e, err);
                continue;
            }
            if (animate) {
                added.style({ opacity: 0 });
                added.animate({ style: { opacity: opacity } },
                    { duration: ANIM.growDuration, easing: ANIM.easing });
            } else {
                added.style({ opacity: opacity });
            }
        }

        // 命名空间卡片上的「展开中」提示要跟着状态走
        for (const n of state.nodes) {
            if (n.kind !== 'namespace') continue;
            const el = cy.getElementById(n.id);
            if (!el.empty()) el.data('expanded', isContainerExpanded(n.id) ? 1 : 0);
        }

        // 悬停高亮是即时状态，重建之后要按当前悬停重新盖一遍；
        // 悬停的节点没了（重新分析 / 折叠）就收干净，别把线留在压暗状态。
        if (hoverId) {
            const hoverEl = cy.getElementById(hoverId);
            if (hoverEl.empty()) { hoverId = null; clearSpotlight(); }
            else spotlight(hoverEl);
        }

        // 拖动途中如果有人渲染了一轮（保存触发的重建、L2 回来），新上画布的子节点
        // 不在 riders 名单里，后面的拖动就带不上它们 —— 重新取一次名单。
        if (state.drag.el && !state.drag.el.removed()) {
            state.drag.riders = visibleDescendants(state.drag.el);
        }
        scheduleReconcile();

        state.drawn = { nodes: want.size, edges: wantEdges.size };
        updateStats();
    }

    /**
     * 落地校正：一轮动画播完之后，核对每个节点是不是真的落在布局位置上，差得多的直接摆正。
     *
     * 正常情况下这里什么都不做。它是给这类情况兜底的：位置被某个过期的异步回调
     * （延迟起的出生动画、被打断的补间、拖动途中重排）改过，而后面又没有任何渲染
     * 来收尾 —— 表现出来就是「子节点跑到父容器外面」，而且一直不回去。
     */
    function scheduleReconcile() {
        const gen = state.renderGen;
        clearTimeout(state.reconcileTimer);
        state.reconcileTimer = setTimeout(() => {
            if (gen !== state.renderGen) return;                  // 又渲染过了，交给新一轮
            // 真拖着的时候别插手（只是点了一下不算，见 render 里的 beingDragged）
            if (state.drag.moved && state.drag.el && !state.drag.el.removed()) return;
            cy.nodes().forEach(el => {
                if (el.data('dying')) return;
                const box = state.lastLayout && state.lastLayout.get(el.id());
                if (!box) return;
                const p = el.position();
                if (Math.abs(p.x - box.x) > 1 || Math.abs(p.y - box.y) > 1) {
                    el.stop(true);
                    el.position(copyPos(box));
                }
                if (Math.abs(el.data('w') - box.w) > 1 || Math.abs(el.data('h') - box.h) > 1) {
                    el.data('w', box.w);
                    el.data('h', box.h);
                }
            });
        }, ANIM.growDuration + 360);
    }

    function updateStats() {
        const modeText = state.mode === 'namespace' ? '聚合：命名空间' : '平铺：类型';
        if (modeLabel && modeLabel.textContent !== modeText) modeLabel.textContent = modeText;
        if (modeBtn) {
            modeBtn.title = state.mode === 'namespace'
                ? '当前按命名空间聚合 · 点击切成平铺的类型'
                : '当前平铺类型 · 点击切成命名空间聚合';
        }

        if (!state.stats) return;
        // 用「目标集合」的规模而不是 cy 的实时规模：淡出中的元素还在画布上，
        // 显示实时值会让状态栏在折叠动画期间跳一下。
        const drawn = state.drawn || { nodes: cy.nodes().length, edges: cy.edges().length };
        const s = state.stats;
        const pills = [
            [escapeHtml(s.projectId), ''],
            [`v${s.version}`, ''],
            [`${s.fileCount} 文件`, ''],
            [`${drawn.nodes}/${s.nodes} 节点`, ' hot'],
            [`${drawn.edges} 边`, ''],
            [`${s.elapsedMs} ms`, ''],
        ];
        if (s.fromCache) pills.push([`L1 缓存 ${s.cachedFiles}`, '']);
        if (s.analyzer) pills.push([escapeHtml(s.analyzer), '']);
        statsEl.innerHTML = pills
            .map(([text, cls]) => `<span class="pill${cls}">${text}</span>`)
            .join('<span class="sep">·</span>');
        statsEl.title =
            `${s.projectId} · v${s.version} · ${s.fileCount} 文件 · ` +
            `${drawn.nodes}/${s.nodes} 节点 · ${drawn.edges} 边 · ${s.elapsedMs} ms` +
            (s.fromCache ? ` · L1 缓存 ${s.cachedFiles} 文件` : '') +
            (s.analyzer ? ` · 分析：${s.analyzer}` : '');
    }

    function refreshHint() {
        const tips = state.mode === 'namespace'
            ? '单击命名空间就地展开，类型会排进卡片里'
            : '单击类型就地展开，方法芯片排在卡片内部';
        setHint(`${tips} · 按 ? 查看全部快捷键`);
    }

    // ================================================================
    //  展开 / 折叠
    // ================================================================

    function expand(id) {
        if (state.expanded.has(id)) return;
        state.expanded.add(id);
        const n = state.nodeById.get(id);
        if (n && isTypeNode(n)) requestResolve(n);
        render({ animate: true });
    }

    function collapse(id) {
        if (!state.expanded.has(id)) return;
        state.expanded.delete(id);
        render({ animate: true });
    }

    function toggle(id) {
        if (state.expanded.has(id)) collapse(id);
        else expand(id);
    }

    function collapseAll() {
        if (state.expanded.size === 0) return;
        state.expanded.clear();
        render({ animate: true });
    }

    function expandOneLevel() {
        let changed = false;
        for (const n of state.nodes) {
            if (!isVisible(n)) continue;
            const isContainer = state.mode === 'namespace' ? n.kind === 'namespace' : isTypeNode(n);
            if (!isContainer) continue;
            if (!state.expanded.has(n.id)) { state.expanded.add(n.id); changed = true; }
        }
        if (!changed) return;
        // 批量展开是一次大重排，这时候重新取景才不会让用户面对一屏空白
        render({ animate: false });
        fitView();
    }

    /**
     * 双击容器：把它整棵子树里的容器一次性展开。
     * 带上限 —— 大项目上「展开所有后代」能把画布瞬间铺满，那种时候宁可展开一层，
     * 剩下的交给用户继续双击。
     */
    function expandSubtree(id) {
        const LIMIT = 60;
        const isContainer = n => (state.mode === 'namespace'
            ? n.kind === 'namespace' : isTypeNode(n));
        const queue = [id];
        let added = 0;
        if (!state.expanded.has(id)) state.expanded.add(id);
        while (queue.length > 0 && added < LIMIT) {
            const cur = queue.shift();
            for (const cid of (state.childrenOf.get(cur) || [])) {
                const c = state.nodeById.get(cid);
                if (!c || !isContainer(c)) continue;
                if (!state.expanded.has(cid)) { state.expanded.add(cid); added++; }
                queue.push(cid);
            }
        }
        if (added === 0) return;
        render({ animate: true });
        setHint(added >= LIMIT
            ? `一次最多展开 ${LIMIT} 个容器，继续双击可以接着往下开`
            : `展开了 ${added} 个容器`);
    }

    // ================================================================
    //  聚焦过滤器（搜索与调用链共用）
    // ================================================================

    function ancestorsOf(id) {
        const out = [];
        const seen = new Set();
        let n = state.nodeById.get(id);
        while (n && n.parentId) {
            if (seen.has(n.parentId)) break;
            seen.add(n.parentId);
            const p = state.nodeById.get(n.parentId);
            if (!p) break;
            out.push(p.id);
            n = p;
        }
        return out;
    }

    function withAncestors(ids) {
        const out = new Set();
        const stack = [...ids];
        while (stack.length) {
            const id = stack.pop();
            if (out.has(id)) continue;
            out.add(id);
            const n = state.nodeById.get(id);
            if (n && n.parentId) stack.push(n.parentId);
        }
        return out;
    }

    function applyFilter(filter) {
        if (!state.filter && filter) state.preFilterExpanded = new Set(state.expanded);
        state.filter = filter;

        if (filter) {
            // 把命中路径上的类型真正展开，这样 L2 精确化也会跟着发生
            let requested = 0;
            for (const id of filter.nodes) {
                const n = state.nodeById.get(id);
                if (!n || !isTypeNode(n)) continue;
                if (!state.expanded.has(id)) state.expanded.add(id);
                if (requested < 40 && !state.requested.has(id)) { requestResolve(n); requested++; }
            }
        } else if (state.preFilterExpanded) {
            state.expanded = new Set(state.preFilterExpanded);
            state.preFilterExpanded = null;
        }

        render({ animate: true });
        updateFocusBar();
    }

    function clearFilter(keepSearch) {
        if (!state.filter) return;
        applyFilter(null);
        if (!keepSearch && searchEl) searchEl.value = '';
        hideResults();
        refreshHint();
    }

    function updateFocusBar() {
        if (!focusBar) return;
        const f = state.filter;
        if (!f) { focusBar.classList.remove('open'); return; }
        focusBar.classList.add('open');
        focusLabel.textContent = f.label;
    }

    function centerOn(id) {
        const el = cy.getElementById(id);
        if (el.empty()) return;
        setSelected(id);
        cy.animate(
            { center: { eles: el }, zoom: Math.max(cy.zoom(), 0.7) },
            { duration: 420, easing: 'ease-out' });
    }

    // ================================================================
    //  搜索
    // ================================================================

    const KIND_LABEL = {
        namespace: '命名空间', class: '类', interface: '接口',
        struct: '结构', record: '记录', type: '类型', method: '方法',
    };

    let searchTimer = null;

    function runSearch(rawQuery) {
        const q = rawQuery.trim().toLowerCase();
        if (q.length === 0) { clearFilter(); return; }

        const labelHits = [];
        const fqnHits = [];
        for (const n of state.nodes) {
            if (n.kind === 'method' && q.length < 2) continue; // 方法太多，单字符不搜
            const label = (n.label || '').toLowerCase();
            if (label === q) { labelHits.unshift(n); continue; }
            if (label.startsWith(q)) { labelHits.push(n); continue; }
            if (label.includes(q)) { labelHits.push(n); continue; }
            if ((n.fqn || '').toLowerCase().includes(q)) fqnHits.push(n);
        }

        const hits = labelHits.concat(fqnHits);
        const shown = hits.slice(0, 200);
        const ids = shown.map(n => n.id);

        if (hits.length === 0) {
            applyFilter(null);
            renderResults([], 0, rawQuery);
            setHint(`没有匹配「${rawQuery}」的类型或方法`, true);
            return;
        }

        applyFilter({
            nodes: withAncestors(ids),
            edges: null,
            autoExpand: true,
            kind: 'search',
            label: `搜索「${rawQuery}」：命中 ${hits.length} 个${hits.length > shown.length ? `（只显示前 ${shown.length} 个）` : ''}`,
        });
        renderResults(shown, hits.length, rawQuery);
        setHint(`搜索「${rawQuery}」命中 ${hits.length} 个 · Enter 跳到第一个 · Esc 退出`);
    }

    /** 把命中的那一段套上 <mark>，让人一眼看见「为什么它会出现在这里」。 */
    function highlightMatch(text, needle) {
        const s = String(text == null ? '' : text);
        if (!needle) return escapeHtml(s);
        const at = s.toLowerCase().indexOf(needle);
        if (at < 0) return escapeHtml(s);
        return escapeHtml(s.slice(0, at)) +
            '<mark>' + escapeHtml(s.slice(at, at + needle.length)) + '</mark>' +
            escapeHtml(s.slice(at + needle.length));
    }

    let resultRows = [];    // 当前列出的候选（顺序与 DOM 一致）
    let resultActive = -1;  // 键盘选中的那一行

    function renderResults(list, total, query) {
        if (!resultsEl) return;
        resultsEl.innerHTML = '';
        resultRows = list.slice(0, 40);
        resultActive = resultRows.length ? 0 : -1;
        if (resultRows.length === 0) { hideResults(); return; }

        const needle = query.trim().toLowerCase();
        resultRows.forEach((n, i) => {
            const row = document.createElement('div');
            row.className = 'row' + (i === resultActive ? ' active' : '');
            const color = TYPE_COLORS[n.kind] || TYPE_COLORS.type;
            row.innerHTML =
                `<span class="kind" style="background:${color}">${KIND_LABEL[n.kind] || n.kind}</span>` +
                `<span class="label">${highlightMatch(n.label, needle)}</span>` +
                `<span class="fqn" title="${escapeHtml(n.fqn || '')}">${escapeHtml(n.fqn || '')}</span>`;
            row.addEventListener('mousedown', ev => {
                ev.preventDefault();
                pickResult(i);
            });
            row.addEventListener('mousemove', () => setActiveResult(i));
            resultsEl.appendChild(row);
        });

        if (total > resultRows.length) {
            const more = document.createElement('div');
            more.className = 'more';
            more.textContent = `… 还有 ${total - resultRows.length} 个匹配，把关键词写具体一点`;
            resultsEl.appendChild(more);
        }

        const foot = document.createElement('div');
        foot.className = 'foot';
        foot.innerHTML = `<span>${total} 个匹配</span>` +
            '<span style="margin-left:auto">↑↓ 选择 · Enter 定位 · Esc 退出</span>';
        resultsEl.appendChild(foot);

        resultsEl.classList.add('open');
    }

    function setActiveResult(i) {
        const rows = resultsEl ? resultsEl.querySelectorAll('.row') : [];
        if (!rows.length) return;
        resultActive = (i + rows.length) % rows.length;
        rows.forEach((r, k) => r.classList.toggle('active', k === resultActive));
        if (rows[resultActive].scrollIntoView) {
            rows[resultActive].scrollIntoView({ block: 'nearest' });
        }
    }

    function pickResult(i) {
        const n = resultRows[i];
        if (!n) return;
        centerOn(n.id);
        hideResults();
    }

    function hideResults() {
        if (resultsEl) resultsEl.classList.remove('open');
    }

    // ================================================================
    //  调用链追踪
    // ================================================================

    /** 按节点层级挑选要跟随的边类型：方法跟 calls，类型跟 typeCalls/inherits，命名空间跟聚合边。 */
    function traceEdgeKinds(node) {
        if (!node) return [];
        if (node.kind === 'method') return ['calls'];
        if (node.kind === 'namespace') return ['nsCalls', 'nsInherits'];
        return ['typeCalls', 'inherits'];
    }

    function traceFrom(startId, direction, depth) {
        const start = state.nodeById.get(startId);
        if (!start) { setHint('先点一个节点再追踪调用链', true); return; }

        const kinds = new Set(traceEdgeKinds(start));
        const outgoing = direction !== 'in';

        const nodes = new Set([startId]);
        const edges = new Set();
        let frontier = [startId];

        for (let d = 0; d < depth && frontier.length; d++) {
            const next = [];
            for (const id of frontier) {
                for (const e of state.edgeList) {
                    if (!kinds.has(e.kind)) continue;
                    const from = outgoing ? e.source : e.target;
                    const to = outgoing ? e.target : e.source;
                    if (from !== id) continue;
                    if (!state.nodeById.has(to)) continue;
                    edges.add(e.id);
                    if (!nodes.has(to)) { nodes.add(to); next.push(to); }
                }
            }
            frontier = next;
        }

        if (edges.size === 0) {
            setHint(`「${start.label}」在 ${depth} 层内没有可追踪的${outgoing ? '下游' : '上游'}调用`, true);
            return;
        }

        applyFilter({
            nodes: withAncestors(nodes),
            edges,
            autoExpand: true,
            kind: 'trace',
            label: `${start.label} ${outgoing ? '下游' : '上游'} ${depth} 层：${nodes.size} 节点 / ${edges.size} 边` +
                (edges.size > 0 ? '（方法级调用未精确解析时基于 L1 近似）' : ''),
        });
        setHint(`调用链：${nodes.size} 节点 / ${edges.size} 边 · Esc 退出聚焦`);
    }

    // ================================================================
    //  导出
    // ================================================================

    function visibleGraph() {
        const nodes = state.nodes.filter(isVisible);
        const ids = new Set(nodes.map(n => n.id));
        // 用投影后的边：导出要和画布上看到的一致（展开后线是挂在子节点上的）
        const edges = [];
        for (const r of state.renderEdges.values()) {
            if (ids.has(r.source) && ids.has(r.target)) edges.push(r);
        }
        return { nodes, edges };
    }

    function buildMermaid() {
        const { nodes, edges } = visibleGraph();
        const alias = new Map();
        const lines = [
            '%% 码图导出 · ' + (state.stats ? `${state.stats.projectId} v${state.stats.version}` : '') +
            ` · 模式 ${state.mode} · ${nodes.length} 节点 / ${edges.length} 边`,
            'flowchart LR',
        ];

        const classOf = {
            namespace: 'ns', class: 'cls', interface: 'itf',
            struct: 'st', record: 'rec', type: 'other', method: 'mth',
        };
        const byClass = new Map();

        nodes.forEach((n, i) => {
            const a = 'n' + i;
            alias.set(n.id, a);
            const text = String(n.label).replace(/"/g, '&quot;');
            const shape = n.kind === 'namespace' ? `[["${text}"]]`
                : n.kind === 'method' ? `(("${text}"))`
                    : `["${text}"]`;
            lines.push(`  ${a}${shape}`);
            const cls = classOf[n.kind] || 'other';
            if (!byClass.has(cls)) byClass.set(cls, []);
            byClass.get(cls).push(a);
        });

        const EDGE_TEXT = {
            inherits: '继承', nsInherits: '继承', typeCalls: '调用',
            nsCalls: '调用', calls: '调用', typeContains: '嵌套',
        };
        for (const e of edges) {
            const s = alias.get(e.source);
            const t = alias.get(e.target);
            if (!s || !t) continue;
            lines.push(`  ${s} -->|${EDGE_TEXT[e.kind] || e.kind}| ${t}`);
        }

        lines.push('  classDef ns fill:#5b6b7f,stroke:#5b6b7f,color:#ffffff;');
        lines.push('  classDef cls fill:#eaf2ff,stroke:#4c8dff,color:#123;');
        lines.push('  classDef itf fill:#e6f5f2,stroke:#2a9d8f,color:#123;');
        lines.push('  classDef st fill:#fdf1e5,stroke:#f4a261,color:#123;');
        lines.push('  classDef rec fill:#fdeee9,stroke:#e76f51,color:#123;');
        lines.push('  classDef other fill:#f1f2f4,stroke:#888888,color:#123;');
        lines.push('  classDef mth fill:#ffffff,stroke:#8c9298,color:#333;');
        for (const [cls, list] of byClass) lines.push(`  class ${list.join(',')} ${cls};`);

        return lines.join('\n') + '\n';
    }

    function buildJson() {
        const { nodes, edges } = visibleGraph();
        return JSON.stringify({
            tool: '码图',
            exportedAt: new Date().toISOString(),
            projectId: state.stats ? state.stats.projectId : null,
            version: state.stats ? state.stats.version : null,
            root: state.root,
            mode: state.mode,
            filter: state.filter ? state.filter.label : null,
            nodes: nodes.map(n => ({
                id: n.id, label: n.label, kind: n.kind, fqn: n.fqn,
                file: n.file, line: n.line, parentId: n.parentId ?? null,
                fields: n.fields || null, methods: n.methods || null,
            })),
            edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, kind: e.kind })),
        }, null, 2) + '\n';
    }

    /**
     * 自己拿 canvas 画一张静态图。
     * 不能直接用 cy.png()：类型卡片是 cytoscape-node-html-label 渲染的 DOM，
     * 不在 cytoscape 的画布里，导出会得到一堆没有文字的框。
     */
    function buildPng(scale) {
        const { nodes, edges } = visibleGraph();
        if (nodes.length === 0) return null;

        const pos = new Map();
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const n of nodes) {
            const el = cy.getElementById(n.id);
            if (el.empty()) continue;
            const bb = el.boundingBox();
            pos.set(n.id, bb);
            x1 = Math.min(x1, bb.x1); y1 = Math.min(y1, bb.y1);
            x2 = Math.max(x2, bb.x2); y2 = Math.max(y2, bb.y2);
        }
        if (pos.size === 0) return null;

        const pad = 40;
        const w = x2 - x1 + pad * 2;
        const h = y2 - y1 + pad * 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(w * scale);
        canvas.height = Math.ceil(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.translate(pad - x1, pad - y1);

        ctx.fillStyle = theme().pngBg;
        ctx.fillRect(x1 - pad, y1 - pad, w, h);

        // —— 先画边 ——
        for (const e of edges) {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) continue;
            const color = EDGE_COLOR[e.kind] || EDGE_COLOR.calls;
            const lineWidth = (e.kind === 'inherits' || e.kind === 'nsInherits') ? 2.2
                : (e.kind === 'typeCalls' || e.kind === 'nsCalls') ? 1.8 : 1.2;

            ctx.save();
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = lineWidth;
            if (e.kind === 'typeContains') ctx.setLineDash([5, 4]);

            const sx = a.x1 + a.w / 2, sy = a.y1 + a.h / 2;
            const tx = b.x1 + b.w / 2, ty = b.y1 + b.h / 2;
            const [px, py] = trimToBox(sx, sy, tx, ty, a);
            const [qx, qy] = trimToBox(tx, ty, sx, sy, b);

            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(qx, qy);
            ctx.stroke();

            if (e.kind !== 'typeContains') drawArrow(ctx, px, py, qx, qy, 5 + lineWidth);
            ctx.restore();
        }

        // —— 再画节点 ——
        for (const n of nodes) {
            const bb = pos.get(n.id);
            if (!bb) continue;
            if (n.kind === 'method') {
                drawChip(ctx, n, bb);
                continue;
            }
            drawCard(ctx, n, bb);
        }

        return canvas.toDataURL('image/png');
    }

    /** 方法芯片：圆角胶囊 + 主色描边 + 淡色底（和画布上的样式一致）。 */
    function drawChip(ctx, n, box) {
        const parent = state.nodeById.get(n.parentId);
        const color = TYPE_COLORS[(parent || {}).kind] || TYPE_COLORS.type;
        const c = chipColors(color);
        ctx.save();
        ctx.beginPath();
        roundRect(ctx, box.x1, box.y1, box.w, box.h, box.h / 2);
        ctx.fillStyle = c.chipBg;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.stroke();

        ctx.fillStyle = c.ink;
        ctx.font = `${BOX.chipFontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(clipText(ctx, n.label, box.w - 14), box.x1 + box.w / 2, box.y1 + box.h / 2);
        ctx.restore();
    }

    /** 把中心连线裁剪到矩形边上，避免线头插进卡片里。 */
    function trimToBox(sx, sy, tx, ty, box) {
        const dx = tx - sx, dy = ty - sy;
        if (dx === 0 && dy === 0) return [sx, sy];
        const hw = box.w / 2 + 2, hh = box.h / 2 + 2;
        const scaleX = dx === 0 ? Infinity : hw / Math.abs(dx);
        const scaleY = dy === 0 ? Infinity : hh / Math.abs(dy);
        const t = Math.min(scaleX, scaleY);
        return [sx + dx * t, sy + dy * t];
    }

    function drawArrow(ctx, fromX, fromY, toX, toY, size) {
        const angle = Math.atan2(toY - fromY, toX - fromX);
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - size * Math.cos(angle - 0.4), toY - size * Math.sin(angle - 0.4));
        ctx.lineTo(toX - size * Math.cos(angle + 0.4), toY - size * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fill();
    }

    function drawCard(ctx, n, box) {
        const t = theme();
        const color = TYPE_COLORS[n.kind] || TYPE_COLORS.type;
        const isNs = n.kind === 'namespace';
        const soft = mix(color, t.surface, t.dark ? 0.80 : 0.88);
        const border = mix(color, t.surface, t.dark ? 0.55 : 0.68);
        const deep = mix(color, '#000000', t.dark ? 0.30 : 0.20);
        const accentInk = mix(color, t.dark ? '#ffffff' : '#0b1020', 0.30);
        const radius = 11;
        const x = box.x1, y = box.y1, w = box.w, h = box.h;
        const headerH = headerHeight(n.kind);

        // —— 卡片底 ——
        ctx.save();
        ctx.beginPath();
        roundRect(ctx, x, y, w, h, radius);
        ctx.fillStyle = isNs ? deep : (n.tray ? mix(color, t.surface, 0.97) : t.surface);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = border;
        if (n.tray) ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // —— 标题条 ——
        ctx.save();
        ctx.beginPath();
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        if (isNs) {
            const g = ctx.createLinearGradient(x, y, x + w, y + headerH);
            g.addColorStop(0, color);
            g.addColorStop(1, deep);
            ctx.fillStyle = g;
        } else {
            ctx.fillStyle = soft;
        }
        ctx.fillRect(x, y, w, headerH);
        ctx.beginPath();
        ctx.moveTo(x, y + headerH - 0.5);
        ctx.lineTo(x + w, y + headerH - 0.5);
        ctx.strokeStyle = isNs ? 'rgba(255,255,255,.28)' : border;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        // 类型徽标
        const gx = x + 9, gy = y + (headerH - 16) / 2;
        ctx.beginPath();
        roundRect(ctx, gx, gy, 16, 16, 5);
        ctx.fillStyle = isNs ? 'rgba(255,255,255,.22)' : color;
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(KIND_GLYPH[n.kind] || 'T', gx + 8, gy + 8.5);

        // 标题
        ctx.fillStyle = isNs ? '#ffffff' : accentInk;
        ctx.font = `650 ${isNs ? 12.5 : 12}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(clipText(ctx, n.label, w - 44), x + 32, y + headerH / 2 + 0.5);

        // 托盘内部留给子节点，正文不画（子节点会各自画在自己的位置上）
        if (n.tray) { ctx.restore(); return; }

        // —— 正文 ——
        ctx.font = '11px "Cascadia Mono", "Consolas", monospace';
        let cursor = y + headerH + 9;
        const lines = isNs
            ? [`${(state.childrenOf.get(n.id) || []).length} 个类型`, ...(n.preview || [])]
            : [...(n.fields || []), ...(n.methods || [])];
        for (let i = 0; i < lines.length; i++) {
            if (cursor > y + h - 4) break;
            const line = lines[i];
            ctx.fillStyle = line.startsWith('…') ? t.muted
                : (isNs ? t.ink2 : (i < (n.fields || []).length ? t.ink2 : t.ink));
            ctx.fillText(clipText(ctx, line, w - 20), x + 10, cursor + 5);
            cursor += 18;
        }
        if (lines.length === 0) {
            ctx.fillStyle = t.muted;
            ctx.fillText('（无成员）', x + 10, cursor + 5);
        }
        ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function clipText(ctx, text, maxWidth) {
        let s = String(text);
        if (ctx.measureText(s).width <= maxWidth) return s;
        while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
        return s + '…';
    }

    function exportAs(format) {
        const base = state.stats ? state.stats.projectId : 'codemap';
        try {
            if (format === 'png') {
                const dataUrl = buildPng(2);
                if (!dataUrl) { setHint('当前视图没有可导出的内容', true); return; }
                post({
                    type: 'export', format: 'png', base64: true,
                    name: `${base}-${state.mode}.png`,
                    content: dataUrl.replace(/^data:image\/png;base64,/, ''),
                });
                return;
            }
            if (format === 'mermaid') {
                post({
                    type: 'export', format: 'mermaid', base64: false,
                    name: `${base}-${state.mode}.mmd`,
                    content: buildMermaid(),
                });
                return;
            }
            post({
                type: 'export', format: 'json', base64: false,
                name: `${base}-${state.mode}.json`,
                content: buildJson(),
            });
        } catch (err) {
            setHint(`导出失败：${err.message}`, true);
        }
    }

    function onExported(msg) {
        if (msg.ok) setHint(`已导出到 ${msg.path}`);
        else setHint(`导出失败：${msg.message}`, true);
    }

    // ================================================================
    //  语义精确化（L2）—— 请求与合并
    // ================================================================

    function post(msg) {
        if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
    }

    function requestResolve(n) {
        if (state.requested.has(n.id)) return;
        state.requested.add(n.id);
        post({ type: 'resolve', typeId: n.id, fqn: n.fqn });
    }

    function onResolved(msg) {
        const calls = msg.edges || [];
        const typeCalls = msg.typeCalls || [];
        const merged = calls.concat(typeCalls);

        if (msg.precise) {
            state.preciseByType.set(msg.typeId, merged);
        } else if (state.preciseByType.has(msg.typeId)) {
            state.preciseByType.delete(msg.typeId);
        }

        state.resolutions.set(msg.typeId, {
            fqn: msg.fqn || null,
            precise: !!msg.precise,
            reason: msg.reason || null,
            calls: calls.length,
            typeCalls: typeCalls.length,
            methodCount: msg.methodCount || 0,
            unresolved: msg.unresolved || 0,
            elapsedMs: msg.elapsedMs || 0,
        });

        render({ animate: true });

        const name = (msg.fqn || '').split('.').pop();
        if (msg.precise) {
            setHint(`语义精确化 ${name}：${calls.length} 条方法调用 / ${typeCalls.length} 条类型调用 · ` +
                `${msg.elapsedMs} ms`);
        } else if (msg.reason) {
            setHint(`语义解析降级（保留 L1 近似）：${msg.reason}`, true);
        }
    }

    function onNavigated(msg) {
        if (msg.success) setHint(`已用 ${msg.target} 打开 ${msg.message}`);
        else setHint(`跳转失败：${msg.message}`, true);
    }

    // ================================================================
    //  快照装载
    // ================================================================

    function whenContainerReady(cb) {
        const el = document.getElementById('cy');
        let tries = 0;
        const check = () => {
            if (el.clientWidth > 0 && el.clientHeight > 0) { cy.resize(); cb(); }
            else if (tries++ < 600) requestAnimationFrame(check);
            else setHint('容器尺寸始终为 0', true);
        };
        check();
    }

    function onSnapshot(snap) {
        const isNewProject = snap.projectId !== state.projectId;

        if (isNewProject) {
            state.projectId = snap.projectId;
            state.version = -1;
            state.expanded.clear();
            state.preciseByType.clear();
            state.requested.clear();
            state.resolutions.clear();
            state.typeSig = new Map();
            state.offsets.clear();
            state.drag.el = null;
            state.drag.riders = [];
            cy.elements().remove();
        }
        if (snap.version <= state.version) return;
        state.version = snap.version;
        state.root = snap.root || '';

        const prevSig = state.typeSig;
        state.nodes = snap.nodes || [];
        // 后端推来的 edges 是只读数组，复制一份，后面不会再改它
        state.edges = (snap.edges || []).slice();
        state.stats = {
            projectId: snap.projectId,
            version: snap.version,
            fileCount: snap.fileCount || 0,
            elapsedMs: snap.elapsedMs || 0,
            nodes: state.nodes.length,
            fromCache: !!snap.fromCache,
            cachedFiles: snap.cachedFiles || 0,
            analyzer: snap.analyzer || '',
        };

        indexSnapshot();
        refreshEdgeList();

        // —— L2 结果的失效判断 ——
        // 只有「自身方法/字段签名」变了才需要重新精确解析；未变的类型沿用旧结果，
        // 避免每次保存都在后台重建一次编译。
        const nextSig = new Map();
        for (const n of state.nodes) {
            if (isTypeNode(n)) nextSig.set(n.id, methodSignature(n));
        }
        state.typeSig = nextSig;

        const stale = [];
        for (const id of state.expanded) {
            const n = state.nodeById.get(id);
            if (!n || !isTypeNode(n)) continue;
            const before = prevSig.get(id);
            if (before !== undefined && before === nextSig.get(id) && state.resolutions.has(id)) continue;
            state.preciseByType.delete(id);
            state.resolutions.delete(id);
            state.requested.delete(id);
            stale.push(n);
        }

        whenContainerReady(() => {
            render({ animate: !isNewProject });
            if (isNewProject || cy.nodes().length === 0) fitView();
            refreshHint();
            for (const n of stale) requestResolve(n);
        });
        // 没有任何节点 = 还没打开项目，给一张能直接开始的空状态
        toggleWelcome(state.nodes.length === 0);
    }

    function methodSignature(n) {
        return (n.methods || []).join('\u0001') + '\u0002' + (n.fields || []).join('\u0001');
    }

    // ================================================================
    //  交互
    // ================================================================

    /*
     * 选中与悬停都写进节点的 data，而不是往 DOM 上挂类：
     * 卡片那一层 DOM 是 cytoscape-node-html-label 按 data 重建的，
     * 从外面加的类活不过下一次渲染；放进 data 才能让卡片模板和方法芯片都读到。
     */
    function setNodeFlag(id, key, value) {
        const el = id ? cy.getElementById(id) : null;
        if (!el || el.empty()) return;
        if (el.data(key) === value) return;
        el.data(key, value);
    }

    function setSelected(id) {
        id = id || null;
        if (state.selected === id) { updateCrumbs(); return; }
        setNodeFlag(state.selected, 'sel', 0);
        state.selected = id;
        setNodeFlag(id, 'sel', 1);
        updateCrumbs();
    }

    /** 顶部那条面包屑：当前选中节点在包含树里的位置，点中间一段可以跳回去。 */
    function updateCrumbs() {
        if (!crumbsEl) return;
        const n = state.selected ? state.nodeById.get(state.selected) : null;
        if (!n) {
            crumbsEl.classList.remove('open');
            crumbsEl.innerHTML = '';
            return;
        }

        const chain = [n];
        for (const pid of ancestorsOf(n.id)) {
            const p = state.nodeById.get(pid);
            if (p) chain.unshift(p);
        }

        crumbsEl.innerHTML = chain.map((c, i) => {
            const color = TYPE_COLORS[c.kind] || TYPE_COLORS.type;
            const last = i === chain.length - 1;
            return (i ? '<span class="sep">›</span>' : '') +
                `<span class="crumb${last ? ' last' : ''}" data-crumb="${escapeHtml(c.id)}" ` +
                `title="${escapeHtml(c.fqn || c.label)}">` +
                (last ? `<span class="dot" style="background:${color}"></span>` : '') +
                escapeHtml(c.label) + '</span>';
        }).join('');
        crumbsEl.classList.add('open');
    }

    if (crumbsEl) {
        crumbsEl.addEventListener('click', ev => {
            const hit = ev.target.closest ? ev.target.closest('[data-crumb]') : null;
            if (!hit) return;
            const id = hit.getAttribute('data-crumb');
            // 点到链路中间的一段：把它上面的容器都展开，再飞过去
            for (const pid of ancestorsOf(id)) state.expanded.add(pid);
            render({ animate: true });
            centerOn(id);
        });
    }

    // —— 悬停：把跟它有关系的边点亮，其余的压暗 ——
    const EDGE_WIDTH = {
        inherits: 2.2, nsInherits: 2.6, typeCalls: 1.8,
        nsCalls: 2.2, typeContains: 1.2, calls: 1.0,
    };

    let hoverId = null;
    let spot = null;

    function setHovered(id) {
        id = id || null;
        if (hoverId === id) return;
        setNodeFlag(hoverId, 'hovered', 0);
        hoverId = id;
        setNodeFlag(id, 'hovered', 1);
    }

    function clearSpotlight() {
        if (!spot) return;
        spot.dimmed.forEach(el => el.style('opacity', EDGE_OPACITY[el.data('kind')] || 0.6));
        spot.lit.removeStyle('width');
        spot = null;
    }

    /** 孤立节点没有邻边，压暗整张图只会让人以为界面坏了 —— 那就什么都不做。 */
    function spotlight(node) {
        clearSpotlight();
        // 正在淡出的边不参与：它们的透明度是「动画的中间值」，
        // 碰了它们等于把一条本该消失的线重新点亮。
        const live = cy.edges().filter(e => !e.data('dying'));
        const lit = node.closedNeighborhood().edges().filter(e => !e.data('dying'));
        if (lit.length === 0) return;
        const dimmed = live.difference(lit);
        if (dimmed.length === 0) return;
        dimmed.style('opacity', 0.07);
        lit.forEach(el => el.style('width', (EDGE_WIDTH[el.data('kind')] || 1.6) * 1.7));
        spot = { dimmed: dimmed, lit: lit };
    }

    cy.on('mouseover', 'node', evt => {
        setHovered(evt.target.id());
        spotlight(evt.target);
    });
    cy.on('mouseout', 'node', evt => {
        if (hoverId === evt.target.id()) setHovered(null);
        clearSpotlight();
    });

    cy.on('tap', 'node[isNs], node[isType]', evt => {
        setSelected(evt.target.id());
        toggle(evt.target.id());
    });
    cy.on('tap', 'node[isMethod]', evt => {
        setSelected(evt.target.id());
        const d = evt.target.data();
        if (!d.file) return;
        setHint(`跳转 ${d.file}:${d.line} ...`);
        post({ type: 'goto', file: d.file, line: d.line || 1 });
    });
    cy.on('tap', evt => {
        if (evt.target === cy) { hideResults(); setSelected(null); }
    });
    cy.on('dbltap', evt => {
        if (evt.target === cy) { clearFilter(); collapseAll(); setSelected(null); }
    });
    // 双击容器 = 把它下面的容器一起展开，省掉一层层点
    cy.on('dbltap', 'node[isNs], node[isType]', evt => expandSubtree(evt.target.id()));
    // 右键直接按工具栏当前的方向与深度追踪
    cy.on('cxttap', 'node', evt => {
        setSelected(evt.target.id());
        traceFrom(evt.target.id(),
            traceDirEl ? traceDirEl.value : 'out',
            Number(traceDepthEl ? traceDepthEl.value : 3));
    });

    // ================================================================
    //  拖动
    // ================================================================

    /*
     * 托盘里的子节点是「算出来再摆进去」的独立节点，cytoscape 并不知道它们属于谁
     * （我们没走复合节点那套），所以拖动托盘时里面的东西不会跟着走，会当场散架。
     * 这里自己把这层包含关系补上：
     *
     *   拖动中：把这一帧的位移同步给所有可见后代
     *   松手后：把「拖离布局位置多远」记进 state.offsets，重排时由 placeBox 生效。
     *          记在父节点上就够了 —— 子节点坐标从父节点中心推出来，位移自动继承。
     */
    function visibleDescendants(el) {
        const out = [];
        const stack = [el.id()];
        while (stack.length) {
            const pid = stack.pop();
            for (const cid of (state.childrenOf.get(pid) || [])) {
                const c = cy.getElementById(cid);
                if (c.empty()) continue;      // 折叠着的后代不在画布上
                out.push(c);
                stack.push(cid);
            }
        }
        return out;
    }

    /**
     * 这个节点一共被拖离「纯布局位置」多远。
     * 基准用的是 lastPureLayout（不含位移的那份坐标）：如果拿叠加过位移的坐标当基准，
     * 第二次拖动只会记下第二次的增量，上一次拖出来的位置会被悄悄吞掉。
     */
    function rememberDragOffset(el) {
        const base = state.lastPureLayout && state.lastPureLayout.get(el.id());
        if (!base) return;
        const cur = el.position();
        const dx = cur.x - base.x, dy = cur.y - base.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) state.offsets.delete(el.id());
        else state.offsets.set(el.id(), { dx: dx, dy: dy });
    }

    /** 这个节点拖动时允许落在的范围（相对当前可见的父容器）；根节点不受限。 */
    function dragBounds(el) {
        const n = state.nodeById.get(el.id());
        if (!n) return null;
        const parent = layoutParentOf(n);
        if (!parent) return null;
        const pel = cy.getElementById(parent.id);
        if (pel.empty()) return null;
        const pw = pel.data('w'), ph = pel.data('h');
        if (!pw || !ph) return null;
        const c = pel.position();
        return {
            left: c.x - pw / 2 + BOX.pad,
            right: c.x + pw / 2 - BOX.pad,
            top: c.y - ph / 2 + headerHeight(parent.kind) + BOX.pad * 0.5,
            bottom: c.y + ph / 2 - BOX.pad,
        };
    }

    /** 把位置夹回父容器内部。子节点被拖到边界时就贴着边界走，不会整个甩出去。 */
    function clampToParent(el, pos) {
        const b = dragBounds(el);
        if (!b) return pos;
        const hw = el.width() / 2, hh = el.height() / 2;
        return {
            x: clampAxis(pos.x, b.left + hw, b.right - hw),
            y: clampAxis(pos.y, b.top + hh, b.bottom - hh),
        };
    }

    /** 清掉手动拖出来的位移，回到自动布局的位置。 */
    function resetDragOffsets() {
        if (state.offsets.size === 0) return false;
        state.offsets.clear();
        render({ animate: true });
        return true;
    }

    cy.on('grab', 'node', evt => {
        state.drag.el = evt.target;
        state.drag.last = copyPos(evt.target.position());
        state.drag.riders = visibleDescendants(evt.target);
        state.drag.moved = false;
    });

    cy.on('drag', 'node', evt => {
        const el = evt.target;
        if (state.drag.el !== el) return;
        const raw = copyPos(el.position());
        const cur = clampToParent(el, raw);
        if (cur.x !== raw.x || cur.y !== raw.y) el.position(cur);

        const dx = cur.x - state.drag.last.x;
        const dy = cur.y - state.drag.last.y;
        if (dx === 0 && dy === 0) return;
        state.drag.last = cur;
        state.drag.moved = true;

        for (const r of state.drag.riders) {
            if (r.removed() || r.id() === el.id()) continue;
            const p = r.position();
            r.position({ x: p.x + dx, y: p.y + dy });
        }
        rememberDragOffset(el);
    });

    cy.on('free', 'node', evt => {
        if (state.drag.el !== evt.target) return;
        // 只是点一下（没有真的拖动）就别记位移：布局动画还在跑的时候，
        // 节点当下只是动画的中间帧，拿它当基准会把卡片钉在一个谁也没拖过的位置上。
        const moved = state.drag.moved;
        if (moved) rememberDragOffset(evt.target);
        state.drag.el = null;
        state.drag.riders = [];
        state.drag.moved = false;
        // 松手后排一次版：位置不会再变（算出来就是刚放下的地方），
        // 但位移表、布局坐标、卡片尺寸都回到彼此一致的状态 —— 落地校正才有个准头。
        if (moved) render({ animate: true });
    });

    // ================================================================
    //  界面部件：主题 / 图例 / 帮助 / 缩放 / 空状态
    // ================================================================

    /**
     * 切主题。
     * CSS 变量一改，工具条与卡片样式立刻跟着变；canvas 上的东西（芯片、连线）
     * 读的是 cytoscape 样式表和节点 data，所以要重建样式表、重画一遍。
     */
    function setTheme(name, opts) {
        opts = opts || {};
        applyThemeVars(name);
        if (!opts.silent) {
            try { localStorage.setItem(THEME_KEY, themeName); } catch (_) { /* 存不下就只影响下次启动 */ }
        }
        sizeCache.clear();
        headerCache.clear();
        cy.style().fromJson(buildStyle());
        render({ animate: false });
        // 标题栏也跟着走：深色图配一条亮色系统标题栏太割裂
        post({ type: 'theme', dark: theme().dark });
    }

    function legendLine(color, width, dashed, arrow) {
        return `<svg class="line" width="22" height="8" viewBox="0 0 22 8">` +
            `<path d="M1 4h${arrow ? 16 : 20}" stroke="${color}" stroke-width="${width}" ` +
            `stroke-linecap="round"${dashed ? ' stroke-dasharray="3 2.5"' : ''}/>` +
            (arrow
                ? `<path d="M16 1.2L20.4 4 16 6.8z" fill="${color}"/>`
                : '') +
            '</svg>';
    }

    function renderLegend() {
        if (!legendBody) return;
        const nodes = LEGEND_KINDS
            .map(([k, label]) => '<div class="legend-row">' +
                `<span class="swatch" style="background:${TYPE_COLORS[k]}"></span>${label}</div>`)
            .join('');
        const edges = LEGEND_EDGES
            .map(([k, label, w, dashed]) => '<div class="legend-row">' +
                legendLine(EDGE_COLOR[k], w, dashed, k !== 'typeContains') + label + '</div>')
            .join('');
        legendBody.innerHTML =
            `<div class="legend-group"><span class="legend-title">节点</span>${nodes}</div>` +
            `<div class="legend-group"><span class="legend-title">关系</span>${edges}</div>`;
    }

    function renderHelp() {
        if (!helpRows) return;
        helpRows.innerHTML = HELP_ROWS.map(([keys, desc]) =>
            '<div class="help-row"><span class="keys">' +
            keys.map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('') +
            `</span><span>${escapeHtml(desc)}</span></div>`).join('');
    }

    function toggleHelp(force) {
        if (!helpEl) return;
        const open = force === undefined ? !helpEl.classList.contains('open') : !!force;
        helpEl.classList.toggle('open', open);
    }

    function closeMenus() {
        if (exportMenu) exportMenu.classList.remove('open');
    }

    function updateZoomLabel() {
        if (!zoomValueEl) return;
        const pct = Math.round(cy.zoom() * 100);
        zoomValueEl.textContent = `${pct}%`;
        zoomValueEl.title = `当前 ${pct}% · 点击回到 100%`;
    }

    function syncSearchClear() {
        const has = !!(searchEl && searchEl.value.length > 0);
        if (searchClearBtn) searchClearBtn.hidden = !has;
        if (searchWrap) searchWrap.classList.toggle('has-value', has);
    }

    function toggleWelcome(show) {
        if (welcomeEl) welcomeEl.classList.toggle('open', !!show);
    }

    if (modeBtn) {
        modeBtn.addEventListener('click', () => {
            state.mode = state.mode === 'namespace' ? 'type' : 'namespace';
            state.expanded.clear();
            state.filter = null;
            state.preFilterExpanded = null;
            // 换了聚合模式就是另一套布局，拖动留下的位移不再有意义
            state.offsets.clear();
            state.drag.el = null;
            state.drag.riders = [];
            setSelected(null);
            updateFocusBar();
            cy.elements().remove();
            render({ animate: false });
            fitView();
            refreshHint();
        });
    }
    const expandBtn = document.getElementById('expandBtn');
    if (expandBtn) expandBtn.addEventListener('click', expandOneLevel);
    const collapseBtn = document.getElementById('collapseBtn');
    if (collapseBtn) collapseBtn.addEventListener('click', collapseAll);

    const traceBtn = document.getElementById('traceBtn');
    if (traceBtn) {
        traceBtn.addEventListener('click', () => {
            if (!state.selected) { setHint('先点一个节点，再点「调用链」', true); return; }
            traceFrom(state.selected,
                traceDirEl ? traceDirEl.value : 'out',
                Number(traceDepthEl ? traceDepthEl.value : 3));
        });
    }
    if (focusClear) focusClear.addEventListener('click', () => clearFilter());

    // —— 导出：三个格式收进一个菜单，工具栏不再被按钮撑满 ——
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            if (exportMenu) exportMenu.classList.toggle('open');
        });
    }
    for (const [id, format] of [['exportPng', 'png'], ['exportMermaid', 'mermaid'], ['exportJson', 'json']]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => { closeMenus(); exportAs(format); });
    }

    // —— 重新分析 / 主题 / 帮助 / 图例 / 缩放 ——
    const reloadBtn = document.getElementById('reloadBtn');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', () => {
            setBusy(true);
            setHint('重新分析中…');
            post({ type: 'reload' });
        });
    }
    if (themeBtn) themeBtn.addEventListener('click', () => setTheme(theme().dark ? 'light' : 'dark'));
    if (helpBtn) helpBtn.addEventListener('click', () => toggleHelp(true));
    const helpCloseBtn = document.getElementById('helpClose');
    if (helpCloseBtn) helpCloseBtn.addEventListener('click', () => toggleHelp(false));
    if (helpEl) {
        helpEl.addEventListener('mousedown', ev => { if (ev.target === helpEl) toggleHelp(false); });
    }
    if (legendToggle) {
        legendToggle.addEventListener('click', () => legendEl.classList.toggle('collapsed'));
    }
    if (welcomeOpenBtn) welcomeOpenBtn.addEventListener('click', () => post({ type: 'open-project' }));

    const zoomBy = k => cy.animate({ zoom: cy.zoom() * k, duration: 180, easing: 'ease-out' });
    const zoomInBtn = document.getElementById('zoomIn');
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomBy(1.25));
    const zoomOutBtn = document.getElementById('zoomOut');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.25));
    if (zoomValueEl) zoomValueEl.addEventListener('click', () => cy.animate({ zoom: 1, duration: 220 }));
    const zoomFitBtn = document.getElementById('zoomFit');
    if (zoomFitBtn) zoomFitBtn.addEventListener('click', () => { resetDragOffsets(); fitView(420); });
    cy.on('zoom', updateZoomLabel);

    if (searchEl) {
        searchEl.addEventListener('input', () => {
            syncSearchClear();
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => runSearch(searchEl.value), 180);
        });
        searchEl.addEventListener('focus', () => {
            if (searchEl.value.trim().length > 0 && resultsEl && resultsEl.children.length) {
                resultsEl.classList.add('open');
            }
        });
        searchEl.addEventListener('keydown', ev => {
            if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                setActiveResult(resultActive + 1);
            } else if (ev.key === 'ArrowUp') {
                ev.preventDefault();
                setActiveResult(resultActive - 1);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                pickResult(Math.max(0, resultActive));
            } else if (ev.key === 'Escape') {
                clearFilter();
                searchEl.blur();
            }
        });
    }
    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            clearFilter();
            if (searchEl) searchEl.focus();
        });
    }

    document.addEventListener('mousedown', ev => {
        if (searchWrap && searchWrap.contains(ev.target)) { /* 点搜索区不关面板 */ }
        else hideResults();
        if (!exportWrap || !exportWrap.contains(ev.target)) closeMenus();
    });

    window.chrome.webview.addEventListener('message', ev => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'snapshot') { setBusy(false); onSnapshot(msg.snapshot); }
        else if (msg.type === 'resolved') { setBusy(false); onResolved(msg); }
        else if (msg.type === 'navigated') onNavigated(msg);
        else if (msg.type === 'exported') onExported(msg);
        else if (msg.type === 'shell-theme') {
            // 宿主回执：外壳真的把主题落到了根元素上（actualTheme 是 XAML 说了算的）
            state.shell = {
                dark: !!msg.dark,
                actual: msg.actual || '',
                band: msg.band || '',
            };
        }
        else if (msg.type === 'resolving') {
            setBusy(true);
            setHint('语义解析中…（首次解析要建立编译，稍等）');
        }
    });

    window.addEventListener('keydown', e => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            if (e.key === 'Escape' && tag === 'INPUT') clearFilter();
            return;
        }
        if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }
        if (e.key === '/') { e.preventDefault(); if (searchEl) searchEl.focus(); return; }
        // 「0 复位」把视图和手动拖动一起复位：拖过之后如果没有恢复的办法，
        // 用户就只能一个个拖回去
        if (e.key === '0') { resetDragOffsets(); fitView(400); }
        else if (e.key === '=' || e.key === '+') cy.animate({ zoom: cy.zoom() * 1.2, duration: 200 });
        else if (e.key === '-') cy.animate({ zoom: cy.zoom() / 1.2, duration: 200 });
        else if (e.key === 'f' || e.key === 'F') fitView(420);
        else if (e.key === 'Escape') {
            if (helpEl && helpEl.classList.contains('open')) { toggleHelp(false); return; }
            clearFilter();
            collapseAll();
            setSelected(null);
        }
        else if (e.key === 't' || e.key === 'T') {
            if (state.selected) {
                traceFrom(state.selected,
                    traceDirEl ? traceDirEl.value : 'out',
                    Number(traceDepthEl ? traceDepthEl.value : 3));
            }
        } else if (e.key === 'F12') post({ type: 'devtools' });
    });

    // 用户没显式选过主题时，跟随系统的深浅色切换
    if (window.matchMedia) {
        const scheme = window.matchMedia('(prefers-color-scheme: dark)');
        const onScheme = evt => {
            let saved = null;
            try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* 忽略 */ }
            if (saved === 'light' || saved === 'dark') return;
            setTheme(evt.matches ? 'dark' : 'light', { silent: true });
        };
        if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
        else if (scheme.addListener) scheme.addListener(onScheme);
    }

    // 窗口尺寸变了就按新比例重铺一次：顶层是照工作区长宽比铺的，
    // 不重排的话内容会停在旧比例上 —— 窗口拉宽了，两侧反而空出一大片。
    // 只重排、不动相机：用户自己挪过的视角不该被窗口一拉伸就夺走。
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            cy.resize();
            if (cy.nodes().length > 0) render({ animate: false });
        }, 220);
    });

    renderHelp();
    renderLegend();
    syncSearchClear();
    updateZoomLabel();
    updateCrumbs();
    // 主题是页面说了算，但标题栏那条底和窗口按钮是宿主画的。
    // 启动时就得报一次，否则「系统浅色 + 上次选了深色」这种组合下，
    // 外壳会一直停在系统主题上，跟页面两种颜色。
    post({ type: 'theme', dark: theme().dark });
    post({ type: 'ready' });
    setHint('已就绪，打开项目后显示骨架图');
    toggleWelcome(true);
    updateStats();

    // 诊断句柄：方案 §8 的原则是「WebView2 里排查问题的成本远高于普通浏览器」，
    // 所以把内部状态挂出来，便于远程调试端口或控制台直接查。
    window.__codemap = {
        cy,
        state,
        isVisible,
        edgeInScope,
        projectEdges,
        render,
        // 交互与导出的入口也挂出来，自检脚本可以绕过「另存为」对话框直接验证产物
        runSearch,
        clearFilter,
        traceFrom,
        visibleGraph,
        buildMermaid,
        buildJson,
        buildPng,
        measureSize,
        computeLayout,
        layoutParentOf,
        visibleChildrenOf,
        visibleDescendants,
        resetDragOffsets,
        headerHeight,
        // 界面入口：自检脚本可以切主题、开帮助面板，不用去点按钮
        setTheme,
        toggleHelp,
        setSelected,
        setHovered,
        spotlight,
        clearSpotlight,
        THEMES,
        snapshotSummary() {
            const byKind = {};
            for (const n of state.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
            return {
                projectId: state.projectId,
                version: state.version,
                mode: state.mode,
                theme: themeName,
                shell: state.shell || null,
                hovered: hoverId,
                busy: !!(progressEl && progressEl.classList.contains('on')),
                errors: window.__errors || [],
                source: { nodes: state.nodes.length, edges: state.edges.length, byKind },
                drawn: { nodes: cy.nodes().length, edges: cy.edges().length },
                wanted: state.drawn || null,
                expanded: [...state.expanded],
                resolutions: [...state.resolutions.entries()].map(([id, r]) => ({
                    id, fqn: r.fqn, precise: r.precise, reason: r.reason,
                    calls: r.calls, typeCalls: r.typeCalls,
                    methodCount: r.methodCount, unresolved: r.unresolved, elapsedMs: r.elapsedMs,
                })),
                edgeKinds: state.edgeList.reduce((acc, e) => {
                    acc[e.kind] = (acc[e.kind] || 0) + 1;
                    return acc;
                }, {}),
                drawnEdgeKinds: [...state.renderEdges.values()].reduce((acc, e) => {
                    acc[e.kind] = (acc[e.kind] || 0) + 1;
                    return acc;
                }, {}),
                dragged: [...state.offsets.entries()].map(([id, o]) => ({
                    id, label: (state.nodeById.get(id) || {}).label,
                    dx: Math.round(o.dx), dy: Math.round(o.dy),
                })),
                hint: hint.textContent,
                stats: statsEl.textContent,
                analyzer: state.stats ? state.stats.analyzer : '',
                filter: state.filter ? {
                    kind: state.filter.kind,
                    label: state.filter.label,
                    nodes: state.filter.nodes.size,
                    edges: state.filter.edges ? state.filter.edges.size : null,
                } : null,
                selected: state.selected,
            };
        },
    };
})();
