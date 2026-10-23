// 驱动 Violentmonkey 的 confirm 安装页：枚举按钮 -> 点击安装 -> 校验脚本已入库
// 用法: node vm-install.mjs [--dump-only]

const HOST = '127.0.0.1:9222';
const EXT = 'jinjaccalgkegednnccohejagnlnfdag';
const dumpOnly = process.argv.includes('--dump-only');

const list = await (await fetch(`http://${HOST}/json/list`)).json();
const page = list.find((d) => d.type === 'page' && (d.url || '').includes(`${EXT}/confirm/`));
if (!page) { console.log(JSON.stringify({ error: 'no confirm page', pages: list.map((d) => d.url) }, null, 2)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2500));

const info = await evl(`(() => ({
  title: document.title,
  text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
  buttons: [...document.querySelectorAll('button,[role=button],a')].map((b, i) => ({
    i, tag: b.tagName, text: (b.innerText || '').trim().slice(0, 30),
    cls: b.className.toString().slice(0, 60), dis: !!b.disabled,
  })).filter((b) => b.text),
  scriptName: ([...document.querySelectorAll('h1,h2,.title,input')].map((x) => (x.value || x.innerText || '').trim()).filter(Boolean).slice(0, 6)),
}))()`);

console.log(JSON.stringify({ url: page.url, info }, null, 2));

if (!dumpOnly) {
  const clicked = await evl(`(() => {
    const cand = [...document.querySelectorAll('button,[role=button],a')].filter((b) => /^(安装|安装脚本|确认|Install|Add script|Save|保存)/i.test((b.innerText || '').trim()));
    if (!cand.length) return { error: 'no install button', seen: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) };
    cand[0].click();
    return { clicked: (cand[0].innerText || '').trim() };
  })()`);
  await new Promise((r) => setTimeout(r, 4000));
  const after = await evl(`({title: document.title, text: (document.body?.innerText || '').replace(/\\s+/g,' ').slice(0,300)})`);
  console.log(JSON.stringify({ clicked, after }, null, 2));
}
ws.close();
