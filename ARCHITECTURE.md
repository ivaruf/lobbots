# LOBBOTS — architecture and build plan

Turn-based mech artillery in the shape of *Tank Wars* (Kenneth Morse, 1990):
walkers planted on a destructible hillside take turns choosing weapon, angle
and power; wind bends the shot; craters change the ground; the last one
standing wins the round; everyone shops; a new hill is generated. This file is
the implementation plan asked for by `promt.txt`, and the module contract the
build is held to. When two files disagree about a fact, this one is corrected
first and the code second.

The game is called **Lobbots**. The directory and repo are still `tankwars`,
the working name (as `trailblazers` was for NeonFox); the slug is the URL and
the storage prefix, so every cache name and storage key here is already
`lobbots.*` and the folder rename is the owner's to do between sessions.

Part of the [games hub](../CLAUDE.md); its rules apply throughout. Read that
first if you have not.

---

## 1. Decisions taken before a line was written

| Question | Decision | Why |
|---|---|---|
| Language | Plain JS ES modules, no build | Hub §2: ship the code you wrote. TypeScript would need transpiling. |
| Units | Industrial walkers, not tanks | Reframed the way NeonFox reframed Kurve. Worn, functional, clean silhouette; team-colour panels. Look serves readability. |
| Rendering | Canvas 2D + DOM overlay, mechs drawn procedurally and baked per colour | The prompt keeps play strictly side-on 2D; Babylon is for genuinely 3D games. Modelled sprite frames are a later job for astra under `codex-models/` if the loop earns it. |
| Sound | Sonic Pi pieces in `tools/audio/`, rendered to `.m4a` | Hub §9. One pipeline, every later cue is cheap. |
| Scope of this build | Milestone 1 from the prompt, then a playtest | Owner's call. Everything past M1 is designed for, not built. |
| Terrain | Per-column solid spans | Overhangs and tunnels for burrowers, cheap circular carving, and crumble is one loop per column. See §4. |
| Field | 1600 × 900 logical px, always fully visible, letterboxed | The whole battlefield in view is the prompt's camera rule. |
| Randomness | One seeded generator per match, round seeds derived from it | Replayable from a seed; a host can later own it. `Math.random()` only on the render side. |
| Money | "bolts" | The game's own word; the shop is a parts counter. |

---

## 2. Layout and ownership

One file, one owner (hub §12). Lanes are named so parallel agents never touch
the same file. **sim** is written first, alone, because everything else is a
view of it.

```
tankwars/
  index.html                DOM shell: screens, HUD, crash bar, script tags   [ui]
  manifest.webmanifest      "LOBBOTS — Big robots, bigger lobs."             [assets]
  sw.js                     lobbots-<VERSION> precache, opt-in update         [assets]
  css/style.css             every screen and the HUD                          [ui]
  js/
    config.js               ALL tuning numbers + the four presets             [sim]
    main.js                 boot, fixed-step loop, routes sim events to
                            render / ui / audio, turns input into actions     [glue]
    update.js               SW registration + UPDATE READY (self-contained)   [assets]
    screen.js               fullscreen pill (self-contained; not fullscreen.js) [assets]
    input.js                keyboard + pointer -> intents                     [ui]
    ui.js                   setup screen, HUD, shop, scoreboard, banners      [ui]
    audio.js                cue loader/mixer for audio/*.m4a                  [assets]
    sim/
      rng.js                mulberry32                                        [sim]
      terrain.js            column spans: generate, carve, fill, settle, query [sim]
      ballistics.js         projectile integration + collision sweep          [sim]
      weapons.js            the catalog (data) + behaviour registry            [sim]
      world.js              one round: mechs, projectiles, wind, terrain, step [sim]
      ai.js                 shared aiming logic + seven personality parameter sets [sim]
      match.js              players, turn order, rounds, economy, shop, state machine [sim]
    render/
      render.js             camera fit, layer order, shake, offscreen markers  [render]
      sky.js                gradient + parallax clouds drifting with the wind  [render]
      terrain-draw.js       terrain offscreen canvas, shaded, dirty-range redraw [render]
      mech-draw.js          procedural walker sprites baked per colour; live barrel, legs, recoil, tilt [render]
      effects.js            particles: smoke, debris, sparks, flashes, trails   [render]
  audio/*.m4a               rendered cues                                      [assets]
  icons/                    192, 512, 512-maskable, 180                        [assets]
  tools/
    make-icons.py           Pillow, procedural, source of truth for icons      [assets]
    sim-smoke.mjs           headless AI-only match through node                [sim]
    audio/*.rb              the cue compositions                               [assets]
    audio/encode.sh         render + encode recipe for this game               [assets]
  README.md, ARCHITECTURE.md
```

