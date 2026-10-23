// 反向验证：把 hidden-thinking / web_search 塞回 features，看控件是否消失
(() => {
  const RE = /\/api\/v1\/chats\/[0-9a-fA-F-]{36}(\?|$)/;
  const ADD = [
    { type: 'web_search', server: 'web_search_h', status: 'hidden' },
    { type: 'hidden-thinking', server: 'hidden-thinking', status: 'hidden' },
  ];
  const fix = (json) => {
    if (!json || !json.chat || !Array.isArray(json.chat.features)) return null;
    let changed = false;
    for (const f of ADD) {
      if (!json.chat.features.some((x) => x.type === f.type)) {
        json.chat.features.push(f);
        changed = true;
      }
    }
    return changed ? json : null;
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const res = await of.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      if (!RE.test(url)) return res;
      if (!(res.headers.get('content-type') || '').includes('json')) return res;
      const json = fix(await res.clone().json());
      if (!json) return res;
      const h = new Headers(res.headers);
      h.delete('content-length');
      h.delete('content-encoding');
      window.__DIRTY__ = (window.__DIRTY__ || 0) + 1;
      return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: h });
    } catch (e) {
      return res;
    }
  };
})();
