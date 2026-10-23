// ==UserScript==
// @name         Z.ai 经典输入框完整还原
// @namespace    https://github.com/shebing8
// @version      3.2.1
// @description  还原经典 composer：常驻「联网搜索」+「深度思考 · 档位」两个 pill 控件（原生裸图标收编进 pill），剥离 chat/models 的 hidden 标记、关掉 unified_agent，并在建会话/发送请求里强制写入 enable_thinking / reasoning_effort / web_search / auto_web_search；新增 chat 模式渲染竞态自愈：①流已结束（chat:finish）但正文未上屏 ②流中途中断（只有 chat:start 迟迟没有 chat:finish、正文冻结）两种卡死都自动恢复
// @author       ENI
// @match        https://zchat.z.ai/*
// @match        https://chat.z.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    // 这三类 hidden 标记一律剥掉：联网键、思考键、工具选择键
    unhide: ['web_search', 'hidden-thinking', 'tool_selector'],
    unhideConfig: true,   // /api/config: unified_agent=false + enable_web_search=true
    forceCreate: true,    // 新建会话（POST /api/v1/chats/new）body 也按本脚本档位写
    forceInBody: true,    // 发送体以本脚本档位为准
    syncNativeSlider: true, // 把档位回写进 chat.enable_thinking / chat.reasoning_effort，让原生滑块显示一致
    labeledPills: true,   // 用带文字的旧版 pill 控件，并把原生裸图标藏掉，避免两个联网开关
    healStuck: true,      // chat 模式竞态自愈：流已结束（chat:finish）但正文没上屏时，自动刷新恢复
  };

  const LEVELS = [
    { key: 'low', label: '低', effort: 'low' },
    { key: 'high', label: '高', effort: 'high' },
    { key: 'max', label: '最高', effort: 'max' },
    { key: 'off', label: '关闭', effort: 'max', thinking: false },
  ];

  const LS = { level: 'zai_classic_level', web: 'zai_classic_web' };
  const stats = { config: 0, models: 0, chats: 0, creates: 0, forced: 0 };
  const state = {
    level: (() => {
      try {
        const s = localStorage.getItem(LS.level);
        return LEVELS.some((l) => l.key === s) ? s : 'max';
      } catch (e) { return 'max'; }
    })(),
    web: (() => {
      try { return localStorage.getItem(LS.web) === '1'; } catch (e) { return false; }
    })(),
  };

  const level = () => LEVELS.find((l) => l.key === state.level) || LEVELS[2];
  const save = () => {
    try {
      localStorage.setItem(LS.level, state.level);
      localStorage.setItem(LS.web, state.web ? '1' : '0');
    } catch (e) {}
  };

  const HIDDEN = new Set(CFG.unhide);
  const CHAT_RE = /\/api\/v\d+\/chats\b/i;
  const MODEL_RE = /\/api\/(?:v\d+\/)?models\b/i;
  const CONFIG_RE = /\/api\/config\b/i;
  const COMPLETION_RE = /\/(?:chat\/completions|completions)\b|\/api\/v\d+\/(?:agent|chat)\b/i;
  const CREATE_RE = /\/api\/v\d+\/chats\/new\b/i;

  /* ---------- 1. 响应侧：拆掉 hidden 标记 ---------- */

  function unhideHolder(holder) {
    if (!holder || !Array.isArray(holder.features)) return false;
    const kept = holder.features.filter((f) => !(f && HIDDEN.has(f.type) && f.status === 'hidden'));
    if (kept.length === holder.features.length) return false;
    holder.features = kept;
    return true;
  }

  function writeChatState(holder) {
    if (!CFG.syncNativeSlider || !holder || typeof holder !== 'object') return false;
    const lv = level();
    let changed = false;
    if ('enable_thinking' in holder && holder.enable_thinking !== (lv.thinking !== false)) {
      holder.enable_thinking = lv.thinking !== false; changed = true;
    }
    if ('reasoning_effort' in holder && holder.reasoning_effort !== lv.effort) {
      holder.reasoning_effort = lv.effort; changed = true;
    }
    return changed;
  }

  function patchChat(json) {
    if (!json || typeof json !== 'object') return false;
    let c = unhideHolder(json) || unhideHolder(json.chat);
    if (writeChatState(json.chat) || writeChatState(json)) c = true;
    if (Array.isArray(json.data)) {
      for (const item of json.data) {
        if (unhideHolder(item) || unhideHolder(item.chat)) c = true;
        if (writeChatState(item.chat)) c = true;
      }
    }
    return c;
  }

  function patchModels(json) {
    const arr = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
    if (!arr) return false;
    let changed = false;
    for (const model of arr) {
      const sp = model?.info?.meta?.suggestion_prompts;
      if (!Array.isArray(sp)) continue;
      for (const s of sp) if (unhideHolder(s)) changed = true;
      if (unhideHolder(model)) changed = true;
    }
    return changed;
  }

  function patchConfig(json) {
    if (!CFG.unhideConfig || !json || typeof json !== 'object' || !json.features) return false;
    let changed = false;
    const f = json.features;
    if (f.unified_agent) { f.unified_agent = false; changed = true; }
    if (f.enable_web_search === false) { f.enable_web_search = true; changed = true; }
    const pf = json.permissions && json.permissions.features;
    if (pf && pf.web_search === false) { pf.web_search = true; changed = true; }
    return changed;
  }

  function applyPatch(url, json) {
    if (CHAT_RE.test(url)) { stats.chats += 1; return patchChat(json); }
    if (MODEL_RE.test(url)) { stats.models += 1; return patchModels(json); }
    if (CONFIG_RE.test(url)) { stats.config += 1; return patchConfig(json); }
    return false;
  }

  function rebuild(res, json) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(json), {
      status: res.status, statusText: res.statusText, headers,
    });
  }

  /* ---------- 2. 请求侧：新建会话去 agent 化 + 发送体强制档位 ---------- */

  // 新会话 body 默认写 reasoning_effort:"max"，和 chip 档位不一致会让服务端记录与 UI 显示分叉
  function forceCreateBody(body) {
    if (!CFG.forceCreate || typeof body !== 'string') return body;
    let json;
    try { json = JSON.parse(body); } catch (e) { return body; }
    const holder = json && (json.chat || json);
    if (!holder || typeof holder !== 'object') return body;
    const lv = level();
    const before = JSON.stringify(holder.enable_thinking) + holder.reasoning_effort + holder.auto_web_search;
    holder.enable_thinking = lv.thinking !== false;
    holder.reasoning_effort = lv.effort;
    holder.auto_web_search = state.web;
    if (Array.isArray(holder.features)) unhideHolder(holder);
    if (before === JSON.stringify(holder.enable_thinking) + holder.reasoning_effort + holder.auto_web_search) return body;
    stats.creates += 1;
    return JSON.stringify(json);
  }

  function forceFeatures(body) {
    if (!CFG.forceInBody || typeof body !== 'string') return body;
    let json;
    try { json = JSON.parse(body); } catch (e) { return body; }
    if (!json || typeof json !== 'object') return body;

    const lv = level();
    const thinking = lv.thinking !== false;
    let target = json.features && typeof json.features === 'object'
      ? json.features
      : json.chat && json.chat.features && typeof json.chat.features === 'object'
        ? json.chat.features
        : (json.features = {});

    target.enable_thinking = thinking;
    target.reasoning_effort = lv.effort;
    // 站点用两个字段：web_search 是显式开启，auto_web_search 是自动判断，经典模式两者同步跟随
    if ('web_search' in target || 'auto_web_search' in target) target.web_search = state.web;
    target.auto_web_search = state.web;
    // 已经存在的顶层同名字段一起对齐，避免新旧两套读取路径打架
    for (const key of ['enable_thinking', 'reasoning_effort', 'auto_web_search']) {
      for (const holder of [json, json.chat]) {
        if (holder && typeof holder === 'object' && key in holder) {
          holder[key] = key === 'enable_thinking' ? thinking : key === 'reasoning_effort' ? lv.effort : state.web;
        }
      }
    }
    stats.forced += 1;
    window.__ZAI_LAST_BODY__ = {
      effort: target.reasoning_effort, thinking: target.enable_thinking,
      web: target.auto_web_search, web_explicit: target.web_search,
    };
    return JSON.stringify(json);
  }

  /* ---------- 3. 经典 chips ---------- */

  const CSS = `
    .zai-cls-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
      border:.5px solid var(--color-border-default,rgba(0,0,0,.14));border-radius:9999px;
      background:transparent;color:var(--color-text-tertiary,rgba(0,0,0,.55));
      font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;
      transition:background .2s,color .2s,border-color .2s}
    .zai-cls-chip:hover{background:var(--color-bg-hover,rgba(0,0,0,.04))}
    .zai-cls-chip[data-active="true"]{color:var(--color-accent-blue-default,#2f6fed);
      border-color:var(--color-accent-blue-default,#2f6fed);
      background:var(--color-accent-blue-subtle,rgba(47,111,237,.08))}
    .zai-cls-chip svg{flex:0 0 auto}
  `;

  function styleOnce() {
    if (document.getElementById('zai-cls-style')) return;
    const el = document.createElement('style');
    el.id = 'zai-cls-style';
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
  }

  const ICON_WEB = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.33333 8H14.6667M1.33333 8C1.33333 11.6819 4.3181 14.6667 8 14.6667M1.33333 8C1.33333 4.3181 4.3181 1.33333 8 1.33333M14.6667 8C14.6667 11.6819 11.6819 14.6667 8 14.6667M14.6667 8C14.6667 4.3181 11.6819 1.33333 8 1.33333" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.33"/></svg>';
  const ICON_THINK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.33333V14.6667M1.33333 8H14.6667M3.06667 3.06667L12.9333 12.9333M12.9333 3.06667L3.06667 12.9333" stroke="currentColor" stroke-linecap="round" stroke-width="1.33"/></svg>';

  function nativeWebButton() {
    return [...document.querySelectorAll('button')].find(
      (b) => !b.id && !b.getAttribute('aria-label') &&
        /1\.33333 8H14\.6667/.test(b.querySelector('svg path')?.getAttribute('d') || '')
    );
  }

  function makeChip(kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zai-cls-chip';
    btn.dataset.zaiChip = kind;
    btn.innerHTML = (kind === 'web' ? ICON_WEB : ICON_THINK) + '<span></span>';
    const label = btn.querySelector('span');

    const render = () => {
      if (kind === 'web') {
        label.textContent = '联网搜索';
        btn.dataset.active = state.web ? 'true' : 'false';
        btn.title = state.web ? '联网搜索已开启，点击关闭' : '联网搜索已关闭，点击开启';
      } else {
        const lv = level();
        label.textContent = lv.thinking === false ? '深度思考' : '深度思考 · ' + lv.label;
        btn.dataset.active = lv.thinking === false ? 'false' : 'true';
        btn.title = '思考档位：低 / 高 / 最高 / 关闭（点击循环）';
      }
    };
    render();

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (kind === 'web') {
        state.web = !state.web;
      } else {
        const i = LEVELS.findIndex((l) => l.key === state.level);
        state.level = LEVELS[(i + 1) % LEVELS.length].key;
      }
      save();
      if (typeof schedule === 'function') schedule();
      document.querySelectorAll('[data-zai-chip]').forEach((c) => c.__render && c.__render());
    });

    btn.__render = render;
    return btn;
  }

  function composerBox() {
    const ta = document.querySelector('textarea');
    if (!ta) return null;
    let box = ta;
    for (let i = 0; i < 12 && box.parentElement; i++) {
      box = box.parentElement;
      if (box.querySelector('.sendMessageButton')) return box;
    }
    return null;
  }

  let webSyncGuard = { want: null, ts: 0, tries: 0 };

  function ensureChips() {
    const box = composerBox();
    if (!box) return;
    styleOnce();

    const row = box.querySelector('.modelSelectorButton')?.parentElement?.parentElement || box;
    const anchor = box.querySelector('.modelSelectorButton') || box.querySelector('.sendMessageButton');
    const host = anchor && anchor.parentElement ? anchor.parentElement : row;

    const native = nativeWebButton();
    if (native) {
      native.style.display = CFG.labeledPills ? 'none' : '';
      const on = native.getAttribute('data-active') === 'true';
      if (on !== state.web) {
        const now = Date.now();
        if (webSyncGuard.want === state.web && now - webSyncGuard.ts < 1200) {
          webSyncGuard.tries += 1;
          // 原生控件拒绝跟随（某些模式禁用联网），就以原生状态为准，避免死循环点击
          if (webSyncGuard.tries > 3) { state.web = on; save(); }
        } else {
          webSyncGuard = { want: state.web, ts: now, tries: 0 };
          native.click();
        }
      }
    }

    const want = CFG.labeledPills || !native ? ['web', 'think'] : ['think'];
    for (const c of [...host.querySelectorAll('[data-zai-chip]')]) {
      if (!want.includes(c.dataset.zaiChip)) c.remove();
    }
    for (const kind of want) {
      let el = host.querySelector(`[data-zai-chip="${kind}"]`);
      if (!el) {
        el = makeChip(kind);
        host.insertBefore(el, anchor || host.firstChild);
      } else if (el.parentElement !== host) {
        host.insertBefore(el, anchor || host.firstChild);
        el.__render();
      } else {
        el.__render();
      }
    }
  }

  /* ---------- 3.5 chat 渲染竞态自愈 ---------- */

  // 站点 bug（实测复现，与脚本无关）：服务端 prompt cache 命中秒回时，chat 模式
  // 前端能完整收到流，但 requestIdleCallback 渲染队列在收尾竞态里丢了内容，
  // 只有重新挂载（刷新）才从历史把正文读出来；agent 模式不受影响。
  // 站点自己在事件总线派发 chat:start / chat:finish（detail 带 id、content），
  // 以 finish 后 5 秒正文仍未上屏为判据，替用户刷新一次；同一 id 只自愈一次防循环。

  const heal = { watching: null, log: [], reloads: 0, seen: { start: 0, finish: 0 } };

  //  watchdog B：只有 chat:start、迟迟等不到 chat:finish 的中途断流变体。
  //  每 8 秒采样 message-<id> 容器文本：全程空白且静默 60s → 自愈；
  //  只有零星残字（<120，如「思考过程」标签）且静默 120s → 自愈。
  //  agent 长任务有持续增量或成段正文，两条都够不着，不会误伤。
  let hbTimer = null;
  function healContainerText(id) {
    const esc = window.CSS && CSS.escape ? CSS.escape(id) : id;
    const el = document.querySelector('.message-' + esc);
    return el ? (el.innerText || '').trim() : '';
  }
  function stopWatchdog() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }
  function startWatchdog(id) {
    stopWatchdog();
    const t0 = Date.now();
    let lastLen = -1;
    let lastChange = Date.now();
    hbTimer = setInterval(() => {
      try {
        if (heal.watching !== id) { stopWatchdog(); return; } // finish 路径或新一轮接管
        if (document.visibilityState !== 'visible') return;   // 后台页回前台会自己补渲染
        const text = healContainerText(id);
        const len = text.length;
        if (len !== lastLen) { lastLen = len; lastChange = Date.now(); return; }
        const quiet = Date.now() - lastChange;
        const since = Date.now() - t0;
        const stuckEmpty = len === 0 && quiet > 60000 && since > 60000;
        const stuckPartial = len > 0 && len < 120 && quiet > 120000 && since > 120000;
        if (!stuckEmpty && !stuckPartial) return;
        stopWatchdog();
        const flag = 'zai_hb_' + id;
        try {
          if (sessionStorage.getItem(flag)) return;
          sessionStorage.setItem(flag, '1');
        } catch (e) {}
        heal.reloads += 1;
        heal.log.push({ id, t: Date.now(), why: stuckEmpty ? 'stalled-empty' : 'stalled-partial' });
        location.reload();
      } catch (e) {}
    }, 8000);
  }

  function healRendered(id, content) {
    try {
      if (document.visibilityState !== 'visible') return true; // 后台页回到前台会自己补渲染，别抢
      const el = document.querySelector('.message-' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
      if (el) return (el.innerText || '').trim().length > 0; // 站点按 message-<id> 命名渲染容器
      // 兜底：类名换代时退回正文探针（取正文中段，避开用户回声首尾）
      const norm = (s) => String(s || '').replace(/\s+/g, '').slice(4, 28);
      const needle = norm(content);
      if (!needle) return true;
      return norm(document.body && document.body.innerText).includes(needle);
    } catch (e) { return true; }
  }
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    try {
      const type = ev && ev.type;
      if (type === 'chat:start' && ev.detail) {
        heal.seen.start += 1;
        heal.watching = ev.detail.id || null;
        if (CFG.healStuck && heal.watching) startWatchdog(heal.watching);
      } else if (type === 'chat:finish' && CFG.healStuck && ev.detail && ev.detail.id) {
        heal.seen.finish += 1;
        stopWatchdog(); // 正常收尾，交给下面的空判检查
        const id = ev.detail.id;
        const content = ev.detail.content;
        setTimeout(() => {
          try {
            if (heal.watching !== id) return;                    // 已进入下一轮，别抢
            if (healRendered(id, content)) return;               // 正常渲染，无事发生
            const flag = 'zai_heal_' + id;
            try {
              if (sessionStorage.getItem(flag)) return;          // 该条已自愈过，防循环
              sessionStorage.setItem(flag, '1');
            } catch (e) {}
            heal.reloads += 1;
            heal.log.push({ id, t: Date.now() });
            location.reload();
          } catch (e) {}
        }, 5000);
      }
    } catch (e) {}
    return nativeDispatch.apply(this, arguments);
  };

  /* ---------- 4. 挂钩 ---------- */

  const nativeFetch = window.fetch;
  window.fetch = async function (input, init) {
    let realInput = input;
    let realInit = init;
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

      if (method === 'POST' && CREATE_RE.test(url) && init && typeof init.body === 'string') {
        const body = forceCreateBody(init.body);
        if (body !== init.body) realInit = Object.assign({}, init, { body });
      } else if (method === 'POST' && COMPLETION_RE.test(url)) {
        if (init && typeof init.body === 'string') {
          const body = forceFeatures(init.body);
          if (body !== init.body) realInit = Object.assign({}, init, { body });
        } else if (input && typeof Request !== 'undefined' && input instanceof Request) {
          const text = await input.clone().text();
          const body = forceFeatures(text);
          if (body !== text) {
            realInput = new Request(input, { body, method: input.method, headers: input.headers });
          }
        }
      }
    } catch (e) { /* 保持原始请求 */ }

    const res = await nativeFetch.call(this, realInput, realInit);
    try {
      const url = typeof input === 'string' ? input : input?.url || res.url || '';
      if (!(CHAT_RE.test(url) || MODEL_RE.test(url) || CONFIG_RE.test(url))) return res;
      if (!(res.headers.get('content-type') || '').includes('json')) return res;
      const json = await res.clone().json();
      if (!applyPatch(url, json)) return res;
      return rebuild(res, json);
    } catch (e) {
      return res;
    }
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__zai = { method: String(method).toUpperCase(), url: String(url || '') };
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const info = self.__zai;
    if (info) {
      if (info.method === 'POST' && CREATE_RE.test(info.url)) body = forceCreateBody(body);
      else if (info.method === 'POST' && COMPLETION_RE.test(info.url)) body = forceFeatures(body);
      if (CHAT_RE.test(info.url) || MODEL_RE.test(info.url) || CONFIG_RE.test(info.url)) {
        self.addEventListener('readystatechange', () => {
          if (self.readyState !== 4) return;
          try {
            const json = JSON.parse(self.responseText);
            if (!applyPatch(info.url, json)) return;
            const text = JSON.stringify(json);
            Object.defineProperty(self, 'responseText', { value: text, configurable: true });
            Object.defineProperty(self, 'response', {
              value: self.responseType === 'json' ? json : text, configurable: true,
            });
          } catch (e) {}
        });
      }
    }
    return nativeSend.call(this, body);
  };

  /* ---------- 5. UI 跟随路由与重渲染 ---------- */

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; try { ensureChips(); } catch (e) {} });
  };
  const mo = new MutationObserver(schedule);
  function observe() {
    if (!document.body) return false;
    mo.observe(document.body, { childList: true, subtree: true });
    return true;
  }
  if (!observe()) {
    document.addEventListener('DOMContentLoaded', observe);
  }
  setInterval(schedule, 1500);
  window.addEventListener('load', schedule);
  for (const t of ['popstate', 'hashchange']) window.addEventListener(t, schedule);

  window.__ZAI_CLASSIC_COMPOSER__ = stats;
  window.__ZAI_CLASSIC_STATE__ = state;
  window.__ZAI_HEAL__ = heal;
})();