Rules that follow from the hub and are easy to forget here:

- No `fullscreen`, `popup`, `banner`, `ads`, `track`, `promo`, `pixel`,
  `beacon`, `interstitial`, `sponsor`, `analytics`, `advert` as a basename.
- `../arcade/exit.js` as a classic deferred script with `data-handled`;
  the quit button is ours and appears only once `window.ArcadeExit` exists.
- Every `window.top` / `parent` access wrapped in try/catch; never a bare `top`.
- Storage keys `lobbots.<thing>.v1`; every read/write in try/catch.
- `sw.js` VERSION bumped once per committed batch that deploys.
- Nothing under `js/sim/` imports from `render/`, `ui.js`, `audio.js` or
  touches the DOM. `tools/sim-smoke.mjs` is what enforces it.

---

## 3. The sim is a machine that eats actions

Multiplayer later means a host runs the sim and everyone else sends
*decisions*. So the sim has exactly one input surface, and the UI and the AI
both use it:

```js
match.apply({ type: 'fire',  playerId, weaponId, angle, power, target })  // target: x for air strikes, mechId for homing
match.apply({ type: 'buy',   playerId, itemId })
match.apply({ type: 'ready', playerId })        // done shopping / start round
match.apply({ type: 'aim',   playerId, angle, power, weaponId })  // cosmetic: lets other screens see the barrel move
match.step(dt, events)                          // fixed dt, pushes events for the frame
```

`events` is an array the caller clears each frame. The sim never holds a
reference to it. Renderers read state directly (same process) and use events
only for one-shots. Event types:

```
turnStart {playerId}          fire {playerId, weaponId, x, y, angle, power}
projectileSpawn {id}          projectileGone {id, reason}     bounce {x,y}
split {x,y,count}             explosion {x, y, radius, strength, weaponId}
terrainChanged {x0, x1}       crumble {x0, x1}                mechFell {id, drop}
mechHit {id, damage, by}      mechDied {id, by}               shieldHit {id}
roundOver {winnerId|null, teamId|null}   awards [{playerId, bolts, reasons}]
shopOpen {playerId}           purchase {playerId, itemId, price}
shopClosed                    roundStart {round, rounds, seed, profile}
matchOver {standings}         windChanged {wind}
apex {id, x, y, weaponId, hidden}        the top of an arc; the whistle starts here
shopDone {playerId, purchases}           timerExpired {playerId}
```

### State machine (match.js)

```
setup -> roundStart -> aim -> firing -> (aim | roundOver) -> scoreboard -> shop -> (roundStart | matchOver)
```

- `aim`: `match.current` is the player whose turn it is. Human: waits for a
  `fire` action. AI: `ai.js` is asked for a decision once, on entering the
  state; `match` schedules it after a think delay so it reads as a player.
- `firing`: projectiles fly, explosions resolve, terrain settles, mechs
  fall. Ends when the world is *quiet* (§4). Deaths are resolved, the turn
  passes to the next living player in seat order. A round ends when one
  team (or nobody) is left.
- `shop`: every player in seat order, dead ones included. Humans get the
  screen; AI buys according to its personality and the shop advances.
- Angle, power and weapon are stored **per player** and never reset between
  turns: that is the shot memory the prompt asks for.

### Determinism

All sim randomness comes from `rng.js` seeded once per match; round `r` uses
`hash(matchSeed, r)`. Sim math is plain arithmetic on numbers; `Math.sin/cos`
appear only when turning angle+power into a velocity, once per shot. Fixed
`SIM_DT` (1/120 s) substeps; `main.js` accumulates real time and never passes
a variable dt into the sim.

