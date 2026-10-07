/*
 * net-smoke.mjs — an online match with nobody watching and no network.
 *
 * The authority (js/net/authority.js) and two replicas (js/net/replica.js)
 * talk through in-memory queues with a little random delay, exactly the
 * messages they would send over a data channel (each one round-tripped
 * through JSON, as the channel does). Two seats are "people", one per
 * replica, who fire at random, shop a little and tap through the results;
 * the rest are bots. It checks what lockstep promises:
 *
 *   - both replicas reach the same final standings as each other, through
 *     rounds, the shop and new hills, without ever asking for a checkpoint;
 *   - a replica that is deliberately knocked out of step is caught by the
 *     next fingerprint, asks for a checkpoint, and finishes in step;
 *   - a device leaving mid-match hands its seat to a bot and the match ends.
 *
 * The clock runs twelve times fast so a match takes seconds. Like
 * sim-smoke.mjs it is one command and a printed verdict, not a test suite
 * (hub CLAUDE.md §11).
 *
 * Run: node tools/net-smoke.mjs
 */

import { resolveSettings } from '../js/config.js';
import { Match } from '../js/sim/match.js';
import { stateHash } from '../js/sim/checkpoint.js';
import { createAuthority } from '../js/net/authority.js';
import { createReplica } from '../js/net/replica.js';

function assert(ok, msg) {
  if (!ok) throw new Error('net-smoke: ' + msg);
}

const FAST = 12;
const clock = () => performance.now() * FAST;
const wire = (v) => JSON.parse(JSON.stringify(v));

/**
 * A one-way pipe with 0–60 ms of delay that never reorders, as a reliable
 * data channel never does. One queue drained in order — a timer per message
 * would not do: Node does not promise to fire timers with different
 * fractional delays in the order they were set.
 */
function pipe(deliver) {
  const queue = [];
  let ready = 0;
  setInterval(() => {
    const t = Date.now();
    while (queue.length && queue[0].at <= t) deliver(queue.shift().msg);
  }, 4).unref();
  return (msg) => {
    ready = Math.max(ready, Date.now() + Math.random() * 60);
    queue.push({ at: ready, msg: wire(msg) });
  };
}

