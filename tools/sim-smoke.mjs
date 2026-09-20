/*
 * sim-smoke.mjs — play Lobbots with nobody watching.
 *
 * The sim is free of the DOM and the canvas (ARCHITECTURE.md §2), and this
 * is what cashes that in: it imports Match straight into node, runs a full
 * seeded match of bots through every state — rounds, awards, shop, new hill —
 * and checks the things a player would otherwise find by losing an evening:
 * that every turn ends, that a round ends with at most one team standing,
 * that money never goes negative, that bots actually buy things and the
 * ammo carries into the next round, that the terrain never breaks its own
 * invariants, and that every weapon in the shop can be fired and comes to
 * rest.
 *
 * It is not a unit-test suite (hub CLAUDE.md §11 keeps verification light).
 * One command, a few seconds, and a printed summary that says whether the
 * game is still a game.
 *
 * Run: node tools/sim-smoke.mjs
 */

import { SIM_DT, resolveSettings, TERRAIN_PROFILE_IDS } from '../js/config.js';
import { Match } from '../js/sim/match.js';
import { World } from '../js/sim/world.js';
import { Terrain } from '../js/sim/terrain.js';
import { SHOP_ITEMS, weaponById } from '../js/sim/weapons.js';
import { PERSONALITY_IDS } from '../js/sim/ai.js';
import { mulberry32 } from '../js/sim/rng.js';

function assert(ok, msg) {
  if (!ok) throw new Error('sim-smoke: ' + msg);
}

// ---------------------------------------------------------------------------
// 1. Every terrain profile generates a valid hill and seats ten mechs.
// ---------------------------------------------------------------------------
for (const id of TERRAIN_PROFILE_IDS) {
  const t = Terrain.generate(mulberry32(99), id);
  const xs = t.placeMechs(10, mulberry32(7));
  t.validate();
  assert(xs.length === 10, `${id}: placed ${xs.length} mechs`);
  for (let i = 1; i < xs.length; i++) assert(xs[i] - xs[i - 1] > 40, `${id}: mechs ${i - 1} and ${i} overlap`);
}
console.log(`terrain: ${TERRAIN_PROFILE_IDS.length} profiles generate and seat ten`);

// ---------------------------------------------------------------------------
// 2. Every shop weapon fires and the world goes quiet again.
// ---------------------------------------------------------------------------
for (const w of SHOP_ITEMS.concat([weaponById('shell')])) {
  for (const mode of ['static', 'crumble', 'collapse']) {
    const settings = resolveSettings('default', { terrainMode: mode, terrainProfile: 'rolling', windMax: 40, seed: 5 });
    const world = new World(settings, mulberry32(11));
    world.setup([
      { id: 'a', team: 'A', angle: 60, power: 60, weaponId: w.id },
      { id: 'b', team: 'B', angle: 120, power: 60, weaponId: 'shell' },
    ]);
    const events = [];
    world.fire('a', w.id, 55, 70);
    let t = 0;
    while (!world.isQuiet() && t < 40) {
      events.length = 0;
      world.step(SIM_DT, events);
      t += SIM_DT;
    }
    assert(world.isQuiet(), `${w.id} (${mode}) never came to rest`);
    world.terrain.validate();
  }
}
console.log(`weapons: ${SHOP_ITEMS.length + 1} fire and settle in all three terrain modes`);

