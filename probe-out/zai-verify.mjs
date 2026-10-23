// 注入 userscript 全文，验证 composer 控件 + 捕获outFrames completions 请求体
// 用法: node zai-verify.mjs <url> <scriptFile> <outPrefix> [--send "文本"]

import fs from 'node:fs';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const [url, scriptFile, outPrefix] = pos;
const sendText = opt('send');
const HOST = '127.0.0.1:9222';
const SOURCE = fs.readFileSync(scriptFile, 'utf8');

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const outFrames = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.webSocketFrameSent') {
    outFrames.push({ kind: 'ws', payload: (m.params.response?.payloadData || '').slice(0, 4000) });
  }
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
const hooked = await send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 12000));

const ui = await evl(`(() => {
  const ta = document.querySelector('textarea');
  let box = ta;
  for (let i = 0; i < 12 && box && box.parentElement; i++) { box = box.parentElement; if (box.querySelector('.sendMessageButton')) break; }
  const chips = [...document.querySelectorAll('[data-zai-chip]')].map((c) => ({
    kind: c.dataset.zaiChip, text: (c.innerText || '').trim(), active: c.dataset.active,
  }));
  const btns = [...(box || document).querySelectorAll('button')];
  const globe = btns.find((b) => !b.id && !b.getAttribute('aria-label') && /1\\.33333 8H14\\.6667/.test((b.querySelector('svg path') || {}).getAttribute ? b.querySelector('svg path').getAttribute('d') : ''));
  return {
    stats: window.__ZAI_CLASSIC_COMPOSER__ || null,
    state: window.__ZAI_CLASSIC_STATE__ || null,
    chips,
    nativeGlobe: globe ? { found: true, active: globe.getAttribute('data-active') } : { found: false },
    composerBtnCount: box ? box.querySelectorAll('button').length : 0,
    composerText: box ? box.innerText.replace(/\\s+/g, ' ').slice(0, 200) : null,
  };
})()`);

// 点一次思考 chip，确认档位循环 + localStorage
const cycle = await evl(`(() => {
  const c = document.querySelector('[data-zai-chip="think"]');
  if (!c) return { error: 'no think chip' };
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push((c.innerText || '').trim()); c.click(); }
  return { seen, stored: localStorage.getItem('zai_classic_level') };
})()`);

// 点联网 chip / 原生键
const web = await evl(`(() => {
  const c = document.querySelector('[data-zai-chip="web"]');
  if (c) { c.click(); return { via: 'chip', active: c.dataset.active, stored: localStorage.getItem('zai_classic_web') }; }
  return { via: 'none' };
})()`);

let sent = null;
if (sendText) {
  sent = await evl(`(async () => {
    const ta = document.querySelector('textarea');
    if (!ta) return { error: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(sendText)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const btn = document.querySelector('.sendMessageButton');
    if (!btn) return { error: 'no send button' };
    if (btn.disabled) return { error: 'send disabled', value: ta.value };
    btn.click();
    return { clicked: true };
  })()`);
  await new Promise((r) => setTimeout(r, 9000));
}

const last = await evl(`window.__ZAI_LAST_BODY__ || null`);

const slider = await evl(`(async () => {
  const ms = document.querySelector('.modelSelectorButton');
  if (!ms) return { error: 'no model selector' };
  ms.click();
  await new Promise((r) => setTimeout(r, 1800));
  const menu = [...document.querySelectorAll('[role=menu]')].find((p) => /GLM/.test(p.innerText));
  if (!menu) return { error: 'no menu' };
  const s = menu.querySelector('[role=slider]');
  return {
    text: menu.innerText.replace(/\\s+/g, ' ').slice(0, 120),
    valueNow: s ? s.getAttribute('aria-valuenow') : null,
    valueText: s ? s.getAttribute('aria-valuetext') : null,
    disabled: s ? s.getAttribute('aria-disabled') : null,
  };
})()`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));

await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hooked.identifier });

const report = { url, ui, cycle, web, sent, lastBody: last, slider, wsFrames: outFrames.slice(0, 5) };
fs.writeFileSync(`${outPrefix}.verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
