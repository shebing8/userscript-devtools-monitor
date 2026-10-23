// 给当前焦点元素发按键（用于滑块等 React 控件）
// 用法: node cdp-key.mjs --match <片段> --key ArrowLeft --times 2
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const match = arg('match');
const key = arg('key', 'ArrowLeft');
const times = Number(arg('times', 1));
const HOST = '127.0.0.1:9222';

const CODES = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 };

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

for (let i = 0; i < times; i++) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: key, windowsVirtualKeyCode: CODES[key] || 0, nativeVirtualKeyCode: CODES[key] || 0,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: key, windowsVirtualKeyCode: CODES[key] || 0, nativeVirtualKeyCode: CODES[key] || 0,
  });
  await new Promise((r) => setTimeout(r, 200));
}

console.log(`sent ${key} x${times}`);
ws.close();
