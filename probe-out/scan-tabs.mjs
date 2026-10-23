// 遍历所有 page 目标，报告：URL、脚本是否在场、输入框按钮、是否显示深度思考
const HOST = '127.0.0.1:9222';

const list = await (await fetch(`http://${HOST}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page' && t.url.startsWith('https://zchat'));

const probe = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const eds = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(vis);
  const ta = eds[eds.length - 1];
  let box = ta;
  while (box && box.parentElement) {
    const r = box.getBoundingClientRect();
    if (r.width > 500 && r.height > 60 && box.textContent.includes('WeChat')) break;
    box = box.parentElement;
  }
  const btns = box ? [...box.querySelectorAll('button')].filter(vis).length : 0;
  const hasGlobe = box ? !!box.querySelector('svg[viewBox="0 0 15 15"]') : false;
  return {
    url: location.href,
    hook: window.__ZAI_CLASSIC_COMPOSER__ || null,
    btns,
    hasGlobe,
    hasThink: /深度思考/.test((document.body.innerText || '')),
    textarea: !!ta,
  };
})()`;

for (const t of pages) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
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
  const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  console.log(t.id.slice(0, 6), JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text));
  ws.close();
}
