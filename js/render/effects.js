/*
 * effects.js — particles, flash rings, wind streaks and the screen shake.
 *
 * THE POOL IS THE WHOLE DESIGN
 *   A nuke asks for around forty particles in one frame and the ground can be
 *   pouring dust for several seconds after it. Making objects for those would
 *   hand the garbage collector a hitch in the middle of exactly the moment the
 *   player is watching. So every particle that will ever exist is built once,
 *   at startup, and emitters only ever write fields into a slot that already
 *   exists. The cursor wraps: when the pool is full the oldest slot is
 *   reused, which is the honest trade — the alternative is either an
 *   allocation or a dropped effect, and one stolen smoke puff is invisible.
 *
 * SMOKE IS DELIBERATELY THIN AND SHORT-LIVED
 *   Readability beats spectacle (hub §, and the brief). A player has to be
 *   able to read where every mech is and what hill is between them at all
 *   times, so smoke fades fast and never goes above a modest alpha. If you
 *   are tempted to turn it up, turn the count up instead and the alpha down.
 *
 * WIND IS DRAWN, NOT JUST PRINTED
 *   The HUD has the number. The streaks crossing the sky move at a speed and
 *   a direction taken straight from world.wind, so a glance at the air tells
 *   you which way the shot will bend. They are drawn BEHIND the terrain (see
 *   drawSky) so the hill occludes them and they never clutter the ground.
 *
 * SHAKE is amplitude-decaying and capped, and it is off entirely when
 * settings.shake is false — some people get motion sick, and Classic turns it
 * off on purpose.
 *
 * BIG THINGS ARE ALLOWED TO BE BIG, BRIEFLY
 *   The Nuke's own description promises it is "visually unreasonable", so it
 *   gets what nothing else does: a white-out over the whole field, a
 *   shockwave ring that crosses most of the screen, and a mushroom cloud that
 *   climbs and drifts with the wind. All three are short and all three fade,
 *   because the rule above still holds — a few seconds later the player must
 *   be able to see who is left. The flash is held to a soft tint under
 *   prefers-reduced-motion (setCalm), where a full white frame is exactly the
 *   thing that should not happen. Mushrooms are their own tiny preallocated
 *   pool (they are one shape, not a cloud of particles), so a nuke chain
 *   reaction cannot starve the smoke pool.
 *
 * DEATH BLASTS: a wreck cooking off throws hull plating in its own team
 * colour on top of whatever explosion it rolled, so a chain reaction reads
 * as "Ember's machine went up" and not just another crater.
 */

const TAU = Math.PI * 2;

const K_SMOKE = 0;
const K_DEBRIS = 1;
const K_SPARK = 2;
const K_DIRT = 3;
const K_FLAME = 4;

const POOL = 1400;
const RINGS = 32;
const STREAKS = 18;

// Palettes as fixed strings: assigning a reference allocates nothing, while
// building an 'rgba(...)' every frame would allocate per particle per frame.
const SMOKE_COLS = ['#7a7d86', '#63676f', '#8b8474'];
const DIRT_COLS = ['#6e5a45', '#5a4a3a', '#8b8474', '#4a3d31'];
const DEBRIS_COLS = ['#2b2a31', '#3b3a42', '#25242a'];
const SPARK_COLS = ['#ffd27a', '#fff0c8', '#ffb347'];
const FLASH_CORE = '#ffe9b0';
const FLASH_RING = '#ffc46a';
const MOUND_RING = '#9b8466';
const STREAK_COL = '#cfd8ee';
const FLAME_HOT = '#fff1a8';
const FLAME_MID = '#ffa23a';
const FLAME_COOL = '#b8502e';
const SHOCK_COL = '#fff6dc';
const MUSH_SMOKE = ['#8a7f7a', '#6f6866', '#9b8f86'];
const MUSH_HOT = '#ffb35c';
const HULL_COLS = ['#2b2a31', '#5b6474', '#9aafbf'];

/** Mushroom clouds alive at once, and the puffs that make each cap. */
const MUSHES = 3;
const MUSH_PUFFS = 16;
const MUSH_STEM = 16;
const MUSH_LIFE = 4.6;

