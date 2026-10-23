// 实验：chat 会话（type:"default"）里请求级注入 features.flags=["general_agent"]
// 看服务端是否给沙箱工具、前端是否能渲染 agent 回合
// 用法: node zai-flagexp.mjs [chatUrl] [outPrefix]

import fs from 'node:fs';

const HOST = '127.0.0.1:9222';
const chatUrl = process.argv[2] || 'https://zchat.z.ai/c/f5368b08-004d-4470-aa96-61bee1e6d77e';
const outPrefix = process.argv[3] || 't-flagexp';

// 在页面最早的 fetch 上再包一层：POST chat/completions 时把 flags 改成 general_agent
// VM 装的 v3.2.1 自己的 wrapper 只覆盖 enable_thinking 等字段、不动 flags，两层顺序无所谓
const WRAP = `(function(){ if (window.__FLAG_EXP__) return; window.__FLAG_EXP__={patched:0,log:[]};
  var nf=window.fetch;
  window.fetch=function(input,init){ try{
    var url=typeof input==='string'?input:(input&&input.url)||'';
    var meth=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    if(meth==='POST'&&/chat\\/completions/.test(url)&&init&&typeof init.body==='string'){
      var j=JSON.parse(init.body);
      if(j&&j.features){ j.features.flags=['general_agent'];
        window.__FLAG_EXP__.log.push({features:j.features,chat_id:j.chat_id});
        var nb=JSON.stringify(j);
        window.__FLAG_EXP__.patched+=1;
        return nf.call(this,input,Object.assign({},init,{body:nb}));
      }
    }
  }catch(e){ window.__FLAG_EXP__.log.push({error:String(e)}); }
  return nf.apply(this,arguments); }; })()`;

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
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
    if (rq.method === 'POST' && /\/api\/v\d+\/chat\/completions/.test(rq.url)) {
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
        responses.push({ url: u, status: r.result?.base64Encoded ? 'b64' : 'raw', body: text.slice(0, 30000) });
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
await send('Page.navigate', { url: chatUrl });
await wait(9000);

const report = { chatUrl, steps: [] };
const step = (name, value) => report.steps.push({ name, value });

step('wrapBoot', await evl('window.__FLAG_EXP__ ? {patched: window.__FLAG_EXP__.patched} : {error: "wrap missing"}'));

// 发送强制沙箱任务
step('send', await evl(`(async () => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '必须调用代码沙箱工具执行 bash 命令：echo FLAGEXP_OK_$((7*7)) ，不要只用文字回答，直接执行工具');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const btn = document.querySelector('.sendMessageButton');
  if (!btn) return { error: 'no send button' };
  if (btn.disabled) return { error: 'send disabled' };
  btn.click();
  return { clicked: true };
})()`));

// 轮询到回复稳定（最多 90s）
let settled = null;
for (let i = 0; i < 30; i++) {
  await wait(3000);
  settled = await evl(`(() => {
    const asst = [...document.querySelectorAll('[class*=markdown]')];
    const last = asst[asst.length - 1];
    const tail = (last ? last.innerText : '').slice(-400);
    const toolBlocks = [...document.querySelectorAll('div,span')].filter((x) => /已运行\\s*\\d+\\s*条命令|正在运行|执行命令|bash/i.test((x.innerText || '')) && x.children.length < 3).length;
    const thinking = /思考中|生成中/.test(document.body.innerText);
    return { tail, toolBlocks, thinking, len: tail.length };
  })()`);
  if (settled && !settled.thinking && settled.tail && settled.tail.length > 5) {
    await wait(4000);
    const again = await evl('(() => { const a=[...document.querySelectorAll("[class*=markdown]")]; const l=a[a.length-1]; return (l?l.innerText:"").slice(-400); })()');
    if (again === settled.tail) break;
    settled.tail = again;
  }
}
step('settled', settled);

step('wrapState', await evl('({patched: window.__FLAG_EXP__ && window.__FLAG_EXP__.patched, log: (window.__FLAG_EXP__ && window.__FLAG_EXP__.log || []).slice(-3)})'));

// 出站请求体里 flags 是否真的是 general_agent
step('outboundFlags', posts.map((p) => {
  try { const j = JSON.parse(p.body); return { chat_id: j.chat_id, features: j.features }; } catch (e) { return { parseError: String(e) }; }
}));

// 服务端是否报错（签名校验/权限）
step('responses', responses.map((r) => ({ url: r.url, head: r.body.slice(0, 1500), err: /\"error\"|403|401|invalid|signature/i.test(r.body.slice(0, 3000)) })));

step('healState', await evl('window.__ZAI_HEAL__ ? {reloads: window.__ZAI_HEAL__.reloads, seen: window.__ZAI_HEAL__.seen, log: window.__ZAI_HEAL__.log} : null'));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  fs.writeFileSync(`${outPrefix}.png`, Buffer.from(shot.result.data, 'base64'));
  report.screenshot = `${outPrefix}.png`;
}

report.posts = posts.map((p) => ({ url: p.url, bodyLen: p.body.length }));
fs.writeFileSync(`${outPrefix}.flagexp.json`, JSON.stringify(report, null, 2));
console.log('WROTE', `${outPrefix}.flagexp.json`, 'posts:', posts.length, 'responses:', responses.length);
console.log(JSON.stringify({ steps: report.steps.map((s) => s.name), outboundFlags: report.outboundFlags, errFlags: report.responses.map((r) => r.err) }, null, 2));
ws.close();
process.exit(0);
