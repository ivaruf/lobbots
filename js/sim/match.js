/*
 * match.js — players, turns, rounds, money and the shop: the game around
 * the battlefield.
 *
 * A Match is a state machine driven by two things and nothing else:
 *
 *   apply(action)   a decision by a player (fire, move, buy, ready, aim)
 *   step(dt, events) fixed time passing
 *
 * That is deliberately the entire input surface (ARCHITECTURE.md §3). The
 * setup screen, the HUD, the AI and, later, a remote peer all speak to it
 * through apply(); nothing reaches in. Everything that happens comes back
 * out on the events array.
 *
 *   setup -> aim <-> firing -> scoreboard -> shop -> aim ... -> matchOver
 *
 * Angle, power and weapon belong to the PLAYER and persist between their
 * turns and across rounds: shot memory is a rule here, not a UI nicety.
 */

import {
  PALETTE, ECONOMY, SCORE, TURN_GAP, AI_THINK_MIN, AI_THINK_MAX,
  AI_ANGLE_RATE, AI_POWER_RATE, AI_SHOP_DWELL, AUTO_ADVANCE, WIDTH, MOVE_RANGE, resolveSettings,
} from '../config.js';
import { mulberry32, hash, randomSeed, range } from './rng.js';
import { World } from './world.js';
import { weaponById, isUtility, SHOP_ITEMS } from './weapons.js';
import * as AI from './ai.js';

export class Match {
  /**
   * @param settings  from config.resolveSettings(); `seed` inside it may be null
   * @param specs     [{ name, colorIndex, isAI, personality, team }] in seat order
   */
  constructor(settings, specs) {
    this.settings = settings || resolveSettings();
    this.seed = Number.isInteger(this.settings.seed) ? this.settings.seed >>> 0 : randomSeed();
    /** Match-level rng: AI decisions, shop order, tie breaks. Rounds get their own. */
    this.rng = mulberry32(hash(this.seed, 0xa11ce));

    this.players = specs.map((s, i) => this.makePlayer(s, i));
    this.state = 'setup';
    this.round = 0;
    this.world = null;
    this.currentId = null;
    this.turnSeat = -1;

    // Per-turn scratch.
    this.shot = null;          // { playerId, weaponId, landing, lost }
    this.gapTimer = 0;
    this.thinkTimer = 0;
    this.aiPlan = null;
    this.timeLeft = 0;         // shot timer for humans, seconds
    /** The round is decided but a wreck is still cooking off: hold the
     *  table until the world is quiet, and let nobody fire meanwhile. */
    this.roundEnding = false;

    // Between rounds.
    this.lastAwards = [];
    this.autoTimer = 0;
    this.shopQueue = [];
    this.shopperId = null;
    this.shopDwell = 0;
    this.lastPurchases = [];   // what the current shopper bought (AI, for the UI)
    this.standings = null;
  }

