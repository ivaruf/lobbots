/*
 * screen.js — the fullscreen pill in the top-right corner cluster (#corner).
 *
 * DELIBERATELY SELF-CONTAINED, the same shape as js/update.js: it imports
 * nothing and exports nothing, and no other module knows it exists.
 * index.html loads it as its own module script, independent of js/main.js, so
 * a game that fails to boot for some unrelated reason does not also take down
 * the one button that makes a 1600x900 battlefield legible on a phone.
 *
 * NOT NAMED fullscreen.js, and the word does not appear in this path at all.
 * uBlock Origin's DEFAULT filter lists carry a rule matching any repo under
 * github.io whose basename is "fullscreen.js" — it blanked fishtank for every
 * visitor running uBlock, because a blocked import aborts the whole module
 * graph (hub CLAUDE.md §2). This file is the renamed shape fishtank landed on.
 *
 * SUPPORT IS NOT UNIVERSAL. Safari on iPhone has no Element.requestFullscreen
 * at all — fullscreen there is reserved for <video> — and a button that does
 * nothing when pressed is worse than no button, so the first thing this file
 * does is check for a working request/exit pair and leave the button hidden
 * (as index.html already has it) when there is none. The cluster it sits in
 * shrinks to the pills that remain; nothing else has to know.
 *
 * Escape leaves fullscreen without ever touching this button, and so does the
 * browser's own chrome, so the label and aria-pressed are kept in sync from
 * the fullscreenchange event rather than only from the click handler.
 *
 * ORIENTATION comes with it, and only with it: a browser will pin the
 * orientation of a fullscreen page and of nothing else. A phone held upright
 * gets a letterboxed strip of a wide battlefield, so one tap here asks for
 * landscape as well — best effort, because Safari has no Screen Orientation
 * lock and a desktop refuses politely. The request is never awaited and its
 * failure is swallowed: going fullscreen must not depend on it.
 *
 * It works inside the arcade's iframe: the arcade's allow list already grants
 * `fullscreen`.
 */

const button = document.getElementById("screen-toggle");
const root = document.documentElement;

// webkit-prefixed forms are the fallback for older Safari; everywhere else
// this game runs, the unprefixed standard names are what exist.
const request = root.requestFullscreen || root.webkitRequestFullscreen || null;
const exit = document.exitFullscreen || document.webkitExitFullscreen || null;

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/*
 * Keep the label and aria-pressed matching reality, whoever changed it.
 *
 * The pill is a glyph, so this writes aria-label and title rather than
 * textContent — and that is not a downgrade in what it says, it is the only
 * thing that says anything at all to a screen reader. The picture is swapped
 * by CSS off the same aria-pressed, so the two cannot drift.
 *
 * The words stay plain, against this hub's habit of naming controls the way
 * the game would. Fullscreen is not part of the fiction; it is a thing the
 * browser does, it has one name everywhere, and the player already knows it.
 */
function paint() {
  const active = isFullscreen();
  const label = active ? "Exit fullscreen" : "Fullscreen";
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", label);
  button.title = label;
}

/** Ask for landscape once we are actually fullscreen. Best effort, always. */
function lockLandscape() {
  try {
    const lock = screen.orientation && screen.orientation.lock;
    if (!lock) return;
    const result = lock.call(screen.orientation, "landscape");
    // Desktop Chrome rejects this with NotSupportedError and Firefox with
    // SecurityError; neither is news and neither may reach the crash bar.
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // No Screen Orientation API (Safari). The page is still fullscreen.
  }
}

if (button && request && exit) {
  button.hidden = false;
  paint();

  button.addEventListener("click", () => {
    if (isFullscreen()) {
      try {
        // Release the orientation before leaving, or a phone can stay pinned
        // sideways in a windowed page.
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      } catch {
        // Nothing to release. Carry on and exit.
      }
      const left = exit.call(document);
      if (left && typeof left.catch === "function") left.catch(() => {});
      return;
    }
    const entered = request.call(root);
    // The call returns a promise that can reject — a permissions policy
    // refusing it, or the player backing out of a browser prompt. paint() via
    // fullscreenchange already reports what actually happened, so this handler
    // exists only to stop a refusal surfacing as an unhandled rejection on
    // index.html's crash bar.
    if (entered && typeof entered.then === "function") {
      entered.then(lockLandscape).catch(() => {});
    } else {
      // Prefixed webkit path returns nothing; fullscreenchange will land.
      lockLandscape();
    }
  });

  // The button is not the only way out of fullscreen — Escape, or the
  // browser's own chrome — so the label has to be able to catch up from
  // outside the click handler too.
  document.addEventListener("fullscreenchange", paint);
  document.addEventListener("webkitfullscreenchange", paint);
}
