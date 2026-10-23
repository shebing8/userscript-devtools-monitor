(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const editables = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(vis);
  if (!editables.length) return { error: 'no visible editable' };
  const ta = editables[editables.length - 1];
  let root = ta;
  for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
  const btns = [...root.querySelectorAll('button')].map((b) => ({
    text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    aria: b.getAttribute('aria-label'),
    title: b.getAttribute('title'),
    testid: b.getAttribute('data-testid'),
    vis: vis(b),
    cls: (b.className || '').toString().slice(0, 60),
  }));
  const svgUse = [...root.querySelectorAll('svg use')].map((u) => u.getAttribute('xlink:href') || u.getAttribute('href'));
  const icons = [...root.querySelectorAll('svg')].map((s) => (s.getAttribute('class') || '') + '|' + (s.getAttribute('viewBox') || ''));
  return {
    url: location.href,
    tag: ta.tagName,
    placeholder: ta.getAttribute('placeholder') || ta.getAttribute('data-placeholder') || ta.getAttribute('aria-label'),
    buttonCount: btns.length,
    btns,
    svgUse: [...new Set(svgUse)],
    iconCount: icons.length,
    rootText: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  };
})()
