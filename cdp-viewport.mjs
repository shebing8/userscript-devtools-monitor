// 设定视口尺寸后报告输入框版本
// 用法: node cdp-viewport.mjs --match <片段> --w 1440 --h 900
const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const match = arg('match');
const w = Number(arg('w', 1440));
const h = Number(arg('h', 900));
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

await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 1500));

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    innerWidth: window.innerWidth,
    think: /深度思考/.test(document.body.innerText),
    model: !!document.querySelector('.modelSelectorButton'),
    globe: !!document.querySelector('svg[viewBox="0 0 15 15"]')
  })`,
  returnByValue: true,
});
console.log(r.result?.result?.value);
ws.close();
