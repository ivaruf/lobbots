/*
 * sky.js — everything behind the hill: the dusk gradient, a warm band low on
 * the horizon, a band of far clouds that drift with the wind, and two ridge
 * silhouettes.
 *
 * WHY THIS IS ITS OWN LAYER AND WHY IT IS NOT SHAKEN
 *   The field is 1600x900 and always fully visible, so a window that is not
 *   16:9 gets letterbox margins. Black bars would look like a bug, so the sky
 *   is drawn across the WHOLE canvas in field coordinates — render.js hands
 *   us a `view` rectangle that already covers the margins — and the world
 *   layers are clipped to the field rect on top of it. Screen shake is a
 *   translate of the world transform only; if the sky shook with it, the
 *   translate would expose a hard edge at the top or bottom of the fill.
 *   Distant things not shaking also happens to be what distance looks like.
 *
 * WHY THE WIND IS IN THE AIR
 *   The HUD prints the wind as a number, and a number is something a player
 *   reads once and forgets. Clouds that drift in its direction, and lean into
 *   it, mean the player can feel which way the shot will bend without looking
 *   away from the hill. effects.js adds the faint streaks that cross the sky
 *   at wind speed; between the two, the air is never still by accident.
 *
 * Everything repeated is pre-baked: four cloud blobs and the whole ridge band
 * are offscreen canvases, rebuilt only on resize. The per-frame cost here is
 * two fills, twenty-four drawImages and one more.
 */

import { WIDTH, HEIGHT } from '../config.js';

// ARCHITECTURE.md §12, the sky row of the shared palette.
const SKY_TOP = '#0f1626';
const SKY_MID = '#2c3a62';
const SKY_HORIZON = '#7a6a8f';
const WARM_RGB = '201, 138, 106'; // #c98a6a, kept as parts so the band can fade

const RIDGE_FAR = '#3f4064';
const RIDGE_NEAR = '#2c2e46';

/** Where the ground colour of the sky takes over. Field px, y down. */
const HORIZON_Y = HEIGHT * 0.66;

/** The ridge band sits behind where the hills usually are. */
const RIDGE_TOP = 420;
const RIDGE_H = 300;

const CLOUD_COUNT = 24;
const CLOUD_SPRITES = 4;
const CLOUD_SPRITE_W = 240;
const CLOUD_SPRITE_H = 90;

/** Clouds drift at wind * this, in px/s per px/s² of wind. Tuned so the
 *  strongest wind (90) is an unmistakable but unhurried crawl. */
const CLOUD_DRIFT = 0.34;

