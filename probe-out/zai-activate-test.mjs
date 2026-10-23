// 卡住标签页前台激活实验：不刷新，看排队 delta 是否自己渲染
const chatId = process.argv[2] || 'f5368b08';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.type === 'page' && x.url.includes(chatId));
if (!t) { console.log('no tab'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Runtime.enable');

const EXPR = `(function(){
  try {
    var s = Array.prototype.slice.call(document.querySelectorAll('[class*=markdown]')).map(function(n){return n.innerText}).join('\\n');
    var i = s.lastIndexOf('PACETEST');
    if (i < 0) i = s.lastIndexOf('STUCKDIAG');
    return JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), tail: s.slice(Math.max(0,i), i + 200) });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

const read = async () => {
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  if (r.result?.exceptionDetails) return { exc: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return JSON.parse(r.result?.result?.value || '{}');
};

console.log('BEFORE :', JSON.stringify(await read()));
await fetch('http://127.0.0.1:9222/json/activate/' + t.id);
await new Promise((r) => setTimeout(r, 6000));
console.log('ACTIV8 :', JSON.stringify(await read()));
ws.close();
