/*
 * YTPro motion module (fork-local): smooth open/close for the upstream YTPro panels
 * (settings, downloads, favourites). Upstream inserts and removes them instantly.
 *  - open: the dimmed backdrop fades in, the sheet slides up with a soft landing;
 *  - close: element.remove() on a panel plays the reverse animation, then removes it.
 * Honours the system "remove animations" setting (prefers-reduced-motion).
 */
(function () {
  'use strict';

  if (window.__ytproMotion) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  window.__ytproMotion = true;

  var OVERLAYS = ['settingsprodiv', 'outerheartsdiv', 'outerdownytprodiv'];
  var SHEETS = ['ssprodivI', 'heartytprodiv', 'downytprodiv'];
  var EASE_OUT = 'cubic-bezier(.2,.85,.25,1)';
  var EASE_IN = 'cubic-bezier(.5,0,.75,0)';
  var OUT_MS = 220;

  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var ov = OVERLAYS.map(function (id) { return '#' + id; }).join(',');
  var sh = SHEETS.map(function (id) { return '#' + id; }).join(',');

  var css = document.createElement('style');
  css.id = 'ytproMotionCss';
  css.textContent =
    '@keyframes ytproFadeIn{from{opacity:0}}' +
    '@keyframes ytproSheetIn{from{opacity:0;transform:translateY(48px) scale(.97)}}' +
    '@keyframes ytproFadeOut{to{opacity:0}}' +
    '@keyframes ytproSheetOut{to{opacity:0;transform:translateY(36px) scale(.98)}}' +
    ov + '{animation:ytproFadeIn .26s ' + EASE_OUT + ' both}' +
    sh + '{animation:ytproSheetIn .42s ' + EASE_OUT + ' both}' +
    '[data-ytpro-closing]{pointer-events:none!important;animation:ytproFadeOut ' + OUT_MS + 'ms ' + EASE_IN + ' both!important}' +
    '[data-ytpro-closing] :is(' + sh + '){animation:ytproSheetOut ' + OUT_MS + 'ms ' + EASE_IN + ' both!important}' +
    '@media (prefers-reduced-motion: reduce){' + ov + ',' + sh + ',[data-ytpro-closing],[data-ytpro-closing] *{animation:none!important}}';
  (document.head || document.documentElement).appendChild(css);

  if (reduced) return;

  var nativeRemove = Element.prototype.remove;
  Element.prototype.remove = function () {
    if (this.id && OVERLAYS.indexOf(this.id) > -1 && this.isConnected && !this.hasAttribute('data-ytpro-closing')) {
      var el = this;
      el.setAttribute('data-ytpro-closing', '');
      setTimeout(function () { nativeRemove.call(el); }, OUT_MS + 20);
      return;
    }
    return nativeRemove.call(this);
  };
})();
