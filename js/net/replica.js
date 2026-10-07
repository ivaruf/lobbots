/*
 * replica.js — this device's copy of an online match, kept in step with the
 * host's.
 *
 * Every device runs a full Match: the host's own page as much as a guest's.
 * Nothing about the battle is sent — no shells, no craters, no health — only
 * the decisions and how far the host's clock has got (protocol.js). Because
 * the sim is deterministic, stepping the same Match through the same
 * decisions at the same ticks IS the host's battle, and the renderer, the
 * sounds and the screens all work exactly as they do in hot-seat, from events
 * this device's own Match emits. That is the whole reason to do it this way.
 *
 * PACING. The replica never steps past the last tick the host announced, so
 * it can never run into a turn whose decision has not arrived. It plays at
 * real speed and spends a little extra on any backlog — an eighth of it per
 * frame — so it trails the host by a few frames normally and catches up from
 * a hiccup without a visible lurch. When the host plays bots at ×4 the
 * backlog simply settles a little deeper. A backlog of seconds (a hidden tab,
 * a Skip to results) is fast-forwarded in one go instead, and the caller
 * redraws from the result rather than replaying a minute of explosions.
 *
 * YOUR OWN BARREL. Waiting a round trip to see your own aim move would make
 * the dial feel like it is wading through mud, so an aim from this device is
 * applied here at once and sent with a sequence number. The host's echo of
 * an older aim is then skipped — this device already has a newer one — and
 * the echo of the latest is applied, which changes nothing because aims are
 * absolute. Everything else (fire, walk, buy) waits for the host: those
 * decide the game, and a shot must leave on the host's tick, not ours.
 *
 * THE SEATBELT. At every quiet turn start the host sends its state
 * fingerprint; if ours differs, we ask for a checkpoint and carry on from
 * the host's state when it comes (sim/checkpoint.js). It should never fire.
 * If it does, the console says so, because it means a bug worth finding.
 */

import { SIM_DT } from '../config.js';
import { stateHash, restore } from '../sim/checkpoint.js';

/** More than this many ticks behind (2.5 s) is fast-forwarded, not played. */
const FAST_FORWARD = Math.round(2.5 / SIM_DT);

/**
 * @param me        this device's id, to recognise the echo of its own aims
 * @param send      (msg) -> to the authority
 * @param onResync  () -> the Match was replaced from a checkpoint
 * @param onWait    (names) -> who the results table is waiting on
 */
export function createReplica({ me, send, onResync, onWait }) {
  let queue = [];
  let head = 0;
  let tick = 0;
  let hostTick = 0;
  let acc = 0;
  let seq = 0;
  let asked = false;
  let match = null;

  function push(msg) {
    // Consecutive clock messages say only "the latest one"; keep one.
    if (msg.t === 'k' && queue.length > head && queue[queue.length - 1].t === 'k') queue[queue.length - 1] = msg;
    else queue.push(msg);
    if (msg.k > hostTick) hostTick = msg.k;
  }

  function applyRemote(msg) {
    // An older echo of our own aim: we already show a newer one.
    if (msg.o === me && msg.a.type === 'aim' && msg.s < seq) return;
    match.apply(msg.a);
  }

  function check(msg) {
    if (asked) return;
    const h = stateHash(match);
    if (h === msg.h) return;
    asked = true;
    console.warn(`lobbots: out of step with the host at tick ${msg.k} (${h} vs ${msg.h}); asking for a checkpoint`);
    send({ t: 'need' });
  }

  /** Step and apply in stream order, at most `budget` steps. */
  function drain(budget, events) {
    while (head < queue.length) {
      const msg = queue[head];
      if (msg.k > tick) {
        if (budget <= 0) break;
        match.step(SIM_DT, events);
        tick++;
        budget--;
        continue;
      }
      head++;
      if (msg.k < tick) continue;
      if (msg.t === 'a') applyRemote(msg);
      else if (msg.t === 'h') check(msg);
    }
    if (head > 256 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
  }

  return {
    get tick() { return tick; },
    get behind() { return hostTick - tick; },

    /** The Match this replica drives; started by the caller at tick 0. */
    attach(m) {
      match = m;
      queue = [];
      head = 0;
      tick = 0;
      hostTick = 0;
      acc = 0;
      asked = false;
    },

    receive(msg) {
      if (!match || !msg) return;
      switch (msg.t) {
        case 'a':
        case 'k':
        case 'h':
          push(msg);
          break;
        case 'c':
          // Everything queued so far is already inside the checkpoint.
          try {
            restore(match, msg.s);
          } catch (error) {
            console.warn('lobbots: checkpoint refused', error);
            return;
          }
          queue = [];
          head = 0;
          tick = msg.k;
          if (hostTick < tick) hostTick = tick;
          acc = 0;
          asked = false;
          onResync?.();
          break;
        case 'wait':
          onWait?.(Array.isArray(msg.names) ? msg.names : []);
          break;
        default:
      }
    },

    /**
     * Advance toward the host. Returns true when it fast-forwarded, in which
     * case `events` holds nothing worth reacting to one by one and the caller
     * should redraw from the state instead.
     */
    advance(dt, events) {
      if (!match) return false;
      const behind = hostTick - tick;
      if (behind > FAST_FORWARD) {
        drain(Infinity, []);
        acc = 0;
        return true;
      }
      acc += dt;
      let budget = Math.floor(acc / SIM_DT);
      acc -= budget * SIM_DT;
      budget += Math.floor(behind / 8);
      // Caught up: no debt to carry into the next frame.
      if (budget >= behind) acc = 0;
      drain(budget, events);
      return false;
    },

    /** A decision from this device; the host applies it and echoes it back. */
    act(action) {
      if (action.type === 'aim') {
        match.apply(action);
        seq++;
        send({ t: 'act', a: action, s: seq });
      } else {
        send({ t: 'act', a: action });
      }
    },

    send,
  };
}
