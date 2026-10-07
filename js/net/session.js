/*
 * session.js — a hangar: the host's end and a guest's end of one online game.
 *
 * Between this file and the battle there are two pieces, and this file is
 * the plumbing between them and the network:
 *
 *   authority.js   the one Match that decides; on the host, in a worker
 *   replica.js     this device's copy, which main.js renders and steers
 *
 * HOST. openHangar() mints a code and listens on it (rendezvous.js). A guest
 * says hello; main.js decides whether there is a seat for them (admit) and
 * the setup screen shows them as one. Deploying sends every guest the
 * settings and the seats, starts the authority, and from then on routes:
 * the authority's stream to the host's own replica and to every guest, and
 * every guest's decisions back to the authority. A guest who goes is
 * dropped from the authority, which hands their seat to a bot.
 *
 * GUEST. joinHangar() finds the code, says hello and waits to be welcomed or
 * refused. Then it is a pipe: the room, the start, the stream, the end.
 *
 * Nobody joins a match already under way: there is no seat for them in a
 * Match that is already built, and the replica could not catch up anyway
 * without the whole history. They are told to wait for the next one.
 */

import { hostRendezvous, joinRendezvous } from './rendezvous.js';
import { newCode } from './codes.js';
import { NET_VERSION, HOST, cleanName, sendFramed, createJoiner } from './protocol.js';
import { createAuthority } from './authority.js';

/*
 * The authority, in a worker when we can and in the page when we cannot.
 * A module worker that fails to start says so with an error event before it
 * has said anything else, and then the page runs it instead — slower to
 * survive a background tab, but a game.
 */
