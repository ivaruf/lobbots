/*
 * ballistics.js — how a shell moves, and how we find out what it hit.
 *
 * One projectile is a plain object (see makeProjectile). sweep() advances it
 * by one fixed step under gravity and wind and walks the movement in SWEEP_STEP
 * px pieces, testing ground and mech hit-circles at each, so a fast shell
 * cannot tunnel through a thin ridge or a mech. The first contact wins and the
 * projectile is left sitting on it.
 *
 * The side edges are a game option (settings.offscreen). The top is always
 * open: a shell lobbed off the top of the field is still a shell, it is
 * simply somewhere the camera is not, and it comes back down on the same
 * arithmetic. The renderer shows a marker; nothing here cares.
 *
 * The vacuum solver at the bottom is for the AI. It deliberately ignores
 * wind: an artillery player's first guess ignores wind too, and the point of
 * the AI (ARCHITECTURE.md §8) is that it is wrong the same way a person is,
 * then corrects.
 */

import {
  WIDTH, HEIGHT, MECH_RADIUS, BODY_LIFT, SWEEP_STEP, TRAIL_SPACING,
  PROJECTILE_MAX_AGE, OPEN_MARGIN, SPEED_PER_POWER, WIND_UNIT,
} from '../config.js';

/** Angle (deg, 0 right / 90 up / 180 left) and power to a launch velocity. */
export function launchVelocity(angleDeg, power, speedScale = 1) {
  const a = (angleDeg * Math.PI) / 180;
  const v = power * SPEED_PER_POWER * speedScale;
  return { vx: Math.cos(a) * v, vy: -Math.sin(a) * v };
}

/** A fresh projectile. `weapon` is a CATALOG entry, kept by reference. */
export function makeProjectile(id, weapon, ownerId, x, y, vx, vy) {
  return {
    id,
    weaponId: weapon.id,
    weapon,
    ownerId,
    x, y, vx, vy,
    prevVy: vy,
    age: 0,
    alive: true,
    /** Set for one step when vy crosses from up to down. */
    apex: false,
    /** True after the projectile has passed its apex at least once. */
    pastApex: false,
    /** Behaviour scratch space (bounces left, rolling flag...). */
    state: {},
    /** Rendering: points along the flight, one per TRAIL_SPACING px.
     *  A null entry is a break (a wrap). */
    trail: [{ x, y }],
    sinceTrail: 0,
    /** Ground checks off while burrowing. */
    ignoreTerrain: false,
    /** Scales per weapon. */
    gravityScale: weapon.gravityScale ?? 1,
    windScale: weapon.windScale ?? 1,
    radius: weapon.projRadius ?? 3,
  };
}

/**
 * Advance `p` by dt through `world` (needs .settings, .wind, .terrain,
 * .mechs). Returns null, or a hit:
 *   { type: 'terrain', x, y }
 *   { type: 'mech', x, y, mech }
 *   { type: 'exit', x, y }      left the field for good
 */
export function sweep(p, world, dt) {
  const s = world.settings;
  p.age += dt;
  if (p.age > PROJECTILE_MAX_AGE) return { type: 'exit', x: p.x, y: p.y };

  // Semi-implicit Euler: velocity first, then position with the new velocity.
  p.prevVy = p.vy;
  p.vx += world.wind * WIND_UNIT * p.windScale * dt;
  p.vy += s.gravity * p.gravityScale * dt;
  p.apex = p.prevVy < 0 && p.vy >= 0;
  if (p.apex) p.pastApex = true;

  const dx = p.vx * dt;
  const dy = p.vy * dt;
  const dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(dist / SWEEP_STEP));
  const sx = dx / n, sy = dy / n;

  for (let i = 0; i < n; i++) {
    p.x += sx;
    p.y += sy;
    p.sinceTrail += dist / n;
    if (p.sinceTrail >= TRAIL_SPACING) {
      p.sinceTrail = 0;
      p.trail.push({ x: p.x, y: p.y });
    }

    // Side edges.
    if (p.x < 0 || p.x > WIDTH) {
      const edge = edgeRule(p, s.offscreen);
      if (edge === 'exit') return { type: 'exit', x: p.x, y: p.y };
    }
    // Below the floor outside the field (inside it, bedrock catches it first).
    if (p.y > HEIGHT + 60) return { type: 'exit', x: p.x, y: p.y };

    // Mechs first: a shell that clips a mech standing on a ridge is a hit,
    // not a crater beside it.
    const mech = mechAt(world.mechs, p.x, p.y, p.radius);
    if (mech) return { type: 'mech', x: p.x, y: p.y, mech };

    if (!p.ignoreTerrain && world.terrain.solidAt(p.x, p.y)) {
      return { type: 'terrain', x: p.x, y: p.y };
    }
  }
  return null;
}

/** Apply the side-edge rule in place. Returns 'exit' when the shell is gone. */
function edgeRule(p, rule) {
  if (rule === 'vanish') return 'exit';
  if (rule === 'wrap') {
    if (p.x < 0) p.x += WIDTH;
    else p.x -= WIDTH;
    p.trail.push(null, { x: p.x, y: p.y });
    return 'wrapped';
  }
  if (rule === 'bounce') {
    if (p.x < 0) p.x = -p.x;
    else p.x = 2 * WIDTH - p.x;
    p.vx = -p.vx * 0.8;
    return 'bounced';
  }
  // 'open': keep flying, but not forever.
  if (p.x < -OPEN_MARGIN || p.x > WIDTH + OPEN_MARGIN) return 'exit';
  return 'open';
}

/** The first living mech whose hit circle contains (x, y), padded by r. */
export function mechAt(mechs, x, y, r = 0) {
  const reach = MECH_RADIUS + r;
  for (const m of mechs) {
    if (!m.alive) continue;
    const cx = m.x, cy = m.y - BODY_LIFT;
    const ddx = x - cx, ddy = y - cy;
    if (ddx * ddx + ddy * ddy <= reach * reach) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vacuum solutions, for the AI's first guess
// ---------------------------------------------------------------------------

/**
 * Power needed to land at horizontal distance `dx` (> 0) and height `dyUp`
 * (positive = target higher) when firing at `elev` degrees above horizontal,
 * ignoring wind. Returns null when that elevation cannot reach the point.
 */
export function powerForElevation(dx, dyUp, elev, gravity, speedScale = 1) {
  const a = (elev * Math.PI) / 180;
  const cos = Math.cos(a);
  const denom = 2 * cos * cos * (dx * Math.tan(a) - dyUp);
  if (denom <= 0) return null;
  const v2 = (gravity * dx * dx) / denom;
  if (!(v2 > 0)) return null;
  return Math.sqrt(v2) / (SPEED_PER_POWER * speedScale);
}

/** Time of flight in a vacuum for a launch, until it returns to launch height. */
export function hangTime(elev, power, gravity, speedScale = 1) {
  const v = power * SPEED_PER_POWER * speedScale;
  return (2 * v * Math.sin((elev * Math.PI) / 180)) / gravity;
}
