/*
 * ui.js — every screen a player reads or taps: setup, HUD, scoreboard, the
 * parts counter, pause and the final standings.
 *
 * The contract is ARCHITECTURE.md §12. main.js hands this file callbacks and
 * calls the show and update methods on it; this file never touches the Match
 * except to READ it, and it decides nothing about the game. A tap is a callback
 * and the callback becomes a match.apply() somewhere else. That is what lets
 * the same screens sit in front of a remote host one day.
 *
 * Three habits run through the whole file.
 *
 * THE PANELS BELONG TO LOBBOTS. Graphite panels, cool accent lights, condensed
 * uppercase, and the battlefield showing through the glass — because a panel
 * that would look the same over a white page is not finished (hub §2). There
 * is no bare <select> anywhere; a choice is a row of real buttons carrying
 * aria-pressed, which is also the only way a screen reader learns which one
 * is on. Player colour arrives as data and is written onto elements as the
 * custom property --c, so nothing here hard-codes a team colour.
 *
 * UPDATE WHAT CHANGED. updateHud() runs on every animation frame. It keeps
 * the last value it wrote for each field and writes nothing when the number
 * has not moved: setting .textContent to the string it already holds still
 * costs a layout, sixty times a second, for no pixels.
 *
 * TWO LANGUAGES, SWITCHED LIVE. Every word here comes from t() (js/i18n.js),
 * and an `arcade:lang` repaints whatever is on screen where it stands: the
 * setup's pills and seat cards, the HUD on its next diff, the open results,
 * shop, standings or pause panel, and a banner still in the air. Nothing is
 * rebuilt by navigating — no screen changes, no pause is lifted. Names are
 * the exception: what a player typed is never translated, and a name the
 * game chose ("Du", a colour) follows the language only until somebody
 * changes it.
 *
 * ICONS ARE DRAWN, NOT TYPED. Weapon icons are painted procedurally onto a
 * canvas and cached as data URLs, and the currency mark is an inline SVG nut.
 * No web fonts (hub §1), and no emoji either: an emoji is a font somebody
 * else chose, which on one platform is a flat glyph and on another a colour
 * sticker two sizes too big.
 */

import {
  PALETTE,
  PRESETS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  resolveSettings,
} from './config.js';
import { PERSONALITIES, PERSONALITY_IDS } from './sim/ai.js';
import { holdRate, HOLD_DELAY } from './input.js';
import { t, num, shortNum, codeWord, getLang, setLang, variants } from './i18n.js';

/** Where the last setup is remembered. Hub §6: <slug>.<thing>.v<n>. */
const SETUP_KEY = 'lobbots.setup.v1';

/** Starting purses offered on the setup screen. Includes every preset's own. */
const MONEY_STEPS = [0, 500, 800, 1200, 4000, 10000];


// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/** Thousands separators in this language's style (js/i18n.js num). */
const comma = num;

/** A colour's name, in the current language. */
const colourName = (idx) => t(`color.${(PALETTE[idx] || PALETTE[0]).id}`);
/** A weapon's name and its line, in the current language. */
const wName = (id) => t(`w.${id}`);
const wDesc = (id) => t(`wd.${id}`);

/** Ammo reads as a number or as the shell's infinity. */
function ammoText(n) {
  return n === Infinity ? '∞' : String(n);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Write only if it differs: see the purpose block. */
function setText(node, value) {
  const s = String(value);
  if (node.textContent !== s) node.textContent = s;
}

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

/**
 * The currency mark: a hex nut with a hole through it, drawn as one path with
 * fill-rule evenodd so the hole is genuinely a hole and not a dot in the
 * panel's colour that stops working the moment it sits on something else.
 */
function boltMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'bolt');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill-rule', 'evenodd');
  p.setAttribute(
    'd',
    'M3.3 0.6h5.4l2.7 5.4-2.7 5.4H3.3L0.6 6Z M6 3.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z',
  );
  svg.appendChild(p);
  return svg;
}

/** A price or a purse: the nut, then the number, then the word. */
function boltAmount(n, word) {
  const wrap = el('span', 'bolts');
  wrap.appendChild(boltMark());
  wrap.appendChild(el('b', null, comma(n)));
  if (word) wrap.appendChild(el('i', null, word));
  return wrap;
}

// ---------------------------------------------------------------------------
// Procedural weapon icons
//
// One 40x40 painter per CATALOG `icon` key, in the palette's own colours on a
// transparent ground, cached as a data URL so the same shell can appear in the
// HUD strip and twice over in the shop without being drawn again. Bold shapes
// only: these are read at 34px on a phone, and anything finer than a 2px line
// turns to grey mush there.
// ---------------------------------------------------------------------------

const HAZ = '#a7d9e8';
const TXT = '#eef0f4';
const DIM = '#9aa3b2';
const RED = '#ff4b3e';
const iconCache = new Map();

