/*
 * input.js — keyboard and pointer turned into the five intents the game has.
 *
 * Nothing here knows what a mech is. It reports what the player asked for and
 * js/main.js decides whether the sim is listening:
 *
 *     onAngle(delta)   integer degrees, signed
 *     onPower(delta)   integer power points, signed
 *     onWeapon(dir)    -1 / +1 through the arsenal
 *     onFire()
 *     onPause()
 *
 * Two rules give this file most of its shape.
 *
 * ONE INPUT PRIMITIVE. Pointer Events, never a mouse path beside a touch
 * path (hub §10). A drag on the field aims: horizontal is angle, vertical is
 * power, and both are read in whole steps with the fraction carried over, so
 * a slow drag still moves one degree at a time instead of rounding to
 * nothing. A tap that never moves does nothing at all — click-to-fire is a
 * way to lose a match by brushing the screen.
 *
 * THE DOM OWNS ITS OWN KEYS. A key event whose target is a text field is that
 * field's business and we never see it; a key event on a button is the
 * button's, so Enter and Space press it rather than firing a shell. Escape is
 * the single exception in both directions: it pauses from anywhere, and it
 * pauses even when the sim has taken the controls away, because "I cannot get
 * out of this" is the one failure a pause button exists to prevent.
 *
 * Direction convention, chosen once and shared with the HUD pills: RIGHT and
 * UP raise the number on the readout. → and a rightward drag raise the angle,
 * ↑ and an upward drag raise the power. The alternative — mapping the drag to
 * where the barrel physically swings — needs to know which way the mech
 * faces, which is the sim's business, and it reverses itself halfway across
 * the field. Matching the readout is the rule that never lies.
 */

// ---------------------------------------------------------------------------
// The hold ramp. Exported because js/ui.js drives the HUD's − / + pills from
// exactly this curve: one tuning for the pills and the arrow keys, or they
// drift apart the first time either is touched.
//
// A press is one step. Keep holding and, after a beat long enough that a tap
// is never two steps, it repeats — starting brisk and winding up.
//
// ARCHITECTURE.md §12 says "1/s -> 10/s over ~1.5 s" and this is faster than
// that on purpose: angle runs 0..180 and power 1..100, so a 10/s ceiling
// means eighteen seconds of held button to swing the barrel across, which is
// not a control, it is a punishment. Shift (keyboard) and the drag (touch)
// are the fine adjustments; the pills are the coarse one.
// ---------------------------------------------------------------------------

/** Seconds a press is held before it begins to repeat at all. */
export const HOLD_DELAY = 0.26;

const RATE_START = 8; // steps/second the moment repeating starts
const RATE_END = 34; // steps/second once wound all the way up
const RAMP = 1.5; // seconds from one to the other

/** Steps per second for a press that has been held `heldSeconds`. */
export function holdRate(heldSeconds) {
  const t = Math.min(1, Math.max(0, (heldSeconds - HOLD_DELAY) / RAMP));
  // Squared, so the first half-second stays controllable and the long hold
  // is the one that gets away from you.
  return RATE_START + (RATE_END - RATE_START) * t * t;
}

/** CSS pixels of drag per degree of angle, and per point of power. */
const PX_PER_STEP = 4;

