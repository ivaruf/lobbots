/*
 * ai.js — seven rivals from one routine: estimate, fire, watch, correct.
 *
 * THE AI DOES NOT KNOW THE ANSWER. Its first shot at a target is a vacuum
 * solution (ballistics.powerForElevation) with wind ignored or crudely
 * compensated, plus noise. Every shot after that is a correction from where
 * the last one actually landed: range goes with the square of speed, so a
 * shot that fell 20% short wants power divided by sqrt(0.8), blended in by
 * the personality's learnRate and shaken by its noise. That is how a person
 * plays artillery, and it is why "72 was short, try 76" is also what the
 * bots are doing across the table.
 *
 * A personality is a PARAMETER SET over that routine — never a separate
 * brain. Seven of them are listed in PERSONALITIES and the setup screen
 * offers them by name. Add an eighth by adding an object.
 *
 * Memory lives on the player (player.aiMemory) so it survives a round's
 * World being thrown away, and it is per target: switching targets means
 * starting over, the same as it does for a human.
 *
 * All randomness comes from the match's rng, so an AI match replays.
 */

import { BODY_LIFT } from '../config.js';
import { powerForElevation, hangTime } from './ballistics.js';
import { SHOP_ITEMS, weaponById } from './weapons.js';
import { range, gauss, pick, shuffle } from './rng.js';

export const PERSONALITIES = {
  rookie: {
    id: 'rookie', name: 'Rookie', blurb: 'Big swings, short memory. Dangerous by accident.',
    // Forgetting was 0.35 once, and six Rookies then never finished a round:
    // a bot that wipes its memory every third turn never converges. It still
    // forgets more than anyone else; it just gets to be wrong on purpose less.
    aimNoise: 0.13, angleNoise: 5, learnRate: 0.55, forget: 0.15, windSkill: 0.1,
    arc: 'mixed', targeting: 'nearest', weaponStyle: 'basic',
    shopping: { reserve: 0.2, prefs: ['heavy', 'dirt', 'bouncer'], random: true },
  },
  improviser: {
    id: 'improviser', name: 'Improviser', blurb: 'Decent aim, never the same weapon twice.',
    aimNoise: 0.10, angleNoise: 3, learnRate: 0.6, forget: 0.1, windSkill: 0.4,
    arc: 'mixed', targeting: 'random', weaponStyle: 'varied',
    shopping: { reserve: 0.1, prefs: ['cluster', 'roller', 'bouncer', 'funky', 'heavy'], random: true },
  },
  calculator: {
    id: 'calculator', name: 'Calculator', blurb: 'Dials in from the last miss. Give it two shots and worry.',
    aimNoise: 0.06, angleNoise: 1, learnRate: 0.9, forget: 0, windSkill: 0.7,
    arc: 'high', targeting: 'nearest', weaponStyle: 'dialed',
    shopping: { reserve: 0.15, prefs: ['heavy', 'mega', 'mirv', 'burrower'] },
  },
  sniper: {
    id: 'sniper', name: 'Sniper', blurb: 'Flat, accurate, stingy. Spends the good ammo only when sure.',
    aimNoise: 0.04, angleNoise: 1, learnRate: 0.85, forget: 0, windSkill: 0.85,
    arc: 'low', targeting: 'weakest', weaponStyle: 'conserve',
    shopping: { reserve: 0.4, prefs: ['mega', 'heavy', 'burrower'] },
  },
  maniac: {
    id: 'maniac', name: 'Maniac', blurb: 'Buys the biggest thing in the shop and fires it at whoever is closest.',
    aimNoise: 0.13, angleNoise: 4, learnRate: 0.6, forget: 0.1, windSkill: 0.3,
    arc: 'high', targeting: 'nearest', weaponStyle: 'big',
    shopping: { reserve: 0, prefs: ['nuke', 'mega', 'volcano', 'napalm', 'mirv', 'cluster', 'heavy'] },
  },
  economist: {
    id: 'economist', name: 'Economist', blurb: 'Saves half of everything. Picks on the wounded.',
    aimNoise: 0.08, angleNoise: 2, learnRate: 0.75, forget: 0.05, windSkill: 0.6,
    arc: 'mixed', targeting: 'weakest', weaponStyle: 'conserve',
    shopping: { reserve: 0.5, prefs: ['heavy', 'cluster', 'roller', 'dirt'] },
  },
  chaos: {
    id: 'chaos', name: 'Chaos Gopher', blurb: 'Plausible choices in an implausible order. Delightful to watch, from a distance.',
    aimNoise: 0.15, angleNoise: 8, learnRate: 0.5, forget: 0.25, windSkill: 0.3,
    arc: 'mixed', targeting: 'random', weaponStyle: 'chaos',
    shopping: { reserve: 0.05, prefs: [], random: true },
  },
};
export const PERSONALITY_IDS = Object.keys(PERSONALITIES);

/** Within this many px of the target counts as dialled in. */
const CONFIDENT_PX = 60;

