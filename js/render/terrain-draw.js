/*
 * terrain-draw.js — the hillside, painted once into an offscreen canvas and
 * then only ever patched.
 *
 * WHY AN OFFSCREEN CANVAS AND NOT A PATH PER FRAME
 *   terrain.cols is 1600 flat span lists. Walking all of them every frame to
 *   build a path would be the single most expensive thing in the renderer,
 *   and it would be pure waste: the ground changes only when something blows
 *   it up or when it is pouring into a hole, and world.js already tells us
 *   exactly which columns that was — `terrainChanged {x0, x1}`. So the hill
 *   lives in a 1600x900 canvas, one drawImage a frame, and markDirty() queues
 *   the column range that has to be repainted before the next one. A full
 *   repaint happens on attach and at the top of a round and nowhere else.
 *
 * WHY COLUMN STRIPS AND NOT A FILLED OUTLINE
 *   A span list is already a per-column answer. Painting column x is: clear
 *   the strip, fill each [top, bottom) piece of it, put a crust line on every
 *   span top. That is three or four fillRects per column and it handles
 *   overhangs, tunnels and floating chunks without a single special case,
 *   because it never has to work out what the *shape* is.
 *
 * WHY THE STRATA ARE A GRADIENT IN ABSOLUTE Y
 *   The fill is one vertical gradient over the whole field height, so the
 *   colour of a piece of ground depends on how deep it is and not on which
 *   column it is in. Blow a crater and the walls show the bands you cut
 *   through, which is what makes a hole read as a hole; two rust seams give
 *   the eye something to measure depth against. The crust — a light line
 *   along every surface — is what separates ground from sky at a glance, and
 *   is the single most load-bearing detail in here.
 */

import { WIDTH, HEIGHT, BEDROCK } from '../config.js';

// ARCHITECTURE.md §12, the terrain row of the shared palette.
const DEEP = '#25242a';
const BODY_DARK = '#34333b';
const BODY_MID = '#3b3a42';
const BODY_LIGHT = '#4e4b52';
const RUST = '#6e4a3a';
const CRUST = '#8b8474';
const CRUST_LINE = '#a79f8a';
const BEDROCK_FILL = '#191920';
const BEDROCK_LINE = '#2f2b35';

/** Shadow on an exposed tunnel ceiling. */
const GRAIN_DARK = '#000000';

export function createTerrainLayer() {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const c = canvas.getContext('2d');

  // A baked, mottled rock texture instead of full-height vertical grain.
  // Absolute coordinates keep the texture stable when a crater is repainted.
  const rock = document.createElement('canvas');
  rock.width = rock.height = 128;
  const rc = rock.getContext('2d');
  for (let i = 0; i < 850; i++) {
    const x = (i * 73) % 128;
    const y = (i * 37 + Math.floor(i / 11) * 17) % 128;
    rc.fillStyle = i % 3 ? '#080d1618' : '#d2c5ac12';
    rc.fillRect(x, y, 2 + i % 7, 1 + i % 3);
  }
  const rockPattern = c.createPattern(rock, 'repeat');

  const strata = c.createLinearGradient(0, 0, 0, HEIGHT);
  // Stop pairs sitting close together are seams; everything else is a slow
  // fade from pale crust rock at the top to near-black at the bottom.
  strata.addColorStop(0.0, BODY_LIGHT);
  strata.addColorStop(0.16, '#474450');
  strata.addColorStop(0.28, '#454149');
  strata.addColorStop(0.295, RUST);
  strata.addColorStop(0.325, RUST);
  strata.addColorStop(0.34, '#413e47');
  strata.addColorStop(0.52, BODY_MID);
  strata.addColorStop(0.63, '#383740');
  strata.addColorStop(0.645, RUST);
  strata.addColorStop(0.675, RUST);
  strata.addColorStop(0.69, BODY_DARK);
  strata.addColorStop(0.86, DEEP);
  strata.addColorStop(1.0, '#1d1c22');

  // Pending repaint. `full` beats any range; a range of [Infinity, -Infinity]
  // is the empty one.
  let full = true;
  let dx0 = Infinity;
  let dx1 = -Infinity;
  let lastTerrain = null;

  /** Repaint one column strip from its span list. */
  function paintColumn(terrain, x) {
    c.clearRect(x, 0, 1, HEIGHT);

    const col = terrain.cols[x];
    for (let i = 0; i < col.length; i += 2) {
      const top = col[i];
      let bot = col[i + 1];
      if (bot > BEDROCK) bot = BEDROCK;
      const h = bot - top;
      if (h <= 0) continue;

      c.fillStyle = strata;
      c.fillRect(x, top, 1, h);

      c.fillStyle = rockPattern;
      c.fillRect(x, top, 1, h);
      // A darker undercut makes the lit rim feel thick, even at small scale.
      c.fillStyle = '#10151e38';
      c.fillRect(x, top + 4, 1, Math.min(8, Math.max(0, h - 4)));

      // Every span top is a surface — there is air above it by construction —
      // so every one of them gets the crust. This is what makes a bright
      // shell read against the ground and a tunnel read as a tunnel.
      if (h > 1) {
        c.fillStyle = CRUST;
        c.fillRect(x, top, 1, Math.min(4, h));
        c.fillStyle = CRUST_LINE;
        c.fillRect(x, top, 1, 1);
      }
      // A span bottom with air under it is a ceiling: darken it so the roof
      // of a burrower's tunnel does not float.
      if (h > 3 && bot < BEDROCK - 0.5) {
        c.globalAlpha = 0.45;
        c.fillStyle = GRAIN_DARK;
        c.fillRect(x, bot - 2, 1, 2);
        c.globalAlpha = 1;
      }
    }

    // Bedrock. Spans never reach below it, so it is drawn unconditionally:
    // the floor is always there and is the one thing no weapon removes.
    c.fillStyle = BEDROCK_FILL;
    c.fillRect(x, BEDROCK, 1, HEIGHT - BEDROCK);
    c.fillStyle = BEDROCK_LINE;
    c.fillRect(x, BEDROCK, 1, 1);
  }

  return {
    canvas,

    /** Forget everything; the next sync() repaints the whole hill. */
    reset() {
      full = true;
      dx0 = Infinity;
      dx1 = -Infinity;
      lastTerrain = null;
    },

    /** Queue a column range, from a terrainChanged event. Ranges merge. */
    markDirty(x0, x1) {
      if (full) return;
      if (x0 < dx0) dx0 = x0;
      if (x1 > dx1) dx1 = x1;
    },

    /**
     * Repaint whatever is pending. Cheap and safe to call every frame: with
     * nothing queued it does nothing at all. Also notices a brand new Terrain
     * (a new round) on its own, so a missed roundStart event cannot leave the
     * last round's hill on screen.
     */
    sync(terrain) {
      if (!terrain) return;
      if (terrain !== lastTerrain) {
        lastTerrain = terrain;
        full = true;
      }
      if (full) {
        for (let x = 0; x < WIDTH; x++) paintColumn(terrain, x);
        full = false;
        dx0 = Infinity;
        dx1 = -Infinity;
        return;
      }
      if (dx0 > dx1) return;
      // One column either side: carve() rounds outward and a crust line on
      // the boundary column can be left stale otherwise.
      const a = Math.max(0, Math.floor(dx0) - 1);
      const b = Math.min(WIDTH - 1, Math.ceil(dx1) + 1);
      for (let x = a; x <= b; x++) paintColumn(terrain, x);
      dx0 = Infinity;
      dx1 = -Infinity;
    },
  };
}