/** Shake never exceeds this many field px, whatever goes off. */
const SHAKE_CAP = 15;

export function createEffects() {
  const pool = new Array(POOL);
  for (let i = 0; i < POOL; i++) {
    pool[i] = {
      live: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0,
      life: 0, max: 1, size: 1, grow: 0, rot: 0, spin: 0,
      g: 0, drag: 0, wind: 0, alpha: 1, col: '#fff',
    };
  }
  let cursor = 0;

  const rings = new Array(RINGS);
  for (let i = 0; i < RINGS; i++) {
    rings[i] = { live: false, x: 0, y: 0, r0: 0, r1: 0, t: 0, dur: 1, lw: 3, core: 0, ring: FLASH_RING, coreCol: FLASH_CORE };
  }
  let ringCursor = 0;

  const streaks = new Array(STREAKS);
  for (let i = 0; i < STREAKS; i++) {
    // `k` is a per-streak speed variation so the air is not a marching band.
    streaks[i] = { x: 0, y: 0, len: 10, speed: 0, k: 0.75 + Math.random() * 0.5, alpha: 0.1 };
  }

  // Mushroom clouds: position, age, drift, and each cap puff's unit offset
  // and radius, rolled once at spawn so the shape holds still as it rises.
  const mushes = new Array(MUSHES);
  for (let i = 0; i < MUSHES; i++) {
    mushes[i] = { live: false, x: 0, y: 0, t: 0, drift: 0, scale: 1, puffs: new Float32Array(MUSH_PUFFS * 3) };
  }
  let mushCursor = 0;

  // The white-out, field-wide; 0 when nothing is flashing.
  let flash = 0;
  let calm = false;

  // The view rectangle the streaks live in; render.js keeps it current.
  const bounds = { x0: 0, y0: 0, x1: 1600, y1: 560 };
  let boundsSet = false;

  /** Public, preallocated: render.js reads shake.x / shake.y every frame. */
  const shake = { x: 0, y: 0 };
  let shakeAmp = 0;
  let shakeT = 0;
  let shakeOn = true;

  /** Throttle for the dust that settling ground kicks up. */
  let dustClock = 0;

  function take() {
    // Round-robin. Deliberately not a free-list scan: this is O(1) and the
    // pool is big enough that reusing a live slot is a rounding error.
    const p = pool[cursor];
    cursor = (cursor + 1) % POOL;
    p.live = true;
    p.grow = 0;
    p.rot = 0;
    p.spin = 0;
    p.drag = 0;
    return p;
  }

  function smoke(x, y, vx, vy, size, life, alpha) {
    const p = take();
    p.kind = K_SMOKE;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    // Capped: a nuke's radius is 150 and a puff scaled honestly off that
    // would be a wall. More, smaller puffs read as a cloud; one enormous one
    // reads as a bug and hides whoever was standing there.
    p.size = size > 24 ? 24 : size;
    p.grow = p.size * 0.9;
    p.life = life; p.max = life;
    p.g = -14;            // hot gas rises, gently
    p.drag = 0.9;
    p.wind = 0.9;         // smoke is the thing the wind pushes most
    p.alpha = alpha;
    p.col = SMOKE_COLS[(Math.random() * SMOKE_COLS.length) | 0];
  }

  function chunk(x, y, vx, vy, size, life, cols, wind) {
    const p = take();
    p.kind = cols === DIRT_COLS ? K_DIRT : K_DEBRIS;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.size = size;
    p.life = life; p.max = life;
    p.g = 900;            // debris arcs; it is the only thing here that does
    p.drag = 0.08;
    p.wind = wind;
    p.rot = Math.random() * TAU;
    p.spin = (Math.random() * 2 - 1) * 9;
    p.alpha = 1;
    p.col = cols[(Math.random() * cols.length) | 0];
  }

  function spark(x, y, vx, vy, life) {
    const p = take();
    p.kind = K_SPARK;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.size = 1.4 + Math.random() * 1.4;
    p.life = life; p.max = life;
    p.g = 620;
    p.drag = 0.5;
    p.wind = 0.2;
    p.alpha = 1;
    p.col = SPARK_COLS[(Math.random() * SPARK_COLS.length) | 0];
  }

  function flame(x, y, vx, vy, size, life) {
    const p = take();
    p.kind = K_FLAME;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.size = size;
    p.grow = -size * 0.6;   // licks shrink as they burn out
    p.life = life; p.max = life;
    p.g = -90;              // flame climbs
    p.drag = 1.6;
    p.wind = 0.6;
    p.alpha = 0.9;
    p.col = FLAME_HOT;
  }

  function mushroom(x, y, scale) {
    const m = mushes[mushCursor];
    mushCursor = (mushCursor + 1) % MUSHES;
    m.live = true;
    m.x = x; m.y = y; m.t = 0; m.drift = 0; m.scale = scale;
    const pf = m.puffs;
    for (let i = 0; i < MUSH_PUFFS; i++) {
      // A flattened dome: wider than tall, heavier at the rim.
      const a = Math.PI + (i / (MUSH_PUFFS - 1)) * Math.PI;
      const rr = 0.55 + Math.random() * 0.45;
      pf[i * 3] = Math.cos(a) * rr * 1.25;
      pf[i * 3 + 1] = Math.sin(a) * rr * 0.55 + 0.1;
      pf[i * 3 + 2] = 0.32 + Math.random() * 0.22;
    }
  }

  function ring(x, y, r0, r1, dur, lw, core, ringCol, coreCol) {
    const r = rings[ringCursor];
    ringCursor = (ringCursor + 1) % RINGS;
    r.live = true;
    r.x = x; r.y = y; r.r0 = r0; r.r1 = r1;
    r.t = 0; r.dur = dur; r.lw = lw; r.core = core;
    r.ring = ringCol; r.coreCol = coreCol;
  }

  /**
   * Put a streak back in play. `dir` decides which edge it enters from;
   * `fromEdge` false scatters it across the view, which is what the first
   * frame wants so the sky is not empty for two seconds.
   */
  function respawnStreak(s, dir, fromEdge) {
    const w = bounds.x1 - bounds.x0;
    const skyBottom = Math.min(bounds.y1, 560);
    s.y = bounds.y0 + Math.random() * Math.max(40, skyBottom - bounds.y0);
    s.alpha = 0.05 + Math.random() * 0.07;
    if (!fromEdge) s.x = bounds.x0 + Math.random() * w;
    else s.x = dir > 0 ? bounds.x0 - 50 : bounds.x1 + 50;
  }

  return {
    shake,

    /** Field rect currently on screen; streaks respawn against it. */
    setBounds(view) {
      bounds.x0 = view.x0;
      bounds.y0 = view.y0;
      bounds.x1 = view.x1;
      bounds.y1 = view.y1;
      if (!boundsSet) {
        boundsSet = true;
        for (const s of streaks) respawnStreak(s, 1, false);
      }
    },

    /** Reduced motion: no full white frame, ever. render.js keeps it current. */
    setCalm(on) { calm = !!on; },

    setShake(on) {
      shakeOn = !!on;
      if (!on) { shakeAmp = 0; shake.x = 0; shake.y = 0; }
    },

    /** Everything gone: a new round, or a new match. */
    reset() {
      for (let i = 0; i < POOL; i++) pool[i].live = false;
      for (let i = 0; i < RINGS; i++) rings[i].live = false;
      for (let i = 0; i < MUSHES; i++) mushes[i].live = false;
      flash = 0;
      shakeAmp = 0;
      shake.x = 0;
      shake.y = 0;
      dustClock = 0;
    },

    // ---- emitters --------------------------------------------------------

    /**
     * A blast. `radius` is the weapon's, `strength` its 0..1 shake weight,
     * `mound` true for a dirt bomb, which throws earth instead of fire.
     * `weaponId` picks the extras: flame licks for fuel, the full works for
     * the Nuke.
     */
    explosion(x, y, radius, strength, mound, weaponId) {
      const r = Math.max(6, radius);
      if (mound) {
        // Dirt bomb: a dull brown ring, a fat splat of earth, no flash. The
        // player must be able to tell at a glance that nothing was damaged.
        ring(x, y, r * 0.3, r * 1.1, 0.34, 3, 0, MOUND_RING, MOUND_RING);
        const n = Math.min(26, 10 + (r * 0.3) | 0);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI - Math.PI; // upper half only
          const sp = r * (1.6 + Math.random() * 2.4);
          chunk(x, y, Math.cos(a) * sp, Math.sin(a) * sp * 0.9, 2 + Math.random() * 3.5, 0.5 + Math.random() * 0.6, DIRT_COLS, 0.2);
        }
        for (let i = 0; i < 8; i++) {
          smoke(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r * 0.6,
            (Math.random() - 0.5) * 40, -20 - Math.random() * 40,
            r * 0.22, 0.45 + Math.random() * 0.4, 0.2);
        }
        addShake(strength * 0.6);
        return;
      }

      ring(x, y, r * 0.25, r * 1.25, 0.18 + r * 0.0018, 3 + r * 0.05, r * 0.55, FLASH_RING, FLASH_CORE);

      const smokeN = Math.min(34, 6 + ((r * 0.3) | 0));
      for (let i = 0; i < smokeN; i++) {
        const a = Math.random() * TAU;
        const sp = r * (0.5 + Math.random() * 1.4);
        smoke(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3,
          Math.cos(a) * sp, Math.sin(a) * sp * 0.7,
          r * (0.16 + Math.random() * 0.14),
          0.5 + Math.random() * 0.6,
          0.2 + Math.random() * 0.08);
      }

      // Debris scales with the hole; the cap rises for the really big ones
      // so a Mega reads heavier than a Heavy, and a Nuke heavier still.
      const debrisN = Math.min(r > 100 ? 34 : 22, 4 + ((r * 0.22) | 0));
      for (let i = 0; i < debrisN; i++) {
        const a = -Math.PI * (0.15 + Math.random() * 0.7); // thrown upward
        const sp = r * (2.2 + Math.random() * 3.2);
        chunk(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 1.8 + Math.random() * 3, 0.8 + Math.random() * 0.7, DEBRIS_COLS, 0.08);
      }

      const sparkN = Math.min(20, 6 + ((r * 0.14) | 0));
      for (let i = 0; i < sparkN; i++) {
        const a = Math.random() * TAU;
        const sp = r * (3 + Math.random() * 4);
        spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.22 + Math.random() * 0.22);
      }

      if (weaponId === 'fire' || weaponId === 'napalm') {
        // Burning fuel: licks that climb and lean with the wind, and a few
        // slower ones that sit on the ground a moment, so a napalm splash
        // looks like it is still burning after the bangs.
        const n = weaponId === 'napalm' ? 14 : 7;
        for (let i = 0; i < n; i++) {
          flame(x + (Math.random() - 0.5) * r * 1.2, y - Math.random() * 4,
            (Math.random() - 0.5) * 70, -40 - Math.random() * 90,
            3 + Math.random() * 4, 0.35 + Math.random() * 0.5);
        }
        for (let i = 0; i < 4; i++) {
          flame(x + (Math.random() - 0.5) * r, y - 1, (Math.random() - 0.5) * 12, -8,
            2.5 + Math.random() * 2, 0.9 + Math.random() * 0.6);
        }
      } else if (weaponId === 'volcano' || weaponId === 'lava-rock') {
        for (let i = 0; i < 5; i++) {
          flame(x + (Math.random() - 0.5) * r * 0.6, y, (Math.random() - 0.5) * 50, -60 - Math.random() * 60,
            2.5 + Math.random() * 2.5, 0.3 + Math.random() * 0.3);
        }
      }

      if (weaponId === 'nuke') {
        // The works. White-out, a shockwave across most of the field, a
        // second warm ring behind it, a fireball, and the mushroom.
        flash = 1;
        ring(x, y, r * 0.3, r * 3.8, 1.25, 7, 0, SHOCK_COL, SHOCK_COL);
        ring(x, y, r * 0.2, r * 2.2, 0.9, 10, r * 0.9, FLASH_RING, FLASH_CORE);
        mushroom(x, y, r / 150);
        for (let i = 0; i < 18; i++) {
          const a = -Math.PI * Math.random();
          const sp = r * (0.8 + Math.random() * 1.6);
          flame(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.2,
            Math.cos(a) * sp, Math.sin(a) * sp * 0.8, 6 + Math.random() * 6, 0.5 + Math.random() * 0.5);
        }
      } else if (r >= 56) {
        // Mega and friends: a second, wider pressure ring.
        ring(x, y, r * 0.5, r * 2, 0.5, 3, 0, SHOCK_COL, SHOCK_COL);
      }

      addShake(strength);
    },

    /**
     * A wreck cooking off: plating in the dead mech's colour flung wide, plus
     * a hot ring. Drawn on top of the explosion the death blast rolled.
     */
    deathBlast(x, y, hex) {
      ring(x, y - 14, 10, 90, 0.5, 5, 26, FLASH_RING, FLASH_CORE);
      for (let i = 0; i < 16; i++) {
        const a = -Math.PI * (0.05 + Math.random() * 0.9);
        const sp = 180 + Math.random() * 360;
        const p = take();
        p.kind = K_DEBRIS;
        p.x = x; p.y = y - 16; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
        p.size = 2.5 + Math.random() * 4;
        p.life = 1 + Math.random() * 0.9; p.max = p.life;
        p.g = 900; p.drag = 0.08; p.wind = 0.08;
        p.rot = Math.random() * TAU;
        p.spin = (Math.random() * 2 - 1) * 12;
        p.alpha = 1;
        p.col = i % 3 === 0 ? HULL_COLS[(Math.random() * HULL_COLS.length) | 0] : hex;
      }
      for (let i = 0; i < 6; i++) {
        flame(x + (Math.random() - 0.5) * 20, y - 14, (Math.random() - 0.5) * 80, -60 - Math.random() * 80,
          4 + Math.random() * 4, 0.4 + Math.random() * 0.4);
      }
      addShake(0.3);
    },

    /** A wreck's dead wiring arcing now and then. */
    wreckSpark(x, y) {
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI * (0.15 + Math.random() * 0.7);
        const sp = 50 + Math.random() * 120;
        spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.15 + Math.random() * 0.2);
      }
    },

    /**
     * A wreck about to blow: sparks spat from the hole, more as `k` (0..1,
     * how close it is) climbs. Gated on dt, so frame-rate free.
     */
    cookOff(x, y, k, dt) {
      if (Math.random() > dt * (6 + k * 40)) return;
      const a = -Math.PI * (0.1 + Math.random() * 0.8);
      const sp = 80 + Math.random() * (160 + k * 240);
      spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.2 + Math.random() * 0.25);
      if (k > 0.5 && Math.random() < 0.3) {
        flame(x + (Math.random() - 0.5) * 6, y, (Math.random() - 0.5) * 20, -50, 2.5 + k * 2, 0.3);
      }
    },

    /** A footfall on the march: a little scuff of dust behind the foot. */
    footDust(x, y, dir) {
      smoke(x - dir * 3, y - 1, -dir * (20 + Math.random() * 30), -10 - Math.random() * 16,
        2.6 + Math.random() * 1.6, 0.35 + Math.random() * 0.2, 0.14);
    },

    /** The muzzle: a short cone of fire where the shell left the barrel. */
    muzzle(x, y, angleDeg) {
      const a = angleDeg * (Math.PI / 180);
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      ring(x + dx * 4, y + dy * 4, 3, 16, 0.14, 2.5, 7, FLASH_RING, FLASH_CORE);
      for (let i = 0; i < 9; i++) {
        const spread = (Math.random() - 0.5) * 0.7;
        const c = Math.cos(a + spread);
        const s = -Math.sin(a + spread);
        const sp = 120 + Math.random() * 220;
        spark(x + dx * 6, y + dy * 6, c * sp, s * sp, 0.14 + Math.random() * 0.16);
      }
      for (let i = 0; i < 3; i++) {
        smoke(x + dx * 8, y + dy * 8, dx * 60 + (Math.random() - 0.5) * 40, dy * 60 - 20, 4, 0.5, 0.16);
      }
      addShake(0.08);
    },

    /** A bouncer or a roller touching down: a scuff of sparks and dust. */
    bounce(x, y) {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI * (0.2 + Math.random() * 0.6);
        const sp = 60 + Math.random() * 160;
        spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.16 + Math.random() * 0.14);
      }
      smoke(x, y - 2, (Math.random() - 0.5) * 30, -30, 4, 0.35, 0.14);
    },

    /** A MIRV opening: one clean puff so the split is legible. */
    split(x, y, count) {
      ring(x, y, 4, 26, 0.3, 2, 6, '#dfe6f5', '#ffffff');
      const n = Math.min(10, count + 4);
      for (let i = 0; i < n; i++) {
        smoke(x, y, (Math.random() - 0.5) * 140, (Math.random() - 0.5) * 90, 3.5, 0.4, 0.18);
      }
    },

    /** A mech going up: black smoke, a hot core, scrap in every direction. */
    died(x, y) {
      ring(x, y - 16, 8, 70, 0.4, 4, 22, FLASH_RING, FLASH_CORE);
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * TAU;
        const sp = 40 + Math.random() * 190;
        smoke(x, y - 18, Math.cos(a) * sp, Math.sin(a) * sp * 0.8, 7 + Math.random() * 7, 0.7 + Math.random() * 0.7, 0.24);
      }
      for (let i = 0; i < 14; i++) {
        const a = -Math.PI * (0.1 + Math.random() * 0.8);
        const sp = 140 + Math.random() * 320;
        chunk(x, y - 14, Math.cos(a) * sp, Math.sin(a) * sp, 2 + Math.random() * 3.5, 0.9 + Math.random() * 0.8, DEBRIS_COLS, 0.1);
      }
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * TAU;
        const sp = 120 + Math.random() * 260;
        spark(x, y - 16, Math.cos(a) * sp, Math.sin(a) * sp, 0.25 + Math.random() * 0.3);
      }
      addShake(0.5);
    },

    /** A shell that hit armour: a brief spatter, no crater of its own. */
    hit(x, y) {
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * TAU;
        const sp = 70 + Math.random() * 180;
        spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.18 + Math.random() * 0.16);
      }
    },

    /** A shield eating a hit: a cold ring, obviously not a normal blast. */
    shield(x, y) {
      ring(x, y, 16, 34, 0.32, 3, 0, '#9fd8ff', '#ffffff');
    },

    /** A mech landing after a fall. Dust at the feet, scaled by the drop. */
    landed(x, y, drop) {
      const k = Math.min(1, drop / 200);
      for (let i = 0; i < 4 + ((k * 8) | 0); i++) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        smoke(x + dir * (6 + Math.random() * 14), y - 2,
          dir * (40 + Math.random() * 90), -20 - Math.random() * 40,
          4 + k * 6, 0.4 + Math.random() * 0.3, 0.16);
      }
      addShake(0.12 * k);
    },

    /**
     * Ground pouring into a hole. Called with the dirty range every frame it
     * moves, so it has to be throttled here rather than by the caller.
     */
    settling(x0, x1, y, dt) {
      dustClock -= dt;
      if (dustClock > 0) return;
      dustClock = 0.06;
      const x = x0 + Math.random() * Math.max(1, x1 - x0);
      smoke(x, y, (Math.random() - 0.5) * 24, 10 + Math.random() * 30, 3.5, 0.35, 0.13);
    },

    /** A wreck smouldering. Gated on dt so the column is frame-rate free. */
    wreckSmoke(x, y, dt) {
      if (Math.random() > dt * 9) return;
      smoke(x + (Math.random() - 0.5) * 10, y - 18,
        (Math.random() - 0.5) * 12, -26 - Math.random() * 22,
        3.5 + Math.random() * 3, 1.1 + Math.random() * 0.7, 0.2);
    },

    // ---- per-frame -------------------------------------------------------

    update(dt, wind) {
      // Shake: amplitude decays exponentially, the offset is two
      // incommensurate sines so it never looks like a loop.
      if (shakeAmp > 0.01) {
        shakeAmp *= Math.pow(0.0012, dt);
        shakeT += dt;
        if (shakeOn) {
          shake.x = shakeAmp * Math.sin(shakeT * 61.7);
          shake.y = shakeAmp * Math.sin(shakeT * 47.3) * 0.7;
        }
      } else {
        shakeAmp = 0;
        shake.x = 0;
        shake.y = 0;
      }

      for (let i = 0; i < POOL; i++) {
        const p = pool[i];
        if (!p.live) continue;
        p.life -= dt;
        if (p.life <= 0) { p.live = false; continue; }
        // Wind is an acceleration in the sim, so applying it as one here is
        // not a fudge: the smoke really is in the same air as the shell.
        if (p.wind) p.vx += wind * p.wind * dt;
        p.vy += p.g * dt;
        if (p.drag) {
          const k = 1 - p.drag * dt;
          p.vx *= k;
          p.vy *= k;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.spin) p.rot += p.spin * dt;
        if (p.grow) p.size += p.grow * dt;
      }

      for (let i = 0; i < RINGS; i++) {
        const r = rings[i];
        if (!r.live) continue;
        r.t += dt;
        if (r.t >= r.dur) r.live = false;
      }

      for (let i = 0; i < MUSHES; i++) {
        const m = mushes[i];
        if (!m.live) continue;
        m.t += dt;
        // The cloud is high and slow; the wind moves it, gently and late.
        m.drift += wind * 0.35 * Math.min(1, m.t / 1.5) * dt;
        if (m.t >= MUSH_LIFE) m.live = false;
      }

      if (flash > 0) {
        flash -= dt / 0.7;
        if (flash < 0) flash = 0;
      }

      // Streaks. Speed eases toward the current wind rather than snapping to
      // it, so a wind change per turn reads as the air turning round.
      if (wind !== 0) {
        for (let i = 0; i < STREAKS; i++) {
          const s = streaks[i];
          const want = wind * 4.2 * s.k;
          s.speed += (want - s.speed) * Math.min(1, dt * 1.5);
          s.x += s.speed * dt;
          // A fast streak is a longer smear; a slow one is nearly a dot.
          const mag = Math.abs(s.speed) * 0.1;
          s.len = mag < 6 ? 6 : mag > 44 ? 44 : mag;
          if (s.x < bounds.x0 - 80 || s.x > bounds.x1 + 80) respawnStreak(s, s.speed, true);
        }
      }
    },

    /**
     * The sky half: wind streaks only. render.js calls this before the
     * terrain so the hill hides them, which is why it is a separate pass.
     */
    drawSky(ctx, wind) {
      if (!wind) return;
      ctx.fillStyle = STREAK_COL;
      for (let i = 0; i < STREAKS; i++) {
        const s = streaks[i];
        ctx.globalAlpha = s.alpha;
        const x = s.speed > 0 ? s.x - s.len : s.x;
        ctx.fillRect(x, s.y, s.len, 1.2);
      }
      ctx.globalAlpha = 1;
    },

    /** Everything else, over the world. */
    draw(ctx) {
      for (let i = 0; i < POOL; i++) {
        const p = pool[i];
        if (!p.live) continue;
        const k = p.life / p.max;
        switch (p.kind) {
          case K_SMOKE:
            // Fade out on a curve that spends most of its life already thin:
            // smoke must never be what hides a mech.
            ctx.globalAlpha = p.alpha * k * k;
            ctx.fillStyle = p.col;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, TAU);
            ctx.fill();
            break;
          case K_FLAME:
            // White-yellow when fresh, orange, then a dull red as it dies.
            // Fades as it cools: a spent lick must not hang about as a red dot.
            ctx.globalAlpha = p.alpha * (k > 0.5 ? 1 : k * 2);
            ctx.fillStyle = k > 0.66 ? FLAME_HOT : k > 0.33 ? FLAME_MID : FLAME_COOL;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size > 0.4 ? p.size : 0.4, 0, TAU);
            ctx.fill();
            break;
          case K_SPARK:
            ctx.globalAlpha = k;
            ctx.fillStyle = p.col;
            ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
            break;
          default: {
            // Debris and dirt: small rotating slabs, which read as chunks
            // where a circle would read as another puff of smoke.
            ctx.globalAlpha = k > 0.25 ? 1 : k * 4;
            ctx.fillStyle = p.col;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.8);
            ctx.restore();
            break;
          }
        }
      }
      ctx.globalAlpha = 1;

      for (let i = 0; i < RINGS; i++) {
        const r = rings[i];
        if (!r.live) continue;
        const k = r.t / r.dur;
        const ease = 1 - (1 - k) * (1 - k);
        const rad = r.r0 + (r.r1 - r.r0) * ease;
        ctx.globalAlpha = (1 - k) * 0.85;
        ctx.strokeStyle = r.ring;
        ctx.lineWidth = Math.max(1, r.lw * (1 - k * 0.7));
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, TAU);
        ctx.stroke();
        if (r.core > 0 && k < 0.45) {
          const ck = 1 - k / 0.45;
          ctx.globalAlpha = ck * 0.9;
          ctx.fillStyle = r.coreCol;
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.core * ck + 2, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      for (let i = 0; i < MUSHES; i++) {
        const m = mushes[i];
        if (m.live) drawMushroom(ctx, m);
      }

      if (flash > 0) {
        ctx.globalAlpha = (calm ? 0.25 : 0.85) * flash * flash;
        ctx.fillStyle = '#fffbea';
        ctx.fillRect(-2000, -2000, 5600, 4900);
        ctx.globalAlpha = 1;
      }
    },
  };

  /**
   * One mushroom: a stem of stacked puffs from the ground to the cap, and the
   * dome of puffs rolled at spawn. It rises on an ease-out, the cap swells as
   * it goes, it is hot orange at the start and cools to smoke, and it fades
   * over its last third. Peak alpha is held low on purpose: it is a moment,
   * not a curtain.
   */
  function drawMushroom(ctx, m) {
    const s = m.scale;
    const k = m.t / MUSH_LIFE;
    const rise = 1 - Math.pow(1 - Math.min(1, m.t / 2.2), 3);
    const capY = m.y - (50 + 160 * rise) * s;
    const capX = m.x + m.drift;
    const capR = (50 + 55 * rise) * s;
    const fade = m.t < 0.2 ? m.t / 0.2 : k > 0.62 ? (1 - k) / 0.38 : 1;
    const hot = m.t < 1.6 ? 1 - m.t / 1.6 : 0;

    // Stem: narrows toward the top, leans with the drift.
    for (let i = 0; i < MUSH_STEM; i++) {
      const u = i / (MUSH_STEM - 1);
      const sx = m.x + m.drift * u * u;
      const sy = m.y + (capY - m.y) * u;
      // Overlapping heavily, and wobbling a little, so it reads as one
      // column of smoke and not a string of beads.
      const sr = (30 - 14 * u + Math.sin(i * 2.3) * 3) * s * (0.6 + 0.4 * rise);
      ctx.globalAlpha = 0.42 * fade;
      ctx.fillStyle = MUSH_SMOKE[i % 3];
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, TAU); ctx.fill();
      if (hot > 0) {
        ctx.globalAlpha = 0.5 * fade * hot;
        ctx.fillStyle = MUSH_HOT;
        ctx.beginPath(); ctx.arc(sx, sy, sr * 0.6, 0, TAU); ctx.fill();
      }
    }
    // Cap.
    const pf = m.puffs;
    for (let i = 0; i < MUSH_PUFFS; i++) {
      const px = capX + pf[i * 3] * capR;
      const py = capY + pf[i * 3 + 1] * capR;
      const pr = pf[i * 3 + 2] * capR;
      ctx.globalAlpha = 0.5 * fade;
      ctx.fillStyle = MUSH_SMOKE[i % 3];
      ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
    }
    if (hot > 0) {
      for (let i = 0; i < MUSH_PUFFS; i += 2) {
        const px = capX + pf[i * 3] * capR * 0.8;
        const py = capY + pf[i * 3 + 1] * capR * 0.8 + capR * 0.12;
        ctx.globalAlpha = 0.6 * fade * hot;
        ctx.fillStyle = i % 4 ? MUSH_HOT : FLAME_HOT;
        ctx.beginPath(); ctx.arc(px, py, pf[i * 3 + 2] * capR * 0.6, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function addShake(strength) {
    if (!shakeOn || !(strength > 0)) return;
    shakeAmp += strength * 13;
    if (shakeAmp > SHAKE_CAP) shakeAmp = SHAKE_CAP;
  }
}