export function createSky() {
  // --- cloud sprites: soft blobs, baked once, tinted by alpha at draw time --
  const sprites = [];
  for (let i = 0; i < CLOUD_SPRITES; i++) sprites.push(bakeCloud(i));

  // --- the cloud field ------------------------------------------------------
  // `u` is a normalised position across the drift domain, so a resize that
  // widens the view moves clouds apart instead of teleporting them.
  const clouds = new Array(CLOUD_COUNT);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const far = i < CLOUD_COUNT * 0.55;
    clouds[i] = {
      u: Math.random(),
      y: far
        ? HORIZON_Y - 180 + Math.random() * 120
        : HORIZON_Y - 300 + Math.random() * 150,
      // Far clouds are smaller, fainter and slower: that is the parallax.
      scale: far ? 0.5 + Math.random() * 0.35 : 0.85 + Math.random() * 0.7,
      alpha: far ? 0.1 + Math.random() * 0.07 : 0.16 + Math.random() * 0.12,
      layer: far ? 0.35 + Math.random() * 0.2 : 0.75 + Math.random() * 0.45,
      sprite: sprites[(Math.random() * CLOUD_SPRITES) | 0],
    };
  }

  // --- ridge silhouettes ----------------------------------------------------
  // Two lattices sampled with cosine interpolation, same trick terrain.js
  // uses. Generated ONCE so the skyline does not change shape when the window
  // is resized; only the bake that samples them is redone.
  const DOM_X0 = -WIDTH;
  const DOM_SPAN = WIDTH * 3;
  const far = { coarse: lattice(14), fine: lattice(37), amp: 74, base: 118, col: RIDGE_FAR, alpha: 0.5 };
  const near = { coarse: lattice(11), fine: lattice(29), amp: 92, base: 196, col: RIDGE_NEAR, alpha: 0.85 };

  let ridgeCanvas = null;
  let ridgeX0 = 0;
  let ridgeW = 0;

  // Gradients are in field coordinates, which never change, so they are built
  // once. They are cached against the context that made them because a
  // CanvasGradient belongs to its context.
  let gradCtx = null;
  let skyGrad = null;
  let warmGrad = null;

  function buildGradients(ctx) {
    skyGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    skyGrad.addColorStop(0, SKY_TOP);
    skyGrad.addColorStop(0.46, SKY_MID);
    skyGrad.addColorStop(0.82, SKY_HORIZON);
    skyGrad.addColorStop(1, SKY_HORIZON);
    // A separate band rather than a stop, so it can be faint and wide without
    // dragging the whole gradient warm.
    warmGrad = ctx.createLinearGradient(0, HEIGHT * 0.58, 0, HEIGHT * 0.95);
    warmGrad.addColorStop(0, `rgba(${WARM_RGB}, 0)`);
    warmGrad.addColorStop(0.55, `rgba(${WARM_RGB}, 0.34)`);
    warmGrad.addColorStop(1, `rgba(${WARM_RGB}, 0)`);
    gradCtx = ctx;
  }

  function bakeRidges(view) {
    const x0 = Math.floor(view.x0) - 2;
    const w = Math.min(4600, Math.max(WIDTH, Math.ceil(view.x1 - view.x0) + 4));
    if (ridgeCanvas && ridgeX0 === x0 && ridgeW === w) return;
    ridgeX0 = x0;
    ridgeW = w;
    if (!ridgeCanvas) ridgeCanvas = document.createElement('canvas');
    ridgeCanvas.width = w;
    ridgeCanvas.height = RIDGE_H;
    const c = ridgeCanvas.getContext('2d');
    c.clearRect(0, 0, w, RIDGE_H);
    for (const layer of [far, near]) {
      c.globalAlpha = layer.alpha;
      c.fillStyle = layer.col;
      c.beginPath();
      c.moveTo(0, RIDGE_H);
      // 6 px steps: at this scale the silhouette is smooth and the bake is
      // under a thousand segments.
      for (let px = 0; px <= w; px += 6) {
        const wx = x0 + px;
        const n =
          sample(layer.coarse, wx, DOM_X0, DOM_SPAN) * 0.72 +
          sample(layer.fine, wx, DOM_X0, DOM_SPAN) * 0.28;
        c.lineTo(px, layer.base - n * layer.amp);
      }
      c.lineTo(w, RIDGE_H);
      c.closePath();
      c.fill();
    }
    c.globalAlpha = 1;
  }

  return {
    /** Rebake anything that depends on how much of the world is on screen. */
    setView(view) {
      bakeRidges(view);
    },

    /**
     * One frame of background. `view` is the canvas rect in field coords,
     * `wind` the world's px/s² (0 when the setting turns it off), `dt` real
     * seconds. Draws in field coordinates with no shake applied.
     */
    draw(ctx, view, wind, dt) {
      if (gradCtx !== ctx) buildGradients(ctx);
      const vw = view.x1 - view.x0;
      const vh = view.y1 - view.y0;

      ctx.fillStyle = skyGrad;
      ctx.fillRect(view.x0, view.y0, vw, vh);
      ctx.fillStyle = warmGrad;
      ctx.fillRect(view.x0, view.y0, vw, vh);

      // Clouds. The drift domain is the view plus a sprite's width either
      // side, so one never pops in at the edge.
      const domX0 = view.x0 - CLOUD_SPRITE_W;
      const domW = vw + CLOUD_SPRITE_W * 2;
      // Lean: the top of the cloud is dragged ahead of its base. Capped so a
      // gale does not turn the sky into italics.
      const lean = Math.max(-0.42, Math.min(0.42, wind * 0.005));
      for (let i = 0; i < CLOUD_COUNT; i++) {
        const c = clouds[i];
        c.u += (wind * CLOUD_DRIFT * c.layer * dt) / domW;
        if (c.u >= 1) c.u -= Math.floor(c.u);
        else if (c.u < 0) c.u += Math.ceil(-c.u);
        const x = domX0 + c.u * domW;
        const w = CLOUD_SPRITE_W * c.scale;
        const h = CLOUD_SPRITE_H * c.scale;
        ctx.save();
        ctx.translate(x, c.y);
        // Shear about the cloud's own base: x' = x + lean * -y.
        ctx.transform(1, 0, -lean, 1, 0, 0);
        ctx.globalAlpha = c.alpha;
        ctx.drawImage(c.sprite, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      if (ridgeCanvas) ctx.drawImage(ridgeCanvas, ridgeX0, RIDGE_TOP);
    },
  };
}

// ---------------------------------------------------------------------------
// Bakery
// ---------------------------------------------------------------------------

/** A soft cumulus blob: overlapping radial gradients on a transparent sheet. */
function bakeCloud(seed) {
  const cv = document.createElement('canvas');
  cv.width = CLOUD_SPRITE_W;
  cv.height = CLOUD_SPRITE_H;
  const c = cv.getContext('2d');
  const lobes = 5 + ((seed * 3) % 3);
  for (let i = 0; i < lobes; i++) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1);
    const x = CLOUD_SPRITE_W * (0.16 + t * 0.68) + (Math.random() - 0.5) * 18;
    // A cloud base is flatter than its top, so lobes sit low and rise in the
    // middle. Without this they read as a string of bubbles.
    const rise = Math.sin(t * Math.PI);
    const y = CLOUD_SPRITE_H * (0.66 - rise * 0.24);
    const r = CLOUD_SPRITE_H * (0.26 + rise * 0.24) * (0.8 + Math.random() * 0.4);
    const g = c.createRadialGradient(x, y, r * 0.15, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.55, 'rgba(240,240,255,0.5)');
    g.addColorStop(1, 'rgba(230,235,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

/** n random values in [-1, 1], the control points of one noise octave. */
function lattice(n) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

/** Cosine-interpolated value noise, clamped at the ends of the domain. */
function sample(lat, x, x0, span) {
  let f = ((x - x0) / span) * (lat.length - 1);
  if (f < 0) f = 0;
  const top = lat.length - 2;
  let i = Math.floor(f);
  if (i > top) i = top;
  const t = f - i;
  const s = (1 - Math.cos(t * Math.PI)) * 0.5;
  return lat[i] * (1 - s) + lat[i + 1] * s;
}
