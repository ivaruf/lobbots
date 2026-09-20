/*
 * mech-draw.js — the walkers: a baked chassis, live legs, a live barrel, and
 * the small strip of information that floats over each one.
 *
 * WHAT IS BAKED AND WHAT IS NOT
 *   The chassis never changes: worn steel, two panels in the player's colour,
 *   a hazard stripe, a lit visor, some scratches. That is a sprite, baked
 *   once per colour on attach() at 2x and drawn scaled down so the edges stay
 *   crisp on a high-DPI tablet. Everything that moves is drawn live, because
 *   it cannot be a sprite:
 *     legs     the feet are planted on the actual ground under x ± FOOT_W/2,
 *              so a mech on a slope stands on the slope rather than hovering
 *              over it. Two-bone IK, knee bending backwards like a bird's.
 *     body     rotated by mech.tilt, which world.js computes from the ground
 *              under each foot.
 *     barrel   rotated by mech.angle, BARREL_LEN from the body centre at
 *              y - BODY_LIFT. That is EXACTLY where world.muzzle() puts the
 *              shell, which is the point: the shot has to visibly leave the
 *              tip, or the barrel is a decoration and the player stops
 *              trusting it.
 *     recoil   world.js sets mech.recoil to 1 when the shot goes off and
 *              never touches it again; render.js decays it. Barrel and body
 *              are shoved back along the barrel axis, the planted feet do not
 *              move, so the legs compress. 200 ms, then it is gone.
 *
 * FACING is not a field on the mech: the barrel angle is the facing. Under 90
 * degrees is firing right, so the sprite is mirrored for anything above it
 * and the visor always looks where the gun looks.
 *
 * READABILITY IS THE BRIEF. Ten of these can be on screen at once and a
 * player has to find theirs instantly: silhouette first, colour second,
 * name tag third. Nothing here is allowed to be subtle.
 */

import { FOOT_W, BODY_LIFT, BARREL_LEN } from '../config.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// The sprite sheet's own units are field px; SS is the bake oversample.
const SS = 2;
const SP_W = 60;
const SP_H = 46;

// Chassis geometry, local to the body centre.
const HULL_W = 42;
const HULL_H = 25;
const HULL_TOP = -14;
const HIP_X = 11;
const HIP_Y = 9;
const THIGH = 11;
const SHIN = 12;

// Worn steel and the dark outline that lifts a mech off the strata.
const STEEL_TOP = '#49505d';
const STEEL_BOT = '#262b34';
const OUTLINE = '#14171d';
const LEG_STEEL = '#39404b';
const LEG_DARK = '#252a33';
const JOINT = '#5b6474';
const HAZARD = '#ffd23f';
const VISOR = '#a8e4ff';
const SHIELD_COL = '#9fd8ff';
const TAG_SHADOW = 'rgba(8,10,14,0.85)';
const BAR_BACK = 'rgba(10,12,16,0.66)';

const TAG_FONT = 'bold 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Preallocated IK scratch: the draw loop must not make objects. */
const knee = { x: 0, y: 0 };

export function createMechLayer() {
  /** hex -> { body, wreck }, so ten players with ten colours bake ten times. */
  const byHex = new Map();
  /** playerId -> { hex, name, body, wreck }, what render.js looks up. */
  const byPlayer = new Map();
  let fallback = null;

  function spritesFor(hex) {
    let s = byHex.get(hex);
    if (!s) {
      s = { body: bakeBody(hex, false), wreck: bakeBody(hex, true) };
      byHex.set(hex, s);
    }
    return s;
  }

  return {
    /** Bake one chassis and one wreck per player colour. Call on attach. */
    bake(players) {
      byPlayer.clear();
      if (!players) return;
      for (const p of players) {
        const hex = (p.color && p.color.hex) || '#eef0f4';
        const s = spritesFor(hex);
        byPlayer.set(p.id, { hex, name: p.name || '', body: s.body, wreck: s.wreck });
      }
    },

    /** The skin for a mech. Never null: an unknown player gets chalk. */
    skin(playerId) {
      const s = byPlayer.get(playerId);
      if (s) return s;
      if (!fallback) {
        const f = spritesFor('#eef0f4');
        fallback = { hex: '#eef0f4', name: '', body: f.body, wreck: f.wreck };
      }
      return fallback;
    },

    drawWreck,
    drawLive,
    drawOverlay,
    drawChevron,
  };
}

// ---------------------------------------------------------------------------
// Live drawing
// ---------------------------------------------------------------------------

/**
 * A living walker. `terrain` is world.terrain, used to plant the feet.
 * Draw order inside: legs, hull, barrel — so the hips are hidden under the
 * chassis and the gun sits on top of it where the eye expects a shoulder.
 */
