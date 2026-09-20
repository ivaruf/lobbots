/*
 * audio.js — the cue mixer: eleven short .m4a files, fetched once, played with
 * a pitch offset and a per-shot gain.
 *
 * WHY FILES AND NOT OSCILLATORS. Hub CLAUDE.md §9: a sound with character —
 * a pneumatic thump, gravel sliding, a cash register — is composed, not coded.
 * Every cue here is a Sonic Pi piece in tools/audio/<name>.rb, rendered offline
 * and encoded to mono AAC. The piece is the source of truth and audio/*.m4a is
 * an output, the same way tools/make-icons.py is the truth for the icons. The
 * runtime's whole job is therefore: decode them, keep a master gain, and give
 * main.js two knobs — `gain` and `rate` — so one boom can serve a pea-shooter
 * and a nuke without eleven more files.
 *
 * THE BALANCE IS AUTHORED, NOT MEASURED. The hub one-shot encoder lifts the
 * whole set by ONE shared gain, so the relative loudness written into the
 * pieces with `amp:` survives into the game: `click` really is quieter than
 * `boom`, and `boom-big` really is the loudest thing in the set. Nothing here
 * normalises per cue, and nothing should.
 *
 * THE CONTEXT IS LAZY. Browsers refuse to start audio before a user gesture,
 * so nothing is created until main.js calls unlock() from the first
 * pointerdown/keydown. Decoding starts there too — not at module load — which
 * also means the eleven fetches never compete with the first frame. Every
 * public method no-ops safely before that, so callers never guard a call: a cue
 * fired during the gap is simply lost, which is correct for a one-shot (a
 * whistle that arrives after the shell has landed is worse than no whistle).
 *
 * NOTHING HERE MAY THROW OR REJECT. index.html has a crash bar that catches
 * unhandled rejections, and a missing sound must never look like a broken game.
 * Each cue loads inside its own try/catch, warns once, and stays silent; play()
 * on a cue that never arrived does nothing at all.
 */

// Hub §6: <slug>.<thing>.v<n>, and the slug is lobbots even while the folder is
// still called tankwars.
const VOLUME_KEY = "lobbots.vol.sfx.v1";
const DEFAULT_VOLUME = 0.8;

/*
 * The cue list, and the file names under audio/. Order is only cosmetic — they
 * all load in parallel — but it is grouped the way the game uses them: firing,
 * flight, the four kinds of landing, the ground giving way, then the screens.
 */
export const CUES = [
  "fire",
  "whistle",
  "boom",
  "boom-big",
  "bounce",
  "splat",
  "crumble",
  "wreck",
  "kaching",
  "fanfare",
  "click",
];

/*
 * How many copies of ONE cue may sound at once.
 *
 * A cluster bomb splits into nine bomblets that land within about a second of
 * each other, and a MIRV does something similar; without a cap that is nine
 * simultaneous booms, which is both a mush and — because gains sum — far
 * louder than anything the piece was authored at. Six is enough to still read
 * as a cluster. When the cap is hit the OLDEST voice is stopped rather than the
 * newest dropped: the newest explosion is the one the player is looking at.
 */
const MAX_VOICES = 6;

