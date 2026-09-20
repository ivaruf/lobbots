/*
 * terrain.js — the hillside as columns of solid spans.
 *
 * WHY SPANS AND NOT A HEIGHTMAP OR A BITMAP
 *   A heightmap cannot hold an overhang or a tunnel, and a burrower that
 *   cannot burrow is a shell. A bitmap can hold anything but makes "let the
 *   unsupported bit fall" a per-pixel job. A list of [top, bottom) intervals
 *   per column is the middle: carving a crater is one interval subtraction
 *   per column, a burrower is a hole in the middle of a span, and crumble is
 *   "does this span rest on the one below it", which is one comparison.
 *
 * COORDINATES  x right, y down. `cols[x]` is a flat array
 *   [t0, b0, t1, b1, ...], sorted top to bottom, non-overlapping, never
 *   touching (touching spans are merged). Everything at or below BEDROCK is
 *   solid whether or not a span says so; nothing is ever carved below it.
 *
 * SETTLING IS A PROCESS. carve() and fill() only change spans and mark the
 *   columns unsettled; settle(dt, mode) then moves anything unsupported down
 *   at TERRAIN_FALL_SPEED until it lands, one step at a time, so the renderer
 *   gets to draw the ground pouring into the hole rather than teleporting.
 *   'collapse' adds a surface flow between neighbouring columns on top.
 *
 * Nothing in here knows about mechs, projectiles or the DOM.
 */

import {
  WIDTH, HEIGHT, BEDROCK,
  TERRAIN_PROFILES, TERRAIN_MIN_H, TERRAIN_MAX_H,
  TERRAIN_FALL_SPEED, COLLAPSE_SLOPE, TERRAIN_FLOW_SPEED, CRATER_JITTER,
  SPAWN_MARGIN, FOOT_W,
} from '../config.js';
import { range, int } from './rng.js';

const EPS = 0.01;

