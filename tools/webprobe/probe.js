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

/*
 * 布局不变量。
 *
 * 这里量的是 cytoscape 的 boundingBox（含节点标签），而不是节点自己的 width/height ——
 * 方法节点的标签是常显的，只按 14px 的圆点算「没压住」，标签其实已经糊到旁边的卡片上。
 *
 * shared 一项专门盯住一个曾经把图毁掉的地雷：cytoscape 的 position() 交出的是元素内部
 * 那个 position 对象本身，add() 又直接引用传进去的对象。一旦有两条路径共用同一个对象，
 * 动一个就等于动全部，整批展开的节点会全部叠在容器上。
 */
async function layoutReport(cdp) {
    return JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var live = app.cy.nodes().filter(function (n) { return !n.data('dying'); });
            var seen = [], shared = 0;
            live.forEach(function (n) {
                var p = n.position();
                if (seen.indexOf(p) >= 0) shared++; else seen.push(p);
            });
            var overlaps = [];
            // 容器和它自己的后代「重叠」是设计本身（子节点就排在容器里面），不算冲突
            var ancestors = {};
            live.forEach(function (n) {
                var set = {}, cur = app.state.nodeById.get(n.id());
                while (cur) {
                    set[cur.id] = 1;
                    cur = cur.parentId ? app.state.nodeById.get(cur.parentId) : null;
                }
                ancestors[n.id()] = set;
            });
            for (var i = 0; i < live.length; i++) {
                for (var j = i + 1; j < live.length; j++) {
                    if (ancestors[live[i].id()][live[j].id()]) continue;
                    if (ancestors[live[j].id()][live[i].id()]) continue;
                    var a = live[i].boundingBox(), b = live[j].boundingBox();
                    var ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
                    var oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
                    if (ox > 1 && oy > 1) {
                        overlaps.push(String(live[i].data('label')) + ' × ' +
                            String(live[j].data('label')) + ' 重叠 ' +
                            Math.round(ox) + 'x' + Math.round(oy));
                    }
                }
            }
            var pos = {};
            live.forEach(function (n) {
                var p = n.position();
                pos[n.id()] = [p.x, p.y];
            });
            return JSON.stringify({ shared: shared, overlaps: overlaps, pos: pos, count: live.length });
        })()`));
}

/*
 * 内嵌布局的核心不变量：可见子节点必须完整落在它容器的盒子里。
 * 这一条就是把「展开 = 卡片长大 + 子节点排在内部」钉死；只要有人把子节点甩到容器外面，
 * 这里立刻会红。
 */
async function containmentReport(cdp) {
    return JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var bad = [], checked = 0;
            app.cy.nodes().forEach(function (el) {
                var n = app.state.nodeById.get(el.id());
                if (!n) return;
                var parent = app.layoutParentOf(n);
                if (!parent) return;
                var pel = app.cy.getElementById(parent.id);
                if (pel.empty()) { bad.push(String(n.label) + ' 的容器不在画布上'); return; }
                checked++;
                var a = el.boundingBox(), p = pel.boundingBox();
                if (a.x1 < p.x1 - 1 || a.x2 > p.x2 + 1 || a.y1 < p.y1 - 1 || a.y2 > p.y2 + 1) {
                    bad.push(String(n.label) + ' 溢出 ' + String(parent.label) +
                        ' 子[' + [Math.round(a.x1), Math.round(a.y1), Math.round(a.x2), Math.round(a.y2)] +
                        '] 容器[' + [Math.round(p.x1), Math.round(p.y1), Math.round(p.x2), Math.round(p.y2)] + ']');
                }
            });
            return JSON.stringify({ checked: checked, bad: bad });
        })()`));
}

/** 取某个节点的尺寸，「展开后容器必须长大」用它比。 */
async function nodeSize(cdp, id) {
    const raw = await cdp.eval(`
        (function () {
            var el = window.__codemap.cy.getElementById(${JSON.stringify(id)});
            return el.empty() ? '' : JSON.stringify([Math.round(el.width()), Math.round(el.height())]);
        })()`);
    return raw ? JSON.parse(raw) : null;
}

