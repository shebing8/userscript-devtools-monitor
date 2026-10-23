// ==UserScript==
// @name         Z.ai 旧版输入框（联网搜索 + 深度思考）
// @namespace    https://github.com/shebing8
// @version      2.0.0
// @description  还原被 hidden 的 web_search / hidden-thinking 能力；无论站点发的是旧版还是新版输入框，都保证输入框里有可点的「深度思考」档位和联网开关，并在发送请求里强制生效
// @author       ENI
// @match        https://zchat.z.ai/*
// @match        https://chat.z.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DROP = new Set(['web_search', 'hidden-thinking']);
  const CHAT_RE = /\/api\/(?:v\d+\/)?chats?\b/i;
  const MODEL_RE = /\/api\/(?:models|config)\b/i;
  const COMPLETION_RE = /\/chat\/completions\b/i;

  const LEVELS = [
    { key: 'max', label: '最高', effort: 'max' },
    { key: 'high', label: '高', effort: 'high' },
    { key: 'low', label: '低', effort: 'low' },
    { key: 'off', label: '关闭', effort: 'max', thinking: false },
  ];

  const stats = { scanned: 0, rewritten: 0, sent: 0 };
  const state = { level: 'max' };

  try {
    const saved = localStorage.getItem('zai_classic_level');
    if (saved && LEVELS.some((l) => l.key === saved)) state.level = saved;
  } catch (e) {}

  const level = () => LEVELS.find((l) => l.key === state.level) || LEVELS[2];

  /* ---------- 1. 去掉 hidden 标记，让原生控件回来 ---------- */

  function fixHolder(holder) {
    if (!holder || !Array.isArray(holder.features)) return false;
    const kept = holder.features.filter((f) => !(f && DROP.has(f.type)));
    if (kept.length === holder.features.length) return false;
    holder.features = kept;
    return true;
  }

  function patchChat(json) {
    if (!json || typeof json !== 'object') return false;
    let changed = fixHolder(json);
    if (fixHolder(json.chat)) changed = true;
    if (Array.isArray(json.data)) {
      for (const item of json.data) {
        if (fixHolder(item)) changed = true;
        if (item && fixHolder(item.chat)) changed = true;
      }
    }
    return changed;
  }

  function patchModels(json) {
    const arr = Array.isArray(json) ? json : json && Array.isArray(json.data) ? json.data : null;
    if (!arr) return false;
    let changed = false;
    for (const model of arr) {
      const sps = model && model.info && model.info.meta && model.info.meta.suggestion_prompts;
      if (!Array.isArray(sps)) continue;
      for (const sp of sps) if (fixHolder(sp)) changed = true;
    }
    return changed;
  }

  function rebuild(res, json) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
  }

  /* ---------- 2. 发送时强制写入思考档位 ---------- */

  function forceFeatures(body) {
    if (typeof body !== 'string') return body;
    try {
      const json = JSON.parse(body);
      if (!json || !json.features || typeof json.features !== 'object') return body;
      const lv = level();
      json.features.enable_thinking = lv.thinking !== false;
      json.features.reasoning_effort = lv.effort;
      if (typeof state.web === 'boolean') json.features.auto_web_search = state.web;
      window.__ZAI_LAST_BODY__ = { effort: json.features.reasoning_effort, thinking: json.features.enable_thinking, web: json.features.auto_web_search };
      stats.sent += 1;
      return JSON.stringify(json);
    } catch (e) {
      return body;
    }
  }

  /* ---------- 3. 输入框里补一个可点的档位按钮 ---------- */

  const CSS = `
    .zai-lv-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
      border:1px solid rgba(0,0,0,.12);border-radius:8px;background:transparent;cursor:pointer;
      font-size:13px;line-height:1;color:rgba(0,0,0,.72);white-space:nowrap;
      transition:background .15s,border-color .15s}
    .zai-lv-chip:hover{background:rgba(0,0,0,.04)}
    .zai-lv-chip[data-off="1"]{color:rgba(0,0,0,.38)}
    .zai-lv-dot{width:6px;height:6px;border-radius:999px;background:#2f6fed}
    .zai-lv-chip[data-off="1"] .zai-lv-dot{background:rgba(0,0,0,.25)}
  `;

  function styleOnce() {
    if (document.getElementById('zai-lv-style')) return;
    const el = document.createElement('style');
    el.id = 'zai-lv-style';
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  function makeChip() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zai-lv-chip';
    btn.dataset.zaiChip = '1';
    btn.title = '点击切换思考档位：低 / 高 / 最高 / 关闭';

    const dot = document.createElement('span');
    dot.className = 'zai-lv-dot';
    const text = document.createElement('span');
    btn.append(dot, text);

    const render = () => {
      const lv = level();
      text.textContent = '深度思考 · ' + lv.label;
      btn.dataset.off = lv.thinking === false ? '1' : '0';
    };
    render();

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const i = LEVELS.findIndex((l) => l.key === state.level);
      state.level = LEVELS[(i + 1) % LEVELS.length].key;
      try { localStorage.setItem('zai_classic_level', state.level); } catch (err) {}
      render();
    });

    btn.__render = render;
    return btn;
  }

  function ensureChip() {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    styleOnce();

    let box = ta;
    for (let i = 0; i < 8 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelector('.sendMessageButton')) break;
    }
    if (!box || !box.querySelector('.sendMessageButton')) return;

    const send = box.querySelector('.sendMessageButton');
    const wechat = [...box.querySelectorAll('button')].find((b) => /WeChat/.test(b.innerText || ''));
    // 右侧工具条：优先落在 WeChat 那一排，其次退到发送键所在容器
    const anchor = wechat || send;
    const target = anchor && anchor.parentElement ? anchor.parentElement : box;

    // 原生已经给了可见的思考控件，就不重复插
    if (/深度思考|思考强度/.test(box.innerText || '')) {
      const mine = box.querySelector('[data-zai-chip]');
      if (mine) mine.remove();
      return;
    }

    const existing = box.querySelector('[data-zai-chip]');
    if (existing) {
      if (existing.parentElement === target) {
        existing.__render();
        return;
      }
      existing.remove();
    }

    const chip = makeChip();
    if (anchor && anchor.parentElement) target.insertBefore(chip, anchor);
    else box.appendChild(chip);
  }

  /* ---------- 4. 挂钩 ---------- */

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      if (method === 'POST' && COMPLETION_RE.test(url) && init && typeof init.body === 'string') {
        const body = forceFeatures(init.body);
        if (body !== init.body) {
          const res = await nativeFetch.call(this, input, Object.assign({}, init, { body }));
          return res;
        }
      }

      const res = await nativeFetch.apply(this, arguments);
      if (!CHAT_RE.test(url) && !MODEL_RE.test(url)) return res;
      if (!(res.headers.get('content-type') || '').includes('json')) return res;

      stats.scanned += 1;
      const json = await res.clone().json();
      const changed = CHAT_RE.test(url) ? patchChat(json) : patchModels(json);
      if (!changed) return res;
      stats.rewritten += 1;
      return rebuild(res, json);
    } catch (e) {
      return nativeFetch.apply(this, arguments);
    }
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__zaiUrl = url;
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__zaiUrl;
    if (typeof url === 'string' && COMPLETION_RE.test(url)) body = forceFeatures(body);
    if (typeof url === 'string' && (CHAT_RE.test(url) || MODEL_RE.test(url))) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState !== 4) return;
        try {
          stats.scanned += 1;
          const json = JSON.parse(this.responseText);
          const changed = CHAT_RE.test(url) ? patchChat(json) : patchModels(json);
          if (!changed) return;
          const text = JSON.stringify(json);
          stats.rewritten += 1;
          Object.defineProperty(this, 'responseText', { value: text, configurable: true });
          Object.defineProperty(this, 'response', {
            value: this.responseType === 'json' ? json : text,
            configurable: true,
          });
        } catch (e) {}
      });
    }
    return nativeSend.call(this, body);
  };

  /* ---------- 5. 路由变化后补按钮 ---------- */

  let tick = 0;
  setInterval(() => {
    tick += 1;
    if (tick % 2 === 0) return; // 约 1 秒一次
    ensureChip();
  }, 500);

  window.addEventListener('load', ensureChip);
  window.__ZAI_CLASSIC_COMPOSER__ = stats;
})();
