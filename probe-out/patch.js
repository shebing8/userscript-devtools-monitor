// 试验版：把 general_agent 会话的 features 改回 default 的那套
(() => {
  const CHAT_RE = /\/api\/v1\/chats\/[0-9a-fA-F-]{36}(\?|$)/;
  const DROP = new Set(['web_search', 'hidden-thinking']);

  const fix = (json) => {
    if (!json || !json.chat || !Array.isArray(json.chat.features)) return null;
    const before = json.chat.features.length;
    json.chat.features = json.chat.features.filter((f) => !DROP.has(f.type));
    if (json.chat.features.length === before) return null;
    window.__ZAI_RESTORE_HOOK__ = (window.__ZAI_RESTORE_HOOK__ || 0) + 1;
    return json;
  };

  const rebuild = (res, json) => {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(json), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      if (CHAT_RE.test(url) && (res.headers.get('content-type') || '').includes('json')) {
        const json = fix(await res.clone().json());
        if (json) return rebuild(res, json);
      }
    } catch (e) {
      /* 放行原响应 */
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__zaiUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (typeof this.__zaiUrl === 'string' && CHAT_RE.test(this.__zaiUrl)) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState !== 4) return;
        try {
          const json = fix(JSON.parse(this.responseText));
          if (!json) return;
          Object.defineProperty(this, 'responseText', { value: JSON.stringify(json), configurable: true });
          Object.defineProperty(this, 'response', { value: JSON.stringify(json), configurable: true });
        } catch (e) {
          /* 非 JSON，忽略 */
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  window.__ZAI_RESTORE_HOOK__ = 0;
})();
