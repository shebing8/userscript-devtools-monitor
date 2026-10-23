// 自愈模块自检：合成 chat:finish 未渲染事件 → 应触发一次性 reload（sessionStorage 防循环旗标可证）
const chatUrl = process.argv[2] || 'https://zchat.z.ai/c/f5368b08-004d-4470-aa96-61bee1e6d77e';
const SOURCE = (await import('node:fs')).readFileSync('../zai-restore-classic-composer.user.js', 'utf8');
const HOST = '127.0.0.1:9222';

const target = await (await fetch(`http://${HOST}/json/new?${encodeURIComponent(chatUrl)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let seq = 0;
const pend = new Map();
const navs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Page.frameNavigated' && !m.params.frame.parentFrameId) navs.push({ t: Date.now(), url: (m.params.frame.url || '').slice(0, 80) });
});
const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
const evl = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: SOURCE });
await send('Page.navigate', { url: chatUrl });
await wait(13000);

console.log('boot heal obj:', await evl('JSON.stringify(window.__ZAI_HEAL__ || null)'));

// 1) 合成"已 finish 但未渲染"→ 5s 后应 reload
const armed = await evl(`(function(){
  var id='SELFTEST_'+Date.now();
  document.dispatchEvent(new CustomEvent('chat:start',{detail:{id:id}}));
  document.dispatchEvent(new CustomEvent('chat:finish',{detail:{id:id,content:'ZZQQ 这段合成正文绝不会出现在页面上面上面面对对对'}}));
  return id;
})()`);
console.log('armed id:', armed);
await wait(9000);

const flag = await evl(`JSON.stringify({flag: sessionStorage.getItem('zai_heal_'+'${armed}'), navs: ${navs.length}})`);
console.log('after synthetic:', flag, '| navigations observed:', navs.length);

// 2) 合成"已 finish 且已渲染"（内容取页面真实文字）→ 不应 reload
const before = await evl('location.reload ? "ok" : "nope"');
const armed2 = await evl(`(function(){
  var real = (document.body.innerText||'').slice(50,90);
  var id2='OKTEST_'+Date.now();
  document.dispatchEvent(new CustomEvent('chat:start',{detail:{id:id2}}));
  document.dispatchEvent(new CustomEvent('chat:finish',{detail:{id:id2,content:real}}));
  return id2;
})()`);
await wait(9000);
const flag2 = await evl(`JSON.stringify({flag2: sessionStorage.getItem('zai_heal_'+'${armed2}'), url: location.href.slice(0,60)})`);
console.log('after rendered-sim:', flag2, '| navigations total:', navs.length);
ws.close();
