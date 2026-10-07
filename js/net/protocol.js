/*
 * protocol.js — what goes on the wire between a hangar's devices, and what is
 * allowed in off it.
 *
 * LOCKSTEP ON THE HOST'S CLOCK. Lobbots is the case NeonFox looked at and had
 * to turn down: turn-based, fixed-step, seeded. NeonFox could not send only
 * decisions because Math.cos and friends differ between Chrome and Safari;
 * Lobbots took those out of the sim instead (sim/dmath.js). So every device
 * runs the very same Match, and what travels is:
 *
 *   a  {k, a, o, s}  an action, applied after the host's k-th step.
 *                    o = whose device sent it, s = that device's sequence
 *                    number (replica.js uses both to keep its own barrel
 *                    responsive while the echo is still on its way).
 *   k  {k}           the host has stepped this far. A device never steps
 *                    past the last k it has heard, so it can never run ahead
 *                    into a turn whose decision has not reached it yet.
 *   h  {k, h}        the host's state fingerprint at the start of a turn
 *                    (sim/checkpoint.js). A device that disagrees asks for…
 *   c  {k, s}        …the whole Match as text, taken at a quiet moment, and
 *                    carries on from the host's state instead of its own.
 *   wait {names}     who the results table is still waiting on.
 *
 * Everything is one ordered, reliable stream, because every message is
 * stamped with the tick it belongs to and has to be applied in that order.
 * A lost or late message is not superseded by a newer one here, unlike a
 * state frame; there is nothing to be gained from a lossy lane.
 *
 * Bandwidth is the opposite of fishtank's problem: one k per host frame and a
 * handful of actions per turn is about a kilobyte a second, so nothing here is
 * packed. Only a checkpoint is big (the terrain alone is ~20 KB of JSON), and
 * it is cut into parts to stay inside the 16 KB interoperable message limit.
 *
 * In the lobby: hello / welcome / refused / room / start / end / bye.
 */

export const NET_VERSION = 1;
export const MAX_NAME = 14;

/** The host's own device, as an owner and as an origin. */
export const HOST = 'host';

/**
 * A name off the wire. Control characters out, runs of space folded, cut to
 * the width a seat card has room for. Never empty: the setup screen falls back
 * to the colour's name, and so does this.
 */
export function cleanName(raw, fallback = 'Lobbot') {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, MAX_NAME).join('') || fallback;
}

const ID = /^[a-z][a-z0-9-]{0,23}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * An action a guest asked for, rebuilt field by field from what Match.apply
 * reads, or null. `owned` is the set of player ids that device drives: a
 * guest may aim, fire, walk, shop and finish shopping for its own seat and
 * for nobody else's. Whose turn it is, what they can afford and what they
 * hold is Match's to judge — it already refuses everything out of turn,
 * because "a remote peer or a stale button must never break the machine".
 */
export function cleanAction(raw, owned) {
  if (!raw || typeof raw !== 'object') return null;
  const { type, playerId } = raw;
  if (typeof playerId !== 'string' || !owned.has(playerId)) return null;
  switch (type) {
    case 'aim': {
      const a = { type, playerId };
      if (num(raw.angle) !== undefined) a.angle = raw.angle;
      if (num(raw.power) !== undefined) a.power = raw.power;
      if (num(raw.moveX) !== undefined) a.moveX = raw.moveX;
      if (typeof raw.weaponId === 'string' && ID.test(raw.weaponId)) a.weaponId = raw.weaponId;
      return a;
    }
    case 'fire': {
      if (typeof raw.weaponId !== 'string' || !ID.test(raw.weaponId)) return null;
      if (num(raw.angle) === undefined || num(raw.power) === undefined) return null;
      return { type, playerId, weaponId: raw.weaponId, angle: raw.angle, power: raw.power };
    }
    case 'move':
      return num(raw.x) === undefined ? { type, playerId } : { type, playerId, x: raw.x };
    case 'buy':
      return typeof raw.itemId === 'string' && ID.test(raw.itemId) ? { type, playerId, itemId: raw.itemId } : null;
    case 'ready':
      return { type, playerId };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Big messages
// ---------------------------------------------------------------------------

/*
 * A part's text is JSON inside JSON, so every quote in it is escaped on the
 * way out and a 6,000-character slice can approach 12 KB on the wire. That is
 * the margin under the 16 KB a data channel message may safely be.
 */
const PART = 6000;
let nextPart = 1;

/** Send one message, cut into parts if it would be too big for one. */
export function sendFramed(channel, msg) {
  const text = JSON.stringify(msg);
  if (text.length <= PART) return channel.send(msg);
  const id = nextPart++;
  const n = Math.ceil(text.length / PART);
  for (let i = 0; i < n; i++) {
    if (!channel.send({ t: 'part', id, i, n, s: text.slice(i * PART, (i + 1) * PART) })) return false;
  }
  return true;
}

/** The receiving side: hands back whole messages, holds parts until complete. */
export function createJoiner() {
  let current = null;
  return (msg) => {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.t !== 'part') return msg;
    // The lane is ordered, so parts of one message arrive together and in
    // order; anything else is a fresh message starting over.
    if (!current || current.id !== msg.id || msg.i !== current.parts.length) {
      if (msg.i !== 0) return null;
      current = { id: msg.id, parts: [] };
    }
    current.parts.push(String(msg.s ?? ''));
    if (current.parts.length < msg.n) return null;
    const text = current.parts.join('');
    current = null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
}
