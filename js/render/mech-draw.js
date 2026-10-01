/*
 * mech-draw.js — the walkers: a baked chassis and barrel, live legs, and the
 * small strip of information that floats over each one.
 *
 * WHAT IS BAKED AND WHAT IS NOT
 *   The chassis never changes: faceted ceramic armour over a graphite frame,
 *   enamel panels in the player's colour, a hazard-striped skirt, an exhaust
 *   stack, a sensor mast, the ammo drum, the hip housings, rivets and the
 *   scuffs a working machine picks up. That is a sprite, baked once per
 *   colour on attach() at 4x and drawn scaled down so the edges stay crisp on
 *   a high-DPI tablet. The barrel is baked the same way (it used to build a
 *   gradient every frame) and only rotated live. Everything that moves is
 *   drawn live, because it cannot be a sprite:
 *     legs     the feet are planted on the actual ground under x ± FOOT_W/2,
 *              so a mech on a slope stands on the slope rather than hovering
 *              over it. Two-bone IK, knee bending backwards like a bird's.
 *              On a Move turn (m.walking) they STRIDE instead: see stride().
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
 *     life     the antenna beacon blinks, a glint sweeps the visor now and
 *              then, the exhaust breathes a little heat. Each is keyed to the
 *              mech's x so ten walkers never blink in unison.
 *
 * FACING is not a field on the mech: the barrel angle is the facing. Under 90
 * degrees is firing right, so the sprite is mirrored for anything above it
 * and the visor always looks where the gun looks. The one exception is a
 * walk: a machine faces where it is going, so while m.walking the hull turns
 * to m.walkDir and the barrel is DRAWN mirrored to match. Nothing fires
 * during a walk, so the muzzle contract is not in play, and the sim's angle
 * is untouched — when the walk ends the gun swings back to where it was.
 *
 * READABILITY IS THE BRIEF. Ten of these can be on screen at once and a
 * player has to find theirs instantly: silhouette first, colour second,
 * name tag third. Detail is allowed only where it does not blur those three:
 * the enamel panels are the largest flat areas on the hull, and everything
 * fine is dark-on-mid or light-on-mid so it reads as texture, not as shape.
 */

import { FOOT_W, BODY_LIFT, BARREL_LEN } from '../config.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// The sprite sheet's own units are field px; SS is the bake oversample. The
// origin (the body centre) sits off-centre in the sheet because the sensor
// mast and exhaust stack reach much higher than the skirt reaches low.
const SS = 4;
const SP_W = 64;
const SP_H = 62;
const SP_OX = 32;
const SP_OY = 40;

// Barrel sheet: hub at the origin, muzzle at +BARREL_LEN.
const BR_X0 = -9;
const BR_W = BARREL_LEN + 11;
const BR_H = 18;

// Chassis geometry, local to the body centre.
const HULL_H = 25;
const HULL_TOP = -14;
const HIP_X = 11;
const HIP_Y = 9;
const THIGH = 11;
const SHIN = 12;

// Walking. One full stride cycle per STRIDE px travelled; S is how far a foot
// swings either side of its rest point. A foot on the ground must move
// backwards relative to the body at the body's own speed or it skates, and
// half a cycle moves the body STRIDE/2 while the foot sweeps 2S, so S is
// STRIDE/4 — not a taste, a requirement.
export const STRIDE = 36;
const STRIDE_S = STRIDE / 4;
const STRIDE_LIFT = 6.5;

// Graphite joints and the dark outline that lifts a mech off the strata.
const OUTLINE = '#14171d';
const LEG_STEEL = '#3d4552';
const LEG_DARK = '#272c35';
const LEG_HI = '#8a99a8';
const LEG_HI_DARK = '#58677a';
const JOINT = '#5b6474';
const HAZARD = '#ffd23f';
const PLATE = '#15181e';
const ACCENT = '#a7d9e8';
const SHIELD_COL = '#9fd8ff';
const TAG_SHADOW = 'rgba(8,10,14,0.85)';
const BAR_BACK = 'rgba(10,12,16,0.66)';

const TAG_FONT = 'bold 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Preallocated IK and stride scratch: the draw loop must not make objects. */
const knee = { x: 0, y: 0 };
const foot = { x: 0, y: 0, lift: 0 };

/** A soft orange glow, baked once, used for cook-off light and the visor. */
let glowSprite = null;
function glow() {
  if (glowSprite) return glowSprite;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,236,170,1)');
  g.addColorStop(0.25, 'rgba(255,170,70,0.85)');
  g.addColorStop(0.6, 'rgba(230,80,30,0.3)');
  g.addColorStop(1, 'rgba(200,40,20,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  glowSprite = cv;
  return cv;
}

export function createMechLayer() {
  /** hex -> skin, so ten players with ten colours bake ten times. */
  const byHex = new Map();
  /** playerId -> { hex, name, body, wreck, barrel, barrelWreck }. */
  const byPlayer = new Map();
  let fallback = null;

  function spritesFor(hex) {
    let s = byHex.get(hex);
    if (!s) {
      s = bakeSkin(hex, SS);
      byHex.set(hex, s);
    }
    return s;
  }

  return {
    /** Bake one chassis, barrel and wreck per player colour. Call on attach. */
    bake(players) {
      byPlayer.clear();
      if (!players) return;
      for (const p of players) {
        const hex = (p.color && p.color.hex) || '#eef0f4';
        const s = spritesFor(hex);
        byPlayer.set(p.id, { ...s, name: p.name || '' });
      }
    },

    /** The skin for a mech. Never null: an unknown player gets chalk. */
    skin(playerId) {
      const s = byPlayer.get(playerId);
      if (s) return s;
      if (!fallback) fallback = { ...spritesFor('#eef0f4'), name: '' };
      return fallback;
    },

    drawWreck,
    drawLive,
    drawOverlay,
    drawChevron,
  };
}

