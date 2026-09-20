#!/usr/bin/env bash
# Rebuild audio/ from the Sonic Pi pieces beside this script. One command, both steps.
#
#     tools/audio/encode.sh            # renders to a temp dir, encodes into audio/
#     tools/audio/encode.sh /tmp/wav   # keep the WAVs somewhere you can listen to them
#
# The pieces in this directory are the source of truth and audio/*.m4a is an output
# (hub CLAUDE.md §9), the same way tools/make-icons.py is the truth for the icons. Edit a
# .rb, run this, commit both — and bump VERSION in sw.js, because the cues are precached.
#
# IT WILL NOT RUN IN A SANDBOX. Sonic Pi renders in REAL TIME through the real audio device,
# so this takes about half a minute and is audible while it works. A sandbox that blocks
# CoreAudio kills the engine a few seconds in.
#
# THE SECONDS AFTER EACH NAME ARE A RECORDING WINDOW, NOT A DURATION, and each one is
# deliberately longer than its piece. The hub's one-shot encoder finds the take between the
# first and the last silence in the recording; a piece still sounding when the recorder stops
# has no last silence, so it comes back UNTRIMMED with the recorder's own ~1 s of lead-in
# still attached — which on a cue means the boom lands a beat after the flash. Two pieces
# taught us that: boom-big needed 7 s (and an envelope on :misc_cineboom, which is many
# seconds long and droned under everything at -20 dB until the recorder stopped), and
# bounce/kaching/click each needed roughly double their audible length before their reverb
# tails reached the floor. If you lengthen a piece's release or raise its reverb room, raise
# its window here too, then check the encoder's output: a line reading "full" instead of a
# duration in ms means exactly this failure.
#
# The encoder applies ONE gain to the whole set, so the balance is whatever the `amp:` values
# in the pieces say. As rendered today the spread runs boom-big -5 dB, boom -9, wreck -10,
# splat/crumble -13, bounce -14, whistle/kaching -15, fire -16, fanfare -18, click -27.
set -euo pipefail

cd "$(dirname "$0")/../.."   # the game directory, whatever it is called this month

SP="${SONIC_PI_APP:-/Applications/Sonic Pi.app}/Contents/Resources/app/server/native/ruby/bin/ruby"
WAV="${1:-$(mktemp -d)}"

SONIC_PI_PIECES=tools/audio "$SP" ../tools/audio/render.rb "$WAV" \
  fire=1.2 \
  whistle=2 \
  boom=3 \
  boom-big=7 \
  bounce=1.5 \
  splat=1 \
  crumble=2 \
  wreck=3 \
  kaching=2 \
  fanfare=3 \
  click=1

# Trim, one shared gain, mono AAC at 96k. Music would want the opposite treatment
# (per-file normalisation, stereo) and is a different tool; this game has no music.
node ../tools/audio/encode-oneshots.mjs "$WAV" audio

echo
echo "WAVs left in $WAV"
ls -l audio