function createEngine(init, onEmit) {
  let local = null;
  let worker = null;
  let heard = false;
  const startLocal = () => {
    local = createAuthority({ ...init, emit: onEmit, now: () => performance.now() });
    local.start();
  };
  try {
    worker = new Worker(new URL('./authority-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      heard = true;
      onEmit(data.msg, data.to);
    };
    worker.onerror = (e) => {
      if (heard) {
        console.warn('lobbots: the match referee stopped', e);
        return;
      }
      e.preventDefault?.();
      worker.terminate();
      worker = null;
      startLocal();
    };
    worker.postMessage({ type: 'init', ...init });
  } catch {
    worker = null;
    startLocal();
  }
  const post = (msg) => (worker ? worker.postMessage(msg) : null);
  return {
    input(device, msg) {
      if (worker) post({ type: 'input', device, msg });
      else local?.input(device, msg);
    },
    setSpeed(v) {
      if (worker) post({ type: 'speed', v });
      else local?.setSpeed(v);
    },
    drop(device) {
      if (worker) post({ type: 'drop', device });
      else local?.drop(device);
    },
    stop() {
      if (worker) {
        post({ type: 'stop' });
        worker = null;
      }
      local?.stop();
      local = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export async function openHangar() {
  const code = newCode();
  /** id -> { id, name, channel, inMatch } */
  const guests = new Map();
  let engine = null;

  const session = {
    kind: 'host',
    code,
    mode: '',
    detail: '',
    guests,
    /** (id, name) -> null to seat them, or the reason they are turned away. */
    admit: null,
    /** (id, gone, name) -> a guest arrived, or went (gone true). */
    onGuests: null,
    /** ({ reachable, note }) -> whether the code still resolves. */
    onHealth: null,
    get playing() { return !!engine; },

    /** Tell every guest in the hangar what it looks like now. */
    sendRoom(room) {
      for (const g of guests.values()) {
        if (!g.inMatch) g.channel.send({ t: 'room', ...room(g.id) });
      }
    },

    /**
     * Deploy. Every guest gets the settings and the seats and the ids that
     * are theirs; the authority starts; `toHost` receives the host's own
     * share of the stream. Returns what the host's page needs to steer.
     */
    startMatch({ settings, specs, owners, toHost, speed }) {
      for (const g of guests.values()) {
        g.inMatch = true;
        const mine = Object.keys(owners).filter((id) => owners[id] === g.id);
        g.channel.send({ t: 'start', settings, specs, mine });
      }
      engine = createEngine({ settings, specs, owners }, (msg, to) => {
        if (!to || to === HOST) toHost(msg);
        for (const g of guests.values()) {
          if (g.inMatch && (!to || to === g.id)) sendFramed(g.channel, msg);
        }
      });
      engine.setSpeed(speed);
      return {
        send: (msg) => engine?.input(HOST, msg),
        setSpeed: (v) => engine?.setSpeed(v),
      };
    },

    /** The match is over or abandoned; guests go back to the hangar. */
    endMatch(why = '') {
      engine?.stop();
      engine = null;
      for (const g of guests.values()) {
        if (g.inMatch) g.channel.send({ t: 'end', why });
        g.inMatch = false;
      }
    },

    close() {
      engine?.stop();
      engine = null;
      for (const g of guests.values()) {
        g.channel.send({ t: 'bye', why: 'The host closed the hangar.' });
        // Give the goodbye a moment to leave before the line goes.
        setTimeout(() => g.channel.close(), 300);
      }
      guests.clear();
      rendezvous?.close();
    },
  };

  function refuse(channel, why) {
    channel.send({ t: 'refused', why });
    setTimeout(() => channel.close(), 500);
  }

  function gone(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    try {
      g.channel.close();
    } catch {
      /* Already gone. */
    }
    if (engine && g.inMatch) engine.drop(id);
    session.onGuests?.(id, true, g.name);
  }

  function fromGuest(id, channel, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (guests.has(id)) return;
      if (msg.v !== NET_VERSION) {
        refuse(channel, 'You and the host are on different builds of Lobbots. Both reload and try again.');
        return;
      }
      if (engine) {
        refuse(channel, 'That hangar is in the middle of a match. Try again when it is over.');
        return;
      }
      const name = cleanName(msg.name);
      const why = session.admit ? session.admit(id, name) : null;
      if (why) {
        refuse(channel, why);
        return;
      }
      guests.set(id, { id, name, channel, inMatch: false });
      channel.send({ t: 'welcome', id });
      session.onGuests?.(id, false, name);
      return;
    }
    if (!guests.has(id)) return;
    if (msg.t === 'bye') {
      gone(id);
      return;
    }
    if (engine && guests.get(id).inMatch) engine.input(id, msg);
  }

  const rendezvous = await hostRendezvous(code, (id, channel) => {
    channel.onMessage = (msg) => fromGuest(id, channel, msg);
    channel.onClose = () => gone(id);
  });
  session.mode = rendezvous.mode;
  session.detail = rendezvous.detail;
  rendezvous.watch?.((health) => session.onHealth?.(health));
  return session;
}

// ---------------------------------------------------------------------------
// Guest
// ---------------------------------------------------------------------------

export async function joinHangar(code, name) {
  const rendezvous = await joinRendezvous(code);
  const channel = rendezvous.channel;
  const join = createJoiner();
  let closed = false;

  const session = {
    kind: 'guest',
    code,
    mode: rendezvous.mode,
    id: null,
    /** The host's last word on the hangar, kept for whoever asks late. */
    room: null,
    onRoom: null,
    onStart: null,
    onEnd: null,
    /** A message of the match stream (a, k, h, c, wait). */
    onStream: null,
    onClosed: null,
    send: (msg) => channel.send(msg),
    leave() {
      if (closed) return;
      closed = true;
      channel.send({ t: 'bye' });
      setTimeout(() => {
        channel.close();
        rendezvous.close?.();
      }, 300);
    },
  };

  const lost = (why) => {
    if (closed) return;
    closed = true;
    rendezvous.close?.();
    session.onClosed?.(why);
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      lost('');
      reject(new Error('The hangar never answered. Check the words, and ask your friend to keep it open.'));
    }, 12000);
    channel.onMessage = (raw) => {
      const msg = join(raw);
      if (!msg) return;
      switch (msg.t) {
        case 'welcome':
          clearTimeout(timer);
          session.id = String(msg.id);
          resolve(session);
          break;
        case 'refused':
          clearTimeout(timer);
          closed = true;
          rendezvous.close?.();
          reject(new Error(String(msg.why || 'The hangar turned us away.')));
          break;
        case 'room':
          session.room = msg;
          session.onRoom?.(msg);
          break;
        case 'start':
          session.onStart?.(msg);
          break;
        case 'end':
          session.onEnd?.(String(msg.why || ''));
          break;
        case 'bye':
          lost(String(msg.why || 'The host closed the hangar.'));
          break;
        default:
          session.onStream?.(msg);
      }
    };
    channel.onClose = () => {
      clearTimeout(timer);
      reject(new Error('The line to the hangar dropped.'));
      lost('The line to the host dropped.');
    };
    channel.send({ t: 'hello', v: NET_VERSION, name });
  });
}
