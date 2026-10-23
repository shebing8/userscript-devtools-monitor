// 从站点 chunk 里提取 vO 类（chatCompletionsQueue）完整代码及调用点
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
  const url = 'https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.114/assets/index-BOuzUNK8.js';
  const txt = await (await fetch(url)).text();
  const out = {};
  const i = txt.indexOf('class vO');
  out.classStart = i;
  out.classFull = txt.slice(i, i + 6000);
  const j = txt.lastIndexOf('cancelIdleCallback', i);
  out.scheduler = txt.slice(Math.max(0, j - 1200), j + 400);
  // 找 vO 的引用点
  const uses = [];
  let k = -1;
  while ((k = txt.indexOf('new vO', k + 1)) >= 0 && uses.length < 5) uses.push(txt.slice(Math.max(0, k - 500), k + 500));
  out.uses = uses;
  return JSON.stringify(out);
})()`;

const rr = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const v = rr.result?.result?.value;
if (!v) { console.log(JSON.stringify(rr.result?.exceptionDetails || rr).slice(0, 400)); process.exit(0); }
const o = JSON.parse(v);
const fs = await import('node:fs');
fs.writeFileSync('delta-vo.txt', JSON.stringify(o, null, 1));
console.log('class at', o.classStart, '| scheduler len', o.scheduler.length, '| uses', o.uses.length);
console.log('\n===== SCHEDULER (before class) =====\n' + o.scheduler);
console.log('\n===== CLASS vO (first 3000) =====\n' + o.classFull.slice(0, 3000));
ws.close();
