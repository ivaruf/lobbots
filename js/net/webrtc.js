/*
 * webrtc.js — the actual connection.
 *
 * NeonFox's file (neonfox/js/net/webrtc.js), which is fishtank's, carried over
 * with only the signalling namespace changed: the handshake is the same
 * problem in every game, and two copies that read alike are easier to keep
 * honest than two that drifted for no reason.
 *
 * Everything above this file talks to "channels": anything with
 * send(value, fast), onMessage and onClose. That keeps authority.js and
 * replica.js innocent of WebRTC entirely, and it is why the same protocol runs
 * over a real RTCDataChannel, over BroadcastChannel between two tabs, or over
 * a postMessage to the host's own worker.
 *
 * Signalling is deliberately pluggable, because signalling is the only part a
 * static site on GitHub Pages cannot do by itself. Two transports live here —
 * BroadcastChannel and a WebSocket relay — and rendezvous.js adds a third by
 * borrowing a public broker's connection purely as a pipe for the messages
 * below. All three carry the same plain objects.
 *
 * TWO LANES ARE OPENED AND LOBBOTS USES ONE. NeonFox streams state frames on
 * an unreliable "fast" lane. Lobbots sends decisions, not state, and every
 * message is stamped with the tick it belongs to and must arrive in order
 * (protocol.js), so everything goes on the reliable, ordered "game" lane and
 * "fast" sits idle. It stays because removing it would make this the one copy
 * of the file that differs in shape for a saving of nothing.
 */

const ICE = {
  // One public STUN server, and no TURN. STUN only tells a peer its own
  // public address; no game traffic passes through it. TURN would relay the
  // traffic itself, which costs bandwidth by the gigabyte — see docs/P2P.md
  // for what that means for the roughly one connection in ten that needs it.
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};
const UNRELIABLE = { ordered: false, maxRetransmits: 0 };

/* Same browser, different tabs. No third party at all, and it exercises the
 * whole WebRTC path, which is what makes it a usable local test. */
export function broadcastSignalling(code) {
  const bus = new BroadcastChannel(`lobbots-signal-${code}`);
  const listeners = new Set();
  bus.onmessage = (e) => {
    for (const fn of listeners) fn(e.data);
  };
  return {
    post: (message) => bus.postMessage(message),
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close: () => bus.close(),
  };
}

/* Any tiny WebSocket that echoes messages within a room, for running your own. */
export function relaySignalling(code, url) {
  const socket = new WebSocket(url);
  const listeners = new Set();
  const backlog = [];
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "SIGNAL_JOIN", room: code }));
    for (const m of backlog.splice(0)) socket.send(JSON.stringify(m));
  });
  socket.addEventListener("message", (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    if (data?.room === code) for (const fn of listeners) fn(data);
  });
  return {
    post(message) {
      const framed = { ...message, room: code };
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(framed));
      else backlog.push(framed);
    },
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    close: () => socket.close(),
  };
}

/* Wrap a pair of data channels as one channel with an explicit lane. */
function wrap(reliable, fast, connection) {
  let closed = false;
  const channel = {
    get open() {
      return !closed && reliable.readyState === "open";
    },
    send(value, useFast = false) {
      const binary = value instanceof Uint8Array;
      const lane = useFast && fast?.readyState === "open" ? fast : reliable;
      if (lane.readyState !== "open") return false;
      // A subarray shares its buffer with the whole allocation, so send a
      // copy of just this frame rather than everything the packer had room
      // for. (fishtank's note, and it is still true.)
      try {
        lane.send(binary ? value.slice() : JSON.stringify(value));
      } catch {
        return false;
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        connection.close();
      } catch {
        /* Already gone. */
      }
      channel.onClose?.();
    },
    onMessage: null,
    onClose: null,
  };
  const receive = (e) => {
    if (typeof e.data !== "string") {
      channel.onMessage?.(new Uint8Array(e.data));
      return;
    }
    let value;
    try {
      value = JSON.parse(e.data);
    } catch {
      return;
    }
    channel.onMessage?.(value);
  };
  for (const lane of [reliable, fast])
    if (lane) {
      // Not the default everywhere, and a Blob would arrive as a promise the
      // synchronous receive path above cannot read.
      lane.binaryType = "arraybuffer";
      lane.onmessage = receive;
    }
  connection.onconnectionstatechange = () => {
    if (
      ["failed", "closed", "disconnected"].includes(connection.connectionState)
    )
      channel.close();
  };
  return channel;
}

