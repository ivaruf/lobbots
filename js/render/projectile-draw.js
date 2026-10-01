/*
 * projectile-draw.js — a sprite for every munition in the catalog.
 *
 * WHY EACH WEAPON GETS ITS OWN SHAPE
 *   Every shell used to be the same three discs. That was legible and told
 *   the player nothing: a Nuke on its way looked exactly like a free Shell,
 *   and the whole table should be watching one of those two and not the
 *   other. Now the thing in the air says what it is — a finned warhead with
 *   a trefoil, a drill bit, a canister with seams — and the room can start
 *   shouting before it lands.
 *
 * WHAT STILL HOLDS FROM THE OLD DISCS
 *   Every sprite has a dark outline and a bright body, because it must read
 *   against a pale dusk sky AND against dark strata, and one colour cannot do
 *   both. The owner's colour is somewhere on every one, so whose shot it is
 *   stays as readable as it was. Sizes stay close to the old 3 px radius —
 *   these are small things a long way off — except the Nuke, which is
 *   allowed to be visibly too big.
 *
 * BAKED, ROTATED, CACHED
 *   Each sprite is painted once per (weapon, owner colour) at 4x into an
 *   offscreen canvas, pointing +x, and drawn rotated along the velocity. The
 *   cache is two nested Maps rather than one keyed on `${id}|${hex}`, because
 *   building that string every frame for every projectile is an allocation
 *   per shell per frame. Weapons that animate (a spinning drill, a funky
 *   bomb cycling colour) bake a short strip of frames instead of one.
 *   Fire is the exception: it is drawn live, because a flame that flickers
 *   has no single frame to bake and the shape is three circles anyway.
 *
 * Unknown ids fall back to the old three-disc shell, so a weapon added to
 * the catalog before it gets art still flies visibly.
 */

const TAU = Math.PI * 2;
const SS = 4;

const DARK = '#10131a';
const CORE = '#fff3d0';
const STEEL_HI = '#e4ecf1';
const STEEL = '#9fb1c1';
const STEEL_LO = '#4d6276';
const HAZARD = '#ffd23f';

/**
 * Per weapon: the sheet size in field px (square), how many frames, and how
 * it is oriented. `spin` sprites are rotated by distance travelled rather
 * than by velocity (a ball rolls; it does not point).
 */
const SPEC = {
  shell:      { d: 14, frames: 1 },
  heavy:      { d: 16, frames: 1 },
  mega:       { d: 20, frames: 1 },
  cluster:    { d: 16, frames: 1 },
  bomblet:    { d: 9,  frames: 1, spin: 0.25 },
  mirv:       { d: 22, frames: 1 },
  'mirv-head':{ d: 12, frames: 1 },
  roller:     { d: 14, frames: 1, spin: 'roll' },
  bouncer:    { d: 14, frames: 1, spin: 'roll' },
  dirt:       { d: 14, frames: 1, spin: 0.12 },
  earthmover: { d: 16, frames: 1 },
  burrower:   { d: 18, frames: 3 },
  napalm:     { d: 16, frames: 1 },
  volcano:    { d: 14, frames: 2, spin: 0.08 },
  'lava-rock':{ d: 12, frames: 2, spin: 0.1 },
  funky:      { d: 14, frames: 6, spin: 'roll' },
  spark:      { d: 9,  frames: 2, spin: 0.3 },
  nuke:       { d: 30, frames: 1 },
};

