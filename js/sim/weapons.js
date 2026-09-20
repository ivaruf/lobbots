/*
 * weapons.js — the catalog, and the handful of behaviours it is built from.
 *
 * A weapon is DATA. Adding one is adding an object to CATALOG. Only when a
 * weapon genuinely moves or lands in a new way does a function get written,
 * and it goes in one of two registries:
 *
 *   FLIGHT[name]   how the projectile moves and what it does on contact
 *                    move(p, world, dt) -> hit | null    (default: ballistic sweep)
 *                    onApex(p, world)                   (optional)
 *                    onHit(p, world, hit)               (required; usually ends p)
 *   IMPACT[name]   what happens where it stops: a crater, a mound, a scatter
 *                    (p, world, x, y)
 *
 * Every projectile's contact ends in world.explode(), world.mound() or
 * world.spawn() — the world owns damage, terrain and events; behaviours only
 * decide what to ask for. Behaviours draw randomness from world.rng so they
 * stay replayable.
 *
 * Milestone 1 ships fourteen of the prompt's arsenal. Laser, Heavy Laser,
 * Homing Missile and Air Strike need a target the UI does not yet collect,
 * so they wait; guidance and defence items likewise. Their slots are noted
 * at the bottom so the shop's breadth is a matter of filling in objects.
 */

import { sweep } from './ballistics.js';
import { range, gauss } from './rng.js';

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * Fields:
 *   id, name, desc          what the shop shows
 *   price, pack             bolts per purchase and rounds it buys; pack Infinity = unlimited
 *   category                'shell' | 'special' | 'terrain' | 'heavy' | 'guidance' | 'defence'
 *   flight, impact          registry names
 *   radius, damage          blast radius px and damage at the centre
 *   terrain                 'crater' | 'fill' | 'none' | 'scoop'
 *   props                   behaviour knobs
 *   icon                    key for the UI's procedural icon set
 *   hidden                  true for child munitions the shop never lists
 *   shake                   0..1, how much the screen should jolt (renderer reads it)
 */
