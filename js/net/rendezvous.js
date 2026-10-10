/*
 * rendezvous.js — how two browsers find each other.
 *
 * NeonFox's file (neonfox/js/net/rendezvous.js), with Lobbots' broker prefix
 * and its own words in the messages. Read the trade below before changing who
 * is asked to introduce two players.
 *
 * The game itself never goes through any of this. Once the data channels are
 * up, peers talk directly and none of it is involved again — which is also
 * why a broker being down only stops *new* games from starting.
 *
 * Three ways, tried in this order (hub CLAUDE.md §8):
 *
 *   relay    an explicit meta[name="signal-url"], if you want to run your own.
 *   broker   PeerJS's public broker. Nothing of ours runs anywhere, which is
 *            the whole point on GitHub Pages: there is no server to wake.
 *   tabs     BroadcastChannel. Reaches other tabs in this browser and nothing
 *            else, so it is a last resort and the lobby says so rather than
 *            looking broken.
 *
 * WHY PEERJS ONLY CARRIES SIGNALLING HERE. fishtank uses a PeerJS data
 * connection as the game connection, and pays for it with a single reliable
 * lane on the broker path — its two-lane code only runs over the relay. A
 * PeerJS connection is reliable or, at best, unordered-but-still-retransmitted;
 * there is no maxRetransmits: 0 to be had through it. So this file uses the
 * broker connection as a pipe for OFFER/ANSWER/ICE and nothing else, and every
 * tier then negotiates the same RTCPeerConnection with the same two lanes
 * webrtc.js builds. The cost is real and worth naming: two WebRTC handshakes
 * instead of one, so joining through the broker takes a second or so longer.
 * The gain is that the lane rules in webrtc.js are true everywhere, rather
 * than true on one transport and quietly not on the one everybody uses.
 *
 * A public broker is a real trade, stated plainly:
 *   - a third party with no promises. Down means no new games; games already
 *     connected are untouched, because it carries no game traffic.
 *   - it sees room codes and connection metadata. It never sees game data.
 *   - no TURN, so a minority of network situations fail to connect at all.
 * Against that, it needs nothing running and nothing paid for.
 */

import { spellCode as spell } from "./codes.js";
import {
  broadcastSignalling,
  relaySignalling,
  hostOverWebRTC,
  joinOverWebRTC,
} from "./webrtc.js";

/*
 * Pinned to an exact version with an integrity hash, with a byte-identical
 * local copy behind it (hub CLAUDE.md §1). fishtank ships this CDN tag with
 * no vendor copy and loses multiplayer entirely to one filter rule; the hub
 * file calls that out as a gap rather than a pattern, so vendor/peerjs.js is
 * committed here and verified to hash to exactly the string below.
 *
 * Loaded lazily, on the first attempt to host or join. A player who never
 * touches multiplayer never fetches it.
 */
const PEERJS = {
  url: "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js",
  integrity:
    "sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu",
  local: "vendor/peerjs.js",
};

/* The broker's id space is shared with every other PeerJS app in the world,
 * so codes are namespaced. Lobbots' own prefix, not NeonFox's or fishtank's. */
const brokerId = (code) => `lobbots-v1-${code}`;

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = "anonymous";
    }
    // Answered here, and the player is told what it means — so index.html's
    // crash bar leaves this tag alone rather than throwing a fatal-looking
    // red strip over a game that still plays perfectly well alone.
    script.dataset.handled = "peerjs";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(script);
  });
}

/*
 * An Error a person can be shown. `key` (and `args`) are what js/i18n.js
 * renders, in whichever language this device speaks; the English message is
 * only for the console. This file never builds a sentence for the screen.
 */
function said(key, message, ...args) {
  return Object.assign(new Error(message), { key, args });
}

