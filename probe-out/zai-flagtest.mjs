// 在 B 会话注入 fetch 补丁（剥离 hidden 标记），验证 composer 控件是否回来
// 用法: node zai-flagtest.mjs <url> <outPrefix>

import fs from 'node:fs';

const [url, outPrefix] = process.argv.slice(2);
const HOST = '127.0.0.1:9222';

const PATCH = `(() => {
  const DROP = new Set(['web_search', 'hidden-thinking']);
  const fix = (h) => {
    if (!h || !Array.isArray(h.features)) return false;
    const kept = h.features.filter((f) => !(f && DROP.has(f.type)));
    if (kept.length === h.features.length) return false;
    h.features = kept; return true;
  };
  const patch = (j) => {
    if (!j || typeof j !== 'object') return false;
    let c = fix(j) || fix(j.chat);
    const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
    for (const m of (arr || [])) {
      const sp = m && m.info && m.info.meta && m.info.meta.suggestion_prompts;
      if (Array.isArray(sp)) for (const s of sp) if (fix(s)) c = true;
    }
    if (Array.isArray(j.data)) for (const it of j.data) { if (fix(it) || fix(it.chat)) c = true; }
    return c;
  };
  const nf = window.fetch;
  window.fetch = async function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await nf.apply(this, arguments);
    if (!/\\/api\\/(models|config)$|\\/api\\/v\\d+\\/chats\\b/.test(u)) return res;
    try {
      const j = await res.clone().json();
      if (!patch(j)) return res;
      const h = new Headers(res.headers); h.delete('content-length'); h.delete('content-encoding');
      window.__ZAI_TEST_PATCHED__ = (window.__ZAI_TEST_PATCHED__ || 0) + 1;
      return new Response(JSON.stringify(j), { status: res.status, statusText: res.statusText, headers: h });
    } catch (e) { return res; }
  };
  window.__ZAI_TEST_ON__ = 1;
})()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

const cfg = await send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 12000));

const dump = await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  let box = ta;
  for (let i = 0; i < 12 && box.parentElement; i++) { box = box.parentElement; if (box.querySelector('.sendMessageButton')) break; }
  return {
    patched: window.__ZAI_TEST_PATCHED__ || 0,
    buttons: [...box.querySelectorAll('button')].map((b) => ({
      id: b.id || null, label: b.getAttribute('aria-label'), text: (b.innerText || '').trim().slice(0, 20),
    })),
    composerText: box.innerText.replace(/\\s+/g, ' ').slice(0, 200),
    deepThink: /深度思考|思考/.test(box.innerText),
    webSearch: /联网|Web Search|探索/.test(box.innerText),
  };
})()`);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ url, patchedComposer: dump }, null, 2));

await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: cfg.identifier });
ws.close();
