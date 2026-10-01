# Lobbots

Big robots, bigger lobs. Turn-based artillery in the shape of the 1990 DOS
classic *Tank Wars*: industrial walkers stand on a procedurally generated
hillside, take turns choosing a weapon, an angle and a power, and watch the
shell cross the sky while the wind has its say. Craters change the ground,
the ground gives way under whoever was standing on it, and the last one
standing takes the round. Then everyone shops, and the next hill is built.

The directory and published slug are `lobbots`, and cache and storage keys use
`lobbots.*`.

Part of the [games hub](../CLAUDE.md). Registered in Arcade on the southwest
**proving ground** island, with a cabinet and take-home machine. The integration
is local until the Arcade and Lobbots repositories are deployed.

## Run it

Serve the directory over HTTP and open it. Any static server works:

```sh
python3 -m http.server
# then http://localhost:8000/
```

`file://` does not work: the game is ES modules. Serving the game directory
alone means `../arcade/exit.js` is a 404 and the "Back to the arcade" button
simply does not appear; serve `~/projects/games` instead to see it.

## How a match goes

1. **Setup.** Two to ten seats. Each is a human or a bot; bots come in seven
   personalities (Rookie, Improviser, Calculator, Sniper, Maniac, Economist,
   Chaos Gopher). Pick a preset (Default, Classic, Quick, Mayhem), a number
   of rounds, and how many bolts everyone starts with. Any starting money
   opens the shop before round one, so a 10k start is a first round fought
   with nukes; 0 goes straight onto the hill with shells.
2. **A round.** Everyone stands on a fresh hill. On your turn: weapon, angle,
   power, fire. Wind is shown as an arrow and a number; the shell's arc is
   drawn as it flies and your last shot stays as a ghost while you aim the
   next one. Your angle and power are remembered between turns. A direct hit
   is devastating, a near miss hurts, terrain in the way halves the damage,
   and a walker whose ground disappears falls, taking damage if it was a long
   way down. A wreck does not stay quiet: half a second after a walker dies
   it cooks off as a random weapon from the arsenal, and once in a while that
   is the nuke. Stand well back from anyone you are about to finish. Whatever
   a wreck does is credited to whoever killed it.
3. **The shop.** After every round each player, alive or wrecked, spends
   their bolts. Damage, kills, surviving and winning pay; everyone draws a
   salary; anyone far behind the richest player is topped up so they stay
   dangerous. Ammunition carries across rounds.
4. **Next hill.** Until the rounds run out. Score is kills, damage and round
   wins.

## Controls

| Action        | Keyboard                       | Mouse / touch                          |
| ------------- | ------------------------------ | -------------------------------------- |
| Barrel        | `←` `→` swing it (hold to speed up) | ◂ ▸ pills, or drag sideways on the field |
| Power         | `↑` `↓`                        | − / + pills, or drag up and down       |
| Fine steps    | hold `Shift`                   | tap the pills                          |
| Weapon        | `Q` `E` or `Tab`               | tap it in the strip                    |
| Fire          | `Space` or `Enter`             | FIRE                                   |
| Walk (Move)   | `←` `→` place the marker, `Space` walks | ◂ ▸ pills or drag, then WALK  |
| Pause         | `Esc`                          | the pause pill, top right              |

## The arsenal

Fourteen weapons in Milestone 1, all data in `js/sim/weapons.js`: Shell
(free, unlimited), Heavy Shell, Mega Shell, Cluster Bomb, MIRV, Roller,
Bouncer, Dirt Bomb, Earth Mover, Burrower, Napalm, Volcano, Funky Bomb, Nuke.
Laser, Heavy Laser, Homing Missile, Air Strike and the Gopher Bomb, plus the
two guidance systems and three defences, are the next milestone; each is one
object in the catalog and at most one small behaviour function.

## Bot speed

The pause menu has a **Bot speed** slider, ×1 to ×4. While a bot is playing —
on its turns, and for the rest of a round once every human is wrecked — the
whole game runs that much faster: thinking, aiming, shells and cook-offs
together. Your own shots always fly at ×1. It starts at ×1 and is remembered
next time you play.

Once no human is left standing in a round, **Skip to results** appears in the
top bar: the rest of the round is played out at once, to exactly the result
watching it would have shown, and you go straight to the scoreboard.

## Move

Not in the original: a Move, bought in the shop like ammunition, spends your
turn walking instead of shooting. Select it in the strip and the angle dial
becomes a walk dial: ◂ ▸ slide a marker along the ground, up to 220 px either
side, and FIRE reads WALK. The walker will not climb a cliff, step off a drop
that would hurt, or walk into another walker; the marker shows exactly where it
will stop before you commit. Bots buy them too, and use them to get away from
a rival who is standing too close to shoot.

## Architecture

`ARCHITECTURE.md` is the plan and the module contract. The short version:

```
js/sim/        the game: terrain, ballistics, weapons, world, AI, match — plain numbers, no DOM
js/render/     draws the sim on one canvas: sky, terrain, walkers, shells, particles
js/ui.js       setup, HUD, shop, scoreboard, pause — DOM over the canvas
js/input.js    keyboard and pointer -> "angle +1", "fire"
js/audio.js    the rendered Sonic Pi cues
js/main.js     fixed-step loop and the wiring between all of the above
```

The sim is a machine that eats actions (`fire`, `buy`, `ready`, `aim`) and
emits events; the UI and the AI both drive it through the same `apply()`.
Every random number in the sim comes from a seeded generator, so a match
replays from its seed. That is the shape a host-authoritative peer-to-peer
version (fishtank's, see the hub) will need: a host runs the Match, guests
send decisions.

Terrain is columns of solid spans, not a heightmap, so burrowers tunnel and
overhangs exist. Three settling modes: static, crumble (unsupported ground
falls) and collapse (crumble plus surface flow).

### Checks

```sh
node --check js/**/*.js js/*.js       # syntax
node tools/sim-smoke.mjs              # four bot matches through rounds, shop and hills, headless
```

The smoke test is the only automated check. Everything visual is verified by
playing it.

## Assets

Sound is composed in Sonic Pi (`tools/audio/*.rb`) and rendered to
`audio/*.m4a` with the hub's recorder; `tools/audio/encode.sh` is the recipe.
Icons come from `tools/make-icons.py`. The walkers are drawn procedurally on
the canvas, with faceted ceramic armor, cooling vents, machined gun assemblies,
live hydraulic legs, suspension idle, visor
blinks and recoil. The hangar and crew portraits share the same painter.
Menu transitions and idle animation respect reduced-motion preferences.

## Intentionally simplified

- **Milestone 1 only.** No teams UI, no advanced options screen (the settings
  exist in `js/config.js` and the presets use them), no guidance or defence
  items yet, no targeted weapons. All designed for, none built.
- **The AI does not know the answer.** It solves a vacuum shot, fires, looks
  where it landed and corrects. Personalities are parameter sets over that
  one routine.
- **No camera.** The whole field is always visible. Off-screen shells get an
  edge marker.
- **Mechs walk only when you pay for it.** They stand, fall when the ground
  goes, and lean with the slope; a bought Move is the one way to change
  ground. They never slide or tip over. This is still artillery.
- **No multiplayer yet.** The sim is shaped for it; nothing is wired.