function bakeSkin(hex, ss) {
  return {
    hex,
    body: bakeBody(hex, false, ss),
    wreck: bakeBody(hex, true, ss),
    barrel: bakeBarrel(hex, false, ss),
    barrelWreck: bakeBarrel(hex, true, ss),
  };
}

// ---------------------------------------------------------------------------
// Live drawing
// ---------------------------------------------------------------------------

/**
 * A living walker. `terrain` is world.terrain, used to plant the feet.
 * Draw order inside: legs, hull, barrel — so the hips are hidden under the
 * chassis and the gun sits on top of it where the eye expects a shoulder.
 * The caller's globalAlpha is honoured throughout, so render.js can draw a
 * ghost walker for the Move marker with this same function.
 */
function drawLive(ctx, m, skin, terrain, time = 0) {
  const base = ctx.globalAlpha;
  const walking = !!m.walking;
  const walkDir = m.walkDir < 0 ? -1 : 1;
  const aimRight = m.angle < 90;
  const facingRight = walking ? walkDir > 0 : aimRight;
  // Drawn angle: mirrored during a walk if the gun points behind the hull.
  const drawAngle = walking && facingRight !== aimRight ? 180 - m.angle : m.angle;
  const angle = drawAngle * DEG;
  const dirX = Math.cos(angle);
  const dirY = -Math.sin(angle);
  const recoil = m.recoil > 0 ? m.recoil : 0;
  const phase = walking ? ((m.walkDist || 0) / STRIDE) * TAU : 0;

  // The whole machine shoves back along the barrel; the feet do not.
  const bodyKick = recoil * 3.5;
  const cx = m.x - dirX * bodyKick;
  const cy = m.y - BODY_LIFT - dirY * bodyKick;

  // Suspension travel: a slow idle sway at rest, a two-beat bob on the march
  // (the hull rises as each leg passes under it).
  const bob = walking
    ? -(1 - Math.cos(phase * 2)) * 0.9
    : Math.sin(time * 2.3 + m.x * 0.07) * 0.65;

  ctx.globalAlpha = base * 0.28;
  ctx.fillStyle = '#080f19';
  ctx.beginPath();
  ctx.ellipse(m.x, m.y + 1, 26, 4, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = base;

  const cos = Math.cos(m.tilt);
  const sin = Math.sin(m.tilt);

  // Back leg first so the front one overlaps it. Opposite phases on the
  // march, so one foot is always down.
  const backX = facingRight ? -HIP_X : HIP_X;
  const frontX = -backX;
  drawLeg(ctx, terrain, m, skin.hex, cx, cy + bob, cos, sin, backX, facingRight, false, walking, walkDir, phase);
  drawLeg(ctx, terrain, m, skin.hex, cx, cy + bob, cos, sin, frontX, facingRight, true, walking, walkDir, phase + Math.PI);

  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.rotate(m.tilt);
  if (!facingRight) ctx.scale(-1, 1);
  ctx.drawImage(skin.body, -SP_OX, -SP_OY, SP_W, SP_H);

  if (time > 0) {
    const seed = m.x * 0.031;
    // Antenna beacon: a short wink every second or so.
    const wink = Math.sin(time * 3 + m.x) > 0.6;
    ctx.fillStyle = wink ? '#fff6c8' : '#6b5a2a';
    ctx.fillRect(-12.2, -37.6, 2.4, 2.4);
    if (wink) {
      ctx.globalAlpha = base * 0.35;
      ctx.drawImage(glow(), -15, -40.4, 8, 8);
      ctx.globalAlpha = base;
    }
    // Visor: a glint sweeps across the glass every few seconds; the shutter
    // still blinks on its own, slower clock.
    const sweep = (time * 0.55 + seed) % 3.2;
    if (sweep < 0.5) {
      const gx = 5 + (sweep / 0.5) * 10;
      ctx.globalAlpha = base * 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(gx, -11, 1.1, 4);
      ctx.globalAlpha = base;
    }
    if ((time + m.x * 0.03) % 6.7 < 0.14) {
      ctx.fillStyle = '#26394a';
      ctx.fillRect(5, -11, 11, 4);
    }
    // Heat off the exhaust stack: three faint puffs on a loop, rising and
    // spreading. Drawn, not emitted — this is idle life, not an event.
    ctx.fillStyle = '#c9ccd4';
    for (let i = 0; i < 3; i++) {
      const k = (time * 0.7 + i / 3 + seed) % 1;
      ctx.globalAlpha = base * 0.16 * (1 - k);
      ctx.beginPath();
      ctx.arc(-19.5 + Math.sin(k * 5 + i) * 1.5, -32 - k * 12, 1.4 + k * 3, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = base;
  }
  ctx.restore();

  drawBarrel(ctx, cx, cy + (walking ? bob : 0), dirX, dirY, recoil, skin.barrel);
}

/**
 * Where a striding foot is this frame, relative to its rest point, written
 * into the `foot` scratch. sin(u) > 0 is the swing (moving forward, lifted),
 * the rest is stance (on the ground, sliding back at body speed).
 */
function stride(u, walkDir) {
  const s = Math.sin(u);
  foot.x = -walkDir * STRIDE_S * Math.cos(u);
  foot.lift = s > 0 ? s * STRIDE_LIFT : 0;
}

/** One leg: hip on the tilted hull, foot on the ground under the footprint. */
function drawLeg(ctx, terrain, m, hex, cx, cy, cos, sin, hipLocalX, facingRight, front, walking, walkDir, u) {
  // Rotate the hip offset by the body tilt (y is down, so this matrix turns
  // clockwise on screen, which is the way a positive tilt leans).
  const hx = cx + hipLocalX * cos - HIP_Y * sin;
  const hy = cy + hipLocalX * sin + HIP_Y * cos;

  let footX = m.x + (hipLocalX > 0 ? FOOT_W / 2 : -FOOT_W / 2);
  let lift = 0;
  if (walking) {
    stride(u, walkDir);
    footX += foot.x;
    lift = foot.lift;
  }
  // Probe from above the feet: groundBelow() answers with y itself when the
  // point is already buried, and a buried mech would otherwise grow knees.
  let footY = terrain ? terrain.groundBelow(footX, m.y - 30) : m.y;
  // Falling, or standing at a cliff edge: the leg dangles instead of
  // stretching to something a hundred px down.
  const maxDown = m.y + 16;
  if (!(footY < maxDown)) footY = maxDown;
  if (footY < m.y - 10) footY = m.y - 10;
  footY -= lift;

  solveKnee(hx, hy, footX, footY, THIGH, SHIN, facingRight);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Outline for both bones at once, then each bone in its own tone: a
  // heavier thigh in steel, a slimmer shin a shade darker.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = front ? 9 : 8;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(knee.x, knee.y);
  ctx.lineTo(footX, footY);
  ctx.stroke();

  ctx.strokeStyle = front ? LEG_STEEL : LEG_DARK;
  ctx.lineWidth = front ? 6.4 : 5.4;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(knee.x, knee.y);
  ctx.stroke();
  ctx.lineWidth = front ? 4.6 : 3.8;
  ctx.strokeStyle = front ? '#323945' : '#20242c';
  ctx.beginPath();
  ctx.moveTo(knee.x, knee.y);
  ctx.lineTo(footX, footY);
  ctx.stroke();

  // Edge light along the top of the thigh, so the leg reads as a round
  // member and not a flat stroke.
  ctx.strokeStyle = front ? LEG_HI : LEG_HI_DARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hx - 1.2, hy - 1.6);
  ctx.lineTo(knee.x - 1.2, knee.y - 1.6);
  ctx.stroke();

  // Thigh armour in the pilot's colour on the near leg only: a second place
  // for team colour, low on the silhouette where the hull cannot hide it.
  if (front) {
    const tx = hx + (knee.x - hx) * 0.3;
    const ty = hy + (knee.y - hy) * 0.3;
    const ex = hx + (knee.x - hx) * 0.78;
    const ey = hy + (knee.y - hy) * 0.78;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 4.6;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = hex;
    ctx.lineWidth = 2.8;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey); ctx.stroke();
  }

  // Hydraulic piston: a bright rod in a dark sleeve, from mid-thigh to low
  // on the shin, so the knee visibly works when the leg folds.
  const px0 = hx + (knee.x - hx) * 0.45 + 2.4;
  const py0 = hy + (knee.y - hy) * 0.45;
  const px1 = knee.x + (footX - knee.x) * 0.7 + 2.4;
  const py1 = knee.y + (footY - knee.y) * 0.7;
  const pmx = (px0 + px1) / 2;
  const pmy = (py0 + py1) / 2;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.8;
  ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke();
  ctx.strokeStyle = front ? '#2a313b' : '#1e232a';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(pmx, pmy); ctx.stroke();
  ctx.strokeStyle = front ? '#cfdbe2' : '#7a8a98';
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(pmx, pmy); ctx.lineTo(px1, py1); ctx.stroke();

  // Knee: a joint disc with a dark hub and a pin of light.
  ctx.fillStyle = OUTLINE;
  ctx.beginPath(); ctx.arc(knee.x, knee.y, front ? 3.6 : 3.1, 0, TAU); ctx.fill();
  ctx.fillStyle = JOINT;
  ctx.beginPath(); ctx.arc(knee.x, knee.y, front ? 2.8 : 2.3, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1a2e43';
  ctx.beginPath(); ctx.arc(knee.x, knee.y, front ? 1.5 : 1.1, 0, TAU); ctx.fill();
  ctx.fillStyle = '#c7d7e2';
  ctx.fillRect(knee.x - 0.8, knee.y - 1.2, 1.4, 0.6);

  // Foot: a pad laid along the local slope so it sits ON the hill, three
  // toothed claws forward and a heel spur back. A lifted foot tips its toes
  // down a touch, which is most of what makes a stride read as a step.
  const slope = terrain && !lift ? terrain.slopeAt(footX) : 0;
  const fs = facingRight ? 1 : -1;
  ctx.save();
  ctx.translate(footX, footY);
  ctx.rotate(Math.atan(slope) + (lift ? fs * lift * 0.04 : 0));
  ctx.scale(fs, 1);
  ctx.fillStyle = OUTLINE;
  ctx.beginPath();
  ctx.moveTo(-9, 2); ctx.lineTo(-10.5, -1); ctx.lineTo(-6, -4.5); ctx.lineTo(5, -4.5);
  ctx.lineTo(8, -2); ctx.lineTo(11.5, 0.5); ctx.lineTo(11, 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = front ? LEG_STEEL : LEG_DARK;
  ctx.fillRect(-7, -3.5, 12, 3.6);
  ctx.fillStyle = front ? '#b4c4d0' : '#697f94';
  ctx.fillRect(-6, -3.6, 10, 1);
  // Claws: three teeth splayed forward.
  ctx.fillStyle = front ? '#8d9aa8' : '#56626e';
  for (let i = 0; i < 3; i++) {
    const tx = 4.5 + i * 2.2;
    ctx.beginPath();
    ctx.moveTo(tx, -1.6); ctx.lineTo(tx + 2.4, 1.6); ctx.lineTo(tx, 1.4);
    ctx.closePath();
    ctx.fill();
  }
  // Heel spur.
  ctx.beginPath();
  ctx.moveTo(-7, -1); ctx.lineTo(-10, 1.6); ctx.lineTo(-6.5, 1.4);
  ctx.closePath();
  ctx.fill();
  // Ankle bolt.
  ctx.fillStyle = '#13283c';
  ctx.beginPath(); ctx.arc(-1, -2.2, 1.2, 0, TAU); ctx.fill();
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
function drawBarrel(ctx, cx, cy, dirX, dirY, recoil, sprite) {
  const kick = recoil * 4.5;
  ctx.save();
  ctx.translate(cx - dirX * kick, cy - dirY * kick);
  ctx.rotate(Math.atan2(dirY, dirX));
  ctx.drawImage(sprite, BR_X0, -BR_H / 2, BR_W, BR_H);
  ctx.restore();
}

/**
 * A dead mech: the burnt-out sprite, slumped over and half sunk, two
 * buckled leg stubs under it, and its gun torn off and lying in the dirt
 * beside it. render.js adds the smoke column and the occasional spark from
 * effects.js — a wreck that just sits there looks like a bug, and the column
 * is also how a player spots at a glance who is already out.
 *
 * COOK-OFF: while m.cookOff counts down, the wreck is about to blow (the
 * death blast). Light pulses out of the hole in the hull, faster and hotter
 * as the count runs out, and a column of light climbs from it in the final
 * moments. The player should look at it and flinch before it goes.
 */
function drawWreck(ctx, m, skin, terrain, time = 0) {
  // Lean the way the ground leans, plus a fixed slump, and sit it low.
  const side = m.x % 2 < 1 ? 1 : -1;
  const lean = m.tilt + side * 0.42;

  // The torn-off gun, on the ground on the low side of the slump.
  const gx = m.x + side * 27;
  const gy = terrain ? terrain.groundBelow(gx, m.y - 30) : m.y;
  const gSlope = terrain ? Math.atan(terrain.slopeAt(gx)) : 0;
  ctx.save();
  ctx.translate(gx, gy - 2.6);
  ctx.rotate(gSlope + side * 0.12);
  ctx.scale(side, 1);
  ctx.drawImage(skin.barrelWreck, BR_X0 - BARREL_LEN * 0.5, -BR_H / 2, BR_W, BR_H);
  ctx.restore();

  // Buckled leg stubs: short, bent, splayed. Same steel as the living legs.
  ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i += 2) {
    const hx = m.x + i * 9;
    const hy = m.y - BODY_LIFT * 0.4;
    const kx = m.x + i * 17;
    const ky = m.y - 5;
    const fx = m.x + i * 13;
    const fy = terrain ? Math.min(m.y + 2, terrain.groundBelow(fx, m.y - 30)) : m.y;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.strokeStyle = '#2a2d33';
    ctx.lineWidth = 4.4;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.fillStyle = '#4a3c34';
    ctx.beginPath(); ctx.arc(kx, ky, 2, 0, TAU); ctx.fill();
  }

  ctx.save();
  ctx.translate(m.x, m.y - BODY_LIFT * 0.55);
  ctx.rotate(lean);
  ctx.drawImage(skin.wreck, -SP_OX, -SP_OY, SP_W, SP_H);

  // Embers in the hole even when nothing is pending: dim, slow.
  const base = ctx.globalAlpha;
  const cook = m.cookOff > 0 ? m.cookOff : 0;
  if (cook > 0) {
    // k: 0 at the start of a typical cook-off, 1 at the bang.
    const k = cook > 1.2 ? 0 : 1 - cook / 1.2;
    const freq = 6 + k * 34;
    const flick = 0.55 + 0.45 * Math.sin(time * freq) * Math.sin(time * freq * 0.37 + 1.3);
    const size = 16 + k * 30 + flick * 8;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = base * (0.45 + 0.55 * flick) * (0.55 + 0.45 * k);
    ctx.drawImage(glow(), -2 - size / 2, -4 - size / 2, size, size);
    ctx.globalCompositeOperation = 'source-over';
  } else if (time > 0) {
    const ember = 0.25 + 0.2 * Math.sin(time * 2.1 + m.x);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = base * ember;
    ctx.drawImage(glow(), -8, -10, 12, 12);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = base;
  ctx.restore();

  // The column of light in the last moments: the reactor is open. Drawn in
  // world space so it climbs straight up whatever angle the wreck slumped at.
  if (cook > 0 && cook < 0.66) {
    const beam = 1 - cook / 0.66;
    const flick = 0.6 + 0.4 * Math.sin(time * 47);
    const hx = m.x;
    const hy = m.y - BODY_LIFT * 0.55 - 4;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = base * beam * 0.5 * flick;
    ctx.fillStyle = '#ffe2a0';
    ctx.fillRect(hx - beam * 2.5, hy - 80 * beam, beam * 5, 80 * beam);
    ctx.globalAlpha = base * beam * 0.25 * flick;
    ctx.fillRect(hx - beam * 6, hy - 50 * beam, beam * 12, 50 * beam);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = base;
  }
}

/**
 * Name tag, health bar and shield bar, above a living mech. Positioned from
 * the UN-recoiled centre on purpose: text that jumps when the gun fires is
 * unreadable exactly when the player is watching hardest.
 */
function drawOverlay(ctx, m, skin) {
  const cx = m.x;
  const cy = m.y - BODY_LIFT;
  const barY = cy - HULL_H - 18;
  const w = 46;
  const x = cx - w / 2;

  ctx.fillStyle = BAR_BACK;
  ctx.fillRect(x - 1, barY - 1, w + 2, 7);
  const ratio = m.maxHealth > 0 ? Math.max(0, Math.min(1, m.health / m.maxHealth)) : 0;
  ctx.fillStyle = skin.hex;
  ctx.fillRect(x, barY, w * ratio, 5);
  // Quarter ticks, so "about half" can be read without counting pixels.
  ctx.fillStyle = 'rgba(10,12,16,0.55)';
  for (let i = 1; i < 4; i++) ctx.fillRect(x + (w * i) / 4 - 0.5, barY, 1, 5);
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
  const y = m.y - BODY_LIFT - HULL_H - 44 + bob;
  ctx.beginPath();
  ctx.moveTo(x - 9, y);
  ctx.lineTo(x + 9, y);
  ctx.lineTo(x, y + 11);
  ctx.closePath();
  ctx.fillStyle = ACCENT;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// The bakery
// ---------------------------------------------------------------------------

/** '#rrggbb' mixed toward white (k > 0) or black (k < 0). Bake time only. */
function shade(hex, k) {
  const n = parseInt(hex.slice(1, 7), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (k > 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
  else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** A tiny seeded generator for scuffs, so a colour's wear is always the same. */
function scuffRng(hex) {
  let s = parseInt(hex.slice(1, 7), 16) ^ 0x5bd1e995;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/**
 * One chassis sprite. Drawn facing RIGHT; drawLive mirrors it for the other
 * half of the protractor. `dead` paints the same hull as a burnt-out wreck so
 * the silhouette a player learned is still the silhouette they recognise on
 * the scrap heap — with the mast snapped and the stack cold.
 */
function bakeBody(hex, dead, ss = SS) {
  const cv = document.createElement('canvas');
  cv.width = SP_W * ss;
  cv.height = SP_H * ss;
  const c = cv.getContext('2d');
  // Draw in field units with the origin at the body centre; the oversample
  // is in the transform, so every number below is a real px on the field.
  c.setTransform(ss, 0, 0, ss, SP_OX * ss, SP_OY * ss);
  const rnd = scuffRng(hex);

  function poly(points) {
    c.beginPath();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]);
    }
    c.closePath();
  }
  function plate(points, fill, edge = '#172434', lw = 0.7) {
    poly(points);
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = edge;
    c.lineWidth = lw;
    c.stroke();
  }
  function rivet(x, y, r = 0.75) {
    c.fillStyle = '#1d3043';
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    c.fillStyle = '#dce8ef';
    c.fillRect(x - r * 0.5, y - r * 0.5, r * 0.8, r * 0.35);
  }

  const ceramic = c.createLinearGradient(0, -21, 8, 10);
  ceramic.addColorStop(0, '#e9eef2');
  ceramic.addColorStop(0.3, '#b9c8d4');
  ceramic.addColorStop(0.55, '#7d93a7');
  ceramic.addColorStop(1, '#3d5168');
  const darkMetal = c.createLinearGradient(-24, 0, 22, 10);
  darkMetal.addColorStop(0, '#152131');
  darkMetal.addColorStop(0.5, '#52687a');
  darkMetal.addColorStop(1, '#172536');
  const shell = c.createLinearGradient(0, -16, 4, 2);
  shell.addColorStop(0, shade(hex, 0.45));
  shell.addColorStop(0.45, hex);
  shell.addColorStop(1, shade(hex, -0.3));
  const enamel = c.createLinearGradient(-16, -14, -6, 0);
  enamel.addColorStop(0, shade(hex, 0.5));
  enamel.addColorStop(0.5, hex);
  enamel.addColorStop(1, shade(hex, -0.38));

  // ---- the silhouette's dark outline, drawn first and fat ---------------
  // Everything below sits inside this; it is what lifts a pale hull off a
  // pale sky.
  c.lineJoin = 'round';
  plate([[-26,-14],[-21,-20],[-13,-22],[8,-22],[14,-17],[23,-9],[21,7],[13,13],[-16,11],[-24,7]], OUTLINE, OUTLINE, 2.4);

  // ---- exhaust stack, behind the hull ------------------------------------
  const stack = c.createLinearGradient(-23, 0, -16, 0);
  stack.addColorStop(0, '#1b2430');
  stack.addColorStop(0.45, '#6d7f90');
  stack.addColorStop(1, '#1d2836');
  c.fillStyle = OUTLINE;
  c.fillRect(-23.4, dead ? -24.5 : -31.5, 7.8, dead ? 16 : 23);
  c.fillStyle = stack;
  c.fillRect(-22.6, dead ? -23.8 : -29, 6.2, dead ? 15 : 21);
  if (!dead) {
    // Cap with a rain flap, sooted mouth, and a band in the pilot's colour.
    c.fillStyle = OUTLINE;
    c.fillRect(-24.4, -32.2, 9.8, 3.4);
    c.fillStyle = '#8395a6';
    c.fillRect(-23.8, -31.6, 8.6, 2.2);
    c.fillStyle = '#0c0f14';
    c.fillRect(-22.4, -31.1, 5.8, 0.9);
    c.fillStyle = hex;
    c.fillRect(-22.6, -25, 6.2, 1.8);
  } else {
    // Torn off short, jagged and scorched.
    poly([[-22.6,-23.8],[-21.4,-26.2],[-20.2,-24.4],[-18.6,-26.8],[-17.2,-24.2],[-16.4,-23.8]]);
    c.fillStyle = '#2a2420'; c.fill();
  }
  c.fillStyle = '#0d141d';
  for (let i = 0; i < 3; i++) c.fillRect(-21.8, -20 + i * 3.4, 4.6, 0.7);

  // ---- sensor mast --------------------------------------------------------
  c.lineCap = 'round';
  c.strokeStyle = OUTLINE;
  c.lineWidth = 2.4;
  c.beginPath();
  if (dead) { c.moveTo(-7, -21); c.lineTo(-9, -27); c.lineTo(-15, -26); }
  else { c.moveTo(-7, -21); c.lineTo(-11, -36.4); }
  c.stroke();
  c.strokeStyle = '#a8b7c4';
  c.lineWidth = 0.9;
  c.beginPath();
  if (dead) { c.moveTo(-7, -21); c.lineTo(-9, -27); c.lineTo(-15, -26); }
  else { c.moveTo(-7, -21); c.lineTo(-11, -36.4); }
  c.stroke();
  if (!dead) {
    // Cross-arm and the beacon housing; the lamp itself is drawn live.
    c.strokeStyle = OUTLINE; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(-13.4, -30); c.lineTo(-7.6, -31.4); c.stroke();
    c.strokeStyle = '#a8b7c4'; c.lineWidth = 0.6;
    c.beginPath(); c.moveTo(-13.4, -30); c.lineTo(-7.6, -31.4); c.stroke();
    c.fillStyle = OUTLINE;
    c.fillRect(-12.9, -38.3, 3.8, 3.8);
  }

  // ---- rear cooling module ----------------------------------------------
  plate([[-25,-14],[-21,-19],[-15,-18],[-15,9],[-23,7]], darkMetal);
  for (let i = 0; i < 6; i++) {
    c.fillStyle = '#0b1522';
    c.fillRect(-23, -12 + i * 2.5, 6, 1.3);
    c.fillStyle = '#8198ad';
    c.fillRect(-23, -12 + i * 2.5, 5, 0.4);
  }

  // ---- main frame and ceramic shell --------------------------------------
  plate([[-20,-11],[-13,-17],[12,-16],[22,-8],[20,7],[12,12],[-16,10],[-22,3]], darkMetal);
  // The main shell is enamel in the pilot's colour: the largest flat area on
  // the machine, so it is what an eye finds first from across the field.
  plate([[-19,-10],[-12,-16],[11,-15],[20,-8],[17,1],[-16,2]], shell, shade(hex, -0.6));
  // Facet break: pale ceramic bevel along the roofline, and a lower facet a
  // shade darker, so the hull reads as folded plate rather than a flat fill.
  plate([[-12,-16],[11,-15],[14,-12.5],[-10,-13.4]], ceramic, '#8ea3b5', 0.4);
  plate([[-16,2],[17,1],[18.6,-3.4],[-17.6,-2.2]], shade(hex, -0.42), shade(hex, -0.6), 0.4);

  // Scuffs and chips on the ceramic: seeded per colour, clipped to the shell
  // so none of them spill onto the frame.
  c.save();
  poly([[-19,-10],[-12,-16],[11,-15],[20,-8],[17,1],[-16,2]]);
  c.clip();
  for (let i = 0; i < 9; i++) {
    const x = -12 + rnd() * 30;
    const y = -14 + rnd() * 14;
    const len = 1 + rnd() * 3;
    c.strokeStyle = rnd() < 0.5 ? 'rgba(20,30,44,0.5)' : 'rgba(255,255,255,0.45)';
    c.lineWidth = 0.35;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + len, y + (rnd() - 0.5) * 1.4); c.stroke();
  }
  for (let i = 0; i < 4; i++) {
    c.fillStyle = 'rgba(40,52,66,0.55)';
    c.beginPath(); c.arc(4 + rnd() * 14, -12 + rnd() * 12, 0.35 + rnd() * 0.5, 0, TAU); c.fill();
  }
  c.restore();

  // ---- hazard-striped skirt ---------------------------------------------
  plate([[-15,3],[17,2],[15,8],[9,11],[-13,8]], '#34485c');
  c.save();
  poly([[-14,3.6],[16,2.7],[14.6,6.4],[-13.4,6.6]]);
  c.clip();
  c.fillStyle = PLATE;
  c.fillRect(-16, 2, 34, 6);
  c.fillStyle = dead ? '#6d5a2a' : HAZARD;
  for (let x = -18; x < 18; x += 3.4) {
    poly([[x, 7], [x + 1.7, 7], [x + 4.4, 2], [x + 2.7, 2]]);
    c.fill();
  }
  c.restore();
  c.strokeStyle = '#0f1820';
  c.lineWidth = 0.5;
  c.beginPath(); c.moveTo(-14, 3.6); c.lineTo(16, 2.7); c.stroke();
  // Lower armour segments under the stripe, each with a lit top edge.
  for (let i = 0; i < 5; i++) {
    const x = -12.5 + i * 5.6;
    plate([[x,6.8],[x+4.8,6.6],[x+4.2,9.6],[x+0.4,9.6]], i % 2 ? '#7f93a5' : '#a2b4c2', '#172434', 0.5);
    c.fillStyle = '#e2edf3';
    c.fillRect(x + 0.7, 7, 2.8, 0.4);
  }

  // ---- pilot colour: the enamel side panel and roof rail -----------------
  plate([[-17,-9],[-11,-14],[-3,-13],[1,-7],[-4,-0.5],[-16,0]], enamel, shade(hex, -0.6), 0.6);
  // Highlight edge along its top and a chevron decal in the plate colour.
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = 0.5;
  c.beginPath(); c.moveTo(-16.4, -8.6); c.lineTo(-10.8, -13.3); c.lineTo(-3.4, -12.4); c.stroke();
  c.fillStyle = shade(hex, -0.55);
  for (let i = 0; i < 2; i++) {
    const ox = -13 + i * 3.2;
    poly([[ox, -3], [ox + 1.6, -7], [ox + 3, -7], [ox + 1.4, -3]]);
    c.fill();
  }
  rivet(-15.2, -1.4, 0.6); rivet(-4.6, -1.8, 0.6); rivet(-11, -12.6, 0.6);

  plate([[-12,-17],[-9,-21],[7,-21],[12,-17]], ceramic);
  c.fillStyle = hex;
  c.fillRect(-8, -20, 14, 1.6);
  c.fillStyle = shade(hex, -0.5);
  c.fillRect(-8, -18.6, 14, 0.4);
  c.fillStyle = '#192b3c';
  c.fillRect(-7, -17.5, 12, 0.8);

  // ---- ammo drum on the shoulder -----------------------------------------
  // Concentric machined rings, a band in the pilot's colour, and the bases
  // of six shells visible in the magazine. It hangs at the back, over the
  // cooling module, so it does not cover the enamel the eye looks for.
  const DX = -19, DY = -2;
  for (const [radius, color] of [[4.9, OUTLINE], [4.3, '#9aafbf'], [3.5, '#2b4358']]) {
    c.beginPath(); c.arc(DX, DY, radius, 0, TAU); c.fillStyle = color; c.fill();
  }
  c.strokeStyle = shade(hex, -0.1);
  c.lineWidth = 0.7;
  c.beginPath(); c.arc(DX, DY, 3.9, 0, TAU); c.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    const sx = DX + Math.cos(a) * 2.2;
    const sy = DY + Math.sin(a) * 2.2;
    c.fillStyle = dead ? '#4a3a2a' : '#c9a85a';
    c.beginPath(); c.arc(sx, sy, 0.75, 0, TAU); c.fill();
    c.fillStyle = '#3a2c16';
    c.beginPath(); c.arc(sx, sy, 0.35, 0, TAU); c.fill();
  }
  c.fillStyle = '#13283b';
  c.beginPath(); c.arc(DX, DY, 1, 0, TAU); c.fill();
  c.strokeStyle = dead ? '#4d6470' : '#a4edfa';
  c.lineWidth = 0.5;
  c.beginPath(); c.arc(DX, DY, 4.3, -1.3, 0.6); c.stroke();

  // ---- hip housings: the legs vanish into these --------------------------
  for (const hx of [-HIP_X, HIP_X]) {
    for (const [radius, color] of [[3.7, OUTLINE], [3.1, '#4a5868'], [2, '#2a3644'], [0.9, '#7f93a5']]) {
      c.beginPath(); c.arc(hx, HIP_Y, radius, 0, TAU); c.fillStyle = color; c.fill();
    }
    c.strokeStyle = '#a3b5c4';
    c.lineWidth = 0.4;
    c.beginPath(); c.arc(hx, HIP_Y, 2.7, -2.6, -1.0); c.stroke();
  }

  // ---- rivets along the seams --------------------------------------------
  for (const [x, y] of [[-17,-1],[15,0],[13,-12],[-11,-15],[3,-15.3],[8,-15],[18,-6],[-18.5,-8]]) rivet(x, y);

  // ---- forward optical cluster -------------------------------------------
  plate([[3,-13],[15,-12],[18,-9],[15,-5],[4,-6]], '#102133');
  const glass = c.createLinearGradient(4, -12, 15, -5);
  glass.addColorStop(0, '#ecffff');
  glass.addColorStop(0.3, '#a3e7f5');
  glass.addColorStop(1, '#326786');
  plate([[5,-11],[14,-10.5],[15,-9],[13,-7],[5,-7.5]], dead ? '#273a48' : glass, '#45687d');
  c.fillStyle = '#182e42';
  c.fillRect(9, -11, 0.6, 4);
  // Brow over the visor, in hazard yellow: the "face" reads from across the
  // field, and the direction it looks is the direction it fires.
  c.fillStyle = dead ? '#5a4a22' : HAZARD;
  poly([[3.4,-13.6],[15.4,-12.6],[16.4,-11.6],[4,-12.4]]);
  c.fill();
  // Headlamp and a cheek sensor.
  c.fillStyle = OUTLINE;
  c.fillRect(15.5, -0.6, 3.4, 2.2);
  c.fillStyle = dead ? '#354c5b' : '#fff3c4';
  c.fillRect(16, -0.2, 2.4, 1.4);
  c.fillStyle = dead ? '#3a2a22' : '#ff6b5a';
  c.beginPath(); c.arc(17.2, -4, 0.7, 0, TAU); c.fill();

  // Etched service ID; the number comes from the colour so each pilot's
  // machine is its own.
  c.font = '2.3px monospace';
  c.fillStyle = '#c8dae6';
  const num = (parseInt(hex.slice(1, 7), 16) % 89) + 10;
  c.fillText(`LB-${num}`, 5, 1);
  c.strokeStyle = '#e7f2f970';
  c.lineWidth = 0.5;
  c.beginPath(); c.moveTo(-18, -10); c.lineTo(-12, -15); c.lineTo(10, -14); c.stroke();
  // Grime pooling under the overhangs.
  c.fillStyle = 'rgba(14,20,28,0.28)';
  c.fillRect(-15, 1.8, 31, 0.9);

  if (dead) {
    // Burn the whole thing down: a scorch heaviest round the hole, then a
    // general char so no colour is bright any more.
    c.globalCompositeOperation = 'source-atop';
    const scorch = c.createRadialGradient(-2, -4, 2, -2, -4, 26);
    scorch.addColorStop(0, 'rgba(6,5,6,0.92)');
    scorch.addColorStop(0.45, 'rgba(18,14,14,0.75)');
    scorch.addColorStop(1, 'rgba(14,14,18,0.5)');
    c.fillStyle = scorch;
    c.fillRect(-SP_OX, -SP_OY, SP_W, SP_H);
    // Heat tint near the hole.
    c.fillStyle = 'rgba(120,60,30,0.18)';
    c.beginPath(); c.arc(-2, -4, 11, 0, TAU); c.fill();
    c.globalCompositeOperation = 'source-over';
    // The hole, with a torn, jagged rim.
    const rim = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      const r = (i % 2 ? 4.6 : 7.4) + rnd() * 1.2;
      rim.push([-2 + Math.cos(a) * r, -4 + Math.sin(a) * r * 0.9]);
    }
    plate(rim, '#0b0b0e', '#5a3a28', 0.9);
    // Glowing seams cracked across the hull.
    c.strokeStyle = 'rgba(255,120,50,0.5)';
    c.lineWidth = 0.45;
    c.beginPath();
    c.moveTo(4, -5); c.lineTo(9, -8); c.lineTo(13, -6);
    c.moveTo(-7, -1); c.lineTo(-12, 3);
    c.moveTo(-1, -11); c.lineTo(1, -16);
    c.stroke();
  }

  c.setTransform(1, 0, 0, 1, 0, 0);
  return cv;
}

/**
 * The barrel, baked: hub at the origin, muzzle at +BARREL_LEN, pointing +x.
 * Rounded steel tube with a pilot-colour inlay along the top rail, cooling
 * slots, a heat-shroud sleeve and a slotted muzzle brake whose face IS the
 * muzzle. The hub's machined rings sit over the root. A wreck's barrel is the
 * same drawing, charred and with a bent, blackened tip.
 */
function bakeBarrel(hex, dead, ss = SS) {
  const cv = document.createElement('canvas');
  cv.width = BR_W * ss;
  cv.height = BR_H * ss;
  const c = cv.getContext('2d');
  c.setTransform(ss, 0, 0, ss, -BR_X0 * ss, (BR_H / 2) * ss);
  const L = BARREL_LEN;

  const tube = c.createLinearGradient(0, -3.2, 0, 3.2);
  tube.addColorStop(0, '#e2ebf0');
  tube.addColorStop(0.3, '#9cafc1');
  tube.addColorStop(0.55, '#465c73');
  tube.addColorStop(1, '#22374d');

  // Outline pass for the whole gun.
  c.fillStyle = OUTLINE;
  roundRect(c, 1, -4, L - 0.5, 8, 1.6);
  c.fill();

  c.fillStyle = tube;
  roundRect(c, 2, -3.1, L - 2, 6.2, 1);
  c.fill();
  // Heat-shroud sleeve over the root third, darker, with its own lip.
  c.fillStyle = '#2c3d50';
  c.fillRect(4, -3.6, 9, 7.2);
  c.fillStyle = '#8fa4b6';
  c.fillRect(4, -3.6, 9, 0.8);
  for (let x = 5.5; x < 12.5; x += 2.2) {
    c.fillStyle = '#101d2b';
    c.fillRect(x, -2.2, 1.1, 4.4);
  }
  // Upper rail with the pilot's inlay.
  c.fillStyle = '#152c41';
  c.fillRect(13, -4.2, L - 19, 1.4);
  c.fillStyle = hex;
  c.fillRect(14, -3.95, L - 21, 0.8);
  // Cooling slots down the tube.
  for (let x = 15; x < L - 8; x += 3) {
    c.fillStyle = '#192e43'; c.fillRect(x, -0.6, 1.5, 2.4);
    c.fillStyle = '#b0c2d0'; c.fillRect(x, -0.6, 0.4, 2);
  }
  // Muzzle brake: a block wider than the tube with two vent slots. Its face
  // is at exactly L, so the shell visibly leaves the tip.
  c.fillStyle = OUTLINE;
  c.fillRect(L - 6.6, -4.6, 6.6, 9.2);
  c.fillStyle = '#6d849b';
  c.fillRect(L - 6, -4, 5.4, 8);
  c.fillStyle = '#d3e3ec';
  c.fillRect(L - 5.6, -3.6, 4.4, 0.8);
  c.fillStyle = '#0c1c2e';
  c.fillRect(L - 4.8, -4, 1.1, 2.6);
  c.fillRect(L - 4.8, 1.4, 1.1, 2.6);
  c.fillRect(L - 1, -2.4, 1, 4.8);

  // The hub.
  for (const [radius, color] of [[7.4, OUTLINE], [6.4, '#a9bccb'], [5.1, '#465f77'], [3.7, '#182e44'], [2, '#96b6cd']]) {
    c.beginPath(); c.arc(0, 0, radius, 0, TAU); c.fillStyle = color; c.fill();
  }
  c.strokeStyle = dead ? '#4d6470' : '#c9f5ff';
  c.lineWidth = 0.8;
  c.beginPath(); c.arc(0, 0, 4.4, -2.7, -0.5); c.stroke();
  c.strokeStyle = hex;
  c.lineWidth = 0.6;
  c.beginPath(); c.arc(0, 0, 5.75, 0.4, 2.4); c.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + 0.4;
    c.fillStyle = '#233e55';
    c.beginPath(); c.arc(Math.cos(a) * 5.75, Math.sin(a) * 5.75, 0.55, 0, TAU); c.fill();
  }

  if (dead) {
    c.globalCompositeOperation = 'source-atop';
    const char = c.createLinearGradient(BR_X0, 0, L, 0);
    char.addColorStop(0, 'rgba(10,9,10,0.85)');
    char.addColorStop(0.6, 'rgba(18,15,15,0.62)');
    char.addColorStop(1, 'rgba(6,5,6,0.9)');
    c.fillStyle = char;
    c.fillRect(BR_X0, -BR_H / 2, BR_W, BR_H);
    c.globalCompositeOperation = 'source-over';
    // Ripped off at the hub: a jagged dark break where it tore free.
    c.fillStyle = '#0b0b0e';
    c.beginPath();
    c.moveTo(-3, -7); c.lineTo(-1, -3); c.lineTo(-4, 0); c.lineTo(-1, 3); c.lineTo(-3, 7);
    c.lineTo(-9, 7); c.lineTo(-9, -7);
    c.closePath();
    c.globalCompositeOperation = 'destination-out';
    c.fill();
    c.globalCompositeOperation = 'source-over';
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

/**
 * Shared menu portrait: the actual battlefield model, at presentation scale.
 * Baked at a higher oversample than the field sprite because the hero is
 * drawn five times life size and a 4x bake would go soft at that scale.
 */
export function drawMechPortrait(canvas, hex, hero = false) {
  const w = hero ? 640 : 160;
  const h = hero ? 400 : 120;
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (hero) {
    const light = c.createRadialGradient(320, 220, 12, 320, 220, 235);
    light.addColorStop(0, '#66dbc32b'); light.addColorStop(1, '#66dbc300');
    c.fillStyle = light; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#90b7c322'; c.lineWidth = 1;
    for (let r = 90; r < 240; r += 55) {
      c.beginPath(); c.ellipse(320, 326, r, r * 0.23, 0, 0, TAU); c.stroke();
    }
  }
  const scale = hero ? 4.6 : 1.7;
  c.translate(w / 2, hero ? 326 : 110);
  c.scale(scale, scale);
  drawLive(c, { x: 0, y: 0, angle: 28, tilt: -0.04, recoil: 0 }, bakeSkin(hex, hero ? 12 : SS), null);
}