  makePlayer(spec, seat) {
    const color = PALETTE[spec.colorIndex % PALETTE.length] || PALETTE[seat % PALETTE.length];
    return {
      id: spec.id || `p${seat}`,
      seat,
      name: spec.name || `Lobbot ${seat + 1}`,
      color,
      isAI: !!spec.isAI,
      personality: spec.personality || 'rookie',
      // Free-for-all: everyone is their own team.
      team: this.settings.teams && spec.team != null ? spec.team : `solo-${seat}`,
      money: this.settings.startMoney,
      inventory: { shell: Infinity },
      armour: 0,
      shield: 0,
      kills: 0,
      deaths: 0,
      damageDealt: 0,
      roundWins: 0,
      score: 0,
      // Aim memory. Set on the first round from which side the mech stands.
      angle: null,
      power: 60,
      weaponId: 'shell',
      // Move: where the walk would go (field x, null until Move is picked)
      // and the weapon to hand back once the walk is done.
      moveX: null,
      prevWeaponId: 'shell',
      alive: true,
      aiMemory: null,
      ready: false,
      round: { damage: 0, kills: 0, earned: 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Queries the UI leans on
  // -------------------------------------------------------------------------

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  current() {
    return this.player(this.currentId);
  }

  shopper() {
    return this.player(this.shopperId);
  }

  humans() {
    return this.players.filter((p) => !p.isAI);
  }

  isHumanTurn() {
    const p = this.current();
    return this.state === 'aim' && !!p && !p.isAI;
  }

  /** Ammo for a weapon; Infinity for the shell. */
  ammo(player, weaponId) {
    return player.inventory[weaponId] || 0;
  }

  /** Weapons this player can fire right now, catalog order, shell first. */
  arsenal(player) {
    const ids = Object.keys(player.inventory).filter((id) => player.inventory[id] > 0);
    // Shell first, utilities (Move) last, the guns by price between.
    const rank = (w) => (w.id === 'shell' ? 0 : w.category === 'utility' ? 2 : 1);
    return ids.map(weaponById).filter((w) => !w.hidden).sort((a, b) => rank(a) - rank(b) || a.price - b.price);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Begin. Emits roundStart and the first turnStart. */
  start(events) {
    this.events = events;
    this.startRound();
  }

  /**
   * The one input surface. Unknown or out-of-turn actions are ignored, not
   * thrown: a remote peer or a stale button must never break the machine.
   */
  apply(action) {
    switch (action.type) {
      case 'aim': return this.applyAim(action);
      case 'fire': return this.applyFire(action);
      case 'move': return this.applyMove(action);
      case 'buy': return this.applyBuy(action);
      case 'ready': return this.applyReady(action);
      default: return false;
    }
  }

  applyAim(a) {
    const p = this.player(a.playerId);
    if (!p || this.state !== 'aim' || p.id !== this.currentId || p.isAI) return false;
    if (Number.isFinite(a.angle)) p.angle = clamp(Math.round(a.angle), 0, 180);
    if (Number.isFinite(a.power)) p.power = clamp(Math.round(a.power), 1, 100);
    if (a.weaponId && this.ammo(p, a.weaponId) > 0) this.selectWeapon(p, a.weaponId);
    if (Number.isFinite(a.moveX) && p.weaponId === 'move') this.setMoveX(p, a.moveX);
    this.mirrorAim(p);
    return true;
  }

  /** Switch weapon, remembering the gun to go back to after a Move. */
  selectWeapon(p, weaponId) {
    if (weaponId === p.weaponId) return;
    if (!isUtility(p.weaponId)) p.prevWeaponId = p.weaponId;
    p.weaponId = weaponId;
    if (weaponId === 'move' && p.moveX === null) {
      // A first guess: half the range, the way the barrel faces.
      const m = this.world && this.world.mechFor(p.id);
      if (m) this.setMoveX(p, m.x + (p.angle <= 90 ? 1 : -1) * MOVE_RANGE * 0.5);
    }
  }

  setMoveX(p, x) {
    const m = this.world && this.world.mechFor(p.id);
    if (!m) return;
    const lo = Math.max(0, m.x - MOVE_RANGE), hi = Math.min(WIDTH, m.x + MOVE_RANGE);
    p.moveX = clamp(Math.round(x), Math.round(lo), Math.round(hi));
  }

  applyMove(a) {
    const p = this.player(a.playerId);
    if (!p || this.state !== 'aim' || p.id !== this.currentId || this.roundEnding) return false;
    if (this.ammo(p, 'move') <= 0) return false;
    if (Number.isFinite(a.x)) this.setMoveX(p, a.x);
    if (p.moveX === null) return false;
    return this.walkNow(p, p.moveX);
  }

  applyFire(a) {
    const p = this.player(a.playerId);
    if (!p || this.state !== 'aim' || p.id !== this.currentId) return false;
    const angle = clamp(Math.round(Number.isFinite(a.angle) ? a.angle : p.angle), 0, 180);
    const power = clamp(Math.round(Number.isFinite(a.power) ? a.power : p.power), 1, 100);
    let weaponId = a.weaponId || p.weaponId;
    if (this.ammo(p, weaponId) <= 0) weaponId = 'shell';
    // FIRE with Move selected means "go": the one button commits the turn.
    if (weaponId === 'move') return this.applyMove({ playerId: p.id });
    return this.fireNow(p, weaponId, angle, power);
  }

  applyBuy(a) {
    const p = this.player(a.playerId);
    if (!p || this.state !== 'shop' || p.id !== this.shopperId) return false;
    return this.buy(p, a.itemId);
  }

  applyReady(a) {
    const p = this.player(a.playerId);
    if (!p) return false;
    if (this.state === 'scoreboard') {
      p.ready = true;
      // Hot-seat shares one screen, so one tap moves everyone on; nobody
      // waits on a bot either.
      this.openShop();
      return true;
    }
    if (this.state === 'shop' && p.id === this.shopperId) {
      this.nextShopper();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------

  startRound() {
    this.round++;
    const roundRng = mulberry32(hash(this.seed, this.round));
    this.world = new World(this.settings, roundRng);
    this.roundEnding = false;
    for (const p of this.players) {
      p.alive = true;
      p.ready = false;
      p.moveX = null;
      p.round = { damage: 0, kills: 0, earned: 0 };
      // First round: face the middle. After that the aim is the player's own.
      if (p.angle === null) p.angle = 60;
    }
    this.world.setup(this.players.map((p) => ({
      id: p.id, team: p.team, angle: p.angle, power: p.power, weaponId: p.weaponId, armour: p.armour, shield: p.shield,
    })));
    // Now that spawn sides are known, first-round aim faces the field.
    if (this.round === 1) {
      for (const p of this.players) {
        const m = this.world.mechFor(p.id);
        p.angle = m && m.x > WIDTH / 2 ? 120 : 60;
        this.mirrorAim(p);
      }
    }
    this.events.push({ type: 'roundStart', round: this.round, rounds: this.settings.rounds, seed: this.seed, profile: this.world.profileId });
    this.events.push({ type: 'windChanged', wind: this.world.wind });

    // Round r opens with seat r-1, so the first shot goes round the table.
    this.turnSeat = (this.round - 1) % this.players.length - 1;
    this.beginTurn(this.nextAliveSeat());
  }

  nextAliveSeat() {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const seat = (this.turnSeat + i) % n;
      const m = this.world.mechFor(this.players[seat].id);
      if (m && m.alive) return seat;
    }
    return -1;
  }

  beginTurn(seat) {
    if (seat < 0) { this.endRound(); return; }
    this.turnSeat = seat;
    const p = this.players[seat];
    this.currentId = p.id;
    this.state = 'aim';
    this.shot = null;
    this.gapTimer = 0;
    this.aiPlan = null;
    // The walker may have moved (or been moved) since its last turn, so a
    // remembered walk target is stale. And a turn that ended with Move in
    // hand ended by walking: hand back the gun it held before, because the
    // turn after a walk is almost always a shot.
    p.moveX = null;
    if (isUtility(p.weaponId)) p.weaponId = p.prevWeaponId;
    if (this.settings.windChanges === 'turn') {
      this.world.rollWind();
      this.events.push({ type: 'windChanged', wind: this.world.wind });
    }
    this.timeLeft = !p.isAI && this.settings.shotTimer > 0 ? this.settings.shotTimer : 0;
    if (p.isAI) {
      this.thinkTimer = range(this.rng, AI_THINK_MIN, AI_THINK_MAX);
      const plan = AI.decide(this.world, p, this.rng);
      // No target left (everyone else fell in a hole this turn): the round
      // check at the end of the turn will catch it; fire a harmless shell up.
      this.aiPlan = plan || { weaponId: 'shell', angle: 90, power: 30, targetId: null };
      // Bots cannot fire what they do not own; the shop is the only source.
      if (this.ammo(p, this.aiPlan.weaponId) <= 0) this.aiPlan = { ...this.aiPlan, weaponId: 'shell', moveX: undefined };
      this.selectWeapon(p, this.aiPlan.weaponId);
      this.mirrorAim(p);
    }
    this.events.push({ type: 'turnStart', playerId: p.id, seat, isAI: p.isAI, timeLeft: this.timeLeft });
  }

  fireNow(p, weaponId, angle, power) {
    const m = this.world.mechFor(p.id);
    if (!m || !m.alive || this.roundEnding) return false;
    p.angle = angle;
    p.power = power;
    p.weaponId = weaponId;
    if (p.inventory[weaponId] !== Infinity) {
      p.inventory[weaponId] = Math.max(0, (p.inventory[weaponId] || 0) - 1);
    }
    const proj = this.world.fire(p.id, weaponId, angle, power);
    if (!proj) return false;
    this.shot = { playerId: p.id, weaponId, landing: null, lost: false };
    this.state = 'firing';
    this.gapTimer = 0;
    return true;
  }

  /**
   * Spend the turn walking. Refused (nothing spent) if the walker cannot
   * take a single step that way, so a player pressing WALK into a wall gets
   * a dud click instead of a lost turn and a lost Move.
   */
  walkNow(p, x) {
    const m = this.world.mechFor(p.id);
    if (!m || !m.alive) return false;
    if (!this.world.walk(p.id, x)) return false;
    p.inventory.move = Math.max(0, (p.inventory.move || 0) - 1);
    this.shot = { playerId: p.id, weaponId: 'move', landing: null, lost: false, move: true };
    this.state = 'firing';
    this.gapTimer = 0;
    // A bot's corrections were measured from where it stood. It has moved.
    if (p.aiMemory) p.aiMemory.shots = {};
    return true;
  }

  /** Keep the world's mech showing the player's current aim. */
  mirrorAim(p) {
    const m = this.world && this.world.mechFor(p.id);
    if (!m) return;
    m.angle = p.angle;
    m.power = p.power;
    m.weaponId = p.weaponId;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  step(dt, events) {
    this.events = events;
    switch (this.state) {
      case 'aim': this.stepAim(dt); break;
      case 'firing': this.stepFiring(dt); break;
      case 'scoreboard': this.stepScoreboard(dt); break;
      case 'shop': this.stepShop(dt); break;
      default: break;
    }
  }

  stepAim(dt) {
    // The ground may still be pouring from a dirt bomb; let it.
    const before = this.events.length;
    this.world.step(dt, this.events);
    this.absorbLedger();
    if (this.events.length > before || this.roundEnding) this.checkDeathsMidAim();
    if (this.state !== 'aim' || this.roundEnding) return;

    const p = this.current();
    if (!p) return;

    if (p.isAI && this.aiPlan) {
      this.thinkTimer -= dt;
      if (this.thinkTimer > 0) return;
      // Swing the barrel to the answer, visibly, then fire.
      const plan = this.aiPlan;
      if (plan.weaponId === 'move') {
        // Slide the walk marker out to the plan, visibly, then go.
        if (p.moveX === null) this.setMoveX(p, this.world.mechFor(p.id).x);
        this.setMoveX(p, approach(p.moveX, plan.moveX, AI_MOVE_RATE * dt));
        if (Math.abs(p.moveX - plan.moveX) < 1 && !this.walkNow(p, p.moveX)) {
          // The ground changed under the plan: fall back to a plain shot.
          this.aiPlan = { ...plan, weaponId: 'shell' };
          this.selectWeapon(p, 'shell');
        }
        return;
      }
      p.angle = approach(p.angle, plan.angle, AI_ANGLE_RATE * dt);
      p.power = approach(p.power, plan.power, AI_POWER_RATE * dt);
      this.mirrorAim(p);
      if (p.angle === plan.angle && p.power === plan.power) {
        this.fireNow(p, plan.weaponId, plan.angle, plan.power);
      }
      return;
    }

    if (this.timeLeft > 0) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.events.push({ type: 'timerExpired', playerId: p.id });
        // The turn goes as it stands: a dialled-in walk walks, if it can.
        if (p.weaponId === 'move' && p.moveX !== null && this.walkNow(p, p.moveX)) return;
        const w = this.ammo(p, p.weaponId) > 0 && !isUtility(p.weaponId) ? p.weaponId : 'shell';
        this.fireNow(p, w, p.angle, p.power);
      }
    }
  }

  stepFiring(dt) {
    const start = this.events.length;
    this.world.step(dt, this.events);
    // Grade the shot for the AI: where did it first go off?
    for (let i = start; i < this.events.length; i++) {
      const e = this.events[i];
      if (!this.shot.landing && e.type === 'explosion') this.shot.landing = { x: e.x, y: e.y };
      if (e.type === 'projectileGone' && e.lost && !this.shot.landing && this.world.projectiles.length === 0) {
        this.shot.landing = { x: e.x, y: e.y };
        this.shot.lost = true;
      }
    }
    this.absorbLedger();

    if (!this.world.isQuiet()) { this.gapTimer = 0; return; }
    this.gapTimer += dt;
    if (this.gapTimer < TURN_GAP) return;
    this.endTurn();
  }

  /** Credit damage and kills from the world's ledger to players. */
  absorbLedger() {
    const records = this.world.drainLedger();
    if (!records.length) return;
    for (const r of records) {
      const victim = this.player(r.to);
      // A fall has no author in the world; the shot that moved the ground does.
      const byId = r.by ?? (this.shot ? this.shot.playerId : null);
      const shooter = byId ? this.player(byId) : null;
      const rival = shooter && victim && shooter.id !== victim.id && shooter.team !== victim.team;
      if (rival) {
        shooter.damageDealt += r.amount;
        shooter.round.damage += r.amount;
      }
      if (r.kill && victim) {
        victim.alive = false;
        victim.deaths++;
        if (rival) { shooter.kills++; shooter.round.kills++; }
      }
    }
  }

  /** Someone died while nobody was firing (crumble under them). */
  checkDeathsMidAim() {
    const cur = this.world.mechFor(this.currentId);
    if (this.world.aliveTeams().size <= 1) {
      // Decided — but a wreck still cooking off might yet take the last
      // one standing with it, and either way it deserves to be seen.
      if (this.world.isQuiet()) this.endRound();
      else this.roundEnding = true;
      return;
    }
    if (cur && !cur.alive) this.beginTurn(this.nextAliveSeat());
  }

  endTurn() {
    const p = this.current();
    if (p && p.isAI && this.shot && !this.shot.move) AI.observe(p, this.shot.landing, this.shot.lost);
    this.shot = null;
    if (this.world.aliveTeams().size <= 1) { this.endRound(); return; }
    this.beginTurn(this.nextAliveSeat());
  }

  // -------------------------------------------------------------------------
  // Round end, money, scoreboard
  // -------------------------------------------------------------------------

  endRound() {
    const alive = this.world.aliveMechs();
    const winnerMech = alive.length === 1 ? alive[0] : null;
    const winnerTeam = this.world.aliveTeams().size === 1 ? [...this.world.aliveTeams()][0] : null;
    const scale = this.settings.moneyScale;
    const awards = [];

    for (const p of this.players) {
      const m = this.world.mechFor(p.id);
      const reasons = [];
      let bolts = 0;
      const dmg = Math.round(p.round.damage * ECONOMY.perDamage);
      if (dmg) { bolts += dmg; reasons.push(['damage', dmg]); }
      if (p.round.kills) { const k = p.round.kills * ECONOMY.perKill; bolts += k; reasons.push(['kills', k]); }
      if (m && m.alive) { bolts += ECONOMY.survive; reasons.push(['survived', ECONOMY.survive]); }
      const won = winnerTeam !== null && p.team === winnerTeam;
      if (won) {
        bolts += ECONOMY.roundWin; reasons.push(['round win', ECONOMY.roundWin]);
        p.roundWins++;
        p.score += SCORE.roundWin;
      }
      bolts += ECONOMY.salary; reasons.push(['salary', ECONOMY.salary]);
      bolts = Math.round(bolts * scale);
      p.money += bolts;
      p.round.earned = bolts;
      p.score += Math.round(p.round.damage * SCORE.perDamage) + p.round.kills * SCORE.perKill;
      awards.push({ playerId: p.id, bolts, reasons, won, alive: !!(m && m.alive) });
    }

    // Underdog top-up: nobody is left too poor to matter.
    const richest = Math.max(...this.players.map((p) => p.money));
    const floor = Math.round(richest * ECONOMY.underdogFraction);
    for (const p of this.players) {
      if (p.money < floor) {
        const lift = floor - p.money;
        p.money = floor;
        const a = awards.find((x) => x.playerId === p.id);
        a.bolts += lift;
        a.reasons.push(['underdog', lift]);
      }
    }

    this.lastAwards = awards;
    this.roundEnding = false;
    this.currentId = null;
    this.state = 'scoreboard';
    this.autoTimer = 0;
    for (const p of this.players) p.ready = false;
    this.events.push({ type: 'roundOver', round: this.round, winnerId: winnerMech ? winnerMech.playerId : null, winnerTeam });
    this.events.push({ type: 'awards', awards });
  }

  stepScoreboard(dt) {
    if (this.humans().length) return; // a human taps through
    this.autoTimer += dt;
    if (this.autoTimer >= AUTO_ADVANCE) this.openShop();
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------

  openShop() {
    if (this.round >= this.settings.rounds) { this.finish(); return; }
    this.state = 'shop';
    this.shopQueue = this.players.map((p) => p.id);
    this.nextShopper();
  }

  nextShopper() {
    if (this.shopperId) this.events.push({ type: 'shopDone', playerId: this.shopperId, purchases: this.lastPurchases });
    this.lastPurchases = [];
    if (!this.shopQueue.length) {
      this.shopperId = null;
      this.events.push({ type: 'shopClosed' });
      this.startRound();
      return;
    }
    this.shopperId = this.shopQueue.shift();
    const p = this.shopper();
    this.events.push({ type: 'shopOpen', playerId: p.id, isAI: p.isAI });
    if (p.isAI) {
      for (const itemId of AI.shop(p, this.rng)) this.buy(p, itemId);
      this.shopDwell = AI_SHOP_DWELL;
    }
  }

  stepShop(dt) {
    const p = this.shopper();
    if (!p || !p.isAI) return;
    this.shopDwell -= dt;
    if (this.shopDwell <= 0) this.nextShopper();
  }

  buy(p, itemId) {
    const w = weaponById(itemId);
    if (!w || w.hidden || w.price <= 0 || w.id !== itemId) return false;
    if (p.money < w.price) return false;
    p.money -= w.price;
    p.inventory[itemId] = (p.inventory[itemId] || 0) + w.pack;
    this.lastPurchases.push(itemId);
    this.events.push({ type: 'purchase', playerId: p.id, itemId, price: w.price, pack: w.pack, owned: p.inventory[itemId], money: p.money });
    return true;
  }

  /** The shop's rows for a player: what it costs and what they hold. */
  shopRows(p) {
    return SHOP_ITEMS.map((w) => ({
      item: w,
      owned: p.inventory[w.id] || 0,
      affordable: p.money >= w.price,
    }));
  }

  // -------------------------------------------------------------------------
  // The end
  // -------------------------------------------------------------------------

  finish() {
    this.state = 'matchOver';
    this.standings = this.players
      .slice()
      .sort((a, b) => b.score - a.score || b.roundWins - a.roundWins || b.kills - a.kills || b.money - a.money)
      .map((p, i) => ({ place: i + 1, playerId: p.id, name: p.name, score: p.score, roundWins: p.roundWins, kills: p.kills, deaths: p.deaths, damage: p.damageDealt, money: p.money }));
    this.events.push({ type: 'matchOver', standings: this.standings });
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Bots slide their walk marker at this many px per second. */
const AI_MOVE_RATE = 260;

/** Move `v` toward `target` by at most `maxDelta`, landing exactly on it. */
function approach(v, target, maxDelta) {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}
