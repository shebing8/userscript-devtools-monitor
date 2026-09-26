// ==UserScript==
// @name         海角预览 HLS 完整流解析器 (全能增强版)
// @namespace    local.haijiao.reverse
// @version      2.2.0
// @description  清除广告，拦截解密 /api/topic 与 /api/attachment 响应，智能恢复隐藏/VIP附件，支持多规则 CDN 完整流推导与诊断
// @match        *://haijiao.com/*
// @match        *://*.haijiao.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(() => {
  'use strict';

  if (!/(^|\.)haijiao\.com$/i.test(location.hostname)) return;

  // 0. 拦截并解密 /api/topic/* 与 /api/attachment (兼容 Axios XHR 与 window.fetch，支持 UTF-8 多层 Base64 脱壳)
  function unwrapBase64Json(raw) {
    let cur = typeof raw === 'string' ? raw.trim() : '';
    if (!cur) return null;
    for (let i = 0; i < 5; i++) {
      if (cur.startsWith('{') || cur.startsWith('[')) {
        try { return JSON.parse(cur); } catch { break; }
      }
      if (!/^[A-Za-z0-9+/=]+$/.test(cur)) break;
      try {
        const bin = atob(cur);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        cur = new TextDecoder('utf-8').decode(bytes).trim();
      } catch {
        break;
      }
    }
    return null;
  }

  function inspectApiPayload(apiUrl, bodyText) {
    try {
      const outer = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText;
      if (!outer || outer.data === undefined) return;
      const parsed = typeof outer.data === 'object' ? outer.data : unwrapBase64Json(outer.data);
      if (!parsed) return;
      window.__HJ_LAST_API_DATA__ = parsed;
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments
        : (parsed.category === 'video' ? [parsed] : []);
      for (const att of attachments) {
        if (att?.category === 'video' && att.remoteUrl) {
          const isPreview = /_preview\.m3u8/i.test(att.remoteUrl);
          console.log(
            `%c[HJ-FULL API Hook] ${apiUrl}\n- 状态: ${isPreview ? '⚠️ 试看流 (服务端截断 _preview)' : '✅ 完整流 (已解锁)'}\n- 附件ID: ${att.id} | 原片时长: ${att.video_time_length || '--'}s\n- URL: ${att.remoteUrl}`,
            'color:#22d3ee;font-weight:bold;'
          );
        }
      }
    } catch {}
  }

  if (!window.__HJ_API_INTERCEPTOR__) {
    window.__HJ_API_INTERCEPTOR__ = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      const reqUrl = String(args[0] instanceof Request ? args[0].url : args[0] || '');
      if (/\/api\/(topic\/|attachment)/i.test(reqUrl)) {
        response.clone().text().then(t => inspectApiPayload(reqUrl, t)).catch(() => {});
      }
      return response;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__hjApiUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (/\/api\/(topic\/|attachment)/i.test(this.__hjApiUrl || '')) {
        this.addEventListener('load', function () {
          try { inspectApiPayload(this.__hjApiUrl, this.responseText); } catch {}
        });
      }
      return origSend.apply(this, args);
    };
  }

  // 1. 拦截 ElementUI 预览中断监听器（避免播放中途弹购买窗中断播放）
  if (!window.__HJ_VIDEO_GATE_GUARD__) {
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const guardedTypes = new Set(['timeupdate', 'seeking', 'ended']);
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLVideoElement && guardedTypes.has(type) && typeof listener === 'function') {
        let source = '';
        try { source = Function.prototype.toString.call(listener); } catch {}
        if (/\.alert\s*\(/.test(source) && (type === 'ended' || /currentTime/.test(source))) {
          console.log('[HJ-FULL] 已阻止预览付费门监听器:', type);
          return;
        }
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
    Object.defineProperty(window, '__HJ_VIDEO_GATE_GUARD__', {
      value: Object.freeze({
        active: true,
        restore() { EventTarget.prototype.addEventListener = nativeAddEventListener; }
      }),
      configurable: true
    });
  }

  const CONFIG = {
    autoResolve: true,
    scanIntervalMs: 1000,
    manifestTimeoutMs: 10000,
    showPanel: true,
    forceHighestQuality: true
  };

  const AD_SELECTORS = [
    '.containeradvertising',
    '.custom_carousel',
    '.left-activty',
    '.right-activty',
    '.customer-service'
  ];
  const adStats = { removed: 0, lastRun: 0 };

  function installAdCss() {
    if (document.getElementById('hj-ad-cleaner-style')) return;
    if (!document.documentElement) {
      document.addEventListener('readystatechange', installAdCss, { once: true });
      return;
    }
    const style = document.createElement('style');
    style.id = 'hj-ad-cleaner-style';
    style.textContent = `${AD_SELECTORS.join(',')} { display:none!important; visibility:hidden!important; width:0!important; height:0!important; min-width:0!important; min-height:0!important; margin:0!important; padding:0!important; overflow:hidden!important; pointer-events:none!important; }`;
    document.documentElement.appendChild(style);
  }

  function cleanAds(root = document) {
    let removed = 0;
    for (const selector of AD_SELECTORS) {
      const nodes = [];
      if (root.nodeType === 1 && root.matches?.(selector)) nodes.push(root);
      root.querySelectorAll?.(selector).forEach(node => nodes.push(node));
      for (const node of nodes) {
        if (!node.isConnected) continue;
        node.remove();
        removed++;
      }
    }
    adStats.removed += removed;
    adStats.lastRun = Date.now();
    return removed;
  }

  function installAdObserver() {
    installAdCss();
    const start = () => {
      cleanAds();
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) cleanAds(node);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.__HJ_AD_OBSERVER__ = observer;
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  if (window.__HJ_FULL_RESOLVER__?.version === '2.3.0') return;

  const PREFIX = '[HJ-FULL]';
  let handled = new WeakSet();
  const results = [];
  let vipRecovery = null;
  let lastHref = location.href;
  let panel;
  let statusNode;
  let detailNode;
  let badgeNode;
  let lastStatus = '';

  const log = (...args) => console.log(PREFIX, ...args);

  // 本地 Vue 状态与 VIP 标识解锁（避免 btoa 中文报错与盲目替换 404 导致黑屏）
  function unlockLocalVueState() {
    try {
      const root = document.querySelector('#app')?.__vue__;
      if (root?.$store?.state) {
        const st = root.$store.state;
        if (st.userInfo && typeof st.userInfo === 'object') {
          st.userInfo.vip = Math.max(Number(st.userInfo.vip) || 0, 4);
          st.userInfo.role = 1;
        }
      }
      const rawResp = sessionStorage.getItem('response');
      if (rawResp) {
        const parsed = JSON.parse(rawResp);
        if (parsed?.data?.user) {
          parsed.data.user.vip = Math.max(Number(parsed.data.user.vip) || 0, 4);
          sessionStorage.setItem('response', JSON.stringify(parsed));
        }
      }
      const vm = findTopicViewModel();
      if (vm?.$data) {
        vm.$data.isvipLimit = false;
        const art = vm.$data.articleInfo || vm.$data.details;
        if (art) {
          if (art.node) art.node.vipLimit = 0;
          if (art.sale) art.sale.is_buy = true;
          art.currentUserPurchased = true;
        }
      }
      document.querySelectorAll('.sell-btn').forEach(el => {
        if (el.style.display === 'none') el.style.display = '';
      });
      document.querySelectorAll('.sell_line1, .sell_line2').forEach(el => {
        el.style.display = 'none';
      });
      document.querySelectorAll('.sell-btn .video-div').forEach(el => {
        if (el.style.marginBottom === '-80px') el.style.marginBottom = '8px';
      });
    } catch {}
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function manifestInfo(text) {
    const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const segments = lines.filter(x => !x.startsWith('#') && /\.ts(?:\?|$)/i.test(x));
    const duration = [...text.matchAll(/#EXTINF:([0-9.]+)/g)]
      .reduce((sum, match) => sum + Number(match[1]), 0);
    const isHashedSegments = segments.length > 0 && segments.every(x => /^[a-f0-9]{32}\.ts(?:\?|$)/i.test(x.split('/').pop()));
    return { lines, segments, duration, isHashedSegments };
  }

  function findTopicViewModel() {
    const root = document.querySelector('#app')?.__vue__;
    if (!root) return null;
    const queue = [root];
    const seen = new Set();
    while (queue.length && seen.size < 400) {
      const vm = queue.shift();
      if (!vm || seen.has(vm)) continue;
      seen.add(vm);
      if (vm.$data?.articleInfo?.topicId || vm.$data?.details?.topicId) return vm;
      queue.push(...(vm.$children || []));
    }
    return null;
  }

  function getArticleVideoMeta() {
    const vm = findTopicViewModel();
    const article = vm?.$data?.articleInfo || vm?.$data?.details;
    const attachments = Array.isArray(article?.attachments) ? article.attachments : [];
    const videoAtt = attachments.find(a => a?.category === 'video') || null;
    return {
      vm,
      article,
      topicId: Number(article?.topicId || 0),
      isSaleUnbought: Boolean(article?.sale && article.sale.is_buy === false),
      saleAmount: article?.sale?.amount ? (article.sale.amount / 100) : null,
      videoAtt,
      totalDuration: Number(videoAtt?.video_time_length || 0)
    };
  }

  function decodeProtectedImage(text) {
    const alphabet = 'ABCD*EFGHIJKLMNOPQRSTUVWX#YZabcdefghijklmnopqrstuvwxyz1234567890';
    const source = String(text || '').replace(/[^A-Za-z0-9*#]/g, '');
    const bytes = [];
    for (let offset = 0; offset < source.length;) {
      const a = alphabet.indexOf(source.charAt(offset++));
      const b = alphabet.indexOf(source.charAt(offset++));
      const c = alphabet.indexOf(source.charAt(offset++));
      const d = alphabet.indexOf(source.charAt(offset++));
      if (a < 0 || b < 0) break;
      bytes.push((a << 2) | (b >> 4));
      if (c >= 0 && c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
      if (d >= 0 && d !== 64) bytes.push(((c & 3) << 6) | d);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  async function renderProtectedImage(image, attachment) {
    const response = await fetch(attachment.remoteUrl, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) throw new Error(`图片 ${attachment.id} HTTP ${response.status}`);
    const decoded = decodeProtectedImage(await response.text());
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(decoded)) {
      throw new Error(`图片 ${attachment.id} 解码结果无效`);
    }
    image.src = decoded;
    image.dataset.state = 'ready';
  }

  function waitForSiteGlobal(name, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (typeof window[name] === 'function') {
          clearInterval(timer);
          resolve(window[name]);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待 ${name} 超时`));
        }
      }, 50);
    });
  }

  async function createVipVideoPlayer(video, attachment) {
    const rawUrl = String(attachment.remoteUrl || '');
    if (!rawUrl) {
      throw new Error(`附件 ${attachment.id} 没有视频播放地址（服务端未下发）`);
    }
    const HlsClass = await waitForSiteGlobal('Hls');
    if (!HlsClass.isSupported()) {
      const kversion = JSON.parse(sessionStorage.getItem('config') || '{}').kversion || '';
      const nativeUrl = new URL(rawUrl);
      nativeUrl.hostname = `${kversion || '0'}${nativeUrl.hostname}`;
      video.src = nativeUrl.href;
      video.load();
      return { native: true, rawUrl };
    }

    const [seedText, wasmFactory] = await Promise.all([
      fetch(rawUrl.replace(/\.m3u8(?:\?.*)?$/i, '.jpg'), { credentials: 'omit', cache: 'force-cache' })
        .then(response => {
          if (!response.ok) throw new Error(`视频密钥种子 HTTP ${response.status}`);
          return response.text();
        }),
      waitForSiteGlobal('createModule')
    ]);
    const binary = atob(seedText.trim());
    const seed = Uint8Array.from(binary, char => char.charCodeAt(0));
    const wasm = await wasmFactory();
    let transformedKey = null;
    const hls = new HlsClass({
      debug: false,
      autoStartLoad: false,
      maxBufferLength: 15,
      maxMaxBufferLength: 30,
      maxBufferSize: 30000000,
      startLevel: -1,
      fragLoadingRetryDelay: 500,
      xhrSetup(xhr, url) {
        const kversion = JSON.parse(sessionStorage.getItem('config') || '{}').kversion || '';
        if (url.includes('.key')) {
          const keyedUrl = url.replace('.key', `.key${kversion}`);
          xhr.open('GET', keyedUrl, true);
        }
      }
    });
    hls.on(HlsClass.Events.KEY_LOADED, (_event, data) => {
      if (!transformedKey) {
        const original = new Uint8Array(data.frag.decryptdata.key);
        const keyPointer = wasm._malloc(original.length);
        const seedPointer = wasm._malloc(seed.length);
        try {
          wasm.HEAPU8.set(original, keyPointer);
          wasm.HEAPU8.set(seed, seedPointer);
          wasm.ccall('jquery_key', null, ['number', 'number', 'number', 'number'],
            [keyPointer, original.length, seedPointer, seed.length]);
          transformedKey = new Uint8Array(wasm.HEAPU8.buffer, keyPointer, original.length).slice();
        } finally {
          wasm._free(keyPointer);
          wasm._free(seedPointer);
        }
      }
      data.frag.decryptdata.key = transformedKey;
    });
    video.__hls = hls;
    hls.attachMedia(video);
    hls.once(HlsClass.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(rawUrl);
      hls.startLoad(0);
    });
    return { hls, rawUrl };
  }

  // 智能恢复未在正文中渲染的隐藏/受限附件（自动跳过正文已渲染的图片和视频，杜绝双播放器冲突）
  async function recoverVipAttachments() {
    if (!/^\/post\/details/i.test(location.pathname)) return null;
    const vm = findTopicViewModel();
    const article = vm?.$data?.articleInfo || vm?.$data?.details;
    const topicId = Number(article?.topicId || 0);
    const attachments = Array.isArray(article?.attachments) ? article.attachments : [];
    if (!topicId || !attachments.length) return null;

    const isVipLimited = Boolean(vm?.$data?.isvipLimit) || /升级VIP\d+查看完整内容/.test(document.body?.innerText || '');
    const contentHtml = String(article?.content || '');

    // 过滤出正文中尚未包含/未渲染的缺失附件（避免与正文已有图片/视频重复）
    const missingAttachments = attachments.filter(att => {
      if (!att?.id) return false;
      if (!isVipLimited && contentHtml.includes(String(att.id))) return false;
      const inArticleDom = Array.from(
        document.querySelectorAll(`img[data-id="${att.id}"], #video_${att.id}, .video-div[data-id="${att.id}"]`)
      ).some(el => !el.closest('#hj-vip-attachment-recovery'));
      return !inArticleDom;
    });

    if (!missingAttachments.length) {
      document.querySelector('#hj-vip-attachment-recovery')?.remove();
      return null;
    }

    if (vipRecovery?.topicId === topicId) return vipRecovery.promise;

    const promise = (async () => {
      document.querySelector('#hj-vip-attachment-recovery')?.remove();
      const container = document.createElement('section');
      container.id = 'hj-vip-attachment-recovery';
      container.dataset.topicId = String(topicId);
      container.innerHTML = '<div class="hj-vip-title">已恢复隐藏/受限附件资源</div><div class="hj-vip-items"></div>';
      const items = container.querySelector('.hj-vip-items');
      const anchor = document.querySelector('.article');
      if (anchor) anchor.insertAdjacentElement('afterend', container);
      else (document.querySelector('.details-box') || document.body).appendChild(container);

      for (const prompt of document.querySelectorAll('.vipbtn')) {
        if (/升级VIP\d+查看完整内容/.test(prompt.textContent || '')) {
          const box = prompt.closest('.pagecontainer');
          if (box) box.style.display = 'none';
        }
      }

      const imageTasks = [];
      let imageCount = 0;
      let videoCount = 0;
      for (const attachment of missingAttachments) {
        if (attachment?.category === 'images' && attachment.remoteUrl) {
          imageCount++;
          const image = document.createElement('img');
          image.dataset.id = String(attachment.id || '');
          image.dataset.state = 'loading';
          image.alt = `恢复图片 ${imageCount}`;
          image.loading = 'eager';
          items.appendChild(image);
          imageTasks.push(renderProtectedImage(image, attachment).catch(error => {
            image.dataset.state = 'error';
            image.alt = String(error?.message || error);
          }));
        } else if (attachment?.category === 'video' && attachment.remoteUrl) {
          videoCount++;
          const wrapper = document.createElement('div');
          wrapper.className = 'video-div hj-vip-video';
          wrapper.id = `hj_vip_video_${attachment.id}`;
          wrapper.dataset.id = String(attachment.id || '');
          wrapper.dataset.url = String(attachment.remoteUrl);
          wrapper.dataset.preview = '0';
          wrapper.innerHTML = '<video controls playsinline webkit-playsinline preload="metadata"></video>';
          items.appendChild(wrapper);
          await createVipVideoPlayer(wrapper.querySelector('video'), attachment);
        } else if (attachment?.category === 'video' && !attachment.remoteUrl) {
          const emptyTip = document.createElement('div');
          emptyTip.style.padding = '8px';
          emptyTip.style.background = '#fef2f2';
          emptyTip.style.color = '#991b1b';
          emptyTip.style.borderRadius = '4px';
          emptyTip.innerText = `[提示] 视频附件 #${attachment.id} 地址为空（服务端权限拦截未下发）`;
          items.appendChild(emptyTip);
        }
      }
      await Promise.all(imageTasks);
      const outcome = { type: 'vip-recovered', topicId, imageCount, videoCount };
      if (!results.some(item => item.type === outcome.type && item.topicId === topicId)) results.push(outcome);
      return outcome;
    })().catch(error => {
      console.error(PREFIX, '附件恢复异常', error);
      return { type: 'error', topicId, error: String(error?.message || error) };
    });
    vipRecovery = { topicId, promise };
    return promise;
  }

  // 核心：支持多类 CDN 完整流智能推导与多线路备用探测
  async function deriveFullUrl(previewUrl, previewManifest) {
    const info = manifestInfo(previewManifest);
    const preview = new URL(previewUrl, location.href);
    const candidates = [];

    // 候选 1：旧版 CDN 泄露规则（从 _iN.ts 反推 _i.m3u8 及 .m3u8）
    const segmentI = info.segments.find(x => /_i\d+\.ts(?:\?|$)/i.test(x));
    if (segmentI) {
      const c1 = new URL(segmentI, preview);
      c1.pathname = c1.pathname.replace(/(_i)\d+\.ts$/i, '$1.m3u8');
      c1.search = '';
      c1.hash = '';
      candidates.push(c1.href);

      const c1Plain = new URL(segmentI, preview);
      c1Plain.pathname = c1Plain.pathname.replace(/_i\d+\.ts$/i, '.m3u8');
      c1Plain.search = '';
      c1Plain.hash = '';
      candidates.push(c1Plain.href);
    }

    // 候选 2：数字前缀切片规则（文件名形如 [视频ID][附件ID].m3u8，完整流为 [视频ID].m3u8）
    const firstSegment = info.segments[0];
    if (firstSegment && !info.isHashedSegments) {
      const segFile = firstSegment.split('/').pop();
      const segMatch = segFile.match(/^(\d+?)(\d+)\.ts(?:\?|$)/i);
      const m3u8Match = preview.pathname.match(/\/(\d+)\.m3u8$/i);
      if (segMatch && m3u8Match) {
        const videoPrefix = segMatch[1];
        const c2 = new URL(previewUrl);
        c2.pathname = c2.pathname.replace(/\/\d+\.m3u8$/i, `/${videoPrefix}.m3u8`);
        c2.search = '';
        candidates.push(c2.href);
      }
    }

    // 候选 3：替换 (_i)_preview.m3u8 为 _i.m3u8 与 .m3u8（修复原版 _i_i.m3u8 重复拼接 Bug）
    if (/_preview\.m3u8/i.test(preview.pathname)) {
      const c3WithI = new URL(preview.href);
      c3WithI.pathname = c3WithI.pathname.replace(/(?:_i)?_preview\.m3u8$/i, '_i.m3u8');
      candidates.push(c3WithI.href);

      const c3Plain = new URL(preview.href);
      c3Plain.pathname = c3Plain.pathname.replace(/(?:_i)?_preview\.m3u8$/i, '.m3u8');
      candidates.push(c3Plain.href);
    }

    // 候选 4：通过接口轮询多条线路（vip / normal2 / normal1），检查是否有未截断的源流
    try {
      const meta = getArticleVideoMeta();
      const axios = document.querySelector('#app')?.__vue__?.$axios;
      if (axios && meta.videoAtt?.id && meta.topicId) {
        for (const line of ['vip', 'normal2', 'normal1']) {
          const resp = await axios.post('/api/attachment', {
            id: Number(meta.videoAtt.id),
            resource_id: Number(meta.topicId),
            resource_type: 'topic',
            line
          }).catch(() => null);
          const altUrl = resp?.data?.remoteUrl;
          if (altUrl && altUrl !== previewUrl) {
            candidates.push(altUrl);
            if (/_preview\.m3u8/i.test(altUrl)) {
              candidates.push(altUrl.replace(/(?:_i)?_preview\.m3u8$/i, '_i.m3u8'));
              candidates.push(altUrl.replace(/(?:_i)?_preview\.m3u8$/i, '.m3u8'));
            }
          }
        }
      }
    } catch {}

    const uniqueCandidates = [...new Set(candidates)].filter(u => u && u !== previewUrl);
    log('开始探测候选完整流:', uniqueCandidates);

    for (const candidateUrl of uniqueCandidates) {
      try {
        const text = await fetchManifest(candidateUrl);
        const fullInfo = manifestInfo(text);
        if (fullInfo.segments.length > info.segments.length || fullInfo.duration > info.duration + 2) {
          log('命中有效完整流:', candidateUrl, `时长: ${info.duration}s -> ${fullInfo.duration}s`);
          return { fullUrl: candidateUrl, previewInfo: info, fullInfo, leakedSegment: firstSegment };
        }
      } catch {}
    }

    const meta = getArticleVideoMeta();
    if (info.isHashedSegments) {
      const fullTimeStr = meta.totalDuration ? ` / 原片 ${formatTime(meta.totalDuration)}` : '';
      throw new Error(`该帖采用 32 位哈希切片且 CDN 未公开完整清单（预览 ${formatTime(info.duration)}${fullTimeStr}，候选地址均 404）`);
    }
    throw new Error('未嗅探到有效更长分片的完整流（CDN 权限已严格限制）');
  }

  async function fetchManifest(url) {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`M3U8 HTTP ${response.status}`);
    const text = await response.text();
    if (!text.startsWith('#EXTM3U')) throw new Error('响应不是 HLS M3U8');
    return text;
  }

  function armHighestQuality(hls) {
    if (!hls || hls.__hjQualityArmed) return;
    hls.__hjQualityArmed = true;
    const apply = () => {
      const levels = hls.levels || [];
      let selectedLevel = 0;
      if (CONFIG.forceHighestQuality && levels.length > 1) {
        selectedLevel = levels.reduce((best, level, index) => {
          const score = (Number(level.width) || 0) * (Number(level.height) || 0) * 1e6 + (Number(level.bitrate) || 0);
          return score > best.score ? { index, score } : best;
        }, { index: 0, score: -1 }).index;
        try { hls.startLevel = selectedLevel; } catch {}
        try { hls.currentLevel = selectedLevel; } catch {}
        try { hls.nextLevel = selectedLevel; } catch {}
        try { hls.loadLevel = selectedLevel; } catch {}
      }
    };
    hls.on(Hls.Events.MANIFEST_PARSED, apply);
  }

  function setBadge(text, color = '#0891b2') {
    if (!badgeNode) return;
    badgeNode.textContent = text;
    badgeNode.style.background = color;
  }

  function publishResolved(hls, previewUrl, fullUrl, previewInfo, fullInfo, leakedSegment, mode) {
    const result = {
      type: 'resolved',
      mode,
      previewUrl,
      leakedSegment,
      fullUrl,
      previewSegments: previewInfo.segments.length,
      fullSegments: fullInfo.segments.length,
      previewDuration: previewInfo.duration,
      fullDuration: fullInfo.duration
    };
    hls.__hjFullInfo = result;
    if (!results.some(x => x.fullUrl === fullUrl)) results.push(result);
    const updateVideo = () => {
      const video = hls.media;
      if (!video) return;
      video.dataset.hjFullResolved = '1';
      video.dataset.hjFullUrl = fullUrl;
      const container = video.closest('.video-div');
      if (container) {
        container.dataset.url = fullUrl;
        container.dataset.preview = '0';
      }
    };
    updateVideo();
    setTimeout(updateVideo, 0);
    setTimeout(updateVideo, 500);
    setBadge('完整流已解锁', '#059669');
    setStatus(
      `完整流已载入：${formatTime(fullInfo.duration)} / ${fullInfo.segments.length} 分片`,
      `原流 ${formatTime(previewInfo.duration)} → 完整 ${formatTime(fullInfo.duration)}`
    );
    log(result);
    return result;
  }

  function installEarlyLoadSourceHook() {
    let attempts = 0;
    const timer = setInterval(() => {
      const HlsClass = window.Hls;
      const proto = HlsClass?.prototype;
      if (!proto?.loadSource) {
        if (++attempts > 4000) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      if (proto.loadSource.__hjEarlyHook) return;
      const nativeLoadSource = proto.loadSource;
      function hookedLoadSource(source) {
        const previewUrl = String(source || '');
        if (!/\.m3u8(?:\?|$)/i.test(previewUrl)) {
          return nativeLoadSource.call(this, source);
        }
        const hls = this;
        if (hls.__hjEarlyResolution) return;
        setBadge('探测中…', '#d97706');
        setStatus('正在探测并推导完整视频流…', previewUrl);
        hls.__hjEarlyResolution = (async () => {
          try {
            const previewText = await fetchManifest(previewUrl);
            const { fullUrl, previewInfo, fullInfo, leakedSegment } = await deriveFullUrl(previewUrl, previewText);
            armHighestQuality(hls);
            nativeLoadSource.call(hls, fullUrl);
            publishResolved(hls, previewUrl, fullUrl, previewInfo, fullInfo, leakedSegment, 'early-loadSource');
          } catch (error) {
            log('未探测到更长完整流，保持原流播放:', error.message);
            setBadge('哈希隔离/仅预览', '#dc2626');
            setStatus('当前仅可播放预览流', error.message);
            nativeLoadSource.call(hls, source);
          }
        })();
        return undefined;
      }
      Object.defineProperty(hookedLoadSource, '__hjEarlyHook', { value: true });
      Object.defineProperty(hookedLoadSource, '__hjNative', { value: nativeLoadSource });
      proto.loadSource = hookedLoadSource;
      log('已安装 Hls.loadSource 拦截器');
    }, 10);
  }

  function setStatus(text, detail = '') {
    const key = `${text}\n${detail}`;
    if (key === lastStatus) return;
    lastStatus = key;
    if (statusNode) statusNode.textContent = text;
    if (detailNode) detailNode.textContent = detail;
    log(text, detail);
  }

  function waitForManifest(hls) {
    return new Promise(resolve => {
      let settled = false;
      const finish = data => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { hls.off(Hls.Events.MANIFEST_PARSED, onParsed); } catch {}
        resolve(data);
      };
      const onParsed = (_event, data) => finish(data);
      const timer = setTimeout(() => finish(null), CONFIG.manifestTimeoutMs);
      hls.on(Hls.Events.MANIFEST_PARSED, onParsed);
    });
  }

  async function resolveVideo(video, force = false) {
    const hls = video?.__hls;
    if (!hls) return null;
    if (hls.__hjEarlyResolution && !force) {
      try { await hls.__hjEarlyResolution; } catch {}
    }
    if (hls.__hjFullInfo && !force) {
      handled.add(hls);
      return hls.__hjFullInfo;
    }
    if (!force && handled.has(hls)) return null;

    const previewUrl = hls.url || video.closest('.video-div')?.dataset.url || '';
    if (!previewUrl) {
      video.dataset.hjStreamType = 'pending';
      return { type: 'pending' };
    }

    handled.add(hls);
    setBadge('分析中…', '#d97706');
    setStatus('正在分析当前 M3U8 流…', previewUrl);
    try {
      const previewText = await fetchManifest(previewUrl);
      const info = manifestInfo(previewText);
      const meta = getArticleVideoMeta();

      if (meta.totalDuration > 0 && info.duration >= meta.totalDuration - 5) {
        setBadge('原生完整流', '#059669');
        setStatus(`当前已是完整视频流：${formatTime(info.duration)}`, previewUrl);
        return { type: 'already-full', url: previewUrl, duration: info.duration };
      }

      const { fullUrl, previewInfo, fullInfo, leakedSegment } = await deriveFullUrl(previewUrl, previewText);

      setStatus('已成功反推完整清单，准备重载…', fullUrl);
      const parsed = waitForManifest(hls);
      hls.stopLoad();
      armHighestQuality(hls);
      const nativeLoad = Hls.prototype.loadSource.__hjNative || hls.loadSource;
      nativeLoad.call(hls, fullUrl);
      hls.startLoad(0);
      await parsed;
      if (video.duration && video.currentTime >= video.duration - 1) {
        try { video.currentTime = 0; } catch {}
      }

      return publishResolved(hls, previewUrl, fullUrl, previewInfo, fullInfo, leakedSegment, 'late-swap-fallback');
    } catch (error) {
      video.dataset.hjStreamType = 'normal-or-full';
      setBadge('哈希隔离/仅预览', '#dc2626');
      setStatus('当前仅可播放预览流', String(error?.message || ''));
      return { type: 'normal-or-full', url: previewUrl };
    }
  }

  function checkRouteChange() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      handled = new WeakSet();
      vipRecovery = null;
      lastStatus = '';
      document.querySelector('#hj-vip-attachment-recovery')?.remove();
      setBadge('准备就绪', '#0891b2');
      setStatus('检测到路由切换，正在重新扫描…', location.href);
    }
  }

  async function scan(force = false) {
    checkRouteChange();
    unlockLocalVueState();
    if (/^\/post\/details/i.test(location.pathname)) createPanel();
    else if (panel) {
      panel.remove();
      panel = statusNode = detailNode = badgeNode = null;
      return [];
    }
    const recovered = await recoverVipAttachments();
    const videos = [...document.querySelectorAll('.video-div video')];
    if (!videos.length) {
      if (recovered?.type === 'vip-recovered') {
        setStatus(`附件已恢复：${recovered.imageCount} 图 / ${recovered.videoCount} 视频`, `帖子 ${recovered.topicId}`);
        return [recovered];
      }
      return [];
    }
    const settled = [];
    for (const video of videos) settled.push(await resolveVideo(video, force));
    return settled.filter(Boolean);
  }

  async function copyLastUrl() {
    const activeVideo = document.querySelector('.video-div video');
    const url = results.at(-1)?.fullUrl || activeVideo?.__hls?.url || activeVideo?.closest('.video-div')?.dataset.url;
    if (!url) return setStatus('还没有可复制的 M3U8 地址');
    try {
      await navigator.clipboard.writeText(url);
      setStatus('M3U8 地址已复制', url);
    } catch {
      prompt('复制 M3U8 地址：', url);
    }
  }

  function createPanel() {
    if (!CONFIG.showPanel || (panel && panel.isConnected) || !/^\/post\/details/i.test(location.pathname)) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', createPanel, { once: true });
      return;
    }
    document.querySelectorAll('#hj-full-resolver-panel').forEach(el => el.remove());
    panel = document.createElement('div');
    panel.id = 'hj-full-resolver-panel';
    panel.innerHTML = `
      <div class="hj-header">
        <span class="hj-title">HLS 完整流解析器 v2.3</span>
        <span class="hj-badge">准备就绪</span>
      </div>
      <div class="hj-status">准备就绪</div>
      <div class="hj-detail"></div>
      <div class="hj-actions">
        <button type="button" data-action="resolve">重新探测</button>
        <button type="button" data-action="copy">复制 M3U8</button>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      #hj-full-resolver-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;padding:12px;border-radius:10px;background:rgba(17,24,39,.95);color:#f9fafb;box-shadow:0 8px 30px rgba(0,0,0,.4);font:13px/1.45 system-ui,sans-serif;border:1px solid rgba(255,255,255,.1)}
      #hj-full-resolver-panel .hj-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
      #hj-full-resolver-panel .hj-title{font-weight:700;color:#67e8f9}
      #hj-full-resolver-panel .hj-badge{font-size:11px;padding:2px 6px;border-radius:4px;background:#0891b2;color:#fff;font-weight:600}
      #hj-full-resolver-panel .hj-status{word-break:break-word;font-weight:500}
      #hj-full-resolver-panel .hj-detail{margin-top:4px;color:#9ca3af;font-size:12px;word-break:break-all;max-height:72px;overflow:auto}
      #hj-full-resolver-panel .hj-actions{display:flex;gap:8px;margin-top:10px}
      #hj-full-resolver-panel button{border:0;border-radius:6px;padding:6px 10px;background:#0891b2;color:white;cursor:pointer;font-size:12px}
      #hj-full-resolver-panel button:last-child{background:#4b5563}
      #hj-vip-attachment-recovery{width:100%;box-sizing:border-box;margin:16px 0;padding:12px;border:1px solid #0891b2;border-radius:8px;background:#fff}
      #hj-vip-attachment-recovery .hj-vip-title{font-weight:700;color:#0891b2;margin-bottom:10px}
      #hj-vip-attachment-recovery .hj-vip-items{display:flex;flex-direction:column;gap:12px;width:100%}
      #hj-vip-attachment-recovery img{display:block;max-width:100%;height:auto;margin:0 auto}
      #hj-vip-attachment-recovery video{display:block;width:100%;max-width:100%;aspect-ratio:16/9;background:#000}
      @media(max-width:600px){#hj-full-resolver-panel{right:8px;bottom:8px;left:8px;width:auto;max-width:none}#hj-vip-attachment-recovery{margin:10px 0;padding:8px}}`;
    document.documentElement.append(style, panel);
    statusNode = panel.querySelector('.hj-status');
    detailNode = panel.querySelector('.hj-detail');
    badgeNode = panel.querySelector('.hj-badge');
    panel.querySelector('[data-action="resolve"]').addEventListener('click', () => scan(true));
    panel.querySelector('[data-action="copy"]').addEventListener('click', copyLastUrl);
  }

  const api = Object.freeze({
    version: '2.3.0',
    scan,
    resolveVideo,
    deriveFullUrl,
    manifestInfo,
    results,
    cleanAds,
    adStats,
    recoverVipAttachments,
    decodeProtectedImage
  });
  Object.defineProperty(window, '__HJ_FULL_RESOLVER__', { value: api, configurable: true });

  installAdObserver();
  installEarlyLoadSourceHook();
  createPanel();
  setInterval(() => CONFIG.autoResolve && scan(false), CONFIG.scanIntervalMs);
  CONFIG.autoResolve && scan(false);
})();
