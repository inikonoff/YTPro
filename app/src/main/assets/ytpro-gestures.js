/*
 * YTPro gestures module (fork-local).
 * Injected by YTProWebViewClient.onPageFinished AFTER the upstream scripts.
 * Works on top of upstream YTPro and does not modify scripts/*.
 *
 * Gestures
 *  - Fullscreen, left zone  : vertical swipe = brightness (remembered between videos)
 *  - Fullscreen, right zone : vertical swipe = volume
 *  - Fullscreen, centre zone: swipe down = exit fullscreen
 *  - Normal mode, on video  : swipe up = fullscreen, swipe down = in-app mini player
 *  - Any mode, hold still   : 2x speed while the finger is down
 *  - Fullscreen, pinch      : spread = fill screen, pinch in = reset
 *
 * Actions that need a user activation (requestFullscreen) run on touchend.
 *
 * Mini player: the watch page stays loaded, the player shrinks into the bottom-right corner and
 * the feed is shown in a same-origin iframe on top of the page, so it can be scrolled freely.
 * Tap = expand, swipe up = expand, swipe down / ✕ = close, Back = feed back or expand.
 *
 * Shorts are removed everywhere: shelves, feed items, tabs, chips, the upstream setting,
 * and /shorts/ID links open as /watch?v=ID.
 */
