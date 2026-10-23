// 实验7：agent 会话里操作 VM pills（think=off, web=on），抓出站 features 验证 pill 是否生效
// 用法: node zai-pillagent.mjs <chatUrl> [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const chatUrl = process.argv[2] || 'https://zchat.z.ai/c/2f7b303b-6daf-4c69-9fd6-96698091d45a';
const outPrefix = process.argv[3] || 'z-pillagent';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
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
    if (rq.method === 'POST' && /\/api\/v\d+\/chat\/completions/.test(rq.url)) posts.push(rq.postData || '');
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
await send('Page.navigate', { url: chatUrl });
await wait(9000);

const report = { steps: [] };
const step = (n, v) => report.steps.push({ n, v });

step('vmState', await evl('({state: window.__ZAI_CLASSIC_STATE__||null, chips: [...document.querySelectorAll("[data-zai-chip]")].map((c)=>({k:c.dataset.zaiChip,a:c.dataset.active,t:(c.innerText||"").trim()})), stats: window.__ZAI_CLASSIC_COMPOSER__||null})'));

// think 切到 off（从当前档一路点到出现「深度思考」裸标签或回到 off）
step('thinkOff', await evl(`(() => {
  const c = document.querySelector('[data-zai-chip="think"]');
  if (!c) return { error: 'no think chip' };
  for (let i = 0; i < 6 && /·/.test(c.innerText); i++) c.click();
  return { label: (c.innerText||'').trim(), state: (window.__ZAI_CLASSIC_STATE__||{}).level };
})()`));
// web 开
step('webOn', await evl(`(() => {
  const wc = document.querySelector('[data-zai-chip="web"]');
  if (!wc) return { error: 'no web chip' };
  if (wc.dataset.active !== 'true') wc.click();
  return { active: wc.dataset.active, state: (window.__ZAI_CLASSIC_STATE__||{}).web };
})()`));
await wait(1000);

step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'disabled' };
  btn.click();
  return { clicked: true };
})()`));
await wait(15000);

step('bodies', posts.map((b) => {
  try { const j = JSON.parse(b); const f = j.features || {}; return { flags: f.flags, thinking: f.enable_thinking, effort: f.reasoning_effort, web: f.web_search, auto: f.auto_web_search, topThinking: j.enable_thinking, topEffort: j.reasoning_effort }; }
  catch (e) { return { note: 'parse fail', len: b.length }; }
}));
step('vmStatsAfter', await evl('window.__ZAI_CLASSIC_COMPOSER__||null'));
step('lastBody', await evl('window.__ZAI_LAST_BODY__||null'));

fs.writeFileSync(`${outPrefix}.pillagent.json`, JSON.stringify(report, null, 2));
for (const s of report.steps) console.log('--', s.n, JSON.stringify(s.v).slice(0, 500));
ws.close();
process.exit(0);
