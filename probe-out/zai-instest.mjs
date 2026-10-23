// 埋点诊断：帧解析数 / idle 回调数 / done 后消息状态
import fs from 'node:fs';
const [scriptFile, chatUrl, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';
const SOURCE = scriptFile === 'NONE' ? null : fs.readFileSync(scriptFile, 'utf8');

const INSTR = `(function(){
  if (window.__ZAI_INS) return;
  var c = window.__ZAI_INS = { jsonFrames:0, idleSched:0, idleRun:0, decode:0, samples:[], reads:0 };
  var jp = JSON.parse;
  JSON.parse = function (t) {
    var v = jp.apply(null, arguments);
    try {
      if (v && v.type === 'chat:completion') {
        c.jsonFrames++;
        if (c.samples.length < 6) c.samples.push(JSON.stringify(v).slice(0, 300));
      }
    } catch (e) {}
    return v;
  };
  var ric = window.requestIdleCallback;
  if (ric) window.requestIdleCallback = function (cb, opt) {
    c.idleSched++;
    return ric.call(window, function (d) { c.idleRun++; return cb(d); }, opt);
  };
  var td = TextDecoder.prototype.decode;
  TextDecoder.prototype.decode = function () { c.decode++; return td.apply(this, arguments); };
})()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pend = new Map();
const idUrl = new Map();
const events = [];
const t0 = Date.now();
const now = () => Date.now() - t0;
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') idUrl.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Runtime.exceptionThrown') events.push({ t: now(), k: 'exc', d: String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 300) });
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push({ t: now(), k: 'err', d: (m.params.args || []).map(a => a.description || a.value || '').join(' ').slice(0, 300) });
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
const srcs = INSTR + (SOURCE ? '\n' + SOURCE : '');
const hook = await send('Page.addScriptToEvaluateOnNewDocument', { source: srcs });
await send('Page.navigate', { url: chatUrl });
await wait(12000);
await evl('window.__ZAI_INS && (window.__ZAI_INS.jsonFrames=0, window.__ZAI_INS.samples=[], true)');

const marker = 'INSTEST_' + Math.random().toString(36).slice(2, 7);
const sent = await evl(`(async () => {
  var ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到 ${marker}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  var btn = document.querySelector('.sendMessageButton');
  if (!btn || btn.disabled) return { error: 'send unavailable' };
  btn.click();
  return { clicked: true };
})()`);

const curve = [];
for (let i = 0; i < 14; i++) {
  await wait(3000);
  const v = await evl(`(function(){
    var c = window.__ZAI_INS || {};
    var s = Array.prototype.slice.call(document.querySelectorAll('[class*=markdown]')).map(function(n){return n.innerText}).join('\\n');
    var j = s.lastIndexOf('${marker}');
    return { jsonFrames: c.jsonFrames, idleSched: c.idleSched, idleRun: c.idleRun, decode: c.decode,
      samples: (c.samples||[]).slice(0,3), tail: s.slice(j, j+120), tailLen: s.slice(j+10).trim().length, err: c.error||null };
  })()`);
  curve.push({ t: now(), ...v });
  if (v.tailLen > 8) break;
}
fs.writeFileSync(`${outPrefix}.instest.json`, JSON.stringify({ script: scriptFile !== 'NONE', sent, curve, events }, null, 2));
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hook.result.identifier });
const last = curve[curve.length - 1];
console.log('withScript=', scriptFile !== 'NONE', '| rendered=', last.tailLen > 8, '| jsonFrames=', last.jsonFrames, '| idleSched=', last.idleSched, '| idleRun=', last.idleRun, '| events=', events.length);
ws.close();
