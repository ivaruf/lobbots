/*
 * intro.js — the three-second sting that plays when the game opens.
 *
 * The icon, set moving (tools/make-icons.py): a dusk sky over a dark hill, a
 * hazard-yellow walker planted on the right. Its barrel swings up, it fires
 * with a kick, and one bright shell climbs a dotted arc across the sky — and
 * comes down exactly where the LOBBOTS title sits on the setup screen. The
 * impact flashes, the curtain shakes, dirt and sparks fly, and the blast
 * leaves a crater in the curtain itself with the title already showing at
 * the bottom of it. Then the crater widens until there is no curtain left.
 * So the hand-off is the shot landing on the game rather than one picture
 * swapped for another, and nothing in it is text, so nothing to translate.
 *
 * WHAT IT MAY NOT DO
 *   - Cost anyone a match (hub §1). It only ever plays at page load, over
 *     the setup screen, and any tap or key skips straight to the hand-off.
 *   - Let the skipping press through. A key is swallowed in the capture
 *     phase on window — this script runs async from the top of <body>, long
 *     before the module graph, so its listener is registered before
 *     js/input.js's, js/main.js's and js/update.js's and runs first —
 *     because the press that skips must not also be the setup screen's
 *     Escape (the way out to the arcade) or Enter. A tap lands on the
 *     curtain itself, which covers every button.
 *   - Delay the game. It is a curtain, not a gate: the module graph, the
 *     hero mech and the cues boot underneath while it plays.
 *   - Play for someone who has asked for less motion. prefers-reduced-motion
 *     means the script does nothing at all — and this one shakes, which is
 *     exactly what that setting is for.
 *
 * A classic script, self-contained, importing nothing, for the reason
 * touch-guard.js stands apart: if anything in the module graph fails, the
 * curtain must still lift. Every frame runs inside a try, a hard timeout
 * removes the curtain whatever happens, and a failure of this file leaves
 * the game exactly as it was without it. Modelled on neonfox's js/intro.js,
 * which set the contract every sting in the hub keeps.
 *
 * Canvas 2D, devicePixelRatio capped at 2, the hill, the debris and the
 * smoke built once (the sky gradient once per resize) and no allocation in
 * the frame loop (hub §10).
 */
