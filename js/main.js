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
 * ONLINE (js/net/) replaces exactly those two and nothing else, as the
 * architecture always said it would. (1): the clock is the host's, and a
 * replica steps this Match only as far as the host has announced. (3): a
 * decision goes to the host instead of straight into match.apply, and comes
 * back stamped with the tick it belongs to. Everything else — the renderer,
 * the sounds, the screens — runs from this device's own Match and its own
 * events, exactly as in hot-seat, because this device's Match IS the host's
 * battle (protocol.js says why that holds). What online adds here is who
 * may touch what: `mine` is the seats this device drives, and a turn that
 * is not one of them is watched, not played.
 *
 * The online modules are imported the first time somebody taps Play online,
 * never at boot: a hot-seat game must not depend on a single network file,
 * because one failed import takes a whole module graph down (hub §2).
 *
 * WORDS. Every banner here is handed to the UI as functions that make their
 * text with t() rather than as finished strings, so a language switch mid-
 * banner says it again in the new language (js/i18n.js). What crosses to
 * another device is a key — 'full', 'hostEnded' — never a sentence.
 */

import { SIM_DT } from './config.js';
import { Match } from './sim/match.js';
import { weaponById } from './sim/weapons.js';
import { t, errText, whyText } from './i18n.js';
import { createRenderer } from './render/render.js';
import { drawMechPortrait } from './render/mech-draw.js';
import { createUI } from './ui.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { randomSeed } from './sim/rng.js';


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
 * Bot speed, the pause panel's slider: how many times faster the sim runs
 * while a bot is playing — on its turns, and for the rest of a round every
 * human is already out of. It is purely more SIM_DT steps per real second;
 * the sim never sees a different dt, so a fast round is the same round, and
 * the bots' think pauses, barrel swings and shells all speed up together.
 * A human's own shot always flies at ×1. Remembered across visits.
 */
const BOT_SPEED_KEY = 'lobbots.botspeed.v1';

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
let botSpeed = loadBotSpeed();
let outRound = 0;         // the round the "you are out" banner was last shown in
let wereOut = false;

/**
 * Online. `online` is the hangar this device is in, between matches and
 * during them: { kind: 'host'|'guest', session }. `net` is the online match
 * in progress: { role, replica, link (host only), mine: Set of player ids }.
 * Both null in hot-seat, which is every code path's cue to behave as before.
 */
let online = null;
let net = null;
let lobby = null;
let netModules = null;
let hostHealth = { reachable: true, note: '' };
let tappedReady = false;
let waitingNames = [];

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
  onSkip: () => (net ? net.replica.send({ t: 'skip' }) : skipRound()),
  onOnline: openLobby,
  onCloseHangar: closeHangar,
  onSeatsChanged: pushRoom,
  onBotSpeed: (v) => {
    botSpeed = v;
    net?.link?.setSpeed(v);
    try { localStorage.setItem(BOT_SPEED_KEY, String(v)); } catch { /* private mode: lasts the visit */ }
  },
});

const input = createInput(canvas, {
  onAngle: (d) => aimDelta({ angle: d }),
  onPower: (d) => aimDelta({ power: d }),
  onWeapon: selectWeapon,
  onFire: fire,
  onPause: togglePause,
});

/** Is this player driven from this device? Everyone is, in hot-seat. */
function isMine(p) {
  return !!p && (!net || net.mine.has(p.id));
}

/** The human whose turn it is, or null. Every intent goes through this. */
function humanNow() {
  return match && mode === 'play' && !paused && match.isHumanTurn() && isMine(match.current()) ? match.current() : null;
}

/** A decision: into the Match here, or to the host online. */
function act(action) {
  if (!net) return match.apply(action);
  net.replica.act(action);
  return true;
}

function aimDelta({ angle = 0, power = 0 }) {
  const p = humanNow();
  if (!p) return;
  if (p.weaponId === 'move') {
    // The barrel intents walk the marker instead. A positive angle delta
    // swings the barrel LEFT (0° points right), so it walks the marker left.
    if (angle && p.moveX !== null) act({ type: 'aim', playerId: p.id, moveX: p.moveX - angle * WALK_STEP });
    return;
  }
  act({ type: 'aim', playerId: p.id, angle: p.angle + angle, power: p.power + power });
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
    act({ type: 'aim', playerId: p.id, weaponId });
    audio.play('click', { gain: 0.6 });
  }
}

