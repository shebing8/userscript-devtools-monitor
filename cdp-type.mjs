// 聚焦输入框并插入文本（走 CDP Input.insertText，能触发 React 的 onChange）
// 用法: node cdp-type.mjs --match <url片段> --text "hello"
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const match = arg('match');
const text = arg('text');
const HOST = '127.0.0.1:9222';

const list = await (await fetch(`http://${HOST}/json/list`)).json();
const target = list.filter((t) => t.type === 'page').find((t) => t.url.includes(match));
if (!target) { console.error('no page matched'); process.exit(3); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await evaluate(`(() => { const t = document.querySelector('textarea'); t.focus(); return t.value; })()`);
await send('Input.insertText', { text });
await new Promise((r) => setTimeout(r, 600));

const state = await evaluate(`(() => {
  const t = document.querySelector('textarea');
  const btn = document.querySelector('.sendMessageButton');
  const r = btn ? btn.getBoundingClientRect() : null;
  return { value: t.value, sendBtn: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null };
})()`);
console.log(JSON.stringify(state, null, 1));
ws.close();
