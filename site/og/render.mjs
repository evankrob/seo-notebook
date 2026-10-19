// Renders og/card.html to public/og.png (1200×630) with headless Chrome over the DevTools protocol.
// Usage (from site/): node og/render.mjs   Set CHROME to the browser binary if it isn't the macOS default.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9334;
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'og-')), '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
    let targets;
    for (let i = 0; i < 40 && !targets; i++) {
        await wait(250);
        targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => null);
    }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', e => {
        const m = JSON.parse(e.data);
        if (pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        }
    });
    const send = (method, params = {}) => new Promise((ok, fail) => {
        const i = ++id;
        pending.set(i, m => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.navigate', { url: pathToFileURL(resolve('og/card.html')).href });
    await wait(1200);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('public/og.png', Buffer.from(data, 'base64'));
    console.log('Wrote public/og.png');
    ws.close();
}
finally {
    chrome.kill();
}
