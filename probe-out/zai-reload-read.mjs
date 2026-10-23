// 重载指定会话页面并读取测试提问之后的回答
const [chatId, url] = process.argv.slice(2);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.url.includes(chatId) && x.type === 'page');
if (!t) { console.log('tab gone for', chatId); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Page.enable');
await send('Runtime.enable');
if (url) { await send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 13000)); }
const expr = `(function(){
  const txt=[...document.querySelectorAll('[class*=markdown]')].map(n=>n.innerText).join('\\n\\n');
  const i=txt.lastIndexOf('请调用代码沙箱工具');
  return JSON.stringify({len:txt.length, found:i, after: txt.slice(i+28, i+1600)});
})()`;
const rr = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const v = rr.result?.result?.value;
if (v) { const o = JSON.parse(v); console.log('len', o.len, 'found', o.found); console.log(o.after || '(no assistant text after prompt)'); }
else console.log(JSON.stringify(rr.result?.exceptionDetails || rr).slice(0, 600));
ws.close();