---

## 4. Terrain: column spans

`terrain.columns[x]` is a flat `Int16Array`-backed list of `[top, bottom)`
solid intervals, sorted top to bottom, y down, for each of `WIDTH` columns.
Ground is solid from the surface down to `HEIGHT`.

- **Generate**: seeded layered noise → a height per column → one span each.
  Six profiles in `config.js` (`rolling`, `mountains`, `valley`, `canyon`,
  `chaos`, `flat`) are just parameter sets for the same generator.
- **Carve** a crater: for each column within the radius, subtract the
  vertical chord of the circle (with a small seeded jitter for an irregular
  rim). **Fill** (dirt bomb) is the union.
- **Query**: `solidAt(x, y)`, `surfaceAt(x)` (top of the first span),
  `groundBelow(x, y)` (top of the first span at or below y). Mechs stand on
  `groundBelow` averaged across their footprint.
- **Settle** runs as a process, not a jump, because watching it fall is half
  the point:
  - `static`: nothing moves.
  - `crumble`: any span not resting on `HEIGHT` or on the span below it falls
    at `TERRAIN_FALL_SPEED` until it lands and merges. Per column, per step.
  - `collapse`: crumble, plus a relaxation pass: where a column's surface
    is more than `COLLAPSE_SLOPE` above a neighbour, a slice moves across.
- **Quiet** means: no falling spans, no live projectiles, no pending
  sub-spawns, no mech in the air.

Renderer contract: `terrainChanged {x0,x1}` says which columns to redraw.
The terrain never redraws itself in full during play.

---

## 5. Mechs

A mech is `{ id, playerId, x, y, facing, angle, power, weaponId, health,
shield, armour, alive, vy, tilt }`. It does not walk. `x` changes only if a
future slide rule says so. Each step: find the ground under the footprint;
if it is lower than the feet, fall with gravity; landing from more than
`FALL_DAMAGE_FROM` px deals `FALL_DAMAGE_PER_PX` (jump jets will zero this
later). `tilt` is the slope under the feet, for the renderer. A buried mech
fires from inside the ground: the shell detonates at the muzzle and digs it
out, which is the classic way out and costs the shooter some health.

Hit test: circle of `MECH_RADIUS` at the body centre. Damage from an
explosion of radius `R`, damage `D`, at distance `d` from that centre:
`D * clamp(1 - max(0, d - MECH_RADIUS) / R)`. A direct hit is full damage.
If the segment from the blast centre to the mech centre crosses terrain, the
damage is multiplied by `TERRAIN_SHADOW` (0.5). Self-damage is on;
friendly fire (team-mates) is a config flag.

---

## 6. Weapons are data

```js
{
  id: 'heavy', name: 'Heavy Shell', desc: 'Same arc, twice the hole.',
  price: 250, pack: 3, category: 'shell',           // pack: rounds per purchase; Infinity = unlimited
  flight: 'ballistic',                              // behaviour name in FLIGHT registry
  impact: 'explode',                                // behaviour name in IMPACT registry
  radius: 42, damage: 45,                           // blast radius px, damage at centre
  terrain: 'crater',                                // 'crater' | 'fill' | 'none' | 'scoop'
  props: { ... }                                    // behaviour-specific knobs (bounces, bomblets, roll speed ...)
  icon: 'shell-heavy'                               // key into the procedural icon set
}
```

Behaviours are small functions in two registries in `weapons.js`, each given
`(proj, world, dt, out)`; `out` collects spawned projectiles and explosions.
Flight hooks: `step`, `onApex`, `onTerrain`, `onMech`, `onExit`. Adding a
weapon is adding one object to `CATALOG` and, if it genuinely behaves in a new
way, one function. Guidance and defences share the same catalog with
`category: 'guidance' | 'defence'` and are bought the same way.

Milestone 1 ships: Shell (free), Heavy Shell, Mega Shell, Cluster, MIRV,
Roller, Bouncer, Dirt Bomb, Burrower, Napalm, Nuke — eleven, because the
behaviours behind them are the work and the objects are cheap. Laser, Heavy
Laser, Homing, Air Strike, Volcano, Funky Bomb, Earth Mover and the Gopher
Bomb are next, as are the two guidance and three defence items.