function dot(ctx, x, y, r, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** The shell family: one silhouette, three weights, one band per weight. */
function shellShape(ctx, hw, bands) {
  const cx = 20;
  // `noseY`/`baseY` rather than top/bot: a bare `top` is window.top in the
  // wrong scope and this hub has already lost an afternoon to one (hub §5).
  const noseY = 8;
  const baseY = 31;
  ctx.beginPath();
  ctx.moveTo(cx - hw, baseY);
  ctx.lineTo(cx - hw, noseY + hw * 0.9);
  ctx.quadraticCurveTo(cx, noseY - hw * 0.5, cx + hw, noseY + hw * 0.9);
  ctx.lineTo(cx + hw, baseY);
  ctx.closePath();
  ctx.fillStyle = TXT;
  ctx.fill();
  ctx.fillStyle = HAZ;
  for (let i = 0; i < bands; i++) {
    ctx.fillRect(cx - hw, baseY - 5 - i * 5, hw * 2, 3);
  }
  // Fins, so the small one still reads as a shell and not as a pill.
  ctx.strokeStyle = DIM;
  ctx.beginPath();
  ctx.moveTo(cx - hw, baseY - 2);
  ctx.lineTo(cx - hw - 4, baseY + 3);
  ctx.moveTo(cx + hw, baseY - 2);
  ctx.lineTo(cx + hw + 4, baseY + 3);
  ctx.stroke();
}

function ground(ctx, y) {
  ctx.strokeStyle = DIM;
  ctx.beginPath();
  ctx.moveTo(3, y);
  ctx.lineTo(37, y);
  ctx.stroke();
}

const PAINT = {
  /**
   * Move: two footprints under a two-way arrow. Not a gun, and the icon
   * should say so at a glance — no shell silhouette anywhere near it.
   */
  move(ctx) {
    ground(ctx, 34);
    ctx.fillStyle = TXT;
    ctx.fillRect(6, 27, 11, 5);
    ctx.fillRect(23, 27, 11, 5);
    ctx.fillStyle = DIM;
    for (const x of [7, 11, 15, 24, 28, 32]) ctx.fillRect(x - 1, 32, 2, 2);
    ctx.strokeStyle = HAZ;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(8, 15);
    ctx.lineTo(32, 15);
    ctx.stroke();
    ctx.fillStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(3, 15); ctx.lineTo(11, 8); ctx.lineTo(11, 22); ctx.closePath();
    ctx.moveTo(37, 15); ctx.lineTo(29, 8); ctx.lineTo(29, 22); ctx.closePath();
    ctx.fill();
  },

  shell: (ctx) => shellShape(ctx, 5, 1),
  'shell-heavy': (ctx) => shellShape(ctx, 7, 2),
  'shell-mega': (ctx) => shellShape(ctx, 9, 3),

  /** One casing, six children on their way out. */
  cluster(ctx) {
    dot(ctx, 20, 27, 7, TXT);
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.55;
      dot(ctx, 20 + Math.cos(a) * 15, 27 + Math.sin(a) * 15, 3.2, HAZ);
    }
  },

  /** A stem that splits at the apex into three warheads. */
  mirv(ctx) {
    ctx.strokeStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(20, 36);
    ctx.lineTo(20, 22);
    ctx.moveTo(20, 22);
    ctx.lineTo(7, 10);
    ctx.moveTo(20, 22);
    ctx.lineTo(20, 7);
    ctx.moveTo(20, 22);
    ctx.lineTo(33, 10);
    ctx.stroke();
    dot(ctx, 7, 9, 3.4, TXT);
    dot(ctx, 20, 6, 3.4, TXT);
    dot(ctx, 33, 9, 3.4, TXT);
  },

  /** A ball on a slope, already moving. */
  roller(ctx) {
    ctx.strokeStyle = DIM;
    ctx.beginPath();
    ctx.moveTo(3, 20);
    ctx.lineTo(37, 34);
    ctx.stroke();
    dot(ctx, 26, 20, 7, TXT);
    ctx.strokeStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(6, 13);
    ctx.lineTo(14, 16);
    ctx.moveTo(8, 20);
    ctx.lineTo(15, 22);
    ctx.stroke();
  },

  /** Three hops drawn as the dotted arc they leave behind. */
  bouncer(ctx) {
    ground(ctx, 33);
    ctx.strokeStyle = HAZ;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(4, 33);
    ctx.quadraticCurveTo(10, 8, 17, 33);
    ctx.quadraticCurveTo(22, 15, 27, 33);
    ctx.quadraticCurveTo(30, 22, 34, 31);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(ctx, 34, 29, 4, TXT);
  },

  /** A hill where there was none, and the clods still landing. */
  dirt(ctx) {
    ctx.fillStyle = DIM;
    ctx.beginPath();
    ctx.moveTo(3, 34);
    ctx.quadraticCurveTo(20, 12, 37, 34);
    ctx.closePath();
    ctx.fill();
    dot(ctx, 12, 12, 2.6, HAZ);
    dot(ctx, 21, 6, 3, HAZ);
    dot(ctx, 30, 13, 2.6, HAZ);
  },

  /** A bowl scooped out, with the spoil piled either side. */
  earthmover(ctx) {
    ctx.fillStyle = DIM;
    ctx.beginPath();
    ctx.moveTo(2, 34);
    ctx.lineTo(2, 22);
    ctx.quadraticCurveTo(8, 14, 12, 24);
    ctx.quadraticCurveTo(20, 38, 28, 24);
    ctx.quadraticCurveTo(32, 14, 38, 22);
    ctx.lineTo(38, 34);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(13, 12);
    ctx.lineTo(20, 20);
    ctx.lineTo(27, 12);
    ctx.stroke();
  },

  /** Into the hill, and onwards. */
  burrower(ctx) {
    ctx.fillStyle = 'rgba(154,163,178,0.4)';
    ctx.fillRect(2, 22, 36, 14);
    ctx.strokeStyle = DIM;
    ctx.beginPath();
    ctx.moveTo(2, 22);
    ctx.lineTo(38, 22);
    ctx.stroke();
    ctx.strokeStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(9, 5);
    ctx.lineTo(26, 30);
    ctx.stroke();
    ctx.fillStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(28, 34);
    ctx.lineTo(19, 28);
    ctx.lineTo(27, 24);
    ctx.closePath();
    ctx.fill();
  },

  /** A tongue of flame with a hot core. */
  napalm(ctx) {
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.moveTo(20, 36);
    ctx.bezierCurveTo(6, 30, 10, 16, 18, 4);
    ctx.bezierCurveTo(20, 14, 34, 16, 20, 36);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = HAZ;
    ctx.beginPath();
    ctx.moveTo(20, 33);
    ctx.bezierCurveTo(14, 28, 16, 22, 20, 15);
    ctx.bezierCurveTo(22, 22, 26, 26, 20, 33);
    ctx.closePath();
    ctx.fill();
  },

  /** The mountain, and what it just sent up. */
  volcano(ctx) {
    ctx.fillStyle = DIM;
    ctx.beginPath();
    ctx.moveTo(4, 35);
    ctx.lineTo(15, 17);
    ctx.lineTo(25, 17);
    ctx.lineTo(36, 35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = RED;
    ctx.fillRect(15, 15, 10, 4);
    dot(ctx, 20, 6, 3.2, HAZ);
    dot(ctx, 11, 11, 2.6, HAZ);
    dot(ctx, 29, 11, 2.6, HAZ);
  },

  /** No pattern on purpose: a burst, a wobble and two sparks. */
  funky(ctx) {
    ctx.strokeStyle = HAZ;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.moveTo(20 + Math.cos(a) * 5, 21 + Math.sin(a) * 5);
      ctx.lineTo(20 + Math.cos(a) * 14, 21 + Math.sin(a) * 14);
      ctx.stroke();
    }
    dot(ctx, 20, 21, 6, TXT);
    dot(ctx, 33, 8, 2.4, RED);
    dot(ctx, 7, 32, 2.4, RED);
  },

  /** The trefoil. Unmistakable at any size, which is the point. */
  nuke(ctx) {
    ctx.fillStyle = HAZ;
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(20, 20);
      ctx.arc(20, 20, 16, a - 0.52, a + 0.52);
      ctx.closePath();
      ctx.fill();
    }
    dot(ctx, 20, 20, 5.5, TXT);
  },
};

/** data: URL for one icon key, painted once and kept. */
function iconUrl(key) {
  if (iconCache.has(key)) return iconCache.get(key);
  const px = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(40 * px);
  c.height = Math.round(40 * px);
  const ctx = c.getContext('2d');
  ctx.scale(px, px);
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  (PAINT[key] || PAINT.shell)(ctx);
  let url = '';
  try {
    url = c.toDataURL('image/png');
  } catch {
    // A tainted or disabled canvas: the name beside the icon still carries
    // the meaning, so an empty src is a blank box and never a broken screen.
  }
  iconCache.set(key, url);
  return url;
}

function iconImg(key) {
  const img = el('img', 'wicon');
  img.src = iconUrl(key);
  img.width = 40;
  img.height = 40;
  img.alt = '';
  img.decoding = 'async';
  return img;
}

// ---------------------------------------------------------------------------
// Hold-to-repeat for the HUD's − / + pills
//
// The curve comes from input.js so the pills and the arrow keys accelerate
// identically. A press is one step; keep holding and it winds up. The click
// handler is what makes the pill work from the keyboard, and it ignores the
// click a pointer press synthesises so a tap is never two steps.
// ---------------------------------------------------------------------------

function attachHold(btn, emit) {
  let pid = null;
  let t0 = 0;
  let last = 0;
  let acc = 0;
  let raf = 0;
  let lastPointerAt = -1;

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = now();
    const dt = Math.min(0.1, t - last);
    last = t;
    const heldFor = t - t0;
    if (heldFor < HOLD_DELAY) return;
    acc += holdRate(heldFor) * dt;
    const steps = Math.floor(acc);
    if (steps > 0) {
      acc -= steps;
      emit(steps);
    }
  }

  function stop() {
    if (pid === null) return;
    try {
      btn.releasePointerCapture(pid);
    } catch {
      // Already released with the pointer itself; nothing to undo.
    }
    pid = null;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  btn.addEventListener('pointerdown', (e) => {
    if (btn.disabled || pid !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    pid = e.pointerId;
    lastPointerAt = now();
    try {
      btn.setPointerCapture(pid);
    } catch {
      // Capture is a convenience; the window-level pointerup below still ends it.
    }
    t0 = now();
    last = t0;
    acc = 0;
    emit(1);
    raf = requestAnimationFrame(frame);
  });
  // On the window rather than the button: a finger that slides off mid-hold
  // must still stop the repeat, capture or no capture.
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);

  btn.addEventListener('click', (e) => {
    // Never let Enter or Space on a HUD button reach the game as a shot.
    e.stopPropagation();
    // The click a pointer press synthesises is the same step we already sent.
    if (now() - lastPointerAt < 0.7) return;
    if (!btn.disabled) emit(1);
  });
}

// ---------------------------------------------------------------------------
// createUI
// ---------------------------------------------------------------------------

