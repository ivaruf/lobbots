/*
 * config.js — every number that tunes Lobbots, in one place.
 *
 * Two kinds of thing live here and the split matters:
 *
 *   CONSTANTS  are facts about the build: field size, sim step, mech size,
 *              economy rates, AI pacing. Nothing on a menu changes them.
 *   SETTINGS   are the game options a player may change on the setup screen
 *              (gravity, wind, terrain mode, rounds, money...). DEFAULTS is
 *              the good preset the prompt asks for; PRESETS layer over it.
 *              A Match receives one resolved settings object and reads
 *              nothing else.
 *
 * Coordinates: x right, y DOWN (canvas order), origin top-left of the field.
 * Angles: degrees, 0 = firing right, 90 = straight up, 180 = firing left.
 * Power: 0..100, an integer as far as the player can tell.
 */

// ---------------------------------------------------------------------------
// Field and simulation
// ---------------------------------------------------------------------------

/** Logical battlefield size. The renderer letterboxes this into the window. */
export const WIDTH = 1600;
export const HEIGHT = 900;

/** The indestructible floor. Nothing is carved below this row. */
export const BEDROCK = HEIGHT - 24;

/** Fixed simulation step. main.js accumulates real time into these. */
export const SIM_DT = 1 / 120;

/** How far a projectile may move per collision sample, in px. */
export const SWEEP_STEP = 3;

/** Nothing flies for longer than this. A shell lost to the wind is dropped. */
export const PROJECTILE_MAX_AGE = 30;

/** How far past a side edge a shell may travel before it counts as lost
 *  (only when the offscreen rule is 'open'). Generous: the wind may bring
 *  it back, and watching the edge marker while it does is part of the fun. */
export const OPEN_MARGIN = 2400;

/** A trail point is kept every this many px of travel. */
export const TRAIL_SPACING = 6;

// ---------------------------------------------------------------------------
// Mechs
// ---------------------------------------------------------------------------

/** Hit circle radius around the body centre. */
export const MECH_RADIUS = 18;

/** Footprint width; the feet sample the ground at both ends and the middle. */
export const FOOT_W = 44;

/** Body centre sits this far above the feet. */
export const BODY_LIFT = 26;

/** Barrel length from the body centre to the muzzle. */
export const BARREL_LEN = 34;

/** Falling: a drop shorter than this is free; beyond it each px costs health. */
export const FALL_DAMAGE_FROM = 60;
export const FALL_DAMAGE_PER_PX = 0.25;

/** Damage multiplier when terrain sits between blast and mech. */
export const TERRAIN_SHADOW = 0.5;

/** Your own blasts hurt you, but not as much. Keeps buried-and-digging-out
 *  survivable and the nuke-at-your-own-feet a lesson rather than a suicide. */
export const SELF_DAMAGE_SCALE = 0.5;

/**
 * Move: the owner's own idea, not Tank Wars'. A bought Move spends the turn
 * walking instead of shooting. The walker goes up to MOVE_RANGE px either
 * way at WALK_SPEED, follows the ground, and refuses two things: a climb
 * steeper than WALK_MAX_RISE px per px (a cliff), and a drop it would take
 * fall damage from (it stops at the lip rather than stepping off). It also
 * will not walk through another walker. Either refusal stops it short, and
 * world.walkPreview() shows exactly where before the player commits.
 */
export const MOVE_RANGE = 220;
export const WALK_SPEED = 75;
export const WALK_MAX_RISE = 2;

/**
 * Death blasts, as in the original: a wreck does not just sit there. Shortly
 * after a walker dies its magazine cooks off as one weapon drawn from this
 * table, so a kill next to a rival can take them too, and once in a while a
 * wreck goes up as a nuke. Weights, not percentages; they happen to sum to
 * 100. Special-flight weapons (MIRV, roller, bouncer, funky, burrower) are
 * thrown up out of the wreck and fly as themselves; everything else goes off
 * in place. The delay is the half-second in which everyone nearby realises.
 */