export const CATALOG = [
  {
    id: 'shell', name: 'Shell', desc: 'The one you always have. Small, honest, free.',
    price: 0, pack: Infinity, category: 'shell', flight: 'ballistic', impact: 'explode',
    radius: 26, damage: 30, terrain: 'crater', props: {}, icon: 'shell', shake: 0.15,
  },
  {
    id: 'heavy', name: 'Heavy Shell', desc: 'Same arc, twice the hole.',
    price: 300, pack: 3, category: 'shell', flight: 'ballistic', impact: 'explode',
    radius: 40, damage: 45, terrain: 'crater', props: {}, icon: 'shell-heavy', shake: 0.35,
  },
  {
    id: 'mega', name: 'Mega Shell', desc: 'A conventional explosion that stops being polite.',
    price: 900, pack: 2, category: 'heavy', flight: 'ballistic', impact: 'explode',
    radius: 62, damage: 70, terrain: 'crater', props: {}, icon: 'shell-mega', shake: 0.6,
  },
  {
    id: 'cluster', name: 'Cluster Bomb', desc: 'Pops on impact into six bomblets that do the real work.',
    price: 600, pack: 3, category: 'special', flight: 'ballistic', impact: 'scatter',
    radius: 22, damage: 18, terrain: 'crater',
    props: { child: 'bomblet', count: 6, spread: 240, up: 420, delay: 0 }, icon: 'cluster', shake: 0.3,
  },
  {
    id: 'mirv', name: 'MIRV', desc: 'Splits at the top of its arc into five warheads. Bring an umbrella.',
    price: 1200, pack: 2, category: 'special', flight: 'mirv', impact: 'explode',
    radius: 30, damage: 32, terrain: 'crater',
    props: { child: 'mirv-head', count: 5, spread: 130 }, icon: 'mirv', shake: 0.4,
  },
  {
    id: 'roller', name: 'Roller', desc: 'Lands, then rolls downhill until it finds someone.',
    price: 500, pack: 3, category: 'special', flight: 'roller', impact: 'explode',
    radius: 34, damage: 40, terrain: 'crater',
    props: { rollAccel: 520, maxSpeed: 340, fuse: 6 }, icon: 'roller', shake: 0.3,
  },
  {
    id: 'bouncer', name: 'Bouncer', desc: 'Three bounces, then it makes up its mind.',
    price: 400, pack: 3, category: 'special', flight: 'bouncer', impact: 'explode',
    radius: 32, damage: 36, terrain: 'crater',
    props: { bounces: 3, restitution: 0.62 }, icon: 'bouncer', shake: 0.3,
  },
  {
    id: 'dirt', name: 'Dirt Bomb', desc: 'Builds a hill where it lands. Bury a rival, or yourself.',
    price: 250, pack: 3, category: 'terrain', flight: 'ballistic', impact: 'mound',
    radius: 56, damage: 0, terrain: 'fill', props: {}, icon: 'dirt', shake: 0.1,
  },
  {
    id: 'earthmover', name: 'Earth Mover', desc: 'Scoops a bowl out and piles it up either side.',
    price: 450, pack: 2, category: 'terrain', flight: 'ballistic', impact: 'scoop',
    radius: 70, damage: 8, terrain: 'scoop', props: {}, icon: 'earthmover', shake: 0.3,
  },
  {
    id: 'burrower', name: 'Burrower', desc: 'Goes into the hill and keeps going. Detonates deep.',
    price: 700, pack: 3, category: 'special', flight: 'burrower', impact: 'explode',
    radius: 46, damage: 52, terrain: 'crater',
    props: { depth: 95, speed: 260 }, icon: 'burrower', shake: 0.4,
  },
  {
    id: 'napalm', name: 'Napalm', desc: 'Splashes burning fuel across the slope. Digs nothing, hurts plenty.',
    price: 900, pack: 2, category: 'heavy', flight: 'ballistic', impact: 'scatter',
    radius: 18, damage: 8, terrain: 'none',
    props: { child: 'fire', count: 9, spread: 260, up: 260, delay: 0 }, icon: 'napalm', shake: 0.3,
  },
  {
    id: 'volcano', name: 'Volcano', desc: 'Erupts from the crater: seven hot rocks straight up and out.',
    price: 1000, pack: 2, category: 'heavy', flight: 'ballistic', impact: 'scatter',
    radius: 30, damage: 25, terrain: 'crater',
    props: { child: 'lava-rock', count: 7, spread: 200, up: 700, delay: 0.05 }, icon: 'volcano', shake: 0.5,
  },
  {
    id: 'funky', name: 'Funky Bomb', desc: 'Bounces however it feels like and sheds sparks on every hop. Glorious.',
    price: 800, pack: 2, category: 'special', flight: 'funky', impact: 'explode',
    radius: 36, damage: 34, terrain: 'crater',
    props: { bounces: 4, child: 'spark', perBounce: 2 }, icon: 'funky', shake: 0.35,
  },
  {
    id: 'nuke', name: 'Nuke', desc: 'Removes the hill. And most of the neighbourhood. Visually unreasonable.',
    price: 5000, pack: 1, category: 'heavy', flight: 'ballistic', impact: 'explode',
    radius: 150, damage: 200, terrain: 'crater', props: {}, icon: 'nuke', shake: 1,
  },

  // ---- child munitions: never in the shop -------------------------------
  {
    id: 'bomblet', name: 'Bomblet', desc: '', price: 0, pack: 0, category: 'child', hidden: true,
    flight: 'ballistic', impact: 'explode', radius: 20, damage: 22, terrain: 'crater', props: {}, icon: 'shell', shake: 0.15,
  },
  {
    id: 'mirv-head', name: 'MIRV warhead', desc: '', price: 0, pack: 0, category: 'child', hidden: true,
    flight: 'ballistic', impact: 'explode', radius: 30, damage: 32, terrain: 'crater', props: {}, icon: 'shell', shake: 0.25,
  },
  {
    id: 'fire', name: 'Fire', desc: '', price: 0, pack: 0, category: 'child', hidden: true,
    flight: 'ballistic', impact: 'explode', radius: 30, damage: 14, terrain: 'none', props: {}, icon: 'napalm', shake: 0.05,
    windScale: 1.6, gravityScale: 0.9,
  },
  {
    id: 'lava-rock', name: 'Lava rock', desc: '', price: 0, pack: 0, category: 'child', hidden: true,
    flight: 'ballistic', impact: 'explode', radius: 26, damage: 24, terrain: 'crater', props: {}, icon: 'volcano', shake: 0.2,
  },
  {
    id: 'spark', name: 'Spark', desc: '', price: 0, pack: 0, category: 'child', hidden: true,
    flight: 'ballistic', impact: 'explode', radius: 16, damage: 12, terrain: 'crater', props: {}, icon: 'funky', shake: 0.1,
  },
];

/** id -> weapon. */
export const WEAPONS = Object.fromEntries(CATALOG.map((w) => [w.id, w]));

/** What the shop lists, in catalog order. */
export const SHOP_ITEMS = CATALOG.filter((w) => !w.hidden && w.price > 0);

export function weaponById(id) {
  return WEAPONS[id] || WEAPONS.shell;
}

// ---------------------------------------------------------------------------
// Impact behaviours: (p, world, x, y)
// ---------------------------------------------------------------------------

