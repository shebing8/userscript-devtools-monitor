#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 9222, match: '', out: './telemetry', bodyLimit: 131072, captureBodies: false, rawSecrets: false, list: false, preload: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--match') out.match = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--body-limit') out.bodyLimit = Number(argv[++i]);
    else if (a === '--capture-bodies') out.captureBodies = true;
    else if (a === '--raw-secrets') out.rawSecrets = true;
    else if (a === '--preload') out.preload.push(argv[++i]);
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const cfg = parseArgs(process.argv.slice(2));
if (cfg.help) {
  console.log('node cdp-monitor.mjs [--host 127.0.0.1] [--port 9222] [--match text] [--out dir] [--capture-bodies] [--body-limit 131072] [--raw-secrets] [--preload userscript.js] [--list]');
  process.exit(0);
}

const endpoint = `http://${cfg.host}:${cfg.port}`;
const secretKey = /authorization|cookie|set-cookie|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret/i;
const textTypes = new Set(['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch', 'EventSource', 'Manifest']);

function redact(value, depth = 0, key = '') {
  if (cfg.rawSecrets) return value;
  if (secretKey.test(key)) return '<redacted>';
  if (depth > 8) return '<max-depth>';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redact(v, depth + 1, k);
    return o;
  }
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1<redacted>')
      .replace(/((?:token|secret|password|passwd|api[-_]?key)\s*[=:]\s*)[^&\s"']+/gi, '$1<redacted>');
  }
  return value;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

let targets;
try {
  targets = await getJson(`${endpoint}/json/list`);
} catch (e) {
  console.error(`无法连接 ${endpoint}。请先运行 launch-debug-browser.ps1。\n${e.message}`);
  process.exit(2);
}

const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'));
if (cfg.list) {
  for (const p of pages) console.log(`${p.id}\t${p.title}\t${p.url}`);
  process.exit(0);
}

const needle = cfg.match.toLowerCase();
const selected = pages.find(p => !needle || `${p.title} ${p.url} ${p.id}`.toLowerCase().includes(needle));
if (!selected) {
  console.error(`没有匹配页面: ${cfg.match}`);
  for (const p of pages) console.error(`- ${p.id}  ${p.title}  ${p.url}`);
  process.exit(3);
}

fs.mkdirSync(cfg.out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.resolve(cfg.out, `session-${stamp}.jsonl`);
const stream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
const targetInfo = { id: selected.id, title: selected.title, url: selected.url };

function write(type, data = {}) {
  const record = { ts: new Date().toISOString(), type, target: targetInfo, data: redact(data) };
  stream.write(`${JSON.stringify(record)}\n`);
}

function previewRemoteObject(x) {
  if (!x) return null;
  if ('value' in x) return x.value;
  if (x.unserializableValue) return x.unserializableValue;
  return x.description ?? `[${x.type}${x.subtype ? `:${x.subtype}` : ''}]`;
}

class CDPClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
        return;
      }
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) Promise.resolve(fn(msg.params ?? {})).catch(e => write('monitor.handlerError', { method: msg.method, error: e.message }));
    });
    this.ws.addEventListener('close', () => {
      write('monitor.disconnected');
      console.log('\nCDP 已断开。');
      for (const p of this.pending.values()) p.reject(new Error('CDP disconnected'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 15000).unref();
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }
  close() { this.ws?.close(); }
}

const cdp = new CDPClient(selected.webSocketDebuggerUrl);
const contexts = new Map();
const scripts = new Map();
const responses = new Map();
let defaultContextId = null;

cdp.on('Runtime.executionContextCreated', ({ context }) => {
  contexts.set(context.id, context);
  if (context.auxData?.isDefault && context.auxData?.frameId) defaultContextId = context.id;
  write('Runtime.executionContextCreated', {
    id: context.id, name: context.name, origin: context.origin,
    auxData: context.auxData, uniqueId: context.uniqueId
  });
});
cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
  contexts.delete(executionContextId);
  if (defaultContextId === executionContextId) defaultContextId = null;
  write('Runtime.executionContextDestroyed', { executionContextId });
});
cdp.on('Runtime.executionContextsCleared', () => {
  contexts.clear(); defaultContextId = null; write('Runtime.executionContextsCleared');
});
cdp.on('Runtime.consoleAPICalled', p => {
  const args = p.args?.map(previewRemoteObject) ?? [];
  write('Runtime.consoleAPICalled', { consoleType: p.type, args, executionContextId: p.executionContextId, stackTrace: p.stackTrace });
  const marker = args[0] === '[USMON]' ? ' USMON' : '';
  console.log(`[console.${p.type}${marker}]`, ...args);
});
cdp.on('Runtime.exceptionThrown', p => {
  write('Runtime.exceptionThrown', p);
  console.log(`[exception] ${p.exceptionDetails?.text ?? 'Exception'} ${p.exceptionDetails?.exception?.description ?? ''}`);
});
cdp.on('Log.entryAdded', ({ entry }) => {
  write('Log.entryAdded', entry);
  console.log(`[log.${entry.level}] ${entry.text}`);
});
cdp.on('Debugger.scriptParsed', p => {
  scripts.set(p.scriptId, p);
  write('Debugger.scriptParsed', {
    scriptId: p.scriptId, url: p.url, startLine: p.startLine, startColumn: p.startColumn,
    endLine: p.endLine, endColumn: p.endColumn, executionContextId: p.executionContextId,
    hash: p.hash, sourceMapURL: p.sourceMapURL, hasSourceURL: p.hasSourceURL
  });
});
cdp.on('Debugger.paused', p => {
  write('Debugger.paused', p);
  console.log(`\n[PAUSED] reason=${p.reason}`);
  for (const f of p.callFrames ?? []) console.log(`  ${f.functionName || '<anonymous>'}  ${f.url || scripts.get(f.location?.scriptId)?.url || ''}:${(f.location?.lineNumber ?? 0) + 1}:${(f.location?.columnNumber ?? 0) + 1}`);
});
cdp.on('Debugger.resumed', () => { write('Debugger.resumed'); console.log('[RESUMED]'); });
cdp.on('Network.requestWillBeSent', p => {
  write('Network.requestWillBeSent', {
    requestId: p.requestId, loaderId: p.loaderId, documentURL: p.documentURL, type: p.type,
    request: p.request, initiator: p.initiator, redirectResponse: p.redirectResponse
  });
  if (['XHR', 'Fetch', 'Document', 'Script'].includes(p.type)) console.log(`[request ${p.type}] ${p.request.method} ${p.request.url}  id=${p.requestId}`);
});
cdp.on('Network.responseReceived', p => {
  responses.set(p.requestId, { type: p.type, response: p.response });
  write('Network.responseReceived', p);
  if (['XHR', 'Fetch', 'Document', 'Script'].includes(p.type)) console.log(`[response ${p.type}] ${p.response.status} ${p.response.url}  id=${p.requestId}`);
});
cdp.on('Network.loadingFailed', p => { write('Network.loadingFailed', p); console.log(`[failed] ${p.requestId} ${p.errorText}`); });
cdp.on('Network.loadingFinished', async p => {
  write('Network.loadingFinished', p);
  if (!cfg.captureBodies) return;
  const meta = responses.get(p.requestId);
  if (!meta || !textTypes.has(meta.type) || p.encodedDataLength > cfg.bodyLimit * 4) return;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
    const raw = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
    const clipped = raw.subarray(0, cfg.bodyLimit).toString('utf8');
    write('Network.responseBody', { requestId: p.requestId, url: meta.response.url, base64Encoded: body.base64Encoded, truncated: raw.length > cfg.bodyLimit, body: clipped });
  } catch (e) {
    write('Network.responseBodyError', { requestId: p.requestId, error: e.message });
  }
});
for (const method of [
  'Network.webSocketCreated', 'Network.webSocketWillSendHandshakeRequest', 'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketFrameSent', 'Network.webSocketFrameReceived', 'Network.webSocketFrameError', 'Network.webSocketClosed'
]) cdp.on(method, p => write(method, p));
cdp.on('Page.frameNavigated', p => write('Page.frameNavigated', p));
cdp.on('Page.javascriptDialogOpening', p => write('Page.javascriptDialogOpening', p));

