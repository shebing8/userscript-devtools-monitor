// 实验2：新建真·default chat 会话，fetch+XHR 双层注入 features.flags=["general_agent"]
// 用法: node zai-flagexp2.mjs [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const outPrefix = process.argv[2] || 'u-flagexp2';
const START = 'https://zchat.z.ai/';

const WRAP = `(function(){
  if (window.__FLAG2__) return; window.__FLAG2__={patched:0,via:[],err:[]};
  function rewrite(bodyStr, via){
    try{
      var j=JSON.parse(bodyStr);
      if(!j||typeof j!=='object') return bodyStr;
      var f=j.features||(j.chat&&j.chat.features)||null;
      if(!f){ f=j.features={}; }
      var before=JSON.stringify(f.flags);
      f.flags=['general_agent'];
      window.__FLAG2__.patched+=1;
      window.__FLAG2__.via.push({via:via,before:before});
      return JSON.stringify(j);
    }catch(e){ window.__FLAG2__.err.push(String(e)); return bodyStr; }
  }
  var nf=window.fetch;
  window.fetch=function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      var meth=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      if(meth==='POST'&&/chat\\/completions|\\/api\\/v\\d+\\/(agent|chat)\\b/.test(url)){
        if(init&&typeof init.body==='string'){
          return nf.call(this,input,Object.assign({},init,{body:rewrite(init.body,'fetch-str')}));
        }
        if(input&&typeof Request!=='undefined'&&input instanceof Request&&!init){
          return input.clone().text().then(function(t){
            return nf.call(this,new Request(input,{body:rewrite(t,'fetch-req')}));
          }.bind(this));
        }
      }
    }catch(e){ window.__FLAG2__.err.push('fetchwrap:'+e); }
    return nf.apply(this,arguments);
  };
  var nOpen=XMLHttpRequest.prototype.open, nSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){ this.__f2={m:String(m).toUpperCase(),u:String(u||'')}; return nOpen.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(b){
    var i=this.__f2;
    if(i&&i.m==='POST'&&/chat\\/completions/.test(i.u)&&typeof b==='string') b=rewrite(b,'xhr');
    return nSend.call(this,b);
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
    if (rq.method === 'POST' && /\/api\/v\d+\/(chat\/completions|chats\/new|agent|chat)\b/.test(rq.url)) {
      posts.push({ url: rq.url, body: rq.postData || '' });
    }
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

const report = { START, steps: [] };
const step = (name, value) => report.steps.push({ name, value });

step('wrapBoot', await evl('!!window.__FLAG2__'));

// 新建会话（默认 Chat 模式）
step('newChat', await evl(`(() => {
  const el = [...document.querySelectorAll('button,a,div[role=button]')].find((x) => /^新聊天$/.test((x.innerText || '').trim()));
  if (!el) return { error: 'no new chat button' };
  el.click(); return { clicked: true };
})()`));
await wait(5000);
step('href', await evl('location.href'));

// 发送强制沙箱任务
const TOKEN = 'FLAG2_OK_' + (11 * 13);
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

// 轮询到稳定（最多 100s）
let settled = null;
for (let i = 0; i < 34; i++) {
  await wait(3000);
  settled = await evl(`(() => {
    const asst = [...document.querySelectorAll('[class*=markdown]')];
    const last = asst[asst.length - 1];
    const tail = (last ? last.innerText : '').slice(-500);
    const running = /思考中|生成中/.test(document.body.innerText);
    const hasTool = /已运行\\s*\\d+\\s*条命令/.test(document.body.innerText);
    const hasToken = document.body.innerText.includes('${TOKEN}');
    return { tail, running, hasTool, hasToken };
  })()`);
  if (settled && !settled.running && settled.tail && settled.tail.length > 5) {
    await wait(4000);
    const again = await evl('(() => { const a=[...document.querySelectorAll("[class*=markdown]")]; const l=a[a.length-1]; return (l?l.innerText:"").slice(-500); })()');
    if (again === settled.tail) break;
    settled.tail = again;
  }
}
step('settled', settled);

step('wrapState', await evl('window.__FLAG2__'));
step('hrefAfter', await evl('location.href'));

// 会话持久 type
const cid = await evl('(location.href.match(/\\/c\\/([\\w-]+)/)||[])[1]');
if (cid) {
  step('chatType', await evl(`(async () => {
    const t = localStorage.getItem('token');
    const res = await fetch('/api/v1/chats/${cid}', { headers: { Authorization: 'Bearer ' + (t || '') } });
    const j = await res.json().catch(() => null);
    return { status: res.status, type: j && j.type, title: j && j.title };
  })()`));
}

// 真实出站体（网络层证据）
step('outbound', posts.map((p) => {
  try { const j = JSON.parse(p.body); return { url: p.url.replace(/\?.*/, ''), flags: j.features && j.features.flags, type: j.type, model: j.model }; }
  catch (e) { return { url: p.url.replace(/\?.*/, ''), note: 'no body or parse fail', len: p.body.length }; }
}));

// SSE 里是否有真实工具事件与 token 输出
step('sseEvidence', responses.map((r) => ({
  url: r.url.replace(/\?.*/, ''),
  len: r.body.length,
  hasToken: r.body.includes(TOKEN),
  toolHits: (r.body.match(/tool|command|bash|sandbox/gi) || []).length,
  head: r.body.slice(0, 400),
  err: /"error"|403|401|invalid|permission/i.test(r.body.slice(0, 2000)),
})));

step('healState', await evl('window.__ZAI_HEAL__ ? {reloads: window.__ZAI_HEAL__.reloads, seen: window.__ZAI_HEAL__.seen} : null'));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));

fs.writeFileSync(`${outPrefix}.flagexp2.json`, JSON.stringify(report, null, 2));
console.log('WROTE', `${outPrefix}.flagexp2.json`);
for (const s of report.steps) console.log('--', s.name, JSON.stringify(s.value).slice(0, 700));
ws.close();
process.exit(0);
