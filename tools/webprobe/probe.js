/*
 * WebView2 远程调试探针
 *
 * 用途：不依赖人眼，直接读取码图页面在真实 WebView2 里的状态并模拟点击。
 * 原理：给码图进程设置 MATU_CDP_PORT=<port>，再通过 CDP 的 Runtime.evaluate
 *      读写页面里的 window.__codemap。
 *
 * 用法：node tools/webprobe/probe.js [port]
 */

import { sleep, connectToApp } from './cdp.js';

const port = Number(process.argv[2] || process.env.CDP_PORT || 9222);

function line(label, value) {
    console.log(`  ${label.padEnd(26, ' ')} ${value}`);
}

function summarize(cdp, title) {
    return cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())').then(raw => {
        const x = JSON.parse(raw);
        console.log(`\n== ${title} ==`);
        line('项目 / 版本', `${x.projectId} v${x.version}`);
        line('聚合模式', x.mode);
        line('数据规模', `${x.source.nodes} 节点 / ${x.source.edges} 边  ${JSON.stringify(x.source.byKind)}`);
        line('可见集合', `${x.wanted.nodes} 节点 / ${x.wanted.edges} 边`);
        line('画布实时', `${x.drawn.nodes} 节点 / ${x.drawn.edges} 边`);
        line('已展开容器', x.expanded.length ? x.expanded.join(',') : '(无)');
        line('聚焦过滤器', x.filter ? x.filter.label : '(无)');
        line('状态栏', x.stats);
        line('分析器', x.analyzer || '(未上报)');
        line('提示', x.hint);
        if (x.errors.length) {
            line('页面 JS 错误', '');
            for (const e of x.errors) console.log(`      ! ${e}`);
        }
        return x;
    });
}

// ================================================================
//  第一 ~ 三阶段：聚合、展开/折叠、L2 精确化
// ================================================================

