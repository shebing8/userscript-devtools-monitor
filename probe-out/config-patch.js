// 试验：关掉 unified_agent，看是否回到老版输入框
(() => {
  const RE = /\/api\/config\b/;
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const res = await of.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      if (!RE.test(url)) return res;
      const json = await res.clone().json();
      if (!json || !json.features) return res;
      json.features.unified_agent = false;
      window.__CFG_PATCHED__ = (window.__CFG_PATCHED__ || 0) + 1;
      const h = new Headers(res.headers);
      h.delete('content-length');
      h.delete('content-encoding');
      return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: h });
    } catch (e) {
      return res;
    }
  };
})();
