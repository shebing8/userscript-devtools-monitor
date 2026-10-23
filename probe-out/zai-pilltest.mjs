// 测试D：在默认(现为agent)新会话里开联网pill+改思考档位，抓出站体看是否生效
// 顺带 dump 模式切换控件的位置与结构
// 用法: node zai-pilltest.mjs [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const outPrefix = process.argv[2] || 'w-pilltest';
const START = 'https://zchat.z.ai/';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(START)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const posts = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const rq = m.params.request;
    if (rq.method === 'POST' && /\/api\/v\d+\/(chat\/completions|chats\/new)/.test(rq.url)) {
      posts.push({ url: rq.url.replace(/\?.*/, ''), body: rq.postData || '' });
    }
  }
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: START });
await wait(9000);

const report = { steps: [] };
const step = (n, v) => report.steps.push({ n, v });

step('vm', await evl('({state: window.__ZAI_CLASSIC_STATE__ || null, stats: window.__ZAI_CLASSIC_COMPOSER__ || null})'));

// 模式切换控件在哪
step('modeToggle', await evl(`(() => {
  const els = [...document.querySelectorAll('*')].filter((x) => {
    const t = (x.innerText || '').trim();
    return (t === 'Chat 模式' || t === 'Agent 模式') && x.children.length <= 2;
  });
  return els.map((x) => {
    const r = x.getBoundingClientRect();
    const path = []; let p = x;
    for (let i = 0; i < 5 && p; i++) { path.push(p.tagName + (p.className ? '.' + String(p.className).split(' ')[0].slice(0, 30) : '')); p = p.parentElement; }
    return { text: (x.innerText || '').trim(), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], active: x.getAttribute('aria-checked') || x.getAttribute('data-state') || x.className.includes('active'), path: path.join('<') };
  });
})()`));

// 点联网 pill（开）
step('webPill', await evl(`(() => {
  const wc = document.querySelector('[data-zai-chip="web"]');
  if (!wc) return { error: 'no web chip' };
  wc.click();
  return { active: wc.dataset.active, state: (window.__ZAI_CLASSIC_STATE__||{}).web };
})()`));
// 档位 pill 切到非默认档
step('thinkPill', await evl(`(() => {
  const c = document.querySelector('[data-zai-chip="think"]');
  if (!c) return { error: 'no think chip' };
  const start = (window.__ZAI_CLASSIC_STATE__||{}).level;
  for (let i = 0; i < 5; i++) { c.click(); }
  return { before: start, label: (c.innerText || '').trim(), state: (window.__ZAI_CLASSIC_STATE__||{}).level };
})()`));
await wait(1200);

// 发送小消息
step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn || btn.disabled) return { error: 'send btn issue', has: !!btn };
  btn.click();
  return { clicked: true };
})()`));
await wait(12000);

step('bodies', posts.map((p) => {
  try {
    const j = JSON.parse(p.body);
    const f = j.features || {};
    return { url: p.url, flags: f.flags, web_search: f.web_search, auto: f.auto_web_search, thinking: f.enable_thinking, effort: f.reasoning_effort, topEffort: j.reasoning_effort, topAuto: j.auto_web_search };
  } catch (e) { return { url: p.url, note: 'parse fail', len: p.body.length }; }
}));
step('lastBodyFromVM', await evl('window.__ZAI_LAST_BODY__ || null'));
step('statsAfter', await evl('window.__ZAI_CLASSIC_COMPOSER__ || null'));

fs.writeFileSync(`${outPrefix}.pilltest.json`, JSON.stringify(report, null, 2));
for (const s of report.steps) console.log('--', s.n, JSON.stringify(s.v).slice(0, 600));
ws.close();
process.exit(0);