export const IMPACT = {
  /** A blast: damage in a radius and, per `terrain`, a crater or nothing. */
  explode(p, world, x, y) {
    world.explode(x, y, p.weapon, p.ownerId);
  },

  /** The dirt bomb: no damage, a mound. */
  mound(p, world, x, y) {
    world.mound(x, y, p.weapon.radius, p.weapon, p.ownerId);
  },

  /** Earth mover: a bowl with shoulders, a small blast for anyone in it. */
  scoop(p, world, x, y) {
    world.explode(x, y, p.weapon, p.ownerId);
  },

  /**
   * Cluster, napalm and volcano: a blast of its own, then `count` children
   * thrown upward and outward. `up` is the vertical speed, `spread` the
   * horizontal range either side; both jittered.
   */
  scatter(p, world, x, y) {
    world.explode(x, y, p.weapon, p.ownerId);
    const { child, count, spread, up, delay } = p.weapon.props;
    const rng = world.rng;
    for (let i = 0; i < count; i++) {
      // Fan them so a cluster never lands as one lump.
      const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
      const vx = t * spread * range(rng, 0.6, 1.0) + gauss(rng) * spread * 0.12;
      const vy = -up * range(rng, 0.75, 1.15);
      world.spawn(child, p.ownerId, x, y - 4, vx, vy, delay * i);
    }
  },
};

// ---------------------------------------------------------------------------
// Flight behaviours
// ---------------------------------------------------------------------------

/** The standard: fly, hit, resolve the impact, done. */
function ballisticHit(p, world, hit) {
  if (hit.type === 'exit') { world.lose(p, 'offscreen'); return; }
  IMPACT[p.weapon.impact](p, world, hit.x, hit.y);
  world.retire(p, hit.type);
}