// main.js scales `rate` by blast radius, so clamp it rather than trusting it:
// a rate of 0 would leave a source running forever and a huge one is a click.
const RATE_MIN = 0.25;
const RATE_MAX = 4;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function readStoredVolume() {
  try {
    const stored = localStorage.getItem(VOLUME_KEY);
    if (stored === null) return DEFAULT_VOLUME;
    return clamp(stored, 0, 1);
  } catch {
    // Private mode, or storage disabled entirely. Default volume, no fuss.
    return DEFAULT_VOLUME;
  }
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let volume = readStoredVolume();
  let loadStarted = false;

  /** name -> AudioBuffer. A name is present here only once it has decoded. */
  const buffers = new Map();
  /** name -> live AudioBufferSourceNodes, oldest first. See MAX_VOICES. */
  const voices = new Map();

  /*
   * decodeAudioData in both of its shapes. The promise form is what every
   * current browser gives back; older WebKit only ever calls the callbacks and
   * returns undefined. Resolving twice is harmless, so this covers both without
   * sniffing anything.
   */
  function decode(data) {
    return new Promise((resolve, reject) => {
      const maybe = ctx.decodeAudioData(data, resolve, reject);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
    });
  }

  async function loadCue(name) {
    try {
      const response = await fetch(`audio/${name}.m4a`);
      // A 404 still resolves the fetch, so check it: a missing file would
      // otherwise fail later, inside the decoder, with a far less useful error.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      buffers.set(name, await decode(data));
    } catch (err) {
      // One warning per cue, and then this cue is silent for the session. The
      // game is entirely playable without it — see the purpose block.
      console.warn(`Lobbots: cue "${name}" unavailable, playing silent`, err);
    }
  }

  /** Glide the master gain instead of snapping it, so dragging a volume
   *  slider ramps rather than clicking on every "input" event. */
  function applyVolume() {
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
  }

  /**
   * Create (or resume) the AudioContext and start decoding. Call from a user
   * gesture; calling it again afterwards is free and is how a tab returning
   * from the background gets its context resumed.
   */
  function unlock() {
    try {
      if (!ctx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return;
        ctx = new AudioCtor();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume();
    } catch {
      // No WebAudio, or the browser refused to build a context. play() checks
      // for a live context on every call, so the game just stays quiet.
      return;
    }

    if (loadStarted) return;
    loadStarted = true;
    // Eleven parallel fetches, each with its own catch inside loadCue, so this
    // Promise.all can never reject and never needs awaiting. Nothing waits on
    // it: cues become audible one at a time as they decode.
    Promise.all(CUES.map(loadCue));
  }

  /**
   * Play one cue.
   *
   * `gain` is a multiplier on the authored loudness (distance, or a small shell
   * against a big one). `rate` is playbackRate, which moves pitch and length
   * together — main.js drops the rate of `boom` for a wide blast and lifts it
   * for a narrow one, which is why the piece does not need eleven siblings.
   *
   * Silent no-op before unlock(), and silent no-op for a cue that failed to
   * load or a name that does not exist. Callers never check.
   */
  function play(name, { gain = 1, rate = 1 } = {}) {
    if (!ctx || !master) return;
    const buffer = buffers.get(name);
    if (!buffer) return;

    let live = voices.get(name);
    if (!live) {
      live = [];
      voices.set(name, live);
    }
    // Oldest first, so shift() is the one that has been sounding longest.
    while (live.length >= MAX_VOICES) {
      const oldest = live.shift();
      try {
        oldest.stop();
      } catch {
        // Already finished between its onended firing and now. Nothing to do.
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(rate, RATE_MIN, RATE_MAX);

    // One gain node per voice, not one per cue: two booms an eighth of a second
    // apart have different distances and therefore different gains, and a
    // shared node would rewrite the first one's level mid-decay.
    const env = ctx.createGain();
    env.gain.value = clamp(gain, 0, 4);

    source.connect(env).connect(master);
    source.onended = () => {
      const i = live.indexOf(source);
      if (i >= 0) live.splice(i, 1);
      try {
        // Let the graph go. Left connected, every shot of a long match would
        // keep a GainNode alive behind it.
        env.disconnect();
      } catch {
        // Already torn down.
      }
    };
    source.start(0);
    live.push(source);
  }

  /** 0..1, persisted. Takes effect immediately, live sources included. */
  function setVolume(v) {
    volume = clamp(v, 0, 1);
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // Storage unavailable; the in-memory value still governs this session.
    }
    applyVolume();
  }

  return {
    unlock,
    play,
    setVolume,
    /** The current effects volume, 0..1. Read by ui.js to paint the slider. */
    get volume() {
      return volume;
    },
  };
}
