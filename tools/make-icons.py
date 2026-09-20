#!/usr/bin/env python3
"""Generate the LOBBOTS icon set.

    python3 tools/make-icons.py

Writes icons/icon-192.png, icon-512.png, icon-180.png and
icon-maskable-512.png. Requires Pillow (stdlib otherwise); no network, no
fonts, no external assets — the whole motif is polygons, lines and circles.
The script is the source of truth, not the PNGs (hub CLAUDE.md §4): change the
motif here and re-run, never touch the images.

THE MOTIF: a chunky industrial WALKER planted on a dark hill at the right,
shoulder barrel raised, with one bright SHELL climbing away from the muzzle on
a dotted arc toward the upper left. It is the game in one picture — the moment
after the FIRE button and before anybody knows whether it was enough power.
The walker stands on a slope with one leg long and one short, because planting
each foot on its own ground is what the mechs do in the sim.

WHAT MAKES IT LEGIBLE AT 24 px: three masses with hard value breaks, and a
fourth thing that is only a dot.
  1. the SKY: the lightest mass, a dusk gradient from near-black at the top
     (#0f1626) through #2c3a62 to a mauve horizon (#7a6a8f), warmed by a thin
     band of #c98a6a where the sun went.
  2. the HILL: the darkest mass (#25242a), filling the bottom right, with a
     pale crust line (#8b8474) where it meets the sky.
  3. the WALKER: hazard yellow (#ffd23f), the only saturated thing in the
     frame — hue carries it against the blues long after its panel detail has
     collapsed into one blob.
  4. the SHELL: a small near-white dot in the empty upper left, the one bright
     spot the dark sky is there to hold.
Hazard stripes, the visor lamp, the muzzle brake, the rust seam and the dots
of the trail are 512-px enrichment and are allowed to vanish at small sizes.

Rendered 4x and downsampled with LANCZOS. The palette is the game's own — the
shared table in ARCHITECTURE.md §12, which css/style.css and js/render/ also
work from, and whose `plate` is the manifest's background_color.
"""

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

# ---- palette (ARCHITECTURE.md §12; must match the game) -----------------
SKY_TOP = (15, 22, 38)      # #0f1626
SKY_MID = (44, 58, 98)      # #2c3a62
SKY_LOW = (122, 106, 143)   # #7a6a8f, the horizon
SKY_WARM = (201, 138, 106)  # #c98a6a, the last of the sun

RIDGE = (58, 57, 84)        # distant hills: between the sky and the near hill

HILL = (37, 36, 42)         # #25242a terrain deep — the dark mass
HILL_BAND = (59, 58, 66)    # #3b3a42 strata just under the crust
CRUST = (139, 132, 116)     # #8b8474 the lit top edge
RUST = (110, 74, 58)        # #6e4a3a seam

PLATE = (21, 24, 30)        # #15181e every outline, and the visor slot
STEEL = (78, 75, 82)        # foot pads and the hip block
HAZARD = (255, 210, 63)     # #ffd23f the walker's panels
HAZARD_DK = (206, 158, 36)  # shaded panels: the far leg, the muzzle brake
TEXT = (238, 240, 244)      # #eef0f4 the lamp, and the shell's core
MUTED = (154, 163, 178)     # #9aa3b2 the dots of the trail

SS = 4  # supersample factor


def lerp(a, b, t):
    return tuple(int(x + (y - x) * t) for x, y in zip(a, b))


def sky(img, S):
    """Four-stop vertical dusk gradient over the whole frame.

    Drawn in frame coordinates, never scaled by the maskable inset: a maskable
    icon must be opaque to its corners, so the sky is the one thing that always
    fills the image."""
    d = ImageDraw.Draw(img)
    stops = [(0.00, SKY_TOP), (0.42, SKY_MID), (0.62, SKY_WARM), (0.78, SKY_LOW)]
    for y in range(S):
        t = y / S
        c = stops[-1][1]
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                c = lerp(c0, c1, (t - t0) / (t1 - t0))
                break
        d.line([(0, y), (S, y)], fill=c)


