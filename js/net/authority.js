/*
 * authority.js — the one Match that decides an online game.
 *
 * Host-authoritative, as every multiplayer game in the hub is (hub CLAUDE.md
 * §8): the host's device runs this, every device including the host's own
 * page runs a replica (replica.js), and nothing a replica does changes the
 * game until it has come back from here stamped with a tick.
 *
 * What this adds to a plain Match is only the bookkeeping of being the
 * referee:
 *
 *   THE CLOCK. It steps the Match on its own timer and tells everyone how far
 *   it has got (k). Bot speed and Skip to results happen here, so they happen
 *   for everyone at once.
 *   DECISIONS. A guest's action is checked against the seats that device owns
 *   (protocol.cleanAction), applied, and only then broadcast with its tick.
 *   THE RESULTS TABLE. In hot-seat one tap moves everyone on; online, the
 *   table waits until every device with a person still playing has tapped.
 *   SOMEONE LEAVING. Their seats go to a bot by an `autopilot` action, so the
 *   round carries on and nobody has to start again.
 *   THE SEATBELT. A fingerprint at every quiet turn start, and on request a
 *   full checkpoint at the next quiet moment (sim/checkpoint.js).
 *
 * It knows nothing of the DOM or of WebRTC, so the same file runs in a Web
 * Worker (authority-worker.js, the normal case) or in the page (the fallback).
 * The worker is not a nicety: a browser throttles timers in a background tab
 * to a crawl, and fishtank measured what that does to a host — 3 updates in
 * 15 seconds instead of 62. Here it would mean a guest's shell hanging in the
 * air because the host glanced at another tab.
 */

import { SIM_DT } from '../config.js';
import { Match } from '../sim/match.js';
import { stateHash, snapshot, canCheckpoint } from '../sim/checkpoint.js';
import { cleanAction, HOST } from './protocol.js';

/** A Skip to results may play this much game time in one go, and no more. */
const SKIP_LIMIT = Math.ceil(900 / SIM_DT);

/**
 * @param settings  resolved settings with an explicit seed
 * @param specs     seat specs, in seat order, each with its player id
 * @param owners    { playerId: deviceId } for every human seat
 * @param emit      (msg, to?) — to a device, or to everyone when `to` is absent
 * @param now       ms clock (performance.now)
 */