export const DEATH_BLASTS = [
  ['shell', 21], ['heavy', 20], ['mega', 10], ['cluster', 9], ['napalm', 8],
  ['funky', 6], ['bouncer', 5], ['roller', 4], ['mirv', 4], ['dirt', 4],
  ['volcano', 4], ['burrower', 2], ['nuke', 3],
];
export const COOKOFF_MIN = 0.55;
export const COOKOFF_MAX = 1.1;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** Speed at which an unsupported span falls in 'crumble' and 'collapse'. */
export const TERRAIN_FALL_SPEED = 700;

/** 'collapse' only: a surface step steeper than this many px flows across. */
export const COLLAPSE_SLOPE = 28;

/** 'collapse' only: px of height moved per second across a steep step. */
export const TERRAIN_FLOW_SPEED = 240;

/** Fraction of the crater radius the rim may jitter by, for irregular holes. */
export const CRATER_JITTER = 0.08;

/**
 * Terrain profiles. All are the same generator with different knobs:
 *   base      mean surface height, fraction of HEIGHT up from BEDROCK
 *   amp       amplitude of the noise, fraction of HEIGHT
 *   octaves   layers of noise; more is rougher
 *   lacunarity/gain   frequency and amplitude ratio between layers
 *   ridged    abs(noise) folding, for sharp mountain ridges
 *   shape     an extra large-scale curve: 'none' | 'valley' | 'canyon'
 *   wavelength  px of the lowest octave
 */
export const TERRAIN_PROFILES = {
  rolling:   { base: 0.34, amp: 0.14, octaves: 3, lacunarity: 2.1, gain: 0.45, ridged: false, shape: 'none',   wavelength: 520 },
  mountains: { base: 0.40, amp: 0.26, octaves: 4, lacunarity: 2.0, gain: 0.5,  ridged: true,  shape: 'none',   wavelength: 420 },
  valley:    { base: 0.42, amp: 0.10, octaves: 3, lacunarity: 2.0, gain: 0.45, ridged: false, shape: 'valley', wavelength: 480 },
  canyon:    { base: 0.48, amp: 0.08, octaves: 3, lacunarity: 2.2, gain: 0.4,  ridged: false, shape: 'canyon', wavelength: 380 },
  chaos:     { base: 0.36, amp: 0.22, octaves: 6, lacunarity: 2.3, gain: 0.58, ridged: true,  shape: 'none',   wavelength: 300 },
  flat:      { base: 0.26, amp: 0.03, octaves: 2, lacunarity: 2.0, gain: 0.4,  ridged: false, shape: 'none',   wavelength: 700 },
};
export const TERRAIN_PROFILE_IDS = Object.keys(TERRAIN_PROFILES);

/** Surface must stay inside these fractions of HEIGHT above BEDROCK. */
export const TERRAIN_MIN_H = 0.06;
export const TERRAIN_MAX_H = 0.78;

/** Mechs never spawn closer than this to a side edge. */
export const SPAWN_MARGIN = 70;

// ---------------------------------------------------------------------------
// Ballistics
// ---------------------------------------------------------------------------

/** Muzzle speed per point of power, px/s. Power 100 at 45° carries roughly
 *  1.3 field widths under default gravity, so the edges are always in play. */
export const SPEED_PER_POWER = 9.1;

/** Wind is an acceleration in px/s². The displayed number is this value. */
export const WIND_UNIT = 1;

// ---------------------------------------------------------------------------
// Turn pacing (seconds)
// ---------------------------------------------------------------------------

/** After the world goes quiet, before the next turn is announced. */
export const TURN_GAP = 0.7;

/** AI pretends to think for a random time in this range... */
export const AI_THINK_MIN = 0.6;
export const AI_THINK_MAX = 1.4;
/** ...then swings the barrel to its answer at these rates before firing. */
export const AI_ANGLE_RATE = 90;   // degrees per second
export const AI_POWER_RATE = 60;   // power points per second

/** AI shopping happens in one beat; the UI holds the shop this long so a
 *  human can read what was bought. */
export const AI_SHOP_DWELL = 1.2;

/** Scoreboard with no human present advances on its own after this. */
export const AUTO_ADVANCE = 3.0;