def qbez(p0, p1, p2, n=28):
    """Sample a quadratic bezier as n+1 points, inclusive of both ends."""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


# The hill's skyline, left to right, in motif coordinates (u right, v down,
# 0..1 is the safe area). It runs out past both edges (-0.45 and 1.45) so the
# maskable version — which shrinks the motif toward the centre — still has
# ground under the walker and no floating island.
SKYLINE = (qbez((-0.45, 1.03), (0.05, 0.95), (0.30, 0.845))
           + qbez((0.30, 0.845), (0.50, 0.745), (0.70, 0.667))
           + qbez((0.70, 0.667), (0.90, 0.630), (1.45, 0.700)))


def ground_at(u):
    """Where the hill's surface sits at u — so a foot can be planted on it
    rather than guessed at. Linear between the sampled skyline points, which
    are dense enough that the difference is invisible."""
    if u <= SKYLINE[0][0]:
        return SKYLINE[0][1]
    for (u0, v0), (u1, v1) in zip(SKYLINE, SKYLINE[1:]):
        if u0 <= u <= u1 and u1 > u0:
            return v0 + (v1 - v0) * (u - u0) / (u1 - u0)
    return SKYLINE[-1][1]


def draw_motif(img, S, sq=1.0):
    """Draw hill and walker onto img (size S). sq < 1 shrinks the motif toward
    the centre, which is how the maskable icon gets its wider safe zone."""
    d = ImageDraw.Draw(img)
    cx = cy = S / 2

    def P(u, v):
        return (cx + (u - 0.5) * S * sq, cy + (v - 0.5) * S * sq)

    def W(w):
        """A motif-space width in pixels, never thinner than one."""
        return max(1, int(round(w * S * sq)))

    def poly(pts, fill):
        d.polygon([P(u, v) for (u, v) in pts], fill=fill)

    def circ(u, v, r, fill, outline=None, ow=0.0):
        x, y = P(u, v)
        rr = r * S * sq
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=fill,
                  outline=outline, width=W(ow) if outline else 1)

    def curve(pts, fill, w):
        d.line([P(u, v) for (u, v) in pts], fill=fill, width=W(w), joint="curve")

    def box(u0, v0, u1, v1, fill, radius=0.02, outline=PLATE, ow=0.016):
        a, b = P(u0, v0), P(u1, v1)
        d.rounded_rectangle([a, b], radius=radius * S * sq, fill=fill,
                            outline=outline, width=W(ow))

    def strut(points, w, fill):
        """A limb: one dark stroke wide enough to leave an outline, the fill
        over it, and a disc at each joint so the corners are not mitred
        spikes. Cheap, and it survives the downsample better than a polygon."""
        d.line([P(u, v) for (u, v) in points], fill=PLATE,
               width=W(w + 0.026), joint="curve")
        d.line([P(u, v) for (u, v) in points], fill=fill,
               width=W(w), joint="curve")
        for (u, v) in points[1:-1]:
            circ(u, v, w / 2, fill)

    # ---- distant ridges ---------------------------------------------------
    # One value between the sky and the near hill, so it reads as depth at
    # 512 px and merges into the hill's silhouette long before 24 px.
    ridge = (qbez((-0.45, 0.760), (0.00, 0.690), (0.26, 0.712))
             + qbez((0.26, 0.712), (0.48, 0.735), (0.62, 0.690))
             + qbez((0.62, 0.690), (0.85, 0.645), (1.45, 0.690)))
    poly(ridge + [(1.45, 1.6), (-0.45, 1.6)], RIDGE)

    # ---- the hill ---------------------------------------------------------
    poly(SKYLINE + [(1.45, 1.6), (-0.45, 1.6)], HILL)
    # A band of lighter strata hugging the surface, then the pale crust line
    # over it: the crust is the hard edge that keeps the dark mass from
    # bleeding into the sky at small sizes.
    band = [(u, v + 0.055) for (u, v) in SKYLINE]
    poly(SKYLINE + list(reversed(band)), HILL_BAND)
    curve(SKYLINE, CRUST, 0.016)
    # A rust seam deeper in, drawn only across the middle where there is room.
    curve([(u, v + 0.135) for (u, v) in SKYLINE if -0.1 < u < 1.1], RUST, 0.010)

    # ---- the walker -------------------------------------------------------
    # Legs first, so the body covers the hips. Each foot is planted on
    # ground_at() rather than on a guessed line, which is why the left leg is
    # long and bent and the right one is short: the slope decides.
    lf_u, rt_u = 0.622, 0.878
    lf_v, rt_v = ground_at(lf_u), ground_at(rt_u)

    strut([(0.685, 0.500), (0.630, 0.595), (lf_u, lf_v - 0.028)], 0.052, HAZARD_DK)
    box(lf_u - 0.052, lf_v - 0.018, lf_u + 0.052, lf_v + 0.016, STEEL, radius=0.012)

    strut([(0.800, 0.500), (0.868, 0.585), (rt_u, rt_v - 0.026)], 0.058, HAZARD)
    box(rt_u - 0.058, rt_v - 0.018, rt_u + 0.058, rt_v + 0.018, STEEL, radius=0.012)

    # Hip block: the dark waist the body bolts onto, peeking below it.
    box(0.660, 0.470, 0.822, 0.548, STEEL, radius=0.016)

    # Body: the big yellow slab that IS the icon at 24 px.
    box(0.612, 0.335, 0.868, 0.524, HAZARD, radius=0.030, ow=0.018)

    # Hazard stripes along the body's skirt. Slanted quads, each computed to
    # keep all four corners inside the band, so no clipping mask is needed.
    sv0, sv1 = 0.452, 0.512
    slant = 0.030
    x = 0.634
    while x + 0.026 + slant < 0.856:
        poly([(x, sv1), (x + slant, sv0), (x + slant + 0.026, sv0), (x + 0.026, sv1)], PLATE)
        x += 0.054

    # Visor slot and its lamp — the walker's one facial feature.
    box(0.640, 0.372, 0.794, 0.416, PLATE, radius=0.014, outline=None)
    circ(0.668, 0.394, 0.017, TEXT)

    # Shoulder mount, raised on the body's left, and the barrel out of it.
    box(0.592, 0.272, 0.724, 0.376, HAZARD, radius=0.022, ow=0.018)
    pivot, muzzle = (0.660, 0.322), (0.462, 0.208)
    brake = (pivot[0] + (muzzle[0] - pivot[0]) * 0.76,
             pivot[1] + (muzzle[1] - pivot[1]) * 0.76)
    strut([pivot, muzzle], 0.052, HAZARD)
    strut([brake, muzzle], 0.078, HAZARD_DK)
    circ(*pivot, 0.020, PLATE)  # the shoulder bolt

    # ---- the shot ---------------------------------------------------------
    # A lob, not a laser: it leaves the muzzle steeply and is still climbing
    # when it reaches the corner. The dots are the shot trail the renderer
    # draws in play (ARCHITECTURE.md §9), so the icon and the game agree.
    arc = qbez((0.462, 0.208), (0.310, 0.085), (0.145, 0.090), n=9)
    for i, (u, v) in enumerate(arc[1:-1], start=1):
        circ(u, v, 0.012 + 0.004 * (i / len(arc)), MUTED)
    su, sv = arc[-1]
    circ(su, sv, 0.052, PLATE)     # a dark rim, so it reads against any sky
    circ(su, sv, 0.040, HAZARD)
    circ(su - 0.008, sv - 0.008, 0.021, TEXT)  # hot core, offset toward flight


def render(size, sq=1.0):
    S = size * SS
    img = Image.new("RGB", (S, S))
    sky(img, S)
    draw_motif(img, S, sq)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")):
        render(size).save(os.path.join(OUT, name))
        print("wrote", name)
    # Maskable: the same motif inside a 78% box, so a circular or squircle
    # mask can take ~11% off every edge and still not clip the barrel or the
    # shell. The sky fills the frame regardless, and the hill runs off the
    # bottom by construction, so the result is opaque to its corners.
    render(512, sq=0.78).save(os.path.join(OUT, "icon-maskable-512.png"))
    print("wrote icon-maskable-512.png")


if __name__ == "__main__":
    main()