---

## 7. Economy (all in config.js)

Awards at round end, per player: damage dealt × `BOLTS_PER_DAMAGE`, kills ×
`BOLTS_PER_KILL`, `BOLTS_SURVIVE` if alive, `BOLTS_ROUND_WIN` to the winner,
and `BOLTS_SALARY` to everyone. Then an **underdog top-up**: anyone below
`UNDERDOG_FRACTION` of the richest player's purse is lifted to it. That is
the anti-snowball rule: the leader keeps the lead, the trailer stays
dangerous. Score is `SCORE_KILL × kills + damage + SCORE_ROUND_WIN × wins`.

---

## 8. AI: estimate, fire, watch, correct

`ai.js` exposes `decide(match, playerId, rng) -> action` and
`shop(match, playerId, rng) -> itemId[]`. Shared logic:

1. Pick a target (nearest / weakest / random, per personality).
2. First shot at a target: closed-form vacuum solution for the range and
   height difference, high or low arc by preference, wind **ignored**, then
   `aimNoise` added. The AI does not get the real solution.
3. Every later shot: take the last shot's landing point against the target,
   move power (or angle when power is pinned) by `learnRate × error`, add
   noise, forget everything with probability `forget` when the wind changed.
4. Choose a weapon from the inventory by the personality's weights (cheap,
   big, varied, conserve).

The seven personalities — Rookie, Improviser, Calculator, Sniper, Maniac,
Economist, Chaos Gopher — are parameter sets over that one routine. All
seven exist as data in M1; only the routine is tested.

---

## 9. Rendering and feel

Layers, back to front: sky gradient → far cloud band (parallax, drifts with
wind) → distant ridge silhouettes → terrain canvas → wrecks → mechs → trails
→ projectiles → particles → flashes → offscreen markers → screen-shake is a
translate of the whole world transform, decaying, capped, and off by config.

The terrain canvas is dark strata under a lighter crust so a bright shell
reads against it and against the sky. Player colour appears on the mech
panels, the name tag, the health bar and the trail, never on terrain.

Feel checklist from the prompt, each one a small, cheap thing:
recoil (barrel and body kick 200 ms), rock/settle when ground goes,
smoke that drifts with the wind, debris arcs from craters, a flash ring
on explosions scaled to radius, a subtle shake on anything above
`SHAKE_RADIUS`, a dotted trail per shot with the shooter's previous shot
kept ghosted while they aim again.

Camera never zooms in M1. Off-screen shells get a marker at the edge.

---

## 10. UI

