// 查询打开的 chat tab 对应会话的持久 type
const HOST = '127.0.0.1:9222';
const list = await (await fetch(`http://${HOST}/json/list`)).json();
for (const d of list.filter((x) => x.type === 'page' && /\/c\//.test(x.url || ''))) {
  const ws = new WebSocket(d.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
  await send('Runtime.enable');
  const cid = (d.url.match(/\/c\/([\w-]+)/) || [])[1];
  const expr = `(async () => {
    const t = localStorage.getItem('token');
    const res = await fetch('/api/v1/chats/${cid}', { headers: { Authorization: 'Bearer ' + (t || '') } });
    const j = await res.json().catch(() => null);
    return { status: res.status, keys: Object.keys(j || {}), raw: JSON.stringify(j).slice(0, 500) };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(cid, JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r));
  ws.close();
}
