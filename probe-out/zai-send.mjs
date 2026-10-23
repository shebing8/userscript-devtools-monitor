// 端到端：注入脚本 → 新建会话 → 设档位/联网 → 发送 → 抓出站 POST 请求体 + 校验原生滑块同步
// 用法: node zai-send.mjs <scriptFile> <outPrefix>

import fs from 'node:fs';

const [scriptFile, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';
const SOURCE = fs.readFileSync(scriptFile, 'utf8');
const START = 'https://zchat.z.ai/';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(START)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const posts = [];
const responses = [];
const idToUrl = new Map();
const wss = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const rq = m.params.request;
    idToUrl.set(m.params.requestId, rq.url);
    if (rq.method !== 'GET' && /\/api\//.test(rq.url)) {
      posts.push({ t: 'http', method: rq.method, url: rq.url, body: (rq.postData || '').slice(0, 4000) });
    }
  }
  if (m.method === 'Network.responseReceived') {
    if (/\/api\/v\d+\/chats\/new\b/.test(m.params.response.url)) idToUrl.set('res:' + m.params.requestId, m.params.response.url);
  }
  if (m.method === 'Network.loadingFinished') {
    const u = idToUrl.get('res:' + m.params.requestId);
    if (!u) return;
    send('Network.getResponseBody', { requestId: m.params.requestId })
      .then((r) => {
        let text = r.result?.body || '';
        if (r.result?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        responses.push({ url: u, body: text.slice(0, 4000) });
      })
      .catch(() => {});
  }
  if (m.method === 'Network.webSocketFrameSent') {
    wss.push({ t: 'ws', data: (m.params.response?.payloadData || '').slice(0, 4000) });
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
const hooked = await send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: START });
await wait(11000);

const log = { steps: [] };
const step = (name, value) => { log.steps.push({ name, value }); };

step('boot', await evl(`({stats: window.__ZAI_CLASSIC_COMPOSER__, state: window.__ZAI_CLASSIC_STATE__})`));

// 1) 新建会话
step('newChat', await evl(`(() => {
  const el = [...document.querySelectorAll('button,a,div[role=button]')].find((x) => /^新聊天$/.test((x.innerText || '').trim()));
  if (!el) return { error: 'no 新聊天 button' };
  el.click();
  return { clicked: true };
})()`));
await wait(5000);
step('hrefAfterNew', await evl('location.href'));

// 2) 档位设为「低」
step('setLow', await evl(`(() => {
  const c = document.querySelector('[data-zai-chip="think"]');
  if (!c) return { error: 'no think chip' };
  for (let i = 0; i < 8 && !/低/.test(c.innerText); i++) c.click();
  return { label: (c.innerText || '').trim(), state: window.__ZAI_CLASSIC_STATE__.level };
})()`));

// 3) 打开联网：走我们注入的 pill（v3.1 起 pill 是唯一入口，原生裸图标被收编）
step('setWeb', await evl(`(() => {
  const wc = document.querySelector('[data-zai-chip="web"]');
  if (!wc) return { error: 'no web chip' };
  wc.click();
  const g = [...document.querySelectorAll('button')].find((b) => !b.id && !b.getAttribute('aria-label') && /1\\.33333 8H14\\.6667/.test((b.querySelector('svg path') || {}).getAttribute ? b.querySelector('svg path').getAttribute('d') : ''));
  return {
    chipActive: wc.dataset.active, state: window.__ZAI_CLASSIC_STATE__.web,
    nativeHidden: g ? g.style.display === 'none' : null,
    nativeActive: g ? g.getAttribute('data-active') : null,
  };
})()`));
await wait(1500);
step('webSettled', await evl(`(() => {
  const wc = document.querySelector('[data-zai-chip="web"]');
  const g = [...document.querySelectorAll('button')].find((b) => !b.id && !b.getAttribute('aria-label') && /1\\.33333 8H14\\.6667/.test((b.querySelector('svg path') || {}).getAttribute ? b.querySelector('svg path').getAttribute('d') : ''));
  return { chipActive: wc && wc.dataset.active, state: window.__ZAI_CLASSIC_STATE__.web, nativeActive: g && g.getAttribute('data-active'), stored: localStorage.getItem('zai_classic_web') };
})()`));
await wait(600);

// 4) 输入并发送
step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'send still disabled' };
  btn.click();
  return { clicked: true };
})()`));
await wait(14000);

step('hrefAfterSend', await evl('location.href'));
step('lastBody', await evl('window.__ZAI_LAST_BODY__ || null'));
step('statsAfter', await evl('window.__ZAI_CLASSIC_COMPOSER__ || null'));

// 5) 打开模型菜单确认原生思考强度滑块
step('slider', await evl(`(async () => {
  const ms = document.querySelector('.modelSelectorButton');
  if (!ms) return { error: 'no model selector' };
  ms.click();
  await new Promise((r) => setTimeout(r, 1600));
  const menu = [...document.querySelectorAll('[role=menu]')].find((p) => /GLM/.test(p.innerText));
  if (!menu) return { error: 'no menu' };
  const s = menu.querySelector('[role=slider]');
  return {
    text: menu.innerText.replace(/\\s+/g, ' ').slice(0, 120),
    valueNow: s ? s.getAttribute('aria-valuenow') : null,
    valueText: s ? s.getAttribute('aria-valuetext') : null,
    disabled: s ? s.getAttribute('aria-disabled') : null,
  };
})()`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hooked.identifier });

fs.writeFileSync(`${outPrefix}.send.json`, JSON.stringify({ START, log, posts, responses, wss: wss.slice(0, 8) }, null, 2));
console.log('steps', log.steps.length, 'http posts', posts.length, 'ws frames', wss.length);
ws.close();
