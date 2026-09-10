/*
 * 复现并抓取页面快照，用于排查渲染问题。
 *
 *   node tools/webprobe/shot.js <port> <输出png> [步骤]
 *
 * 步骤（逗号分隔，按顺序执行）：
 *   ns:<序号>      点击第 N 个命名空间
 *   type:<序号>    点击第 N 个类型（按方法数降序）
 *   expandall      展开一层
 *   hover:<序号>   把第 N 个类型置为 hover 态（模拟不了真实鼠标，只做样式查询）
 *
 * 除截图外，还会把每个节点的渲染信息（位置、尺寸、背景色、overlay、选中态、
 * HTML 卡片元素的包围盒）打到 stdout。
 */

import fs from 'node:fs';
import { sleep, connectToApp } from './cdp.js';

const port = Number(process.argv[2] || 9222);
const outPath = process.argv[3] || 'shot.png';
const steps = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean);

const { page, cdp } = await connectToApp(port);
console.log(`已连接 ${page.url}`);

for (let i = 0; i < 60; i++) {
    const n = await cdp.eval('window.__codemap ? window.__codemap.state.nodes.length : -1');
    if (n > 0) break;
    await sleep(500);
}
await sleep(1000);

for (const step of steps) {
    const [op, arg] = step.split(':');
    if (op === 'ns') {
        await cdp.eval(`
            (function () {
                var ns = window.__codemap.cy.nodes('[isNs]');
                if (ns[${Number(arg) || 0}]) ns[${Number(arg) || 0}].emit('tap');
                return true;
            })()`);
        await sleep(1200);
        console.log(`已点击命名空间 #${arg || 0}`);
    } else if (op === 'type') {
        await cdp.eval(`
            (function () {
                var t = window.__codemap.cy.nodes('[isType]').sort(function (a, b) {
                    return (b.data('methods') || []).length - (a.data('methods') || []).length;
                });
                if (t[${Number(arg) || 0}]) t[${Number(arg) || 0}].emit('tap');
                return true;
            })()`);
        await sleep(1800);
        console.log(`已点击类型 #${arg || 0}`);
    } else if (op === 'expandall') {
        await cdp.eval('document.getElementById("expandBtn").click(); true');
        await sleep(2000);
        console.log('已展开一层');
    }
}

// —— 渲染诊断 ——
const diag = await cdp.eval(`
    (function () {
        var c = window.__codemap.cy;
        var out = [];
        c.nodes().forEach(function (n) {
            var d = n.data();
            var bb = n.boundingBox();
            out.push({
                id: n.id(),
                label: String(d.label),
                kind: d.kind,
                isNs: !!d.isNs,
                isType: !!d.isType,
                isMethod: !!d.isMethod,
                selected: n.selected(),
                active: n.active(),
                bg: n.pstyle('background-color').strValue,
                bgOpacity: n.pstyle('background-opacity').value,
                overlay: n.pstyle('overlay-opacity').value,
                underlay: n.pstyle('underlay-opacity').value,
                blacken: n.pstyle('background-blacken').value,
                borderStyle: n.pstyle('border-style').strValue,
                borderColor: n.pstyle('border-color').strValue,
                borderWidth: n.pstyle('border-width').value,
                w: n.pstyle('width').value,
                h: n.pstyle('height').value,
                bb: { x1: Math.round(bb.x1), y1: Math.round(bb.y1), w: Math.round(bb.w), h: Math.round(bb.h) },
            });
        });
        // HTML 卡片所在的层
        var labels = [];
        document.querySelectorAll('.mermaid-card').forEach(function (el) {
            var r = el.getBoundingClientRect();
            var cs = getComputedStyle(el);
            labels.push({
                text: (el.querySelector('.mermaid-header') || {}).textContent || '',
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                bg: cs.backgroundColor,
                border: cs.borderTopColor + ' ' + cs.borderTopStyle,
                parentBg: el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : null,
                parentClass: el.parentElement ? el.parentElement.className : null,
            });
        });
        return JSON.stringify({
            nodes: out.sort(function (a, b) { return b.overlay - a.overlay; }),
            labels: labels,
        });
    })()`);

const info = JSON.parse(diag);

console.log('\n== 节点渲染属性（按 overlay 降序）==');
for (const n of info.nodes) {
    const flag = (n.overlay > 0 || n.underlay > 0 || n.blacken !== 0 || n.bg !== 'transparent') ? '  <== 可疑' : '';
    console.log(`  ${String(n.label).padEnd(24, ' ')} kind=${String(n.kind).padEnd(9)} ` +
        `bg=${n.bg}/a${n.bgOpacity} overlay=${n.overlay} underlay=${n.underlay} blacken=${n.blacken} ` +
        `border=${n.borderColor} ${n.borderStyle} ${n.borderWidth} ` +
        `sel=${n.selected} act=${n.active} bb=${JSON.stringify(n.bb)}${flag}`);
}

console.log('\n== HTML 卡片 ==');
for (const l of info.labels) {
    console.log(`  ${String(l.text).padEnd(24, ' ')} rect=${JSON.stringify(l.rect)} ` +
        `bg=${l.bg} border=${l.border} parentBg=${l.parentBg} parent=${l.parentClass}`);
}

// —— 截图 ——
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log(`\n截图已写入 ${outPath}`);

process.exit(0);