/*
 * 「展开后线要改挂到子节点上」。
 *
 * 展开一个容器之后，原来连在它卡片上的聚合边应该全部挪到里面真正参与的子节点上；
 * 还有线挂在已展开的容器卡片上 = 用户看到的那条「连错了」的线。
 * 只查聚合边（nsCalls / nsInherits / typeCalls）：嵌套归属虚线 typeContains 本来就该
 * 连在外层类型上，那是它的语义，不是没更新。
 */
async function retargetReport(cdp, expandedIds) {
    return JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var expanded = ${JSON.stringify(expandedIds)};
            var label = function (id) {
                var n = app.state.nodeById.get(id);
                return n ? String(n.label) : '?' + id;
            };
            var isAggregate = function (k) {
                return k === 'nsCalls' || k === 'nsInherits' || k === 'typeCalls';
            };
            var insideOf = function (id, ancestor) {
                var n = app.state.nodeById.get(id);
                while (n && n.parentId) {
                    if (n.parentId === ancestor) return true;
                    n = app.state.nodeById.get(n.parentId);
                }
                return false;
            };

            var onChild = [], stuck = [], ontoMethods = [];
            var kindOf = function (id) {
                var n = app.state.nodeById.get(id);
                return n ? n.kind : '';
            };
            var descendsFrom = function (id) {
                for (var i = 0; i < expanded.length; i++) if (insideOf(id, expanded[i])) return true;
                return false;
            };
            app.cy.edges().forEach(function (e) {
                if (e.data('dying')) return;
                var k = e.data('kind');
                if (!isAggregate(k)) return;
                var s = e.data('source'), t = e.data('target');
                var descends = false;
                for (var i = 0; i < expanded.length; i++) {
                    if (insideOf(s, expanded[i]) || insideOf(t, expanded[i])) descends = true;
                    if (s === expanded[i] || t === expanded[i]) {
                        stuck.push(k + ': ' + label(s) + ' → ' + label(t));
                    }
                }
                if (descends) onChild.push(k + ': ' + label(s) + ' → ' + label(t));
                if ((kindOf(s) === 'method' && descendsFrom(s)) ||
                    (kindOf(t) === 'method' && descendsFrom(t))) {
                    ontoMethods.push(k + ': ' + label(s) + ' → ' + label(t));
                }
            });
            return JSON.stringify({ onChild: onChild, stuck: stuck, ontoMethods: ontoMethods });
        })()`));
}

/*
 * 用真实鼠标事件拖一个节点。
 * 不能直接改 position —— 那样绕过了 cytoscape 的抓取/拖动路径，
 * 「拖动父节点时子节点没跟着走」这类问题根本测不出来。
 *
 * 抓取点要试：展开后的托盘可能比窗口还高（顶部在视口外），
 * 托盘正中又可能正好压着里面的子节点 —— 那样抓到的是子节点，容器不动。
 * 所以从标题条开始挨个候选点试，直到容器真的动了为止。
 */
async function dragNode(cdp, id, dxScreen, dyScreen) {
    const candidates = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var el = app.cy.getElementById(${JSON.stringify(id)});
            if (el.empty()) return '[]';
            var rect = app.cy.container().getBoundingClientRect();
            var rp = el.renderedPosition();
            var z = app.cy.zoom();
            var hw = el.width() * z / 2, hh = el.height() * z / 2;
            var x1 = rp.x - hw, y1 = rp.y - hh, x2 = rp.x + hw, y2 = rp.y + hh;
            var raw = [
                [x1 + 24, y1 + 12], [rp.x, y1 + 12],
                [rp.x, rp.y], [x1 + 24, rp.y], [x2 - 24, rp.y], [rp.x, y2 - 12],
            ];
            var pts = [];
            for (var i = 0; i < raw.length; i++) {
                var px = raw[i][0], py = raw[i][1];
                if (px < 4 || py < 4 || px > rect.width - 4 || py > rect.height - 4) continue;
                pts.push([Math.round(rect.left + px), Math.round(rect.top + py)]);
            }
            return JSON.stringify(pts);
        })()`));

    if (candidates.length === 0) return null;

    const snapshot = `
        (function () {
            var app = window.__codemap;
            var el = app.cy.getElementById(${JSON.stringify(id)});
            if (el.empty()) return 'null';
            var kids = app.visibleDescendants(el);
            var pos = {};
            kids.forEach(function (k) {
                var p = k.position();
                pos[k.id()] = [p.x, p.y];
            });
            var p0 = el.position();
            var off = app.state.offsets.get(el.id()) || null;
            return JSON.stringify({
                self: [p0.x, p0.y], kids: pos, kidCount: kids.length, offset: off,
            });
        })()`;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
        // 上一次可能抓到了子节点并把它拖走了，先复位
        await cdp.eval('window.__codemap.resetDragOffsets(); true');
        await sleep(260);

        const before = JSON.parse(await cdp.eval(snapshot));
        const [x, y] = candidates[attempt];

        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, buttons: 0 });
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1,
        });
        for (let i = 1; i <= 8; i++) {
            await sleep(30);
            await cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x: x + Math.round(dxScreen * i / 8),
                y: y + Math.round(dyScreen * i / 8), button: 'left', buttons: 1,
            });
        }
        await sleep(50);
        await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: x + dxScreen, y: y + dyScreen,
            button: 'left', buttons: 0, clickCount: 1,
        });
        await sleep(320);

        const after = JSON.parse(await cdp.eval(snapshot));
        const moved = Math.abs(after.self[0] - before.self[0]) > 5 ||
            Math.abs(after.self[1] - before.self[1]) > 5;
        if (moved) {
            // 鼠标挪开：不然光标还悬停在卡片上，后面「卡片节点自身不被绘制」那条
            // 会量到悬停时才有的虚线边框（那是设计的一部分，不是绘制泄漏）
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, buttons: 0 });
            await sleep(120);
            return { before: before, after: after, attempts: attempt + 1 };
        }
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3, buttons: 0 });
    return null;
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
    const homeLayout = await layoutReport(cdp);
    check('首屏没有节点叠在一起', homeLayout.overlaps.length === 0,
        homeLayout.overlaps.slice(0, 2).join(' | '));
    check('首屏节点各自持有独立的 position 对象', homeLayout.shared === 0,
        `${homeLayout.shared} 个节点与别的节点共用同一个 position`);

    const nsId = await cdp.eval(`
        (function () {
            var ns = window.__codemap.cy.nodes('[isNs]');
            return ns.length ? ns[0].id() : '';
        })()`);
    check('取到了要展开的命名空间', !!nsId, String(nsId));
    const nsSizeBefore = await nodeSize(cdp, nsId);

    await cdp.eval(`window.__codemap.cy.getElementById(${JSON.stringify(nsId)}).emit('tap'); true`);
    await sleep(1400);
    const expanded = await summarize(cdp, '点击命名空间之后');
    check('命名空间展开后出现了类型节点',
        (await cdp.eval("window.__codemap.cy.nodes('[isType]').length")) > 0);
    check('展开后无 JS 错误', expanded.errors.length === 0);

    const afterNs = await layoutReport(cdp);
    check('展开命名空间后没有节点叠在一起', afterNs.overlaps.length === 0,
        afterNs.overlaps.slice(0, 2).join(' | '));
    check('展开命名空间后仍有独立 position', afterNs.shared === 0,
        `${afterNs.shared} 个节点与别的节点共用同一个 position`);

    const nsSizeAfter = await nodeSize(cdp, nsId);
    check('展开后容器卡片长大了',
        nsSizeBefore && nsSizeAfter && nsSizeAfter[1] > nsSizeBefore[1] + 20 &&
        nsSizeAfter[0] >= nsSizeBefore[0],
        `${nsSizeBefore} → ${nsSizeAfter}`);

    const containNs = await containmentReport(cdp);
    check('展开命名空间后子节点都排在容器内部', containNs.bad.length === 0,
        `检查 ${containNs.checked} 个 · ${containNs.bad.slice(0, 2).join(' | ')}`);
    check('展开命名空间确实检查到了子节点', containNs.checked > 0, `${containNs.checked} 个`);

    // —— 展开之后，原来连在父卡片上的线要改挂到里面真正参与的子节点上 ——
    const nsRetarget = await retargetReport(cdp, [nsId]);
    check('展开命名空间后聚合边改挂到了内部节点上', nsRetarget.onChild.length > 0,
        nsRetarget.onChild.slice(0, 3).join(' | '));
    check('没有聚合边还挂在已展开的命名空间卡片上', nsRetarget.stuck.length === 0,
        nsRetarget.stuck.join(' | '));

    // —— 拖动容器：里面的子节点必须整体跟着走 ——
    const drag = await dragNode(cdp, nsId, 130, 70);
    const selfDelta = drag
        ? [drag.after.self[0] - drag.before.self[0], drag.after.self[1] - drag.before.self[1]]
        : [0, 0];
    check('鼠标能把容器拖走', !!drag && (Math.abs(selfDelta[0]) > 20 || Math.abs(selfDelta[1]) > 20),
        drag ? `第 ${drag.attempts} 个抓取点生效，位移 ${selfDelta.map(v => Math.round(v)).join(',')}`
            + `（容器里有 ${drag.before.kidCount} 个后代）`
            : '所有候选抓取点都没抓到容器');

    const kidDeltas = drag ? Object.entries(drag.after.kids).map(([id, p]) => {
        const b = drag.before.kids[id];
        return b ? [p[0] - b[0], p[1] - b[1]] : null;
    }).filter(Boolean) : [];
    const followedAll = !!drag && kidDeltas.length === drag.before.kidCount && kidDeltas.length > 0 &&
        kidDeltas.every(d => Math.abs(d[0] - selfDelta[0]) < 1.5 && Math.abs(d[1] - selfDelta[1]) < 1.5);
    check('拖动容器时子节点跟着一起走', followedAll,
        drag ? `${kidDeltas.length}/${drag.before.kidCount} 个后代的位移与容器一致` : '(没拖动成功)');

    // 重排一次：拖动留下的位移必须被记住，卡片不能弹回自动布局的位置
    const kept = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var el = app.cy.getElementById(${JSON.stringify(nsId)});
            var a = el.position();
            app.render({ animate: false });
            var b = el.position();
            return JSON.stringify({ a: [a.x, a.y], b: [b.x, b.y] });
        })()`));
    check('拖动的位置在重新布局后不弹回',
        Math.abs(kept.a[0] - kept.b[0]) < 1 && Math.abs(kept.a[1] - kept.b[1]) < 1,
        `[${kept.a.map(v => Math.round(v)).join(',')}] → [${kept.b.map(v => Math.round(v)).join(',')}]`);

    // 复位，免得后面的断言都在一个被拖歪的布局上做
    await cdp.eval('window.__codemap.resetDragOffsets(); true');
    await sleep(500);
    const reset = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary().dragged)'));
    check('「0 复位」清得掉拖动位移', reset.length === 0, `${reset.length} 个残留`);

    // —— 渲染不变量 ——
    // 上面的拖动测试把光标留在了卡片上，悬停高亮（虚线边框）是设计的一部分，
    // 先摘掉再验「卡片自身不被绘制」，免得把悬停当成绘制泄漏。
    await cdp.eval("window.__codemap.cy.nodes('.hovered').removeClass('hovered'); true");

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
    const pickedRaw = await cdp.eval(`
        (function () {
            var t = window.__codemap.cy.nodes('[isType]')
                .sort(function (a, b) {
                    return (b.data('methods') || []).length - (a.data('methods') || []).length;
                });
            if (!t.length) return '';
            t[0].emit('tap');
            return JSON.stringify({ id: t[0].id(), label: String(t[0].data('label')) });
        })()`);
    const pickedType = pickedRaw ? JSON.parse(pickedRaw) : null;
    check('找到了可展开的类型', !!pickedType, pickedType ? pickedType.label : '(没有类型节点)');

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

    const afterType = await layoutReport(cdp);
    check('展开类型后没有节点叠在一起（按含标签的包围盒比）', afterType.overlaps.length === 0,
        afterType.overlaps.slice(0, 2).join(' | '));
    check('展开类型后仍有独立 position', afterType.shared === 0,
        `${afterType.shared} 个节点与别的节点共用同一个 position`);

    const containType = await containmentReport(cdp);
    check('展开类型后方法芯片都排在类型卡片内部', containType.bad.length === 0,
        `检查 ${containType.checked} 个 · ${containType.bad.slice(0, 2).join(' | ')}`);
    check('嵌套布局确实检查到了子节点', containType.checked > containNs.checked,
        `${containNs.checked} → ${containType.checked}`);

    // 展开的类型上也不该再挂着聚合线：调用边要落到具体的方法上
    if (pickedType) {
        const typeRetarget = await retargetReport(cdp, [nsId, pickedType.id]);
        check('展开类型后调用边也改挂到了方法上',
            typeRetarget.ontoMethods.length > 0,
            typeRetarget.ontoMethods.slice(0, 2).join(' | ') ||
            typeRetarget.onChild.slice(0, 2).join(' | '));
        check('没有聚合边还挂在已展开的类型卡片上', typeRetarget.stuck.length === 0,
            typeRetarget.stuck.join(' | '));
    }

    const chipBox = await cdp.eval(`
        (function () {
            var m = window.__codemap.cy.nodes('[isMethod]');
            if (!m.length) return '';
            var el = m[0];
            return JSON.stringify({
                w: Math.round(el.width()), h: Math.round(el.height()),
                label: String(el.data('label')),
                textOpacity: el.pstyle('text-opacity').value,
            });
        })()`);
    const chip = chipBox ? JSON.parse(chipBox) : null;
    check('方法芯片按标签量出了宽度', !!chip && chip.w > 40 && chip.h === 22,
        chip ? `${chip.label} ${chip.w}x${chip.h}` : '(没有方法节点)');
    check('方法芯片的名字是常显的', !!chip && chip.textOpacity === 1,
        chip ? String(chip.textOpacity) : '');
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
//  第五阶段：界面与拖动
//
//  这一层没有「图数据」那种硬不变量，能钉住的是交互的结果：
//  切主题之后 DOM 变量和卡片底色真的变了、帮助面板列得出快捷键、
//  搜索结果能被方向键选中、悬停把无关的边压暗、点一下不该被记成拖动、
//  子节点怎么拖都出不了父容器。
// ================================================================

/** 模拟一次拖动：grab → 挪到目标点 → drag → free。 */
async function dragNodeTo(cdp, id, dx, dy) {
    return cdp.eval(`
        (function () {
            var el = window.__codemap.cy.getElementById(${JSON.stringify(id)});
            if (el.empty()) return '';
            var p = el.position();
            el.emit('grab');
            el.position({ x: p.x + ${dx}, y: p.y + ${dy} });
            el.emit('drag');
            el.emit('free');
            return JSON.stringify(el.position());
        })()`);
}

/** 这个节点是否整个落在（当前可见的）父容器里。 */
async function insideParent(cdp, id) {
    return cdp.eval(`
        (function () {
            var app = window.__codemap;
            var n = app.state.nodeById.get(${JSON.stringify(id)});
            var el = app.cy.getElementById(${JSON.stringify(id)});
            if (!n || el.empty()) return 'skip';
            var parent = app.layoutParentOf(n);
            if (!parent) return 'root';
            var pel = app.cy.getElementById(parent.id);
            if (pel.empty()) return 'skip';
            var a = el.boundingBox(), b = pel.boundingBox();
            return JSON.stringify(a.x1 >= b.x1 - 1 && a.x2 <= b.x2 + 1
                && a.y1 >= b.y1 - 1 && a.y2 <= b.y2 + 1);
        })()`);
}

async function stageFive(cdp, check) {
    console.log('\n== 第五阶段：界面 ==');
    const before = JSON.parse(await cdp.eval(`
        (function () {
            var c = document.querySelector('.mermaid-card');
            return JSON.stringify({
                theme: document.documentElement.getAttribute('data-theme'),
                surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
                border: c ? getComputedStyle(c).borderTopColor : '',
                version: window.__codemap.state.version,
            });
        })()`));

    // —— 主题：换到「另一套」配色，DOM 变量和卡片底色都得跟着走 ——
    // 用「另一套」而不是写死 dark：主题会存在 localStorage 里，
    // 上一次运行留下的选择会让「切到深色」变成原地不动
    const other = before.theme === 'dark' ? 'light' : 'dark';
    await cdp.eval(`window.__codemap.setTheme(${JSON.stringify(other)}, { silent: true }); true`);
    await sleep(600);
    const dark = JSON.parse(await cdp.eval(`
        (function () {
            var c = document.querySelector('.mermaid-card');
            return JSON.stringify({
                attr: document.documentElement.getAttribute('data-theme'),
                surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
                border: c ? getComputedStyle(c).borderTopColor : '',
            });
        })()`));
    check('切到另一套主题：DOM 变量跟着换', dark.attr === other, dark.attr);
    check('切主题会让卡片重新上色', dark.border !== before.border,
        `${before.border} → ${dark.border}`);
    check('底色变量也跟着换', !!dark.surface && dark.surface !== before.surface,
        `${before.surface} → ${dark.surface}`);

    await cdp.eval(`window.__codemap.setTheme(${JSON.stringify(before.theme)}, { silent: true }); true`);
    await sleep(500);
    check('能切回原来的主题',
        (await cdp.eval("document.documentElement.getAttribute('data-theme')")) === before.theme);

    // —— 宿主标题栏：标题栏底和窗口按钮是宿主画的，页面看不见它们，
    //    所以靠宿主回执（shell-theme）来核对它真的跟着换了 ——
    await cdp.eval("window.__codemap.setTheme('dark', { silent: true }); true");
    await sleep(900);
    const shellDark = JSON.parse(await cdp.eval(
        'JSON.stringify(window.__codemap.snapshotSummary().shell)'));
    check('切深色后外壳收到主题并落到根元素上',
        !!shellDark && shellDark.dark === true && shellDark.actual === 'Dark',
        JSON.stringify(shellDark));
    check('标题栏底色换成了深色那套',
        !!shellDark && /0E131C$/i.test(shellDark.band), shellDark && shellDark.band);

    await cdp.eval("window.__codemap.setTheme('light', { silent: true }); true");
    await sleep(900);
    const shellLight = JSON.parse(await cdp.eval(
        'JSON.stringify(window.__codemap.snapshotSummary().shell)'));
    check('切浅色后外壳跟着回到浅色',
        !!shellLight && shellLight.dark === false && shellLight.actual === 'Light',
        JSON.stringify(shellLight));
    check('标题栏底色换回浅色那套',
        !!shellLight && /F4F6F9$/i.test(shellLight.band), shellLight && shellLight.band);

    await cdp.eval(`window.__codemap.setTheme(${JSON.stringify(before.theme)}, { silent: true }); true`);
    await sleep(500);

    // —— 帮助面板 ——
    await cdp.eval('window.__codemap.toggleHelp(true); true');
    await sleep(250);
    const help = JSON.parse(await cdp.eval(`
        (function () {
            return JSON.stringify({
                open: document.getElementById('help').classList.contains('open'),
                rows: document.querySelectorAll('#helpRows .help-row').length,
            });
        })()`));
    check('帮助面板能打开', help.open === true);
    check('帮助面板列出了快捷键', help.rows >= 10, `${help.rows} 条`);
    await cdp.eval(
        "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    await sleep(250);
    check('Esc 关得掉帮助面板',
        (await cdp.eval("!document.getElementById('help').classList.contains('open')")) === true);

    // —— 搜索：命中高亮 + 方向键选择 ——
    await cdp.eval(`
        (function () {
            var s = document.getElementById('search');
            s.value = 'Analyzer';
            s.dispatchEvent(new Event('input'));
            return true;
        })()`);
    await sleep(1300);
    const search = JSON.parse(await cdp.eval(`
        (function () {
            var box = document.getElementById('results');
            return JSON.stringify({
                rows: box.querySelectorAll('.row').length,
                marks: box.querySelectorAll('.row mark').length,
                active: box.querySelectorAll('.row.active').length,
                clear: !document.getElementById('searchClear').hidden,
            });
        })()`));
    check('搜索结果列出了候选', search.rows > 0, `${search.rows} 行`);
    check('命中的关键词被标出来了', search.marks > 0, `${search.marks} 处`);
    check('默认高亮第一行', search.active === 1, `${search.active} 行`);
    check('有内容时出现清空按钮', search.clear === true);

    await cdp.eval(`document.getElementById('search').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`);
    await sleep(150);
    check('方向键能在候选里移动',
        (await cdp.eval(`
            (function () {
                var rows = document.getElementById('results').querySelectorAll('.row');
                return !!(rows[1] && rows[1].classList.contains('active'));
            })()`)) === true);

    await cdp.eval("window.__codemap.clearFilter(); document.getElementById('search').value = ''; true");
    await sleep(900);

    // —— 悬停高亮：无关的边压暗，移开恢复 ——
    // 先把画面停稳：淡出中的边透明度本来就是 0 附近，会污染这里的基准
    await cdp.eval('window.__codemap.render({ animate: false }); true');
    await sleep(400);
    const spot = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            var pick = null;
            app.cy.nodes().forEach(function (n) {
                if (pick || n.data('isMethod')) return;
                if (n.closedNeighborhood().edges().length > 0) pick = n;
            });
            if (!pick) return JSON.stringify({ skip: true });
            var dim = function () {
                var n = 0;
                app.cy.edges().forEach(function (e) {
                    if (parseFloat(e.style('opacity')) < 0.2) n++;
                });
                return n;
            };
            var beforeDim = dim();
            app.spotlight(pick);
            var onDim = dim();
            app.clearSpotlight();
            var offDim = dim();
            return JSON.stringify({
                label: String(pick.data('label')),
                before: beforeDim, on: onDim, off: offDim,
            });
        })()`));
    if (spot.skip) {
        check('悬停高亮：当前视图里没有带边的节点（跳过）', true);
    } else {
        check('悬停会把无关的边压暗', spot.on > spot.before,
            `${spot.label}：${spot.before} → ${spot.on} 条`);
        check('移开之后边的透明度恢复', spot.off === spot.before,
            `${spot.on} → ${spot.off} 条`);
    }

    // —— 拖动：点一下不算拖、子节点出不了父容器、连拖两次不丢位移 ——
    const setup = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap;
            app.clearFilter();
            app.state.offsets.clear();
            app.state.expanded.clear();
            app.render({ animate: false });
            // 上一阶段把模式切成了「平铺：类型」，先切回按命名空间聚合，
            // 否则画布上根本没有可以展开的容器
            if (app.state.mode !== 'namespace') document.getElementById('modeBtn').click();
            var ns = app.cy.nodes('[isNs]');
            if (!ns.length) return JSON.stringify({ skip: true });
            ns[0].emit('tap');
            return JSON.stringify({ skip: false, node: ns[0].id() });
        })()`));

    if (setup.skip) {
        check('拖动：当前视图没有可展开的命名空间（跳过）', true);
    } else {
        await sleep(1200);

        // 布局动画还在跑的时候点一下卡片，不该被记成一次拖动
        const phantom = JSON.parse(await cdp.eval(`
            (function () {
                var app = window.__codemap;
                app.state.offsets.clear();
                var t = app.cy.nodes('[isType]');
                if (!t.length) return JSON.stringify({ skip: true });
                t[0].emit('grab');
                t[0].emit('free');
                var out = [];
                app.state.offsets.forEach(function (v) {
                    out.push([Math.round(v.dx), Math.round(v.dy)]);
                });
                return JSON.stringify({ skip: false, offsets: out, id: t[0].id() });
            })()`));

        if (phantom.skip) {
            check('动画中点一下不会记出拖动位移（没有类型节点，跳过）', true);
        } else {
            check('动画中点一下不会记出拖动位移', phantom.offsets.length === 0,
                JSON.stringify(phantom.offsets));

            // 往右下一把甩出去：只能贴到容器边上，不能整个跑到外面
            await dragNodeTo(cdp, phantom.id, 900, 500);
            await cdp.eval('window.__codemap.render({ animate: false }); true');
            check('子节点被拖不出父容器', (await insideParent(cdp, phantom.id)) === 'true');

            // 第二次拖动不能把第一次的位移吞掉
            const twice = JSON.parse(await cdp.eval(`
                (function () {
                    var app = window.__codemap;
                    var id = ${JSON.stringify(phantom.id)};
                    var el = app.cy.getElementById(id);
                    var first = app.state.offsets.get(id) || { dx: 0, dy: 0 };
                    var p = el.position();
                    el.emit('grab');
                    el.position({ x: p.x - 30, y: p.y - 20 });
                    el.emit('drag');
                    el.emit('free');
                    var second = app.state.offsets.get(id) || { dx: 0, dy: 0 };
                    return JSON.stringify({
                        first: [Math.round(first.dx), Math.round(first.dy)],
                        second: [Math.round(second.dx), Math.round(second.dy)],
                    });
                })()`));
            check('连着拖两次不会丢掉上一次的位移',
                Math.abs(twice.second[0] - twice.first[0]) > 1 ||
                Math.abs(twice.second[1] - twice.first[1]) > 1,
                `${JSON.stringify(twice.first)} → ${JSON.stringify(twice.second)}`);

            // 拖动途中若有人重排（保存触发的重建、L2 回来），刚重建出来的子节点
            // 也必须继续跟着托盘走 —— 不然松手之后它就落在托盘外面，而且再也回不去
            const churn = JSON.parse(await cdp.eval(`
                (function () {
                    var app = window.__codemap, cy = app.cy;
                    var tray = cy.nodes('[isNs]')[0];
                    var child = cy.nodes('[isType]')[0];
                    if (!tray || !child) return JSON.stringify({ skip: true });
                    var id = child.id();
                    tray.emit('grab');
                    var p0 = tray.position();
                    tray.position({ x: p0.x + 180, y: p0.y + 120 });
                    tray.emit('drag');
                    // 拖动途中刷新一次，而且可见集合变了：这个子节点被移除又重建
                    cy.getElementById(id).remove();
                    app.render({ animate: false });
                    var p1 = tray.position();
                    tray.position({ x: p1.x + 180, y: p1.y + 120 });
                    tray.emit('drag');
                    tray.emit('free');
                    return JSON.stringify({ skip: false, id: id });
                })()`));
            if (!churn.skip) {
                await sleep(1400);
                check('拖动途中重排后，重建出来的子节点仍跟着容器走',
                    (await insideParent(cdp, churn.id)) === 'true');
            }

            // 过期的异步写入（延迟起的出生动画、被打断的补间）会把节点留在旧位置，
            // 后面可能再没有任何渲染来收尾 —— 落地校正要能把它捞回来
            const rescued = JSON.parse(await cdp.eval(`
                (function () {
                    var app = window.__codemap, cy = app.cy;
                    app.render({ animate: false });
                    var t = cy.nodes('[isType]')[0];
                    if (!t) return JSON.stringify({ skip: true });
                    var id = t.id();
                    setTimeout(function () {
                        var el = cy.getElementById(id);
                        if (el.empty()) return;
                        var p = el.position();
                        el.position({ x: p.x + 700, y: p.y + 400 });
                    }, 60);
                    return JSON.stringify({ skip: false, id: id });
                })()`));
            if (!rescued.skip) {
                await sleep(1800);
                check('被写过期位置的节点会被落地校正收回容器内',
                    (await insideParent(cdp, rescued.id)) === 'true');
            }

            await cdp.eval('window.__codemap.resetDragOffsets(); true');
        }
    }

    // —— 重新分析：页面 → 宿主 → 重跑一遍 → 新快照 ——
    await cdp.eval("document.getElementById('reloadBtn').click(); true");
    let bumped = false;
    for (let i = 0; i < 40; i++) {
        if ((await cdp.eval('window.__codemap.state.version')) > before.version) {
            bumped = true;
            break;
        }
        await sleep(500);
    }
    check('「重新分析」会推出新快照', bumped,
        `v${before.version} → v${await cdp.eval('window.__codemap.state.version')}`);
    await sleep(800);

    const after = JSON.parse(await cdp.eval('JSON.stringify(window.__codemap.snapshotSummary())'));
    check('界面操作全程无 JS 错误', after.errors.length === 0, after.errors.slice(0, 2).join(' | '));
    check('重新分析后没有卡在「进行中」', after.busy === false);

    // —— 铺满工作区：顶层是照工作区长宽比铺的，不能挤成一根竖条 ——
    // 宽窗口里挤成竖条 = 两边全是空白、字还小，这是最容易被忽略的一种「布局不对」
    const fill = JSON.parse(await cdp.eval(`
        (function () {
            var app = window.__codemap, cy = app.cy;
            if (app.state.mode !== 'type') document.getElementById('modeBtn').click();
            app.state.expanded.clear();
            app.render({ animate: false });
            var bb = cy.elements().boundingBox();
            var tb = document.getElementById('toolbar').offsetHeight;
            return JSON.stringify({
                bbox: [Math.round(bb.w), Math.round(bb.h)],
                contentAspect: bb.w / bb.h,
                canvasAspect: cy.width() / (cy.height() - tb),
                nodes: cy.nodes().length,
            });
        })()`));
    const fillRatio = fill.contentAspect / fill.canvasAspect;
    check('顶层按工作区长宽比铺开（不是一根竖条）',
        fillRatio > 0.45 && fillRatio < 2.2,
        `${fill.nodes} 个节点：内容 ${fill.contentAspect.toFixed(2)} : 工作区 ` +
        `${fill.canvasAspect.toFixed(2)}（比值 ${fillRatio.toFixed(2)}）`);
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
    await stageFive(cdp, check);
} catch (err) {
    console.error(`\n探针中断：${err.message}`);
    failures++;
}

console.log(`\n结论：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