export function createUI(callbacks = {}) {
  if (callbacks.paintPortrait) callbacks.paintPortrait($('hero-mech'), '#a7d9e8', true);
  const cb = {
    onStart() {},
    onAngle() {},
    onPower() {},
    onWeapon() {},
    onFire() {},
    onBuy() {},
    onReady() {},
    onPause() {},
    onResume() {},
    onQuit() {},
    onVolume() {},
    onBotSpeed() {},
    onSkip() {},
    onOnline() {},
    onCloseHangar() {},
    onSeatsChanged() {},
    ...callbacks,
  };

  // ---- the furniture ------------------------------------------------------
  const screens = {
    setup: $('setup'),
    hud: $('hud'),
    scoreboard: $('scoreboard'),
    shop: $('shop'),
    matchover: $('matchover'),
    lobby: $('lobby'),
  };
  const pausePanel = $('pause');
  const pauseBtn = $('pause-btn');
  const callout = $('callout');
  const calloutTitle = $('callout-title');
  const calloutSub = $('callout-sub');

  // Setup
  const presetSeg = screens.setup.querySelector('[data-seg="preset"]');
  const presetBlurb = $('preset-blurb');
  const roundsSeg = screens.setup.querySelector('[data-seg="rounds"]');
  const roundsCustom = $('rounds-custom');
  const moneySeg = screens.setup.querySelector('[data-seg="money"]');
  const roundsInput = $('rounds-input');
  const seatsBox = $('seats');
  const seatCount = $('seat-count');
  const seatLess = $('seat-less');
  const seatMore = $('seat-more');
  const deployBtn = $('deploy');
  const onlineBtn = $('online-btn');
  const hangarBox = $('hangar');
  const hangarCode = $('hangar-code');
  const hangarStatus = $('hangar-status');

  // HUD
  const hudTop = $('hud-top');
  const hudBottom = $('hud-bottom');
  const turnSwatch = $('turn-swatch');
  const turnName = $('turn-name');
  const turnThink = $('turn-think');
  const hpBar = $('hp-bar');
  const hpFill = $('hp-fill');
  const hpShield = $('hp-shield');
  const hpText = $('hp-text');
  const hpWrap = $('hp');
  const roundText = $('round-text');
  const windEl = $('wind');
  const windNum = $('wind-num');
  const windBar = $('wind-bar');
  const windHead = $('wind-head');
  const shotTimer = $('shot-timer');
  const skipBtn = $('skip-btn');
  skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onSkip();
  });

  const angleVal = $('angle-val');
  const angleUnit = $('angle-unit');
  const angleLabel = $('angle-label');
  const powerVal = $('power-val');
  const weaponsBox = $('weapons');
  const fireBtn = $('fire-btn');
  const powerDial = $('power-val').closest('.dial');

  // Scoreboard / shop / match over / pause
  const sbTitle = $('sb-title');
  const sbRows = $('sb-rows');
  const sbContinue = $('sb-continue');
  const shopSwatch = $('shop-swatch');
  const shopName = $('shop-name');
  const shopStatus = $('shop-status');
  const shopMoney = $('shop-money');
  const shopRowsBox = $('shop-rows');
  const shopBotLine = $('shop-bot');
  const shopDone = $('shop-done');
  const moTitle = $('mo-title');
  const moChamp = $('mo-champ');
  const moRows = $('mo-rows');
  const moAgain = $('mo-again');
  const resumeBtn = $('resume-btn');
  const quitBtn = $('quit-btn');
  const volume = $('volume');
  const volumeOut = $('volume-out');
  const botSpeed = $('bot-speed');
  const botSpeedOut = $('bot-speed-out');
  const botSpeedRow = $('bot-speed-row');
  const sbWait = $('sb-wait');
  const pauseKicker = $('pause-kicker');
  const pauseTitle = $('pause-title');
  const pauseNote = $('pause-note');

  // =========================================================================
  // Setup screen
  // =========================================================================

  /**
   * Everything the setup screen is currently saying, in one object. `seats`
   * is the roster; the two `touched` flags remember whether the player has
   * overruled the preset, because a preset that quietly undoes a choice
   * somebody just made is worse than one that never helps at all.
   */
  const setup = {
    preset: 'default',
    rounds: 5,
    custom: false,
    money: resolveSettings('default').startMoney,
    moneyTouched: false,
    roundsTouched: false,
    seatsTouched: false,
    seats: [],
  };

  /** A palette index nobody else at the table is wearing. */
  function freeColor(from, exceptSeat) {
    const taken = new Set(
      setup.seats.filter((_, i) => i !== exceptSeat).map((s) => s.colorIndex),
    );
    for (let k = 1; k <= PALETTE.length; k++) {
      const idx = (from + k) % PALETTE.length;
      if (!taken.has(idx)) return idx;
    }
    return from;
  }

  /** Is this seat's name one the game chose, in either language? */
  function isGameName(seat) {
    const id = (PALETTE[seat.colorIndex] || PALETTE[0]).id;
    return [...variants('you'), ...variants(`color.${id}`)].includes(seat.name);
  }

  /** A language switch: every name the game chose, said in the new language. */
  function localiseNames() {
    for (const seat of setup.seats) {
      if (seat.remote || !seat.autoName) continue;
      if (variants('you').includes(seat.name)) seat.name = t('you');
      else if (isGameName(seat)) seat.name = colourName(seat.colorIndex);
    }
  }

  function makeSeat(i) {
    const colorIndex = freeColor(i - 1 < 0 ? PALETTE.length - 1 : i - 1, -1);
    const isAI = i > 0;
    return {
      colorIndex,
      isAI,
      // Personalities are dealt round the table so a default match is seven
      // different opponents rather than four copies of the Rookie.
      personality: PERSONALITY_IDS[(i - 1 + PERSONALITY_IDS.length) % PERSONALITY_IDS.length],
      name: isAI ? colourName(colorIndex) : t('you'),
      // True while the name is still whatever we chose, so recolouring can
      // rename with it and stop the moment the player types something.
      autoName: true,
    };
  }

  function defaultSeats(presetId) {
    const want = Math.max(
      MIN_PLAYERS,
      Math.min(MAX_PLAYERS, (PRESETS[presetId] || PRESETS.default).players || 4),
    );
    setup.seats = [];
    for (let i = 0; i < want; i++) setup.seats.push(makeSeat(i));
  }

  function loadSetup() {
    try {
      const raw = localStorage.getItem(SETUP_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.seats) || data.seats.length < MIN_PLAYERS) return null;
      return data;
    } catch {
      // Private mode, a full quota, or a shape from an older build. Either
      // way the defaults below are a perfectly good match.
      return null;
    }
  }

  function saveSetup() {
    try {
      localStorage.setItem(
        SETUP_KEY,
        JSON.stringify({
          v: 1,
          preset: setup.preset,
          rounds: setup.rounds,
          custom: setup.custom,
          money: setup.money,
          moneyTouched: setup.moneyTouched,
          // A friend's seat is theirs for this visit only: remember the bot
          // it stood in for, or nothing at all.
          seats: setup.seats
            .map((s) => (s.remote ? s.prior : s))
            .filter(Boolean)
            .map((s) => ({
              name: s.name,
              colorIndex: s.colorIndex,
              isAI: s.isAI,
              personality: s.personality,
            })),
        }),
      );
    } catch {
      // Not being able to remember the last roster is not a reason to stop
      // anyone playing.
    }
  }

  function adoptSpecs(specs, presetId, rounds) {
    setup.seats = specs.slice(0, MAX_PLAYERS).map((s, i) => ({
      colorIndex: Number.isInteger(s.colorIndex) ? s.colorIndex % PALETTE.length : i % PALETTE.length,
      isAI: !!s.isAI,
      personality: PERSONALITIES[s.personality] ? s.personality : PERSONALITY_IDS[i % PERSONALITY_IDS.length],
      name: String(s.name || '').slice(0, 14),
      autoName: false,
    }));
    // A remembered "You" or colour is still the game's choice, not a name
    // somebody typed: let it follow the language (localiseNames below).
    for (const seat of setup.seats) seat.autoName = isGameName(seat);
    while (setup.seats.length < MIN_PLAYERS) setup.seats.push(makeSeat(setup.seats.length));
    if (PRESETS[presetId]) setup.preset = presetId;
    const r = Number(rounds);
    if (Number.isFinite(r) && r >= 1) {
      setup.rounds = Math.min(50, Math.round(r));
      setup.custom = ![1, 3, 5, 10].includes(setup.rounds);
    }
    // A roster that came back from somewhere is a roster somebody chose.
    setup.roundsTouched = true;
    setup.seatsTouched = true;
  }

  // ---- segmented rows -----------------------------------------------------

  /**
   * Build a row of pills where exactly one is pressed. Real buttons carrying
   * aria-pressed, never a <select> (hub §2); the CSS gives them one size from
   * a zero flex basis so a group of equals looks equal.
   */
  function buildSeg(box, options, pick) {
    box.textContent = '';
    for (const o of options) {
      const b = el('button', null, o.label);
      b.type = 'button';
      b.dataset.v = String(o.v);
      b.setAttribute('aria-pressed', 'false');
      if (o.title) b.title = o.title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pick(o.v, b);
      });
      box.appendChild(b);
    }
  }

  function markSeg(box, value) {
    for (const b of box.children) {
      b.setAttribute('aria-pressed', b.dataset.v === String(value) ? 'true' : 'false');
    }
  }

  /** The setup's three pill rows, built again on a language switch. */
  function buildSetupSegs() {
    buildSeg(
      presetSeg,
      Object.keys(PRESETS).map((id) => ({ v: id, label: t(`preset.${id}`), title: t(`presetd.${id}`) })),
      (id) => {
        setup.preset = id;
        // The preset's rounds and seat count are a suggestion, and only for
        // somebody who has not already said otherwise.
        if (!setup.roundsTouched) {
          setup.rounds = resolveSettings(id).rounds;
          setup.custom = false;
        }
        if (!setup.moneyTouched) setup.money = resolveSettings(id).startMoney;
        if (!setup.seatsTouched) {
          defaultSeats(id);
          renderSeats();
        }
        renderPreset();
        renderRounds();
        renderMoney();
      },
    );

    // Every preset's own purse is one of these, so a preset always has a pill
    // to light up; 0 and 10k are the two ends worth playing with.
    buildSeg(
      moneySeg,
      MONEY_STEPS.map((v) => ({ v, label: shortNum(v), title: t('moneyEach', comma(v)) })),
      (v) => {
        setup.money = v;
        setup.moneyTouched = true;
        renderMoney();
      },
    );

    buildSeg(
      roundsSeg,
      [
        { v: 1, label: '1' },
        { v: 3, label: '3' },
        { v: 5, label: '5' },
        { v: 10, label: '10' },
        { v: 'custom', label: t('roundsOther') },
      ],
      (v) => {
        setup.roundsTouched = true;
        if (v === 'custom') {
          setup.custom = true;
          renderRounds();
          roundsInput.focus();
          return;
        }
        setup.custom = false;
        setup.rounds = v;
        renderRounds();
      },
    );
  }
  buildSetupSegs();

  roundsInput.addEventListener('input', () => {
    const n = Math.max(1, Math.min(50, Math.round(Number(roundsInput.value) || 1)));
    setup.rounds = n;
    setup.roundsTouched = true;
  });
  roundsInput.addEventListener('blur', () => {
    roundsInput.value = String(setup.rounds);
  });

  function renderPreset() {
    markSeg(presetSeg, setup.preset);
    setText(presetBlurb, t(`presetd.${PRESETS[setup.preset] ? setup.preset : 'default'}`));
  }

  function renderMoney() {
    markSeg(moneySeg, setup.money);
  }

  function renderRounds() {
    markSeg(roundsSeg, setup.custom ? 'custom' : setup.rounds);
    roundsCustom.hidden = !setup.custom;
    if (roundsInput.value !== String(setup.rounds)) roundsInput.value = String(setup.rounds);
  }

  // ---- the roster ---------------------------------------------------------

  /**
   * One card per seat: colour, name, whether a person or a bot is driving,
   * and for a bot which of the seven it is. Rebuilt whole only when a seat is
   * added or removed — a rebuild while somebody is typing their name would
   * take the caret with it.
   */
  function renderSeats() {
    seatsBox.textContent = '';
    setup.seats.forEach((seat, i) => seatsBox.appendChild(seatCard(seat, i)));
    setText(seatCount, setup.seats.length);
    seatLess.disabled = setup.seats.length <= MIN_PLAYERS || lastLocalSeat() < 0;
    seatMore.disabled = setup.seats.length >= MAX_PLAYERS;
  }

  /** The seat "one fewer" removes: the last one that is not a friend's. */
  function lastLocalSeat() {
    for (let i = setup.seats.length - 1; i >= 0; i--) if (!setup.seats[i].remote) return i;
    return -1;
  }

  function seatCard(seat, i) {
    const color = PALETTE[seat.colorIndex] || PALETTE[0];
    const card = el('div', 'seat');
    card.style.setProperty('--c', color.hex);

    const head = el('div', 'seat-head');

    const sw = el('button', 'swatch-btn');
    sw.type = 'button';
    sw.title = t('colourTitle', colourName(seat.colorIndex));
    sw.setAttribute('aria-label', t('colourLabel', colourName(seat.colorIndex)));
    const portrait = el('canvas', 'mech-portrait');
    portrait.setAttribute('aria-hidden', 'true');
    sw.appendChild(portrait);
    if (callbacks.paintPortrait) callbacks.paintPortrait(portrait, color.hex);
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasAuto = seat.autoName;
      seat.colorIndex = freeColor(seat.colorIndex, i);
      const c = PALETTE[seat.colorIndex];
      card.style.setProperty('--c', c.hex);
      if (callbacks.paintPortrait) callbacks.paintPortrait(portrait, c.hex);
      const cName = colourName(seat.colorIndex);
      sw.title = t('colourTitle', cName);
      sw.setAttribute('aria-label', t('colourLabel', cName));
      // A name nobody has typed follows its colour around.
      if (wasAuto && !seat.remote) {
        seat.name = seat.isAI || i > 0 ? cName : t('you');
        nameField.value = seat.name;
      }
    });
    head.appendChild(sw);

    const nameField = el('input', 'field seat-name');
    nameField.type = 'text';
    nameField.value = seat.name;
    // A friend's name is theirs to choose, on their own screen.
    if (seat.remote) {
      nameField.readOnly = true;
      nameField.setAttribute('aria-readonly', 'true');
      card.classList.add('online');
    }
    nameField.maxLength = 14;
    nameField.autocomplete = 'off';
    nameField.spellcheck = false;
    nameField.setAttribute('aria-label', t('seatName', i + 1));
    nameField.addEventListener('input', () => {
      seat.name = nameField.value;
      seat.autoName = false;
    });
    head.appendChild(nameField);

    if (seat.remote) {
      // Who drives it is not a choice: the friend does, from their device.
      head.appendChild(el('span', 'tag online-tag', t('online')));
      card.appendChild(head);
      return card;
    }

    const kind = el('div', 'seg seg-kind');
    kind.setAttribute('role', 'group');
    kind.setAttribute('aria-label', t('seatWho', i + 1));
    for (const opt of [
      { v: 'human', label: t('you') },
      { v: 'bot', label: t('robot') },
    ]) {
      const b = el('button', null, opt.label);
      b.type = 'button';
      b.dataset.v = opt.v;
      b.setAttribute('aria-pressed', String(seat.isAI === (opt.v === 'bot')));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        seat.isAI = opt.v === 'bot';
        for (const other of kind.children) {
          other.setAttribute('aria-pressed', String(seat.isAI === (other.dataset.v === 'bot')));
        }
        persBox.hidden = !seat.isAI;
        persBlurb.hidden = !seat.isAI;
        if (seat.autoName) {
          seat.name = seat.isAI ? colourName(seat.colorIndex) : t('you');
          nameField.value = seat.name;
        }
      });
      kind.appendChild(b);
    }
    head.appendChild(kind);
    card.appendChild(head);

    // The seven. A grid rather than a flex row so every pill is exactly the
    // same size however the row wraps on a narrow phone.
    const persBox = el('div', 'seg seg-grid seg-pers');
    persBox.setAttribute('role', 'group');
    persBox.setAttribute('aria-label', t('seatStyle', i + 1));
    const persBlurb = el('p', 'pers-blurb');
    for (const id of PERSONALITY_IDS) {
      const b = el('button', null, t(`bot.${id}`));
      b.type = 'button';
      b.dataset.v = id;
      b.title = t(`botd.${id}`);
      b.setAttribute('aria-pressed', String(seat.personality === id));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        seat.personality = id;
        for (const other of persBox.children) {
          other.setAttribute('aria-pressed', String(other.dataset.v === id));
        }
        setText(persBlurb, t(`botd.${id}`));
      });
      persBox.appendChild(b);
    }
    setText(persBlurb, t(`botd.${PERSONALITIES[seat.personality] ? seat.personality : 'rookie'}`));
    persBox.hidden = !seat.isAI;
    persBlurb.hidden = !seat.isAI;
    card.appendChild(persBox);
    card.appendChild(persBlurb);

    return card;
  }

  seatLess.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = lastLocalSeat();
    if (setup.seats.length <= MIN_PLAYERS || i < 0) return;
    setup.seats.splice(i, 1);
    setup.seatsTouched = true;
    renderSeats();
  });
  seatMore.addEventListener('click', (e) => {
    e.stopPropagation();
    if (setup.seats.length >= MAX_PLAYERS) return;
    setup.seats.push(makeSeat(setup.seats.length));
    setup.seatsTouched = true;
    renderSeats();
  });

  deployBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveSetup();
    const specs = setup.seats.map((s, i) => ({
      name: (s.name || '').trim() || colourName(s.colorIndex),
      colorIndex: s.colorIndex,
      isAI: s.isAI,
      personality: s.personality,
      // The device that drives this seat, for an online match; null is here.
      remote: s.remote || null,
      // Teams are designed for and not built (ARCHITECTURE §1); every seat is
      // its own side until they are.
      team: null,
    }));
    const settings = resolveSettings(setup.preset, { rounds: setup.rounds, startMoney: setup.money });
    cb.onStart(specs, settings);
  });

  onlineBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onOnline();
  });
  $('hangar-close').addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onCloseHangar();
  });

  /*
   * While a hangar is open, guests see the host's setup as it changes. One
   * watcher rather than a call in every handler: it listens in the capture
   * phase, because the handlers stop propagation, and reports after they
   * have run.
   */
  let changeQueued = false;
  const seatsChanged = () => {
    if (changeQueued) return;
    changeQueued = true;
    setTimeout(() => {
      changeQueued = false;
      cb.onSeatsChanged();
    }, 0);
  };
  screens.setup.addEventListener('click', seatsChanged, true);
  screens.setup.addEventListener('input', seatsChanged, true);

  // ---- friends' seats (online) --------------------------------------------

  /**
   * A friend joined: they take the last bot's seat, so a crew of four stays a
   * crew of four, or a new seat when there is no bot to stand in for. The bot
   * is remembered and comes back if they leave. False when the table is full.
   */
  function addRemoteSeat(id, name) {
    let i = -1;
    for (let k = setup.seats.length - 1; k >= 0; k--) {
      if (setup.seats[k].isAI && !setup.seats[k].remote) { i = k; break; }
    }
    if (i < 0) {
      if (setup.seats.length >= MAX_PLAYERS) return false;
      setup.seats.push(makeSeat(setup.seats.length));
      i = setup.seats.length - 1;
      setup.seats[i].prior = null;
    } else {
      setup.seats[i] = { ...setup.seats[i], prior: { ...setup.seats[i] } };
    }
    Object.assign(setup.seats[i], { remote: id, isAI: false, name, autoName: false });
    setup.seatsTouched = true;
    renderSeats();
    return true;
  }

  function removeRemoteSeat(id) {
    const i = setup.seats.findIndex((s) => s.remote === id);
    if (i < 0) return;
    const prior = setup.seats[i].prior;
    if (prior) setup.seats[i] = prior;
    else setup.seats.splice(i, 1);
    while (setup.seats.length < MIN_PLAYERS) setup.seats.push(makeSeat(setup.seats.length));
    renderSeats();
  }

  /**
   * What a guest's lobby shows: the crew and the rules, from `forId`'s seat.
   * Numbers and keys, never a sentence — the guest's lobby says it in the
   * guest's own language (js/net/lobby.js). The host's name is a name, or
   * null for the guest to call "the host" in its own words.
   */
  function roomSummary(forId) {
    const host = setup.seats.find((s) => !s.isAI && !s.remote);
    return {
      host: host ? (host.name || '').trim() || null : null,
      rules: { preset: setup.preset, rounds: setup.rounds, money: setup.money },
      seats: setup.seats.map((s) => ({
        name: (s.name || '').trim() || colourName(s.colorIndex),
        colorIndex: s.colorIndex,
        kind: s.remote ? 'online' : s.isAI ? 'bot' : 'host',
        you: !!forId && s.remote === forId,
      })),
    };
  }

  // =========================================================================
  // HUD
  // =========================================================================

  // The last value written for each field. updateHud compares against this
  // and touches the DOM only where it differs.
  const seen = {
    pid: null,
    state: null,
    think: null,
    hp: -1,
    maxhp: -1,
    shield: -1,
    angle: -1,
    power: -1,
    weapon: null,
    wind: NaN,
    round: -1,
    rounds: -1,
    timer: -1,
    locked: null,
    moving: null,
    walk: NaN,
  };
  /** Move is selected: the angle dial reads the walk, power is idle. */
  let moveMode = false;

  let weaponButtons = [];
  let controlsLocked = false;
  let rebuildStrip = true;
  /**
   * Which Match the numbers above were read from. Player ids are per seat —
   * the first player of every match is `p0` — so without this a second match
   * whose seat one happens to be another p0 would keep the first match's name
   * and colour in the chip, because nothing the diff looks at changed.
   */
  let seenMatch = null;

  function resetSeen() {
    seen.pid = null;
    seen.state = null;
    seen.think = null;
    seen.hp = -1;
    seen.maxhp = -1;
    seen.shield = -1;
    seen.angle = -1;
    seen.power = -1;
    seen.weapon = null;
    seen.wind = NaN;
    seen.round = -1;
    seen.rounds = -1;
    seen.timer = -1;
    seen.moving = null;
    seen.walk = NaN;
    rebuildStrip = true;
  }

  for (const pill of hudBottom.querySelectorAll('.pill.step')) {
    const axis = pill.dataset.axis;
    const dir = Number(pill.dataset.dir);
    attachHold(pill, (steps) => {
      if (controlsLocked) return;
      const d = dir * steps;
      if (axis === 'angle') cb.onAngle(d);
      else cb.onPower(d);
    });
  }

  fireBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (controlsLocked) return;
    cb.onFire();
  });

  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onPause();
  });

  /** One button per weapon the current player can actually fire. */
  function buildWeapons(match, player) {
    weaponsBox.textContent = '';
    weaponButtons = [];
    for (const w of match.arsenal(player)) {
      const b = el('button', 'weapon');
      b.type = 'button';
      b.dataset.wid = w.id;
      b.title = `${wName(w.id)} — ${wDesc(w.id)}`;
      b.setAttribute('aria-pressed', String(player.weaponId === w.id));
      b.appendChild(iconImg(w.icon));
      b.appendChild(el('span', 'w-name', wName(w.id)));
      const count = el('span', 'w-ammo', ammoText(match.ammo(player, w.id)));
      b.appendChild(count);
      b.disabled = controlsLocked;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (controlsLocked) return;
        cb.onWeapon(w.id);
      });
      weaponsBox.appendChild(b);
      weaponButtons.push({ id: w.id, btn: b, count });
    }
  }

  function markWeapon(id) {
    for (const w of weaponButtons) {
      w.btn.setAttribute('aria-pressed', String(w.id === id));
    }
  }

  function updateHud(match) {
    if (match !== seenMatch) {
      seenMatch = match;
      resetSeen();
    }
    const p = match.current();
    const world = match.world;
    if (!p || !world) return;
    const m = world.mechFor(p.id);

    // ---- whose turn ------------------------------------------------------
    if (p.id !== seen.pid) {
      seen.pid = p.id;
      seen.weapon = null;
      // A turn can pass without the state ever leaving 'aim' — the ground
      // crumbles out from under whoever was up — so the strip is marked stale
      // here as well as on a state change.
      rebuildStrip = true;
      turnSwatch.style.background = p.color.hex;
      hudTop.style.setProperty('--c', p.color.hex);
      hudBottom.style.setProperty('--c', p.color.hex);
      setText(turnName, p.name);
    }

    // The arsenal only changes across a state boundary — a shot spends ammo
    // on the way into `firing`, the parts counter adds it on the way out of
    // `shop` — or when the turn passes, so the strip is rebuilt on those two
    // events and never diffed per frame. (Diffing would mean building a key
    // string out of the inventory sixty times a second to learn nothing.)
    if (match.state !== seen.state || rebuildStrip || weaponButtons.length === 0) {
      seen.state = match.state;
      rebuildStrip = false;
      buildWeapons(match, p);
      seen.weapon = null;
    }

    const thinking = !!p.isAI && match.state === 'aim';
    if (thinking !== seen.think) {
      seen.think = thinking;
      turnThink.hidden = !thinking;
    }

    // ---- hull ------------------------------------------------------------
    const hp = m ? Math.max(0, Math.round(m.health)) : 0;
    const maxhp = m ? m.maxHealth : 100;
    const shield = m ? Math.max(0, Math.round(m.shield)) : 0;
    if (hp !== seen.hp || maxhp !== seen.maxhp) {
      seen.hp = hp;
      seen.maxhp = maxhp;
      const frac = maxhp > 0 ? hp / maxhp : 0;
      hpFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      hpBar.classList.toggle('low', frac <= 0.25);
      hpBar.classList.toggle('mid', frac > 0.25 && frac <= 0.55);
      setText(hpText, hp);
      hpWrap.setAttribute('aria-label', t('hull', hp, maxhp));
    }
    if (shield !== seen.shield) {
      seen.shield = shield;
      hpShield.hidden = shield <= 0;
      if (shield > 0) {
        hpShield.style.width = `${Math.min(1, shield / Math.max(1, maxhp)) * 100}%`;
      }
    }

    // ---- round -----------------------------------------------------------
    if (match.round !== seen.round || match.settings.rounds !== seen.rounds) {
      seen.round = match.round;
      seen.rounds = match.settings.rounds;
      setText(roundText, t('roundOf', match.round, match.settings.rounds));
    }

    // ---- aim -------------------------------------------------------------
    // The AI's angle and power are floats mid-swing; the player reads whole
    // numbers, so round for display and never for the sim.
    // With Move in hand the same ◂ ▸ dial walks the marker instead of
    // swinging the barrel (main.js does the translating), so the dial says
    // how far and which way, power goes quiet, and FIRE becomes WALK. One
    // set of controls, two meanings, and the labels never lie about which.
    const moving = p.weaponId === 'move';
    if (moving !== seen.moving) {
      seen.moving = moving;
      moveMode = moving;
      seen.angle = -1;
      seen.walk = NaN;
      setText(angleLabel, t(moving ? 'walk' : 'angle'));
      setText(angleUnit, moving ? '' : '°');
      setText(fireBtn, t(moving ? 'walk' : 'fire'));
      const [left, right] = hudBottom.querySelectorAll('.pill.step[data-axis="angle"]');
      if (left) left.setAttribute('aria-label', t(moving ? 'walkLeft' : 'swingLeft'));
      if (right) right.setAttribute('aria-label', t(moving ? 'walkRight' : 'swingRight'));
      powerDial.classList.toggle('off', moving);
      applyLock();
    }
    if (moving) {
      const walk = m && p.moveX !== null ? Math.round(p.moveX - m.x) : 0;
      if (walk !== seen.walk) {
        seen.walk = walk;
        setText(angleVal, walk === 0 ? '0' : walk < 0 ? `◂${-walk}` : `${walk}▸`);
      }
    } else {
      const ang = Math.round(p.angle ?? 0);
      if (ang !== seen.angle) {
        seen.angle = ang;
        setText(angleVal, ang);
      }
    }
    const pow = Math.round(p.power ?? 0);
    if (pow !== seen.power) {
      seen.power = pow;
      setText(powerVal, pow);
    }
    if (p.weaponId !== seen.weapon) {
      seen.weapon = p.weaponId;
      markWeapon(p.weaponId);
    }

    // ---- wind ------------------------------------------------------------
    const wind = Math.round(world.wind || 0);
    if (wind !== seen.wind) {
      seen.wind = wind;
      const mag = Math.abs(wind);
      const max = Math.max(1, match.settings.windMax || 1);
      const strength = Math.min(1, mag / max);
      windEl.classList.toggle('west', wind < 0);
      windEl.classList.toggle('calm', mag === 0);
      setText(windNum, mag === 0 ? t('calm') : String(mag));
      setText(windHead, wind < 0 ? '◀' : '▶');
      windBar.style.width = `${6 + strength * 26}px`;
      windBar.style.opacity = String(0.35 + strength * 0.65);
      windEl.setAttribute('aria-label', mag === 0 ? t('windCalm') : t('wind', mag, wind < 0));
    }

    // ---- shot timer ------------------------------------------------------
    const t = match.timeLeft > 0 ? Math.ceil(match.timeLeft) : 0;
    if (t !== seen.timer) {
      seen.timer = t;
      shotTimer.hidden = t <= 0;
      if (t > 0) {
        setText(shotTimer, t);
        shotTimer.classList.toggle('urgent', t <= 5);
      }
    }
  }

  /** Dim and disable the bottom strip: firing, or somebody else's turn. */
  function lockControls(locked) {
    controlsLocked = !!locked;
    if (seen.locked === controlsLocked) return;
    seen.locked = controlsLocked;
    applyLock();
  }

  function applyLock() {
    hudBottom.classList.toggle('locked', controlsLocked);
    for (const pill of hudBottom.querySelectorAll('.pill.step')) {
      pill.disabled = controlsLocked || (moveMode && pill.dataset.axis === 'power');
    }
    fireBtn.disabled = controlsLocked;
    for (const w of weaponButtons) w.btn.disabled = controlsLocked;
  }

  // =========================================================================
  // Screen switching
  // =========================================================================

  let onHud = false;

  function show(which) {
    for (const key of Object.keys(screens)) {
      screens[key].hidden = key !== which;
    }
    onHud = which === 'hud';
    // Changing screen is a way out of a pause too: abandoning a match from
    // the pause panel lands on the setup screen, and leaving the overlay up
    // over it would strand the player behind a panel about a match that no
    // longer exists.
    pausePanel.hidden = true;
    // The pause pill belongs to a round in progress and nothing else.
    pauseBtn.hidden = !onHud;
  }

  // =========================================================================
  // Scoreboard
  // =========================================================================

  function statCell(label, value) {
    const c = el('span', 'cell');
    c.appendChild(el('b', null, value));
    c.appendChild(el('i', null, label));
    return c;
  }

  function swatchFor(player) {
    const s = el('i', 'swatch');
    s.style.background = player.color.hex;
    return s;
  }

  let sbMatch = null;
  let waiting = { names: null, tapped: false };

  function showScoreboard(match) {
    waiting = { names: null, tapped: false };
    sbWait.hidden = true;
    sbContinue.disabled = false;
    fillScoreboard(match);
    show('scoreboard');
  }

  /** The table itself, without moving screens: also a language switch's repaint. */
  function fillScoreboard(match) {
    sbMatch = match;
    setText(sbTitle, t('sb.title', match.round));
    sbRows.textContent = '';
    // Best round first: the scoreboard is the one moment the table is not in
    // seat order, because what everyone wants to know is who just had a good
    // round.
    const order = match.lastAwards
      .map((a) => ({ award: a, player: match.player(a.playerId) }))
      .filter((r) => r.player)
      .sort((a, b) => b.award.bolts - a.award.bolts);

    for (const { award, player } of order) {
      const row = el('div', 'sb-row');
      row.style.setProperty('--c', player.color.hex);

      const who = el('div', 'sb-who');
      who.appendChild(swatchFor(player));
      who.appendChild(el('b', null, player.name));
      who.appendChild(
        el('span', award.alive ? 'tag standing' : 'tag wrecked', t(award.alive ? 'standing' : 'wrecked')),
      );
      if (award.won) who.appendChild(el('span', 'tag won', t('tookRound')));
      row.appendChild(who);

      const stats = el('div', 'sb-stats');
      stats.appendChild(statCell(t('stat.damage'), Math.round(player.round.damage)));
      stats.appendChild(statCell(t('stat.wrecks'), player.round.kills));
      stats.appendChild(statCell(t('stat.wins'), player.roundWins));
      stats.appendChild(statCell(t('stat.score'), comma(player.score)));
      row.appendChild(stats);

      const money = el('div', 'sb-money');
      const earned = el('div', 'earned');
      earned.appendChild(el('span', 'plus', '+'));
      earned.appendChild(boltAmount(award.bolts, ''));
      money.appendChild(earned);
      const chips = el('div', 'chips');
      // The sim names each reason with a key ('damage', 'round win'); the
      // words are ours.
      for (const [label, amount] of award.reasons) {
        chips.appendChild(el('span', 'chip', `${t(`reason.${label}`)} ${comma(amount)}`));
      }
      money.appendChild(chips);
      money.appendChild(boltAmount(player.money, t('inTheTin')));
      row.appendChild(money);

      sbRows.appendChild(row);
    }
  }

  sbContinue.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onReady();
  });

  // =========================================================================
  // The parts counter
  // =========================================================================

  /** Live references into the rows, so updateShop is not a rebuild. */
  let shopRefs = [];
  let shopIsBot = false;

  /** `watch`: somebody else's turn at the counter, on their own screen. */
  /** The last call that filled the shop, so a language switch can make it again. */
  let shopAgain = null;

  function showShop(match, { watch = false } = {}) {
    const p = match.shopper();
    if (!p) return;
    shopAgain = () => showShop(match, { watch });
    shopIsBot = !!p.isAI || watch;
    shopSwatch.style.background = p.color.hex;
    screens.shop.style.setProperty('--c', p.color.hex);
    setText(shopName, p.name);
    // Dead players still shop — next round they walk again — and the header
    // says so rather than leaving somebody wondering why a wreck is buying.
    shopStatus.hidden = p.alive;
    if (!p.alive) setText(shopStatus, t('shopWrecked'));

    shopRowsBox.textContent = '';
    shopRefs = [];
    for (const row of match.shopRows(p)) {
      const { item } = row;
      const r = el('div', 'shop-row');
      r.appendChild(iconImg(item.icon));

      const main = el('div', 'sr-main');
      main.appendChild(el('b', 'sr-name', wName(item.id)));
      main.appendChild(el('span', 'sr-desc', wDesc(item.id)));
      r.appendChild(main);

      const buyBox = el('div', 'sr-buy');
      buyBox.appendChild(boltAmount(item.price, ''));
      buyBox.appendChild(
        el('span', 'sr-pack', t('pack', item.pack)),
      );
      const owned = el('span', 'sr-owned', row.owned ? t('holding', row.owned) : '');
      buyBox.appendChild(owned);
      const buy = el('button', 'buy', t('buy'));
      buy.type = 'button';
      buy.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.onBuy(item.id);
      });
      buyBox.appendChild(buy);
      r.appendChild(buyBox);

      shopRowsBox.appendChild(r);
      shopRefs.push({ id: item.id, price: item.price, owned, buy, root: r });
    }

    // A bot's turn at the counter is something to watch, not to press.
    shopBotLine.hidden = !shopIsBot;
    if (shopIsBot) setText(shopBotLine, t(watch ? 'shopWatch' : 'shopLooking', p.name));
    shopDone.hidden = shopIsBot;

    updateShop(match);
    show('shop');
  }

  function updateShop(match) {
    const p = match.shopper();
    if (!p) return;
    shopMoney.textContent = '';
    shopMoney.appendChild(boltAmount(p.money, t('bolts')));
    for (const ref of shopRefs) {
      const owned = p.inventory[ref.id] || 0;
      setText(ref.owned, owned ? t('holding', owned) : '');
      const canBuy = !shopIsBot && p.money >= ref.price;
      ref.buy.disabled = !canBuy;
      ref.buy.setAttribute('aria-disabled', String(!canBuy));
      ref.root.classList.toggle('poor', p.money < ref.price);
      ref.root.classList.toggle('held', owned > 0);
    }
  }

  /**
   * What a bot walked out with, grouped so three Heavy Shells read as one
   * line. A bot has already bought everything by the time `shopOpen` reaches
   * main.js, so this is the whole of a bot's visit to the counter and it
   * opens the screen itself rather than assuming showShop() came first.
   */
  function showBotShopping(match, purchases) {
    const p = match.shopper();
    if (!p) return;
    showShop(match);
    shopAgain = () => showBotShopping(match, purchases);
    const names = new Map(match.shopRows(p).map((r) => [r.item.id, wName(r.item.id)]));
    const counts = new Map();
    for (const id of purchases || []) {
      const name = names.get(id) || id;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    shopBotLine.hidden = false;
    setText(
      shopBotLine,
      parts.length ? t('bought', p.name, parts) : t('boughtNothing', p.name),
    );
    updateShop(match);
  }

  shopDone.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onReady();
  });

  // =========================================================================
  // Match over
  // =========================================================================

  let moMatch = null;

  function showMatchOver(match) {
    moMatch = match;
    const standings = match.standings || [];
    setText(moTitle, t('mo.title'));
    moRows.textContent = '';
    const champ = standings[0] ? match.player(standings[0].playerId) : null;
    setText(moChamp, champ ? t('champ', champ.name) : t('noChamp'));
    if (champ) screens.matchover.style.setProperty('--c', champ.color.hex);

    for (const s of standings) {
      const player = match.player(s.playerId);
      if (!player) continue;
      const row = el('div', 'mo-row');
      row.style.setProperty('--c', player.color.hex);
      row.classList.toggle('first', s.place === 1);
      row.appendChild(el('span', 'place', String(s.place)));
      row.appendChild(swatchFor(player));
      row.appendChild(el('b', 'mo-name', s.name));
      const stats = el('div', 'mo-stats');
      stats.appendChild(statCell(t('stat.score'), comma(s.score)));
      stats.appendChild(statCell(t('stat.rounds'), s.roundWins));
      stats.appendChild(statCell(t('stat.wrecks'), s.kills));
      stats.appendChild(statCell(t('stat.bolts'), comma(s.money)));
      row.appendChild(stats);
      moRows.appendChild(row);
    }
    show('matchover');
  }

  moAgain.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onReady();
  });

  // =========================================================================
  // Pause
  // =========================================================================

  resumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onResume();
  });
  quitBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cb.onQuit();
  });
  botSpeed.addEventListener('input', () => {
    const v = Math.max(1, Math.min(4, Number(botSpeed.value) || 1));
    setText(botSpeedOut, `×${v}`);
    cb.onBotSpeed(v);
  });

  volume.addEventListener('input', () => {
    const v = Math.max(0, Math.min(100, Number(volume.value) || 0));
    setText(volumeOut, v);
    cb.onVolume(v / 100);
  });

  // =========================================================================
  // The callout — a turn, a round, a purchase, then gone
  // =========================================================================

  let calloutTimer = 0;
  let calloutHide = 0;

  /** What the callout is saying, kept as makers for a language switch. */
  let calloutSays = { title: '', sub: '' };
  const said = (x) => (typeof x === 'function' ? x() : x || '');

  /** `title` and `sub` may be strings or functions that make them (t() calls). */
  function banner(title, sub, ms = 1700) {
    clearTimeout(calloutTimer);
    clearTimeout(calloutHide);
    calloutSays = { title, sub };
    setText(calloutTitle, said(title));
    setText(calloutSub, said(sub));
    calloutSub.hidden = !sub;
    callout.hidden = false;
    // A frame between un-hiding and the class, or the transition never runs.
    requestAnimationFrame(() => callout.classList.add('up'));
    calloutTimer = setTimeout(() => {
      callout.classList.remove('up');
      calloutHide = setTimeout(() => {
        callout.hidden = true;
      }, 320);
    }, Math.max(300, ms));
  }

  // =========================================================================
  // The way out
  // =========================================================================

  function setExit(verb, onExit) {
    for (const btn of document.querySelectorAll('.exit-btn')) {
      setText(btn, verb || t('exit.arcade'));
      btn.hidden = false;
      btn.onclick = (e) => {
        e.stopPropagation();
        onExit();
      };
    }
  }

  // =========================================================================
  // Pause, online or not
  // =========================================================================

  let pauseRole = null;

  /**
   * The pause panel, online: 'host' or 'guest', or null for hot-seat. A
   * hill shared with other screens cannot be stopped from this one, so the
   * panel says so and nothing on it pretends otherwise (hub §2) — and the
   * bot speed, which is the host's, is not offered to a guest. The words are
   * the hub's plain ones: Pause and Resume when it pauses, Menu and Back when
   * it cannot.
   */
  function setOnline(role) {
    pauseRole = role || null;
    const online = !!role;
    setText(pauseKicker, t(online ? 'pause.kickerOnline' : 'pause.kicker'));
    setText(pauseTitle, t(online ? 'pause.titleOnline' : 'pause.title'));
    pauseNote.hidden = !online;
    setText(pauseNote, role === 'host' ? t('pause.noteHost') : role === 'guest' ? t('pause.noteGuest') : '');
    botSpeedRow.hidden = role === 'guest';
    setText(resumeBtn, t(online ? 'back' : 'resume'));
    setText(quitBtn, t(role === 'host' ? 'quitHost' : role === 'guest' ? 'quitGuest' : 'quit'));
  }

  // =========================================================================
  // Language
  // =========================================================================

  /*
   * Two copies of the row, one on the setup screen and one in the pause
   * panel; both are wired here and both show the same choice. A tap repaints
   * in place (js/i18n.js dispatches arcade:lang, answered below) and changes
   * no screen: the pause panel stays open and the round stays paused.
   */
  const langButtons = document.querySelectorAll('.seg-lang [data-lang]');
  function markLang() {
    const lang = getLang();
    for (const b of langButtons) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  }
  for (const b of langButtons) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.lang !== getLang()) setLang(b.dataset.lang);
    });
  }
  markLang();

  document.addEventListener('arcade:lang', () => {
    markLang();
    // Setup: the pills, and the seat cards with any name the game chose.
    buildSetupSegs();
    renderPreset();
    renderRounds();
    renderMoney();
    localiseNames();
    renderSeats();
    // The HUD: forget what was written and diff it all again now, rather
    // than on the next stepped frame, which a paused round does not have.
    if (seenMatch) {
      resetSeen();
      seen.locked = null;
      if (onHud) updateHud(seenMatch);
    }
    // Whichever panel is up, filled again where it stands.
    if (!screens.scoreboard.hidden && sbMatch) {
      fillScoreboard(sbMatch);
      if (waiting.names) api.setWaiting(waiting.names, waiting.tapped);
    }
    if (!screens.shop.hidden && shopAgain) shopAgain();
    if (!screens.matchover.hidden && moMatch) showMatchOver(moMatch);
    setOnline(pauseRole);
    if (!callout.hidden) {
      setText(calloutTitle, said(calloutSays.title));
      setText(calloutSub, said(calloutSays.sub));
    }
  });

  // =========================================================================
  // The API main.js holds
  // =========================================================================

  const api = {
    showSetup(lastSpecs, lastPreset, lastRounds) {
      if (Array.isArray(lastSpecs) && lastSpecs.length >= MIN_PLAYERS) {
        adoptSpecs(lastSpecs, lastPreset, lastRounds);
      } else {
        const saved = loadSetup();
        if (saved) {
          adoptSpecs(saved.seats, saved.preset, saved.rounds);
          setup.custom = !!saved.custom || ![1, 3, 5, 10].includes(setup.rounds);
          // Older saves have no purse: keep the preset's, untouched.
          if (MONEY_STEPS.includes(saved.money)) {
            setup.money = saved.money;
            setup.moneyTouched = !!saved.moneyTouched;
          } else {
            setup.money = resolveSettings(setup.preset).startMoney;
            setup.moneyTouched = false;
          }
        } else {
          setup.preset = 'default';
          setup.rounds = resolveSettings('default').rounds;
          setup.custom = false;
          setup.money = resolveSettings('default').startMoney;
          setup.moneyTouched = false;
          setup.roundsTouched = false;
          setup.seatsTouched = false;
          defaultSeats('default');
        }
      }
      renderPreset();
      renderRounds();
      renderMoney();
      renderSeats();
      show('setup');
    },

    showHud() {
      show('hud');
    },

    /** The online lobby panel (js/net/lobby.js fills it). */
    showLobby() {
      show('lobby');
    },

    /** The setup screen exactly as it was left, open hangar and all. */
    returnToSetup() {
      renderSeats();
      show('setup');
    },

    /**
     * The open hangar on the setup screen: { words, status, tone } while
     * hosting, null when it closes (and every friend's seat goes with it).
     */
    setHangar(info) {
      hangarBox.hidden = !info;
      onlineBtn.hidden = !!info;
      if (!info) {
        for (const seat of setup.seats.slice()) if (seat.remote) removeRemoteSeat(seat.remote);
        return;
      }
      hangarCode.textContent = '';
      // The code's words in this device's language; the wire keeps its own.
      for (const w of info.words) hangarCode.appendChild(el('span', 'code-word', codeWord(w).toLocaleUpperCase()));
      hangarCode.setAttribute('aria-label', info.words.map(codeWord).join(' '));
      setText(hangarStatus, info.status || '');
      hangarStatus.className = info.tone ? `blurb ${info.tone}` : 'blurb';
    },
    /** The host's callsign goes on the first seat that is still "You". */
    setHostName(name) {
      const seat = setup.seats.find((s) => !s.isAI && !s.remote);
      if (seat && (seat.autoName || variants('you').includes(seat.name))) {
        seat.name = name;
        seat.autoName = false;
        renderSeats();
      }
    },
    addRemoteSeat,
    removeRemoteSeat,
    roomSummary,

    /** Online results: who the table is waiting on, and whether we tapped. */
    setWaiting(names, tapped) {
      waiting = { names, tapped };
      const text = names && names.length ? t('waitingFor', names) : '';
      sbWait.hidden = !text;
      setText(sbWait, text);
      sbContinue.disabled = !!tapped;
    },

    /**
     * The pause panel, online: 'host' or 'guest', or null for hot-seat. A
     * hill shared with other screens cannot be stopped from this one, so the
     * panel says so and nothing on it pretends otherwise (hub §2) — and the
     * bot speed, which is the host's, is not offered to a guest.
     */
    setOnline,
    updateHud,
    lockControls,


    showScoreboard,
    showShop,
    updateShop,
    showBotShopping,
    showMatchOver,

    showPause() {
      pausePanel.hidden = false;
      // A pause pill beside an open pause menu is a button asking to be
      // pressed twice.
      pauseBtn.hidden = true;
      pausePanel.focus?.();
    },
    hidePause() {
      pausePanel.hidden = true;
      pauseBtn.hidden = !onHud;
    },
    /** Whether the pause panel is currently up, so main need not track it. */
    get paused() {
      return !pausePanel.hidden;
    },

    banner,
    setExit,

    /** The skip button: up only while no human is standing this round. */
    setSkip(available) {
      if (skipBtn.hidden === !available) return;
      skipBtn.hidden = !available;
    },

    /** Bot speed as a multiplier, 1..4. Sets the slider without calling back. */
    setBotSpeed(v) {
      botSpeed.value = String(v);
      setText(botSpeedOut, `×${v}`);
    },

    /** Volume as 0..1. Sets the slider without calling back. */
    setVolume(v) {
      const pct = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
      volume.value = String(pct);
      setText(volumeOut, pct);
    },
  };
  setOnline(null);
  return api;
}