function run({ name, corruptAt = 0, dropAt = 0 }) {
  return new Promise((resolve, reject) => {
    const settings = resolveSettings('quick', { rounds: 2, startMoney: 1500, seed: 777, shotTimer: 0 });
    const specs = [
      { id: 'p0', name: 'Ana', colorIndex: 0, isAI: false },
      { id: 'p1', name: 'Calc', colorIndex: 1, isAI: true, personality: 'calculator' },
      { id: 'p2', name: 'Bo', colorIndex: 2, isAI: false },
      { id: 'p3', name: 'Rook', colorIndex: 3, isAI: true, personality: 'rookie' },
    ];
    const owners = { p0: 'host', p2: 'g1' };
    const devices = { host: 'p0', g1: 'p2' };

    const replicas = {};
    const matches = {};
    const toDevice = {};
    let authority = null;
    const toAuthority = {};
    for (const device of Object.keys(devices)) {
      toAuthority[device] = pipe((msg) => authority.input(device, msg));
    }
    let resyncs = 0;
    authority = createAuthority({
      settings, specs, owners, now: clock,
      emit: (msg, to) => {
        for (const device of Object.keys(devices)) if (!to || to === device) toDevice[device](msg);
      },
    });

    const stats = { shots: 0, buys: 0 };
    for (const device of Object.keys(devices)) {
      const events = [];
      const match = new Match(wire(settings), wire(specs));
      const replica = createReplica({
        me: device,
        send: (msg) => toAuthority[device](msg),
        onResync: () => { resyncs++; },
      });
      replica.attach(match);
      match.start(events);
      replicas[device] = { replica, events, mine: devices[device], acted: -1, left: false };
      matches[device] = match;
      toDevice[device] = pipe((msg) => replica.receive(msg));
    }
    authority.start();

    let last = performance.now();
    let corrupted = false;
    let dropped = false;
    const started = Date.now();
    const loop = setInterval(() => {
      const t = performance.now();
      const dt = ((t - last) / 1000) * FAST;
      last = t;
      try {
        for (const device of Object.keys(devices)) {
          const r = replicas[device];
          if (r.left) continue;
          const match = matches[device];
          r.replica.advance(Math.min(dt, 0.25), r.events);
          r.events.length = 0;
          const me = match.player(r.mine);
          // A person, acting at most once per tick so a slow echo is not doubled.
          if (r.acted === r.replica.tick) continue;
          if (match.state === 'aim' && match.currentId === me.id && !me.isAI && !match.roundEnding) {
            r.acted = r.replica.tick;
            r.replica.act({ type: 'aim', playerId: me.id, angle: me.angle + (Math.random() < 0.5 ? -3 : 3) });
            if (Math.random() < 0.08) {
              const arsenal = match.arsenal(me).filter((w) => w.category !== 'utility');
              const w = arsenal[Math.floor(Math.random() * arsenal.length)];
              r.replica.act({ type: 'fire', playerId: me.id, weaponId: w.id, angle: 30 + Math.random() * 120, power: 40 + Math.random() * 55 });
              stats.shots++;
            }
          } else if (match.state === 'shop' && match.shopperId === me.id && !me.isAI) {
            r.acted = r.replica.tick;
            if (Math.random() < 0.5 && me.money >= 250) { r.replica.act({ type: 'buy', playerId: me.id, itemId: 'heavy' }); stats.buys++; }
            else r.replica.act({ type: 'ready', playerId: me.id });
          } else if (match.state === 'scoreboard') {
            r.acted = r.replica.tick;
            r.replica.act({ type: 'ready', playerId: me.id });
          }
        }

        // Knock the guest out of step once, mid-round, and see it caught.
        const g = matches.g1;
        if (corruptAt && !corrupted && g.world && g.state === 'aim' && replicas.g1.replica.tick > corruptAt) {
          corrupted = true;
          g.world.mechs[0].health -= 7;
        }
        // Or have the guest walk away mid-round.
        if (dropAt && !dropped && replicas.g1.replica.tick > dropAt) {
          dropped = true;
          replicas.g1.left = true;
          authority.drop('g1');
        }

        const host = matches.host;
        const done = host.state === 'matchOver' && (replicas.g1.left || (g.state === 'matchOver' && replicas.g1.replica.behind === 0));
        if (done) {
          clearInterval(loop);
          authority.stop();
          if (!replicas.g1.left) {
            assert(stateHash(host) === stateHash(g), `${name}: final states differ`);
            assert(JSON.stringify(host.standings) === JSON.stringify(g.standings), `${name}: standings differ`);
          }
          resolve({ resyncs, stats, standings: host.standings, ms: Date.now() - started, guestIsBot: host.player('p2').isAI });
        }
        if (Date.now() - started > 240000) throw new Error(`${name}: did not finish in 4 minutes (host ${host.state}, guest ${g.state})`);
      } catch (error) {
        clearInterval(loop);
        authority.stop();
        reject(error);
      }
    }, 16);
  });
}

const clean = await run({ name: 'in step' });
assert(clean.resyncs === 0, `in step: ${clean.resyncs} checkpoint(s) needed where none should be`);
console.log(`in step: 2 rounds in ${(clean.ms / 1000).toFixed(1)}s, ${clean.stats.shots} human shots, ${clean.stats.buys} buys, no checkpoints, identical standings`);
console.log('  ' + clean.standings.map((s) => `${s.name}:${s.score}`).join('  '));

const drift = await run({ name: 'knocked out of step', corruptAt: 400 });
assert(drift.resyncs >= 1, 'knocked out of step: the drift was never noticed');
console.log(`knocked out of step: caught, ${drift.resyncs} checkpoint(s), finished identical`);

const left = await run({ name: 'guest leaves', dropAt: 600 });
assert(left.guestIsBot, "guest leaves: the guest's seat did not go to a bot");
console.log('guest leaves: seat handed to a bot, match finished');

console.log('net-smoke: ok');