(function () {
  'use strict';

  if (window.__ytproGest) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  if (window.top !== window) return;   // the mini player feed iframe is driven from the top page
  window.__ytproGest = true;

  /* ---------- no shorts: open shorts links as regular videos ---------- */

  function shortsToWatch(u) {
    var m = /^\/shorts\/([\w-]+)/.exec(u.pathname || '');
    return m ? u.origin + '/watch?v=' + m[1] : null;
  }

  var redirect = shortsToWatch(location);
  if (redirect) { location.replace(redirect); return; }

  var CFG = {
    holdMs: 450,          // still finger this long => 2x speed
    slop: 12,             // px of movement still counted as "not moving"
    zoneSide: 0.35,       // share of width for the left/right zones (centre stays neutral)
    swipeMin: 56,         // px, minimal length of the fullscreen / PiP swipe
    swipeRatio: 0.22,     // ...or this share of the player height, whichever is larger
    bottomSafe: 0.16,     // bottom share of the player reserved for the seek bar
    levelSpan: 0.75,      // share of the player height that equals 0..100 % of volume/brightness
    minBrightness: 0.02,
    speed: 2,
    zoomIn: 1.08,         // pinch ratio that turns "fill screen" on
    zoomOut: 0.92,        // pinch ratio that turns it off
    hudMs: 900,
    brtKey: 'ytproGestBrt',
    miniWidth: 0.5,       // mini player width as a share of the screen width...
    miniMaxWidth: 320,    // ...but not wider than this (px)
    miniMaxHeight: 0.35,  // share of the screen height a portrait video may take
    miniMargin: 8,
    miniBottom: 60        // keeps the mini player above the feed's bottom navigation bar
  };

  var HAS_ANDROID = typeof Android !== 'undefined';
  var CONTROLS = 'button,[role="button"],[role="slider"],a,input,textarea,select';

  var st = null;            // single-finger gesture state
  var pinch = null;         // two-finger gesture state
  var pinchTail = false;    // swallow the remaining finger after a pinch
  var synthBusy = false;    // true while we dispatch our own synthetic events
  var speedOn = false;
  var prevRate = 1;
  var zoomed = false;
  var hudEl = null;
  var hudTimer = null;
  var mini = null;          // in-app mini player state

  /* ---------- small helpers ---------- */

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function pct(v) { return Math.round(v * 100) + '%'; }

  function fsEl() { return document.fullscreenElement || null; }
  function playerEl() { return document.getElementById('player-container-id'); }
  function videoEl() { return document.querySelector('.video-stream') || document.querySelector('video'); }
  function onWatch() { return location.pathname.indexOf('/watch') === 0; }
  function inPip() { return typeof isPIP !== 'undefined' && !!isPIP; }
  function levelGesturesOn() { return ls('gesC') !== 'false'; }   // upstream "Gesture Controls" switch

  function dist(a, b) { return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY); }

  /* The element a gesture belongs to, or null when the touch is not on the player. */
  function hostOf(target) {
    if (mini) return null;
    var fs = fsEl();
    if (fs) return fs.contains(target) ? fs : null;
    var p = playerEl();
    return (p && onWatch() && p.contains(target)) ? p : null;
  }

  /* Real controls (buttons, seek bar...) keep their own behaviour. Big overlays that happen to
     carry a button role are not treated as controls, otherwise no gesture could ever start. */
  function isControl(target, host) {
    var el = target.closest ? target.closest(CONTROLS) : null;
    if (!el || !host.contains(el)) return false;
    var r = el.getBoundingClientRect();
    var h = host.getBoundingClientRect();
    return (r.width * r.height) < 0.25 * (h.width * h.height);
  }

  function swallow(e) {
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }

  /* ---------- HUD ---------- */

  function hud(text, sticky) {
    var host = fsEl() || document.body;
    if (!host) return;
    var ref = (fsEl() || playerEl() || host).getBoundingClientRect();
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'ytproGestHud';
      hudEl.style.cssText = 'position:fixed;padding:6px 14px;border-radius:18px;' +
        'background:rgba(0,0,0,.65);color:#fff;font:600 14px/1.2 system-ui,sans-serif;' +
        'pointer-events:none;z-index:2147483647;white-space:nowrap;' +
        'transform:translateX(-50%);transition:opacity .15s;opacity:0';
    }
    if (hudEl.parentNode !== host) host.appendChild(hudEl);
    hudEl.style.left = (ref.left + ref.width / 2) + 'px';
    hudEl.style.top = (ref.top + Math.max(12, ref.height * 0.12)) + 'px';
    hudEl.textContent = text;
    hudEl.style.opacity = '1';
    clearTimeout(hudTimer);
    if (!sticky) hudTimer = setTimeout(hudHide, CFG.hudMs);
  }

  function hudHide() { if (hudEl) hudEl.style.opacity = '0'; }

  /* ---------- actions ---------- */

  function goFullscreen() {
    var p = playerEl();
    if (!p || fsEl()) return;
    try {
      var r = p.requestFullscreen();   // upstream patches this to pick the right orientation
      if (r && r.catch) r.catch(function () {});
    } catch (e) {}
  }

  function leaveFullscreen() {
    try { if (fsEl()) document.exitFullscreen(); } catch (e) {}
  }

  function startSpeed() {
    var v = videoEl();
    if (!v) return;
    prevRate = v.playbackRate || 1;
    v.playbackRate = CFG.speed;
    speedOn = true;
    hud('⏩ ' + CFG.speed + '×', true);
    try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
  }

  function endSpeed() {
    if (!speedOn) return;
    speedOn = false;
    var v = videoEl();
    if (v) v.playbackRate = prevRate;
    hudHide();
  }

  function setZoom(on) {
    var holder = document.getElementById('player');
    var v = videoEl();
    if (!holder || !v) return;
    var k = 1;
    if (on) {
      var W = window.innerWidth, H = window.innerHeight;
      var vw = v.videoWidth || 16, vh = v.videoHeight || 9;
      var s = Math.min(W / vw, H / vh);
      k = Math.max(W / (vw * s), H / (vh * s));   // factor that removes the black bars
      if (k < 1.01) k = 1;
    }
    holder.style.transformOrigin = 'center center';
    holder.style.transform = 'scale(' + k + ')';
    zoomed = k > 1;
    // keep upstream's own zoom state consistent so it does not fight us
    try { window.zoomIn = zoomed; window.scale = k; } catch (e) {}
    hud(zoomed ? '⤢ Fill' : '⤡ Fit');
  }

  /* ---------- brightness / volume ---------- */

  function storedBrightness() {
    var s = parseFloat(ls(CFG.brtKey));
    return isNaN(s) ? null : clamp(s, CFG.minBrightness, 1);
  }

  function applyBrightness(v) {
    if (HAS_ANDROID) Android.setBrightness(clamp(v, CFG.minBrightness, 1));
  }

  function resetBrightness() {
    if (HAS_ANDROID && typeof Android.resetBrightness === 'function') Android.resetBrightness();
  }

  function levelStart(mode) {
    if (!HAS_ANDROID) return 0;
    if (mode === 'vol') return Android.getVolume();
    var b = storedBrightness();
    return b !== null ? b : clamp(Android.getBrightness() / 100, CFG.minBrightness, 1);
  }

  function levelApply(mode, v) {
    if (!HAS_ANDROID) return;
    if (mode === 'vol') {
      Android.setVolume(v);
      hud((v <= 0 ? '🔇 ' : '🔊 ') + pct(v));
    } else {
      applyBrightness(v);
      hud('☀ ' + pct(v));
    }
  }

  /* ---------- gesture lifecycle ---------- */

  /* Tell the page its own touch sequence is over, so YouTube drops pending gesture state. */
  function claim(s) {
    if (s.claimed) return;
    s.claimed = true;
    try {
      var tgt = s.target;
      var t = new Touch({ identifier: s.id, target: tgt, clientX: s.x0, clientY: s.y0 });
      synthBusy = true;
      tgt.dispatchEvent(new TouchEvent('touchcancel', {
        bubbles: true, cancelable: false, composed: true,
        touches: [], targetTouches: [], changedTouches: [t]
      }));
    } catch (e) {
    } finally {
      synthBusy = false;
    }
  }

  function cancelSingle() {
    if (!st) return;
    clearTimeout(st.hold);
    st = null;
    endSpeed();
  }

  function onHold() {
    if (!st || st.mode) return;
    st.mode = 'speed';
    claim(st);
    startSpeed();
  }

  function onStart(e) {
    if (synthBusy) return;

    if (e.touches.length >= 2) {
      cancelSingle();
      var fs = fsEl();
      if (fs && fs.contains(e.target)) {
        pinch = { d0: dist(e.touches[0], e.touches[1]) || 1 };
      }
      return;
    }

    cancelSingle();
    pinch = null;
    pinchTail = false;

    var host = hostOf(e.target);
    if (!host || isControl(e.target, host)) return;

    var hr = host.getBoundingClientRect();
    var t = e.touches[0];
    if ((t.clientY - hr.top) / hr.height > 1 - CFG.bottomSafe) return;   // seek bar area

    st = {
      id: t.identifier, target: e.target, host: host, hr: hr,
      fs: !!fsEl(), x0: t.clientX, y0: t.clientY, lastY: t.clientY,
      mode: null, claimed: false, level: 0, hold: null
    };
    st.hold = setTimeout(onHold, CFG.holdMs);
  }

  function decideMode(s, dx, dy) {
    if (Math.abs(dy) < Math.abs(dx) * 1.4) return 'ignore';   // horizontal: leave it to YouTube
    if (!s.fs) return 'drag';                                   // normal mode: up = fullscreen, down = PiP
    var fx = (s.x0 - s.hr.left) / s.hr.width;
    if (fx < CFG.zoneSide) return levelGesturesOn() ? 'brt' : 'ignore';
    if (fx > 1 - CFG.zoneSide) return levelGesturesOn() ? 'vol' : 'ignore';
    return 'exit';                                              // neutral centre: swipe down leaves fullscreen
  }

  function threshold(s) { return Math.max(CFG.swipeMin, s.hr.height * CFG.swipeRatio); }

  function onMove(e) {
    if (synthBusy) return;

    if (pinch) {
      if (e.touches.length < 2) return;
      swallow(e);
      var z = dist(e.touches[0], e.touches[1]) / pinch.d0;
      if (z > CFG.zoomIn && !zoomed) setZoom(true);
      else if (z < CFG.zoomOut && zoomed) setZoom(false);
      return;
    }
    if (pinchTail) { swallow(e); return; }
    if (!st) return;
    if (e.touches.length >= 2) { cancelSingle(); return; }

    var t = e.touches[0];
    var dx = t.clientX - st.x0;
    var dy = t.clientY - st.y0;

    if (!st.mode) {
      if (Math.abs(dx) < CFG.slop && Math.abs(dy) < CFG.slop) return;
      clearTimeout(st.hold);
      st.mode = decideMode(st, dx, dy);
      if (st.mode === 'ignore') return;
      claim(st);
      if (st.mode === 'vol' || st.mode === 'brt') {
        st.level = levelStart(st.mode);
        st.lastY = st.y0;   // count the movement that made us decide
      }
    }

    if (st.mode === 'ignore') return;
    swallow(e);

    switch (st.mode) {
      case 'vol':
      case 'brt':
        st.level = clamp(st.level - (t.clientY - st.lastY) / (st.hr.height * CFG.levelSpan), 0, 1);
        st.lastY = t.clientY;
        levelApply(st.mode, st.level);
        break;
      case 'drag':
        if (dy >= threshold(st)) hud('⌄ Release: mini player', true);
        else hudHide();
        break;
      case 'exit':
        if (dy >= threshold(st)) hud('⤡ Release: exit fullscreen', true);
        else hudHide();
        break;
      default:
        break;   // 'speed': keep 2x, ignore movement
    }
  }

  function onEnd(e) {
    if (synthBusy) return;

    if (pinch) {
      if (e.touches.length < 2) {
        pinch = null;
        pinchTail = e.touches.length > 0;
      }
      swallow(e);
      return;
    }
    if (pinchTail) {
      if (e.touches.length === 0) pinchTail = false;
      swallow(e);
      return;
    }
    if (!st) return;

    var s = st;
    st = null;
    clearTimeout(s.hold);

    var cancelled = e.type === 'touchcancel';
    var ct = e.changedTouches && e.changedTouches[0];
    var dy = ct ? ct.clientY - s.y0 : 0;

    if (s.claimed) swallow(e);   // also suppresses the ghost click after the gesture

    if (s.mode === 'speed') { endSpeed(); return; }
    if (s.mode === 'vol' || s.mode === 'brt') {
      if (s.mode === 'brt' && !cancelled) lsSet(CFG.brtKey, String(s.level));
      hud(s.mode === 'vol' ? ((s.level <= 0 ? '🔇 ' : '🔊 ') + pct(s.level)) : ('☀ ' + pct(s.level)));
      return;
    }
    hudHide();
    if (cancelled) return;

    var T = threshold(s);
    if (s.mode === 'drag') {
      if (dy <= -T) goFullscreen();
      else if (dy >= T) miniOpen();
    } else if (s.mode === 'exit') {
      if (dy >= T) leaveFullscreen();
    }
  }

  /* ---------- fullscreen transitions ---------- */

  document.addEventListener('fullscreenchange', function () {
    if (fsEl() && mini) miniExpand();   // PiP / fullscreen always use the full player
    if (inPip()) return;
    if (fsEl()) {
      if (levelGesturesOn()) {
        var b = storedBrightness();
        if (b !== null) applyBrightness(b);   // remembered brightness, fullscreen only
      }
    } else {
      resetBrightness();                       // back to the system brightness
      endSpeed();
      if (zoomed) setZoom(false);
      hudHide();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelSingle(); pinch = null; pinchTail = false; }
  });

  /* ---------- wiring ---------- */

  window.addEventListener('touchstart', onStart, { capture: true, passive: true });
  window.addEventListener('touchmove', onMove, { capture: true, passive: false });
  window.addEventListener('touchend', onEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onEnd, { capture: true, passive: false });

  /* long press on the player would otherwise open the native context menu */
  window.addEventListener('contextmenu', function (e) {
    if (hostOf(e.target)) e.preventDefault();
  }, true);

  /* Own handling replaces upstream's edge strips and its in-page miniplayer swipe. */
  var css = document.createElement('style');
  css.id = 'ytproGestCss';
  css.textContent =
    '#volS,#brtS{display:none!important;pointer-events:none!important}' +
    '#player-container-id,#player-container-id *{touch-action:none!important;' +
    '-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}';
  (document.head || document.documentElement).appendChild(css);

  if (ls('gesM') === 'true') lsSet('gesM', 'false');
  lsSet('shorts', 'true');   // upstream "Hide Shorts" on as well

  /* ---------- mini player ---------- */

  function isVideoUrl(u) { return u.pathname.indexOf('/watch') === 0 || u.pathname.indexOf('/shorts/') === 0; }

  function pageBg() {
    var c = getComputedStyle(document.body).backgroundColor;
    return (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') ? '#fff' : c;
  }

  /* A video picked in the feed replaces the minimised one in the main page. */
  function openFromFeed(u) {
    location.href = shortsToWatch(u) || u.href;
  }

  function wireFeed(f) {
    var d, w;
    try { d = f.contentDocument; w = f.contentWindow; } catch (e) { return; }
    if (!d || !d.documentElement) return;
    noShorts(d);
    if (d.__ytproFeed) return;
    d.__ytproFeed = true;
    d.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var u;
      try { u = new URL(a.href, w.location.href); } catch (err) { return; }
      if (/(^|\.)youtube\.com$/.test(u.hostname) && isVideoUrl(u)) {
        e.preventDefault();
        e.stopPropagation();
        openFromFeed(u);
      }
    }, true);
    if (w.navigation) {
      w.navigation.addEventListener('navigate', function (e) {
        var u;
        try { u = new URL(e.destination.url); } catch (err) { return; }
        if (/(^|\.)youtube\.com$/.test(u.hostname) && isVideoUrl(u)) {
          if (e.cancelable) e.preventDefault();
          openFromFeed(u);
        }
      });
    }
  }

  function feedFrame() {
    var f = document.getElementById('ytproMiniFeed');
    if (f) return f;
    f = document.createElement('iframe');
    f.id = 'ytproMiniFeed';
    f.src = 'https://m.youtube.com/';
    f.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;margin:0;' +
      'z-index:2147482000;display:none';
    f.addEventListener('load', function () { wireFeed(f); });
    document.body.appendChild(f);
    return f;
  }

  function miniControls() {
    var c = document.getElementById('ytproMiniCtl');
    if (c) return c;
    c = document.createElement('div');
    c.id = 'ytproMiniCtl';
    c.style.cssText = 'position:fixed;z-index:2147482600;display:none;touch-action:none;' +
      '-webkit-tap-highlight-color:transparent';
    var btn = 'position:absolute;top:4px;width:30px;height:30px;border-radius:15px;border:0;padding:0;' +
      'background:rgba(0,0,0,.6);color:#fff;font:600 15px/30px system-ui,sans-serif;text-align:center';
    c.innerHTML = '<button data-a="play" style="' + btn + ';left:4px"></button>' +
      '<button data-a="close" style="' + btn + ';right:4px">✕</button>';

    var y0 = 0, t0 = 0;
    c.addEventListener('touchstart', function (e) {
      y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    c.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    c.addEventListener('touchend', function (e) {
      if (e.cancelable) e.preventDefault();   // no ghost click into the feed
      var dy = e.changedTouches[0].clientY - y0;
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (dy > 40) { miniClose(); return; }
      if (dy < -40) { miniExpand(); return; }
      if (Date.now() - t0 > 600) return;
      if (a === 'close') miniClose();
      else if (a === 'play') miniTogglePlay();
      else miniExpand();
    }, { passive: false });
    document.body.appendChild(c);
    return c;
  }

  function miniSyncPlay() {
    var c = document.getElementById('ytproMiniCtl');
    var v = videoEl();
    if (c) c.querySelector('[data-a="play"]').textContent = (v && !v.paused) ? '❚❚' : '▶';
  }

  function miniTogglePlay() {
    var v = videoEl();
    if (!v) return;
    if (v.paused) { var r = v.play(); if (r && r.catch) r.catch(function () {}); }
    else v.pause();
  }

  function miniPlace() {
    if (!mini) return;
    var p = mini.player;
    var W = window.innerWidth, H = window.innerHeight;
    var w0 = W, h0 = Math.round(W * mini.ratio);
    var s = Math.min(W * CFG.miniWidth, CFG.miniMaxWidth) / w0;
    s = Math.min(s, H * CFG.miniMaxHeight / h0);
    var w = w0 * s, h = h0 * s;
    var x = W - w - CFG.miniMargin;
    var y = H - h - CFG.miniBottom;
    var set = function (k, v) { p.style.setProperty(k, v, 'important'); };
    set('position', 'fixed');
    set('top', '0px');
    set('left', '0px');
    set('right', 'auto');
    set('bottom', 'auto');
    set('margin', '0');
    set('width', w0 + 'px');
    set('height', h0 + 'px');
    set('max-height', 'none');
    set('z-index', '2147482500');
    set('transform-origin', '0 0');
    set('transform', 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')');
    set('border-radius', (10 / s) + 'px');
    set('overflow', 'hidden');
    set('box-shadow', '0 ' + (4 / s) + 'px ' + (18 / s) + 'px rgba(0,0,0,.45)');
    var c = miniControls();
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.style.display = 'block';
  }

  function miniOpen() {
    if (mini || fsEl() || !onWatch()) return;
    var p = playerEl();
    if (!p) return;
    var r = p.getBoundingClientRect();
    if (!r.width || !r.height) return;
    endSpeed();
    hudHide();
    var f = feedFrame();
    f.style.background = pageBg();
    f.style.display = 'block';
    mini = { player: p, style: p.getAttribute('style'), ratio: r.height / r.width };
    miniPlace();
    miniSyncPlay();
    wireFeed(f);
  }

  function miniExpand() {
    if (!mini) return;
    var p = mini.player;
    if (mini.style === null) p.removeAttribute('style'); else p.setAttribute('style', mini.style);
    mini = null;
    var f = document.getElementById('ytproMiniFeed');
    if (f) f.style.display = 'none';   // kept loaded, so the feed position survives
    var c = document.getElementById('ytproMiniCtl');
    if (c) c.style.display = 'none';
  }

  /* Closing stops the video and leaves the user on the feed page they were browsing. */
  function miniClose() {
    if (!mini) return;
    var v = videoEl();
    try { if (v) v.pause(); } catch (e) {}
    var f = document.getElementById('ytproMiniFeed');
    var target = 'https://m.youtube.com/';
    try { if (f) target = f.contentWindow.location.href; } catch (e) {}
    location.href = target;
  }

  /* Called by MainActivity on Back; true = handled here. */
  window.__ytproBack = function () {
    if (!mini) return false;
    var f = document.getElementById('ytproMiniFeed');
    try {
      var fl = f.contentWindow.location;
      if (fl.pathname !== '/' || fl.search) { f.contentWindow.history.back(); return true; }
    } catch (e) {}
    miniExpand();
    return true;
  };

  window.addEventListener('resize', function () { if (mini) miniPlace(); });
  document.addEventListener('play', miniSyncPlay, true);
  document.addEventListener('pause', miniSyncPlay, true);

  /* Leaving the watch page (autoplay to another page, history) drops the mini player. */
  if (window.navigation) {
    window.navigation.addEventListener('navigate', function (e) {
      var u;
      try { u = new URL(e.destination.url); } catch (err) { return; }
      var w = shortsToWatch(u);
      if (w) {
        if (e.cancelable) e.preventDefault();
        location.href = w;
        return;
      }
      if (mini && u.pathname.indexOf('/watch') !== 0) miniExpand();
    });
  }

  /* ---------- no shorts in the page ---------- */

  var SHORTS_ITEMS = 'ytm-rich-item-renderer,ytm-rich-section-renderer,ytm-video-with-context-renderer,' +
    'ytm-compact-video-renderer,ytm-video-card-renderer,ytm-reel-shelf-renderer,ytm-reel-item-renderer,' +
    'grid-shelf-view-model,ytm-horizontal-card-list-renderer,ytm-shorts-lockup-view-model,' +
    'ytm-shorts-lockup-view-model-v2';
  var SHORTS_LABELS = 'ytm-pivot-bar-item-renderer,ytm-chip-cloud-chip-renderer,yt-chip-cloud-chip-renderer,' +
    'chip-shape,[role="tab"],.single-column-browse-results-tabs a';
  var SHORTS_CSS = [
    'ytm-reel-shelf-renderer', 'ytm-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model-v2',
    '.big-shorts-singleton', 'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
    ':is(' + SHORTS_ITEMS + '):has(a[href^="/shorts/"],ytm-shorts-lockup-view-model,ytm-shorts-lockup-view-model-v2)',
    'div:has(> span[data-value="shorts"])'
  ].map(function (sel) { return sel + '{display:none!important}'; }).join('\n');   // one rule each: an unsupported selector drops only itself

  function hideEl(el) {
    if (el && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
  }

  function sweepShorts(doc) {
    try {
      doc.querySelectorAll('a[href^="/shorts/"],a[href*="youtube.com/shorts/"]').forEach(function (a) {
        hideEl(a.closest(SHORTS_ITEMS) || a);
      });
      doc.querySelectorAll(SHORTS_LABELS).forEach(function (el) {
        if (el.textContent.trim().toLowerCase() === 'shorts') {
          hideEl(el.closest('ytm-pivot-bar-item-renderer,ytm-chip-cloud-chip-renderer,yt-chip-cloud-chip-renderer') || el);
        }
      });
      doc.querySelectorAll('.pivot-shorts').forEach(function (el) {
        hideEl(el.closest('ytm-pivot-bar-item-renderer') || el);
      });
      doc.querySelectorAll('span[data-value="shorts"]').forEach(function (el) { hideEl(el.parentElement); });
    } catch (e) {}
  }

  function noShorts(doc) {
    if (!doc || !doc.documentElement || doc.__ytproNoShorts) { if (doc) sweepShorts(doc); return; }
    doc.__ytproNoShorts = true;
    var css = doc.createElement('style');
    css.id = 'ytproNoShortsCss';
    css.textContent = SHORTS_CSS;
    (doc.head || doc.documentElement).appendChild(css);
    var timer = null;
    new MutationObserver(function () {
      if (timer) return;
      timer = setTimeout(function () { timer = null; sweepShorts(doc); }, 150);
    }).observe(doc.documentElement, { childList: true, subtree: true });
    sweepShorts(doc);
  }

  noShorts(document);
})();
