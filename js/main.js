/*
 * main.js — boot, the fixed-step loop, and every wire between the parts.
 *
 * This is the only file that imports from more than one lane
 * (ARCHITECTURE.md §2). It owns four things and nothing else:
 *
 *   1. THE CLOCK. Real time is accumulated into SIM_DT steps for the Match;
 *      the renderer gets the real frame time for its own decays. A tab that
 *      was hidden does not "catch up" — the game is turn-based and the lost
 *      time simply never happened.
 *   2. EVENTS -> SIDE EFFECTS. Every sim event is handed to the renderer,
 *      mapped to a sound, and used to move the DOM between screens. The sim
 *      knows none of this.
 *   3. INTENTS -> ACTIONS. The HUD pills and the keyboard both say "angle
 *      +1" or "fire"; here that becomes match.apply({...}) for the player
 *      whose turn it is, and only when it is a human's turn.
 *   4. THE SCREENS. Setup, play, pause, scoreboard, shop, match over — which
 *      is showing follows the Match's state, with a couple of deliberate
 *      pauses so a round's last explosion is seen before the table appears.
 *
 * A future multiplayer client replaces (3) with a network relay and (1) with
 * a snapshot feed; nothing else here should have to change.
 */

import { SIM_DT } from './config.js';
import { Match } from './sim/match.js';
import { PERSONALITIES } from './sim/ai.js';
import { weaponById } from './sim/weapons.js';
import { createRenderer } from './render/render.js';
import { drawMechPortrait } from './render/mech-draw.js';
import { createUI } from './ui.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';

/** Hill names for the round banner, in the game's words. */
const HILL_NAMES = {
  rolling: 'Rolling hills', mountains: 'Steep mountains', valley: 'Deep valley',
  canyon: 'The canyon', chaos: 'Jagged chaos', flat: 'Mostly flat',
};

/** Real seconds between the final blast of a round and the results table. */
const RESULTS_DELAY = 1.6;

/** Crumble is continuous; the rumble should not be. */
const CRUMBLE_COOLDOWN = 0.6;

/**
 * Walk-marker px per unit of angle intent. The angle hold-repeat tops out at
 * 110 units a second, so a held arrow crosses the whole walk range in about
 * two seconds — the same feel as sweeping the barrel.
 */
const WALK_STEP = 2;

/**
 * Turbo: once every human walker is wrecked for the round there is nothing
 * left to decide, only bots to watch, so the sim runs this many times faster
 * until the round is over. It is purely more SIM_DT steps per real second —
 * the sim never sees a different dt, so a turbo round is the same round, and
 * the bots' think pauses, barrel swings and shells all speed up together.
 *
 * It also runs on any bot's turn while humans are still in, but only if the
 * player asks: watching a rival's shot land is information, so that one is
 * off by default and the choice is remembered across visits. Two choices,
 * one button: the pill shows whichever applies right now, so it never reads
 * "on" while the game is running at normal speed. Never on a human's own
 * turn — your shot flies at the speed you aimed it.
 */
const TURBO_SPEED = 3;
const TURBO_KEY = 'lobbots.turbo.v1';

const canvas = document.getElementById('field');
const renderer = createRenderer(canvas);
const audio = createAudio();

/** @type {Match|null} */
let match = null;
let mode = 'setup';       // 'setup' | 'play'
let paused = false;
const events = [];
let accumulator = 0;
let lastFrame = performance.now();
let resultsTimer = 0;     // counts down to the scoreboard after roundOver
let crumbleTimer = 0;
let lastSpecs = null;
let lastPreset = 'default';
let lastRounds = null;
let turboOut = true;      // turbo once every human is out; per match, default on
let turboBots = loadTurboBots(); // turbo on bot turns while humans are in; remembered
let turboShown = false;   // the button is up (a bot is playing, or everyone is out)
let turboMode = null;     // 'out' | 'bots' | null: which choice the button is showing
let turboRound = 0;       // the round the "you're out" banner was last shown in

// ---------------------------------------------------------------------------
// UI and input: intents in, actions out
// ---------------------------------------------------------------------------

const ui = createUI({
  paintPortrait: drawMechPortrait,
  onStart: startMatch,
  onAngle: (d) => aimDelta({ angle: d }),
  onPower: (d) => aimDelta({ power: d }),
  onWeapon: selectWeapon,
  onFire: fire,
  onBuy: buy,
  onReady: ready,
  onPause: pause,
  onResume: resume,
  onQuit: quitMatch,
  onVolume: (v) => audio.setVolume(v),
  onTurbo: () => toggleTurbo(),
});