(function () {
  'use strict';

  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {
    /* No matchMedia: play it. */
  }

  // The palette is the game's own: ARCHITECTURE.md §12, as used by
  // js/render/sky.js, js/render/terrain-draw.js and tools/make-icons.py.
  // Copied rather than imported because this file imports nothing.
  var SKY_TOP = '#0f1626';
  var SKY_MID = '#2c3a62';
  var SKY_LOW = '#7a6a8f';
  var SKY_WARM = '#c98a6a';
  var RIDGE = '#3a3954';
  var HILL = '#25242a';
  var CRUST = '#8b8474';
  var RUST = '#6e4a3a';
  var PLATE = '#15181e';
  var STEEL = '#4e4b52';
  var HAZARD = '#ffd23f';
  var FIRE_HOT = '#ff9a3c';
  var SHELL = '#f4f1e8';

  // The timeline, in milliseconds. The barrel swings up until FIRE; the shell
  // is in the air for FLIGHT; at IMPACT the crater opens; LAND starts the
  // hand-off, which takes LAND_MS (or SKIP_MS when the player skipped).
  var FIRE = 520;
  var FLIGHT = 820;
  var IMPACT = FIRE + FLIGHT;
  var LAND = 2050;
  var LAND_MS = 700;
  var SKIP_MS = 350;

  var canvas = document.createElement('canvas');
  canvas.id = 'intro';
  canvas.setAttribute('aria-hidden', 'true');
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var W = 0;
  var H = 0;
  var dpr = 1;
  var sky = null;

  // THE GROUND, as heights in units of the screen: a far ridge, and the near
  // hill — low on the left, rising to the knoll on the right the walker
  // stands on. Sampled once; scaled on draw.
  var N_GROUND = 33;
  var ridge = new Float32Array(N_GROUND);
  var hill = new Float32Array(N_GROUND);
  for (var g = 0; g < N_GROUND; g++) {
    var u = g / (N_GROUND - 1);
    ridge[g] = 0.66 - 0.05 * Math.sin(u * 5.1 + 0.6) - 0.03 * Math.sin(u * 13 + 2);
    hill[g] =
      0.86 -
      0.15 * Math.exp(-Math.pow((u - 0.8) / 0.17, 2)) -
      0.02 * Math.sin(u * 17 + 1);
  }
  var WALKER_U = 0.8;

  // THE DEBRIS thrown by the impact: direction (mostly upwards), speed,
  // size and colour, fixed now so the frame loop only reads them.
  var N_DEBRIS = 22;
  var dVx = new Float32Array(N_DEBRIS);
  var dVy = new Float32Array(N_DEBRIS);
  var dSize = new Float32Array(N_DEBRIS);
  var dColour = [];
  var DEBRIS_COLOURS = [CRUST, RUST, HAZARD, FIRE_HOT, STEEL];
  for (var d = 0; d < N_DEBRIS; d++) {
    var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
    var sp = 0.35 + Math.random() * 0.75; // screen heights per second
    dVx[d] = Math.cos(a) * sp;
    dVy[d] = Math.sin(a) * sp;
    dSize[d] = 2 + Math.random() * 4;
    dColour.push(DEBRIS_COLOURS[d % DEBRIS_COLOURS.length]);
  }
  var N_SMOKE = 7;
  var sDx = new Float32Array(N_SMOKE);
  var sDy = new Float32Array(N_SMOKE);
  for (var m = 0; m < N_SMOKE; m++) {
    var sa = (m / N_SMOKE) * Math.PI * 2;
    sDx[m] = Math.cos(sa);
    sDy[m] = Math.sin(sa) * 0.6 - 0.4;
  }

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    // Built here rather than per frame: a gradient is an object.
    sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(0.42, SKY_MID);
    sky.addColorStop(0.7, SKY_LOW);
    sky.addColorStop(0.78, SKY_WARM);
    sky.addColorStop(0.9, SKY_LOW);
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function easeOutBack(x) {
    var c = 1.7;
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }
  function easeInOut(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
  function easeIn(x) {
    return x * x * x;
  }

  // THE AIM. The shell flies a parabola from the walker's shoulder to the
  // target: x straight across, y the straight line lifted by 4·A·s·(1−s).
  // The target is the title on the setup screen, read when the barrel starts
  // swinging (the menu may not be parsed yet) and again at the moment of
  // firing; the barrel slews towards it, so a late answer is a quick
  // correction rather than a jump.
  var px = 0; // pivot: the walker's shoulder
  var py = 0;
  var tx = 0; // target: where the shell comes down
  var ty = 0;
  var arc = 0; // A: how high the shell climbs above the straight line
  // Barrel angle, starting level and pointing left. −π rather than π, so
  // the swing up towards an up-left heading (−π…−π/2) is the short way round.
  var aim = -Math.PI;
  var logoW = 0; // the title's box, for the crater's size
  var logoH = 0;
  var unit = 1; // the walker's scale

  function aimAt() {
    unit = Math.max(0.6, Math.min(1.25, Math.min(W, H) / 640));
    var gy = groundY(WALKER_U);
    px = W * WALKER_U - 6 * unit;
    py = gy - 58 * unit;
    // The letters' own box, not the heading's: an <h1> is as wide as its
    // panel, and the crater should frame the word.
    var logo = document.getElementById('logo');
    var b = null;
    if (logo) {
      var range = document.createRange();
      range.selectNodeContents(logo);
      b = range.getBoundingClientRect();
    }
    if (b && b.width > 2 && b.height > 2) {
      tx = b.left + b.width / 2;
      ty = b.top + b.height / 2;
      logoW = b.width;
      logoH = b.height;
    } else {
      // Nothing laid out yet to aim at: the upper middle, where it will be.
      tx = W * 0.45;
      ty = H * 0.3;
      logoW = 0;
      logoH = 0;
    }
    // Climb to a tenth of the screen from the top, whatever the two ends.
    arc = Math.max(40, (py + ty) / 2 - H * 0.1);
  }

  function aimAngle() {
    // The shell's heading as it leaves: the derivative of the arc at s = 0.
    return Math.atan2(ty - py - 4 * arc, tx - px);
  }

  function groundY(u) {
    var f = u * (N_GROUND - 1);
    var i = Math.min(N_GROUND - 2, Math.floor(f));
    return H * (hill[i] + (hill[i + 1] - hill[i]) * (f - i));
  }

  var t0 = 0;
  var landAt = LAND;
  var landMs = LAND_MS;
  var aimed = 0; // 0 not yet, 1 first look, 2 locked at FIRE
  var done = false;
  var raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function skip() {
    // Before the first frame there is no clock yet: hand off from zero.
    var now = t0 ? performance.now() - t0 : 0;
    if (now >= landAt) return;
    landAt = now;
    landMs = SKIP_MS;
  }

  function onKey(e) {
    // Skip, and let the press go no further: see the header.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) skip();
  }

  function onResize() {
    size();
    // A turned phone moves the title; follow it rather than shelling a
    // spot where it used to be.
    if (aimed) aimAt();
  }

  function drawGround(arr, colour, edge) {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var i = 0; i < N_GROUND; i++) {
      ctx.lineTo((i / (N_GROUND - 1)) * W, arr[i] * H);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var j = 0; j < N_GROUND; j++) {
        var x = (j / (N_GROUND - 1)) * W;
        if (j) ctx.lineTo(x, arr[j] * H);
        else ctx.moveTo(x, arr[j] * H);
      }
      ctx.stroke();
    }
  }

  // The walker, after the icon: two planted legs, a hazard-yellow hull with a
  // visor slot, and the barrel on its shoulder. `kick` is the recoil, 0..1.
  function drawWalker(kick) {
    var k = unit;
    var fx = W * WALKER_U;
    var fy = groundY(WALKER_U);
    var rx = Math.cos(aim) * -6 * kick * k; // the whole hull rocks back
    // Legs.
    ctx.strokeStyle = PLATE;
    ctx.lineCap = 'round';
    ctx.lineWidth = 7 * k;
    ctx.beginPath();
    ctx.moveTo(fx - 12 * k + rx, fy - 34 * k);
    ctx.lineTo(fx - 20 * k, fy - 16 * k);
    ctx.lineTo(fx - 16 * k, groundY((fx - 16 * k) / W));
    ctx.moveTo(fx + 12 * k + rx, fy - 34 * k);
    ctx.lineTo(fx + 22 * k, fy - 16 * k);
    ctx.lineTo(fx + 18 * k, groundY((fx + 18 * k) / W));
    ctx.stroke();
    // Barrel, behind the hull's shoulder.
    var bl = 44 * k * (1 - 0.18 * kick);
    ctx.lineWidth = 8 * k;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(px + rx, py);
    ctx.lineTo(px + rx + Math.cos(aim) * bl, py + Math.sin(aim) * bl);
    ctx.stroke();
    // Hull and visor.
    ctx.fillStyle = PLATE;
    ctx.fillRect(fx - 27 * k + rx, fy - 70 * k, 54 * k, 38 * k);
    ctx.fillStyle = HAZARD;
    ctx.fillRect(fx - 24 * k + rx, fy - 67 * k, 48 * k, 32 * k);
    ctx.fillStyle = PLATE;
    ctx.fillRect(fx - 18 * k + rx, fy - 60 * k, 20 * k, 6 * k);
    ctx.fillStyle = '#86edcb';
    ctx.fillRect(fx - 16 * k + rx, fy - 59 * k, 5 * k, 4 * k);
    return bl;
  }

  // The shell and the dotted trail it leaves, s from 0 (muzzle) to 1.
  function arcX(s) {
    return px + (tx - px) * s;
  }
  function arcY(s) {
    return py + (ty - py) * s - 4 * arc * s * (1 - s);
  }
  function drawShell(s, alpha) {
    ctx.fillStyle = SHELL;
    // The dots of the trail, every few hundredths of the flight.
    ctx.globalAlpha = 0.55 * alpha;
    for (var q = 0.05; q < s - 0.03; q += 0.035) {
      ctx.fillRect(arcX(q) - 1.5, arcY(q) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    if (s >= 1) return;
    var x = arcX(s);
    var y = arcY(s);
    ctx.globalAlpha = 0.3 * alpha;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // The crater: an ellipse framing the title, punched out of the curtain.
  function craterRx() {
    return Math.max(logoW * 0.62, Math.min(W, H) * 0.16);
  }
  function craterRy() {
    return Math.max(logoH * 1.25, Math.min(W, H) * 0.1);
  }

  function frame(now) {
    if (done) return;
    try {
      if (!t0) t0 = now;
      var t = now - t0;
      var land = clamp01((t - landAt) / landMs);
      if (land >= 1) {
        finish();
        return;
      }
      if (!aimed) {
        aimAt();
        aimed = 1;
      }
      if (aimed === 1 && t >= FIRE) {
        aimAt();
        aimed = 2;
      }
      var hit = t >= IMPACT && landAt >= IMPACT;

      // The shake: hard at the impact, gone in a third of a second.
      var shake = hit ? Math.max(0, 1 - (t - IMPACT) / 340) : 0;
      var ox = Math.sin(t * 0.13) * 9 * shake;
      var oy = Math.cos(t * 0.17) * 7 * shake;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr, 0, 0, dpr, dpr * ox, dpr * oy);

      // A skip before the shell lands has no crater to widen, so the whole
      // curtain fades instead.
      var fade = hit ? 1 : 1 - easeInOut(land);

      // THE CURTAIN: sky, ridge, hill, walker.
      ctx.globalAlpha = fade;
      ctx.fillStyle = sky;
      ctx.fillRect(-12, -12, W + 24, H + 24);
      drawGround(ridge, RIDGE, null);
      drawGround(hill, HILL, CRUST);
      var want = aimAngle();
      aim += (want - aim) * 0.18;
      if (t < FIRE) aim = -Math.PI + (want + Math.PI) * easeInOut(clamp01(t / (FIRE - 60)));
      var kick = t >= FIRE ? Math.max(0, 1 - (t - FIRE) / 260) : 0;
      var bl = drawWalker(kick);
      // Muzzle flash, a blink at the end of the barrel.
      if (kick > 0.6) {
        ctx.globalAlpha = fade * (kick - 0.6) * 2.5;
        ctx.fillStyle = FIRE_HOT;
        ctx.beginPath();
        ctx.arc(px + Math.cos(aim) * (bl + 8), py + Math.sin(aim) * (bl + 8), 14 * unit, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // The shell, in the air between FIRE and IMPACT.
      if (t >= FIRE && !hit) {
        drawShell(clamp01((t - FIRE) / FLIGHT), fade);
      }

      if (hit) {
        var it = t - IMPACT;
        // The crater, punched through the curtain: it bursts open with an
        // overshoot, holds while the dust flies, then widens past the edges.
        var rx = craterRx() * easeOutBack(clamp01(it / 240));
        var ry = craterRy() * easeOutBack(clamp01(it / 240));
        if (land > 0) {
          var grow = Math.hypot(W, H) * 1.1 * easeIn(land);
          rx += grow;
          ry += grow;
        }
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        // The crater's lip: scorched, then glowing where it is fresh.
        var lip = 1 - clamp01(land * 1.6);
        ctx.globalAlpha = lip;
        ctx.strokeStyle = RUST;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.globalAlpha = lip * Math.max(0.35, 1 - it / 700);
        ctx.strokeStyle = FIRE_HOT;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // The trail's last dots, hanging in the air a moment longer.
        drawShell(1, lip * Math.max(0, 1 - it / 500));
        // The flash, a blink over everything.
        var flash = Math.max(0, 1 - it / 160);
        if (flash > 0) {
          ctx.globalAlpha = 0.65 * flash;
          ctx.fillStyle = '#fff6e0';
          ctx.fillRect(-12, -12, W + 24, H + 24);
        }
        // The shockwave, a ring running out from the hit.
        var sw = clamp01(it / 520);
        if (sw < 1) {
          ctx.globalAlpha = (1 - sw) * 0.8;
          ctx.strokeStyle = HAZARD;
          ctx.lineWidth = 4 * (1 - sw) + 1;
          ctx.beginPath();
          ctx.ellipse(tx, ty, craterRx() * (1 + sw * 1.8), craterRy() * (1 + sw * 1.8), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Smoke, swelling and thinning round the lip.
        var st = it / 1000;
        ctx.fillStyle = '#5a5866';
        for (var m = 0; m < N_SMOKE; m++) {
          ctx.globalAlpha = Math.max(0, 0.32 - st * 0.3) * lip;
          ctx.beginPath();
          ctx.arc(
            tx + sDx[m] * craterRx() * (0.9 + st * 0.6),
            ty + sDy[m] * craterRy() * (0.9 + st * 0.6),
            (14 + st * 40) * unit,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        // Debris: thrown up, falling back, gone by the time the curtain is.
        var dt = it / 1000;
        for (var d = 0; d < N_DEBRIS; d++) {
          var x = tx + dVx[d] * H * dt;
          var y = ty + dVy[d] * H * dt + 0.5 * 1.6 * H * dt * dt;
          ctx.globalAlpha = Math.max(0, 1 - dt / 1.1) * lip;
          ctx.fillStyle = dColour[d];
          ctx.fillRect(x - dSize[d] / 2, y - dSize[d] / 2, dSize[d], dSize[d]);
        }
        ctx.globalAlpha = 1;
      }
    } catch (err) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    size();
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey, true);
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      skip();
    });
    document.body.appendChild(canvas);
    raf = requestAnimationFrame(frame);
    // Whatever happens to the frame loop, the curtain does not outstay this.
    setTimeout(finish, 6000);
  }

  // Loaded from the top of <body>, so the body exists even though the rest
  // of the page may not have been parsed yet.
  try {
    start();
  } catch (e) {
    finish();
  }
})();