export function createAuthority({ settings, specs, owners, emit, now }) {
  const match = new Match(settings, specs);
  const scratch = [];
  const devices = new Set(Object.values(owners));
  const ready = new Set();
  const wantCheckpoint = new Set();
  let tick = 0;
  let sentTick = -1;
  let acc = 0;
  let last = now();
  let speed = 1;
  let timer = null;
  let waitingFor = '';

  /** Hash every turn that starts on a quiet field, after whatever started it. */
  function afterChange() {
    for (const e of scratch) {
      if (e.type === 'turnStart' && match.world && match.world.isQuiet()) {
        emit({ t: 'h', k: tick, h: stateHash(match) });
      }
    }
    scratch.length = 0;
  }

  function stepOnce() {
    match.step(SIM_DT, scratch);
    tick++;
    afterChange();
  }

  function apply(action, origin, seq) {
    const ok = match.apply(action);
    if (ok) emit(seq === undefined ? { t: 'a', k: tick, a: action, o: origin } : { t: 'a', k: tick, a: action, o: origin, s: seq });
    afterChange();
    return ok;
  }

  function ownedBy(device) {
    const ids = new Set();
    for (const [playerId, owner] of Object.entries(owners)) if (owner === device) ids.add(playerId);
    return ids;
  }

  // The same two questions main.js asks for a hot-seat game.
  function humansOut() {
    if (!match.world || (match.state !== 'aim' && match.state !== 'firing')) return false;
    const humans = match.humans();
    if (!humans.length) return false;
    return humans.every((h) => {
      const m = match.world.mechFor(h.id);
      return !m || !m.alive;
    });
  }
  function onlyBotsLeft() {
    if (!match.world || (match.state !== 'aim' && match.state !== 'firing')) return false;
    return !match.humans().length || humansOut();
  }
  function botsPlaying() {
    if (match.state !== 'aim' && match.state !== 'firing') return false;
    const p = match.current();
    return (!!p && p.isAI) || humansOut();
  }

  /**
   * The results table moves on when every device that still has a person
   * playing has said so. A bot is never waited for, nor a device that left.
   */
  function checkReady() {
    if (match.state !== 'scoreboard') {
      ready.clear();
      if (waitingFor) { waitingFor = ''; emit({ t: 'wait', names: [] }); }
      return;
    }
    const pending = match.humans().filter((p) => devices.has(owners[p.id]) && !ready.has(owners[p.id]));
    if (!pending.length && match.humans().length) {
      ready.clear();
      apply({ type: 'ready', playerId: match.humans()[0].id }, HOST);
      return;
    }
    const names = pending.map((p) => p.name);
    const key = names.join('\u0000');
    if (key !== waitingFor) {
      waitingFor = key;
      emit({ t: 'wait', names });
    }
  }

  function serveCheckpoints() {
    if (!wantCheckpoint.size || !canCheckpoint(match)) return;
    const text = snapshot(match);
    for (const device of wantCheckpoint) emit({ t: 'c', k: tick, s: text }, device);
    wantCheckpoint.clear();
  }

  function loop() {
    const t = now();
    let dt = (t - last) / 1000;
    last = t;
    // A worker is not throttled the way a background page is, but a laptop
    // lid is a laptop lid. Turn-based: time the host was asleep for simply
    // never happened, the same rule main.js keeps for a hidden tab.
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;
    const s = botsPlaying() ? speed : 1;
    acc += dt * s;
    const max = Math.ceil(0.25 / SIM_DT) * s;
    let n = 0;
    while (acc >= SIM_DT && n < max) {
      stepOnce();
      acc -= SIM_DT;
      n++;
    }
    if (n === max) acc = 0;
    checkReady();
    serveCheckpoints();
    if (tick !== sentTick) {
      sentTick = tick;
      emit({ t: 'k', k: tick });
    }
  }

  return {
    /** For tools/net-smoke.mjs; nothing in the game reads it. */
    get match() { return match; },

    start() {
      match.start(scratch);
      afterChange();
      emit({ t: 'k', k: tick });
      sentTick = tick;
      last = now();
      timer = setInterval(loop, 1000 / 60);
    },

    /** Anything a device sent during the match. */
    input(device, msg) {
      if (!msg || typeof msg !== 'object' || !devices.has(device)) return;
      switch (msg.t) {
        case 'act': {
          const action = cleanAction(msg.a, ownedBy(device));
          if (!action) return;
          // The results table is the one ready that is a vote, not an action.
          if (action.type === 'ready' && match.state === 'scoreboard') {
            ready.add(device);
            checkReady();
            return;
          }
          apply(action, device, Number.isInteger(msg.s) ? msg.s : undefined);
          return;
        }
        case 'skip': {
          if (!onlyBotsLeft()) return;
          for (let i = 0; i < SKIP_LIMIT && (match.state === 'aim' || match.state === 'firing'); i++) stepOnce();
          acc = 0;
          return;
        }
        case 'need':
          wantCheckpoint.add(device);
          serveCheckpoints();
          return;
        default:
      }
    },

    /** The host's Bot speed slider. */
    setSpeed(v) {
      if (Number.isFinite(v) && v >= 1 && v <= 4) speed = v;
    },

    /** A device has gone. Its people become bots, from this tick, everywhere. */
    drop(device) {
      if (!devices.delete(device)) return;
      wantCheckpoint.delete(device);
      ready.delete(device);
      for (const id of ownedBy(device)) {
        const p = match.player(id);
        if (p && !p.isAI) apply({ type: 'autopilot', playerId: id }, HOST);
      }
      checkReady();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