function fire() {
  const p = humanNow();
  if (!p) return;
  if (p.weaponId === 'move') {
    // Refused when the first step is already a wall: nothing is spent, so
    // say why rather than leave the button looking broken. Online the host
    // decides, so ask this device's copy of the hill the same question first.
    if (!(net ? canWalk(p) && act({ type: 'move', playerId: p.id, x: p.moveX }) : match.apply({ type: 'move', playerId: p.id }))) {
      audio.play('click', { gain: 0.5, rate: 0.7 });
      ui.banner(() => t('cannotWalk'), () => t('cannotWalkSub'), 1100);
    }
    return;
  }
  act({ type: 'fire', playerId: p.id, weaponId: p.weaponId, angle: p.angle, power: p.power });
}

/** world.walk's own refusal, asked without walking. */
function canWalk(p) {
  const m = match.world && match.world.mechFor(p.id);
  if (!m || !m.alive || m.falling || p.moveX === null) return false;
  const preview = match.world.walkPreview(p.id, p.moveX);
  return !!preview && preview.x !== Math.round(m.x);
}

function buy(itemId) {
  if (!match || match.state !== 'shop') return;
  const shopper = match.shopper();
  if (!shopper || shopper.isAI || !isMine(shopper)) return;
  if (!act({ type: 'buy', playerId: shopper.id, itemId })) {
    audio.play('click', { gain: 0.5, rate: 0.7 });
  }
}

