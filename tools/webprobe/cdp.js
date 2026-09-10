/*
 * 共用的 WebView2 CDP 客户端。
 * probe.js（一次性自检）与 watch.js（监听热更新）都建立在它上面。
 */

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function findPage(port, urlPattern = /app\.local/, timeoutMs = 45000) {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    let lastErr = 'unknown';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${base}/json/list`);
            const list = await res.json();
            const page = list.find(t => t.type === 'page' && urlPattern.test(t.url || ''));
            if (page && page.webSocketDebuggerUrl) return page;
            lastErr = `目标列表里没有匹配 ${urlPattern} 的页面（共 ${list.length} 个目标）`;
        } catch (e) {
            lastErr = e.message;
        }
        await sleep(500);
    }
    throw new Error(`等待 WebView2 调试端口超时：${lastErr}`);
}

export class CDP {
    constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }

    static async connect(url) {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
        });
        const cdp = new CDP(ws);
        ws.addEventListener('message', ev => {
            const msg = JSON.parse(ev.data);
            const slot = cdp.pending.get(msg.id);
            if (!slot) return;
            cdp.pending.delete(msg.id);
            if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
            else slot.resolve(msg.result);
        });
        return cdp;
    }

    send(method, params) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description
                || r.exceptionDetails.text || '页面内 JS 抛错');
        }
        return r.result.value;
    }

    /** 反复求值直到结果非空或超时。 */
    async waitFor(expression, { timeoutMs = 30000, intervalMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            last = await this.eval(expression);
            if (last) return last;
            await sleep(intervalMs);
        }
        return last;
    }
}

export async function connectToApp(port) {
    const page = await findPage(port);
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    return { page, cdp };
}