function drawLive(ctx, m, skin, terrain) {
  const angle = m.angle * DEG;
  const dirX = Math.cos(angle);
  const dirY = -Math.sin(angle);
  const facingRight = m.angle < 90;
  const recoil = m.recoil > 0 ? m.recoil : 0;

  // The whole machine shoves back along the barrel; the feet do not.
  const bodyKick = recoil * 3.5;
  const cx = m.x - dirX * bodyKick;
  const cy = m.y - BODY_LIFT - dirY * bodyKick;

  const cos = Math.cos(m.tilt);
  const sin = Math.sin(m.tilt);

  // Back leg first so the front one overlaps it.
  const backX = facingRight ? -HIP_X : HIP_X;
  const frontX = -backX;
  drawLeg(ctx, terrain, m, cx, cy, cos, sin, backX, facingRight, false);
  drawLeg(ctx, terrain, m, cx, cy, cos, sin, frontX, facingRight, true);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(m.tilt);
  if (!facingRight) ctx.scale(-1, 1);
  ctx.drawImage(skin.body, -SP_W / 2, -SP_H / 2, SP_W, SP_H);
  ctx.restore();

  drawBarrel(ctx, cx, cy, dirX, dirY, recoil, skin.hex);
}

/** One leg: hip on the tilted hull, foot on the ground under the footprint. */
function drawLeg(ctx, terrain, m, cx, cy, cos, sin, hipLocalX, facingRight, front) {
  // Rotate the hip offset by the body tilt (y is down, so this matrix turns
  // clockwise on screen, which is the way a positive tilt leans).
  const hx = cx + hipLocalX * cos - HIP_Y * sin;
  const hy = cy + hipLocalX * sin + HIP_Y * cos;

  const footX = m.x + (hipLocalX > 0 ? FOOT_W / 2 : -FOOT_W / 2);
  // Probe from above the feet: groundBelow() answers with y itself when the
  // point is already buried, and a buried mech would otherwise grow knees.
  let footY = terrain ? terrain.groundBelow(footX, m.y - 30) : m.y;
  // Falling, or standing at a cliff edge: the leg dangles instead of
  // stretching to something a hundred px down.
  const maxDown = m.y + 16;
  if (!(footY < maxDown)) footY = maxDown;
  if (footY < m.y - 10) footY = m.y - 10;

  solveKnee(hx, hy, footX, footY, THIGH, SHIN, facingRight);

  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = front ? 8.5 : 7.5;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(knee.x, knee.y);
  ctx.lineTo(footX, footY);
  ctx.stroke();

  ctx.strokeStyle = front ? LEG_STEEL : LEG_DARK;
  ctx.lineWidth = front ? 5.5 : 4.5;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(knee.x, knee.y);
  ctx.lineTo(footX, footY);
  ctx.stroke();

  ctx.fillStyle = JOINT;
  ctx.beginPath();
  ctx.arc(knee.x, knee.y, front ? 2.6 : 2.2, 0, TAU);
  ctx.fill();

  // Foot pad, laid along the local slope so it sits ON the hill.
  const slope = terrain ? terrain.slopeAt(footX) : 0;
  ctx.save();
  ctx.translate(footX, footY);
  ctx.rotate(Math.atan(slope));
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(-8, -3.5, 16, 5.5);
  ctx.fillStyle = front ? LEG_STEEL : LEG_DARK;
  ctx.fillRect(-7, -2.5, 14, 3.5);
  ctx.restore();
}

/**
 * Two-bone IK. Writes the knee into the shared `knee` scratch. The knee bends
 * AWAY from the facing — digitigrade, the way a walker's leg reads as a
 * machine's leg rather than a person's. Out of reach, the leg straightens and
 * the foot is simply short of the target.
 */
function solveKnee(hx, hy, fx, fy, l1, l2, facingRight) {
  let dx = fx - hx;
  let dy = fy - hy;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.001) d = 0.001;
  const max = l1 + l2 - 0.01;
  if (d > max) {
    // Straight leg: put the knee on the line at l1 from the hip.
    knee.x = hx + (dx / d) * l1;
    knee.y = hy + (dy / d) * l1;
    return;
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h2 = l1 * l1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const bx = hx + (dx / d) * a;
  const by = hy + (dy / d) * a;
  // Perpendicular, flipped so the bend goes backwards relative to facing.
  const s = facingRight ? -1 : 1;
  knee.x = bx + s * (dy / d) * h;
  knee.y = by - s * (dx / d) * h;
}