/** CONTINUE, DONE and AGAIN are all "the human is ready"; what it means depends on the state. */
function ready() {
  if (!match) return;
  if (match.state === 'matchOver') { net ? finishOnline() : backToSetup(); return; }
  if (match.state === 'scoreboard') {
    // Online the table waits for every device, so this is a vote, cast once.
    const h = match.humans().find(isMine);
    if (!h || (net && tappedReady)) return;
    if (net) {
      tappedReady = true;
      ui.setWaiting(waitingNames, true);
    }
    act({ type: 'ready', playerId: h.id });
    return;
  }
  if (match.state === 'shop') {
    const s = match.shopper();
    if (s && !s.isAI && isMine(s)) act({ type: 'ready', playerId: s.id });
  }
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function startMatch(specs, settings) {
  if (online && online.kind === 'host') { startHostMatch(specs, settings); return; }
  lastSpecs = specs;
  lastPreset = settings.preset || 'default';
  lastRounds = settings.rounds;
  beginMatch(new Match(settings, specs));
}

/** Everything a new Match needs on this device, hot-seat or online. */
function beginMatch(m) {
  match = m;
  renderer.attach(match);
  renderer.setOptions({ shake: match.settings.shake, trails: match.settings.trails });
  events.length = 0;
  accumulator = 0;
  resultsTimer = 0;
  paused = false;
  outRound = 0;
  wereOut = false;
  mode = 'play';
  tappedReady = false;
  waitingNames = [];
  ui.setOnline(net ? net.role : null);
  ui.hidePause();
  ui.showHud();
  net?.replica.attach(match);
  match.start(events);
  processEvents();
}

function backToSetup() {
  mode = 'setup';
  paused = false;
  input.setEnabled(false);
  ui.hidePause();
  // The last battlefield stays on the canvas behind the setup panel; a hill
  // with craters in it is a better backdrop than an empty one. A host with
  // a hangar open goes back to the setup exactly as it was, friends seated.
  if (online && online.kind === 'host') ui.returnToSetup();
  else ui.showSetup(lastSpecs, lastPreset, lastRounds);
}

function quitMatch() {
  if (net && net.role === 'host') {
    online.session.endMatch('hostEnded');
    endNetMatch();
  } else if (net) {
    // A guest who leaves the match leaves the hangar: their seat goes to a
    // bot, and the others play on.
    leaveHangar();
  }
  backToSetup();
}

function pause() {
  if (mode !== 'play') return;
  // Online, the panel opens and nothing stops: the hill is everyone's, and
  // the controls keep working underneath it (hub §2, the networked menu).
  if (net) { ui.showPause(); return; }
  if (paused) return;
  paused = true;
  input.setEnabled(false);
  ui.showPause();
}

function resume() {
  if (net) { ui.hidePause(); return; }
  if (!paused) return;
  paused = false;
  ui.hidePause();
  input.setEnabled(!!humanNow());
}

function togglePause() {
  if (mode !== 'play') return;
  if (net) { if (ui.paused) resume(); else pause(); return; }
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
      // A hill profile the table does not know shows its key: a new profile is
      // a missing translation, and i18n.js says so in the console.
      ui.banner(() => t('roundBanner', e.round, e.rounds), () => t(`hill.${e.profile}`), 1800);
      break;
    }
    case 'turnStart': {
      const p = match.player(e.playerId);
      const human = !p.isAI;
      const mine = human && isMine(p);
      input.setEnabled(mine && !paused);
      ui.lockControls(!mine);
      if (mine) {
        // Hot-seat: say whose go it is when there is more than one human to
        // confuse. Online: always, because the turn came from somewhere else.
        if (net || match.humans().length > 1) ui.banner(() => t('yourTurn', p.name), () => t('yourTurnSub'), 1400);
      } else if (human) {
        ui.banner(() => t('aiming', p.name), () => t('ownScreen'), 1000);
      } else {
        const walking = match.aiPlan && match.aiPlan.weaponId === 'move';
        const kind = p.personality;
        ui.banner(
          () => t(walking ? 'onTheMove' : 'aiming', p.name),
          () => (kind ? t(`bot.${kind}`) : t('bot')),
          1000,
        );
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
      if (e.blocked && p && !p.isAI && isMine(p)) ui.banner(() => t('stopped'), () => t('stoppedSub'), 900);
      break;
    }
    case 'deathBlast': {
      // The wreck's own boom comes from the explosion event that follows;
      // this is only the headline. A nuke gets shouted.
      const p = match.player(e.id);
      if (p) {
        if (e.weaponId === 'nuke') ui.banner(() => t('reactor', p.name), () => t('nukeShout'), 1600);
        else ui.banner(() => t('cooksOff', p.name), () => t(`w.${e.weaponId}`), 1000);
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
      if (p) ui.banner(() => t('isWrecked', p.name), e.cause === 'fall' ? () => t('groundGave') : '', 1200);
      break;
    }
    case 'roundOver': {
      tappedReady = false;
      waitingNames = [];
      input.setEnabled(false);
      ui.lockControls(true);
      const winner = e.winnerId ? match.player(e.winnerId) : null;
      if (winner) {
        audio.play('fanfare', { gain: 0.8 });
        ui.banner(() => t('takesRound', winner.name), '', RESULTS_DELAY * 1000);
      } else {
        ui.banner(() => t('nobodyLeft'), () => t('paidAnyway'), RESULTS_DELAY * 1000);
      }
      resultsTimer = RESULTS_DELAY;
      break;
    }
    case 'awards': break; // shown with the scoreboard when resultsTimer runs out
    case 'shopOpen': {
      // A bot has already bought everything by the time this arrives; the
      // list is held for a beat so the humans can read what to fear.
      showShopFor(match.shopper());
      break;
    }
    case 'autopilot': {
      const p = match.player(e.playerId);
      if (p) ui.banner(() => t('droppedOut', p.name), () => t('botHasIt'), 1600);
      if (match.state === 'shop' && match.shopperId === e.playerId) showShopFor(p);
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
    case 'timerExpired': ui.banner(() => t('time'), () => t('timeSub'), 900); break;
    case 'matchOver': {
      audio.play('fanfare', { gain: 1 });
      ui.showMatchOver(match);
      break;
    }
    default: break;
  }
}

/** The parts counter for whoever is at it: theirs to use, a bot's, or a friend's to watch. */
function showShopFor(p) {
  if (!p) return;
  if (p.isAI) ui.showBotShopping(match, match.lastPurchases.slice());
  else ui.showShop(match, { watch: !isMine(p) });
}

function showScoreboard() {
  ui.showScoreboard(match);
  if (net) ui.setWaiting(waitingNames, tappedReady);
}

/**
 * Put every screen where the Match now is, after it jumped there without
 * this device seeing each step: a fast-forward, or a checkpoint from the
 * host. The renderer is told it is a new hill, which redraws the ground in
 * full and drops smoke that belonged to the old one.
 */
function resync() {
  renderer.onEvent({ type: 'roundStart' });
  resultsTimer = 0;
  switch (match.state) {
    case 'aim':
    case 'firing': {
      ui.showHud();
      const h = humanNow();
      input.setEnabled(!!h);
      ui.lockControls(!h || match.state === 'firing');
      break;
    }
    case 'scoreboard': showScoreboard(); break;
    case 'shop': showShopFor(match.shopper()); break;
    case 'matchOver': ui.showMatchOver(match); break;
    default:
  }
}

// ---------------------------------------------------------------------------
// Online: the hangar, and an online match's lifecycle
// ---------------------------------------------------------------------------

/** The network code, fetched the first time anybody asks for it. */
function loadNet() {
  if (!netModules) {
    netModules = Promise.all([
      import('./net/lobby.js'),
      import('./net/session.js'),
      import('./net/replica.js'),
      import('./net/codes.js'),
      import('./net/protocol.js'),
    ])
      .then(([lobbyMod, session, replica, codes, protocol]) => ({ ...lobbyMod, ...session, ...replica, ...codes, ...protocol }))
      .catch((error) => {
        netModules = null;
        throw error;
      });
  }
  return netModules;
}

async function openLobby() {
  let m;
  try {
    m = await loadNet();
  } catch {
    ui.banner(() => t('netWontLoad'), () => t('netWontLoadSub'), 2200);
    return;
  }
  if (!lobby) {
    lobby = m.createLobby({
      onHost: hostHangar,
      onJoin: joinHangarAs,
      onBack: () => ui.returnToSetup(),
      onLeave: () => {
        leaveHangar();
        lobby.open(() => t('youLeft'));
      },
    });
  }
  lobby.open();
  ui.showLobby();
}

async function hostHangar(name) {
  const m = await loadNet();
  const session = await m.openHangar();
  online = { kind: 'host', session, m };
  hostHealth = { reachable: true, note: '' };
  holdAwake(true);
  session.admit = (id, guestName) =>
    ui.addRemoteSeat(id, guestName) ? null : 'full';
  session.onGuests = (id, gone, guestName) => {
    if (gone) ui.removeRemoteSeat(id);
    if (!net) ui.banner(() => t(gone ? 'left' : 'aboard', guestName), gone ? () => t('seatIsBot') : '', 1300);
    hangarStatus();
    pushRoom();
  };
  session.onHealth = (h) => {
    hostHealth = h;
    hangarStatus();
  };
  ui.setHostName(name);
  hangarStatus();
  ui.returnToSetup();
}

/** The hangar strip on the setup screen: the code, and whether it works. */
function hangarStatus() {
  if (!online || online.kind !== 'host') return;
  const { session, m } = online;
  const n = session.guests.size;
  let status = n === 0 ? t('hangar.idle') : t('hangar.friends', n);
  let tone = n ? 'live' : '';
  if (session.mode === 'tabs') {
    const why = session.detailError && session.detailError.key ? errText(session.detailError) : session.detail;
    status = t('hangar.tabs', why);
    tone = 'warn';
  } else if (!hostHealth.reachable) {
    // The note is a key from rendezvous.js, said here in this device's words.
    status = hostHealth.note ? t(`err.${hostHealth.note}`, ...(hostHealth.args || [])) : t('hangar.reconnecting');
    tone = 'warn';
  }
  ui.setHangar({ words: m.codeWords(session.code), status, tone });
}

/** Tell the guests what the hangar looks like now. Between matches only. */
function pushRoom() {
  if (!online || online.kind !== 'host' || net) return;
  const { session } = online;
  session.sendRoom((id) => ({ code: session.code, ...ui.roomSummary(id) }));
}

function closeHangar() {
  if (!online || online.kind !== 'host') return;
  online.session.close();
  online = null;
  holdAwake(false);
  ui.setHangar(null);
}

async function joinHangarAs(code, name) {
  const m = await loadNet();
  const session = await m.joinHangar(code, name);
  online = { kind: 'guest', session, m };
  holdAwake(true);
  const showRoom = () => {
    lobby.showRoom({ code, ...(session.room || { seats: [], rules: '' }) });
    if (!net) ui.showLobby();
  };
  session.onRoom = () => { if (!net) showRoom(); };
  session.onStart = (msg) => startGuestMatch(msg);
  session.onEnd = (why) => {
    if (!net) return;
    endNetMatch();
    mode = 'setup';
    input.setEnabled(false);
    showRoom();
    if (why) lobby.say(() => whyText(why), 'warn');
  };
  session.onStream = (msg) => net?.replica.receive(msg);
  session.onClosed = (why) => {
    endNetMatch();
    online = null;
    holdAwake(false);
    mode = 'setup';
    input.setEnabled(false);
    lobby.open(() => whyText(why || 'gone'), 'warn');
    ui.showLobby();
  };
  showRoom();
}

/** A guest leaving the hangar altogether. */
function leaveHangar() {
  if (!online || online.kind !== 'guest') return;
  online.session.leave();
  online = null;
  endNetMatch();
  holdAwake(false);
}

/** The host deploys: seats get ids and owners, every device gets the same Match. */
function startHostMatch(specs, settings) {
  const { session, m } = online;
  const seeded = { ...settings, seed: randomSeed() };
  const owners = {};
  const seats = specs.map((spec, i) => {
    const { remote, ...rest } = spec;
    const id = `p${i}`;
    // A friend who left between the tap and now is a bot like any other.
    const gone = remote && !session.guests.has(remote);
    if (!rest.isAI && !gone) owners[id] = remote || m.HOST;
    return { ...rest, id, isAI: rest.isAI || !!gone };
  });
  const mine = new Set(Object.keys(owners).filter((id) => owners[id] === m.HOST));
  const replica = m.createReplica({
    me: m.HOST,
    send: (msg) => net?.link?.send(msg),
    onResync: resync,
    onWait: onWaiting,
  });
  lastPreset = settings.preset || 'default';
  lastRounds = settings.rounds;
  net = { role: 'host', replica, link: null, mine };
  beginMatch(new Match(seeded, seats));
  net.link = session.startMatch({
    settings: seeded,
    specs: seats,
    owners,
    toHost: (msg) => net?.replica.receive(msg),
    speed: botSpeed,
  });
}

function startGuestMatch(msg) {
  const { session, m } = online;
  if (!msg || !msg.settings || !Array.isArray(msg.specs) || !Array.isArray(msg.mine)) return;
  const replica = m.createReplica({
    me: session.id,
    send: (out) => session.send(out),
    onResync: resync,
    onWait: onWaiting,
  });
  net = { role: 'guest', replica, link: null, mine: new Set(msg.mine) };
  try {
    beginMatch(new Match(msg.settings, msg.specs));
  } catch (error) {
    console.warn('lobbots: could not build the host\'s match', error);
    leaveHangar();
    backToSetup();
  }
}

function onWaiting(names) {
  waitingNames = names;
  if (match && match.state === 'scoreboard' && !resultsTimer) ui.setWaiting(names, tappedReady);
}

function endNetMatch() {
  net = null;
  ui.setOnline(null);
  ui.setSkip(false);
}

/** "Again" on an online match over: the host's setup, or the guest's hangar. */
function finishOnline() {
  if (net.role === 'host') {
    online.session.endMatch('');
    endNetMatch();
    backToSetup();
    pushRoom();
    return;
  }
  endNetMatch();
  mode = 'setup';
  input.setEnabled(false);
  lobby.showRoom({ code: online.session.code, ...(online.session.room || { seats: [], rules: '' }) });
  ui.showLobby();
}

/*
 * Keep the screen on while in a hangar. A host whose phone sleeps drops off
 * the matchmaker and its code stops working (fishtank measured it), and a
 * guest whose phone sleeps drops the line. Refused or unsupported is fine:
 * this is a courtesy, not a requirement. The browser releases it whenever
 * the page is hidden, so it is asked for again on the way back.
 */
let wakeLock = null;
async function holdAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const held = wakeLock;
      wakeLock = null;
      await held.release();
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (online && !document.hidden) holdAwake(true);
});

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

