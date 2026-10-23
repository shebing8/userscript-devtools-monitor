// 打开模型选择器，dump 菜单完整结构（含思考强度行的可交互状态）
// 用法: node zai-effort.mjs <url> <outPrefix>

import fs from 'node:fs';

const [url, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 11000));

const out = await evl(`(async () => {
  const ta = document.querySelector('textarea');
  let box = ta;
  for (let i = 0; i < 12 && box.parentElement; i++) { box = box.parentElement; if (box.querySelector('.sendMessageButton')) break; }
  const btns = [...box.querySelectorAll('button')];
  const ms = btns.find((x) => x.classList.contains('modelSelectorButton'));
  if (!ms) return { error: 'no model selector' };
  ms.click();
  await new Promise((r) => setTimeout(r, 1800));
  const menu = [...document.querySelectorAll('[role=menu]')].find((p) => /GLM/.test(p.innerText));
  if (!menu) return { error: 'no menu', btnCount: btns.length };

  const rows = [...menu.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=separator],div')].slice(0, 0);
  const items = [...menu.querySelectorAll('[role=menuitem], [role=menuitemradio]')].map((x) => ({
    text: (x.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    disabled: x.getAttribute('aria-disabled') || x.disabled || null,
    state: x.dataset.state || null,
    cls: x.className.toString().slice(0, 90),
  }));

  const effortRow = [...menu.querySelectorAll('*')].filter((x) => x.children.length <= 8 && /\\u601d\\u8003\\u5f3a\\u5ea6|\\u63a8\\u7406|effort/i.test(x.textContent || '') && x.textContent.length < 120).map((x) => ({
    tag: x.tagName,
    text: (x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    cls: x.className.toString().slice(0, 120),
    dis: x.getAttribute('aria-disabled') || x.disabled || x.getAttribute('aria-hidden') || null,
    pe: getComputedStyle(x).pointerEvents,
    op: getComputedStyle(x).opacity,
  }));

  return {
    btnCount: btns.length,
    menuText: menu.innerText.replace(/\\s+/g, ' ').slice(0, 400),
    items,
    effortNodes: effortRow.slice(0, 12),
    menuHtml: menu.outerHTML.slice(0, 9000),
  };
})()`);

fs.writeFileSync(`${outPrefix}.effort.json`, JSON.stringify({ url, ...out }, null, 2));
console.log(JSON.stringify({ url, btnCount: out.btnCount, menuText: out.menuText, items: out.items, effortNodes: out.effortNodes, error: out.error }, null, 2));
ws.close();