/** The shoulder gun. Its tip is the sim's muzzle, minus the recoil kick. */
function drawBarrel(ctx, cx, cy, dirX, dirY, recoil, hex) {
  const kick = recoil * 4.5;
  const px = cx - dirX * kick;
  const py = cy - dirY * kick;
  const tipX = px + dirX * BARREL_LEN;
  const tipY = py + dirY * BARREL_LEN;
  // Perpendicular to the barrel, for its width.
  const nx = -dirY;
  const ny = dirX;

  ctx.beginPath();
  ctx.moveTo(px + nx * 4.6, py + ny * 4.6);
  ctx.lineTo(tipX + nx * 3.4, tipY + ny * 3.4);
  ctx.lineTo(tipX - nx * 3.4, tipY - ny * 3.4);
  ctx.lineTo(px - nx * 4.6, py - ny * 4.6);
  ctx.closePath();
  ctx.fillStyle = LEG_STEEL;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Muzzle band in the player's colour: the eye follows the tip, so that is
  // where the identity belongs.
  const bx = px + dirX * (BARREL_LEN - 6);
  const by = py + dirY * (BARREL_LEN - 6);
  ctx.beginPath();
  ctx.moveTo(bx + nx * 3.8, by + ny * 3.8);
  ctx.lineTo(tipX + nx * 3.6, tipY + ny * 3.6);
  ctx.lineTo(tipX - nx * 3.6, tipY - ny * 3.6);
  ctx.lineTo(bx - nx * 3.8, by - ny * 3.8);
  ctx.closePath();
  ctx.fillStyle = hex;
  ctx.fill();

  // Shoulder hub over the pivot, hiding the join.
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, TAU);
  ctx.fillStyle = STEEL_TOP;
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 2.6, 0, TAU);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
}

/**
 * A dead mech: the darkened sprite, slumped over, half sunk into the ground.
 * render.js adds the smoke column from effects.js — a wreck that just sits
 * there looks like a bug, and the column is also how a player spots at a
 * glance who is already out.
 */
function drawWreck(ctx, m, skin) {
  // Lean the way the ground leans, plus a fixed slump, and sit it low.
  const lean = m.tilt + (m.x % 2 < 1 ? 0.42 : -0.42);
  ctx.save();
  ctx.translate(m.x, m.y - BODY_LIFT * 0.55);
  ctx.rotate(lean);
  ctx.drawImage(skin.wreck, -SP_W / 2, -SP_H / 2, SP_W, SP_H);
  ctx.restore();
}

/**
 * Name tag, health bar and shield bar, above a living mech. Positioned from
 * the UN-recoiled centre on purpose: text that jumps when the gun fires is
 * unreadable exactly when the player is watching hardest.
 */
function drawOverlay(ctx, m, skin) {
  const cx = m.x;
  const cy = m.y - BODY_LIFT;
  const barY = cy - HULL_H - 12;
  const w = 46;
  const x = cx - w / 2;

  ctx.fillStyle = BAR_BACK;
  ctx.fillRect(x - 1, barY - 1, w + 2, 7);
  const ratio = m.maxHealth > 0 ? Math.max(0, Math.min(1, m.health / m.maxHealth)) : 0;
  ctx.fillStyle = skin.hex;
  ctx.fillRect(x, barY, w * ratio, 5);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 1.5, barY - 1.5, w + 3, 8);

  if (m.shield > 0) {
    // A thin second bar above the first, measured against the same maximum so
    // "a lot of shield" looks like a lot.
    const sr = Math.max(0, Math.min(1, m.shield / (m.maxHealth || 1)));
    ctx.fillStyle = SHIELD_COL;
    ctx.fillRect(x, barY - 5, w * sr, 2.5);
  }

  if (skin.name) {
    ctx.font = TAG_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // Stroked backing instead of a plate: cheaper, and it reads over sky,
    // strata and smoke alike.
    ctx.lineWidth = 3;
    ctx.strokeStyle = TAG_SHADOW;
    ctx.strokeText(skin.name, cx, barY - (m.shield > 0 ? 10 : 6));
    ctx.fillStyle = skin.hex;
    ctx.fillText(skin.name, cx, barY - (m.shield > 0 ? 10 : 6));
    ctx.textAlign = 'left';
  }
}