/** No human walker is standing: everyone is out, or nobody was ever in. */
function onlyBotsLeft() {
  if (!match || !match.world || (match.state !== 'aim' && match.state !== 'firing')) return false;
  return !match.humans().length || humansOut();
}

/**
 * Skip to results: the sim plays the rest of the round out in one go
 * (match.skipRound), and only what the screen needs afterwards is passed on.
 * The terrain redraws for the craters it now has; the round's ending is
 * reacted to as usual, fanfare and results. Every blast, death and banner in
 * between is dropped: replaying a hundred explosions in one frame is noise,
 * not a summary.
 */
const SKIP_KEEP = new Set(['terrainChanged', 'roundOver', 'awards', 'matchOver']);
function skipRound() {
  if (paused || !onlyBotsLeft()) return;
  processEvents();
  const all = match.skipRound([]);
  for (const e of all) {
    if (!SKIP_KEEP.has(e.type)) continue;
    renderer.onEvent(e);
    react(e);
  }
  accumulator = 0;
  ui.setSkip(false);
}

/** A bot is the one playing: its turn, or a round no human is left in. */
function botsPlaying() {
  if (!match || (match.state !== 'aim' && match.state !== 'firing')) return false;
  const p = match.current();
  return (!!p && p.isAI) || humansOut();
}

