/*
 * update.js — registering the service worker, and the one button that accepts
 * a new build.
 *
 * DELIBERATELY SELF-CONTAINED. It imports nothing and exports nothing, and no
 * other module knows it exists. index.html loads it as its own module script,
 * BEFORE js/main.js, so that a game which fails to boot can still be updated
 * out of whatever broke it — a module graph aborts as a whole when one import
 * fails (see the note on filenames in the hub's CLAUDE.md §2), and an update
 * button living inside main.js's graph would die with it.
 *
 * THE CONTRACT WITH sw.js
 *   Registered with { updateViaCache: 'none' } and update() called at launch,
 *   so a changed sw.js is noticed on every visit instead of whenever the
 *   browser feels like revalidating it. A new worker precaches and then WAITS.
 *   This file shows #update when one is waiting; the tap is the ONLY thing in
 *   the game that posts SKIP_WAITING, and the reload happens only after a
 *   takeover WE asked for.
 *
 * WHY THE BUTTON IS ON THE SETUP SCREEN
 *   #setup is hidden for the whole of a match, so the button is unreachable
 *   while a round is running. That is the mechanism behind "a deploy must never
 *   destroy a run in progress" (hub §1): not a check inside the click handler,
 *   but a control that does not exist on screen until the players are back at
 *   the seat list. A reload between rounds would still cost a match, which is
 *   why it is never automatic.
 *
 * WHY THE FIRST INSTALL IS NOT AN UPDATE
 *   On a first visit the worker installs with no controller to replace, and it
 *   activates immediately. Offering "update ready" there would be a button that
 *   reloads the page for no reason, so every path below checks that a
 *   controller already exists before treating an installed worker as news.
 */

const button = document.getElementById("update");
const buildLine = document.getElementById("build");

/*
 * Its own words, because this file imports nothing (it must outlive a broken
 * game graph) — js/i18n.js included. The language is read off <html lang>,
 * which the head of index.html sets before first paint, and repainted when
 * i18n.js announces a switch with `arcade:lang`.
 */
const WORDS = {
  nb: { title: "Ny versjon klar", sub: "Trykk for å hente den", taking: "Henter den nye versjonen …", build: "Versjon" },
  en: { title: "Update ready", sub: "Tap to take it", taking: "Taking the new build…", build: "Build" },
};
const words = () => WORDS[document.documentElement.lang] || WORDS.en;
let version = "";

function paint() {
  const w = words();
  if (button) {
    const title = button.querySelector(".update-title");
    const sub = button.querySelector(".update-sub");
    if (title) title.textContent = w.title;
    if (sub) sub.textContent = accepted ? w.taking : w.sub;
  }
  if (buildLine && version) buildLine.textContent = `${w.build} ${version}`;
}
document.addEventListener("arcade:lang", paint);

/*
 * Did WE ask for the takeover? `controllerchange` also fires for reasons that
 * are none of our business — another tab of the same game accepting the update,
 * most obviously — and reloading on those would be exactly the mid-match reload
 * the waiting worker exists to prevent. Only our own tap sets this.
 */
let accepted = false;

/** Show the button, wired to the specific worker that is waiting. */
function offer(worker) {
  if (!button || !worker) return;
  paint();
  button.hidden = false;
  button.onclick = () => {
    accepted = true;
    button.disabled = true;
    paint();
    worker.postMessage({ type: "SKIP_WAITING" });
    // controllerchange never comes after a hard refresh (the page is
    // uncontrolled) or if this worker has gone redundant, and then the button
    // would sit at "updating" forever. The tap was a request to reload, so a
    // reload follows anyway (maxgear/js/main.js, dam_break/src/main.js).
    setTimeout(() => location.reload(), 3000);
  };
}

/*
 * Keep Enter and Space on this button from ALSO reaching the game's own key
 * bindings, where Space and Enter are FIRE.
 *
 * js/input.js is supposed to ignore keys while a button has focus, and it is
 * disabled outside a human's aiming turn besides — so on today's code this
 * guard is belt and braces. It stays because the failure it prevents is silent
 * and expensive (accept the update, fire a shot, reload a second later onto a
 * match that had just resumed) and because this button should not depend on a
 * promise made in a file that is not ours to change. Capture phase on the same
 * target runs before any bubble listener and stops the event reaching it, so
 * the button activates and nothing else does. preventDefault is for Space,
 * which would otherwise also scroll the page.
 */
if (button) {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.target !== button) return;
      if (event.code !== "Enter" && event.code !== "Space") return;
      event.preventDefault();
      event.stopPropagation();
      button.click();
    },
    true,
  );
}

/**
 * Ask the worker which build is actually serving this session and print it.
 *
 * Worth the twelve lines: the string baked into a page is the build the page
 * came from, which during a botched release is the one question you cannot
 * answer by looking. A MessageChannel gives the worker somewhere to reply.
 */
function showBuild() {
  const worker = navigator.serviceWorker.controller;
  if (!worker || !buildLine) return;
  try {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const v = event.data && event.data.version;
      if (!v) return;
      version = v;
      paint();
      buildLine.hidden = false;
    };
    worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
  } catch {
    // No version line. The game is entirely unaffected, which is the point.
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!accepted) return;
    // The new worker is in charge. Reload so every module in this session comes
    // from the same build — and we can only be here from the setup screen,
    // because that is the only place the button exists.
    location.reload();
  });

  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      // Already waiting when we arrived: a previous visit precached it and the
      // player closed the tab before accepting.
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

      reg.addEventListener("updatefound", () => {
        const fresh = reg.installing;
        if (!fresh) return;
        fresh.addEventListener("statechange", () => {
          if (fresh.state === "installed" && navigator.serviceWorker.controller) {
            offer(fresh);
          }
        });
      });

      // Check for a new sw.js now rather than waiting for the browser to think
      // of it. Harmless when there is nothing new; it is one conditional GET.
      reg.update().catch(() => {});
    })
    .catch((err) => {
      // An insecure origin, a private window that blocks workers, a user who
      // has turned them off. The game runs perfectly without one — it simply
      // loses offline play and the install prompt.
      console.warn("Lobbots: no service worker this session", err);
    });

  if (navigator.serviceWorker.controller) showBuild();
  else navigator.serviceWorker.ready.then(showBuild).catch(() => {});
}
