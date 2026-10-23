(() => {
  window.__CAP = [];
  const of = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (/\/api\//.test(url)) {
        window.__CAP.push({ kind: 'fetch', method, url, body: init && init.body ? String(init.body).slice(0, 4000) : null });
      }
    } catch (e) {}
    return of.apply(this, arguments);
  };
  const os = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    try {
      if (typeof d === 'string') window.__CAP.push({ kind: 'ws', url: this.url, body: d.slice(0, 4000) });
    } catch (e) {}
    return os.apply(this, arguments);
  };
  const oo = XMLHttpRequest.prototype.open;
  const osd = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try { window.__CAP.push({ kind: 'xhr', url: this.__u, body: b ? String(b).slice(0, 4000) : null }); } catch (e) {}
    return osd.apply(this, arguments);
  };
  return 'hooked';
})()