export class Terrain {
  constructor(width = WIDTH, height = HEIGHT) {
    this.width = width;
    this.height = height;
    /** @type {number[][]} */
    this.cols = new Array(width);
    for (let x = 0; x < width; x++) this.cols[x] = [];
    /** Columns that may hold a floating span. */
    this.unsettled = new Set();
    /** Columns whose surface may still flow sideways ('collapse' only). */
    this.flowing = new Set();
    this.profileId = 'flat';
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * A fresh hillside. `profileId` is a TERRAIN_PROFILES key. Returns the
   * terrain; the caller places mechs on it with placeMechs().
   */
  static generate(rng, profileId) {
    const p = TERRAIN_PROFILES[profileId] || TERRAIN_PROFILES.rolling;
    const t = new Terrain();
    t.profileId = profileId;
    const W = t.width;

    // One lattice of random values per octave; value noise with cosine
    // interpolation between lattice points. Cheap, smooth enough, seeded.
    const octaves = [];
    let wavelength = p.wavelength;
    let amp = 1;
    let ampSum = 0;
    for (let k = 0; k < p.octaves; k++) {
      const n = Math.ceil(W / wavelength) + 2;
      const lattice = new Float64Array(n);
      for (let i = 0; i < n; i++) lattice[i] = rng() * 2 - 1;
      octaves.push({ lattice, wavelength, amp });
      ampSum += amp;
      wavelength /= p.lacunarity;
      amp *= p.gain;
    }

    const noiseAt = (x) => {
      let sum = 0;
      for (const o of octaves) {
        const fx = x / o.wavelength;
        const i = Math.floor(fx);
        const f = fx - i;
        const s = (1 - Math.cos(f * Math.PI)) * 0.5;
        let v = o.lattice[i] * (1 - s) + o.lattice[i + 1] * s;
        // Ridged: fold the noise so troughs become sharp crests.
        if (p.ridged) v = 1 - 2 * Math.abs(v);
        sum += v * o.amp;
      }
      return sum / ampSum; // roughly in [-1, 1]
    };

    // Large-scale shape on top of the noise, in fractions of HEIGHT.
    const cx = W * range(rng, 0.4, 0.6);
    const shapeAt = (x) => {
      if (p.shape === 'valley') {
        const d = (x - cx) / (W * 0.28);
        return -0.26 * Math.exp(-d * d);
      }
      if (p.shape === 'canyon') {
        const d = (x - cx) / 70;
        // Plateaus either side, a slot you can lose a shell in.
        return 0.12 - 0.5 * Math.exp(-d * d * d * d);
      }
      return 0;
    };

    const H = t.height;
    const minH = TERRAIN_MIN_H * H;
    const maxH = TERRAIN_MAX_H * H;
    for (let x = 0; x < W; x++) {
      let h = (p.base + p.amp * noiseAt(x) + shapeAt(x)) * H;
      if (h < minH) h = minH;
      if (h > maxH) h = maxH;
      const top = Math.round(BEDROCK - h);
      t.cols[x] = [top, BEDROCK];
    }
    return t;
  }

  /**
   * Choose `n` standing spots with sensible separation, flatten a pad under
   * each, and return their x positions in left-to-right order. The caller
   * decides which player gets which.
   */
  placeMechs(n, rng) {
    const lo = SPAWN_MARGIN;
    const hi = this.width - SPAWN_MARGIN;
    const slot = (hi - lo) / n;
    const xs = [];
    for (let i = 0; i < n; i++) {
      // Several candidates inside the slot; take the flattest footing.
      let best = null;
      let bestSlope = Infinity;
      for (let c = 0; c < 6; c++) {
        const x = Math.round(lo + slot * (i + range(rng, 0.2, 0.8)));
        const s = Math.abs(this.surfaceAt(x + FOOT_W / 2) - this.surfaceAt(x - FOOT_W / 2));
        if (s < bestSlope) { bestSlope = s; best = x; }
      }
      xs.push(best);
    }
    for (const x of xs) this.flattenPad(x, FOOT_W / 2 + 4);
    return xs;
  }

  /** Level the surface across [cx-half, cx+half] to its mean height. */
  flattenPad(cx, half) {
    const x0 = Math.max(0, Math.floor(cx - half));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + half));
    let sum = 0;
    for (let x = x0; x <= x1; x++) sum += this.surfaceAt(x);
    const mean = Math.round(sum / (x1 - x0 + 1));
    for (let x = x0; x <= x1; x++) {
      const top = this.surfaceAt(x);
      if (top < mean) this.removeInterval(x, top, mean);
      else if (top > mean) this.addInterval(x, mean, top);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Is (x, y) inside ground? Outside the side edges is open air. */
  solidAt(x, y) {
    if (y >= BEDROCK) return true;
    const xi = Math.round(x);
    if (xi < 0 || xi >= this.width) return false;
    const col = this.cols[xi];
    for (let i = 0; i < col.length; i += 2) {
      if (y < col[i]) return false;
      if (y < col[i + 1]) return true;
    }
    return false;
  }

  /** y of the topmost solid in this column (BEDROCK if the column is empty). */
  surfaceAt(x) {
    const xi = Math.round(x);
    if (xi < 0 || xi >= this.width) return BEDROCK;
    const col = this.cols[xi];
    return col.length ? col[0] : BEDROCK;
  }

  /**
   * Where something at (x, y) would come to rest: y itself if it is already
   * inside ground, otherwise the top of the first span below it.
   */
  groundBelow(x, y) {
    if (y >= BEDROCK) return y;
    const xi = Math.round(x);
    if (xi < 0 || xi >= this.width) return BEDROCK;
    const col = this.cols[xi];
    for (let i = 0; i < col.length; i += 2) {
      if (y < col[i]) return col[i];
      if (y < col[i + 1]) return y;
    }
    return BEDROCK;
  }

  /** Surface slope dy/dx (y down, so positive means falling to the right). */
  slopeAt(x) {
    return (this.surfaceAt(x + 3) - this.surfaceAt(x - 3)) / 6;
  }

  /**
   * Outward normal of the ground near (x, y), for bounces. Uses the local
   * span boundary the point is nearest to, so a ceiling bounces down.
   */
  normalAt(x, y) {
    const l = this.groundBelow(x - 3, y - 40);
    const r = this.groundBelow(x + 3, y - 40);
    // Tangent along the surface, normal is its perpendicular pointing up.
    const tx = 6, ty = r - l;
    const len = Math.hypot(tx, ty) || 1;
    let nx = ty / len, ny = -tx / len;
    if (ny > 0) { nx = -nx; ny = -ny; }
    // If we struck a ceiling (solid above, air below), flip it.
    if (this.solidAt(x, y - 2) && !this.solidAt(x, y + 2)) { nx = -nx; ny = -ny; }
    return { nx, ny };
  }

  /** Does the straight segment cross ground? Sampled every 4 px. */
  segmentBlocked(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / 4));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.solidAt(x0 + dx * t, y0 + dy * t)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /** Remove [a, b) from column x. */
  removeInterval(x, a, b) {
    if (x < 0 || x >= this.width) return;
    if (b > BEDROCK) b = BEDROCK;
    if (b - a <= EPS) return;
    const col = this.cols[x];
    const out = [];
    for (let i = 0; i < col.length; i += 2) {
      const t = col[i], bt = col[i + 1];
      if (bt <= a || t >= b) { out.push(t, bt); continue; }
      if (t < a) out.push(t, a);
      if (bt > b) out.push(b, bt);
    }
    this.cols[x] = out;
    this.unsettled.add(x);
  }

