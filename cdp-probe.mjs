// 通过 CDP 打开一个 URL，等 SPA 渲染完，抓截图 + 文本 + 自定义求值
// 用法: node cdp-probe.mjs --url <url> --out <prefix> [--wait 9000] [--eval "<js>"] [--w 1440] [--h 900]

import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const url = arg('url');
const outPrefix = arg('out', 'probe');
const waitMs = Number(arg('wait', 9000));
const evalExpr = arg('eval', '');
const vw = Number(arg('w', 1440));
const vh = Number(arg('h', 900));
const HOST = '127.0.0.1:9222';

if (!url) {
  console.error('missing --url');
  process.exit(2);
}

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
});

await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, waitMs));

const info = await evaluate(`(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  text: (document.body?.innerText || '').slice(0, 4000),
}))()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
}

const extra = evalExpr ? await evaluate(evalExpr) : null;

const report = { url, ...info, extra };
fs.writeFileSync(`${outPrefix}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

ws.close();
