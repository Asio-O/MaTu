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
    const searchEl = document.getElementById('search');
    const resultsEl = document.getElementById('results');
    const focusBar = document.getElementById('focusBar');
    const focusLabel = document.getElementById('focusLabel');
    const focusClear = document.getElementById('focusClear');
    const traceDirEl = document.getElementById('traceDir');
    const traceDepthEl = document.getElementById('traceDepth');

    function setHint(text, isErr) {
        hint.className = isErr ? 'err' : '';
        hint.textContent = text;
    }

    if (typeof cytoscape === 'undefined') {
        setHint('cytoscape.min.js 未加载', true);
        return;
    }

    const TYPE_COLORS = {
        namespace: '#5b6b7f',
        class: '#4c8dff',
        interface: '#2a9d8f',
        struct: '#f4a261',
        record: '#e76f51',
        type: '#888888',
    };

    const CARD_WIDTH = 220;

    const ANIM = {
        growDuration: 420,
        shrinkDuration: 300,
        fadeDuration: 240,
        easing: 'ease-out',
    };

    // 展开一个容器时，子节点环形半径与环间距（按关系类型区分）
    const RING = {
        'ns->type': { radius: 320, spacing: 210, capacity: 130 },
        'type->type': { radius: 400, spacing: 230, capacity: 130 },
        'type->method': { radius: 170, spacing: 74, capacity: 60 },
        'default': { radius: 260, spacing: 180, capacity: 100 },
    };

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

    function typeCardTpl(data) {
        const color = data.color || '#4c8dff';
        const fields = data.fields || [];
        const methods = data.methods || [];

        let sections = '';
        if (fields.length > 0) {
            sections += '<div class="mermaid-section">';
            for (const f of fields) sections += `<div class="mermaid-line">${escapeHtml(f)}</div>`;
            sections += '</div>';
        }
        if (methods.length > 0) {
            sections += '<div class="mermaid-section">';
            for (const m of methods) sections += `<div class="mermaid-line">${escapeHtml(m)}</div>`;
            sections += '</div>';
        }
        if (!sections) {
            sections = '<div class="mermaid-section"><div class="mermaid-line mermaid-empty">(空)</div></div>';
        }

        return `<div class="mermaid-card" style="border-color:${color};">
      <div class="mermaid-header" style="background:${color};">${escapeHtml(data.label)}</div>
      ${sections}
    </div>`;
    }

    function nsCardTpl(data) {
        const color = data.color || '#5b6b7f';
        const preview = data.preview || [];
        let body = '';
        if (preview.length) {
            body = '<div class="mermaid-section">';
            for (const line of preview) body += `<div class="mermaid-line dim">${escapeHtml(line)}</div>`;
            body += '</div>';
        }
        const tail = data.expanded
            ? '<div class="mermaid-hint">展开中 · 点击折叠</div>'
            : '<div class="mermaid-hint">点击展开类型</div>';

        return `<div class="mermaid-card ns" style="border-color:${color};">
      <div class="mermaid-header" style="background:${color};">${escapeHtml(data.label)}</div>
      <div class="mermaid-section"><div class="mermaid-line">${data.childCount} 个类型</div></div>
      ${body}
      ${tail}
    </div>`;
    }

    function estimateSize(n) {
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
                color: TYPE_COLORS.namespace,
                childCount: n.childCount || 0,
                preview: n.preview || [],
                expanded: isContainerExpanded(n.id) ? 1 : 0,
            };
        }
        return {
            label: n.label,
            color: TYPE_COLORS[n.kind] || '#888',
            fields: n.fields || [],
            methods: n.methods || [],
        };
    }

    function measureSize(n) {
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

    const cy = cytoscape({
        container: document.getElementById('cy'),
        wheelSensitivity: 0.3,
        style: [
            {
                selector: 'node[isType], node[isNs]',
                style: {
                    width: 'data(w)',
                    height: 'data(h)',
                    // 卡片由 DOM 层绘制，节点本身必须完全不画。
                    // 注意不能只写 background-color: transparent —— 这个 cytoscape 版本
                    // 填充背景时忽略颜色自带的 alpha，只看 background-opacity，
                    // 结果就是一整块纯黑矩形从卡片底下露出来。
                    'background-opacity': 0,
                    'background-color': '#ffffff',
                    'border-width': 0,
                    'border-style': 'solid',
                    label: '',
                    shape: 'rectangle',
                }
            },
            {
                // cytoscape 没有 :hover 伪类，未知伪类会被当成恒真条件匹配所有节点。
                // 悬停效果只能靠 JS 事件加类实现。
                selector: 'node[isType].hovered, node[isNs].hovered',
                style: {
                    'border-width': 2,
                    'border-color': '#1a1a1a',
                    'border-style': 'dashed',
                    'border-opacity': 0.5,
                }
            },
            {
                selector: 'node[isMethod]',
                style: {
                    label: 'data(label)',
                    'font-size': 9, color: '#333',
                    'text-valign': 'bottom', 'text-margin-y': 4,
                    'text-opacity': 0,
                    'text-background-color': '#ffffff',
                    'text-background-opacity': 0.9,
                    'text-background-padding': 2,
                    shape: 'ellipse',
                    width: 14, height: 14,
                    'background-color': 'data(color)',
                    'background-opacity': 0.75,
                    'border-width': 1.5, 'border-color': '#ffffff',
                    'transition-property': 'background-opacity, border-width, border-color',
                    'transition-duration': '150ms',
                }
            },
            { selector: 'node[isMethod].expanded', style: { 'text-opacity': 1 } },
            {
                selector: 'node[isMethod].hovered',
                style: {
                    'text-opacity': 1,
                    width: 18, height: 18,
                    'background-opacity': 1,
                    'z-index': 999,
                    'border-width': 2, 'border-color': '#1a1a1a',
                }
            },
            {
                selector: 'edge[kind="inherits"]',
                style: {
                    'curve-style': 'bezier', width: 2.2,
                    'line-color': '#e76f51',
                    'target-arrow-color': '#e76f51',
                    'target-arrow-shape': 'triangle', 'arrow-scale': 1.1,
                }
            },
            {
                selector: 'edge[kind="nsInherits"]',
                style: {
                    'curve-style': 'bezier', width: 2.6,
                    'line-color': '#e76f51',
                    'line-style': 'solid',
                    'target-arrow-color': '#e76f51',
                    'target-arrow-shape': 'triangle', 'arrow-scale': 1.2,
                }
            },
            {
                selector: 'edge[kind="typeCalls"]',
                style: {
                    'curve-style': 'bezier', width: 1.8,
                    'line-color': '#4c8dff',
                    'target-arrow-color': '#4c8dff',
                    'target-arrow-shape': 'vee', 'arrow-scale': 1.0,
                }
            },
            {
                selector: 'edge[kind="nsCalls"]',
                style: {
                    'curve-style': 'bezier', width: 2.2,
                    'line-color': '#4c8dff',
                    'target-arrow-color': '#4c8dff',
                    'target-arrow-shape': 'vee', 'arrow-scale': 1.1,
                }
            },
            {
                selector: 'edge[kind="typeContains"]',
                style: {
                    'curve-style': 'bezier', width: 1.2,
                    'line-color': '#c2c9d2',
                    'line-style': 'dashed',
                    'target-arrow-shape': 'none',
                }
            },
            {
                selector: 'edge[kind="calls"]',
                style: {
                    'curve-style': 'bezier', width: 1.0,
                    'line-color': '#8c9298',
                    'target-arrow-color': '#8c9298',
                    'target-arrow-shape': 'vee', 'arrow-scale': 0.7,
                }
            },
        ]
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
        stats: null,
        drawn: null,
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

    function edgeVisible(e) {
        if (e.kind === 'nsContains') return false;
        const s = state.nodeById.get(e.source);
        const t = state.nodeById.get(e.target);
        if (!s || !t) return false;
        if (!isVisible(s) || !isVisible(t)) return false;
        if (state.filter && state.filter.edges && !state.filter.edges.has(e.id)) return false;
        if (state.mode === 'namespace' && (e.kind === 'nsInherits' || e.kind === 'nsCalls')) {
            // 两端命名空间都展开后，类型级边已经表达同样的信息，聚合边退场
            return !(isContainerExpanded(e.source) && isContainerExpanded(e.target));
        }
        return true;
    }

    // ================================================================
    //  布局与位置
    // ================================================================

    function ringPositions(center, count, spec) {
        const out = [];
        let placed = 0, ring = 0;
        while (placed < count && ring < 60) {
            const radius = spec.radius + ring * spec.spacing;
            const capacity = Math.max(4, Math.min(
                Math.floor((2 * Math.PI * radius) / spec.capacity),
                spec.capacity));
            const take = Math.min(capacity, count - placed);
            for (let i = 0; i < take; i++) {
                const a = (i / take) * Math.PI * 2 - Math.PI / 2 + ring * 0.45;
                out.push({
                    x: center.x + Math.cos(a) * radius,
                    y: center.y + Math.sin(a) * radius,
                });
            }
            placed += take;
            ring++;
        }
        while (out.length < count) out.push({ x: center.x, y: center.y });
        return out;
    }

    function ringSpecFor(child, parent) {
        if (!parent) return RING['default'];
        if (parent.kind === 'namespace') return RING['ns->type'];
        if (child.kind === 'method') return RING['type->method'];
        return RING['type->type'];
    }

    function viewportCenter() {
        const ext = cy.extent();
        if (!isFinite(ext.x1) || ext.x2 - ext.x1 <= 0) return { x: 0, y: 0 };
        return { x: (ext.x1 + ext.x2) / 2, y: (ext.y1 + ext.y2) / 2 };
    }

    function layoutAll(fit) {
        cy.resize();
        if (cy.nodes().length === 0) return;
        const sparse = cy.edges().length < cy.nodes().length * 0.5;
        if (sparse) {
            cy.layout({
                name: 'grid',
                avoidOverlap: true,
                avoidOverlapPadding: 40,
                condense: false,
                padding: 60,
                fit: false,
            }).run();
        } else {
            cy.layout({
                name: 'cose',
                animate: false,
                randomize: true,
                padding: 80,
                nodeRepulsion: 800000,
                idealEdgeLength: 280,
                nodeOverlap: 140,
                componentSpacing: 280,
                nodeDimensionsIncludeLabels: false,
                fit: false,
            }).run();
        }
        if (fit) cy.animate({ fit: { padding: 60 } }, { duration: 500, easing: 'ease-out' });
    }

    // ================================================================
    //  渲染（diff）
    // ================================================================

    function nodeData(n, position) {
        const size = measureSize(n);
        if (n.kind === 'namespace') {
            return {
                data: {
                    id: n.id, label: n.label, kind: 'namespace', fqn: n.fqn,
                    color: TYPE_COLORS.namespace, isNs: 1,
                    childCount: n.childCount || 0,
                    preview: n.preview || [],
                    expanded: isContainerExpanded(n.id) ? 1 : 0,
                    w: size.w, h: size.h,
                },
                position: position,
            };
        }
        if (n.kind === 'method') {
            const parent = state.nodeById.get(n.parentId);
            return {
                data: {
                    id: n.id, label: n.label, kind: 'method', fqn: n.fqn,
                    color: parent ? (TYPE_COLORS[parent.kind] || '#888') : '#888',
                    isMethod: 1, parentId: n.parentId,
                    file: n.file, line: n.line,
                },
                position: position,
            };
        }
        return {
            data: {
                id: n.id, label: n.label, kind: n.kind, fqn: n.fqn,
                color: TYPE_COLORS[n.kind] || '#888', isType: 1,
                fields: n.fields || [], methods: n.methods || [],
                file: n.file, line: n.line,
                w: size.w, h: size.h,
            },
            position: position,
        };
    }

    function refreshNodeData(el, n) {
        const fresh = nodeData(n).data;
        // 只刷新会变的部分，避免 position 之类的字段被误改
        el.data('label', fresh.label);
        el.data('fields', fresh.fields);
        el.data('methods', fresh.methods);
        el.data('childCount', fresh.childCount);
        el.data('preview', fresh.preview);
        el.data('expanded', fresh.expanded);
        el.data('file', fresh.file);
        el.data('line', fresh.line);
        if (fresh.w) el.data('w', fresh.w);
        if (fresh.h) el.data('h', fresh.h);
    }

    function kill(el) {
        if (el.empty()) return;
        el.data('dying', 1);
        el.animate({ style: { opacity: 0 } },
            { duration: ANIM.fadeDuration, easing: 'ease-in', complete: () => el.remove() });
    }

    function revive(el) {
        el.stop(true);
        el.data('dying', 0);
        el.animate({ style: { opacity: 1 } }, { duration: 150, easing: 'ease-out' });
    }

    function render(opts) {
        opts = opts || {};
        const animate = opts.animate !== false;

        const want = new Set();
        for (const n of state.nodes) if (isVisible(n)) want.add(n.id);

        // —— 节点：淘汰 ——
        cy.nodes().forEach(el => {
            if (want.has(el.id())) return;
            if (animate) kill(el);
            else el.remove();
        });

        // —— 节点：新增前先算出兄弟顺序，保证环形槽位稳定 ——
        const siblings = new Map();
        for (const n of state.nodes) {
            if (!want.has(n.id) || !n.parentId) continue;
            let arr = siblings.get(n.parentId);
            if (!arr) siblings.set(n.parentId, arr = []);
            arr.push(n.id);
        }

        const born = [];
        for (const n of state.nodes) {
            if (!want.has(n.id)) continue;
            const el = cy.getElementById(n.id);
            if (!el.empty()) {
                if (el.data('dying')) revive(el);
                else refreshNodeData(el, n);
                continue;
            }
            born.push(n);
        }

        for (const n of born) {
            const parentEl = n.parentId ? cy.getElementById(n.parentId) : null;
            const hasParent = parentEl && !parentEl.empty();
            const center = hasParent ? parentEl.position() : viewportCenter();
            const parentNode = n.parentId ? state.nodeById.get(n.parentId) : null;
            const ids = siblings.get(n.parentId) || [n.id];
            const spec = ringSpecFor(n, parentNode);
            const slots = ringPositions(center, ids.length, spec);
            const idx = Math.max(0, ids.indexOf(n.id));
            const target = slots[idx] || center;

            let el;
            try {
                el = cy.add(nodeData(n, center));
            } catch (err) {
                console.warn('[码图] 跳过节点', n, err);
                continue;
            }
            if (n.kind === 'method') el.addClass('expanded');
            if (animate) {
                el.style({ opacity: 0 });
                el.animate(
                    { position: target, style: { opacity: 1 } },
                    { duration: ANIM.growDuration, easing: ANIM.easing });
            } else {
                el.position(target);
            }
        }

        // —— 边 ——
        refreshEdgeList();
        const wantEdges = new Map();
        for (const e of state.edgeList) if (edgeVisible(e)) wantEdges.set(e.id, e);

        cy.edges().forEach(el => {
            const e = wantEdges.get(el.id());
            if (e) return;
            if (animate) kill(el);
            else el.remove();
        });

        for (const [id, e] of wantEdges) {
            const el = cy.getElementById(id);
            if (!el.empty()) {
                if (el.data('dying')) revive(el);
                continue;
            }
            if (cy.getElementById(e.source).empty()) continue;
            if (cy.getElementById(e.target).empty()) continue;
            const opacity = EDGE_OPACITY[e.kind] || 0.6;
            let added;
            try {
                added = cy.add({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } });
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

        state.drawn = { nodes: want.size, edges: wantEdges.size };
        updateStats();
    }

    function updateStats() {
        if (!state.stats) return;
        // 用「目标集合」的规模而不是 cy 的实时规模：淡出中的元素还在画布上，
        // 显示实时值会让状态栏在折叠动画期间跳一下。
        const drawn = state.drawn || { nodes: cy.nodes().length, edges: cy.edges().length };
        statsEl.textContent =
            `${state.stats.projectId} · v${state.stats.version} · ${state.stats.fileCount} 文件 · ` +
            `${drawn.nodes}/${state.stats.nodes} 节点 · ${drawn.edges} 边 · ` +
            `${state.stats.elapsedMs} ms` +
            (state.stats.fromCache ? ` · L1 缓存 ${state.stats.cachedFiles}` : '') +
            (state.stats.analyzer ? ` · ${state.stats.analyzer}` : '');
        const modeText = state.mode === 'namespace' ? '聚合：命名空间' : '平铺：类型';
        if (modeBtn.textContent !== modeText) modeBtn.textContent = modeText;
    }

    function refreshHint() {
        const tips = state.mode === 'namespace'
            ? '单击命名空间展开其中的类型'
            : '单击类型展开它的方法';
        setHint(`${tips} · 双击空白折叠全部 · 单击方法跳到源码 · 0 复位 · +/- 缩放 · F12 开发者工具`);
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
            const isContainer = state.mode === 'namespace' ? n.kind === 'namespace' : isTypeNode(n);
            if (!isContainer) continue;
            if (!state.expanded.has(n.id)) { state.expanded.add(n.id); changed = true; }
        }
        if (!changed) return;
        render({ animate: false });
        layoutAll(true);
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
        cy.animate(
            { center: { eles: el }, zoom: Math.max(cy.zoom(), 0.7) },
            { duration: 420, easing: 'ease-out' });
        el.select();
        setTimeout(() => el.unselect(), 800);
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

    function renderResults(list, total, query) {
        if (!resultsEl) return;
        resultsEl.innerHTML = '';
        if (list.length === 0) { hideResults(); return; }

        list.slice(0, 40).forEach(n => {
            const row = document.createElement('div');
            row.className = 'row';
            const color = TYPE_COLORS[n.kind] || '#888';
            row.innerHTML =
                `<span class="kind" style="background:${color}">${KIND_LABEL[n.kind] || n.kind}</span>` +
                `<span>${escapeHtml(n.label)}</span>` +
                `<span class="fqn">${escapeHtml(n.fqn || '')}</span>`;
            row.addEventListener('mousedown', ev => {
                ev.preventDefault();
                centerOn(n.id);
                hideResults();
            });
            resultsEl.appendChild(row);
        });

        if (total > 40) {
            const more = document.createElement('div');
            more.className = 'more';
            more.textContent = `… 还有 ${total - 40} 个匹配（请把关键词写得更具体）`;
            resultsEl.appendChild(more);
        }
        resultsEl.classList.add('open');
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
        const edges = state.edgeList.filter(e => edgeVisible(e) && ids.has(e.source) && ids.has(e.target));
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

        ctx.fillStyle = '#fafafa';
        ctx.fillRect(x1 - pad, y1 - pad, w, h);

        // —— 先画边 ——
        const EDGE_COLOR = {
            inherits: '#e76f51', nsInherits: '#e76f51',
            typeCalls: '#4c8dff', nsCalls: '#4c8dff',
            typeContains: '#c2c9d2', calls: '#8c9298',
        };
        for (const e of edges) {
            const a = pos.get(e.source);
            const b = pos.get(e.target);
            if (!a || !b) continue;
            const color = EDGE_COLOR[e.kind] || '#8c9298';
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
                ctx.beginPath();
                ctx.arc(bb.x1 + bb.w / 2, bb.y1 + bb.h / 2, bb.w / 2, 0, Math.PI * 2);
                ctx.fillStyle = TYPE_COLORS[(state.nodeById.get(n.parentId) || {}).kind] || '#888';
                ctx.globalAlpha = 0.85;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                continue;
            }
            drawCard(ctx, n, bb);
        }

        return canvas.toDataURL('image/png');
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
        const color = TYPE_COLORS[n.kind] || '#888';
        const radius = 5;
        const x = box.x1, y = box.y1, w = box.w, h = box.h;

        ctx.save();
        ctx.beginPath();
        roundRect(ctx, x, y, w, h, radius);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = n.kind === 'namespace' ? 2 : 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();

        // 标题条
        const headerH = n.kind === 'namespace' ? 28 : 24;
        ctx.save();
        ctx.beginPath();
        roundRect(ctx, x, y, w, h, radius);
        ctx.clip();
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, headerH);
        ctx.restore();

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${n.kind === 'namespace' ? 13 : 12}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(clipText(ctx, n.label, w - 16), x + w / 2, y + headerH / 2);

        // 正文
        ctx.textAlign = 'left';
        ctx.font = '11px "Cascadia Mono", "Consolas", monospace';
        ctx.fillStyle = '#333333';
        let cursor = y + headerH + 8;
        const lines = n.kind === 'namespace'
            ? [`${(state.childrenOf.get(n.id) || []).length} 个类型`, ...(n.preview || [])]
            : [...(n.fields || []), ...(n.methods || [])];
        for (const line of lines) {
            if (cursor > y + h - 4) break;
            if (line.startsWith('…')) ctx.fillStyle = '#9aa4b2';
            ctx.fillText(clipText(ctx, line, w - 16), x + 8, cursor + 5);
            ctx.fillStyle = '#333333';
            cursor += 17;
        }
        if (lines.length === 0) {
            ctx.fillStyle = '#bbbbbb';
            ctx.fillText('(空)', x + 8, cursor + 5);
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
            if (isNewProject || cy.nodes().length === 0) layoutAll(true);
            refreshHint();
            for (const n of stale) requestResolve(n);
        });
    }

    function methodSignature(n) {
        return (n.methods || []).join('\u0001') + '\u0002' + (n.fields || []).join('\u0001');
    }

    // ================================================================
    //  交互
    // ================================================================

    // 悬停：cytoscape 没有 :hover 伪类，只能自己加类
    cy.on('mouseover', 'node[isType], node[isNs], node[isMethod]',
        evt => evt.target.addClass('hovered'));
    cy.on('mouseout', 'node[isType], node[isNs], node[isMethod]',
        evt => evt.target.removeClass('hovered'));

    cy.on('tap', 'node[isNs]', evt => { state.selected = evt.target.id(); toggle(evt.target.id()); });
    cy.on('tap', 'node[isType]', evt => { state.selected = evt.target.id(); toggle(evt.target.id()); });
    cy.on('tap', 'node[isMethod]', evt => {
        state.selected = evt.target.id();
        const d = evt.target.data();
        if (!d.file) return;
        setHint(`跳转 ${d.file}:${d.line} ...`);
        post({ type: 'goto', file: d.file, line: d.line || 1 });
    });
    cy.on('tap', evt => {
        if (evt.target === cy) { hideResults(); }
    });
    cy.on('dbltap', evt => {
        if (evt.target === cy) { clearFilter(); collapseAll(); }
    });
    // 右键直接按工具栏当前的方向与深度追踪
    cy.on('cxttap', 'node', evt => {
        state.selected = evt.target.id();
        traceFrom(evt.target.id(),
            traceDirEl ? traceDirEl.value : 'out',
            Number(traceDepthEl ? traceDepthEl.value : 3));
    });

    if (modeBtn) {
        modeBtn.addEventListener('click', () => {
            state.mode = state.mode === 'namespace' ? 'type' : 'namespace';
            state.expanded.clear();
            state.filter = null;
            state.preFilterExpanded = null;
            updateFocusBar();
            cy.elements().remove();
            render({ animate: false });
            layoutAll(true);
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

    const exportPngBtn = document.getElementById('exportPng');
    if (exportPngBtn) exportPngBtn.addEventListener('click', () => exportAs('png'));
    const exportMermaidBtn = document.getElementById('exportMermaid');
    if (exportMermaidBtn) exportMermaidBtn.addEventListener('click', () => exportAs('mermaid'));
    const exportJsonBtn = document.getElementById('exportJson');
    if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportAs('json'));

    if (searchEl) {
        searchEl.addEventListener('input', () => {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => runSearch(searchEl.value), 180);
        });
        searchEl.addEventListener('focus', () => {
            if (searchEl.value.trim().length > 0 && resultsEl && resultsEl.children.length) {
                resultsEl.classList.add('open');
            }
        });
        searchEl.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                const first = resultsEl && resultsEl.querySelector('.row');
                if (first) first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            } else if (ev.key === 'Escape') {
                clearFilter();
                searchEl.blur();
            }
        });
    }

    document.addEventListener('mousedown', ev => {
        if (!resultsEl) return;
        if (ev.target === searchEl || resultsEl.contains(ev.target)) return;
        hideResults();
    });

    window.chrome.webview.addEventListener('message', ev => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'snapshot') onSnapshot(msg.snapshot);
        else if (msg.type === 'resolved') onResolved(msg);
        else if (msg.type === 'navigated') onNavigated(msg);
        else if (msg.type === 'exported') onExported(msg);
        else if (msg.type === 'resolving') setHint('语义解析中…（首次解析需要建立编译，稍等）');
    });

    window.addEventListener('keydown', e => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            if (e.key === 'Escape' && tag === 'INPUT') clearFilter();
            return;
        }
        if (e.key === '/') { e.preventDefault(); if (searchEl) searchEl.focus(); return; }
        if (e.key === '0') cy.animate({ fit: { padding: 60 } }, { duration: 400, easing: 'ease-out' });
        else if (e.key === '=' || e.key === '+') cy.animate({ zoom: cy.zoom() * 1.2, duration: 200 });
        else if (e.key === '-') cy.animate({ zoom: cy.zoom() / 1.2, duration: 200 });
        else if (e.key === 'Escape') { clearFilter(); collapseAll(); }
        else if (e.key === 't' || e.key === 'T') {
            if (state.selected) {
                traceFrom(state.selected,
                    traceDirEl ? traceDirEl.value : 'out',
                    Number(traceDepthEl ? traceDepthEl.value : 3));
            }
        } else if (e.key === 'F12') post({ type: 'devtools' });
    });

    post({ type: 'ready' });
    setHint('已就绪，打开项目后显示骨架图');
    updateStats();

    // 诊断句柄：方案 §8 的原则是「WebView2 里排查问题的成本远高于普通浏览器」，
    // 所以把内部状态挂出来，便于远程调试端口或控制台直接查。
    window.__codemap = {
        cy,
        state,
        isVisible,
        edgeVisible,
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
        snapshotSummary() {
            const byKind = {};
            for (const n of state.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
            return {
                projectId: state.projectId,
                version: state.version,
                mode: state.mode,
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
