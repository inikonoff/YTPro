/*
 * YTPro gestures module (fork-local).
 * Injected by YTProWebViewClient.onPageFinished AFTER the upstream scripts.
 * Works on top of upstream YTPro and does not modify scripts/*.
 *
 * Gestures
 *  - Fullscreen, left zone  : vertical swipe = brightness (remembered between videos)
 *  - Fullscreen, right zone : vertical swipe = volume
 *  - Fullscreen, centre zone: swipe down = exit fullscreen
 *  - Normal mode, on video  : swipe up = fullscreen, swipe down = picture-in-picture
 *  - Any mode, hold still   : 2x speed while the finger is down
 *  - Fullscreen, pinch      : spread = fill screen, pinch in = reset
 *
 * Actions that need a user activation (requestFullscreen) run on touchend.
 */
(function () {
  'use strict';

  if (window.__ytproGest) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  window.__ytproGest = true;

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
    brtKey: 'ytproGestBrt'
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

  function goPip() {
    if (typeof PIPlayer === 'function') {
      try { PIPlayer(true); return; } catch (e) {}
    }
    if (!HAS_ANDROID) return;
    var v = videoEl();
    var r = v ? v.getBoundingClientRect() : null;
    Android.pipvid(r && r.height > r.width ? 'portrait' : 'landscape');
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
        if (dy <= -threshold(st)) hud('⤢ Release: fullscreen', true);
        else if (dy >= threshold(st)) hud('⧉ Release: PiP', true);
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
      else if (dy >= T) goPip();
    } else if (s.mode === 'exit') {
      if (dy >= T) leaveFullscreen();
    }
  }

  /* ---------- fullscreen transitions ---------- */

  document.addEventListener('fullscreenchange', function () {
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
})();
