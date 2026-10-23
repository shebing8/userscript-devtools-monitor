// 验证竞态假设：把 completions 的 SSE 帧逐帧放慢再交给前端
// 用法: node zai-pacetest.mjs <chatUrl> <outPrefix>
import fs from 'node:fs';

const [chatUrl, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';

const WRAP = `(function(){
  if (window.__PACE_TEST__) return;
  window.__PACE_TEST__ = { streams: 0, delivered: 0 };
  const nf = window.fetch;
  window.fetch = async function (input, init) {
    const res = await nf.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url || res.url || '';
      if (!/chat\\/completions/.test(url)) return res;
      if (!(res.headers.get('content-type') || '').includes('event-stream')) return res;
      window.__PACE_TEST__.streams += 1;
      const src = res.body.getReader();
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      let buf = '';
      const stream = new ReadableStream({
        async pull(controller) {
          // 每帧之间停 120ms，让前端状态机跟上
          for (;;) {
            const { done, value } = await src.read();
            if (done) {
              if (buf.trim()) { await new Promise(r => setTimeout(r, 120)); controller.enqueue(enc.encode(buf)); }
              controller.close();
              return;
            }
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\\n\\n')) >= 0) {
              const frame = buf.slice(0, i + 2);
              buf = buf.slice(i + 2);
              await new Promise((r) => setTimeout(r, 120));
              window.__PACE_TEST__.delivered += 1;
              controller.enqueue(enc.encode(frame));
            }
          }
        },
        cancel(reason) { try { src.cancel(reason); } catch (e) {} },
      });
      return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) { return res; }
  };
})()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pending = new Map();
const responses = [];
const idUrl = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') idUrl.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.loadingFinished' && /completions/.test(idUrl.get(m.params.requestId) || '')) {
    send('Network.getResponseBody', { requestId: m.params.requestId }).then((r) => {
      let t = r.result?.body || '';
      if (r.result?.base64Encoded) t = Buffer.from(t, 'base64').toString('utf8');
      responses.push({ bytes: t.length, head: t.slice(0, 400) });
    }).catch(() => {});
  }
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
const hook = await send('Page.addScriptToEvaluateOnNewDocument', { source: WRAP });
await send('Page.navigate', { url: chatUrl });
await wait(12000);

const marker = 'PACETEST_' + Math.random().toString(36).slice(2, 7);
const sent = await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '只回复两个字：收到 ${marker}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn || btn.disabled) return { error: 'send unavailable' };
  btn.click();
  return { clicked: true };
})()`);

const curve = [];
for (let i = 0; i < 20; i++) {
  await wait(2500);
  const v = await evl(`(() => {
    const txt=[...document.querySelectorAll('[class*=markdown]')].map(n=>n.innerText).join('\\n');
    const j=txt.lastIndexOf('${marker}');
    const after=j>=0?txt.slice(j+${marker.length}+10).trim():'';
    return { afterLen: after.length, probe: window.__PACE_TEST__, sample: after.slice(0,60) };
  })()`);
  curve.push(v);
  if (v.afterLen > 10) break;
}

fs.writeFileSync(`${outPrefix}.pacetest.json`, JSON.stringify({ sent, curve, responses }, null, 2));
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hook.result.identifier });
const last = curve[curve.length - 1];
console.log('rendered=', last.afterLen > 10, '| streams=', JSON.stringify(last.probe), '| sample=', JSON.stringify(last.sample));
ws.close();
