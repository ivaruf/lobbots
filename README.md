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
alone means `../arcade/exit.js` is a 404 and the "Back to arcade" button
simply does not appear; serve `~/projects/games` instead to see it. Even
then it only appears inside the arcade's frame or an installed window, never
in a plain tab. It is the last row of the setup screen and of the pause menu.
`Esc` goes one step back: the lobby's own Back, the pause menu in and out
during a match, and on the setup screen it is the Back to arcade button.

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
| Pause, one step back | `Esc`                   | the pause pill, top right              |

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

## Online

Two or more devices, anywhere, one match. On the setup screen tap **Play
online**, give yourself a name, and either:

- **Host a game.** You get three words — say, KITE GEAR MOON — and go back
  to the setup screen with them shown above your crew. Read them to a friend.
  Each friend who joins takes the place of one of your bots (or a new seat if
  there are none), and their seat card says Online. Set the rules and the
  rest of the crew as usual, then **Play**.
- **Join a game.** Tap in the three words. You see the host's crew and
  rules and wait for them to start. The words are shown in each device's
  own language (KITE is DRAGE in Norwegian) while the code underneath is
  the same, so a Norwegian and an English screen show different words for
  one game — switch both to one language to read a code across them.

During the match everyone plays their own seats on their own screen and
watches the rest. The pause menu does not pause — the hill is everyone's —
and the results table waits until every device has tapped Continue. Somebody
who leaves or loses their connection is handed to a bot, and the match goes
on. **Play again** at the end puts everyone back in the hangar for another.

The honest limits, the same as every online game in the hub:

- **The host must keep the page open.** The match runs on their device.
  Their screen is kept awake while a hangar is open, and the match keeps
  running if they switch tabs, but closing it ends the match for everyone.
- **About one pair of networks in ten cannot connect at all.** There is no
  relay server (TURN) behind this, because that costs money by the gigabyte.
- **A public matchmaker introduces the devices** (PeerJS's free broker). It
  sees the three words and connection details, never the game. If it is
  down, no new hangars open; matches already under way are unaffected.
  If it cannot be reached, a hangar still works between tabs of one browser,
  and says so.
- **No joining mid-match**, and the host can cheat, because the host decides.
  For friends and family, that is fine.

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
js/net/        online: the hangar, the host's deciding Match, every device's copy
```

The sim is a machine that eats actions (`fire`, `buy`, `ready`, `aim`) and
emits events; the UI and the AI both drive it through the same `apply()`.
Every random number in the sim comes from a seeded generator, and every
sine, cosine and exponential is computed by hand (`js/sim/dmath.js`) because
browsers disagree about `Math.cos` in the last bit. So a match replays
exactly from its seed and its decisions, on any device — which is what online
play is built on: the host runs the deciding Match, every device runs a copy,
and only decisions travel (`js/net/`).

Terrain is columns of solid spans, not a heightmap, so burrowers tunnel and
overhangs exist. Three settling modes: static, crumble (unsupported ground
falls) and collapse (crumble plus surface flow).

### Checks

```sh
node --check js/**/*.js js/*.js       # syntax
node tools/sim-smoke.mjs              # four bot matches through rounds, shop and hills, headless
node tools/net-smoke.mjs              # online matches over in-memory pipes: in step, knocked out of step, someone leaving
```

The two smoke tests are the only automated checks. Everything visual is
verified by playing it.

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
- **Online play sends decisions, not the battle.** Every device runs the
  same Match and only angles, powers, purchases and the host's clock travel.
  See ARCHITECTURE.md §13.