/** The bobbing "you" marker over the current player's mech. */
function drawChevron(ctx, m, t) {
  const bob = Math.sin(t * 4.2) * 3;
  const x = m.x;
  const y = m.y - BODY_LIFT - HULL_H - 40 + bob;
  ctx.beginPath();
  ctx.moveTo(x - 9, y);
  ctx.lineTo(x + 9, y);
  ctx.lineTo(x, y + 11);
  ctx.closePath();
  ctx.fillStyle = HAZARD;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// The bakery
// ---------------------------------------------------------------------------

/**
 * One chassis sprite. Drawn facing RIGHT; drawLive mirrors it for the other
 * half of the protractor. `dead` paints the same hull as a burnt-out wreck so
 * the silhouette a player learned is still the silhouette they recognise on
 * the scrap heap.
 */
function bakeBody(hex, dead) {
  const cv = document.createElement('canvas');
  cv.width = SP_W * SS;
  cv.height = SP_H * SS;
  const c = cv.getContext('2d');
  // Draw in field units with the origin at the body centre; the 2x is in the
  // transform, so every number below is a real px on the battlefield.
  c.setTransform(SS, 0, 0, SS, (SP_W * SS) / 2, (SP_H * SS) / 2);

  const left = -HULL_W / 2;
  const top = HULL_TOP;

  // Hull.
  const steel = c.createLinearGradient(0, top, 0, top + HULL_H);
  steel.addColorStop(0, STEEL_TOP);
  steel.addColorStop(1, STEEL_BOT);
  roundRect(c, left, top, HULL_W, HULL_H, 5);
  c.fillStyle = steel;
  c.fill();

  // Shoulder block the gun comes out of: it is what gives the silhouette a
  // top edge instead of a lozenge.
  roundRect(c, -13, top - 6, 26, 9, 3);
  c.fillStyle = dead ? '#2b2f38' : '#424955';
  c.fill();

  // Team panels: one on the shoulder, one on the flank. Two is enough to
  // name the owner from across the field and few enough to keep the machine
  // looking like machinery.
  c.fillStyle = hex;
  roundRect(c, -10, top - 4, 20, 5, 2);
  c.fill();
  roundRect(c, left + 3, top + 4, 13, 9, 2);
  c.fill();

  // Hazard stripe along the lower hull. Diagonals, clipped to the hull, the
  // same accent the HUD uses.
  c.save();
  roundRect(c, left, top, HULL_W, HULL_H, 5);
  c.clip();
  const bandY = top + HULL_H - 8;
  c.fillStyle = '#1c1f26';
  c.fillRect(left, bandY, HULL_W, 6);
  c.fillStyle = HAZARD;
  for (let i = -2; i < 9; i++) {
    c.beginPath();
    const bx = left + i * 5;
    c.moveTo(bx, bandY + 6);
    c.lineTo(bx + 3, bandY + 6);
    c.lineTo(bx + 7, bandY);
    c.lineTo(bx + 4, bandY);
    c.closePath();
    c.fill();
  }
  // Vents at the back, scratches across the front: the "worn, functional"
  // half of the brief, and cheap because it is baked.
  c.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < 3; i++) c.fillRect(left + 2, top + 3 + i * 4, 6, 2);
  c.strokeStyle = 'rgba(0,0,0,0.28)';
  c.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const sy = top + 3 + i * 5;
    c.beginPath();
    c.moveTo(2 + i * 3, sy);
    c.lineTo(11 + i * 2, sy + 3);
    c.stroke();
  }
  c.restore();

  // Cockpit visor, forward and high. Lit on a live mech, dark on a wreck —
  // it is the one part that says whether anyone is home.
  roundRect(c, 5, top + 3, 12, 6, 2.5);
  if (dead) {
    c.fillStyle = '#1a1d24';
    c.fill();
  } else {
    const glow = c.createLinearGradient(5, top + 3, 17, top + 9);
    glow.addColorStop(0, '#ffffff');
    glow.addColorStop(0.5, VISOR);
    glow.addColorStop(1, '#4f9fd0');
    c.fillStyle = glow;
    c.fill();
  }
  c.strokeStyle = OUTLINE;
  c.lineWidth = 1.4;
  c.stroke();

  // Outline last so it sits over everything.
  roundRect(c, left, top, HULL_W, HULL_H, 5);
  c.strokeStyle = OUTLINE;
  c.lineWidth = 2;
  c.stroke();

  if (dead) {
    // Burn the whole thing down and punch a hole in it.
    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(12,12,16,0.62)';
    c.fillRect(-SP_W, -SP_H, SP_W * 2, SP_H * 2);
    c.globalCompositeOperation = 'source-over';
    c.beginPath();
    c.arc(-2, top + 10, 6.5, 0, TAU);
    c.fillStyle = '#0d0e12';
    c.fill();
    c.strokeStyle = '#3a2a22';
    c.lineWidth = 1.6;
    c.stroke();
  }

  c.setTransform(1, 0, 0, 1, 0, 0);
  return cv;
}

/** Path helper; canvas roundRect() is not old enough to rely on. */
function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}