// ---------------------------------------------------------------------------
// Economy — awarded at round end, all in bolts
// ---------------------------------------------------------------------------

export const ECONOMY = {
  perDamage: 5,       // bolts per point of damage dealt to a rival
  perKill: 300,
  survive: 150,
  roundWin: 400,
  salary: 200,        // everyone, every round, alive or not
  /** Anyone below this fraction of the richest purse is lifted to it. This
   *  is the anti-snowball rule: the leader keeps the lead, the trailer stays
   *  dangerous. */
  underdogFraction: 0.5,
};

export const SCORE = {
  perKill: 100,
  perDamage: 1,
  roundWin: 300,
};

// ---------------------------------------------------------------------------
// Player colours — distinct against dark strata and a dusk sky.
// ---------------------------------------------------------------------------

export const PALETTE = [
  { id: 'red',    name: 'Ember',   hex: '#e78d89' },
  { id: 'blue',   name: 'Cobalt',  hex: '#86b4ef' },
  { id: 'yellow', name: 'Alloy',  hex: '#d7c8a4' },
  { id: 'green',  name: 'Moss',    hex: '#8bc6b1' },
  { id: 'orange', name: 'Rust',    hex: '#dca688' },
  { id: 'purple', name: 'Violet',  hex: '#b6a0dc' },
  { id: 'cyan',   name: 'Coolant', hex: '#8cd6de' },
  { id: 'pink',   name: 'Flare',   hex: '#d9a2be' },
  { id: 'white',  name: 'Chalk',   hex: '#eef0f4' },
  { id: 'lime',   name: 'Acid',    hex: '#b8ca92' },
];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

// ---------------------------------------------------------------------------
// Settings — what the setup screen edits. DEFAULTS is the good preset.
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  preset: 'default',
  rounds: 5,
  startMoney: 800,
  startHealth: 100,
  gravity: 400,           // px/s²
  windMax: 60,            // px/s²; 0 turns wind off
  windChanges: 'round',   // 'round' | 'turn'
  terrainMode: 'crumble', // 'static' | 'crumble' | 'collapse'
  terrainProfile: 'random', // a TERRAIN_PROFILES key or 'random'
  trails: true,
  friendlyFire: true,     // team-mates can hurt each other
  teams: false,
  shake: true,
  shotTimer: 0,           // seconds per human turn; 0 = no timer
  offscreen: 'open',      // side edges: 'open' | 'wrap' | 'bounce' | 'vanish'
  fallDamage: true,
  deathBlasts: true,      // wrecks cook off as a random weapon (DEATH_BLASTS)
  moneyScale: 1,          // multiplies every award
  seed: null,             // null = roll one
};

/**
 * Presets are overrides on DEFAULTS. `players` is a hint for the setup
 * screen's default seat count, not a rule.
 */
export const PRESETS = {
  default: { label: 'Default', blurb: 'The way it is meant to be played.', players: 4, overrides: {} },
  classic: {
    label: 'Classic',
    blurb: 'Long match, wind per round, shells leave the field for good.',
    players: 4,
    overrides: { rounds: 10, startMoney: 500, windChanges: 'round', terrainMode: 'crumble', offscreen: 'vanish', shake: false },
  },
  quick: {
    label: 'Quick',
    blurb: 'Three rounds, twenty seconds a shot, wind that will not sit still.',
    players: 3,
    overrides: { rounds: 3, startMoney: 1200, windChanges: 'turn', shotTimer: 20 },
  },
  mayhem: {
    label: 'Mayhem',
    blurb: 'More of everyone, more money, the ground will not stop moving.',
    players: 6,
    overrides: { rounds: 5, startMoney: 4000, windMax: 90, terrainMode: 'collapse', moneyScale: 2 },
  },
};

/** Resolve a preset name plus explicit overrides into one settings object. */
export function resolveSettings(presetId = 'default', overrides = {}) {
  const preset = PRESETS[presetId] || PRESETS.default;
  return { ...DEFAULTS, preset: presetId, ...preset.overrides, ...overrides };
}