/*
 * Descriptions and candidates are platform objects, not plain data: posting
 * one through BroadcastChannel throws DataCloneError, and JSON.stringify of a
 * candidate is not portable either. Every transport gets plain objects.
 */
const plainDescription = (d) => ({ type: d.type, sdp: d.sdp });
const plainCandidate = (c) =>
  typeof c.toJSON === "function"
    ? c.toJSON()
    : {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
        usernameFragment: c.usernameFragment,
      };

const opened = (lane) =>
  new Promise((resolve, reject) => {
    if (lane.readyState === "open") return resolve(lane);
    lane.onopen = () => resolve(lane);
    lane.onerror = reject;
  });

/* Host: answer anyone who offers, and hand each finished channel up. */
export function hostOverWebRTC(signalling, onPeer) {
  const pending = new Map();
  const handler = async (message) => {
    if (message?.from === undefined) return;
    const id = message.from;
    try {
      if (message.type === "OFFER") {
        // A second offer from an id we already answered is a guest that
        // reloaded. Drop the stale connection rather than keep two.
        pending.get(id)?.close();
        const connection = new RTCPeerConnection(ICE);
        pending.set(id, connection);
        const lanes = {};
        connection.ondatachannel = (e) => {
          lanes[e.channel.label] = e.channel;
          // Both lanes present means the guest is ready to play.
          if (lanes.game && lanes.fast)
            onPeer(id, wrap(lanes.game, lanes.fast, connection));
        };
        connection.onicecandidate = (e) => {
          if (e.candidate)
            signalling.post({
              type: "ICE",
              to: id,
              from: "host",
              candidate: plainCandidate(e.candidate),
            });
        };
        await connection.setRemoteDescription(message.description);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        signalling.post({
          type: "ANSWER",
          to: id,
          from: "host",
          description: plainDescription(answer),
        });
      } else if (message.type === "ICE" && message.to === "host") {
        const connection = pending.get(id);
        if (connection && message.candidate)
          await connection.addIceCandidate(message.candidate).catch(() => {});
      }
    } catch {
      // A malformed offer is one guest's problem, not the lobby's; the rest
      // of the room keeps playing.
    }
  };
  signalling.on(handler);
  return {
    close() {
      signalling.off(handler);
      for (const connection of pending.values()) connection.close();
      pending.clear();
      signalling.close();
    },
  };
}

/* Guest: offer, wait for the answer, resolve once both lanes are open. */
export async function joinOverWebRTC(signalling, { timeout = 15000 } = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  const connection = new RTCPeerConnection(ICE);
  const reliable = connection.createDataChannel("game");
  const fast = connection.createDataChannel("fast", UNRELIABLE);
  connection.onicecandidate = (e) => {
    if (e.candidate)
      signalling.post({
        type: "ICE",
        to: "host",
        from: id,
        candidate: plainCandidate(e.candidate),
      });
  };
  const handler = async (message) => {
    if (message?.to !== id) return;
    try {
      if (message.type === "ANSWER")
        await connection.setRemoteDescription(message.description);
      else if (message.type === "ICE" && message.candidate)
        await connection.addIceCandidate(message.candidate).catch(() => {});
    } catch {
      /* The timeout below is the backstop. */
    }
  };
  signalling.on(handler);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  signalling.post({
    type: "OFFER",
    from: id,
    description: plainDescription(offer),
  });
  try {
    await Promise.race([
      Promise.all([opened(reliable), opened(fast)]),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              // `key` is what js/i18n.js shows; the message is for the console.
              Object.assign(new Error("The host never answered (no TURN)."), {
                key: "noTurn",
              }),
            ),
          timeout,
        ),
      ),
    ]);
  } catch (error) {
    signalling.off(handler);
    connection.close();
    throw error;
  }
  signalling.off(handler);
  return wrap(reliable, fast, connection);
}
