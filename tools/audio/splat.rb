# The dirt bomb lands: a soft wet thud and a slump of earth, with no ring to it at all.
# Everything above 80 is filtered off, which is the whole trick — it has to read as the
# OPPOSITE of boom.rb, because the dirt bomb builds ground instead of removing it.
use_random_seed 9

with_fx :lpf, cutoff: 78 do
  sample :drum_heavy_kick, rate: 0.60, amp: 0.75

  use_synth :sine
  s = play 50, note_slide: 0.16, attack: 0.004, release: 0.28, amp: 0.52
  control s, note: 33

  # The earth arriving: crushed noise, dull and short.
  with_fx :bitcrusher, bits: 10, sample_rate: 9000, mix: 0.25 do
    use_synth :pnoise
    play 60, attack: 0.006, sustain: 0.05, release: 0.24, cutoff: 70, amp: 0.38
  end
end