const input = createInput(canvas, {
  onAngle: (d) => aimDelta({ angle: d }),
  onPower: (d) => aimDelta({ power: d }),
  onWeapon: selectWeapon,
  onFire: fire,
  onPause: togglePause,
});

/** The human whose turn it is, or null. Every intent goes through this. */
function humanNow() {
  return match && mode === 'play' && !paused && match.isHumanTurn() ? match.current() : null;
}

function aimDelta({ angle = 0, power = 0 }) {
  const p = humanNow();
  if (!p) return;
  if (p.weaponId === 'move') {
    // The barrel intents walk the marker instead. A positive angle delta
    // swings the barrel LEFT (0° points right), so it walks the marker left.
    if (angle && p.moveX !== null) match.apply({ type: 'aim', playerId: p.id, moveX: p.moveX - angle * WALK_STEP });
    return;
  }
  match.apply({ type: 'aim', playerId: p.id, angle: p.angle + angle, power: p.power + power });
}

/** From the strip a weapon id; from the keyboard a direction to cycle. */
function selectWeapon(dirOrId) {
  const p = humanNow();
  if (!p) return;
  let weaponId = dirOrId;
  if (typeof dirOrId === 'number') {
    const arsenal = match.arsenal(p);
    const i = Math.max(0, arsenal.findIndex((w) => w.id === p.weaponId));
    weaponId = arsenal[(i + dirOrId + arsenal.length) % arsenal.length].id;
  }
  if (weaponId !== p.weaponId) {
    match.apply({ type: 'aim', playerId: p.id, weaponId });
    audio.play('click', { gain: 0.6 });
  }
}

function fire() {
  const p = humanNow();
  if (!p) return;
  if (p.weaponId === 'move') {
    // Refused when the first step is already a wall: nothing is spent, so
    // say why rather than leave the button looking broken.
    if (!match.apply({ type: 'move', playerId: p.id })) {
      audio.play('click', { gain: 0.5, rate: 0.7 });
      ui.banner('Cannot walk that way', 'Pick the other side, or shoot', 1100);
    }
    return;
  }
  match.apply({ type: 'fire', playerId: p.id, weaponId: p.weaponId, angle: p.angle, power: p.power });
}

function buy(itemId) {
  if (!match || match.state !== 'shop') return;
  const shopper = match.shopper();
  if (!shopper || shopper.isAI) return;
  if (!match.apply({ type: 'buy', playerId: shopper.id, itemId })) {
    audio.play('click', { gain: 0.5, rate: 0.7 });
  }
}

