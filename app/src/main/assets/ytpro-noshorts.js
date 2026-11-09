/*
 * YTPro "Hide Shorts" module (fork-local).
 * Driven by the existing settings switch "Hide Shorts" (localStorage "shorts" == "true").
 * When on, Shorts disappear everywhere:
 *  - bottom navigation tab, shelves and single Shorts cards in feeds, search,
 *    subscriptions, channel pages and related videos;
 *  - the "Shorts" tab on channels and the "Shorts" filter chip;
 *  - any /shorts/<id> link or page opens as a normal video (/watch?v=<id>),
 *    the /shorts feed itself goes to the home page.
 * The switch takes effect immediately, without reloading.
 */
(function () {
  'use strict';

  if (window.__ytproNoShorts) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  window.__ytproNoShorts = true;

  var CLS = 'ytpro-noshorts';
  var SHORT_LINK = 'a[href^="/shorts/"],a[href*="youtube.com/shorts/"]';
  var CARDS = [
    'ytm-video-with-context-renderer', 'ytm-compact-video-renderer', 'ytm-rich-item-renderer',
    'ytm-media-item', 'ytm-video-card-renderer', 'ytm-playlist-video-renderer',
    'ytm-item-section-renderer > lazy-list > *'
  ];
  var H = 'html.' + CLS + ' ';

  var css =
    // whole Shorts blocks
    [ 'ytm-reel-shelf-renderer', 'ytm-reel-item-renderer', 'ytm-shorts-lockup-view-model',
      'ytm-shorts-lockup-view-model-v2', '.big-shorts-singleton', '.reel-shelf-items',
      'ytm-rich-section-renderer:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-reel-shelf-renderer)',
      'grid-shelf-view-model:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2)',
      'ytm-shelf-renderer:has(ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-reel-item-renderer)',
      // single cards that point to a Short
      CARDS.map(function (c) { return c + ':has(' + SHORT_LINK.replace(/,/g, '),' + c + ':has(') + ')'; }).join(','),
      // bottom navigation tab
      'ytm-pivot-bar-item-renderer:has(.pivot-shorts)',
      'ytm-pivot-bar-item-renderer:has(a[href="/shorts"], a[href^="/shorts?"], a[href^="/shorts/"])',
      // channel "Shorts" tab
      'yt-tab-shape[tab-title="Shorts"]',
      '.scbrr-tab:has(a[href$="/shorts"])', 'a.scbrr-tab[href$="/shorts"]'
    ].map(function (sel) {
      return sel.split(/,(?![^(]*\))/).map(function (s) { return H + s.trim(); }).join(',');
    }).join(',\n') + '{display:none!important}';

  var style = document.createElement('style');
  style.id = 'ytproNoShortsCss';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function enabled() {
    try { return localStorage.getItem('shorts') === 'true'; } catch (e) { return false; }
  }

  function shortId(href) {
    var m = /\/shorts\/([A-Za-z0-9_-]{11})/.exec(href || '');
    return m ? m[1] : null;
  }

  /* /shorts/<id> page -> normal watch page, /shorts feed -> home */
  function redirectIfShorts() {
    var p = location.pathname;
    if (p.indexOf('/shorts') !== 0) return false;
    var id = shortId(p);
    location.replace(id ? '/watch?v=' + id : '/');
    return true;
  }

  /* things CSS cannot match: elements selected by their text */
  function hideByText() {
    var chips = document.querySelectorAll('ytm-chip-cloud-chip-renderer, yt-chip-cloud-chip-renderer, chip-shape');
    for (var i = 0; i < chips.length; i++) {
      if ((chips[i].textContent || '').trim().toLowerCase() === 'shorts') hide(chips[i]);
    }
    var heads = document.querySelectorAll('ytm-rich-section-renderer, ytm-item-section-renderer, ytm-shelf-renderer');
    for (var j = 0; j < heads.length; j++) {
      var t = heads[j].querySelector('h2, .shelf-title, .reel-shelf-title, yt-section-header-view-model');
      if (t && (t.textContent || '').trim().toLowerCase() === 'shorts') hide(heads[j]);
    }
  }

  function hide(el) {
    el.setAttribute('data-ytpro-noshorts', '');
    el.style.setProperty('display', 'none', 'important');
  }

  function unhideByText() {
    var els = document.querySelectorAll('[data-ytpro-noshorts]');
    for (var i = 0; i < els.length; i++) {
      els[i].removeAttribute('data-ytpro-noshorts');
      els[i].style.removeProperty('display');
    }
  }

  var last = null;
  var queued = false;

  function apply() {
    queued = false;
    var on = enabled();
    if (on !== last) {
      document.documentElement.classList.toggle(CLS, on);
      if (!on && last !== null) unhideByText();
      last = on;
    }
    if (!on) return;
    if (redirectIfShorts()) return;
    hideByText();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(apply);
  }

  /* a tap on any Shorts link opens the plain video instead */
  document.addEventListener('click', function (e) {
    if (!enabled()) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href*="/shorts"]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var id = shortId(href);
    if (!id && !/\/shorts\/?(\?|$)/.test(href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(id ? '/watch?v=' + id : '/');
  }, true);

  /* in-app (SPA) navigation into Shorts */
  if (window.navigation && navigation.addEventListener) {
    navigation.addEventListener('navigate', function (e) {
      if (!enabled() || !e.destination) return;
      var u;
      try { u = new URL(e.destination.url); } catch (err) { return; }
      if (u.hostname.indexOf('youtube.com') === -1 || u.pathname.indexOf('/shorts') !== 0) return;
      var id = shortId(u.pathname);
      if (e.cancelable) e.preventDefault();
      location.assign(id ? '/watch?v=' + id : '/');
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(apply, 700);   // picks up the settings switch without a reload
  apply();
})();