export function createProjectilePainter() {
  /** weaponId -> (hex -> frames[]) */
  const cache = new Map();

  function framesFor(id, hex) {
    let byHex = cache.get(id);
    if (!byHex) { byHex = new Map(); cache.set(id, byHex); }
    let frames = byHex.get(hex);
    if (!frames) {
      const spec = SPEC[id];
      frames = [];
      for (let f = 0; f < spec.frames; f++) frames.push(bake(id, hex, spec.d, f, spec.frames));
      byHex.set(hex, frames);
    }
    return frames;
  }

  /**
   * Draw one projectile. `time` is the renderer's clock, for flicker and
   * frame cycling. The caller's globalAlpha is honoured (a burrower is
   * drawn faint).
   */
  function draw(ctx, p, hex, time) {
    const id = p.weaponId;
    if (id === 'fire') { drawFire(ctx, p, hex, time); return; }
    const spec = SPEC[id];
    if (!spec) { drawDisc(ctx, p, hex); return; }

    const frames = framesFor(id, hex);
    let frame = 0;
    if (spec.frames > 1) {
      // Drill threads advance with distance dug; colour and glow on a clock.
      const rate = id === 'burrower' ? 0 : id === 'funky' ? 9 : 5;
      frame = id === 'burrower'
        ? ((((p.x + p.y) * 0.35) | 0) % spec.frames + spec.frames) % spec.frames
        : (((time * rate + p.id * 0.7) | 0) % spec.frames + spec.frames) % spec.frames;
    }

    let a;
    if (spec.spin === 'roll') {
      // Roll by distance along x: one turn per circumference.
      a = p.x / ((spec.d * 0.3) || 1);
    } else if (typeof spec.spin === 'number') {
      a = (p.x + p.y) * spec.spin + p.id;
    } else {
      // Point along the velocity. A rolling or burrowing shell is moving
      // along its own state, not vx/vy, so fall back to the last direction.
      const st = p.state;
      if (st && st.burrowing && Number.isFinite(st.dx)) a = Math.atan2(st.dy, st.dx);
      else a = Math.atan2(p.vy, p.vx);
    }

    const d = spec.d;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    ctx.drawImage(frames[frame], -d / 2, -d / 2, d, d);
    ctx.restore();
  }

  return { draw };
}

/** The old shell, kept as the fallback for anything without art. */
function drawDisc(ctx, p, hex) {
  const r = p.radius || 3;
  ctx.fillStyle = DARK;
  ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.2, 0, TAU); ctx.fill();
  ctx.fillStyle = hex;
  ctx.beginPath(); ctx.arc(p.x, p.y, r + 1, 0, TAU); ctx.fill();
  ctx.fillStyle = CORE;
  ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.8, 0, TAU); ctx.fill();
}

/**
 * Napalm's burning fuel: a blob that flickers and leans away from where it
 * is going, hot core, an owner-coloured fleck so a splash still says whose.
 */
function drawFire(ctx, p, hex, time) {
  const f = Math.sin(time * 31 + p.id * 1.7) * 0.5 + 0.5;
  const g = Math.sin(time * 19 + p.id * 2.3) * 0.5 + 0.5;
  const sp = Math.hypot(p.vx, p.vy) || 1;
  const bx = -(p.vx / sp) * 2.2;
  const by = -(p.vy / sp) * 2.2 - 1;
  ctx.fillStyle = '#3a1208';
  ctx.beginPath(); ctx.arc(p.x, p.y, 4.6 + f, 0, TAU); ctx.fill();
  ctx.fillStyle = '#e2421e';
  ctx.beginPath(); ctx.arc(p.x + bx * 0.6, p.y + by * 0.6, 3.8 + f * 0.9, 0, TAU); ctx.fill();
  ctx.fillStyle = '#ff9a2e';
  ctx.beginPath(); ctx.arc(p.x + bx * 0.25, p.y + by * 0.25, 2.8 + g * 0.8, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff1a8';
  ctx.beginPath(); ctx.arc(p.x, p.y, 1.5 + g * 0.6, 0, TAU); ctx.fill();
  ctx.fillStyle = hex;
  ctx.fillRect(p.x - 0.8 + bx, p.y - 0.8 + by, 1.6, 1.6);
}

// ---------------------------------------------------------------------------
// The bakery. Every painter draws in field px, origin at the centre, nose
// pointing +x.
// ---------------------------------------------------------------------------

function bake(id, hex, d, frame, frames) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = d * SS;
  const c = cv.getContext('2d');
  c.setTransform(SS, 0, 0, SS, (d / 2) * SS, (d / 2) * SS);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const paint = PAINT[id];
  paint(c, hex, frame, frames);
  return cv;
}

function steel(c, y0, y1) {
  const g = c.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, STEEL_HI);
  g.addColorStop(0.35, STEEL);
  g.addColorStop(1, STEEL_LO);
  return g;
}

