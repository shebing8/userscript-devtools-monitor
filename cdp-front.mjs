// 把标签页切到前台再截图
import fs from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const match = arg('match');
const out = arg('out', 'front');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.filter((t) => t.type === 'page').find((t) => t.url.includes(match));
if (!target) { console.error('no page'); process.exit(3); }

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

await send('Page.bringToFront');
await new Promise((r) => setTimeout(r, 1200));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(`${out}.png`, Buffer.from(shot.result.data, 'base64'));
console.log('saved', `${out}.png`);
ws.close();
