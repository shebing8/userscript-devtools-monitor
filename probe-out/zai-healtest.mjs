// 在卡住的标签页上尝试多种恢复手段，找出不用整页刷新就能让已生成内容渲染的方法
const chatId = process.argv[2] || 'f5368b08';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const tabs = list.filter((x) => x.type === 'page' && x.url.includes(chatId));
if (!tabs.length) { console.log('no tab'); process.exit(0); }

const tryOn = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };
  await send('Runtime.enable');
  const EXPR = `(async function(){
    function tailInfo(){
      var s=Array.prototype.slice.call(document.querySelectorAll('[class*=markdown]')).map(function(n){return n.innerText}).join('\\n');
      var i=s.lastIndexOf('INSTEST'); if(i<0) i=s.lastIndexOf('STUCKDIAG'); if(i<0) i=s.lastIndexOf('PACETEST');
      return { i:i, after: i>=0 ? s.slice(i+40).trim().slice(0,80) : '(none)', len: i>=0? s.slice(i+40).trim().length : 0 };
    }
    function waitRender(ms){ return new Promise(function(res){ var t0=Date.now(); (function poll(){ var ti=tailInfo(); if(ti.len>8){res(ti);return;} if(Date.now()-t0>ms){res(ti);return;} setTimeout(poll,500); })(); }); }
    var results = [];
    var before = tailInfo(); results.push({ step: 'before', len: before.len });
    if (before.len > 8) return JSON.stringify({ tab: 'already-rendered', results });

    // 1) resize 事件触发重渲染
    window.dispatchEvent(new Event('resize'));
    await new Promise(function(r){setTimeout(r,2500)});
    var a = tailInfo(); results.push({ step: 'resize', len: a.len });
    if (a.len > 8) return JSON.stringify({ tab: 'fixed-by-resize', results });

    // 2) visibilitychange fake
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await new Promise(function(r){setTimeout(r,2500)});
    var b = tailInfo(); results.push({ step: 'visibility+focus', len: b.len });
    if (b.len > 8) return JSON.stringify({ tab: 'fixed-by-visibility', results });

    // 3) SPA 导航离开再回来（history + popstate）
    var back = location.href;
    history.pushState({}, '', '/');
    await new Promise(function(r){setTimeout(r,1500)});
    history.popState ? null : null;
    history.back();
    await new Promise(function(r){setTimeout(r,4000)});
    var c = tailInfo(); results.push({ step: 'spa-nav-back', href: location.href.slice(0,60), len: c.len });
    if (c.len > 8) return JSON.stringify({ tab: 'fixed-by-spa-nav', results });

    return JSON.stringify({ tab: 'not-fixed', results: results, href: location.href });
  })()`;
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  ws.close();
  return r.result?.result?.value || JSON.stringify(r.result?.exceptionDetails || {}).slice(0, 200);
};

for (const t of tabs) {
  console.log('TAB', t.id.slice(0, 8), await tryOn(t));
}
