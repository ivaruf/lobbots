/*
 * checkpoint.js — a Match as text and back, and a fingerprint of one.
 *
 * Online play (js/net/) runs the same Match on every device and sends only
 * decisions, so the devices agree because the sim is deterministic — every
 * random number seeded (rng.js), every transcendental function written out by
 * hand (dmath.js). This file is the seatbelt for the day that is not true.
 *
 *   stateHash(match)   A 32-bit fingerprint of everything that decides the
 *                      game. The host sends one at the start of every turn;
 *                      a device whose own fingerprint differs has drifted.
 *   snapshot(match)    The whole Match as one JSON string, for the host to
 *   restore(match, s)  send to a drifted device, which then carries on from
 *                      exactly the host's state rather than its own.
 *
 * WHEN A SNAPSHOT MAY BE TAKEN. Only while the battlefield is quiet
 * (canCheckpoint): nothing in the air, nothing pouring, no wreck cooking off.
 * Shells hold their weapon by reference and cook-offs hold their mech, and a
 * quiet world has neither, so everything left is plain data. The host simply
 * waits for the next quiet moment, which in a turn-based game is never far.
 *
 * Fields are copied by "everything except", not by a list of names, so a
 * field added to Match or World later travels without anyone remembering to
 * add it here. Infinity (the shell's ammo), Map and Set do not survive JSON
 * on their own and are tagged on the way out.
 *
 * Nothing here touches the DOM; the smoke test can import it.
 */

import { World } from './world.js';
import { Terrain } from './terrain.js';
import { mulberry32 } from './rng.js';

/** Not data, or rebuilt rather than copied. */
const MATCH_SKIP = new Set(['settings', 'rng', 'world', 'events']);
const WORLD_SKIP = new Set(['settings', 'rng', 'terrain', 'events']);

export function canCheckpoint(match) {
  if (!match || match.state === 'firing' || match.roundEnding) return false;
  return !match.world || match.world.isQuiet();
}

function copyExcept(obj, skip) {
  const out = {};
  for (const key of Object.keys(obj)) if (!skip.has(key)) out[key] = obj[key];
  return out;
}

function replacer(key, value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return { $n: String(value) };
  if (value instanceof Map) return { $map: [...value.entries()] };
  if (value instanceof Set) return { $set: [...value] };
  return value;
}

function reviver(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('$n' in value) return Number(value.$n);
    if ('$map' in value) return new Map(value.$map);
    if ('$set' in value) return new Set(value.$set);
  }
  return value;
}

export function snapshot(match) {
  const w = match.world;
  return JSON.stringify(
    {
      v: 1,
      match: copyExcept(match, MATCH_SKIP),
      rng: match.rng.state(),
      world: w
        ? { ...copyExcept(w, WORLD_SKIP), rng: w.rng.state(), terrain: copyExcept(w.terrain, new Set()) }
        : null,
    },
    replacer,
  );
}

/** Overwrite `match` in place, so every reference to it stays good. */
export function restore(match, text) {
  const data = JSON.parse(text, reviver);
  if (!data || data.v !== 1) throw new Error('checkpoint: unknown format');
  Object.assign(match, data.match);
  match.rng.setState(data.rng);
  if (data.world) {
    const { rng, terrain, ...rest } = data.world;
    const w = Object.create(World.prototype);
    Object.assign(w, rest);
    w.settings = match.settings;
    w.rng = mulberry32(0);
    w.rng.setState(rng);
    w.terrain = Object.assign(Object.create(Terrain.prototype), terrain);
    w.events = [];
    match.world = w;
  } else {
    match.world = null;
  }
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/**
 * FNV-1a over the bits of every number that decides the game. `+ 0` folds -0
 * into 0: JSON cannot carry the sign of a zero, and nothing in the sim cares.
 * Left out on purpose: recoil, which the renderer decays on its own clock.
 */
export function stateHash(match) {
  let h = 0x811c9dc5;
  const num = (v) => {
    f64[0] = (typeof v === 'number' ? v : v ? 1 : 0) + 0;
    h = Math.imul(h ^ u32[0], 0x01000193);
    h = Math.imul(h ^ u32[1], 0x01000193);
  };
  const str = (s) => {
    s = s == null ? '' : String(s);
    num(s.length);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };

  str(match.state);
  num(match.round);
  str(match.currentId);
  str(match.shopperId);
  num(match.rng.state());
  for (const p of match.players) {
    str(p.id);
    num(p.isAI);
    num(p.money);
    num(p.score);
    num(p.kills);
    num(p.angle);
    num(p.power);
    str(p.weaponId);
    for (const id of Object.keys(p.inventory).sort()) {
      str(id);
      num(p.inventory[id]);
    }
  }
  const w = match.world;
  if (w) {
    num(w.rng.state());
    num(w.wind);
    num(w.nextId);
    for (const m of w.mechs) {
      num(m.x);
      num(m.y);
      num(m.health);
      num(m.shield);
      num(m.alive);
    }
    for (const col of w.terrain.cols) {
      num(col.length);
      for (let i = 0; i < col.length; i++) num(col[i]);
    }
  }
  return h >>> 0;
}
