// 确认 Be 事件总线宿主 + chat:finish detail 结构
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.type === 'page' && x.url.includes('zchat.z.ai'));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Runtime.enable');
const expr = `(async () => {
  const txt = await (await fetch('https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.114/assets/index-BOuzUNK8.js')).text();
  const out = {};
  // Be 的定义
  let i = txt.indexOf('Be=');
  const defs = [];
  while (i >= 0 && defs.length < 6) { defs.push(txt.slice(Math.max(0, i - 60), i + 120)); i = txt.indexOf('Be=', i + 1); }
  out.BeDefs = defs;
  // 运行时判定
  out.docIsBus = typeof document !== 'undefined';
  return JSON.stringify(out);
})()`;
const rr = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const o = JSON.parse(rr.result?.result?.value || '{}');
(o.BeDefs || []).forEach((d, i) => console.log('--- def', i, '---\n' + d + '\n'));
ws.close();
