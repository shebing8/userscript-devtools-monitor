// 附着标签页 → 注入 document-start 脚本 → reload → 等渲染 → 截图 + 输出按钮清单
// 用法: node cdp-inject.mjs --match <url片段> --file <注入脚本> --out <prefix> [--wait 9000]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const match = arg('match');
const file = arg('file');
const out = arg('out', 'inject');
const waitMs = Number(arg('wait', 9000));
const HOST = '127.0.0.1:9222';

const list = await (await fetch(`http://${HOST}/json/list`)).json();
const target = list.filter((t) => t.type === 'page').find((t) => t.url.includes(match));
if (!target) { console.error('no page matched:', match); process.exit(3); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

const src = fs.readFileSync(file, 'utf8');
const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
const scriptId = added.result?.identifier;

await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, waitMs));

const dump = await evaluate(`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const eds = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(vis);
  if (!eds.length) return { error: 'no editable' };
  const ta = eds[eds.length - 1];
  let root = ta;
  for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
  return {
    url: location.href,
    hookAlive: !!window.__ZAI_RESTORE_HOOK__,
    btns: [...root.querySelectorAll('button')].map((b) => ({
      text: (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      aria: b.getAttribute('aria-label'),
      vis: vis(b),
    })),
    rootText: (root.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
  };
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${out}.png`, Buffer.from(shot.result.data, 'base64'));

if (scriptId && !argv.includes('--keep')) {
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
}

console.log(JSON.stringify(dump, null, 1));
ws.close();
