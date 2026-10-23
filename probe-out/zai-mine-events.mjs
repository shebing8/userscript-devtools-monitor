// 挖站点 bundle 里的 chat 状态事件与渲染挂载点
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const t = list.find((x) => x.type === 'page' && x.url.includes('zchat.z.ai'));
if (!t) { console.log('no tab'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
await send('Runtime.enable');

const expr = `(async () => {
  const txt = await (await fetch('https://z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.114/assets/index-BOuzUNK8.js')).text();
  function findAll(pat, radius, max) {
    const out = []; let i = -1;
    while ((i = txt.indexOf(pat, i + 1)) >= 0 && out.length < max) out.push(txt.slice(Math.max(0, i - radius), i + radius));
    return out;
  }
  return JSON.stringify({
    chatEvents: [...new Set((txt.match(/CustomEvent\\(\\s*"chat:[^"]+"/g) || []))],
    addListeners: [...new Set((txt.match(/addEventListener\\(\\s*"chat:[^"]+"/g) || []))],
    startCtx: findAll('CustomEvent("chat:start"', 250, 2),
    finishCtx: findAll('chat:finish', 350, 2),
    endCtx: findAll('chat:end', 350, 2),
    doneCtx: findAll('"chat:done"', 350, 2),
    replyingCtx: findAll('setChatReplying', 250, 3),
  });
})()`;

const rr = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const v = rr.result?.result?.value;
if (v) {
  const fs = await import('node:fs');
  fs.writeFileSync('chat-events.txt', JSON.stringify(JSON.parse(v), null, 1));
  const o = JSON.parse(v);
  console.log('events dispatched:', o.chatEvents);
  console.log('listeners:', o.addListeners);
} else console.log(JSON.stringify(rr.result?.exceptionDetails || rr).slice(0, 400));
ws.close();
