// 在标签页上按坐标真实点击，并输出点击后页面文本尾部 + 截图
// 用法: node cdp-click.mjs --match <url片段> --x 910 --y 855 --out probe-out/shot [--eval "<js>"]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const match = arg('match');
const x = Number(arg('x'));
const y = Number(arg('y'));
const out = arg('out', 'click');
const expr = arg('eval');
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

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
await new Promise((r) => setTimeout(r, 1500));

if (expr) console.log(JSON.stringify(await evaluate(expr), null, 1));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${out}.png`, Buffer.from(shot.result.data, 'base64'));

ws.close();
