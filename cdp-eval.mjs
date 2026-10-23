// 附着到已打开的标签页执行 JS
// 用法: node cdp-eval.mjs --match <url 片段> --eval "<js>"  或  --file <js 文件>
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const match = arg('match');
const file = arg('file');
const expr = file ? fs.readFileSync(file, 'utf8') : arg('eval');
const HOST = '127.0.0.1:9222';

const list = await (await fetch(`http://${HOST}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page');
const target = match ? pages.find((t) => t.url.includes(match)) : pages[0];
if (!target) {
  console.error('no page matched:', match, '\navailable:\n' + pages.map((p) => p.url).join('\n'));
  process.exit(3);
}

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

const r = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});

const out = r.result?.exceptionDetails
  ? { exception: r.result.exceptionDetails.text, detail: r.result.exceptionDetails.exception?.description }
  : r.result?.result?.value;

console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
ws.close();
