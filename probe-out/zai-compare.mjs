// 对比两个 zchat 会话：抓 /api/ 响应体 + composer 控件树
// 用法: node zai-compare.mjs <url> <outPrefix>

import fs from 'node:fs';

const [url, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
const seen = new Map();
const responses = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    if (/\/api\//.test(r.url)) seen.set(msg.params.requestId, { url: r.url, status: r.status });
  }
  if (msg.method === 'Network.loadingFinished') {
    const meta = seen.get(msg.params.requestId);
    if (!meta) return;
    send('Network.getResponseBody', { requestId: msg.params.requestId })
      .then((res) => {
        let text = res.result?.body || '';
        if (res.result?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        responses.push({ ...meta, body: text });
      })
      .catch(() => responses.push({ ...meta, body: null }));
  }
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 11000));

const composer = await evaluate(`
(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  let box = ta;
  for (let i = 0; i < 12 && box.parentElement; i++) {
    box = box.parentElement;
    if (box.querySelector('.sendMessageButton')) break;
  }
  const buttons = [...box.querySelectorAll('button')].map((b, i) => {
    const p = b.querySelector('svg path');
    return {
      i,
      id: b.id || null,
      label: b.getAttribute('aria-label'),
      text: (b.innerText || '').trim().slice(0, 24),
      glyph: p ? p.getAttribute('d').slice(0, 64) : null,
      disabled: b.disabled,
    };
  });
  return {
    href: location.href,
    buttons,
    composerText: box.innerText.replace(/\\s+/g, ' ').slice(0, 300),
    thinkingNodes: document.querySelectorAll('[class*="thinking"],[id*="thinking"],[class*="reasoning"]').length,
    hasDeepThinkText: /深度思考|思考强度/.test(box.innerText),
    hasWebSearchText: /联网|网络搜索|Web Search/i.test(box.innerText),
  };
})()
`);

const stored = await evaluate(`(() => {
  const keys = Object.keys(localStorage).filter((k) => /chat|model|feature|prefer|setting|search|think|flag|exp|agent/i.test(k));
  return keys.slice(0, 40).map((k) => ({ k, v: (localStorage.getItem(k) || '').slice(0, 240) }));
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));

const summary = {
  url,
  composer,
  stored,
  api: responses.map((r) => ({ url: r.url, status: r.status, len: r.body ? r.body.length : 0 })),
};
fs.writeFileSync(`${outPrefix}.summary.json`, JSON.stringify(summary, null, 2));
fs.writeFileSync(`${outPrefix}.full.json`, JSON.stringify({ ...summary, bodies: responses }, null, 2));
console.log(JSON.stringify(summary, null, 2));

ws.close();