/**
 * A shell outline: a cylinder from `tail` to `shoulder`, an ogive nose to
 * `nose`, half-height `h`. Used by Shell, Heavy and Mega, which are the same
 * object at three sizes.
 */
function shellPath(c, tail, shoulder, nose, h) {
  c.beginPath();
  c.moveTo(tail, -h);
  c.lineTo(shoulder, -h);
  c.quadraticCurveTo(nose - (nose - shoulder) * 0.15, -h * 0.9, nose, 0);
  c.quadraticCurveTo(nose - (nose - shoulder) * 0.15, h * 0.9, shoulder, h);
  c.lineTo(tail, h);
  c.closePath();
}

function outlined(c, lw = 2.2) {
  c.strokeStyle = DARK;
  c.lineWidth = lw;
  c.stroke();
}

function circle(c, x, y, r, fill) {
  c.beginPath(); c.arc(x, y, r, 0, TAU);
  if (fill) { c.fillStyle = fill; c.fill(); }
}

const PAINT = {
  shell(c, hex) {
    shellPath(c, -4.5, 0.5, 5, 2.4);
    outlined(c);
    c.fillStyle = steel(c, -2.4, 2.4); c.fill();
    c.fillStyle = hex; c.fillRect(-3.4, -2.4, 1.6, 4.8);
    c.fillStyle = CORE; c.fillRect(1.4, -1.6, 2.2, 0.8);
  },

  heavy(c, hex) {
    shellPath(c, -6, 0.5, 6.5, 3.1);
    outlined(c);
    const g = c.createLinearGradient(0, -3, 0, 3);
    g.addColorStop(0, '#c9d2d8'); g.addColorStop(0.4, '#6f8292'); g.addColorStop(1, '#2d3d4c');
    c.fillStyle = g; c.fill();
    c.fillStyle = hex; c.fillRect(-4.8, -3.1, 1.5, 6.2);
    c.fillStyle = hex; c.fillRect(-2.4, -3.1, 1.5, 6.2);
    c.fillStyle = '#c99a4a'; c.fillRect(-6, -3.1, 0.9, 6.2); // driving band
    c.fillStyle = CORE; c.fillRect(1.8, -2.1, 2.6, 0.8);
  },

  mega(c, hex) {
    shellPath(c, -7.5, 0, 8, 4.2);
    outlined(c, 2.4);
    const g = c.createLinearGradient(0, -4, 0, 4);
    g.addColorStop(0, '#d5dde2'); g.addColorStop(0.4, '#5e7182'); g.addColorStop(1, '#22303d');
    c.fillStyle = g; c.fill();
    // Hazard nose: it is a big one and it says so.
    c.save();
    shellPath(c, -7.5, 0, 8, 4.2); c.clip();
    c.fillStyle = HAZARD; c.fillRect(1.5, -5, 7, 10);
    c.fillStyle = DARK;
    for (let x = 0; x < 9; x += 2.4) {
      c.beginPath(); c.moveTo(x, -5); c.lineTo(x + 1.1, -5); c.lineTo(x + 3.6, 5); c.lineTo(x + 2.5, 5); c.fill();
    }
    c.restore();
    c.fillStyle = hex; c.fillRect(-5.5, -4.2, 2.2, 8.4);
    c.fillStyle = '#c99a4a'; c.fillRect(-7.5, -4.2, 1, 8.4);
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(-3, -3.2, 4, 0.8);
  },

  cluster(c, hex) {
    // A canister: flat ends, seams where it splits, owner-colour caps.
    c.beginPath(); c.rect(-5.5, -3.4, 11, 6.8);
    outlined(c);
    c.fillStyle = steel(c, -3.4, 3.4); c.fill();
    c.fillStyle = hex; c.fillRect(-5.5, -3.4, 1.8, 6.8); c.fillRect(3.7, -3.4, 1.8, 6.8);
    c.fillStyle = DARK;
    for (let x = -2.2; x <= 2.2; x += 2.2) c.fillRect(x - 0.25, -3.4, 0.5, 6.8);
    c.fillStyle = '#ffd27a';
    for (let x = -1.1; x <= 1.1; x += 2.2) circle(c, x, 0, 0.55, '#ffd27a');
  },

  bomblet(c, hex) {
    circle(c, 0, 0, 2.6); outlined(c, 1.8);
    c.fillStyle = '#4b5a68'; c.fill();
    circle(c, -0.6, -0.6, 1.2, hex);
    circle(c, -0.9, -0.9, 0.45, CORE);
  },

  mirv(c, hex) {
    // A missile: long body, cone nose, cruciform fins at the tail.
    c.beginPath();
    c.moveTo(-8, -3.6); c.lineTo(-5, -2); c.lineTo(3, -2); c.lineTo(9, 0);
    c.lineTo(3, 2); c.lineTo(-5, 2); c.lineTo(-8, 3.6); c.lineTo(-7, 0);
    c.closePath();
    outlined(c);
    c.fillStyle = steel(c, -2, 2); c.fill();
    c.fillStyle = hex;
    c.beginPath(); c.moveTo(-8, -3.6); c.lineTo(-5, -2); c.lineTo(-5, 2); c.lineTo(-8, 3.6); c.lineTo(-7, 0); c.fill();
    c.fillStyle = '#d64535';
    c.beginPath(); c.moveTo(3, -2); c.lineTo(9, 0); c.lineTo(3, 2); c.closePath(); c.fill();
    c.fillStyle = DARK;
    for (let x = -2; x <= 2; x += 2) c.fillRect(x, -2, 0.5, 4);
    c.fillStyle = CORE; c.fillRect(-3, -1.5, 5, 0.5);
  },

  'mirv-head'(c, hex) {
    c.beginPath();
    c.moveTo(-3.6, -2.2); c.lineTo(1, -2.2); c.lineTo(4.8, 0); c.lineTo(1, 2.2); c.lineTo(-3.6, 2.2);
    c.closePath();
    outlined(c, 1.8);
    c.fillStyle = '#d64535'; c.fill();
    c.fillStyle = hex; c.fillRect(-3.6, -2.2, 1.8, 4.4);
    c.fillStyle = CORE; c.fillRect(0, -1.4, 2, 0.6);
  },

  roller(c, hex) {
    // A spoked wheel-ball: spokes are what make it visibly roll.
    circle(c, 0, 0, 4.4); outlined(c);
    c.fillStyle = '#596a79'; c.fill();
    circle(c, 0, 0, 3.4, hex);
    c.strokeStyle = DARK; c.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      c.beginPath(); c.moveTo(Math.cos(a) * 3.6, Math.sin(a) * 3.6); c.lineTo(-Math.cos(a) * 3.6, -Math.sin(a) * 3.6); c.stroke();
    }
    circle(c, 0, 0, 1.2, STEEL_HI);
    circle(c, -1.6, -1.8, 0.6, 'rgba(255,255,255,0.7)');
  },

  bouncer(c, hex) {
    // Rubber: a fat owner-coloured ball with one white band round it.
    circle(c, 0, 0, 4.2); outlined(c);
    const g = c.createRadialGradient(-1.4, -1.4, 0.3, 0, 0, 4.2);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, hex); g.addColorStop(1, '#1f2630');
    c.fillStyle = g; c.fill();
    c.save(); circle(c, 0, 0, 4.2); c.clip();
    c.fillStyle = '#f3f5f8'; c.fillRect(-5, -0.8, 10, 1.6);
    c.restore();
  },

  dirt(c, hex) {
    // A clod: lumpy, earthy, a fleck of the thrower's paint.
    c.beginPath();
    const pts = [[4, 0], [3, 2.6], [0.6, 3.8], [-2.4, 3], [-4.2, 0.8], [-3.4, -2.4], [-0.8, -3.8], [2.4, -3]];
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    outlined(c);
    c.fillStyle = '#7a5f45'; c.fill();
    circle(c, -1, -1.2, 1.3, '#9c7e5c');
    circle(c, 1.6, 1.2, 0.9, '#5a4532');
    circle(c, -2, 1.4, 0.6, '#4a3828');
    c.fillStyle = hex; c.fillRect(1.2, -2, 1.2, 1.2);
  },

  earthmover(c, hex) {
    // A scoop: a bucket with teeth, mouth forward.
    c.beginPath();
    c.moveTo(-5, -3.6); c.lineTo(4.6, -3.6); c.lineTo(5.6, 2); c.lineTo(2, 4); c.lineTo(-4, 4); c.lineTo(-6, 0);
    c.closePath();
    outlined(c);
    c.fillStyle = HAZARD; c.fill();
    c.fillStyle = '#5a4a1f'; c.fillRect(-4, -2.4, 7, 4.6);
    c.fillStyle = '#c7ced4';
    for (let y = -2.6; y <= 2.6; y += 2.6) {
      c.beginPath(); c.moveTo(4.8, y - 0.9); c.lineTo(7, y); c.lineTo(4.8, y + 0.9); c.fill();
    }
    c.fillStyle = hex; c.fillRect(-5.4, -1, 1.4, 2);
  },

  burrower(c, hex, frame, frames) {
    // A drill bit: owner-coloured motor body, then a steel cone with spiral
    // flutes. The flutes shift across frames so the bit visibly turns.
    c.beginPath(); c.rect(-7.5, -2.8, 6, 5.6);
    outlined(c);
    c.fillStyle = hex; c.fill();
    c.fillStyle = DARK; c.fillRect(-6.3, -2.8, 0.5, 5.6); c.fillRect(-4.3, -2.8, 0.5, 5.6);
    c.beginPath(); c.moveTo(-1.5, -3.3); c.lineTo(8, 0); c.lineTo(-1.5, 3.3); c.closePath();
    outlined(c);
    c.fillStyle = steel(c, -3.3, 3.3); c.fill();
    c.save();
    c.beginPath(); c.moveTo(-1.5, -3.3); c.lineTo(8, 0); c.lineTo(-1.5, 3.3); c.closePath(); c.clip();
    c.strokeStyle = '#2a3846'; c.lineWidth = 0.7;
    const off = (frame / frames) * 2.6;
    for (let x = -4 + off; x < 9; x += 2.6) {
      c.beginPath(); c.moveTo(x, -4); c.lineTo(x + 2.2, 4); c.stroke();
    }
    c.restore();
    circle(c, 8, 0, 0.5, CORE);
  },

  napalm(c, hex) {
    // A fuel canister: red, rounded, a flame decal on the side.
    c.beginPath();
    c.moveTo(-5.5, -3); c.lineTo(3.5, -3); c.quadraticCurveTo(6.5, -3, 6.5, 0);
    c.quadraticCurveTo(6.5, 3, 3.5, 3); c.lineTo(-5.5, 3); c.closePath();
    outlined(c);
    const g = c.createLinearGradient(0, -3, 0, 3);
    g.addColorStop(0, '#ff8a6a'); g.addColorStop(0.4, '#c8321e'); g.addColorStop(1, '#5a140c');
    c.fillStyle = g; c.fill();
    c.fillStyle = HAZARD;
    c.beginPath(); c.moveTo(-1.6, 2); c.quadraticCurveTo(-3, 0, -1, -2); c.quadraticCurveTo(-0.6, 0, 0.6, -0.6); c.quadraticCurveTo(1.6, 1, 0.2, 2); c.fill();
    c.fillStyle = hex; c.fillRect(-5.5, -3, 1.4, 6);
    c.fillStyle = '#ffd0c0'; c.fillRect(2, -2.2, 2.4, 0.6);
  },

  volcano(c, hex, frame) { rock(c, hex, frame, 4.6); },
  'lava-rock'(c, hex, frame) { rock(c, hex, frame, 3.6); },

  funky(c, hex, frame, frames) {
    // A swirl that cycles through the hues; the only rainbow on the field.
    circle(c, 0, 0, 4.4); outlined(c);
    const hue = (frame / frames) * 360;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, 4.2, (i / 6) * TAU, ((i + 1) / 6) * TAU);
      c.closePath();
      c.fillStyle = `hsl(${(hue + i * 60) % 360},90%,62%)`;
      c.fill();
    }
    circle(c, 0, 0, 1.8, hex);
    circle(c, -1.5, -1.6, 0.8, 'rgba(255,255,255,0.85)');
  },

  spark(c, hex, frame) {
    // A four-point star; two frames, so it twinkles.
    const r = frame ? 3.6 : 2.8;
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const rr = i % 2 ? r * 0.35 : r;
      if (i) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else c.moveTo(rr, 0);
    }
    c.closePath();
    outlined(c, 1.4);
    c.fillStyle = frame ? '#fff6c8' : hex; c.fill();
    circle(c, 0, 0, 0.8, CORE);
  },

  nuke(c, hex) {
    // Unmistakable: fat olive warhead, four tail fins, a hazard band, and
    // the trefoil. This is the one the table should see coming.
    c.beginPath();
    c.moveTo(-13, -6); c.lineTo(-9.5, -3.4); c.lineTo(-9.5, 3.4); c.lineTo(-13, 6); c.lineTo(-11.5, 0);
    c.closePath();
    outlined(c, 2.4);
    c.fillStyle = '#3f4a3a'; c.fill();
    c.beginPath();
    c.moveTo(-10, -4.4); c.lineTo(3, -5.6);
    c.bezierCurveTo(10, -5.6, 13.5, -3, 13.5, 0);
    c.bezierCurveTo(13.5, 3, 10, 5.6, 3, 5.6);
    c.lineTo(-10, 4.4);
    c.closePath();
    outlined(c, 2.6);
    const g = c.createLinearGradient(0, -5.6, 0, 5.6);
    g.addColorStop(0, '#cdd6a4'); g.addColorStop(0.35, '#7c8a4e'); g.addColorStop(1, '#2e3620');
    c.fillStyle = g; c.fill();
    // Hazard band.
    c.save();
    c.beginPath(); c.rect(-6.5, -6, 3.4, 12); c.clip();
    c.fillStyle = HAZARD; c.fillRect(-7, -6, 4, 12);
    c.fillStyle = DARK;
    for (let y = -7; y < 7; y += 2.4) {
      c.beginPath(); c.moveTo(-7, y); c.lineTo(-3, y + 2); c.lineTo(-3, y + 3.1); c.lineTo(-7, y + 1.1); c.fill();
    }
    c.restore();
    // Trefoil on a yellow disc.
    circle(c, 3.6, 0, 3.6, HAZARD);
    c.strokeStyle = DARK; c.lineWidth = 0.5; c.stroke();
    c.fillStyle = DARK;
    for (let i = 0; i < 3; i++) {
      const a0 = -Math.PI / 2 + (i * TAU) / 3 - 0.5;
      c.beginPath();
      c.moveTo(3.6, 0);
      c.arc(3.6, 0, 3.1, a0, a0 + 1.0);
      c.closePath();
      c.fill();
    }
    circle(c, 3.6, 0, 0.9, HAZARD);
    circle(c, 3.6, 0, 0.55, DARK);
    // Owner's nose band and a glint.
    c.fillStyle = hex; c.fillRect(9, -4.6, 1.4, 9.2);
    c.fillStyle = 'rgba(255,255,255,0.65)'; c.fillRect(-4, -4.6, 6, 0.8);
  },
};

/** Volcano rocks: dark basalt with lava cracks; frame 1 glows hotter. */
function rock(c, hex, frame, r) {
  c.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    const rr = r * (i % 2 ? 0.78 : 1);
    if (i) c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else c.moveTo(rr, 0);
  }
  c.closePath();
  outlined(c, 2);
  c.fillStyle = '#2a201c'; c.fill();
  c.save(); c.clip();
  c.strokeStyle = frame ? '#ffd27a' : '#ff7a2a';
  c.lineWidth = frame ? 1 : 0.8;
  c.beginPath();
  c.moveTo(-r, -0.4); c.lineTo(-0.6, 0.4); c.lineTo(r * 0.6, -r * 0.7);
  c.moveTo(-0.6, 0.4); c.lineTo(0.2, r);
  c.stroke();
  c.restore();
  c.fillStyle = hex; c.fillRect(-r * 0.5, -r * 0.6, 1.1, 1.1);
}
