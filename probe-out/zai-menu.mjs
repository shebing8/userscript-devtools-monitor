// 点开 composer 控件，枚举菜单项（找思考档位入口）
// 用法: node zai-menu.mjs <url> <outPrefix>

import fs from 'node:fs';

const [url, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';

const DROP_PATCH = `(() => {
  const DROP = new Set(['web_search', 'hidden-thinking']);
  const fix = (h) => { if (!h || !Array.isArray(h.features)) return false; const k = h.features.filter((f) => !(f && DROP.has(f.type))); if (k.length === h.features.length) return false; h.features = k; return true; };
  const patch = (j) => { if (!j || typeof j !== 'object') return false; let c = fix(j) || fix(j.chat); const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null); for (const m of (arr || [])) { const sp = m && m.info && m.info.meta && m.info.meta.suggestion_prompts; if (Array.isArray(sp)) for (const s of sp) if (fix(s)) c = true; } if (Array.isArray(j.data)) for (const it of j.data) { if (fix(it) || fix(it.chat)) c = true; } return c; };
  const nf = window.fetch;
  window.fetch = async function (i, init) { const u = typeof i === 'string' ? i : (i && i.url) || ''; const r = await nf.apply(this, arguments); if (!/\\/api\\/(models|config)$|\\/api\\/v\\d+\\/chats\\b/.test(u)) return r; try { const j = await r.clone().json(); if (!patch(j)) return r; const h = new Headers(r.headers); h.delete('content-length'); h.delete('content-encoding'); return new Response(JSON.stringify(j), { status: r.status, statusText: r.statusText, headers: h }); } catch (e) { return r; } };
})()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.text) }; return r.result?.result?.value; };

await send('Page.addScriptToEvaluateOnNewDocument', { source: DROP_PATCH });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 12000));

const results = {};

const clickByIndex = async (idx) => {
  await ev(`(() => { const ta=document.querySelector('textarea'); let box=ta; for(let i=0;i<12&&box.parentElement;i++){box=box.parentElement; if(box.querySelector('.sendMessageButton')) break;} const b=box.querySelectorAll('button')[${idx}]; b.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 1800));
  return ev(`(() => {
    const pops = [...document.querySelectorAll('[role=menu],[role=listbox],[data-state=open],[role=dialog]')];
    return pops.map((p) => ({
      role: p.getAttribute('role'),
      text: p.innerText.replace(/\\s+/g, ' ').slice(0, 500),
      items: [...p.querySelectorAll('[role=menuitem],[role=option],button,label,li')].map((x) => (x.innerText || x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 40),
    }));
  })()`);
};

const n = await ev(`(() => { const ta=document.querySelector('textarea'); let box=ta; for(let i=0;i<12&&box.parentElement;i++){box=box.parentElement; if(box.querySelector('.sendMessageButton')) break;} return box.querySelectorAll('button').length; })()`);

for (let i = 0; i < n; i++) {
  results[`btn${i}`] = await clickByIndex(i);
  await ev(`document.body.click(); return 1;`).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
fs.writeFileSync(`${outPrefix}.menu.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
ws.close();
