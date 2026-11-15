/*
 * YTPro in-app miniplayer (fork-local).
 * Injected by YTProWebViewClient.onPageFinished, BEFORE ytpro-gestures.js.
 *
 * window.ytproMini.open() (called by the swipe-down gesture on a playing video):
 *  - the watch page stays loaded, so the video keeps playing;
 *  - the video shrinks into a floating window (bottom-right by default);
 *  - the video list (m.youtube.com in a same-origin iframe) fills the screen under it.
 * Floating window:
 *  - one finger drags it, kept fully on screen;
 *  - two fingers resize it, from 30 % up to 90 % of the screen width;
 *  - a tap opens the video again, the x button stops it and closes the window;
 *  - picking a video in the list opens it as the main video.
 * The player is scaled with a transform (YouTube does not relayout it), like upstream's minimize().
 * Motion: the window follows the finger during the swipe, then every change glides with an
 * ease-out curve (open, expand, close, cancelled swipe); the list fades in and out.
 */
(function () {
  'use strict';

  if (window.__ytproMini) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  if (window.top !== window) return;          // never inside the list iframe
  window.__ytproMini = true;

  var CFG = {
    minFrac: 0.30,        // window width, share of the screen width
    maxFrac: 0.90,
    startFrac: 0.50,
    margin: 12,           // px from the screen edges for the default position
    bottomGap: 64,        // keeps the default position above the list's bottom navigation
    slop: 10,
    radius: 10
  };

  var mini = null;        // floating window: { s, x, y, w0, h0 }
  var iframe = null;
  var closeBtn = null;
  var touch = null;       // current gesture on the window
  var Z_LIST = 2147482000, Z_WIN = 2147483000, Z_BTN = 2147483001;

  function playerEl() { return document.getElementById('player-container-id'); }
  function videoEl() { return document.querySelector('.video-stream') || document.querySelector('video'); }
  function onWatch() { return location.pathname.indexOf('/watch') === 0; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function vw() { return window.innerWidth; }
  function vh() { return window.innerHeight; }
  function dist(a, b) { return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY); }
  function mid(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }
  function swallow(e) { if (e.cancelable) e.preventDefault(); e.stopImmediatePropagation(); }

  function bgColor() {
    var c = '';
    try { c = getComputedStyle(document.body).backgroundColor; } catch (e) {}
    return (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') ? '#0f0f0f' : c;
  }

  /* ---------- the list (iframe) ---------- */

  function openTop(url) {
    teardown(false);
    location.href = url;
  }

  function isVideoUrl(u) {
    return u.hostname.indexOf('youtube.com') > -1 &&
      (u.pathname.indexOf('/watch') === 0 || u.pathname.indexOf('/shorts/') === 0);
  }

  function wireIframe() {
    var w, d;
    try { w = iframe.contentWindow; d = iframe.contentDocument; } catch (e) { return; }
    if (!d || !d.body || d.__ytproWired) return;
    d.__ytproWired = true;

    try {
      if (w.trustedTypes && w.trustedTypes.createPolicy && !w.trustedTypes.defaultPolicy) {
        w.trustedTypes.createPolicy('default', {
          createHTML: function (s) { return s; }, createScriptURL: function (s) { return s; },
          createScript: function (s) { return s; }
        });
      }
    } catch (e) {}

    // YTPro itself, Hide Shorts and panel animations also work in the list
    ['script.js', 'ytpro-noshorts.js', 'ytpro-motion.js'].forEach(function (f) {
      var s = d.createElement('script');
      s.src = 'https://youtube.com/ytpro_local/' + f;
      d.body.appendChild(s);
    });

    // a video picked in the list becomes the main video
    d.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var u;
      try { u = new URL(a.getAttribute('href'), w.location.href); } catch (err) { return; }
      if (!isVideoUrl(u)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openTop(u.href);
    }, true);

    if (w.navigation && w.navigation.addEventListener) {
      w.navigation.addEventListener('navigate', function (e) {
        var u;
        try { u = new URL(e.destination.url); } catch (err) { return; }
        if (!isVideoUrl(u)) return;
        if (e.cancelable) e.preventDefault();
        openTop(u.href);
      });
    }
  }

  function ensureIframe() {
    if (iframe && iframe.isConnected) return iframe;
    iframe = document.createElement('iframe');
    iframe.id = 'ytproMiniList';
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:0;margin:0;' +
      'z-index:' + Z_LIST + ';background:' + bgColor() + ';display:none;opacity:0';
    iframe.addEventListener('load', wireIframe);
    iframe.src = 'https://m.youtube.com/';
    document.body.appendChild(iframe);
    return iframe;
  }

  /* ---------- motion ---------- */

  var EASE_OUT = 'cubic-bezier(.2,.85,.25,1)';    // quick start, long soft landing
  var EASE_IN = 'cubic-bezier(.5,0,.75,0)';
  var DUR = { open: 380, expand: 360, settle: 300, close: 240, list: 300 };
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  function ms(d) { return reduced ? 0 : d; }

  var det = null;         // detached player: { style, L, T, w0, h0, spacer }
  var prev = null;        // live swipe preview (before the window opens): { x, y, s }
  var anim = false;       // an animation is running: touches on the window are ignored
  var animToken = 0;
  var listWanted = false;

  function transformOf(x, y, s) {
    return 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
  }

  /* Run a CSS transition on el; apply() sets the end state. */
  function animateEl(el, d, ease, apply, done) {
    var token = ++animToken;
    var t = d ? ['transform', 'border-radius', 'box-shadow', 'opacity'].map(function (p) {
      return p + ' ' + d + 'ms ' + ease;
    }).join(',') : 'none';
    el.style.setProperty('transition', t, 'important');
    void el.offsetWidth;                         // commit the start state
    apply();
    var over = false;
    function fin() {
      if (over) return;
      over = true;
      el.removeEventListener('transitionend', onEnd);
      if (token !== animToken) return;           // a newer animation took over
      el.style.setProperty('transition', 'none', 'important');
      if (done) done();
    }
    function onEnd(e) { if (e.target === el && e.propertyName === 'transform') fin(); }
    el.addEventListener('transitionend', onEnd);
    setTimeout(fin, d + 90);
  }

  function fadeList(show, d) {
    listWanted = show;
    var f = show ? ensureIframe() : iframe;
    if (!f) return;
    f.style.transition = 'opacity ' + ms(d) + 'ms ' + (show ? EASE_OUT : EASE_IN);
    if (show) {
      if (f.style.display === 'none') { f.style.opacity = '0'; f.style.display = 'block'; }
      void f.offsetWidth;
      f.style.opacity = '1';
    } else {
      f.style.opacity = '0';
      setTimeout(function () { if (!listWanted && f.isConnected) f.style.display = 'none'; }, ms(d) + 40);
    }
  }

  /* Take the player out of the page flow (fixed, transform-driven) without a visual jump. */
  function detach() {
    if (det) return det;
    var p = playerEl();
    if (!p) return null;
    var r = p.getBoundingClientRect();
    var w0 = p.offsetWidth || r.width, h0 = p.offsetHeight || r.height;
    if (!w0 || !h0) return null;
    var pos = '';
    try { pos = getComputedStyle(p).position; } catch (e) {}
    var spacer = null;
    if (pos !== 'fixed' && pos !== 'absolute') {
      // keep the page below the player where it was
      spacer = document.createElement('div');
      spacer.id = 'ytproMiniSpacer';
      spacer.style.cssText = 'width:100%;height:' + h0 + 'px;flex:none';
      p.parentNode.insertBefore(spacer, p);
    }
    det = { style: p.getAttribute('style'), L: r.left, T: r.top, w0: w0, h0: h0, spacer: spacer };
    var css = p.style;
    css.setProperty('position', 'fixed', 'important');
    css.setProperty('top', '0', 'important');
    css.setProperty('left', '0', 'important');
    css.setProperty('right', 'auto', 'important');
    css.setProperty('bottom', 'auto', 'important');
    css.setProperty('margin', '0', 'important');
    css.setProperty('width', w0 + 'px', 'important');
    css.setProperty('height', h0 + 'px', 'important');
    css.setProperty('z-index', String(Z_WIN), 'important');
    css.setProperty('transform-origin', '0 0', 'important');
    css.setProperty('overflow', 'hidden', 'important');
    css.setProperty('will-change', 'transform', 'important');
    css.setProperty('transition', 'none', 'important');
    css.setProperty('transform', transformOf(r.left, r.top, 1), 'important');
    return det;
  }

  /* Put the player back exactly as YouTube had it. */
  function attach() {
    var p = playerEl();
    if (det) {
      if (p) { if (det.style === null) p.removeAttribute('style'); else p.setAttribute('style', det.style); }
      if (det.spacer) det.spacer.remove();
    }
    det = null;
    prev = null;
  }

  function setLook(p, s, k) {
    // k = 0 (in the page) .. 1 (floating window): corner radius and shadow follow
    p.style.setProperty('border-radius', (CFG.radius * k / s) + 'px', 'important');
    p.style.setProperty('box-shadow', '0 ' + (8 * k / s) + 'px ' + (28 * k / s) + 'px rgba(0,0,0,' + (0.55 * k) + ')', 'important');
  }

  /* ---------- window geometry ---------- */

  function sMin() { return CFG.minFrac * vw() / mini.w0; }
  function sMax() { return CFG.maxFrac * vw() / mini.w0; }

  function target(w0, h0) {
    var s = clamp(CFG.startFrac * vw() / w0, CFG.minFrac * vw() / w0, CFG.maxFrac * vw() / w0);
    return { s: s, x: vw() - w0 * s - CFG.margin, y: vh() - h0 * s - CFG.margin - CFG.bottomGap };
  }

  function clampPos() {
    var w = mini.w0 * mini.s, h = mini.h0 * mini.s;
    mini.x = clamp(mini.x, 0, Math.max(0, vw() - w));
    mini.y = clamp(mini.y, 0, Math.max(0, vh() - h));
  }

  function placeCloseBtn() {
    if (!closeBtn || !mini) return;
    closeBtn.style.left = (mini.x + mini.w0 * mini.s - 34) + 'px';
    closeBtn.style.top = (mini.y + 6) + 'px';
  }

  function render() {
    var p = playerEl();
    if (!p || !mini) return;
    clampPos();
    p.style.setProperty('transform', transformOf(mini.x, mini.y, mini.s), 'important');
    setLook(p, mini.s, 1);
    placeCloseBtn();
  }

  function ensureCloseBtn() {
    if (closeBtn && closeBtn.isConnected) return;
    closeBtn = document.createElement('div');
    closeBtn.id = 'ytproMiniClose';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:fixed;width:28px;height:28px;border-radius:14px;' +
      'background:rgba(0,0,0,.6);color:#fff;font:600 15px/28px system-ui,sans-serif;text-align:center;' +
      'z-index:' + Z_BTN + ';touch-action:none;-webkit-user-select:none;user-select:none;' +
      'opacity:0;transform:scale(.6);transition:opacity ' + ms(220) + 'ms ' + EASE_OUT + ',transform ' + ms(260) + 'ms ' + EASE_OUT;
    document.body.appendChild(closeBtn);
  }

  function showCloseBtn(show) {
    if (!closeBtn) return;
    void closeBtn.offsetWidth;
    closeBtn.style.opacity = show ? '1' : '0';
    closeBtn.style.transform = show ? 'scale(1)' : 'scale(.6)';
  }

  /* ---------- live swipe (called by ytpro-gestures.js while the finger moves) ---------- */

  /* k in [-1, 1]: > 0 swipe down toward the window, < 0 swipe up (a small lift toward fullscreen) */
  function preview(k) {
    if (mini || anim || document.fullscreenElement || !onWatch()) return;
    var d = det || detach();
    if (!d) return;
    var p = playerEl();
    var x, y, s;
    if (k >= 0) {
      var t = target(d.w0, d.h0);
      s = 1 + (t.s - 1) * k;
      x = d.L + (t.x - d.L) * k;
      y = d.T + (t.y - d.T) * k;
      setLook(p, s, k);
      var f = ensureIframe();
      listWanted = true;
      f.style.transition = 'none';
      f.style.display = 'block';
      f.style.opacity = String(Math.min(1, k * 1.15));
    } else {
      var u = Math.min(1, -k);
      s = 1 + 0.035 * u;
      x = d.L - d.w0 * (s - 1) / 2;
      y = d.T - d.h0 * (s - 1) / 2;
      setLook(p, s, 0);
      if (iframe) { listWanted = false; iframe.style.transition = 'none'; iframe.style.opacity = '0'; iframe.style.display = 'none'; }
    }
    prev = { x: x, y: y, s: s };
    p.style.setProperty('transform', transformOf(x, y, s), 'important');
  }

  /* the swipe did not reach the threshold: glide back into the page */
  function previewCancel(instant) {
    if (mini || !det) return;
    var p = playerEl();
    var d = det;
    if (iframe) fadeList(false, instant ? 0 : DUR.list);
    if (!p || instant || reduced) { attach(); return; }
    anim = true;
    animateEl(p, DUR.settle, EASE_OUT, function () {
      p.style.setProperty('transform', transformOf(d.L, d.T, 1), 'important');
      setLook(p, 1, 0);
    }, function () { anim = false; attach(); });
  }

  /* ---------- open / expand / close ---------- */

  function open() {
    if (mini || anim || document.fullscreenElement || !onWatch()) return false;
    var d = det || detach();
    if (!d) return false;
    var p = playerEl();
    var t = target(d.w0, d.h0);
    mini = { s: t.s, x: t.x, y: t.y, w0: d.w0, h0: d.h0 };
    document.documentElement.classList.add('ytpro-mini');
    fadeList(true, DUR.list);
    ensureCloseBtn();
    placeCloseBtn();
    anim = true;
    animateEl(p, ms(DUR.open), EASE_OUT, function () {
      p.style.setProperty('transform', transformOf(mini.x, mini.y, mini.s), 'important');
      setLook(p, mini.s, 1);
    }, function () {
      anim = false;
      prev = null;
      render();
      showCloseBtn(true);
    });
    return true;
  }

  function dropCloseBtn() {
    if (!closeBtn) return;
    var b = closeBtn;
    closeBtn = null;
    b.style.opacity = '0';
    b.style.transform = 'scale(.6)';
    setTimeout(function () { b.remove(); }, ms(200) + 20);
  }

  /* back to the full watch page */
  function expand() {
    if (!mini || anim) return;
    var p = playerEl();
    var d = det;
    dropCloseBtn();
    fadeList(false, DUR.list);
    anim = true;
    animateEl(p, ms(DUR.expand), EASE_OUT, function () {
      p.style.setProperty('transform', transformOf(d.L, d.T, 1), 'important');
      setLook(p, 1, 0);
    }, function () {
      anim = false;
      mini = null;
      touch = null;
      attach();
      document.documentElement.classList.remove('ytpro-mini');
    });
  }

  /* stop the video, keep the list on screen */
  function close() {
    if (!mini || anim) return;
    var v = videoEl();
    try { if (v) v.pause(); } catch (e) {}
    var p = playerEl();
    var k = 0.82, cx = mini.x + mini.w0 * mini.s * (1 - k) / 2, cy = mini.y + mini.h0 * mini.s * (1 - k) / 2;
    dropCloseBtn();
    anim = true;
    animateEl(p, ms(DUR.close), EASE_IN, function () {
      p.style.setProperty('transform', transformOf(cx, cy, mini.s * k), 'important');
      p.style.setProperty('opacity', '0', 'important');
    }, function () {
      anim = false;
      mini = null;
      touch = null;
      attach();
      var q = playerEl();
      if (q) q.style.setProperty('visibility', 'hidden', 'important');
      document.documentElement.classList.remove('ytpro-mini');
    });
  }

  /* the main page leaves the watch page (back button etc.): drop everything at once */
  function teardown(removeList) {
    ++animToken;
    anim = false;
    mini = null;
    touch = null;
    if (closeBtn) { closeBtn.remove(); closeBtn = null; }
    attach();
    document.documentElement.classList.remove('ytpro-mini');
    var p = playerEl();
    if (p && p.style.visibility === 'hidden') p.style.removeProperty('visibility');
    if (iframe) {
      listWanted = false;
      if (removeList !== false) { iframe.remove(); iframe = null; }
      else iframe.style.display = 'none';
    }
  }

  /* ---------- touches on the floating window ---------- */

  function onWindow(target) {
    var p = playerEl();
    return !!(mini && ((p && p.contains(target)) || (closeBtn && closeBtn.contains(target))));
  }

  function onStart(e) {
    if (anim && onWindow(e.target)) { swallow(e); return; }
    if (!mini) return;
    var t0 = e.touches[0];
    if (!touch) {
      if (!onWindow(e.target)) return;
      touch = { mode: null, x0: t0.clientX, y0: t0.clientY, mx: mini.x, my: mini.y, onBtn: !!(closeBtn && closeBtn.contains(e.target)) };
    }
    if (e.touches.length >= 2) {
      var a = e.touches[0], b = e.touches[1];
      touch.mode = 'pinch';
      touch.d0 = dist(a, b) || 1;
      touch.s0 = mini.s;
      touch.c0 = mid(a, b);
      touch.mx = mini.x; touch.my = mini.y;
    }
    swallow(e);
  }

  function onMove(e) {
    if (!touch || anim) { if (touch) swallow(e); return; }
    swallow(e);
    if (!mini) return;
    if (touch.mode === 'pinch') {
      if (e.touches.length < 2) return;
      var a = e.touches[0], b = e.touches[1];
      var s = clamp(touch.s0 * dist(a, b) / touch.d0, sMin(), sMax());
      var c = mid(a, b);
      // keep the point between the fingers under the fingers
      mini.x = c.x - (touch.c0.x - touch.mx) * (s / touch.s0);
      mini.y = c.y - (touch.c0.y - touch.my) * (s / touch.s0);
      mini.s = s;
      render();
      return;
    }
    var t = e.touches[0];
    var dx = t.clientX - touch.x0, dy = t.clientY - touch.y0;
    if (!touch.mode) {
      if (Math.abs(dx) < CFG.slop && Math.abs(dy) < CFG.slop) return;
      touch.mode = 'drag';
    }
    if (touch.mode === 'drag') {
      mini.x = touch.mx + dx;
      mini.y = touch.my + dy;
      render();
    }
  }

  function onEnd(e) {
    if (!touch) return;
    swallow(e);
    if (e.touches.length > 0) {
      // one finger left after a pinch: continue as a drag from here
      if (touch.mode === 'pinch' && mini) {
        var t = e.touches[0];
        touch = { mode: 'drag', x0: t.clientX, y0: t.clientY, mx: mini.x, my: mini.y, onBtn: false };
      }
      return;
    }
    var g = touch;
    touch = null;
    if (e.type === 'touchcancel' || g.mode) return;
    if (g.onBtn) close(); else expand();          // a tap
  }

  window.addEventListener('touchstart', onStart, { capture: true, passive: false });
  window.addEventListener('touchmove', onMove, { capture: true, passive: false });
  window.addEventListener('touchend', onEnd, { capture: true, passive: false });
  window.addEventListener('touchcancel', onEnd, { capture: true, passive: false });

  // ghost clicks / mouse events on the window must not reach YouTube's player
  ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (onWindow(e.target)) swallow(e); }, true);
  });

  window.addEventListener('resize', function () { if (mini) render(); });

  // leaving the watch page (back button, links on the page) closes the miniplayer
  function onRoute() {
    if (!onWatch() && (mini || iframe)) teardown(true);
  }
  if (window.navigation && navigation.addEventListener) {
    navigation.addEventListener('navigatesuccess', onRoute);
  }
  window.addEventListener('popstate', function () { setTimeout(onRoute, 0); });
  window.addEventListener('yt-navigate-finish', onRoute);

  /* Android back button (asked by MainActivity before WebView.goBack). Returns true when handled.
     Uses the Navigation API so only the right frame's own history is walked: the list iframe
     would otherwise leave invisible entries in WebView's joint history. */
  function back() {
    if (!iframe || !iframe.isConnected) return false;
    var visible = iframe.style.display !== 'none';
    var w = null;
    try { w = iframe.contentWindow; } catch (e) {}
    if (visible && w && w.navigation && w.navigation.canGoBack) {
      w.navigation.back();
      return true;
    }
    if (mini) { expand(); return true; }
    teardown(true);
    if (window.navigation && navigation.canGoBack) { navigation.back(); return true; }
    return false;
  }

  window.ytproMini = {
    open: open,
    expand: expand,
    close: close,
    preview: preview,
    previewCancel: previewCancel,
    back: back,
    isOpen: function () { return !!mini; }
  };
})();
