/*
 * world.js — one round of the battlefield: the hill, the mechs standing on
 * it, the wind, and whatever is in the air.
 *
 * The World owns everything that has a position. It does not know about
 * turns, money or players beyond an id: match.js decides who fires, the
 * World decides what happens when they do. Every consequence — a blast, a
 * crater, a mech losing health, a mech falling — is done here and announced
 * on the events array handed to step(), so the renderer and the match learn
 * about it the same way and neither has to poll for it.
 *
 * A round's World is thrown away when the round ends; the next round makes
 * a new one from the next derived seed (ARCHITECTURE.md §3).
 */

import {
  WIDTH, HEIGHT, BEDROCK, MECH_RADIUS, FOOT_W, BODY_LIFT, BARREL_LEN,
  FALL_DAMAGE_FROM, FALL_DAMAGE_PER_PX, TERRAIN_SHADOW, SELF_DAMAGE_SCALE,
} from '../config.js';
import { Terrain, chooseProfile } from './terrain.js';
import { launchVelocity, makeProjectile, mechAt } from './ballistics.js';
import { FLIGHT, weaponById } from './weapons.js';
import { range, shuffle } from './rng.js';

export class World {
  /**
   * @param settings  resolved settings (config.resolveSettings)
   * @param rng       this round's seeded generator
   */
  constructor(settings, rng) {
    this.settings = settings;
    this.rng = rng;
    this.terrain = null;
    this.profileId = null;
    /** @type {Array<object>} */
    this.mechs = [];
    /** @type {Array<object>} */
    this.projectiles = [];
    /** Children waiting on a delay: { delay, weaponId, ownerId, x, y, vx, vy } */
    this.pending = [];
    this.wind = 0;
    this.time = 0;
    this.nextId = 1;
    /** The events array for the current step; set by step(). */
    this.events = [];
    /** Damage records since the last drain: { by, to, amount, kill } */
    this.ledger = [];
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Generate the hill and stand one mech per player on it. `players` are
   * match players: { id, team, angle, power, weaponId, armour }. Seat order
   * is shuffled across the spawn spots so the same seat is not always on the
   * left.
   */
  setup(players) {
    this.profileId = chooseProfile(this.rng, this.settings.terrainProfile);
    this.terrain = Terrain.generate(this.rng, this.profileId);
    const spots = this.terrain.placeMechs(players.length, this.rng);
    const order = shuffle(this.rng, players.map((_, i) => i));
    this.mechs = players.map((pl, i) => {
      const x = spots[order[i]];
      const y = this.terrain.surfaceAt(x);
      return {
        id: pl.id,
        playerId: pl.id,
        team: pl.team,
        x,
        y,                 // feet
        vy: 0,
        falling: false,
        fallFrom: y,
        tilt: 0,
        health: this.settings.startHealth + (pl.armour || 0),
        maxHealth: this.settings.startHealth + (pl.armour || 0),
        shield: pl.shield || 0,
        alive: true,
        // Aim is the player's, remembered between turns; mirrored here so
        // the renderer can draw every barrel from one list.
        angle: pl.angle,
        power: pl.power,
        weaponId: pl.weaponId,
        recoil: 0,         // renderer decays this; sim only sets it on fire
      };
    });
    for (const m of this.mechs) this.updateTilt(m);
    this.rollWind();
  }

  /** New wind inside ±windMax, whole numbers so the HUD can print it. */
  rollWind() {
    const max = this.settings.windMax;
    this.wind = max > 0 ? Math.round(range(this.rng, -max, max)) : 0;
    return this.wind;
  }

  mechFor(playerId) {
    return this.mechs.find((m) => m.playerId === playerId) || null;
  }

  aliveMechs() {
    return this.mechs.filter((m) => m.alive);
  }

  /** Distinct teams with a living mech. */
  aliveTeams() {
    const teams = new Set();
    for (const m of this.mechs) if (m.alive) teams.add(m.team);
    return teams;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  /** Where the shell leaves the barrel for this mech at this angle. */
  muzzle(mech, angleDeg) {
    const a = (angleDeg * Math.PI) / 180;
    return {
      x: mech.x + Math.cos(a) * BARREL_LEN,
      y: mech.y - BODY_LIFT - Math.sin(a) * BARREL_LEN,
    };
  }

  /**
   * Fire `weaponId` from a player's mech. Returns the projectile, or null if
   * the mech is dead. Ammo is the match's business; this just launches.
   */
  fire(playerId, weaponId, angle, power) {
    const mech = this.mechFor(playerId);
    if (!mech || !mech.alive) return null;
    const weapon = weaponById(weaponId);
    mech.angle = angle;
    mech.power = power;
    mech.weaponId = weaponId;
    mech.recoil = 1;
    const m = this.muzzle(mech, angle);
    const { vx, vy } = launchVelocity(angle, power, weapon.speedScale ?? 1);
    const p = makeProjectile(this.nextId++, weapon, playerId, m.x, m.y, vx, vy);
    this.projectiles.push(p);
    this.events.push({ type: 'fire', playerId, weaponId, x: m.x, y: m.y, angle, power });
    this.events.push({ type: 'projectileSpawn', id: p.id, weaponId });
    return p;
  }

  /** A child munition, now or after `delay` seconds. */
  spawn(weaponId, ownerId, x, y, vx, vy, delay = 0) {
    if (delay > 0) {
      this.pending.push({ delay, weaponId, ownerId, x, y, vx, vy });
      return null;
    }
    const weapon = weaponById(weaponId);
    const p = makeProjectile(this.nextId++, weapon, ownerId, x, y, vx, vy);
    // A child starting inside ground (a volcano rock, say) must not detonate
    // on the ground it was born in: let it out first.
    if (this.terrain.solidAt(x, y)) {
      p.ignoreTerrain = true;
      p.state.escaping = true;
    }
    this.projectiles.push(p);
    this.events.push({ type: 'projectileSpawn', id: p.id, weaponId });
    return p;
  }

  /** A projectile is finished; the reason is for the renderer's sake. */
  retire(p, reason) {
    p.alive = false;
    this.events.push({ type: 'projectileGone', id: p.id, reason, x: p.x, y: p.y });
  }

  /** It left the field. Same as retire, but the match wants to know the
   *  shot landed nowhere, so the AI learns the right lesson. */
  lose(p, reason) {
    p.alive = false;
    this.events.push({ type: 'projectileGone', id: p.id, reason, x: p.x, y: p.y, lost: true });
  }

  bounce(p) {
    this.events.push({ type: 'bounce', x: p.x, y: p.y, id: p.id });
  }

  split(p, count) {
    this.events.push({ type: 'split', x: p.x, y: p.y, count });
  }

  /** First living mech within r of a point, for rollers and burrowers. */
  mechNear(x, y, r) {
    return mechAt(this.mechs, x, y, r);
  }

  // -------------------------------------------------------------------------
  // Consequences
  // -------------------------------------------------------------------------

  /**
   * The blast. Terrain first, then damage, so a mech shielded by a ridge
   * that the same blast removes is still shielded — the shell went off on
   * the far side of it.
   */
  explode(x, y, weapon, ownerId) {
    const R = weapon.radius;
    const D = weapon.damage;

    // Damage is decided against the ground as it was when the shell arrived.
    const hits = [];
    if (D > 0) {
      for (const m of this.mechs) {
        if (!m.alive) continue;
        const cx = m.x, cy = m.y - BODY_LIFT;
        const d = Math.hypot(cx - x, cy - y);
        if (d > R + MECH_RADIUS) continue;
        let f = 1 - Math.max(0, d - MECH_RADIUS) / R;
        if (f <= 0) continue;
        let dmg = D * f;
        if (this.terrain.segmentBlocked(x, y, cx, cy)) dmg *= TERRAIN_SHADOW;
        if (m.playerId === ownerId) dmg *= SELF_DAMAGE_SCALE;
        else if (!this.settings.friendlyFire && this.sameTeam(m.playerId, ownerId)) dmg = 0;
        if (dmg > 0) hits.push({ m, dmg });
      }
    }

    let dirty = null;
    if (weapon.terrain === 'crater') dirty = this.terrain.carve(x, y, R, this.rng);
    else if (weapon.terrain === 'scoop') dirty = this.terrain.scoop(x, y, R);
    else if (weapon.terrain === 'fill') dirty = this.terrain.fill(x, y, R);

    this.events.push({ type: 'explosion', x, y, radius: R, strength: weapon.shake ?? 0.2, weaponId: weapon.id, ownerId });
    if (dirty) this.events.push({ type: 'terrainChanged', x0: dirty.x0, x1: dirty.x1 });

    for (const { m, dmg } of hits) this.damage(m, dmg, ownerId, 'blast');
  }

  /** The dirt bomb: only ground. A mech under it is buried, not hurt. */
  mound(x, y, r, weapon, ownerId) {
    const dirty = this.terrain.fill(x, y, r);
    this.events.push({ type: 'explosion', x, y, radius: r, strength: weapon.shake ?? 0.1, weaponId: weapon.id, ownerId, mound: true });
    this.events.push({ type: 'terrainChanged', x0: dirty.x0, x1: dirty.x1 });
  }

  /** Apply damage to a mech, shield first, and announce it. */
  damage(m, amount, by, cause) {
    if (!m.alive || amount <= 0) return;
    let dmg = amount;
    if (m.shield > 0) {
      const absorbed = Math.min(m.shield, dmg);
      m.shield -= absorbed;
      dmg -= absorbed;
      this.events.push({ type: 'shieldHit', id: m.id, absorbed });
    }
    dmg = Math.round(dmg);
    if (dmg <= 0) return;
    m.health = Math.max(0, m.health - dmg);
    this.events.push({ type: 'mechHit', id: m.id, damage: dmg, by, cause });
    const kill = m.health <= 0;
    this.ledger.push({ by, to: m.playerId, amount: dmg, kill, cause });
    if (kill) this.kill(m, by, cause);
  }

  kill(m, by, cause) {
    m.alive = false;
    m.health = 0;
    this.events.push({ type: 'mechDied', id: m.id, by, cause, x: m.x, y: m.y });
  }

  sameTeam(a, b) {
    const ma = this.mechFor(a), mb = this.mechFor(b);
    return !!(ma && mb && ma.team === mb.team);
  }

  /** Take and clear the damage ledger. The match tallies it. */
  drainLedger() {
    const out = this.ledger;
    this.ledger = [];
    return out;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  /** Advance one fixed step. `events` receives everything that happened. */
  step(dt, events) {
    this.events = events;
    this.time += dt;

    // Delayed children.
    if (this.pending.length) {
      const still = [];
      for (const c of this.pending) {
        c.delay -= dt;
        if (c.delay <= 0) this.spawn(c.weaponId, c.ownerId, c.x, c.y, c.vx, c.vy, 0);
        else still.push(c);
      }
      this.pending = still;
    }

    // Projectiles. Iterate over a snapshot: hits may spawn children, and
    // those fly from the next step.
    const flying = this.projectiles.slice();
    for (const p of flying) {
      if (!p.alive) continue;
      const flight = FLIGHT[p.weapon.flight] || FLIGHT.ballistic;
      // A child born inside ground is let out before it can hit anything.
      if (p.state.escaping && !this.terrain.solidAt(p.x, p.y)) {
        p.state.escaping = false;
        p.ignoreTerrain = false;
      }
      const hit = flight.move(p, this, dt);
      if (!p.alive) continue;
      if (p.apex) {
        // The top of the arc: the whistle starts here, and MIRVs split here.
        events.push({ type: 'apex', id: p.id, x: p.x, y: p.y, weaponId: p.weaponId, hidden: !!p.weapon.hidden });
        if (flight.onApex) {
          flight.onApex(p, this);
          if (!p.alive) continue;
        }
      }
      if (hit) flight.onHit(p, this, hit);
    }
    if (flying.length) this.projectiles = this.projectiles.filter((p) => p.alive);

    // Ground settles.
    const dirty = this.terrain.settle(dt, this.settings.terrainMode);
    if (dirty) events.push({ type: 'terrainChanged', x0: dirty.x0, x1: dirty.x1, settling: true });

    // Mechs follow the ground down.
    for (const m of this.mechs) this.stepMech(m, dt);
  }

  /** Gravity for a mech: stand, or fall until the ground is under both feet. */
  stepMech(m, dt) {
    const t = this.terrain;
    const h = FOOT_W / 2;
    // Whatever is highest under the footprint holds the mech up. groundBelow
    // returns y itself when the feet are already inside ground (buried).
    const ground = Math.min(t.groundBelow(m.x - h, m.y), t.groundBelow(m.x, m.y), t.groundBelow(m.x + h, m.y));

    if (ground > m.y + 0.5) {
      if (!m.falling) { m.falling = true; m.fallFrom = m.y; m.vy = 0; }
      m.vy += this.settings.gravity * dt;
      m.y += m.vy * dt;
      if (m.y >= ground) {
        m.y = ground;
        m.falling = false;
        m.vy = 0;
        const drop = m.y - m.fallFrom;
        this.events.push({ type: 'mechFell', id: m.id, drop, x: m.x, y: m.y });
        if (m.alive && this.settings.fallDamage && drop > FALL_DAMAGE_FROM) {
          this.damage(m, (drop - FALL_DAMAGE_FROM) * FALL_DAMAGE_PER_PX, null, 'fall');
        }
      }
    } else if (m.falling) {
      m.falling = false;
      m.vy = 0;
    }
    if (m.y > BEDROCK) m.y = BEDROCK;
    this.updateTilt(m);
  }

  /** The lean of the body from the ground under each foot; for the renderer. */
  updateTilt(m) {
    const h = FOOT_W / 2;
    const l = this.terrain.groundBelow(m.x - h, m.y - 30);
    const r = this.terrain.groundBelow(m.x + h, m.y - 30);
    let tilt = Math.atan2(r - l, FOOT_W);
    if (tilt > 0.35) tilt = 0.35;
    if (tilt < -0.35) tilt = -0.35;
    m.tilt = tilt;
  }

  /** Nothing in the air, nothing falling, nothing pouring. */
  isQuiet() {
    if (this.projectiles.length || this.pending.length) return false;
    if (!this.terrain.isQuiet()) return false;
    for (const m of this.mechs) if (m.falling) return false;
    return true;
  }
}

export { WIDTH, HEIGHT };
