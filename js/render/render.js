/*
 * render.js — one canvas, one frame, everything on it.
 *
 * THE CAMERA IS NOT A CAMERA
 *   The whole 1600x900 field is always fully visible (ARCHITECTURE.md §9).
 *   There is no zoom, no tracking, no lerp: one uniform scale that fits the
 *   field into the canvas, centred, letterboxed. A player planning a lob over
 *   a ridge has to see the ridge, the target and their own mech at once, and
 *   an artillery game where the camera decides what matters is an artillery
 *   game you cannot aim in. The margins are filled with sky rather than left
 *   black, so the letterbox does not look like a rendering bug — and because
 *   the world layers are clipped to the field rect, nothing strays into them.
 *
 * WHAT THE RENDERER OWNS OF THE SIM'S STATE
 *   Nothing, with exactly one exception: world.js sets mech.recoil to 1 when
 *   a shot goes off and never touches it again, because how long a kick lasts
 *   is a rendering decision and putting a 200 ms timer in the simulation
 *   would make it a physics one. We decay it here. Everything else is read.
 *
 * EVENTS VS STATE
 *   Positions, health, angles and terrain are read straight off the match
 *   every frame — same process, no copying. Events are for the one-shots that
 *   have no state to read: a blast happened, ground changed, a mech died. So
 *   main.js must hand us every event in order, before the frame that should
 *   show it. Miss one and you lose a puff of smoke; miss a terrainChanged and
 *   the hill is wrong until the next full repaint, which is why terrain-draw
 *   also notices a new Terrain on its own.
 *
 * SHOT MEMORY
 *   The previous shot of whoever is aiming is drawn as a faint ghost trail.
 *   That is a rule of this game, not a flourish: Tank Wars is a game about
 *   correcting, and a player who cannot see where the last one went is being
 *   asked to correct from memory alone. The bookkeeping is in onEvent: the
 *   `fire` event names the owner, the next `projectileSpawn` is that shot's
 *   root projectile, and when that one is gone we keep its trail. It is not
 *   drawn while the player has Move selected: they are not aiming a shot.
 *
 * THE MOVE PLAN
 *   With Move selected (player.weaponId === 'move') the aiming player is
 *   choosing where to walk, not where to shoot, so the field shows that
 *   instead: a faint band along the ground covering how far a walk can go
 *   either way, a dashed footpath to the dialled-in spot, and a ghost of
 *   their own walker standing where the walk will really end. The sim's
 *   world.walkPreview() is the authority on "really": a walk stops at a
 *   cliff it cannot climb, and when it will, the marker turns red and a
 *   striped stop post stands at the wall. Promising a spot the walk cannot
 *   reach would be the same lie as a barrel the shell does not leave.
 *
 * WRECKS ARE NOT QUITE DEAD
 *   A wreck smokes and, now and then, arcs. While its cook-off timer runs
 *   (mech.cookOff, the death blast) it spits sparks from the hole faster and
 *   faster; mech-draw.js paints the light, effects.js the sparks.
 */

import { WIDTH, HEIGHT, BODY_LIFT, FOOT_W } from '../config.js';
// Namespace import for anything that may not exist yet in config.js: a
// missing named import is a module-graph failure and a blank screen (hub
// §2), a missing property on a namespace is just undefined.
import * as CONFIG from '../config.js';
import { createSky } from './sky.js';
import { createTerrainLayer } from './terrain-draw.js';
import { createMechLayer, STRIDE } from './mech-draw.js';
import { createProjectilePainter } from './projectile-draw.js';
import { createEffects } from './effects.js';

const TAU = Math.PI * 2;

/** How long the barrel takes to come back from a shot, seconds. */
const RECOIL_TIME = 0.2;

