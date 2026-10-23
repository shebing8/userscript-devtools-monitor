// 实验6：DELETE 测试会话释放沙箱 → API 建 type:default 会话 → 页面内 wrap 注入 flags → 发送验证
// 用法: node zai-flagexp6.mjs [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const outPrefix = process.argv[2] || 'y-flagexp6';
const DELETE_FIRST = ['59d791c3-bb82-4ff2-b301-d002181488b4', '3a8b7c04-1eef-4355-9671-75c4bbf57b06', '4cc7b79a-e964-4812-ac1b-39b0ccc034c0'];

const WRAP = `(function(){
  if (window.__FLAG6__) return; window.__FLAG6__={patched:0,hits:[],err:[]};
  function rewrite(t){
    if(!t) return t;
    try{
      var j=JSON.parse(t);
      if(!j||typeof j!=='object') return t;
      var f=j.features||(j.chat&&j.chat.features)||null;
      if(!f){ f=j.features={}; }
      var before=JSON.stringify(f.flags);
      f.flags=['general_agent'];
      window.__FLAG6__.patched+=1; window.__FLAG6__.hits.push({before:before});
      return JSON.stringify(j);
    }catch(e){ window.__FLAG6__.err.push(String(e)); return t; }
  }
  var nf=window.fetch;
  window.fetch=function(input,init){
    try{
      var url=typeof input==='string'?input:(input&&input.url)||'';
      var meth=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      if(meth==='POST'&&/chat\\/completions/.test(url)&&init&&typeof init.body==='string'){
        return nf.call(this,input,Object.assign({},init,{body:rewrite(init.body)}));
      }
    }catch(e){ window.__FLAG6__.err.push('fw:'+e); }
    return nf.apply(this,arguments);
  };
})()`;

const START = 'https://zchat.z.ai/';
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
  if (m.method === 'Network.responseReceived' && /\/api\/v\d+\/chat\/completions/.test(m.params.response.url)) {
    idToUrl.set('res:' + m.params.requestId, m.params.response.url);
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

// 1) 删除测试会话（释放沙箱配额）+ 2) API 建 type:default 会话
step('provision', await evl(`(async () => {
  const t = localStorage.getItem('token');
  const H = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
  const del = [];
  for (const id of ${JSON.stringify(DELETE_FIRST)}) {
    const r = await fetch('/api/v1/chats/' + id, { method: 'DELETE', headers: H });
    del.push({ id, status: r.status });
  }
  const body = {
    chat: { id: '', title: 'FlagExp6 sandbox probe', models: ['glm-5.3'], params: {},
      history: { messages: {}, currentId: null }, tags: [], flags: [], features: [],
      mcp_servers: [], enable_thinking: true, reasoning_effort: 'max', auto_web_search: false, message_version: 1 },
    type: 'default',
  };
  const cr = await fetch('/api/v1/chats/new', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const cj = await cr.json().catch(() => null);
  const cid = cj && (cj.id || (cj.data && cj.data.id));
  let check = null;
  if (cid) {
    const gr = await fetch('/api/v1/chats/' + cid, { headers: H });
    const gj = await gr.json().catch(() => null);
    check = { status: gr.status, type: gj && gj.type };
  }
  return { del, createStatus: cr.status, cid, check };
})()`));

const cid = report.steps[0].v?.cid;
if (!cid || report.steps[0].v?.check?.type !== 'default') {
  console.log('PROVISION NOT default:', JSON.stringify(report.steps[0].v));
  fs.writeFileSync(`${outPrefix}.flagexp6.json`, JSON.stringify(report, null, 2));
  ws.close(); process.exit(1);
}

// 3) 进入该会话，注入 wrapper 生效（新文档），发送沙箱任务
const TOKEN = 'FLAG6_OK_' + (19 * 23);
await send('Page.navigate', { url: `https://zchat.z.ai/c/${cid}` });
await wait(7000);
step('wrapBoot', await evl('!!window.__FLAG6__'));
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
step('wrap', await evl('window.__FLAG6__'));

// 会话 type 是否被 agent 回合改写
step('chatTypeAfter', await evl(`(async () => {
  const t = localStorage.getItem('token');
  const res = await fetch('/api/v1/chats/${cid}', { headers: { Authorization: 'Bearer ' + (t || '') } });
  const j = await res.json().catch(() => null);
  return { status: res.status, type: j && j.type };
})()`));

step('outbound', posts.map((p) => {
  try { const j = JSON.parse(p.body); const f = j.features || {}; return { url: p.url, flags: f.flags, type: j.type }; } catch (e) { return { url: p.url, len: p.body.length }; }
}));
step('sse', responses.map((r) => ({
  len: r.body.length, hasToken: r.body.includes(TOKEN),
  toolEvents: [...new Set(r.body.match(/"(tool_call|tool_response)"/g) || [])],
  quotaError: /最大活跃沙箱|sandbox.*limit|maximum.*sandbox/i.test(r.body),
  errSnippet: (r.body.match(/.{0,100}(error|denied|invalid|forbidden).{0,100}/i) || [null])[0],
})));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
fs.writeFileSync(`${outPrefix}.flagexp6.json`, JSON.stringify(report, null, 2));
console.log('WROTE', `${outPrefix}.flagexp6.json`);
for (const s of report.steps) console.log('--', s.n, JSON.stringify(s.v).slice(0, 800));
ws.close();
process.exit(0);