/** CONTINUE, DONE and AGAIN are all "the human is ready"; what it means depends on the state. */
function ready() {
  if (!match) return;
  if (match.state === 'matchOver') { backToSetup(); return; }
  if (match.state === 'scoreboard') {
    const h = match.humans()[0];
    if (h) match.apply({ type: 'ready', playerId: h.id });
    return;
  }
  if (match.state === 'shop') {
    const s = match.shopper();
    if (s && !s.isAI) match.apply({ type: 'ready', playerId: s.id });
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function startMatch(specs, settings) {
  lastSpecs = specs;
  lastPreset = settings.preset || 'default';
  lastRounds = settings.rounds;
  match = new Match(settings, specs);
  renderer.attach(match);
  renderer.setOptions({ shake: settings.shake, trails: settings.trails });
  events.length = 0;
  accumulator = 0;
  resultsTimer = 0;
  paused = false;
  turboOut = true;
  turboShown = false;
  turboMode = null;
  turboRound = 0;
  ui.setTurbo(false, true);
  mode = 'play';
  ui.hidePause();
  ui.showHud();
  match.start(events);
  processEvents();
}

function backToSetup() {
  mode = 'setup';
  paused = false;
  input.setEnabled(false);
  ui.hidePause();
  // The last battlefield stays on the canvas behind the setup panel; a hill
  // with craters in it is a better backdrop than an empty one.
  ui.showSetup(lastSpecs, lastPreset, lastRounds);
}

function quitMatch() {
  backToSetup();
}

function pause() {
  if (mode !== 'play' || paused) return;
  paused = true;
  input.setEnabled(false);
  ui.showPause();
}

function resume() {
  if (!paused) return;
  paused = false;
  ui.hidePause();
  input.setEnabled(!!humanNow());
}

function togglePause() {
  if (mode !== 'play') return;
  if (paused) resume();
  else pause();
}

// ---------------------------------------------------------------------------
// Events -> renderer, audio, screens
// ---------------------------------------------------------------------------

function processEvents() {
  if (!events.length) return;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    renderer.onEvent(e);
    react(e);
  }
  events.length = 0;
}

function react(e) {
  switch (e.type) {
    case 'roundStart': {
      ui.showHud();
      ui.banner(`Round ${e.round} of ${e.rounds}`, HILL_NAMES[e.profile] || e.profile, 1800);
      break;
    }
    case 'turnStart': {
      const p = match.player(e.playerId);
      const human = !p.isAI;
      input.setEnabled(human && !paused);
      ui.lockControls(!human);
      if (human) {
        // Hot-seat: say whose go it is when there is more than one human to confuse.
        if (match.humans().length > 1) ui.banner(`${p.name}, your turn`, 'Angle, power, fire', 1400);
      } else {
        const P = PERSONALITIES[p.personality];
        const walking = match.aiPlan && match.aiPlan.weaponId === 'move';
        ui.banner(walking ? `${p.name} is on the move` : `${p.name} is aiming`, P ? P.name : 'bot', 1000);
      }
      break;
    }
    case 'fire': {
      input.setEnabled(false);
      ui.lockControls(true);
      const w = weaponById(e.weaponId);
      audio.play('fire', { gain: 0.7 + 0.3 * (e.power / 100), rate: w.radius > 50 ? 0.8 : 1 });
      break;
    }
    case 'walkStart': {
      input.setEnabled(false);
      ui.lockControls(true);
      audio.play('click', { gain: 0.7, rate: 0.55 });
      break;
    }
    case 'walkEnd': {
      audio.play('bounce', { gain: 0.35, rate: 0.6 });
      const p = match.player(e.playerId);
      if (e.blocked && p && !p.isAI) ui.banner('Stopped short', 'Too steep to go on', 900);
      break;
    }
    case 'deathBlast': {
      // The wreck's own boom comes from the explosion event that follows;
      // this is only the headline. A nuke gets shouted.
      const p = match.player(e.id);
      const w = weaponById(e.weaponId);
      if (p) {
        if (e.weaponId === 'nuke') ui.banner(`${p.name}'s reactor goes critical`, 'NUKE', 1600);
        else ui.banner(`${p.name}'s wreck cooks off`, w.name, 1000);
      }
      break;
    }
    case 'apex': {
      // Only the shot itself whistles; a cloud of bomblets would be a choir.
      if (!e.hidden) audio.play('whistle', { gain: 0.5 });
      break;
    }
    case 'explosion': {
      if (e.mound) { audio.play('splat', { gain: 0.8 }); break; }
      const big = e.radius >= 56;
      // Smaller blasts pitch up, bigger ones down; one sample covers the set.
      const rate = clamp(1.35 - e.radius / 90, 0.55, 1.35);
      audio.play(big ? 'boom-big' : 'boom', { gain: clamp(0.5 + e.radius / 120, 0.5, 1), rate });
      break;
    }
    case 'bounce': audio.play('bounce', { gain: 0.6 }); break;
    case 'terrainChanged': {
      if (e.settling && crumbleTimer <= 0) {
        audio.play('crumble', { gain: 0.5 });
        crumbleTimer = CRUMBLE_COOLDOWN;
      }
      break;
    }
    case 'mechDied': {
      audio.play('wreck', { gain: 0.9 });
      const p = match.player(e.id);
      if (p) ui.banner(`${p.name} is wrecked`, e.cause === 'fall' ? 'The ground gave way' : '', 1200);
      break;
    }
    case 'roundOver': {
      input.setEnabled(false);
      ui.lockControls(true);
      const winner = e.winnerId ? match.player(e.winnerId) : null;
      if (winner) {
        audio.play('fanfare', { gain: 0.8 });
        ui.banner(`${winner.name} takes the round`, '', RESULTS_DELAY * 1000);
      } else {
        ui.banner('Nobody left standing', 'Everyone gets paid anyway', RESULTS_DELAY * 1000);
      }
      resultsTimer = RESULTS_DELAY;
      break;
    }
    case 'awards': break; // shown with the scoreboard when resultsTimer runs out
    case 'shopOpen': {
      // A bot has already bought everything by the time this arrives; the
      // list is held for a beat so the humans can read what to fear.
      if (e.isAI) ui.showBotShopping(match, match.lastPurchases.slice());
      else ui.showShop(match);
      break;
    }
    case 'purchase': {
      const p = match.player(e.playerId);
      if (p && !p.isAI) {
        audio.play('kaching', { gain: 0.8 });
        ui.updateShop(match);
      }
      break;
    }
    case 'shopClosed': break; // roundStart follows in the same batch
    case 'timerExpired': ui.banner('Time!', 'The shot goes as it stands', 900); break;
    case 'matchOver': {
      audio.play('fanfare', { gain: 1 });
      ui.showMatchOver(match);
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Every human has been wrecked this round and bots are still fighting it out.
 * An all-bot match is not "you are out" — nobody was ever in — so it plays at
 * normal speed; it is a show someone chose to watch.
 */
function humansOut() {
  if (!match || !match.world || (match.state !== 'aim' && match.state !== 'firing')) return false;
  const humans = match.humans();
  if (!humans.length) return false;
  for (const h of humans) {
    const m = match.world.mechFor(h.id);
    if (m && m.alive) return false;
  }
  return true;
}

/** A bot is aiming or its shot is in the air, with humans still standing. */
function botActing() {
  if (!match || (match.state !== 'aim' && match.state !== 'firing')) return false;
  const p = match.current();
  return !!p && p.isAI && match.humans().length > 0;
}

function turboOn() {
  return turboMode === 'out' ? turboOut : turboMode === 'bots' ? turboBots : false;
}

function toggleTurbo() {
  if (turboMode === 'out') turboOut = !turboOut;
  else if (turboMode === 'bots') {
    turboBots = !turboBots;
    try { localStorage.setItem(TURBO_KEY, turboBots ? '1' : '0'); } catch { /* private mode: lasts the visit */ }
  } else return;
  ui.setTurbo(true, turboOn());
}

function loadTurboBots() {
  try { return localStorage.getItem(TURBO_KEY) === '1'; } catch { return false; }
}

/** Show or hide the turbo button as the round goes; announce "out" once. */
function syncTurbo() {
  const out = humansOut();
  const want = out ? 'out' : botActing() ? 'bots' : null;
  if (want !== turboMode) {
    turboMode = want;
    turboShown = want !== null;
    ui.setTurbo(turboShown, turboOn());
    if (out && turboRound !== match.round) {
      turboRound = match.round;
      ui.banner(match.humans().length > 1 ? 'Everyone is out' : 'You are out', `Turbo ×${TURBO_SPEED} — the bots settle it`, 1400);
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastFrame) / 1000;
  lastFrame = now;
  // A hidden tab or a debugger pause hands back a huge dt; clamp it so the
  // sim steps a bounded number of times and the renderer's decays stay sane.
  if (dt > 0.1) dt = 0.1;
  if (dt < 0) dt = 0;

  if (crumbleTimer > 0) crumbleTimer -= dt;

  if (match && mode === 'play' && !paused) {
    syncTurbo();
    const speed = turboOn() ? TURBO_SPEED : 1;
    const maxSteps = 12 * speed;
    accumulator += dt * speed;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < maxSteps) {
      match.step(SIM_DT, events);
      accumulator -= SIM_DT;
      steps++;
    }
    // Fell behind badly: drop the debt rather than spiral.
    if (steps === maxSteps) accumulator = 0;
    processEvents();

    if (resultsTimer > 0) {
      resultsTimer -= dt;
      if (resultsTimer <= 0 && match.state === 'scoreboard') ui.showScoreboard(match);
    }
    ui.updateHud(match);
  }

  renderer.draw(dt);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function resize() {
  renderer.resize();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

// Sound may only start from a gesture. The first one anywhere unlocks it;
// the volume the player last chose is already in the audio module.
const unlock = () => {
  audio.unlock();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

// T toggles turbo whenever the pill is up. Not in input.js: that one is
// switched off for exactly the turns turbo is for (a bot's).
window.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || paused || !turboShown) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  toggleTurbo();
});
ui.setVolume(audio.volume);

// The way back to the arcade. exit.js is a deferred classic script from
// another repo and may be absent (served alone) or late (slow network), so
// look for it now and again shortly after load; both outcomes are normal.
function wireExit() {
  const exit = window.ArcadeExit;
  if (!exit) return false;
  const verb = exit.verb({ arcade: 'Back to the arcade', app: 'Power down' });
  ui.setExit(verb, () => {
    exit.quit().then((outcome) => {
      if (outcome === 'refused') ui.banner('This window will not close itself', 'Close it from the browser', 2500);
    });
  });
  return true;
}
if (!wireExit()) {
  window.addEventListener('load', () => { if (!wireExit()) setTimeout(wireExit, 1500); });
}

// Pausing when the tab goes away is the polite thing during a human turn;
// the sim's time simply stops, since it only moves when we step it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { accumulator = 0; lastFrame = performance.now(); }
});

ui.showSetup(null, 'default');
requestAnimationFrame(frame);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
