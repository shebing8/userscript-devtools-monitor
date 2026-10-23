// 截取指定区域
// 用法: node cdp-clip.mjs --match <片段> --x 590 --y 815 --w 420 --h 60 --out probe-out/clip
import fs from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const match = arg('match');
const x = Number(arg('x', 0));
const y = Number(arg('y', 0));
const w = Number(arg('w', 400));
const h = Number(arg('h', 100));
const out = arg('out', 'clip');
const scale = Number(arg('scale', 2));

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

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale } });
if (shot.result?.data) {
  fs.writeFileSync(`${out}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', `${out}.png`);
} else {
  console.log('failed', JSON.stringify(shot.error || shot));
}
ws.close();
