/*
 * 文件监听 → 重建 → 增量推送 这条链路的端到端验证。
 *
 * 做法：在项目根目录造一个临时 .cs 文件（触发 Created），等页面版本号推进且节点数变多；
 *      再删掉它（触发 Deleted），等页面回到原来的节点数。全程核对没有 JS 错误。
 *      用临时文件而不是改现有文件，是因为它在任何一步失败都不会留下半改的源码。
 *
 * 用法：node tools/webprobe/watch.js [port] [projectRoot] [timeoutMs]
 */

import fs from 'node:fs';
import path from 'node:path';
import { sleep, connectToApp } from './cdp.js';

const port = Number(process.argv[2] || process.env.CDP_PORT || 9222);
const projectRoot = process.argv[3] || process.cwd();
const timeoutMs = Number(process.argv[4] || 40000);

const probeFile = path.join(projectRoot, '__matu_probe_tmp.cs');
const probeSource = `namespace 码图探针
{
    // 由 tools/webprobe/watch.js 临时写入，测试完会删掉
    public sealed class 临时标记类型
    {
        public void Ping()
        {
        }
    }
}
`;

const { page, cdp } = await connectToApp(port);
console.log(`已连接 ${page.url}`);
console.log(`监听目录 ${projectRoot}`);

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

async function readState() {
    const raw = await cdp.eval(`
        (function () {
            var st = window.__codemap && window.__codemap.state;
            if (!st || !st.stats) return '';
            var s = st.stats;
            return JSON.stringify({
                version: s.version, files: s.fileCount, elapsedMs: s.elapsedMs,
                nodes: s.nodes, drawn: (window.__codemap.state.drawn || {}).nodes,
                errors: window.__errors || [],
                hint: document.getElementById('hint').textContent,
                stats: document.getElementById('stats').textContent,
            });
        })()`);
    return raw ? JSON.parse(raw) : null;
}

async function waitFor(predicate, label) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await readState();
        if (last && predicate(last)) return last;
        await sleep(300);
    }
    console.log(`  （等待超时，最后一次状态：${JSON.stringify(last)}）`);
    return last;
}

// —— 基线 ——
const base = await waitFor(s => s.nodes > 0 && s.errors.length === 0, 'baseline');
if (!base) { console.log('  [FAIL] 拿不到基线状态'); process.exit(1); }
console.log(`\n基线：v${base.version} · ${base.files} 文件 · ${base.nodes} 节点 · ${base.elapsedMs} ms`);

let created = null;
try {
    // —— 新增文件 ——
    fs.writeFileSync(probeFile, probeSource, 'utf8');
    console.log('\n== 新增一个 .cs 文件 ==');

    created = await waitFor(s => s.version > base.version && s.nodes > base.nodes, 'created');
    check('版本号推进', !!created && created.version > base.version,
        created ? `v${base.version} → v${created.version}` : '');
    check('文件数 +1', !!created && created.files === base.files + 1,
        created ? `${base.files} → ${created.files}` : '');
    check('节点数变多', !!created && created.nodes > base.nodes,
        created ? `${base.nodes} → ${created.nodes}` : '');
    check('重建耗时是增量级', !!created && created.elapsedMs < 3000,
        created ? `${created.elapsedMs} ms` : '');
    check('新增过程无 JS 错误', !!created && created.errors.length === 0,
        created ? created.errors.slice(0, 2).join(' | ') : '');
}
finally {
    // —— 删除文件 ——
    try { fs.unlinkSync(probeFile); } catch { /* 没写成功就没什么可删 */ }
}

if (created) {
    console.log('\n== 删掉这个文件 ==');
    const removed = await waitFor(s => s.version > created.version && s.nodes === base.nodes, 'removed');
    check('版本号再次推进', !!removed && removed.version > created.version,
        removed ? `v${created.version} → v${removed.version}` : '');
    check('节点数回到基线', !!removed && removed.nodes === base.nodes,
        removed ? `${removed.nodes} vs ${base.nodes}` : '');
    check('删除过程无 JS 错误', !!removed && removed.errors.length === 0,
        removed ? removed.errors.slice(0, 2).join(' | ') : '');
    if (removed) console.log(`  状态栏：${removed.stats}`);
}

check('临时文件已清理', !fs.existsSync(probeFile));

console.log(`\n结论：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