Screens are DOM sections toggled by `ui.js`: `#setup`, `#hud`, `#scoreboard`,
`#shop`, `#pause`, `#matchover`. Style comes from the game: dark plate,
hazard-stripe accents, team colours as light, chunky buttons. `<select>` is
not used; choices are segmented button rows. The menu must not scroll on a
landscape phone — maxgear's `@media (orientation: landscape) and
(max-height: 500px)` grid-area shape is the reference.

Controls, all leading to the same actions:

| Intent | Keyboard | Pointer / touch |
|---|---|---|
| Angle | `←` `→` (hold accelerates) | `−` `+` pills, hold-repeat; or horizontal drag on the field |
| Power | `↑` `↓` | `−` `+` pills; or vertical drag on the field |
| Weapon | `Q` `E` / `Tab` | weapon strip, tap to select |
| Fire | `Space` `Enter` | big FIRE button |
| Pause | `Esc` | pause pill, top right |

HUD shows current player and colour, health, angle, power, weapon and ammo,
wind arrow with a number. Controls lock from `fire` until the next `turnStart`.

---

## 11. Build order

1. **sim** (alone): `config.js`, `rng.js`, `terrain.js`, `ballistics.js`,
   `weapons.js`, `world.js`, `ai.js`, `match.js`, `tools/sim-smoke.mjs`.
   Smoke passes before anything is drawn.
2. **In parallel, one owner each**: `render/*`; `index.html` + `css` +
   `ui.js` + `input.js`; `audio.js` + `tools/audio/*` + icons + manifest +
   `sw.js` + `update.js` + `screen.js`.
3. **glue**: `main.js`, README, version bump, commit, playtest checklist.

Verification is hub §11: `node --check` on every file, the smoke test, no
console errors, then the owner plays it.

---

## 12. Module contracts (what main.js calls; agents build to these)

Nothing below is imported by `js/sim/`. `main.js` is the only file that
imports from more than one lane.

### Shared palette (UI, renderer, icons and manifest agree on this)

```
plate      #15181e   the dark metal every panel sits on (manifest background_color)
panel      #1e232b   raised panel
edge       #3a414d   panel borders, dividers
text       #eef0f4   primary text
muted      #9aa3b2   labels, secondary
hazard     #ffd23f   the accent: stripes, focus rings, primary buttons (manifest theme_color is plate)
danger     #ff4b3e   damage numbers, low health
sky        #0f1626 (top) -> #2c3a62 (mid) -> #7a6a8f (horizon), a faint warm band #c98a6a low
terrain    deep #25242a, body #3b3a42 / #4e4b52 strata, crust highlight #8b8474, rust seams #6e4a3a
```
Player colours are `PALETTE` in `js/config.js`. Fonts are the system stack;
headings condensed bold uppercase. No web fonts (hub rule).

### DOM ids (index.html is [ui]'s; update.js/screen.js from [assets] read these)

```
#field           the one canvas, fills the viewport under everything
#ui              overlay root for every screen
#setup #hud #scoreboard #shop #pause #matchover   screen sections (hidden attribute toggles)
#corner          top-right pill cluster present on every screen
  #screen-toggle   fullscreen pill, starts hidden, owned by js/screen.js
  #pause-btn       pause pill, shown only during play
#update          UPDATE READY button inside #setup, starts hidden, owned by js/update.js
                 (contains .update-title and .update-sub spans)
#build           build line inside #setup, starts hidden, written by js/update.js
#exit-btn        "Back to the arcade" inside #setup and #pause, shown by ui.js only when window.ArcadeExit exists
#crash           bottom error bar, hidden; index.html's inline handler fills it (copy NeonFox's, honour data-handled)
```
Script tags at the end of body, in this order: the crash handler inline,
`js/update.js` (module), `js/screen.js` (module), `js/main.js` (module).
In head: `../arcade/exit.js` as a classic deferred script with
`data-handled="optional"`.

### render — `js/render/render.js`

```js
import { createRenderer } from './render/render.js';
const r = createRenderer(canvas);
r.resize();                 // window resize: DPR-capped (max 2) backing store, recompute the letterbox fit
r.attach(match);            // a new Match (or null): reset caches, bake one mech sprite set per player colour
r.onEvent(e);               // every sim event, in order; particles, terrain dirty ranges, shake, ghost trails
r.draw(dtReal);             // one frame; reads match.world and match.players directly
r.setOptions({ shake: bool, trails: bool });
r.screenToWorld(clientX, clientY)  // -> { x, y } in field units (may be outside 0..WIDTH)
r.worldToScreen(x, y)              // -> { x, y } in CSS px
```
Reads: `match.world.terrain.cols`, `.mechs` (x, y = feet, tilt, angle,
health, maxHealth, shield, alive, recoil, falling, playerId), `.projectiles`
(x, y, trail with null breaks, weapon, state.rolling / state.burrowing),
`.wind`, `match.players` (color.hex, name), `match.currentId`, `match.state`.
Draws the whole field letterboxed, sky extended into the margins, in this
order: sky, far clouds (parallax, drift with wind), ridge silhouettes, terrain
canvas (redrawn only for dirty column ranges), wrecks, mechs (barrel at
`angle`, legs planted to the ground under each foot, body tilted by `tilt`,
recoil kick decayed render-side from `recoil`), a bobbing chevron over the
current player's mech, name tags and health bars, the current player's
previous shot as a faint ghost trail while `match.state === 'aim'`, live
trails, projectiles (dark outline, bright core), particles, flash rings,
edge markers for anything off the top or sides, wind streaks. Screen shake
is a translate of the world transform, decaying, capped, scaled by the
explosion's `strength`.

### ui — `js/ui.js`

```js
import { createUI } from './ui.js';
const ui = createUI({
  onStart(specs, settings),  // specs: [{ name, colorIndex, isAI, personality, team }], settings: resolveSettings(preset, overrides)
  onAngle(delta), onPower(delta), onWeapon(dirOrId),   // deltas are integers; ui does its own hold-repeat with acceleration
  onFire(), onBuy(itemId), onReady(),                  // onReady: scoreboard continue, shop "Done", matchover "Again"
  onPause(), onResume(), onQuit(),                     // quit = abandon match, back to setup
});
ui.showSetup(lastSpecs, lastPreset);   // remembers the previous setup via lobbots.setup.v1
ui.showHud(); ui.updateHud(match);     // every frame in play: player, colour, health, angle, power, weapon, ammo, wind, timer
ui.lockControls(bool);                 // firing / not this human's turn
ui.showScoreboard(match);              // match.lastAwards + players
ui.showShop(match); ui.updateShop(match);   // rows from match.shopRows(match.shopper()); dead shoppers still shop
ui.showBotShopping(match, purchases);  // what a bot bought, held for the dwell
ui.showMatchOver(match);               // match.standings
ui.showPause(); ui.hidePause();
ui.banner(title, sub, ms);             // "Ember's turn", "Round 3 of 5 — Canyon", "Calc bought a Nuke"
ui.setExit(verb, onExit);              // called by main once window.ArcadeExit exists
```
Setup screen: 2–10 seats, each with name, colour swatch (cycles PALETTE,
no duplicates), Human/Bot toggle, personality row for bots, rounds
(1/3/5/10/custom), preset (Default/Classic/Quick/Mayhem). Advanced options
come later; the setup only needs preset + rounds + seats for M1. Landscape
phone: no scrolling (two-column grid by area, maxgear's shape).

### input — `js/input.js`

```js
import { createInput } from './input.js';
const input = createInput(canvas, {
  onAngle(delta), onPower(delta), onWeapon(dir), onFire(), onPause(),
});
input.setEnabled(bool);   // main enables only during a human's aim
```
Keys: `←`/`→` swing the BARREL left and right (so `→` lowers the angle,
because 0° points right), `↑`/`↓` power, hold accelerates fast (18/s →
110/s over 0.9 s after a 0.2 s dwell: the whole 0–180 sweep in about two
seconds); `Shift` = single steps; `Q`/`E`/`Tab` weapon; `Space`/`Enter`
fire; `Esc` pause. Ignores keys when a button or text field has focus.
Pointer: drag on the canvas: horizontal = barrel direction (4 px per
degree, right is right), vertical = power (4 px per point); a tap without
drag does nothing (no click-to-fire). The HUD's angle pills are ◂ ▸ and
mean the same thing as the keys.

### audio — `js/audio.js`

```js
import { createAudio } from './audio.js';
const audio = createAudio();
audio.unlock();                          // first gesture; creates and resumes the context, starts decoding
audio.play(name, { gain = 1, rate = 1 } = {});
audio.setVolume(v); audio.volume;        // persisted at lobbots.vol.sfx.v1
```
Cues in `audio/<name>.m4a`: `fire`, `whistle`, `boom`, `boom-big`,
`bounce`, `splat` (dirt), `crumble`, `wreck`, `kaching`, `fanfare`, `click`.
Composed as `tools/audio/<name>.rb`, rendered with the hub recorder,
encoded with the hub one-shot encoder; `tools/audio/encode.sh` is the
recipe. main.js maps events to cues and scales `rate` by blast radius.

### assets — files, not APIs

`manifest.webmanifest` (name `LOBBOTS — Big robots, bigger lobs.`),
`sw.js` (`lobbots-<VERSION>`, precache list covering every shipped file
above, maxgear's opt-in update shape, GET_VERSION), `js/update.js` and
`js/screen.js` (NeonFox's, adapted to the ids above), `tools/make-icons.py`
and the four PNGs: a chunky walker on a hill, barrel raised, one shell on a
dotted arc, hazard yellow on plate.