export const FLIGHT = {
  ballistic: {
    move: sweep,
    onHit: ballisticHit,
  },

  /** Splits at the apex into `count` warheads spread across the wind. */
  mirv: {
    move: sweep,
    onApex(p, world) {
      const { child, count, spread } = p.weapon.props;
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
        world.spawn(child, p.ownerId, p.x, p.y, p.vx + t * spread, p.vy, 0);
      }
      world.split(p, count);
      world.retire(p, 'split');
    },
    onHit: ballisticHit,
  },

  /**
   * Lands, then rolls along the surface downhill, following the ground and
   * dropping off ledges, until a mech is under it, the fuse runs out, or it
   * leaves the field. A roller rolling uphill slows and comes back: it is a
   * ball, not a car.
   */
  roller: {
    move(p, world, dt) {
      const st = p.state;
      if (!st.rolling) return sweep(p, world, dt);

      const { rollAccel, maxSpeed, fuse } = p.weapon.props;
      st.fuse -= dt;
      if (st.fuse <= 0) return { type: 'terrain', x: p.x, y: p.y };

      const terrain = world.terrain;
      const slope = terrain.slopeAt(p.x); // dy/dx, y down: >0 means downhill to the right
      // Gravity along the slope. Speed is signed along x.
      st.speed += rollAccel * slope * dt;
      st.speed *= 1 - 0.6 * dt; // rolling friction
      if (st.speed > maxSpeed) st.speed = maxSpeed;
      if (st.speed < -maxSpeed) st.speed = -maxSpeed;

      const dx = st.speed * dt;
      const steps = Math.max(1, Math.ceil(Math.abs(dx) / 2));
      for (let i = 0; i < steps; i++) {
        p.x += dx / steps;
        if (p.x < 0 || p.x > world.terrain.width) return { type: 'exit', x: p.x, y: p.y };
        // Follow the ground: climb up if we rolled into it, or fall if the
        // ground dropped away by more than a step.
        const surface = terrain.groundBelow(p.x, p.y - 12);
        if (surface > p.y + 6) {
          // Off a ledge: back to flight with our rolling speed.
          st.rolling = false;
          p.vx = st.speed;
          p.vy = 0;
          return null;
        }
        p.y = surface - 1;
        p.sinceTrail += Math.abs(dx / steps);
        if (p.sinceTrail >= 6) { p.sinceTrail = 0; p.trail.push({ x: p.x, y: p.y }); }
        const m = world.mechNear(p.x, p.y, p.radius + 2);
        if (m) return { type: 'mech', x: p.x, y: p.y, mech: m };
      }
      // Rolled to a stop in a dip: no point waiting for the fuse.
      if (Math.abs(st.speed) < 4 && Math.abs(slope) < 0.02 && st.fuse < fuse - 1) {
        return { type: 'terrain', x: p.x, y: p.y };
      }
      return null;
    },
    onHit(p, world, hit) {
      const st = p.state;
      if (hit.type === 'terrain' && !st.rolling && !st.landed) {
        // First touchdown: start rolling in the direction we were travelling,
        // keeping some of the horizontal speed.
        st.landed = true;
        st.rolling = true;
        st.speed = p.vx * 0.5;
        st.fuse = p.weapon.props.fuse;
        p.y = world.terrain.groundBelow(p.x, p.y - 12) - 1;
        world.bounce(p);
        return;
      }
      ballisticHit(p, world, hit);
    },
  },

  /** Reflects off the ground `bounces` times, then explodes. */
  bouncer: {
    move: sweep,
    onHit(p, world, hit) {
      if (hit.type !== 'terrain') { ballisticHit(p, world, hit); return; }
      const st = p.state;
      st.left = st.left ?? p.weapon.props.bounces;
      if (st.left <= 0) { ballisticHit(p, world, hit); return; }
      st.left--;
      reflect(p, world, p.weapon.props.restitution);
      world.bounce(p);
    },
  },

  /**
   * The funky bomb: bounces with a random restitution, wanders sideways,
   * sheds sparks at every hop, and goes off when it runs out of hops.
   */
  funky: {
    move: sweep,
    onHit(p, world, hit) {
      if (hit.type !== 'terrain') { ballisticHit(p, world, hit); return; }
      const st = p.state;
      st.left = st.left ?? p.weapon.props.bounces;
      if (st.left <= 0) { ballisticHit(p, world, hit); return; }
      st.left--;
      const rng = world.rng;
      reflect(p, world, range(rng, 0.5, 0.95));
      p.vx += gauss(rng) * 120;
      p.vy -= range(rng, 0, 160);
      const { child, perBounce } = p.weapon.props;
      for (let i = 0; i < perBounce; i++) {
        world.spawn(child, p.ownerId, p.x, p.y - 2, gauss(rng) * 160, -range(rng, 120, 360), 0);
      }
      world.bounce(p);
    },
  },

  /**
   * On contact with ground it stops obeying gravity and drives straight on
   * through the hill for `depth` px, then detonates. Breaking back out into
   * air before that also detonates it — no free tunnels.
   */
  burrower: {
    move(p, world, dt) {
      const st = p.state;
      if (!st.burrowing) return sweep(p, world, dt);
      const { speed } = p.weapon.props;
      const d = speed * dt;
      const steps = Math.max(1, Math.ceil(d / 2));
      for (let i = 0; i < steps; i++) {
        p.x += st.dx * (d / steps);
        p.y += st.dy * (d / steps);
        st.travelled += d / steps;
        p.sinceTrail += d / steps;
        if (p.sinceTrail >= 6) { p.sinceTrail = 0; p.trail.push({ x: p.x, y: p.y }); }
        const m = world.mechNear(p.x, p.y, p.radius);
        if (m) return { type: 'mech', x: p.x, y: p.y, mech: m };
        if (st.travelled >= p.weapon.props.depth) return { type: 'terrain', x: p.x, y: p.y };
        if (!world.terrain.solidAt(p.x, p.y) && st.travelled > 6) return { type: 'terrain', x: p.x, y: p.y };
        if (p.x < 0 || p.x > world.terrain.width) return { type: 'exit', x: p.x, y: p.y };
      }
      return null;
    },
    onHit(p, world, hit) {
      const st = p.state;
      if (hit.type === 'terrain' && !st.burrowing && !st.done) {
        st.burrowing = true;
        p.ignoreTerrain = true;
        const len = Math.hypot(p.vx, p.vy) || 1;
        st.dx = p.vx / len;
        st.dy = p.vy / len;
        st.travelled = 0;
        world.bounce(p);
        return;
      }
      st.done = true;
      ballisticHit(p, world, hit);
    },
  },
};

/** Mirror the velocity about the local ground normal and damp it. */
function reflect(p, world, restitution) {
  const { nx, ny } = world.terrain.normalAt(p.x, p.y);
  const dot = p.vx * nx + p.vy * ny;
  p.vx = (p.vx - 2 * dot * nx) * restitution;
  p.vy = (p.vy - 2 * dot * ny) * restitution;
  // Step out of the ground so the next sweep does not hit the same pixel.
  p.x += nx * 4;
  p.y += ny * 4;
  p.trail.push({ x: p.x, y: p.y });
}

/*
 * NEXT (not in Milestone 1), each one object plus at most one behaviour:
 *   laser / heavy-laser    flight 'beam': instant segment from the muzzle, damage along it
 *   homing                 flight 'homing': ballistic with steering toward action.target
 *   airstrike              flight 'drop': spawns children above action.target x
 *   gopher-bomb            flight 'tunnel': dives, travels under the ground, erupts under the nearest rival
 *   targeting / homing-kit category 'guidance'; armour / shield / jets category 'defence'
 */