let loading = null;
function loadBroker() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (loading) return loading;
  loading = (async () => {
    try {
      await loadScript(PEERJS.url, PEERJS.integrity);
    } catch {
      // Blocked or offline. The local copy is the same bytes, so this is a
      // fallback rather than a downgrade.
      await loadScript(PEERJS.local, null).catch(() => {
        throw window.navigator?.onLine === false
          ? said("offline", "Offline: no way to find the other device.")
          : said("noBroker", "The matchmaking code could not load, from the CDN or from this site.");
      });
    }
    if (!window.Peer)
      throw said("brokerBroken", "The matchmaking code loaded but is unusable.");
    return window.Peer;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

/*
 * A signalling channel over the broker: PeerJS connections used as pipes.
 *
 * The host gets one connection per guest and has to route by the `to` field
 * webrtc.js puts on every message, so it learns which connection a signalling
 * id lives behind the first time that id says anything.
 */
function brokerHostSignalling(peer) {
  const listeners = new Set();
  const pipes = new Set();
  const routes = new Map(); // signalling id -> PeerJS connection
  const deliver = (connection, data) => {
    if (!data || typeof data !== "object") return;
    if (typeof data.from === "string") routes.set(data.from, connection);
    for (const fn of listeners) fn(data);
  };
  peer.on("connection", (connection) => {
    pipes.add(connection);
    connection.on("data", (data) => deliver(connection, data));
    connection.on("close", () => pipes.delete(connection));
    connection.on("error", () => pipes.delete(connection));
  });
  return {
    post(message) {
      const target = message?.to ? routes.get(message.to) : null;
      const send = (c) => {
        try {
          c.send(message);
        } catch {
          /* A pipe that died takes its guest with it; nothing to do here. */
        }
      };
      if (target) send(target);
      else for (const c of pipes) send(c);
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close() {
      listeners.clear();
      for (const c of pipes) {
        try {
          c.close();
        } catch {
          /* Already gone. */
        }
      }
      pipes.clear();
    },
  };
}

function brokerGuestSignalling(connection) {
  const listeners = new Set();
  connection.on("data", (data) => {
    if (data && typeof data === "object") for (const fn of listeners) fn(data);
  });
  return {
    post(message) {
      try {
        connection.send(message);
      } catch {
        /* joinOverWebRTC's timeout is the backstop. */
      }
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close() {
      listeners.clear();
      try {
        connection.close();
      } catch {
        /* Already gone. */
      }
    },
  };
}

const configuredRelay = () =>
  document.querySelector('meta[name="signal-url"]')?.content?.trim() || "";

const waitFor = (peer, ms, onError) =>
  new Promise((resolve, reject) => {
    peer.on("open", resolve);
    peer.on("error", (error) => reject(onError(error)));
    setTimeout(() => reject(said("mmTimeout", "Matchmaking timed out.")), ms);
  });

/* Take the code the host was given and start listening for guests. */
export async function hostRendezvous(code, onPeer) {
  const relay = configuredRelay();
  if (relay) {
    const signalling = relaySignalling(code, relay);
    const rtc = hostOverWebRTC(signalling, onPeer);
    return {
      mode: "relay",
      detail: "through your own relay",
      close: rtc.close,
    };
  }
  try {
    const Peer = await loadBroker();
    const peer = new Peer(brokerId(code));
    await waitFor(
      peer,
      20000,
      (error) =>
        error.type === "unavailable-id"
          ? said("codeTaken", "That code is already in use.")
          : said("mmFailed", `Matchmaking failed (${error.type}).`, error.type),
    );
    const signalling = brokerHostSignalling(peer);
    const rtc = hostOverWebRTC(signalling, onPeer);

    /*
     * Holding the code is not a one-off. The broker drops any peer whose
     * heartbeat stops and releases its id with it, and a locked screen or a
     * switched-to app is enough to stop the heartbeat. Nothing tells the
     * host: the page still shows an open lobby while the code has quietly
     * stopped resolving, which is exactly what a friend's "no game found"
     * is. fishtank measured 90 frozen seconds as plenty to lose it.
     *
     * So reclaim the id whenever we notice it is gone. The visibility event
     * alone is not enough — it can fire while the page is frozen, where the
     * reconnect cannot get out — so a slow beat looks as well.
     */
    let watchers = new Set();
    // `note` is a key for js/i18n.js (`err.*`) and `args` its arguments.
    let health = { reachable: true, note: "", args: [] };
    const report = (reachable, note, ...args) => {
      health = { reachable, note, args };
      for (const watcher of watchers) watcher(health);
    };
    const revive = () => {
      if (peer.destroyed || !peer.disconnected) return;
      report(false, "reopening");
      try {
        peer.reconnect();
      } catch {
        /* The next beat tries again. */
      }
    };
    peer.on("disconnected", revive);
    peer.on("open", () => report(true, "")); // emitted again on every reconnect
    peer.on("error", (error) =>
      report(
        false,
        ...(error.type === "unavailable-id"
          ? ["codeStolen"]
          : ["mmTrouble", error.type]),
      ),
    );
    const beat = setInterval(revive, 5000);
    document.addEventListener("visibilitychange", revive);
    return {
      mode: "broker",
      detail: "no server needed",
      /* Lets the lobby say whether the code is actually live, rather than
       * assume it stayed live because it once was. */
      watch(fn) {
        watchers.add(fn);
        fn(health);
        return () => watchers.delete(fn);
      },
      close() {
        clearInterval(beat);
        document.removeEventListener("visibilitychange", revive);
        watchers = new Set();
        rtc.close();
        peer.destroy();
      },
    };
  } catch (error) {
    // Offline or blocked: still useful for two tabs on this device, and the
    // lobby says exactly that rather than failing silently.
    const signalling = broadcastSignalling(code);
    const rtc = hostOverWebRTC(signalling, onPeer);
    return { mode: "tabs", detail: error.message, detailError: error, close: rtc.close };
  }
}

/* Join the game behind a code. Resolves with a channel, or throws with a
 * message worth showing to a person. */
export async function joinRendezvous(code) {
  const relay = configuredRelay();
  if (relay) {
    const signalling = relaySignalling(code, relay);
    const channel = await joinOverWebRTC(signalling);
    return { mode: "relay", channel, close: signalling.close };
  }
  let Peer;
  try {
    Peer = await loadBroker();
  } catch (error) {
    // No broker at all: the other tab in this browser is still reachable,
    // which is exactly the case a parent testing on one laptop is in.
    const signalling = broadcastSignalling(code);
    const channel = await joinOverWebRTC(signalling);
    return {
      mode: "tabs",
      channel,
      close: signalling.close,
      detail: error.message,
    };
  }
  const peer = new Peer();
  await waitFor(
    peer,
    20000,
    (error) => said("mmFailed", `Matchmaking failed (${error.type}).`, error.type),
  );
  const pipe = peer.connect(brokerId(code), { reliable: true });
  await new Promise((resolve, reject) => {
    pipe.on("open", resolve);
    // peer-unavailable is a mistyped code, a finished game — or a host whose
    // screen went to sleep, which drops it off the broker. Worth saying,
    // because from here the three are indistinguishable and only one of them
    // is the player's own fault.
    peer.on("error", (error) =>
      reject(
        error.type === "peer-unavailable"
          ? said("noGame", `No hangar found at ${spell(code)}.`, code)
          : said("unreachable", `Could not reach the game (${error.type}).`, error.type),
      ),
    );
    setTimeout(() => reject(said("hostSilent", "The host did not answer.")), 20000);
  });
  const signalling = brokerGuestSignalling(pipe);
  try {
    const channel = await joinOverWebRTC(signalling);
    return { mode: "broker", channel, close: () => peer.destroy() };
  } catch (error) {
    peer.destroy();
    throw error;
  }
}