// ---------------------------------------------------------------------------
// Aiming
// ---------------------------------------------------------------------------

/**
 * Choose a shot. Returns { weaponId, angle, power, targetId } or null when
 * there is nothing to shoot at. Also records the plan in player.aiMemory so
 * observe() can grade it.
 */
export function decide(world, player, rng) {
  const P = PERSONALITIES[player.personality] || PERSONALITIES.rookie;
  const me = world.mechFor(player.id);
  if (!me || !me.alive) return null;
  const enemies = world.mechs.filter((m) => m.alive && m.playerId !== player.id && m.team !== me.team);
  if (!enemies.length) return null;

  const mem = (player.aiMemory ||= { targetId: null, shots: {} });

  // Forgetful players lose the thread between turns.
  if (P.forget > 0 && rng() < P.forget) mem.shots = {};

  // Target: keep the current one while it lives, unless this personality
  // wanders. Chaos re-rolls half the time for the sake of it.
  let target = enemies.find((m) => m.playerId === mem.targetId) || null;
  if (!target || (P.targeting === 'random' && rng() < 0.5)) {
    target = chooseTarget(P.targeting, me, enemies, rng);
    mem.targetId = target.playerId;
  }

  const g = world.settings.gravity;
  const sx = me.x, sy = me.y - BODY_LIFT;
  const tx = target.x, ty = target.y - BODY_LIFT;
  const dir = tx >= sx ? 1 : -1;
  const dist = Math.max(20, Math.abs(tx - sx));
  const dyUp = sy - ty; // y down: a target higher than us is a positive climb

  const last = mem.shots[target.playerId];
  let elev, power;

  if (last && last.landing) {
    // ---- Correct the last attempt ----------------------------------------
    elev = last.elev;
    power = last.power;
    // How far along the line of fire the last shot got, as a fraction of
    // how far it should have gone. Lost off the edge means it went long.
    let ratio;
    if (last.lost) ratio = 1.5;
    else ratio = ((last.landing.x - sx) * dir) / dist;

    if (ratio < 0.08) {
      // Landed at our own feet: there is a ridge in the way. Go over it.
      elev = Math.min(85, elev + 12);
    } else {
      const want = power / Math.sqrt(Math.max(0.1, ratio));
      power = power + P.learnRate * (want - power);
      if (power > 100) { power = 100; elev = elev > 45 ? Math.max(45, elev - 8) : Math.min(45, elev + 8); }
      if (power < 10) { power = 10; elev = Math.min(85, elev + 10); }
    }
    // Wind moved since last time: the good players allow for the change.
    if (P.windSkill > 0 && last.wind !== world.wind) {
      const T = hangTime(elev, power, g);
      const drift = 0.5 * (world.wind - last.wind) * T * T * dir; // + means pushed toward target
      const scale = Math.sqrt(Math.max(0.3, (dist - P.windSkill * drift) / dist));
      power *= scale;
    }
    // Corrections are steadier than first guesses.
    power += gauss(rng) * P.aimNoise * 100 * 0.5;
    elev += gauss(rng) * P.angleNoise * 0.5;
  } else {
    // ---- First guess -----------------------------------------------------
    elev = pickElevation(P.arc, rng);
    power = solveWithWind(dist, dyUp, elev, g, world.wind * dir, P.windSkill);
    if (power === null || power > 100) {
      // Cannot reach at that elevation: 45° is the longest throw.
      elev = 45;
      power = solveWithWind(dist, dyUp, elev, g, world.wind * dir, P.windSkill) ?? 100;
    }
    if (power < 8) {
      // Neighbour: lob it.
      elev = range(rng, 72, 82);
      power = solveWithWind(dist, dyUp, elev, g, world.wind * dir, P.windSkill) ?? 20;
    }
    power += gauss(rng) * P.aimNoise * 100;
    elev += gauss(rng) * P.angleNoise;
  }

  // Chaos: sometimes a shot straight up because why not.
  if (P.weaponStyle === 'chaos' && rng() < 0.15) {
    elev = range(rng, 78, 88);
    power = solveWithWind(dist, dyUp, elev, g, world.wind * dir, 0) ?? range(rng, 40, 90);
  }

  elev = clamp(elev, 8, 88);
  power = clamp(Math.round(power), 5, 100);
  const angle = dir > 0 ? Math.round(elev) : Math.round(180 - elev);

  const confident = !!(last && last.landing && !last.lost && Math.abs(last.landing.x - tx) < CONFIDENT_PX);
  const weaponId = chooseWeapon(P, player, target, dist, confident, rng);

  mem.shots[target.playerId] = {
    elev, power, wind: world.wind, targetX: tx, targetY: ty,
    landing: null, lost: false, pending: true,
  };
  return { weaponId, angle, power, targetId: target.playerId };
}

/**
 * The match reports where the shot ended: the first explosion, or the point
 * it was lost. The next decide() corrects from it.
 */
