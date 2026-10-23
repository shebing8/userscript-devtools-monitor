// 实验5：显式选 Chat 模式建会话（main-world fetch 可见），注入 features.flags=["general_agent"]
// 判定：服务端是否给 chat 会话开沙箱 + 前端能否渲染工具块
// 用法: node zai-flagexp5.mjs [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const outPrefix = process.argv[2] || 'x-flagexp5';
const START = 'https://zchat.z.ai/';

const WRAP = `(function(){
  if (window.__FLAG5__) return; window.__FLAG5__={patched:0,hits:[],err:[]};
  function rewrite(t){
    if(!t) return t;
    try{
      var j=JSON.parse(t);
      if(!j||typeof j!=='object') return t;
      var f=j.features||(j.chat&&j.chat.features)||null;
      if(!f){ f=j.features={}; }
      var before=JSON.stringify(f.flags);
      f.flags=['general_agent'];
      window.__FLAG5__.patched+=1; window.__FLAG5__.hits.push({before:before});
      return JSON.stringify(j);
    }catch(e){ window.__FLAG5__.err.push(String(e)); return t; }
  }
  var nf=window.fetch;
  window.fetch=function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      var meth=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      if(meth==='POST'&&/chat\\/completions/.test(url)&&init&&typeof init.body==='string'){
        return nf.call(this,input,Object.assign({},init,{body:rewrite(init.body)}));
      }
    }catch(e){ window.__FLAG5__.err.push('fw:'+e); }
    return nf.apply(this,arguments);
  };
})()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(START)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

let seq = 0;
const pending = new Map();
const posts = [];
const responses = [];
const idToUrl = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const rq = m.params.request;
    idToUrl.set(m.params.requestId, rq.url);
    if (rq.method === 'POST' && /\/api\/v\d+\/(chat\/completions|chats\/new)/.test(rq.url)) posts.push({ url: rq.url.replace(/\?.*/, ''), body: rq.postData || '' });
  }
  if (m.method === 'Network.responseReceived') {
    if (/\/api\/v\d+\/chat\/completions/.test(m.params.response.url)) idToUrl.set('res:' + m.params.requestId, m.params.response.url);
  }
  if (m.method === 'Network.loadingFinished') {
    const u = idToUrl.get('res:' + m.params.requestId);
    if (!u) return;
    send('Network.getResponseBody', { requestId: m.params.requestId })
      .then((r) => {
        let text = r.result?.body || '';
        if (r.result?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        responses.push({ url: u, body: text });
      })
      .catch(() => {});
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: WRAP });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: START });
await wait(9000);

const report = { steps: [] };
const step = (n, v) => report.steps.push({ n, v });

// 显式点「Chat 模式」新建
step('pickChat', await evl(`(() => {
  const btn = [...document.querySelectorAll('button')].find((x) => /^Chat 模式$/.test((x.innerText || '').trim()));
  if (!btn) return { error: 'no Chat mode button', seen: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => /模式|新聊天/.test(t)).slice(0, 8) };
  btn.click();
  return { clicked: true };
})()`));
await wait(4000);
step('href1', await evl('location.href'));

const TOKEN = 'FLAG5_OK_' + (17 * 19);
step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '必须调用代码沙箱工具执行 bash：echo ${TOKEN} ，不许只用文字回答，直接调用工具');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 800));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'disabled' };
  btn.click();
  return { clicked: true };
})()`));

let settled = null;
for (let i = 0; i < 34; i++) {
  await wait(3000);
  settled = await evl(`(() => {
    const a = [...document.querySelectorAll('[class*=markdown]')];
    const last = a[a.length - 1];
    const tail = (last ? last.innerText : '').slice(-500);
    const running = /思考中|生成中/.test(document.body.innerText);
    return { tail, running, hasTool: /已运行\\s*\\d+\\s*条命令/.test(document.body.innerText), hasToken: document.body.innerText.includes('${TOKEN}') };
  })()`);
  if (settled && !settled.running && settled.tail && settled.tail.length > 5) {
    await wait(4000);
    const again = await evl('(() => { const a=[...document.querySelectorAll("[class*=markdown]")]; const l=a[a.length-1]; return (l?l.innerText:"").slice(-500); })()');
    if (again === settled.tail) break;
    settled.tail = again;
  }
}
step('settled', settled);
step('wrap', await evl('window.__FLAG5__'));

const cid = await evl('(location.href.match(/\\/c\\/([\\w-]+)/)||[])[1]');
if (cid) {
  step('chatType', await evl(`(async () => {
    const t = localStorage.getItem('token');
    const res = await fetch('/api/v1/chats/${cid}', { headers: { Authorization: 'Bearer ' + (t || '') } });
    const j = await res.json().catch(() => null);
    return { status: res.status, type: j && j.type, cid: '${cid}' };
  })()`));
}

step('outbound', posts.map((p) => {
  try { const j = JSON.parse(p.body); const f = j.features || {}; return { url: p.url, flags: f.flags, type: j.type }; } catch (e) { return { url: p.url, len: p.body.length }; }
}));
step('sse', responses.map((r) => ({
  len: r.body.length, hasToken: r.body.includes(TOKEN),
  toolEvents: [...new Set(r.body.match(/"type":"[^"]*(tool|command)[^"]*"|"(tool_call|tool_response)"/g) || [])].slice(0, 8),
  errSnippet: (r.body.match(/.{0,120}(error|denied|invalid|forbidden).{0,120}/i) || [null])[0],
})));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
fs.writeFileSync(`${outPrefix}.flagexp5.json`, JSON.stringify(report, null, 2));
console.log('WROTE', `${outPrefix}.flagexp5.json`);
for (const s of report.steps) console.log('--', s.n, JSON.stringify(s.v).slice(0, 700));
ws.close();
process.exit(0);
