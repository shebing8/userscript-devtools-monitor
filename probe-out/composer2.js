(() => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const eds = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(vis);
  const ta = eds[eds.length - 1];
  let box = ta;
  while (box.parentElement) {
    const r = box.getBoundingClientRect();
    if (r.width > 500 && r.height > 60 && box.textContent.includes('WeChat')) break;
    box = box.parentElement;
  }
  const rect = box.getBoundingClientRect();
  const btns = [...box.querySelectorAll('button')].map((b, i) => {
    const r = b.getBoundingClientRect();
    const svg = b.querySelector('svg');
    return {
      i,
      x: Math.round(r.x - rect.x),
      y: Math.round(r.y - rect.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      vis: vis(b),
      aria: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      viewBox: svg ? svg.getAttribute('viewBox') : null,
      d: svg ? (svg.querySelector('path')?.getAttribute('d') || '').slice(0, 60) : null,
    };
  });
  return { box: { w: Math.round(rect.width), h: Math.round(rect.height), cls: box.className.toString().slice(0, 120) }, count: btns.length, btns };
})()
