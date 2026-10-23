// 实测：还原脚本在位时，agent 会话是否仍能调用沙箱/执行工具
// 用法: node zai-agenttest.mjs <scriptFile|NONE> <chatUrl> <outPrefix>
import fs from 'node:fs';

const [scriptFile, chatUrl, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';
const SOURCE = scriptFile === 'NONE' ? null : fs.readFileSync(scriptFile, 'utf8');

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const posts = [];
const idToUrl = new Map();
const chunksByReq = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const rq = m.params.request;
    idToUrl.set(m.params.requestId, rq.url);
    if (rq.method !== 'GET' && /\/api\//.test(rq.url)) {
      posts.push({ method: rq.method, url: rq.url, body: (rq.postData || '').slice(0, 6000) });
    }
  }
  if (m.method === 'Network.eventSourceMessageReceived') {
    const u = idToUrl.get(m.params.requestId) || '';
    const key = m.params.requestId;
    if (!chunksByReq.has(key)) chunksByReq.set(key, { url: u, msgs: [] });
    const data = m.params.data || '';
    if (/tool|function|sandbox|shell|bash|exec|command|code_exec|k8s|ssh|terminal|browser/i.test(data) || chunksByReq.get(key).msgs.length < 60) {
      chunksByReq.get(key).msgs.push(data.slice(0, 800));
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
let hookId = null;
if (SOURCE) {
  const h = await send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE });
  hookId = h.result?.identifier;
}
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: chatUrl });
await wait(11000);

const log = { chatUrl, script: scriptFile };
log.boot = await evl(`({stats: window.__ZAI_CLASSIC_COMPOSER__ || null, state: window.__ZAI_CLASSIC_STATE__ || null})`);
log.chips = await evl(`[...document.querySelectorAll('[data-zai-chip]')].map(c => ({kind: c.dataset.zaiChip || c.getAttribute('data-zai-chip'), text: c.innerText.trim(), active: c.dataset.active}))`);

// 发送一个必须动沙箱工具的任务
log.send = await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '请调用代码沙箱工具，在里面执行 bash：echo AGENTTOOL_OK_\$(expr 63 \* 71)，把命令原始输出给我，不要口算。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'send still disabled' };
  btn.click();
  return { clicked: true };
})()`);

// 等流式跑完（工具调用回合较长）
let settled = false;
let lastLen = 0, stableRounds = 0;
for (let i = 0; i < 40; i++) {
  await wait(5000);
  const cur = await evl(`(() => {
    const main = document.querySelector('.messages-container, [class*=messageList], main');
    return main ? main.innerText.length : 0;
  })()`);
  if (cur === lastLen) stableRounds++; else stableRounds = 0;
  lastLen = cur;
  if (stableRounds >= 3) { settled = true; break; }
}
log.settled = settled;
log.finalChars = lastLen;

// 抓最终回答文本尾部 + 是否有工具块
log.answerTail = await evl(`(() => {
  const nodes = [...document.querySelectorAll('[class*=markdown], .message-content, [class*=response]')];
  const t = nodes.map(n => n.innerText).join('\\n');
  return t.slice(-1500);
})()`);
log.toolBlocks = await evl(`(() => {
  const t = document.body.innerText;
  const hits = {};
  for (const k of ['沙箱','工具','执行','bash','shell','terminal','SSH','code interpreter','运行命令','浏览网页']) {
    const re = new RegExp(k, 'gi'); hits[k] = (t.match(re) || []).length;
  }
  return hits;
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
if (hookId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hookId });

const streams = [...chunksByReq.values()].map(s => ({
  url: s.url,
  count: s.msgs.length,
  toolish: s.msgs.filter(d => /tool|function|sandbox|shell|bash|exec|command|ssh|terminal/i.test(d)).slice(0, 20),
}));
fs.writeFileSync(`${outPrefix}.agenttest.json`, JSON.stringify({ log, posts, streams }, null, 2));
console.log('posts', posts.length, 'streams', streams.length, 'settled', settled);
ws.close();