export function createInput(canvas, handlers = {}) {
  const on = {
    onAngle() {},
    onPower() {},
    onWeapon() {},
    onFire() {},
    onPause() {},
    ...handlers,
  };

  let enabled = false;

  // ------------------------------------------------------------------ keys
  // One entry per axis while its key is down: { dir, t, acc }. `acc` counts
  // fractional steps so the ramp above can be integrated smoothly rather than
  // rounded into a stutter.
  const held = { angle: null, power: null };
  let raf = 0;
  let lastFrame = 0;

  function startHold(axis, dir, emit) {
    const cur = held[axis];
    if (cur && cur.dir === dir) return; // OS key-repeat: already running
    held[axis] = { dir, t: 0, acc: 0, emit };
    emit(dir); // the press itself is always worth exactly one step
    if (!raf) {
      lastFrame = now();
      raf = requestAnimationFrame(tick);
    }
  }

  function stopHold(axis) {
    held[axis] = null;
    if (!held.angle && !held.power && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function stopAll() {
    stopHold('angle');
    stopHold('power');
  }

  function now() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  function tick() {
    raf = 0;
    const t = now();
    // A backgrounded tab hands back a huge dt; clamp it or the barrel swings
    // half a circle the moment the player comes back.
    const dt = Math.min(0.1, Math.max(0, t - lastFrame));
    lastFrame = t;
    for (const axis of ['angle', 'power']) {
      const h = held[axis];
      if (!h) continue;
      h.t += dt;
      if (h.t < HOLD_DELAY) continue;
      h.acc += holdRate(h.t) * dt;
      const steps = Math.floor(h.acc);
      if (steps > 0) {
        h.acc -= steps;
        h.emit(h.dir * steps);
      }
    }
    if (held.angle || held.power) raf = requestAnimationFrame(tick);
  }

  /** A text field owns every key it gets, including Escape. */
  function isField(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      t.isContentEditable === true
    );
  }

  /** A button owns Enter and Space; it does not own Escape. */
  function isButton(t) {
    return !!t && (t.tagName === 'BUTTON' || t.getAttribute?.('role') === 'button');
  }

  function onKeyDown(e) {
    if (isField(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcut, not ours

    if (e.key === 'Escape') {
      // Always, enabled or not: this is the way out.
      e.preventDefault();
      stopAll();
      on.onPause();
      return;
    }

    if (isButton(e.target)) return;
    if (!enabled) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        e.preventDefault();
        // Shift is the fine adjustment: one degree per press, no repeat, and
        // OS key-repeat ignored so a leaned-on key cannot sneak a ramp in.
        if (e.shiftKey) {
          if (!e.repeat) on.onAngle(dir);
          return;
        }
        startHold('angle', dir, on.onAngle);
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        e.preventDefault();
        if (e.shiftKey) {
          if (!e.repeat) on.onPower(dir);
          return;
        }
        startHold('power', dir, on.onPower);
        return;
      }
      case 'q':
      case 'Q':
        e.preventDefault();
        if (!e.repeat) on.onWeapon(-1);
        return;
      case 'e':
      case 'E':
        e.preventDefault();
        if (!e.repeat) on.onWeapon(1);
        return;
      case 'Tab':
        // Only while we hold the controls: outside a turn, Tab is the
        // browser's and a player reaching for a button must still find one.
        e.preventDefault();
        if (!e.repeat) on.onWeapon(e.shiftKey ? -1 : 1);
        return;
      case ' ':
      case 'Spacebar':
      case 'Enter':
        e.preventDefault();
        if (!e.repeat) {
          stopAll();
          on.onFire();
        }
        return;
      default:
        return;
    }
  }

  function onKeyUp(e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stopHold('angle');
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') stopHold('power');
  }

  // --------------------------------------------------------------- pointer
  // One drag at a time, tracked by pointerId: a second finger on a tablet is
  // ignored rather than fighting the first for the barrel.
  let dragId = null;
  let lastX = 0;
  let lastY = 0;
  let accA = 0;
  let accP = 0;

  function onPointerDown(e) {
    if (!enabled || dragId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    accA = 0;
    accP = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience; a browser that refuses it still gets moves.
    }
  }

  function onPointerMove(e) {
    if (dragId !== e.pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    accA += dx / PX_PER_STEP;
    // y grows downward on screen; dragging UP is more power.
    accP += -dy / PX_PER_STEP;

    // Whole steps out, remainders kept: a slow drag adds up instead of
    // rounding to zero every frame.
    const da = accA < 0 ? Math.ceil(accA) : Math.floor(accA);
    if (da !== 0) {
      accA -= da;
      on.onAngle(da);
    }
    const dp = accP < 0 ? Math.ceil(accP) : Math.floor(accP);
    if (dp !== 0) {
      accP -= dp;
      on.onPower(dp);
    }
  }

  function endDrag(e) {
    if (dragId !== e.pointerId) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // Already gone; nothing to release.
    }
    dragId = null;
  }

  function cancelDrag() {
    dragId = null;
  }

  // ----------------------------------------------------------------- wire
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // A lost window keeps no keys down: alt-tabbing away mid-hold used to leave
  // the barrel climbing forever.
  window.addEventListener('blur', () => {
    stopAll();
    cancelDrag();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAll();
      cancelDrag();
    }
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  return {
    /** main.js enables this only while a human is aiming. */
    setEnabled(v) {
      const next = !!v;
      if (next === enabled) return;
      enabled = next;
      if (!enabled) {
        stopAll();
        cancelDrag();
      }
    },
    get enabled() {
      return enabled;
    },
  };
}
