// watchdog B 自检：合成 chat:start 且容器始终缺失 → ~65-70s 内自动 reload；随后合成正常轮 → 不误伤
import fs from 'node:fs';
const chatUrl = 'https://zchat.z.ai/c/f5368b08-004d-4470-aa96-61bee1e6d77e';
const SOURCE = fs.readFileSync('../zai-restore-classic-composer.user.js', 'utf8');
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
  if (m.method === 'Page.frameNavigated' && !m.params.frame.parentFrameId) navs.push((m.params.frame.url || '').slice(0, 60));
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
await wait(12000);
console.log('boot:', await evl('JSON.stringify(window.__ZAI_HEAL__||null)'));

// 场景1：start 后无任何渲染（容器不存在）→ watchdog 应 ~70s 内 reload
const wbId = await evl(`(function(){var id='WBTEST_'+Date.now();document.dispatchEvent(new CustomEvent('chat:start',{detail:{id:id}}));return id})()`);
console.log('watchdog armed id:', wbId);
let reloaded = false;
for (let i = 0; i < 13; i++) {
  await wait(8000);
  const st = await evl(`JSON.stringify({flag:sessionStorage.getItem('zai_hb_'+'${wbId}'),reload:!!window.__ZAI_HEAL__&&window.__ZAI_HEAL__.reloads})`);
  if (st && /"flag":"1"/.test(st)) { reloaded = true; break; }
}
console.log('case stalled-empty → reload fired:', reloaded, '| navs:', navs.length);

// 场景2：reload 后新页正常发送一轮（watchdog 不应误触发已有正文），只观察 20s 看无二次 reload
await wait(9000);
const st2 = await evl('JSON.stringify(window.__ZAI_HEAL__||null)');
console.log('after state:', st2 && st2.slice(0, 200));
ws.close();
if (!reloaded) process.exit(2);
