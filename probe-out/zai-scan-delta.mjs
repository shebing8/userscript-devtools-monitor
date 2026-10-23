// 扫描站点已加载 JS chunk，找 delta_content / phase 状态机的位置
const chatId = process.argv[2] || 'f5368b08';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.url.includes(chatId) && x.type === 'page');
if (!t) { console.log('no tab'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Runtime.enable');

const expr = `(async () => {
  const res = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.indexOf('.js') >= 0);
  const hits = [];
  for (const u of res) {
    try {
      const txt = await (await fetch(u)).text();
      let i = txt.indexOf('delta_content');
      if (i < 0) continue;
      const ctx = [];
      while (i >= 0 && ctx.length < 3) { ctx.push(txt.slice(Math.max(0, i - 400), i + 400)); i = txt.indexOf('delta_content', i + 1); }
      hits.push({ url: u, len: txt.length, ctx });
    } catch (e) {}
  }
  return JSON.stringify({ total: res.length, hitCount: hits.length, hits: hits.slice(0, 3) });
})()`;

const rr = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const v = rr.result?.result?.value;
if (v) {
  const o = JSON.parse(v);
  console.log('resources:', o.total, 'chunks with delta_content:', o.hitCount);
  let n = 0;
  for (const h of o.hits) {
    console.log('\n===== CHUNK', ++n, h.url, 'len', h.len);
    h.ctx.forEach((c, i) => console.log('\n--- ctx' + i + ' ---\n' + c));
  }
  const fs = await import('node:fs');
  fs.writeFileSync('probe-out/delta-content-hits.txt', JSON.stringify(o, null, 1));
} else {
  console.log(JSON.stringify(rr.result?.exceptionDetails || rr).slice(0, 500));
}
ws.close();
