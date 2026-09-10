/*
 * 独立分析器进程的冒烟测试：直接给 `码图.exe --analyzer` 喂 JSON 行，不启动界面。
 *
 * 用法：node tools/webprobe/analyzer-smoke.js <码图.exe 路径> <项目根目录>
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const exe = process.argv[2];
const root = process.argv[3];
if (!exe || !root) {
    console.error('用法：node analyzer-smoke.js <码图.exe> <项目根>');
    process.exit(2);
}

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

const child = spawn(exe, ['--analyzer'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
});

const responses = new Map();
const waits = new Map();
let stderrTail = '';

createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { console.log(`  （非协议输出）${line.slice(0, 160)}`); return; }
    const waiter = waits.get(msg.id);
    if (waiter) { waits.delete(msg.id); waiter(msg); }
    else responses.set(msg.id, msg);
});

child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

function send(id, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`请求 ${payload.cmd} 超时`)), 120000);
        waits.set(id, msg => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
}

try {
    // 子进程启动时会先发一行 hello
    const hello = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('分析器进程没有握手')), 30000);
        const iv = setInterval(() => {
            if (responses.has(0)) { clearInterval(iv); clearTimeout(timer); resolve(responses.get(0)); }
        }, 100);
    });
    check('分析器进程完成握手', hello.kind === 'hello', JSON.stringify(hello.kind));

    const analyze = await send(1, { cmd: 'analyze', projectId: 'smoke', root });
    check('analyze 返回成功', analyze.ok === true, analyze.error || '');
    const snap = analyze.snapshot || {};
    console.log(`  节点 ${snap.nodes?.length} · 边 ${snap.edges?.length} · 文件 ${snap.fileCount} · ` +
        `${analyze.stats?.elapsedMs} ms · 缓存命中 ${analyze.stats?.cachedFiles}`);
    check('快照有节点', (snap.nodes?.length || 0) > 0);
    check('快照自洽：边两端都存在', (() => {
        const ids = new Set((snap.nodes || []).map(n => n.id));
        return (snap.edges || []).every(e => ids.has(e.source) && ids.has(e.target));
    })());
    check('统计信息一起回来了', !!analyze.stats && analyze.stats.references > 0,
        analyze.stats ? `${analyze.stats.references} 个引用` : '');

    const busiest = (snap.nodes || [])
        .filter(n => n.kind !== 'namespace' && n.kind !== 'method')
        .sort((a, b) => (b.methods?.length || 0) - (a.methods?.length || 0))[0];
    check('找到了要精确解析的类型', !!busiest, busiest?.fqn);

    if (busiest) {
        const resolved = await send(2, { cmd: 'resolve', typeId: busiest.id, fqn: busiest.fqn });
        check('resolve 返回成功', resolved.ok === true, resolved.error || '');
        const r = resolved.resolution || {};
        console.log(`  L2 ${r.typeFqn} → precise=${r.precise} calls=${r.calls?.length} ` +
            `typeCalls=${r.typeCalls?.length} unresolved=${r.unresolvedInvocations}`);
        check('L2 判定为精确', r.precise === true, r.reason || '');
        check('L2 返回了方法级调用边', (r.calls?.length || 0) > 0);
    }

    const bye = await send(3, { cmd: 'shutdown' });
    check('shutdown 得到确认', bye.kind === 'bye');
} catch (err) {
    console.log(`  [FAIL] ${err.message}`);
    failures++;
    if (stderrTail) console.log(`  子进程 stderr：\n${stderrTail}`);
}

const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 10000);
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
});
check('分析器进程正常退出', exitCode === 0, `exit=${exitCode}`);

console.log(`\n结论：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
