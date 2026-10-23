(() => {
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
    const m = ((init && init.method) || 'GET').toUpperCase();
    if (m === 'POST' && /\/chat\/completions/.test(url)) {
      window.__ABORTED__ = { url: url.split('?')[0], body: init && init.body ? String(init.body).slice(0, 600) : null };
      return Promise.reject(new Error('TEST_ABORT'));
    }
    return of.apply(this, arguments);
  };
})();