await cdp.connect();
await Promise.all([
  cdp.send('Runtime.enable'),
  cdp.send('Network.enable', { maxTotalBufferSize: 100000000, maxResourceBufferSize: Math.max(cfg.bodyLimit * 2, 1000000), maxPostDataSize: cfg.bodyLimit }),
  cdp.send('Page.enable'),
  cdp.send('Log.enable'),
  cdp.send('Debugger.enable', { maxScriptsCacheSize: 100000000 })
]);
await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
write('monitor.connected', { endpoint, logPath, captureBodies: cfg.captureBodies, bodyLimit: cfg.bodyLimit });

const preloads = [];
async function installPreload(fileName, runNow = true) {
  const file = path.resolve(fileName);
  const source = fs.readFileSync(file, 'utf8');
  const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  const item = { file, identifier: added.identifier, bytes: Buffer.byteLength(source) };
  preloads.push(item);
  write('monitor.preloadInstalled', item);
  if (runNow) {
    const params = { expression: source, awaitPromise: true, returnByValue: true, userGesture: true };
    if (defaultContextId) params.contextId = defaultContextId;
    const result = await cdp.send('Runtime.evaluate', params);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  console.log(`已预载: ${file} (${item.bytes} bytes, id=${item.identifier})`);
  return item;
}

for (const file of cfg.preload) await installPreload(file, true);

console.log(`已连接: ${selected.title}\n${selected.url}`);
console.log(`日志: ${logPath}`);
console.log('输入 help 查看命令。');

function safeName(name, fallback) {
  const base = name ? path.basename(name.replace(/[<>:"/\\|?*]/g, '_')) : fallback;
  return path.resolve(cfg.out, base);
}

function printHelp() {
  console.log(`
help                         显示本帮助
targets                      列出 CDP 页面
contexts                     列出执行上下文
scripts [filter]             列出脚本
eval <js>                    主世界执行 JavaScript
eval@<contextId> <js>        指定 context 执行 JavaScript
pause | resume | reload      调试控制
body <requestId>             读取响应体
source <scriptId> [file]     导出脚本源码
dom [file]                   导出 DOMSnapshot
snapshot [file]              导出 MHTML
inject <file>                当前页面主世界注入脚本
preload <file>               当前页注入，并在后续导航自动注入
preloads                     列出已安装的 CDP preload
clear | quit                 清屏或退出
`);
}

async function evaluate(expression, contextId = defaultContextId) {
  const params = { expression, awaitPromise: true, returnByValue: true, generatePreview: true, userGesture: true };
  if (contextId) params.contextId = contextId;
  const r = await cdp.send('Runtime.evaluate', params);
  if (r.exceptionDetails) {
    console.log(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    write('command.evalException', { expression, contextId, exceptionDetails: r.exceptionDetails });
  } else {
    const val = previewRemoteObject(r.result);
    console.dir(val, { depth: 8, colors: true });
    write('command.evalResult', { expression, contextId, result: val });
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'cdp> ', terminal: !!process.stdin.isTTY });
rl.prompt();
async function handleLine(line) {
  const s = line.trim();
  try {
    if (!s) {}
    else if (s === 'help') printHelp();
    else if (s === 'clear') console.clear();
    else if (s === 'quit' || s === 'exit') rl.close();
    else if (s === 'pause') await cdp.send('Debugger.pause');
    else if (s === 'resume') await cdp.send('Debugger.resume');
    else if (s === 'reload') await cdp.send('Page.reload', { ignoreCache: true });
    else if (s === 'preloads') {
      for (const p of preloads) console.log(`${p.identifier}\t${p.bytes} bytes\t${p.file}`);
    } else if (s.startsWith('preload ')) {
      await installPreload(s.slice(8).trim(), true);
    } else if (s.startsWith('inject ')) {
      const file = path.resolve(s.slice(7).trim());
      const source = fs.readFileSync(file, 'utf8');
      const params = { expression: source, awaitPromise: true, returnByValue: true, userGesture: true };
      if (defaultContextId) params.contextId = defaultContextId;
      const result = await cdp.send('Runtime.evaluate', params);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      write('monitor.scriptInjected', { file, bytes: Buffer.byteLength(source) });
      console.log(`已注入: ${file}`);
    }
    else if (s === 'targets') {
      const now = await getJson(`${endpoint}/json/list`);
      for (const p of now.filter(x => x.type === 'page')) console.log(`${p.id}\t${p.title}\t${p.url}`);
    } else if (s === 'contexts') {
      for (const c of contexts.values()) console.log(`${c.id}\t${c.name || '<unnamed>'}\t${c.origin}\tdefault=${!!c.auxData?.isDefault}\ttype=${c.auxData?.type ?? ''}`);
    } else if (s === 'scripts' || s.startsWith('scripts ')) {
      const filter = s.slice(7).trim().toLowerCase();
      for (const p of scripts.values()) {
        const label = p.url || '<inline>';
        if (!filter || `${label} ${p.scriptId}`.toLowerCase().includes(filter)) console.log(`${p.scriptId}\tctx=${p.executionContextId}\t${label}`);
      }
    } else if (s.startsWith('eval@')) {
      const m = s.match(/^eval@(\d+)\s+([\s\S]+)$/);
      if (!m) throw new Error('格式: eval@<contextId> <JavaScript>');
      await evaluate(m[2], Number(m[1]));
    } else if (s.startsWith('eval ')) {
      await evaluate(s.slice(5));
    } else if (s.startsWith('body ')) {
      const requestId = s.slice(5).trim();
      const body = await cdp.send('Network.getResponseBody', { requestId });
      const raw = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
      const file = safeName(`body-${requestId}.bin`, `body-${requestId}.bin`);
      fs.writeFileSync(file, raw);
      console.log(`${raw.length} bytes -> ${file}`);
    } else if (s.startsWith('source ')) {
      const m = s.match(/^source\s+(\S+)(?:\s+(.+))?$/);
      if (!m) throw new Error('格式: source <scriptId> [file]');
      const result = await cdp.send('Debugger.getScriptSource', { scriptId: m[1] });
      const file = safeName(m[2], `script-${m[1]}.js`);
      fs.writeFileSync(file, result.scriptSource ?? result.bytecode ?? '', 'utf8');
      console.log(`已保存 -> ${file}`);
    } else if (s === 'dom' || s.startsWith('dom ')) {
      await cdp.send('DOMSnapshot.enable');
      const result = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [], includePaintOrder: true, includeDOMRects: true, includeBlendedBackgroundColors: false, includeTextColorOpacities: false });
      const file = safeName(s.slice(3).trim(), `dom-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(result), 'utf8');
      console.log(`已保存 -> ${file}`);
    } else if (s === 'snapshot' || s.startsWith('snapshot ')) {
      const result = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
      const file = safeName(s.slice(8).trim(), `snapshot-${Date.now()}.mhtml`);
      fs.writeFileSync(file, result.data, 'utf8');
      console.log(`已保存 -> ${file}`);
    } else {
      console.log('未知命令；输入 help。');
    }
  } catch (e) {
    console.error(`错误: ${e.message}`);
    write('command.error', { command: s, error: e.message });
  } finally {
    if (!rl.closed) rl.prompt();
  }
}

let commandQueue = Promise.resolve();
rl.on('line', line => {
  commandQueue = commandQueue.then(() => handleLine(line));
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return Promise.resolve();
  shuttingDown = true;
  write('monitor.exit');
  cdp.close();
  return new Promise(resolve => stream.end(resolve));
}
rl.on('close', () => {
  commandQueue.finally(async () => { await shutdown(); process.exit(0); });
});
process.on('SIGINT', () => rl.close());
process.on('uncaughtException', async e => { console.error(e); write('monitor.uncaughtException', { error: e.stack ?? e.message }); await shutdown(); process.exit(1); });
