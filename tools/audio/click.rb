# UI: one small relay tick. The quietest thing in the set on purpose — it fires on every
# button, every angle nudge and every weapon change, so it has to disappear under everything.
# The amps look loud for a "quiet" cue because :elec_tick is an intrinsically tiny sample:
# at amp 0.2 it rendered 39 dB under boom-big, which is not quiet, it is inaudible. These
# values put it about 25 dB under, which is where a tick belongs.

sample :elec_tick, rate: 1.5, amp: 1.5

use_synth :square
play 96, attack: 0.001, release: 0.03, cutoff: 100, amp: 0.5