const MARK_OUTLINE = '#0b0d12';
const HAZARD = '#ffd23f';
const DANGER = '#ff4b3e';
const MOVE_RANGE_FALLBACK = 220;
/** Dash patterns, allocated once; setLineDash copies them. */
const DASH = [6, 5];
const NO_DASH = [];

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });

  const sky = createSky();
  const terrain = createTerrainLayer();
  const mechs = createMechLayer();
  const effects = createEffects();
  const shells = createProjectilePainter();

  /** Scratch mech for the Move plan's ghost walker; never allocated per frame. */
  const ghost = { x: 0, y: 0, angle: 60, tilt: 0, recoil: 0, walking: false };
  /** mech id -> last half-stride index seen, so each footfall kicks dust once. */
  const strideSeen = new Map();

  /** The canvas rectangle expressed in field coordinates, margins included. */
  const view = { x0: 0, y0: 0, x1: WIDTH, y1: HEIGHT };

  let match = null;
  let dpr = 1;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  // The canvas fills the viewport, so its position only moves on a resize;
  // caching it keeps screenToWorld off getBoundingClientRect in input paths.
  let rectX = 0;
  let rectY = 0;
  let time = 0;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const options = { shake: true, trails: true };

  // --- shot memory ---------------------------------------------------------
  /** playerId -> the trail array of their last completed root shot. */
  const lastTrail = new Map();
  /** projectile id -> owner, for the root projectile of each shot only. */
  const rootOwner = new Map();
  /** projectile id -> the live projectile object, so we can keep its trail. */
  const rootProj = new Map();
  /** Set by a `fire` event, claimed by the next `projectileSpawn`. */
  let pendingOwner = null;

  // --- settling dust -------------------------------------------------------
  // terrainChanged fires every frame while ground pours; onEvent has no dt,
  // so the range is parked here and spent in draw().
  let settleX0 = 0;
  let settleX1 = 0;
  let settlePending = false;

  function setTransform(shakeX, shakeY) {
    const k = scale * dpr;
    ctx.setTransform(k, 0, 0, k, (offX + shakeX * scale) * dpr, (offY + shakeY * scale) * dpr);
  }

  function mechById(id) {
    const world = match && match.world;
    if (!world) return null;
    const list = world.mechs;
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // -------------------------------------------------------------------------
  // The API
  // -------------------------------------------------------------------------

  function resize() {
    const cssW = canvas.clientWidth || canvas.width || WIDTH;
    const cssH = canvas.clientHeight || canvas.height || HEIGHT;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    scale = Math.min(cssW / WIDTH, cssH / HEIGHT);
    if (!(scale > 0)) scale = 1;
    offX = (cssW - WIDTH * scale) / 2;
    offY = (cssH - HEIGHT * scale) / 2;

    view.x0 = -offX / scale;
    view.y0 = -offY / scale;
    view.x1 = view.x0 + cssW / scale;
    view.y1 = view.y0 + cssH / scale;

    const rect = canvas.getBoundingClientRect();
    rectX = rect.left;
    rectY = rect.top;

    sky.setView(view);
    effects.setBounds(view);
  }

  /** A new Match, or null between matches. Rebakes everything per player. */
  function attach(m) {
    match = m || null;
    terrain.reset();
    effects.reset();
    lastTrail.clear();
    rootOwner.clear();
    rootProj.clear();
    pendingOwner = null;
    settlePending = false;
    mechs.bake(match ? match.players : null);
  }

  /** Every sim event, in order, before the frame that should show it. */
  function onEvent(e) {
    if (!e) return;
    switch (e.type) {
      case 'roundStart':
        // A new hill: old craters, old smoke and old ghost trails all belong
        // to a battlefield that no longer exists.
        terrain.reset();
        effects.reset();
        lastTrail.clear();
        rootOwner.clear();
        rootProj.clear();
        strideSeen.clear();
        pendingOwner = null;
        break;

      case 'terrainChanged':
        terrain.markDirty(e.x0, e.x1);
        if (e.settling) {
          if (!settlePending) { settleX0 = e.x0; settleX1 = e.x1; settlePending = true; }
          else {
            if (e.x0 < settleX0) settleX0 = e.x0;
            if (e.x1 > settleX1) settleX1 = e.x1;
          }
        }
        break;

      case 'fire':
        effects.muzzle(e.x, e.y, e.angle);
        pendingOwner = e.playerId;
        break;

      case 'projectileSpawn':
        if (pendingOwner !== null) {
          rootOwner.set(e.id, pendingOwner);
          pendingOwner = null;
          const world = match && match.world;
          if (world) {
            const list = world.projectiles;
            for (let i = 0; i < list.length; i++) {
              if (list[i].id === e.id) { rootProj.set(e.id, list[i]); break; }
            }
          }
        }
        break;

      case 'projectileGone': {
        const owner = rootOwner.get(e.id);
        if (owner !== undefined) {
          const p = rootProj.get(e.id);
          // Keeping the array by reference is safe: a retired projectile is
          // dropped by the sim and nothing ever pushes to its trail again.
          if (p && p.trail && p.trail.length > 1) lastTrail.set(owner, p.trail);
          rootOwner.delete(e.id);
          rootProj.delete(e.id);
        }
        break;
      }

      case 'explosion':
        effects.explosion(e.x, e.y, e.radius, e.strength, !!e.mound, e.weaponId);
        break;

      case 'deathBlast':
        effects.deathBlast(e.x, e.y, mechs.skin(e.id).hex);
        break;

      case 'bounce':
        effects.bounce(e.x, e.y);
        break;

      case 'split':
        effects.split(e.x, e.y, e.count);
        break;

      case 'mechHit': {
        const m = mechById(e.id);
        if (m) effects.hit(m.x, m.y - BODY_LIFT);
        break;
      }

      case 'shieldHit': {
        const m = mechById(e.id);
        if (m) effects.shield(m.x, m.y - BODY_LIFT);
        break;
      }

      case 'mechDied':
        effects.died(e.x, e.y);
        break;

      case 'mechFell':
        if (e.drop > 25) effects.landed(e.x, e.y, e.drop);
        break;

      default:
        break;
    }
  }

  function setOptions(o) {
    if (!o) return;
    if (typeof o.shake === 'boolean') {
      options.shake = o.shake;
      effects.setShake(o.shake);
    }
    if (typeof o.trails === 'boolean') options.trails = o.trails;
  }

  /** Viewport coordinates (a pointer event's clientX/clientY) to field units. */
  function screenToWorld(clientX, clientY) {
    return {
      x: (clientX - rectX - offX) / scale,
      y: (clientY - rectY - offY) / scale,
    };
  }

  /** Field units to viewport coordinates, the inverse of the above. */
  function worldToScreen(x, y) {
    return {
      x: rectX + offX + x * scale,
      y: rectY + offY + y * scale,
    };
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  function draw(dtReal) {
    let dt = dtReal;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.1) dt = 0.1; // a backgrounded tab must not fast-forward
    time += dt;

    const world = match ? match.world : null;
    const wind = world ? world.wind : 0;

    effects.setCalm(motionPreference.matches);
    effects.update(dt, wind);

    // --- background, never shaken (see sky.js) -----------------------------
    setTransform(0, 0);
    sky.draw(ctx, view, wind, dt);
    effects.drawSky(ctx, wind);

    // Robust with nothing attached and between matches: sky and ridges are a
    // complete, correct picture of an empty battlefield.
    if (!world || !world.terrain) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }

    // --- the world, shaken and clipped to the field ------------------------
    ctx.save();
    setTransform(effects.shake.x, effects.shake.y);
    ctx.beginPath();
    ctx.rect(0, 0, WIDTH, HEIGHT);
    ctx.clip();

    terrain.sync(world.terrain);
    ctx.drawImage(terrain.canvas, 0, 0);

    if (settlePending) {
      const mid = (settleX0 + settleX1) / 2;
      effects.settling(settleX0, settleX1, world.terrain.surfaceAt(mid), dt);
      settlePending = false;
    }

    const list = world.mechs;

    // Wrecks first: they are scenery the living stand in front of.
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.alive) continue;
      const skin = mechs.skin(m.playerId);
      mechs.drawWreck(ctx, m, skin, world.terrain, motionPreference.matches ? 0 : time);
      effects.wreckSmoke(m.x, m.y, dt);
      if (m.cookOff > 0) {
        // Same 1.2 s ramp mech-draw uses for its light, so they climb together.
        const k = m.cookOff > 1.2 ? 0 : 1 - m.cookOff / 1.2;
        effects.cookOff(m.x, m.y - BODY_LIFT * 0.6, k, dt);
      } else if (Math.random() < dt * 0.35) {
        effects.wreckSpark(m.x + (Math.random() - 0.5) * 16, m.y - BODY_LIFT * 0.5);
      }
    }

    // The Move plan sits under the living walkers: the ghost is a promise,
    // the real machine stands in front of it.
    const planner = match.state === 'aim' && match.currentId ? match.player(match.currentId) : null;
    const planning = !!(planner && planner.weaponId === 'move' && Number.isFinite(planner.moveX));
    if (planning) {
      const pm = mechById(match.currentId);
      if (pm && pm.alive) drawMovePlan(ctx, world, pm, planner.moveX, mechs.skin(pm.playerId));
    }

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;
      // The sim sets recoil and leaves it; the decay is ours (see header).
      if (m.recoil > 0) {
        m.recoil -= dt / RECOIL_TIME;
        if (m.recoil < 0) m.recoil = 0;
      }
      mechs.drawLive(ctx, m, mechs.skin(m.playerId), world.terrain, motionPreference.matches ? 0 : time);
      if (m.walking) footfalls(m);
      else if (strideSeen.size) strideSeen.delete(m.id);
    }

    // --- trails -------------------------------------------------------------
    const projs = world.projectiles;
    // Refresh the root references whether or not trails are drawn: main.js
    // may have relayed the spawn event after several sim substeps, in which
    // case the lookup in onEvent came up empty and shot memory depends on
    // catching the projectile here instead.
    for (let i = 0; i < projs.length; i++) {
      if (rootOwner.has(projs[i].id)) rootProj.set(projs[i].id, projs[i]);
    }
    if (options.trails) {
      // Shot memory: the ghost of the aiming player's own last shot. Drawn
      // under the live ones, and faint enough to never be mistaken for one.
      if (match.state === 'aim' && match.currentId && !planning) {
        const ghost = lastTrail.get(match.currentId);
        if (ghost) drawTrail(ctx, ghost, mechs.skin(match.currentId).hex, 0.14, 0.26, 3);
      }
      for (let i = 0; i < projs.length; i++) {
        drawTrail(ctx, projs[i].trail, mechs.skin(projs[i].ownerId).hex, 0.42, 0.8, 2);
      }
    }

    // --- projectiles --------------------------------------------------------
    for (let i = 0; i < projs.length; i++) {
      drawProjectile(ctx, projs[i], mechs.skin(projs[i].ownerId).hex, time);
    }

    effects.draw(ctx);

    // Tags and bars go OVER the smoke: they are the information layer, and a
    // player checking who is nearly dead must not have to wait for a puff.
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.alive) mechs.drawOverlay(ctx, m, mechs.skin(m.playerId));
    }
    if ((match.state === 'aim' || match.state === 'firing') && match.currentId) {
      const cur = mechById(match.currentId);
      if (cur && cur.alive) mechs.drawChevron(ctx, cur, time);
    }

    ctx.restore();

    // --- edge markers, unshaken so they stay readable ----------------------
    setTransform(0, 0);
    drawMarkers(ctx, projs);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Pieces of the frame
  // -------------------------------------------------------------------------

  /**
   * A dotted line along a flight path. `trail` holds points and nulls; a null
   * is a break (the wrap rule teleports a shell across the field, and joining
   * across that would draw a line through everything). Long trails are drawn
   * with a stride — every entry is still *read*, so breaks are never missed,
   * but only every nth becomes a path operation.
   */
  function drawTrail(ctx2, trail, hex, lineAlpha, dotAlpha, dotEvery) {
    const n = trail.length;
    if (n < 2) return;
    const stride = n > 1200 ? Math.ceil(n / 600) : 1;
    const last = n - 1;

    ctx2.globalAlpha = lineAlpha;
    ctx2.strokeStyle = hex;
    ctx2.lineWidth = 1.3;
    ctx2.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const pt = trail[i];
      if (!pt) { pen = false; continue; }
      if (i % stride !== 0 && i !== last) continue;
      if (pen) ctx2.lineTo(pt.x, pt.y);
      else { ctx2.moveTo(pt.x, pt.y); pen = true; }
    }
    ctx2.stroke();

    ctx2.globalAlpha = dotAlpha;
    ctx2.fillStyle = hex;
    const step = stride * dotEvery;
    for (let i = 0; i < n; i += step) {
      const pt = trail[i];
      if (!pt) continue;
      ctx2.fillRect(pt.x - 1.3, pt.y - 1.3, 2.6, 2.6);
    }
    ctx2.globalAlpha = 1;
  }

  /**
   * A projectile, via projectile-draw.js: each weapon has its own sprite,
   * pointed along its flight. A burrower is inside the hill, so it is drawn
   * faint with a marker ring — the player follows the dig rather than losing
   * the shot the moment it goes under.
   */
  function drawProjectile(ctx2, p, hex, t) {
    const st = p.state;
    if (st && st.burrowing) {
      ctx2.globalAlpha = 0.85;
      ctx2.strokeStyle = hex;
      ctx2.lineWidth = 1.4;
      ctx2.beginPath();
      ctx2.arc(p.x, p.y, (p.radius || 3) + 7, 0, TAU);
      ctx2.stroke();
      ctx2.globalAlpha = 0.6;
    }
    shells.draw(ctx2, p, hex, t);
    ctx2.globalAlpha = 1;
  }

  /**
   * Dust at each footfall of a walking mech. A foot lands once per half
   * stride; the index of the half-stride is remembered per mech so each one
   * kicks exactly one puff, whatever the frame rate.
   */
  function footfalls(m) {
    const half = Math.floor((m.walkDist || 0) / (STRIDE / 2));
    const seen = strideSeen.get(m.id);
    if (seen === half) return;
    strideSeen.set(m.id, half);
    if (seen === undefined) return; // first frame of a walk: nothing landed yet
    const dir = m.walkDir < 0 ? -1 : 1;
    const side = half % 2 ? 1 : -1;
    effects.footDust(m.x + side * FOOT_W / 2, m.y, dir);
  }

  /** See THE MOVE PLAN in the header. */
  function drawMovePlan(ctx2, world, m, targetX, skin) {
    const terrain = world.terrain;
    const range = Number.isFinite(CONFIG.MOVE_RANGE) ? CONFIG.MOVE_RANGE : MOVE_RANGE_FALLBACK;
    const x0 = Math.max(2, m.x - range);
    const x1 = Math.min(WIDTH - 2, m.x + range);
    const hex = skin.hex;

    // Reach band along the surface, with end brackets.
    ctx2.lineCap = 'round';
    ctx2.lineJoin = 'round';
    ctx2.globalAlpha = 0.2;
    ctx2.strokeStyle = hex;
    ctx2.lineWidth = 6;
    ctx2.beginPath();
    for (let x = x0; x <= x1; x += 6) {
      const y = terrain.surfaceAt(x) - 2;
      if (x === x0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
    }
    ctx2.stroke();
    ctx2.globalAlpha = 0.6;
    ctx2.lineWidth = 2;
    for (let i = 0; i < 2; i++) {
      const bx = i ? x1 : x0;
      const by = terrain.surfaceAt(bx);
      const inward = i ? -1 : 1;
      ctx2.beginPath();
      ctx2.moveTo(bx + inward * 5, by - 14);
      ctx2.lineTo(bx, by - 14);
      ctx2.lineTo(bx, by);
      ctx2.stroke();
    }

    let pv = null;
    if (typeof world.walkPreview === 'function') pv = world.walkPreview(m.playerId, targetX);
    const px = pv && Number.isFinite(pv.x) ? pv.x : targetX;
    const py = pv && Number.isFinite(pv.y) ? pv.y : terrain.surfaceAt(px);
    const blocked = !!(pv && pv.blocked);
    const dir = targetX >= m.x ? 1 : -1;

    // Footpath: dashes along the ground from the mech to where it stops.
    if (Math.abs(px - m.x) > 2) {
      ctx2.globalAlpha = 0.85;
      ctx2.strokeStyle = blocked ? DANGER : HAZARD;
      ctx2.lineWidth = 2;
      ctx2.setLineDash(DASH);
      ctx2.beginPath();
      const step = dir * 5;
      let x = m.x;
      ctx2.moveTo(x, m.y - 3);
      for (;;) {
        x += step;
        if ((dir > 0 && x >= px) || (dir < 0 && x <= px)) break;
        ctx2.lineTo(x, terrain.surfaceAt(x) - 3);
      }
      ctx2.lineTo(px, py - 3);
      ctx2.stroke();
      ctx2.setLineDash(NO_DASH);
    }

    // The ghost walker where the walk will end, leaning with the ground.
    ghost.x = px;
    ghost.y = py;
    ghost.angle = m.angle;
    const l = terrain.surfaceAt(px - FOOT_W / 2);
    const r = terrain.surfaceAt(px + FOOT_W / 2);
    let tilt = Math.atan2(r - l, FOOT_W);
    if (tilt > 0.35) tilt = 0.35;
    if (tilt < -0.35) tilt = -0.35;
    ghost.tilt = tilt;
    ctx2.globalAlpha = 0.32;
    mechs.drawLive(ctx2, ghost, skin, terrain, 0);

    // A down-pointing marker over it; red if the walk is cut short.
    const my = py - BODY_LIFT - 46 + Math.sin(time * 4.2) * 2;
    ctx2.globalAlpha = 1;
    ctx2.beginPath();
    ctx2.moveTo(px - 8, my);
    ctx2.lineTo(px + 8, my);
    ctx2.lineTo(px, my + 10);
    ctx2.closePath();
    ctx2.fillStyle = blocked ? DANGER : HAZARD;
    ctx2.fill();
    ctx2.lineWidth = 2;
    ctx2.strokeStyle = MARK_OUTLINE;
    ctx2.stroke();

    if (blocked) {
      // A striped stop post just past the stop point, against the wall.
      const sx = px + dir * (FOOT_W / 2 + 6);
      const sy = terrain.surfaceAt(px + dir * FOOT_W / 2);
      const top = Math.min(sy, py) - 22;
      ctx2.fillStyle = MARK_OUTLINE;
      ctx2.fillRect(sx - 3.5, top - 1, 7, py - top + 1);
      for (let yy = top; yy < py; yy += 5) {
        ctx2.fillStyle = ((yy - top) / 5) % 2 < 1 ? DANGER : '#f3f5f8';
        ctx2.fillRect(sx - 2.5, yy, 5, Math.min(5, py - yy));
      }
    }
    ctx2.globalAlpha = 1;
  }

  /**
   * Anything above the top of the field or past a side edge gets an arrow at
   * that edge in the owner's colour. The top is always open (ballistics.js
   * says so) and the sides are open by default, so without this a shell that
   * is still very much in play simply disappears for two seconds.
   */
  function drawMarkers(ctx2, projs) {
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      let mx;
      let my;
      let dir;
      if (p.y < 0) {
        mx = p.x < 16 ? 16 : p.x > WIDTH - 16 ? WIDTH - 16 : p.x;
        my = 14;
        dir = 0;
      } else if (p.x < 0) {
        mx = 14;
        my = p.y < 16 ? 16 : p.y > HEIGHT - 16 ? HEIGHT - 16 : p.y;
        dir = 1;
      } else if (p.x > WIDTH) {
        mx = WIDTH - 14;
        my = p.y < 16 ? 16 : p.y > HEIGHT - 16 ? HEIGHT - 16 : p.y;
        dir = 2;
      } else {
        continue;
      }

      ctx2.beginPath();
      if (dir === 0) {
        ctx2.moveTo(mx, my - 9);
        ctx2.lineTo(mx + 8, my + 6);
        ctx2.lineTo(mx - 8, my + 6);
      } else if (dir === 1) {
        ctx2.moveTo(mx - 9, my);
        ctx2.lineTo(mx + 6, my - 8);
        ctx2.lineTo(mx + 6, my + 8);
      } else {
        ctx2.moveTo(mx + 9, my);
        ctx2.lineTo(mx - 6, my - 8);
        ctx2.lineTo(mx - 6, my + 8);
      }
      ctx2.closePath();
      ctx2.fillStyle = mechs.skin(p.ownerId).hex;
      ctx2.fill();
      ctx2.lineWidth = 2;
      ctx2.strokeStyle = MARK_OUTLINE;
      ctx2.stroke();
    }
  }

  resize();

  return { resize, attach, onEvent, draw, setOptions, screenToWorld, worldToScreen };
}