  /** Add [a, b) to column x, merging with anything it touches. */
  addInterval(x, a, b) {
    if (x < 0 || x >= this.width) return;
    if (b > BEDROCK) b = BEDROCK;
    if (a < 0) a = 0;
    if (b - a <= EPS) return;
    const col = this.cols[x];
    const out = [];
    let placed = false;
    for (let i = 0; i < col.length; i += 2) {
      const t = col[i], bt = col[i + 1];
      if (bt < a - EPS) { out.push(t, bt); continue; }
      if (t > b + EPS) {
        if (!placed) { out.push(a, b); placed = true; }
        out.push(t, bt);
        continue;
      }
      // Overlapping or touching: absorb into [a, b).
      if (t < a) a = t;
      if (bt > b) b = bt;
    }
    if (!placed) out.push(a, b);
    this.cols[x] = out;
    this.unsettled.add(x);
  }

  /**
   * Blow a roughly circular hole. The rim jitters by CRATER_JITTER so no two
   * craters are the same circle. Returns the dirty column range.
   */
  carve(cx, cy, r, rng) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const chord = r * r - dx * dx;
      if (chord <= 0) continue;
      const jitter = rng ? 1 + (rng() * 2 - 1) * CRATER_JITTER : 1;
      const dy = Math.sqrt(chord) * jitter;
      this.removeInterval(x, cy - dy, cy + dy);
    }
    this.markFlow(x0, x1);
    return { x0, x1 };
  }

  /** The dirt bomb: a round mound of new ground. */
  fill(cx, cy, r) {
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const chord = r * r - dx * dx;
      if (chord <= 0) continue;
      const dy = Math.sqrt(chord);
      this.addInterval(x, cy - dy, cy + dy);
    }
    this.markFlow(x0, x1);
    return { x0, x1 };
  }

  /** Scoop: remove a hemisphere and dump it as two shoulders either side. */
  scoop(cx, cy, r) {
    const dirty = this.carve(cx, cy, r, null);
    const shoulder = r * 0.55;
    this.fill(cx - r * 1.25, this.surfaceAt(cx - r * 1.25), shoulder);
    this.fill(cx + r * 1.25, this.surfaceAt(cx + r * 1.25), shoulder);
    return { x0: Math.max(0, Math.floor(dirty.x0 - r * 1.25 - shoulder)), x1: Math.min(this.width - 1, Math.ceil(dirty.x1 + r * 1.25 + shoulder)) };
  }

  markFlow(x0, x1) {
    for (let x = Math.max(0, x0 - 2); x <= Math.min(this.width - 1, x1 + 2); x++) this.flowing.add(x);
  }

  // -------------------------------------------------------------------------
  // Settling
  // -------------------------------------------------------------------------

  /**
   * Advance the settling process. Returns the dirty column range, or null
   * when nothing moved. `mode` is 'static' | 'crumble' | 'collapse'.
   */
  settle(dt, mode) {
    if (mode === 'static') {
      this.unsettled.clear();
      this.flowing.clear();
      return null;
    }
    let x0 = Infinity, x1 = -Infinity;
    const fall = TERRAIN_FALL_SPEED * dt;

    for (const x of this.unsettled) {
      const col = this.cols[x];
      let moved = false;
      // Bottom-up: a span may only fall as far as the (already moved) span
      // below it, so the lowest one is decided first.
      for (let i = col.length - 2; i >= 0; i -= 2) {
        const floor = i + 2 < col.length ? col[i + 2] : BEDROCK;
        const gap = floor - col[i + 1];
        if (gap <= EPS) continue;
        const d = Math.min(fall, gap);
        col[i] += d;
        col[i + 1] += d;
        moved = true;
      }
      if (moved) {
        this.mergeTouching(col);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (mode === 'collapse') this.markFlow(x, x);
      } else {
        this.unsettled.delete(x);
      }
    }

    if (mode === 'collapse') {
      const flow = TERRAIN_FLOW_SPEED * dt;
      // Sand rule on the surface only: a step steeper than COLLAPSE_SLOPE
      // between neighbours moves material from the taller column to the
      // shorter one until the step is gentle again. Caves underneath stay.
      for (const x of Array.from(this.flowing)) {
        let flowed = false;
        for (const nx of [x - 1, x + 1]) {
          if (nx < 0 || nx >= this.width) continue;
          const a = this.surfaceAt(x), b = this.surfaceAt(nx);
          // Smaller y is taller. Move from taller to shorter.
          const diff = b - a; // > 0 means x is taller than nx
          if (diff > COLLAPSE_SLOPE) {
            const amt = Math.min(flow, (diff - COLLAPSE_SLOPE) / 2);
            if (amt <= EPS) continue;
            this.removeInterval(x, a, a + amt);
            this.addInterval(nx, b - amt, b);
            this.flowing.add(nx);
            flowed = true;
            if (Math.min(x, nx) < x0) x0 = Math.min(x, nx);
            if (Math.max(x, nx) > x1) x1 = Math.max(x, nx);
          }
        }
        if (!flowed) this.flowing.delete(x);
      }
    } else {
      this.flowing.clear();
    }

    return x0 <= x1 ? { x0, x1 } : null;
  }

  /** Collapse spans that have landed on each other into one. */
  mergeTouching(col) {
    for (let i = 0; i + 2 < col.length;) {
      if (col[i + 2] - col[i + 1] <= EPS) {
        col.splice(i + 1, 2); // drop this bottom and the next top
      } else {
        i += 2;
      }
    }
  }

  /** True once nothing is falling or flowing. */
  isQuiet() {
    return this.unsettled.size === 0 && this.flowing.size === 0;
  }

  // -------------------------------------------------------------------------
  // Diagnostics (the smoke test leans on this)
  // -------------------------------------------------------------------------

  /** Throws if any column breaks the span invariants. */
  validate() {
    for (let x = 0; x < this.width; x++) {
      const col = this.cols[x];
      if (col.length % 2) throw new Error(`terrain: odd span list at x=${x}`);
      for (let i = 0; i < col.length; i += 2) {
        const t = col[i], b = col[i + 1];
        if (!(t < b)) throw new Error(`terrain: empty or inverted span at x=${x}: [${t}, ${b})`);
        if (b > BEDROCK + EPS) throw new Error(`terrain: span below bedrock at x=${x}: ${b}`);
        if (i + 2 < col.length && !(col[i + 2] > b - EPS)) throw new Error(`terrain: overlapping spans at x=${x}`);
      }
    }
    return true;
  }
}

/** Pick a profile id for a round: the configured one, or a seeded random. */
export function chooseProfile(rng, settingProfile) {
  const ids = Object.keys(TERRAIN_PROFILES);
  if (settingProfile && settingProfile !== 'random' && TERRAIN_PROFILES[settingProfile]) return settingProfile;
  return ids[int(rng, 0, ids.length - 1)];
}
