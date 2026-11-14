/*
 * YTPro background-play fix (fork-local).
 * MainActivity calls ytproBackground(true) from onStop (screen locked, app minimised without PiP)
 * and ytproBackground(false) from onStart, when "Background Play" is on.
 *
 * YouTube pauses the video itself when it detects the page went to the background. Upstream only
 * blocked that in PiP (pauseAllowed = false). The same block is applied here for every background
 * case. Pausing from the notification / headset still works: bgplay.js sets PIPause for those.
 */
(function () {
  'use strict';

  if (window.__ytproBgFix) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  window.__ytproBgFix = true;

  var inBg = false;

  function inPip() { return typeof isPIP !== 'undefined' && !!isPIP; }

  window.ytproBackground = function (bg) {
    bg = !!bg;
    if (bg === inBg) return;
    inBg = bg;
    if (inPip()) return;                 // PiP already manages pauseAllowed itself
    try {
      window.PIPause = false;
      window.pauseAllowed = !bg;
    } catch (e) {}
  };

  window.ytproIsBackground = function () { return inBg; };
})();