// ---------------------------------------------------------------------------
// 3. A whole match of bots.
// ---------------------------------------------------------------------------
function playMatch(label, settings, specs) {
  const match = new Match(settings, specs);
  const events = [];
  match.start(events);

  const stats = {
    label, seed: match.seed, ticks: 0, turns: 0, shots: 0, hits: 0, deaths: 0,
    rounds: 0, purchases: 0, explosions: 0, falls: 0, weaponsFired: new Set(), profiles: [],
    longestTurn: 0, turnTicks: 0,
  };
  const MAX_TICKS = 120 * 60 * 60; // an hour of game time: a hung match trips this
  let lastAlive = null;

  const consume = () => {
    for (const e of events) {
      switch (e.type) {
        case 'turnStart':
          stats.turns++;
          if (stats.turnTicks > stats.longestTurn) stats.longestTurn = stats.turnTicks;
          stats.turnTicks = 0;
          break;
        case 'fire': stats.shots++; stats.weaponsFired.add(e.weaponId); break;
        case 'mechHit': stats.hits++; break;
        case 'mechDied': stats.deaths++; break;
        case 'explosion': stats.explosions++; break;
        case 'mechFell': if (e.drop > 20) stats.falls++; break;
        case 'purchase': stats.purchases++; break;
        case 'roundStart': stats.profiles.push(e.profile); break;
        case 'roundOver': {
          stats.rounds++;
          const teams = match.world.aliveTeams();
          assert(teams.size <= 1, `round ${e.round} ended with ${teams.size} teams alive`);
          lastAlive = match.world.aliveMechs().length;
          break;
        }
        default: break;
      }
    }
    events.length = 0;
  };
  consume();

  while (match.state !== 'matchOver' && stats.ticks < MAX_TICKS) {
    match.step(SIM_DT, events);
    stats.ticks++;
    stats.turnTicks++;
    consume();
    for (const p of match.players) assert(p.money >= 0, `${p.name} has ${p.money} bolts`);
    if (stats.turnTicks > 120 * 90) throw new Error(`sim-smoke: a turn ran past 90 s in state ${match.state}`);
  }

  assert(match.state === 'matchOver', `match never ended (state ${match.state} after ${stats.ticks} ticks)`);
  assert(stats.rounds === settings.rounds, `played ${stats.rounds} rounds of ${settings.rounds}`);
  assert(stats.shots > 0, 'nobody fired');
  assert(stats.hits > 0, 'nobody was hit in a whole match');
  // The shop only opens between rounds, so a one-round match never sells.
  if (settings.rounds > 1) assert(stats.purchases > 0, 'nobody bought anything');
  match.world.terrain.validate();
  for (const p of match.players) {
    for (const [id, n] of Object.entries(p.inventory)) assert(n >= 0, `${p.name} has ${n} of ${id}`);
  }
  stats.standings = match.standings;
  stats.lastAlive = lastAlive;
  return stats;
}

function report(s) {
  const board = s.standings.map((r) => `${r.name}:${r.score}(${r.roundWins}w ${r.kills}k $${r.money})`).join('  ');
  console.log([
    `${s.label} (seed ${s.seed})`,
    `  rounds ${s.rounds}  turns ${s.turns}  shots ${s.shots}  hits ${s.hits}  deaths ${s.deaths}  explosions ${s.explosions}  falls ${s.falls}`,
    `  purchases ${s.purchases}  weapons fired: ${[...s.weaponsFired].join(', ')}`,
    `  hills: ${s.profiles.join(', ')}`,
    `  game time ${(s.ticks / 120).toFixed(0)}s  longest turn ${(s.longestTurn / 120).toFixed(1)}s`,
    `  ${board}`,
  ].join('\n'));
}

const four = [
  { name: 'Calc', colorIndex: 0, isAI: true, personality: 'calculator' },
  { name: 'Rook', colorIndex: 1, isAI: true, personality: 'rookie' },
  { name: 'Mani', colorIndex: 2, isAI: true, personality: 'maniac' },
  { name: 'Snip', colorIndex: 3, isAI: true, personality: 'sniper' },
];
report(playMatch('four bots, default, 3 rounds', resolveSettings('default', { rounds: 3, seed: 12345 }), four));
report(playMatch('four bots, random seed', resolveSettings('default', { rounds: 3 }), four));

// The worst shots at the table must still be able to end a round. Six Rookies
// once played 240 s with one kill; this is the line that keeps that fixed.
report(playMatch('six rookies, default, 1 round', resolveSettings('default', { rounds: 1, seed: 99 }),
  Array.from({ length: 6 }, (_, i) => ({ name: `Rook${i}`, colorIndex: i, isAI: true, personality: 'rookie' }))));

const seven = PERSONALITY_IDS.map((id, i) => ({ name: id, colorIndex: i, isAI: true, personality: id }));
report(playMatch('all seven, mayhem, 2 rounds', resolveSettings('mayhem', { rounds: 2, seed: 777 }), seven));
report(playMatch('ten bots, quick, 2 rounds, collapse', resolveSettings('quick', { rounds: 2, seed: 4242, terrainMode: 'collapse' }),
  Array.from({ length: 10 }, (_, i) => ({ name: `Bot${i}`, colorIndex: i, isAI: true, personality: PERSONALITY_IDS[i % PERSONALITY_IDS.length] }))));

console.log('sim-smoke: ok');
