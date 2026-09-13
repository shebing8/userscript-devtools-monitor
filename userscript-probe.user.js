// ==UserScript==
// @name         Userscript State Probe
// @namespace    local.userscript.monitor
// @version      1.0.0
// @description  页面级 fetch/XHR/WebSocket/路由/存储/DOM 观测探针，与 cdp-monitor.mjs 配合使用
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    // 建议改成目标域名，例如 /example\.com$/；null 表示所有 @match 页面。
    urlAllow: null,
    observeFetch: true,
    observeXHR: true,
    observeWebSocket: true,
    observeHistory: true,
    observeStorage: true,
    observeDom: true,
    domFlushMs: 300,
    bodyPreviewLimit: 16384,
    rawSecrets: false
  };

  if (CONFIG.urlAllow && !CONFIG.urlAllow.test(location.hostname)) return;
  if (window.__USMON__) return;

  const originals = [];
  const secret = /authorization|cookie|token|secret|password|passwd|api[-_]?key/i;
  const now = () => new Date().toISOString();
  const clip = value => {
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); }
    catch { text = String(value); }
    return text.length > CONFIG.bodyPreviewLimit ? `${text.slice(0, CONFIG.bodyPreviewLimit)}…<truncated>` : text;
  };
  const scrub = (value, key = '', depth = 0) => {
    if (CONFIG.rawSecrets) return value;
    if (secret.test(key)) return '<redacted>';
    if (depth > 6) return '<max-depth>';
    if (Array.isArray(value)) return value.map(v => scrub(v, '', depth + 1));
    if (value && typeof value === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(value)) o[k] = scrub(v, k, depth + 1);
      return o;
    }
    return value;
  };
  const emit = (type, data = {}) => {
    const event = { ts: now(), type, data: scrub(data), href: location.href };
    console.debug('[USMON]', event);
    window.dispatchEvent(new CustomEvent('__usmon_event__', { detail: event }));
    return event;
  };
  const replace = (obj, key, value) => {
    const old = obj[key];
    originals.push(() => { try { obj[key] = old; } catch {} });
    obj[key] = value;
    return old;
  };

  if (CONFIG.observeFetch && typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    replace(window, 'fetch', async function usmonFetch(input, init = {}) {
      const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const url = input instanceof Request ? input.url : String(input);
      const method = init.method || (input instanceof Request ? input.method : 'GET');
      emit('fetch.start', { id, url, method, headers: Object.fromEntries(new Headers(init.headers || (input instanceof Request ? input.headers : undefined))), body: init.body ? clip(init.body) : undefined });
      const started = performance.now();
      try {
        const response = await originalFetch.apply(this, arguments);
        const meta = { id, url: response.url, status: response.status, ok: response.ok, redirected: response.redirected, type: response.type, ms: +(performance.now() - started).toFixed(1), headers: Object.fromEntries(response.headers) };
        try {
          const ct = response.headers.get('content-type') || '';
          if (/json|text|javascript|xml|html|form-urlencoded/i.test(ct)) meta.body = clip(await response.clone().text());
        } catch (e) { meta.bodyError = String(e); }
        emit('fetch.end', meta);
        return response;
      } catch (error) {
        emit('fetch.error', { id, url, method, ms: +(performance.now() - started).toFixed(1), error: String(error), stack: error?.stack });
        throw error;
      }
    });
  }

  if (CONFIG.observeXHR && window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const oldOpen = proto.open;
    const oldSend = proto.send;
    const oldSetHeader = proto.setRequestHeader;
    const info = new WeakMap();
    replace(proto, 'open', function(method, url, ...rest) {
      info.set(this, { id: `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, method, url: String(url), headers: {}, started: 0 });
      return oldOpen.call(this, method, url, ...rest);
    });
    replace(proto, 'setRequestHeader', function(name, value) {
      const m = info.get(this); if (m) m.headers[name] = value;
      return oldSetHeader.call(this, name, value);
    });
    replace(proto, 'send', function(body) {
      const m = info.get(this) || { id: `x${Date.now().toString(36)}`, method: '?', url: '?', headers: {} };
      m.started = performance.now();
      emit('xhr.start', { ...m, body: body == null ? undefined : clip(body) });
      this.addEventListener('loadend', () => {
        let responsePreview;
        try { if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') responsePreview = clip(this.response); } catch {}
        emit('xhr.end', { id: m.id, method: m.method, url: this.responseURL || m.url, status: this.status, statusText: this.statusText, responseType: this.responseType, ms: +(performance.now() - m.started).toFixed(1), headers: this.getAllResponseHeaders(), body: responsePreview });
      }, { once: true });
      return oldSend.call(this, body);
    });
  }

  if (CONFIG.observeWebSocket && window.WebSocket) {
    const NativeWebSocket = window.WebSocket;
    class MonitoredWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        emit('ws.create', { id, url: String(url), protocols });
        this.addEventListener('open', () => emit('ws.open', { id, url: this.url }));
        this.addEventListener('message', e => emit('ws.receive', { id, data: clip(e.data) }));
        this.addEventListener('error', () => emit('ws.error', { id }));
        this.addEventListener('close', e => emit('ws.close', { id, code: e.code, reason: e.reason, wasClean: e.wasClean }));
        const nativeSend = this.send;
        this.send = data => { emit('ws.send', { id, data: clip(data) }); return nativeSend.call(this, data); };
      }
    }
    Object.defineProperties(MonitoredWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING }, OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING }, CLOSED: { value: NativeWebSocket.CLOSED }
    });
    replace(window, 'WebSocket', MonitoredWebSocket);
  }

  if (CONFIG.observeHistory) {
    for (const name of ['pushState', 'replaceState']) {
      const old = history[name];
      replace(history, name, function(state, title, url) {
        const result = old.apply(this, arguments);
        emit(`history.${name}`, { state, title, url: url == null ? null : String(url), href: location.href });
        return result;
      });
    }
    window.addEventListener('popstate', e => emit('history.popstate', { state: e.state }));
    window.addEventListener('hashchange', e => emit('history.hashchange', { oldURL: e.oldURL, newURL: e.newURL }));
  }

  if (CONFIG.observeStorage) {
    for (const name of ['setItem', 'removeItem', 'clear']) {
      const old = Storage.prototype[name];
      replace(Storage.prototype, name, function(...args) {
        let area = 'storage';
        try { area = this === localStorage ? 'localStorage' : this === sessionStorage ? 'sessionStorage' : area; } catch {}
        emit(`storage.${name}`, { area, args });
        return old.apply(this, args);
      });
    }
  }

  let observer;
  if (CONFIG.observeDom) {
    let queue = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      const batch = queue;
      queue = [];
      const summary = { count: batch.length, attributes: {}, added: 0, removed: 0, text: 0 };
      for (const m of batch) {
        if (m.type === 'attributes') summary.attributes[m.attributeName] = (summary.attributes[m.attributeName] || 0) + 1;
        if (m.type === 'childList') { summary.added += m.addedNodes.length; summary.removed += m.removedNodes.length; }
        if (m.type === 'characterData') summary.text++;
      }
      emit('dom.mutations', summary);
    };
    observer = new MutationObserver(records => {
      queue.push(...records);
      if (!timer) timer = setTimeout(flush, CONFIG.domFlushMs);
    });
    const start = () => observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  }

  window.addEventListener('error', e => emit('window.error', { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno, error: e.error?.stack || String(e.error || '') }), true);
  window.addEventListener('unhandledrejection', e => emit('window.unhandledrejection', { reason: e.reason?.stack || String(e.reason) }), true);

  const api = Object.freeze({
    version: '1.0.0',
    emit,
    mark: (name, data) => emit('mark', { name, data }),
    status: () => ({ version: '1.0.0', href: location.href, config: { ...CONFIG }, originals: originals.length, observer: !!observer }),
    snapshot: () => {
      const data = {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        localStorage: (() => { try { return { ...localStorage }; } catch (e) { return { error: String(e) }; } })(),
        sessionStorage: (() => { try { return { ...sessionStorage }; } catch (e) { return { error: String(e) }; } })(),
        scripts: [...document.scripts].map(s => ({ src: s.src, type: s.type, textLength: s.src ? 0 : s.textContent.length })),
        resources: performance.getEntriesByType('resource').map(r => ({ name: r.name, initiatorType: r.initiatorType, duration: r.duration, transferSize: r.transferSize }))
      };
      emit('snapshot', data);
      return data;
    },
    watch: (obj, label = 'object') => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) throw new TypeError('watch 需要 object/function');
      return new Proxy(obj, {
        get(target, prop, receiver) { const value = Reflect.get(target, prop, receiver); emit('watch.get', { label, prop: String(prop), value: clip(value) }); return value; },
        set(target, prop, value, receiver) { emit('watch.set', { label, prop: String(prop), value: clip(value) }); return Reflect.set(target, prop, value, receiver); },
        apply(target, thisArg, args) { emit('watch.apply', { label, args: args.map(clip) }); return Reflect.apply(target, thisArg, args); }
      });
    },
    restore: () => {
      observer?.disconnect();
      while (originals.length) originals.pop()();
      emit('probe.restored');
      try { delete window.__USMON__; } catch {}
    }
  });

  Object.defineProperty(window, '__USMON__', { value: api, configurable: true });
  emit('probe.ready', api.status());
})();

