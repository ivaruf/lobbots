/*
 * dmath.js — sin, cos, tan, exp, atan2 and hypot that give the same answer
 * on every JavaScript engine.
 *
 * WHY THIS FILE EXISTS. Online play (js/net/) runs the identical Match on
 * every device and sends only decisions between them, so two devices must
 * compute the identical battle from the identical inputs, down to the last
 * bit. ECMAScript pins down + − × ÷ and Math.sqrt exactly (IEEE 754, correctly
 * rounded, no fused multiply-add), but leaves Math.sin, cos, tan, exp, atan2
 * and hypot "implementation-approximated". V8 and JavaScriptCore really do
 * disagree on them in the last bit — NeonFox measured it (neonfox/js/net/
 * host.js), and it is why NeonFox streams snapshots instead. Desktop Chrome
 * plus an iPad is the ordinary pairing for this game, which is exactly that
 * pair of engines.
 *
 * One ULP sounds harmless. It is not here: a shell's launch velocity comes
 * from cos/sin, it flies for thousands of steps, and a crater carved one
 * column further left changes where the next walker stands. So every one of
 * these is written from operations the standard does pin down — Cody–Waite
 * range reduction and a Taylor polynomial in Horner form — and is therefore
 * bit-identical everywhere. Accuracy is ~1e-16, which is better than the sim
 * needs; identity is the point.
 *
 * Only js/sim/ uses these. The renderer keeps Math.* — what it draws never
 * feeds back into the battle.
 */

const HALF_PI = Math.PI / 2;
// π/2 split in two (fdlibm's pio2_1 / pio2_1t), so x − k·π/2 loses nothing
// for the small k this game ever produces.
const PIO2_HI = 1.5707963267341256;
const PIO2_LO = 6.077100506506192e-11;
const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;

/** sin on |r| <= π/4: Taylor to r^17. */
function kSin(r) {
  const z = r * r;
  return r * (1 + z * (-1 / 6 + z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880 + z * (-1 / 39916800 +
    z * (1 / 6227020800 + z * (-1 / 1307674368000 + z * (1 / 355687428096000)))))))));
}

/** cos on |r| <= π/4: Taylor to r^18. */
function kCos(r) {
  const z = r * r;
  return 1 + z * (-1 / 2 + z * (1 / 24 + z * (-1 / 720 + z * (1 / 40320 + z * (-1 / 3628800 +
    z * (1 / 479001600 + z * (-1 / 87178291200 + z * (1 / 20922789888000 + z * (-1 / 6402373705728000)))))))));
}

/** x = k·π/2 + r with |r| <= π/4; returns k mod 4 and r. */
function reduce(x) {
  const k = Math.round(x / HALF_PI);
  return { q: ((k % 4) + 4) % 4, r: (x - k * PIO2_HI) - k * PIO2_LO };
}

export function dsin(x) {
  const { q, r } = reduce(x);
  return q === 0 ? kSin(r) : q === 1 ? kCos(r) : q === 2 ? -kSin(r) : -kCos(r);
}

export function dcos(x) {
  const { q, r } = reduce(x);
  return q === 0 ? kCos(r) : q === 1 ? -kSin(r) : q === 2 ? -kCos(r) : kSin(r);
}

export function dtan(x) {
  return dsin(x) / dcos(x);
}

/**
 * e^x. Below -700 the answer is under 1e-304 and is returned as 0, which keeps
 * the power-of-two scaling below inside normal numbers (so it is exact).
 */
export function dexp(x) {
  if (x !== x) return NaN;
  if (x < -700) return 0;
  if (x > 709) return Infinity;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO; // |r| <= 0.35
  let p = 1;
  for (let n = 16; n >= 1; n--) p = 1 + (r * p) / n;
  // 2^k by squaring an exact power of two: every product is exact.
  let base = k < 0 ? 0.5 : 2;
  let e = k < 0 ? -k : k;
  let scale = 1;
  while (e) {
    if (e & 1) scale *= base;
    base *= base;
    e >>= 1;
  }
  return p * scale;
}

/** atan on |z| <= tan(π/16): Taylor, ample at 0.2. */
function kAtan(z) {
  const z2 = z * z;
  let s = 0;
  for (let n = 25; n >= 1; n -= 2) s = 1 / n - z2 * s;
  return z * s;
}

function datan(z) {
  if (z !== z) return NaN;
  const neg = z < 0;
  let a = neg ? -z : z;
  let base = 0;
  let inv = false;
  if (a > 1) { a = 1 / a; inv = true; }
  // Halve the angle twice: atan(a) = 2·atan(a / (1 + √(1 + a²))).
  a = a / (1 + Math.sqrt(1 + a * a));
  a = a / (1 + Math.sqrt(1 + a * a));
  base = 4 * kAtan(a);
  if (inv) base = HALF_PI - base;
  return neg ? -base : base;
}

export function datan2(y, x) {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + Math.PI : datan(y / x) - Math.PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

/** √(a² + b²). Math.hypot is engine-defined; √ of a sum is not. */
export function dhypot(a, b) {
  return Math.sqrt(a * a + b * b);
}
