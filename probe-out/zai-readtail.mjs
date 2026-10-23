// 读取指定会话标签页里最近一条回答的尾部
const [chatId] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.url.includes(chatId) && x.type === 'page');
if (!t) { console.log('tab gone for', chatId); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Runtime.enable');
const expr = `(function(){
  const nodes=[...document.querySelectorAll('[class*=markdown]')];
  const txt=nodes.map(n=>n.innerText).join('\\n\\n');
  const i=txt.lastIndexOf('AGENTTOOL_OK');
  return JSON.stringify({
    found:i,
    tail: txt.slice(Math.max(0,i-500), i+1200),
    runChip: /已运行|运行中|执行命令|命令/.test(document.body.innerText),
  });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const v = r.result?.result?.value;
console.log(v ? JSON.stringify(JSON.parse(v), null, 1) : JSON.stringify(r.result?.exceptionDetails || r.result, null, 1));
ws.close();
