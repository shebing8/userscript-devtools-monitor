(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const r = ta.getBoundingClientRect();
  const y0 = r.top - 70;
  const y1 = r.bottom + 70;
  const btns = [...document.querySelectorAll('button')]
    .map((b) => ({ b, q: b.getBoundingClientRect() }))
    .filter(({ q }) => q.width > 0 && q.top >= y0 && q.bottom <= y1)
    .map(({ b, q }) => ({
      x: Math.round(q.x),
      w: Math.round(q.width),
      aria: b.getAttribute('aria-label'),
      txt: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 14),
      vb: b.querySelector('svg') ? b.querySelector('svg').getAttribute('viewBox') : null,
      cls: b.className.toString().slice(0, 50),
    }));
  return { count: btns.length, btns };
})()
