/*
 * rng.js — a tiny seedable generator (mulberry32) and the helpers the sim
 * draws through.
 *
 * Every random number the simulation uses comes from one of these. A match
 * has one seed; each round derives its own with hash(), so terrain, wind and
 * spawn order for round 3 are the same on every machine that has the match
 * seed — which is the whole promise the multiplayer plan (ARCHITECTURE.md §3)
 * rests on, and why a bug report can carry a seed. Math.random() is for the
 * render side only: smoke, sparks, cloud jitter.
 */

/** Returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a seed with a small integer into a fresh, well-spread seed. */
export function hash(seed, n) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (n + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A seed from nowhere in particular, for a match nobody seeded. */
export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Uniform float in [lo, hi). */
export function range(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

/** Uniform integer in [lo, hi] inclusive. */
export function int(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** One element of a non-empty array. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Roughly normal, mean 0, sd 1 (sum of three uniforms; plenty for aim noise). */
export function gauss(rng) {
  return (rng() + rng() + rng() - 1.5) * 2;
}

/** In-place Fisher–Yates. */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