async function stageOneToThree(cdp, check) {
    const before = await summarize(cdp, '首屏（默认命名空间聚合）');
    check('首屏只画命名空间节点',
        before.wanted.nodes === (before.source.byKind.namespace || 0),
        `${before.wanted.nodes} vs ${before.source.byKind.namespace || 0}`);
    check('首屏规模远小于类型总数',
        before.wanted.nodes < before.source.nodes,
        `${before.wanted.nodes} < ${before.source.nodes}`);
    check('首屏无 JS 错误', before.errors.length === 0);

    // —— 点击第一个命名空间 ——
    await cdp.eval(`
        (function () {
            var ns = window.__codemap.cy.nodes('[isNs]');
            if (ns.length) ns[0].emit('tap');
            return ns.length;
        })()`);
    await sleep(1200);
    const expanded = await summarize(cdp, '点击命名空间之后');
    check('命名空间展开后出现了类型节点',
        (await cdp.eval("window.__codemap.cy.nodes('[isType]').length")) > 0);
    check('展开后无 JS 错误', expanded.errors.length === 0);

    // —— 渲染不变量 ——
    // 1) 卡片节点自身不能有任何可见画法：一旦被画出来，卡片没盖住的边角就会露出
    //    一整块底色（曾经是纯黑矩形 + 虚线边：cytoscape 没有 :hover 伪类，未知伪类
    //    被当成恒真条件；同时背景填充会忽略 background-color 自带的 alpha）。
    const painted = JSON.parse(await cdp.eval(`
        (function () {
            var bad = [];
            window.__codemap.cy.nodes('[isType], [isNs]').forEach(function (n) {
                var op = n.pstyle('background-opacity').value;
                var bw = n.pstyle('border-width').value;
                if (op > 0.01 || bw > 0.01) {
                    bad.push(n.data('label') + ' bgOpacity=' + op + ' borderWidth=' + bw);
                }
            });
            return JSON.stringify(bad);
        })()`));
    check('卡片节点自身不被绘制', painted.length === 0, painted.slice(0, 3).join(' | '));

    // 2) 节点尺寸必须等于卡片实测尺寸，否则卡片盖不满节点
    const sized = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var bad = [];
            app.cy.nodes('[isType], [isNs]').forEach(function (n) {
                var raw = app.state.nodeById.get(n.id());
                if (!raw) return;
                var m = app.measureSize(raw);
                if (Math.abs(n.width() - m.w) > 1 || Math.abs(n.height() - m.h) > 1) {
                    bad.push(n.data('label') + ' node=' +
                        Math.round(n.width()) + 'x' + Math.round(n.height()) +
                        ' card=' + m.w + 'x' + m.h);
                }
            });
            return JSON.stringify(bad);
        })()`));
    check('节点尺寸与卡片实测尺寸一致', sized.length === 0, sized.slice(0, 3).join(' | '));

    // —— 点击方法最多的那个类型，触发 L2 语义精确化 ——
    const picked = await cdp.eval(`
        (function () {
            var t = window.__codemap.cy.nodes('[isType]')
                .sort(function (a, b) {
                    return (b.data('methods') || []).length - (a.data('methods') || []).length;
                });
            if (!t.length) return null;
            t[0].emit('tap');
            return t[0].data('label');
        })()`);
    check('找到了可展开的类型', !!picked, String(picked));

    // 等 L2 回来（首次要建立编译，给足时间）
    let l2 = null;
    for (let i = 0; i < 80; i++) {
        const raw = await cdp.eval(`
            (function () {
                var st = window.__codemap.state;
                if (st.resolutions.size === 0) return '';
                var out = [];
                st.resolutions.forEach(function (r, id) {
                    out.push({ id: id, fqn: r.fqn, precise: r.precise, calls: r.calls,
                               typeCalls: r.typeCalls, unresolved: r.unresolved, ms: r.elapsedMs });
                });
                return JSON.stringify({
                    out: out,
                    l1Calls: st.edges.filter(function (e) { return e.kind === 'calls'; }).length,
                    effectiveCalls: st.edgeList.filter(function (e) { return e.kind === 'calls'; }).length,
                });
            })()`);
        if (raw) { l2 = JSON.parse(raw); break; }
        await sleep(500);
    }

    const methods = await summarize(cdp, '点击类型之后');
    check('类型展开后出现了方法节点',
        (await cdp.eval("window.__codemap.cy.nodes('[isMethod]').length")) > 0);
    check('展开类型后无 JS 错误', methods.errors.length === 0);
    check('L2 语义解析返回了结果', !!l2 && l2.out.length > 0);

    if (l2 && l2.out.length) {
        const r = l2.out[0];
        console.log(`  L2 ${r.fqn} → precise=${r.precise} calls=${r.calls} ` +
            `typeCalls=${r.typeCalls} unresolved=${r.unresolved} ${r.ms}ms`);
        check('L2 判定为精确', r.precise === true, String(r.reason || ''));
        check('L2 没有让边集膨胀',
            l2.effectiveCalls <= l2.l1Calls,
            `生效 ${l2.effectiveCalls} ≤ L1 ${l2.l1Calls}`);
        check('L2 结果已进入实际边集', l2.effectiveCalls > 0, `${l2.effectiveCalls} 条`);
    }

    // —— 双击空白折叠全部 ——
    await cdp.eval('window.__codemap.cy.emit("dbltap"); true');
    await sleep(1000);
    const collapsed = await summarize(cdp, '双击空白折叠全部');
    check('折叠后回到首屏规模',
        collapsed.wanted.nodes === before.wanted.nodes,
        `${collapsed.wanted.nodes} vs ${before.wanted.nodes}`);
    check('折叠后无 JS 错误', collapsed.errors.length === 0);

    // —— 切换到类型平铺模式 ——
    await cdp.eval('document.getElementById("modeBtn").click(); true');
    await sleep(1500);
    const flat = await summarize(cdp, '切换到类型平铺');
    const typeCount = Object.entries(flat.source.byKind)
        .filter(([k]) => k !== 'namespace' && k !== 'method')
        .reduce((a, [, v]) => a + v, 0);
    check('平铺模式画出了全部类型',
        flat.wanted.nodes === typeCount,
        `${flat.wanted.nodes} vs ${typeCount}`);
    check('平铺模式无 JS 错误', flat.errors.length === 0);

    // —— 嵌套类型的归属虚线 ——
    const contains = await cdp.eval(`
        (function () {
            var c = window.__codemap.cy;
            return {
                edges: c.edges('[kind="typeContains"]').length,
                marked: window.__codemap.state.edgeList.filter(function (e) {
                    return e.kind === 'typeContains';
                }).length,
            };
        })()`);
    check('平铺模式画出嵌套归属边',
        contains.marked === 0 || contains.edges === contains.marked,
        `${contains.edges}/${contains.marked}`);
}

// ================================================================
//  第四阶段：搜索 / 调用链 / 导出
// ================================================================

async function stageFour(cdp, check) {
    console.log('\n== 第四阶段：搜索 ==');
    await cdp.eval(`
        (function () {
            var s = document.getElementById('search');
            s.value = 'Skeleton';
            s.dispatchEvent(new Event('input'));
            return true;
        })()`);
    await sleep(1400);

    const search = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())'));
    console.log(`  ${search.filter ? search.filter.label : '(没有建立过滤器)'}`);
    line('可见集合', `${search.wanted.nodes} 节点 / ${search.wanted.edges} 边`);
    check('搜索建立了聚焦过滤器', !!search.filter && search.filter.kind === 'search');
    check('搜索结果集合非空', !!search.filter && search.filter.nodes > 0,
        search.filter ? `${search.filter.nodes} 节点` : '');
    check('搜索结果已画到画布上',
        search.wanted.nodes > 0 && search.wanted.nodes <= (search.filter ? search.filter.nodes : 0));
    check('搜索过程无 JS 错误', search.errors.length === 0);
    check('搜索面板列出了候选',
        (await cdp.eval('document.getElementById("results").children.length')) > 0);

    await cdp.eval('window.__codemap.clearFilter(); true');
    await sleep(700);
    const cleared = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())'));
    check('退出聚焦后过滤器被清掉', cleared.filter === null);
    check('退出聚焦后图还在', cleared.wanted.nodes > 0);

    console.log('\n== 第四阶段：调用链 ==');
    await cdp.eval(`
        (function () {
            var t = window.__codemap.cy.nodes('[isType]')
                .sort(function (a, b) {
                    return (b.data('methods') || []).length - (a.data('methods') || []).length;
                });
            if (!t.length) return null;
            t[0].emit('tap');
            return t[0].id();
        })()`);
    await sleep(1600);
    await cdp.eval('document.getElementById("traceBtn").click(); true');
    await sleep(1200);

    const trace = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())'));
    console.log(`  ${trace.filter ? trace.filter.label : '(没有触发调用链)'}`);
    check('调用链建立了聚焦过滤器', !!trace.filter && trace.filter.kind === 'trace');
    check('调用链收集到了边', !!trace.filter && trace.filter.edges > 0,
        trace.filter ? `${trace.filter.edges} 边` : '');
    check('调用链过程无 JS 错误', trace.errors.length === 0);

    console.log('\n== 第四阶段：导出 ==');
    const mermaid = await cdp.eval('window.__codemap.buildMermaid()');
    check('mermaid 导出有正确的头',
        typeof mermaid === 'string' && mermaid.includes('flowchart LR'));
    check('mermaid 导出包含节点与边',
        /-->/.test(mermaid) && /\bclass /.test(mermaid),
        typeof mermaid === 'string' ? `${mermaid.split('\n').length} 行` : '');

    const json = JSON.parse(await cdp.eval('window.__codemap.buildJson()'));
    check('JSON 导出结构完整',
        Array.isArray(json.nodes) && Array.isArray(json.edges) && json.nodes.length > 0,
        `${json.nodes.length} 节点 / ${json.edges.length} 边`);
    check('JSON 导出的边两端都在节点集合里', (() => {
        const ids = new Set(json.nodes.map(n => n.id));
        return json.edges.every(e => ids.has(e.source) && ids.has(e.target));
    })());

    const png = await cdp.eval('window.__codemap.buildPng(1)');
    check('PNG 数据 URL 生成成功',
        typeof png === 'string' && png.startsWith('data:image/png;base64,') && png.length > 5000,
        typeof png === 'string' ? `${Math.round(png.length / 1024)} KB` : String(png));

    await cdp.eval('window.__codemap.clearFilter(); true');
    await sleep(600);
    const final = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())'));
    check('阶段四全程无 JS 错误', final.errors.length === 0, final.errors.slice(0, 2).join(' | '));
}

// ================================================================
//  主流程
// ================================================================

const { page, cdp } = await connectToApp(port);
console.log(`已连接 ${page.url}`);

// 等前端把首个快照画完
for (let i = 0; i < 60; i++) {
    const n = await cdp.eval('window.__codemap ? window.__codemap.state.nodes.length : -1');
    if (n > 0) break;
    await sleep(500);
}

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

try {
    await stageOneToThree(cdp, check);
    await stageFour(cdp, check);
} catch (err) {
    console.error(`\n探针中断：${err.message}`);
    failures++;
}

console.log(`\n结论：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
