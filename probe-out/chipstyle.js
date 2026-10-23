(() => {
  const c = document.querySelector('[data-zai-chip]');
  if (!c) return { chip: 'gone' };
  const cs = getComputedStyle(c);
  const r = c.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    text: c.innerText,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    color: cs.color,
    bg: cs.backgroundColor,
    border: cs.borderTopWidth + ' ' + cs.borderTopColor,
    opacity: cs.opacity,
    topElement: top ? top.tagName + '.' + (top.className || '').toString().slice(0, 40) : null,
    tabs: 0,
  };
})()
