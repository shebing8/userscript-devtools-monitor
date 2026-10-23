// 诊断：chat 模式回复卡住 —— 抓 console 异常、网络时间线、DOM 增量
// 用法: node zai-stuckdiag.mjs <scriptFile|NONE> <chatUrl> <outPrefix>
import fs from 'node:fs';

const [scriptFile, chatUrl, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';
const SOURCE = scriptFile === 'NONE' ? null : fs.readFileSync(scriptFile, 'utf8');

const list = await (await fetch(`http://${HOST}/json/list`)).json();
let target = list.find((x) => x.url === chatUrl && x.type === 'page');
if (!target) target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const events = [];
const responses = [];
const t0 = Date.now();
const now = () => Date.now() - t0;
const idUrl = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  const p = m.params || {};
  if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) {
    events.push({ t: now(), k: 'console.' + p.type, text: (p.args || []).map((a) => a.description || a.value || '').join(' ').slice(0, 500) });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails;
    events.push({ t: now(), k: 'exception', text: String(d.exception?.description || d.text).slice(0, 600) });
  }
  if (m.method === 'Log.entryAdded') {
    events.push({ t: now(), k: 'log.' + p.entry.level, text: `${p.entry.source || ''} ${p.entry.text}`.slice(0, 400), url: (p.entry.url || '').slice(0, 200) });
  }
  if (m.method === 'Network.webSocketCreated') {
    events.push({ t: now(), k: 'ws.create', u: (p.url || '').slice(0, 160) });
  }
  if (m.method === 'Network.webSocketHandshakeResponseReceived') {
    events.push({ t: now(), k: 'ws.ok', s: p.response?.status });
  }
  if (m.method === 'Network.webSocketHandshakeFailed') {
    events.push({ t: now(), k: 'ws.fail', err: p.errorText, u: (p.request?.url || '').slice(0, 160) });
  }
  if (m.method === 'Network.webSocketFrameError') {
    events.push({ t: now(), k: 'ws.frameerr', err: p.errorText });
  }
  if (m.method === 'Network.webSocketClosed') {
    events.push({ t: now(), k: 'ws.close' });
  }
  if (m.method === 'Network.webSocketFrameReceived') {
    const d = (p.response?.payloadData || '').slice(0, 160);
    if (/chat|response|error|close/i.test(d)) events.push({ t: now(), k: 'ws.recv', d });
  }
  if (m.method === 'Network.requestWillBeSent') {
    idUrl.set(p.requestId, p.request.url);
    if (/completions|socket\.io|messages\/batch|chats\//.test(p.request.url)) {
      events.push({ t: now(), k: 'net.send', m: p.request.method, u: p.request.url.slice(0, 130) });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const u = p.response.url;
    if (/completions|socket\.io|messages\/batch/.test(u)) {
      events.push({ t: now(), k: 'net.resp', s: p.response.status, ct: p.response.mimeType, u: u.slice(0, 110) });
    }
  }
  if (m.method === 'Network.loadingFinished') {
    const u = idUrl.get(p.requestId) || '';
    if (/completions/.test(u)) {
      events.push({ t: now(), k: 'net.done', u: u.slice(0, 110), enc: p.encodedDataLength });
      send('Network.getResponseBody', { requestId: p.requestId }).then((r) => {
        let text = r.result?.body || '';
        if (r.result?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        responses.push({ url: u.slice(0, 140), bytes: text.length, head: text.slice(0, 2000) });
      }).catch(() => {});
    }
  }
  if (m.method === 'Network.loadingFailed') {
    const u = idUrl.get(p.requestId) || '';
    events.push({ t: now(), k: 'net.fail', u: u.slice(0, 140), err: p.errorText, type: p.type });
  }
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Log.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
let hookId = null;
if (SOURCE) { const h = await send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE }); hookId = h.result?.identifier; }
await send('Page.navigate', { url: chatUrl });
await wait(12000);

const marker = 'STUCKDIAG_' + Math.random().toString(36).slice(2, 7);
const sent = await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到 ${marker}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn || btn.disabled) return { error: 'send unavailable', disabled: btn && btn.disabled };
  btn.click();
  return { clicked: true, t: Date.now() };
})()`);
events.push({ t: now(), k: 'sent', sent });

// DOM 增量曲线：每 2s 采样最后一次出现 marker 之后的文本长度
const curve = [];
for (let i = 0; i < 25; i++) {
  await wait(2000);
  const v = await evl(`(() => {
    const nodes=[...document.querySelectorAll('[class*=markdown]')];
    const txt=nodes.map(n=>n.innerText).join('\\n');
    const i=txt.lastIndexOf('${marker}');
    const after=i>=0?txt.slice(i+${marker.length} + 12):'';
    const busy=!!document.querySelector('.spinner,[class*=loading],[class*=typing],[class*=generating]');
    const stopBtn=!!document.querySelector('[class*=stop]');
    return { afterLen: after.trim().length, hasText: after.trim().length > 0, busy, stopBtn, sample: after.trim().slice(0, 80) };
  })()`);
  curve.push({ t: now(), ...v });
  if (v.hasText && v.afterLen > 15) break;
}

const socketProbe = await evl(`(() => {
  const perf = performance.getEntriesByType('resource').filter(r => /socket|engine.io|\\\\/ws|wss:/i.test(r.name)).map(r => r.name.slice(0, 160));
  return { ioGlobal: typeof window.io, socketUrlsSeen: [...new Set(perf)].slice(0, 8), connectings: (window.__ZAI_CLASSIC_COMPOSER__ || {}) };
})()`);
events.push({ t: now(), k: 'socketProbe', socketProbe });

fs.writeFileSync(`${outPrefix}.stuckdiag.json`, JSON.stringify({ script: scriptFile, sent, curve, events, responses }, null, 2));
if (hookId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hookId });
const last = curve[curve.length - 1];
console.log('script=', scriptFile !== 'NONE', '| final hasText=', last.hasText, '| afterLen=', last.afterLen, '| events=', events.length);
ws.close();
