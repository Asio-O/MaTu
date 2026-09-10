/*
 * 在页面里求值一段 JS 并打印结果。
 *
 *   node tools/webprobe/eval.js <port> "<表达式>"
 *   node tools/webprobe/eval.js <port> --file <脚本路径> [截图输出路径]
 *
 * 给了截图路径就在求值之后再抓一张页面截图，便于「改一个样式 → 看效果」。
 */

import fs from 'node:fs';
import { connectToApp } from './cdp.js';

const port = Number(process.argv[2] || 9222);
const useFile = process.argv[3] === '--file';
const expression = useFile
    ? fs.readFileSync(process.argv[4], 'utf8')
    : process.argv.slice(3).join(' ');

if (!expression) {
    console.error('用法：node eval.js <port> "<表达式>" | --file <路径>');
    process.exit(2);
}

const shotPath = useFile ? process.argv[5] : null;

const { cdp } = await connectToApp(port);
const result = await cdp.eval(`(function(){ return (${expression}); })()`);

if (typeof result === 'string') console.log(result);
else console.log(JSON.stringify(result, null, 2));

if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`截图已写入 ${shotPath}`);
}

process.exit(0);