/** Stored speed, 1..4 in half steps; anything else written there is ignored. */
function loadBotSpeed() {
  try {
    const v = Number(localStorage.getItem(BOT_SPEED_KEY));
    if (Number.isFinite(v) && v >= 1 && v <= 4) return Math.round(v * 2) / 2;
  } catch { /* fall through */ }
  return 1;
}

/** Say so once a round when the last human goes, so the wait is explained. */
function noticeOut() {
  const out = humansOut();
  if (out && !wereOut && outRound !== match.round) {
    outRound = match.round;
    // A guest's bot speed is the host's to set, so it is not offered.
    const speed = botSpeed;
    const sub = net && net.role === 'guest' ? () => t('botsSettle')
      : speed > 1 ? () => t('botsSettleAt', speed) : () => t('botSpeedWhere');
    const title = match.humans().length > 1 ? 'everyoneOut' : 'youOut';
    ui.banner(() => t(title), sub, 1600);
  }
  wereOut = out;
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

  if (match && mode === 'play' && !paused && net) {
    noticeOut();
    ui.setSkip(onlyBotsLeft());
    // The host's clock, not ours: step only as far as it has announced. A
    // fast-forward (a hidden tab coming back, a Skip) is redrawn from the
    // state it lands on rather than replayed event by event.
    if (net.replica.advance(dt, events)) {
      events.length = 0;
      resync();
    }
    processEvents();
    if (resultsTimer > 0) {
      resultsTimer -= dt;
      if (resultsTimer <= 0 && match.state === 'scoreboard') showScoreboard();
    }
    ui.updateHud(match);
  } else if (match && mode === 'play' && !paused) {
    noticeOut();
    ui.setSkip(onlyBotsLeft());
    const speed = botsPlaying() ? botSpeed : 1;
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
      if (resultsTimer <= 0 && match.state === 'scoreboard') showScoreboard();
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

/**
 * Keep the battlefield out from under the HUD (render.js setInsets). The top
 * inset is where the top strip's CONTENT ends, not its box, because the box
 * carries a fade that is meant to sit over sky; the bottom strip is opaque, so
 * its whole box counts. A ResizeObserver catches everything that changes
 * them — the HUD appearing, a rotation, a weapon strip growing — and a hidden
 * HUD (shop, scoreboard) measures as nothing, which is ignored so the field
 * does not jump while it is off screen.
 */
function syncInsets() {
  const top = document.getElementById('hud-top');
  const bottom = document.getElementById('hud-bottom');
  if (!top || !bottom) return;
  const field = canvas.getBoundingClientRect();
  const bRect = bottom.getBoundingClientRect();
  if (!bRect.height) return;
  let contentBottom = field.top;
  for (const child of top.children) {
    if (child.hidden) continue;
    const r = child.getBoundingClientRect();
    if (r.height) contentBottom = Math.max(contentBottom, r.bottom);
  }
  renderer.setInsets(contentBottom - field.top + 4, field.bottom - bRect.top);
}
if (typeof ResizeObserver === 'function') {
  const watch = new ResizeObserver(syncInsets);
  for (const id of ['hud-top', 'hud-bottom']) {
    const node = document.getElementById(id);
    if (node) watch.observe(node);
  }
}
window.addEventListener('resize', syncInsets);

// Sound may only start from a gesture. The first one anywhere unlocks it;
// the volume the player last chose is already in the audio module.
const unlock = () => {
  audio.unlock();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

ui.setVolume(audio.volume);
ui.setBotSpeed(botSpeed);

// The way back to the arcade. exit.js is a deferred classic script from
// another repo and may be absent (served alone) or late (slow network), so
// look for it now and again shortly after load; both outcomes are normal.
function wireExit() {
  const exit = window.ArcadeExit;
  if (!exit) return false;
  // Plain words, the same in every game (hub §2), in this device's language;
  // wired again on every language switch below.
  const verb = exit.verb({ arcade: t('exit.arcade'), app: t('exit.app') });
  ui.setExit(verb, () => {
    exit.quit().then((outcome) => {
      if (outcome === 'refused') ui.banner(() => t('wontClose'), () => t('wontCloseSub'), 2500);
    });
  });
  return true;
}

// A language switch (js/i18n.js). js/ui.js and js/net/lobby.js repaint
// themselves; the two things this file wrote are the exit's verb and the
// open hangar's status line.
document.addEventListener('arcade:lang', () => {
  wireExit();
  hangarStatus();
});
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
