// 实验3：查清新会话默认 type 的成因 + 稳健双 hook（含 Request/TypedArray 形态）
// 用法: node zai-flagexp3.mjs [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const outPrefix = process.argv[2] || 'v-flagexp3';
const START = 'https://zchat.z.ai/';

const WRAP = `(function(){
  if (window.__FLAG3__) return; window.__FLAG3__={hits:[],patched:0,err:[]};
  var RE=/chat\\/completions|\\/api\\/v\\d+\\/(agent|chat)\\b/;
  function toText(b){
    if (typeof b==='string') return Promise.resolve(b);
    if (b instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(b));
    if (ArrayBuffer.isView(b)) return Promise.resolve(new TextDecoder().decode(b));
    if (b && typeof b.text==='function') return b.text();
    return Promise.resolve(null);
  }
  function rewrite(t){
    if(!t) return t;
    try{
      var j=JSON.parse(t);
      if(!j||typeof j!=='object') return t;
      var f=j.features||(j.chat&&j.chat.features)||null;
      if(!f){ f=j.features={}; }
      var before=JSON.stringify(f.flags);
      f.flags=['general_agent'];
      window.__FLAG3__.patched+=1;
      window.__FLAG3__.hits.push({what:'completions',before:before});
      return JSON.stringify(j);
    }catch(e){ window.__FLAG3__.err.push(String(e)); return t; }
  }
  var nf=window.fetch;
  window.fetch=function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      var meth=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      if(meth==='POST'&&RE.test(url)){
        if(init&&init.body!=null){
          return toText(init.body).then(function(t){
            var nb=rewrite(t);
            return nf.call(this,input,Object.assign({},init,{body:nb}));
          }.bind(this));
        }
        if(input&&typeof Request!=='undefined'&&input instanceof Request){
          return input.clone().text().then(function(t){
            return nf.call(this,new Request(input,{body:rewrite(t)}));
          }.bind(this));
        }
        window.__FLAG3__.hits.push({what:'post-no-body-shape',url:url.slice(0,80)});
      }
    }catch(e){ window.__FLAG3__.err.push('fetch:'+e); }
    return nf.apply(this,arguments);
  };
  var nOpen=XMLHttpRequest.prototype.open, nSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){ this.__f3={m:String(m).toUpperCase(),u:String(u||'')}; return nOpen.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(b){
    var i=this.__f3;
    if(i&&i.m==='POST'&&/chat\\/completions/.test(i.u)){
      var t=(typeof b==='string')?b:null;
      if(t!=null) b=rewrite(t);
    }
    return nSend.call(this,b);
  };
  // 事件总线计数（诊断用）
  var nd=EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent=function(ev){
    try{ if(ev&&(ev.type==='chat:start'||ev.type==='chat:finish')) window.__FLAG3__.hits.push({what:'evt',type:ev.type,id:ev.detail&&ev.detail.id}); }catch(e){}
    return nd.apply(this,arguments);
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
    idToUrl.set(m.params.requestId, { url: rq.url, initiator: rq.initiator?.type });
    if (rq.method === 'POST' && /\/api\/v\d+\//.test(rq.url)) posts.push({ url: rq.url, body: rq.postData || '' });
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/\/api\/(config|v\d+\/chats\/new|v\d+\/chat\/completions)\b/.test(u)) idToUrl.set('res:' + m.params.requestId, u);
  }
  if (m.method === 'Network.loadingFinished') {
    const u = idToUrl.get('res:' + m.params.requestId);
    if (!u) return;
    send('Network.getResponseBody', { requestId: m.params.requestId })
      .then((r) => {
        let text = r.result?.body || '';
        if (r.result?.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
        responses.push({ url: u, body: text.slice(0, 60000) });
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

const report = { START, steps: [] };
const step = (name, value) => report.steps.push({ name, value });

step('vmPresent', await evl('({classic: !!window.__ZAI_CLASSIC_COMPOSER__, heal: !!window.__ZAI_HEAL__, flag3: !!window.__FLAG3__})'));
const cfg = responses.find((r) => /\/api\/config/.test(r.url));
step('apiConfigRaw', cfg ? (() => { try { const j = JSON.parse(cfg.body); return { unified_agent: j?.default_user_permissions?.unified_agent ?? j?.unified_agent ?? null, keys: Object.keys(j || {}) }; } catch (e) { return { parseErr: String(e), head: cfg.body.slice(0, 300) }; } })() : null);

step('newChat', await evl(`(() => {
  const el = [...document.querySelectorAll('button,a,div[role=button]')].find((x) => /^新聊天$/.test((x.innerText || '').trim()));
  if (!el) return { error: 'no new chat button' };
  el.click(); return { clicked: true };
})()`));
await wait(3500);

// 看模式选择 UI
step('modeUI', await evl(`(() => {
  const t = document.body.innerText;
  const modes = [...document.querySelectorAll('[role=menuitem],[role=option],[role=radio],button,div,label')]
    .map((x) => (x.innerText || '').trim()).filter((s) => s && s.length < 40 && /模式|Chat|Agent/i.test(s));
  return { hasChatMode: /Chat 模式|Chat模式/.test(t), hasAgentMode: /Agent 模式|Agent模式/.test(t), samples: [...new Set(modes)].slice(0, 10) };
})()`));

const TOKEN = 'FLAG3_OK_' + (13 * 17);
step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '必须调用代码沙箱工具执行 bash：echo ${TOKEN} ，不许只用文字回答，直接调用工具');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'send disabled' };
  btn.click();
  return { clicked: true };
})()`));

let settled = null;
for (let i = 0; i < 34; i++) {
  await wait(3000);
  settled = await evl(`(() => {
    const asst = [...document.querySelectorAll('[class*=markdown]')];
    const last = asst[asst.length - 1];
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
step('hrefAfter', await evl('location.href'));

const cid = await evl('(location.href.match(/\\/c\\/([\\w-]+)/)||[])[1]');
if (cid) {
  step('chatType', await evl(`(async () => {
    const t = localStorage.getItem('token');
    const res = await fetch('/api/v1/chats/${cid}', { headers: { Authorization: 'Bearer ' + (t || '') } });
    const j = await res.json().catch(() => null);
    return { status: res.status, type: j && j.type };
  })()`));
}

step('wrapState', await evl('window.__FLAG3__'));
step('createBodies', posts.filter((p) => /chats\/new/.test(p.url)).map((p) => p.body.slice(0, 800)));
step('completionFlags', posts.filter((p) => /chat\/completions/.test(p.url)).map((p) => {
  try { const j = JSON.parse(p.body); return { flags: j.features && j.features.flags, thinking: j.features && j.features.enable_thinking, effort: j.features && j.features.reasoning_effort }; } catch (e) { return { note: 'parse fail', len: p.body.length }; }
}));
step('sse', responses.filter((r) => /chat\/completions/.test(r.url)).map((r) => ({
  len: r.body.length, hasToken: r.body.includes(TOKEN),
  toolEvents: (r.body.match(/"(tool|command|bash)[^"]*"/gi) || []).slice(0, 10),
})));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
fs.writeFileSync(`${outPrefix}.flagexp3.json`, JSON.stringify(report, null, 2));
console.log('WROTE', `${outPrefix}.flagexp3.json`);
for (const s of report.steps) console.log('--', s.name, JSON.stringify(s.value).slice(0, 600));
ws.close();
process.exit(0);
