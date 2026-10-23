// 开一个全新标签页（不注入任何脚本），检查模型菜单里是否有「思考强度」
const HOST = '127.0.0.1:9222';
const URL = 'https://zchat.z.ai/c/1259d0ff-d2b9-4e26-aba0-1bf455bce32d';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
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
const ev = async (ex) => {
  const r = await send('Runtime.evaluate', { expression: ex, returnByValue: true, awaitPromise: true, userGesture: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.text;
};

await send('Page.enable');
await send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 13000));

console.log('hook present:', await ev('!!window.__ZAI_CLASSIC_COMPOSER__'));

const pos = JSON.parse(await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /GLM-5\\.3/.test(x.innerText || ''));
  if (!b) return 'null';
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`));

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
await new Promise((r) => setTimeout(r, 1500));

console.log('menu text:', await ev(`(() => {
  const pops = [...document.querySelectorAll('[role=menu],[role=dialog]')].filter((e) => e.getBoundingClientRect().width > 0);
  return JSON.stringify(pops.map((e) => (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)));
})()`));
console.log('sliders:', await ev(`document.querySelectorAll('[role=slider]').length`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  const fs = await import('node:fs');
  fs.writeFileSync('probe-out/fresh-menu.png', Buffer.from(shot.result.data, 'base64'));
}
ws.close();