export function observe(player, landing, lost) {
  const mem = player.aiMemory;
  if (!mem) return;
  const shot = mem.shots[mem.targetId];
  if (!shot || !shot.pending) return;
  shot.pending = false;
  shot.lost = !!lost;
  shot.landing = landing ? { x: landing.x, y: landing.y } : null;
  // A shot that ended nowhere at all teaches nothing.
  if (!shot.landing) delete mem.shots[mem.targetId];
}

function chooseTarget(mode, me, enemies, rng) {
  if (mode === 'random') return pick(rng, enemies);
  if (mode === 'weakest') {
    return enemies.reduce((a, b) => (b.health < a.health ? b : a));
  }
  if (mode === 'strongest') {
    return enemies.reduce((a, b) => (b.health > a.health ? b : a));
  }
  // nearest
  return enemies.reduce((a, b) => (Math.abs(b.x - me.x) < Math.abs(a.x - me.x) ? b : a));
}

function pickElevation(arc, rng) {
  if (arc === 'high') return range(rng, 58, 72);
  if (arc === 'low') return range(rng, 30, 45);
  return rng() < 0.5 ? range(rng, 58, 72) : range(rng, 32, 48);
}

/**
 * Vacuum power for the range, with the wind allowed for as well as this
 * personality can: the expected drift over the hang time shortens or
 * lengthens the range it aims for by windSkill of the true amount.
 * `windAlong` is wind signed along the line of fire.
 */
function solveWithWind(dist, dyUp, elev, g, windAlong, windSkill) {
  let p = powerForElevation(dist, dyUp, elev, g);
  if (p === null) return null;
  if (windSkill > 0 && windAlong !== 0) {
    const T = hangTime(elev, Math.min(100, p), g);
    const drift = 0.5 * windAlong * T * T;
    const adjusted = Math.max(20, dist - windSkill * drift);
    p = powerForElevation(adjusted, dyUp, elev, g) ?? p;
  }
  return p;
}

/** Which of the player's weapons to use this turn. */
function chooseWeapon(P, player, target, dist, confident, rng) {
  const owned = Object.entries(player.inventory)
    .filter(([id, n]) => n > 0 && weaponById(id) && !weaponById(id).hidden)
    .map(([id]) => weaponById(id));
  const specials = owned.filter((w) => w.id !== 'shell');
  if (!specials.length) return 'shell';

  // Do not stand next to your own nuke. Maniacs and chaos sometimes do.
  const safe = (w) => w.radius * 1.3 < dist || ((P.weaponStyle === 'big' || P.weaponStyle === 'chaos') && rng() < 0.3);
  const usable = specials.filter(safe);
  if (!usable.length) return 'shell';
  const biggest = usable.reduce((a, b) => (b.damage * b.radius > a.damage * a.radius ? b : a));

  switch (P.weaponStyle) {
    case 'basic':
      return rng() < 0.15 ? pick(rng, usable).id : 'shell';
    case 'varied':
      return rng() < 0.7 ? pick(rng, usable).id : 'shell';
    case 'dialed':
      return confident ? biggest.id : 'shell';
    case 'conserve':
      return confident && (target.health <= 60 || rng() < 0.4) ? biggest.id : 'shell';
    case 'big':
      return biggest.id;
    case 'chaos':
      return rng() < 0.6 ? pick(rng, usable).id : 'shell';
    default:
      return 'shell';
  }
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

/**
 * What this player buys between rounds, as a list of item ids in order. The
 * match applies them one at a time through the normal buy action so the
 * money check is the same one a human gets.
 */
export function shop(player, rng) {
  const P = PERSONALITIES[player.personality] || PERSONALITIES.rookie;
  const S = P.shopping;
  let budget = player.money * (1 - S.reserve);
  const buys = [];
  const boughtCount = {};
  const order = S.random
    ? shuffle(rng, S.prefs.length ? S.prefs.slice() : SHOP_ITEMS.map((w) => w.id))
    : S.prefs.slice();

  // Two passes: priorities first, then anything affordable if there is still
  // a lot of money about — a rich bot with nothing on its list still shops.
  for (let pass = 0; pass < 2 && buys.length < 6; pass++) {
    const list = pass === 0 ? order : shuffle(rng, SHOP_ITEMS.map((w) => w.id));
    for (const id of list) {
      const w = weaponById(id);
      if (!w || w.hidden || w.price <= 0) continue;
      const have = player.inventory[id] || 0;
      // Do not hoard: at most two packs bought per visit, and not past ~3 packs owned.
      while (budget >= w.price && (boughtCount[id] || 0) < 2 && have + (boughtCount[id] || 0) * w.pack < w.pack * 3 && buys.length < 6) {
        buys.push(id);
        budget -= w.price;
        boughtCount[id] = (boughtCount[id] || 0) + 1;
        if (S.random && rng() < 0.5) break; // impulsive shoppers move on
      }
    }
    if (budget < 300) break;
  }
  return buys;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
