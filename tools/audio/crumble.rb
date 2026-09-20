# Ground giving way: a low rumble with gravel sliding across the top of it, about a second
# and a half of it. The sim settles terrain as a process rather than a jump (ARCHITECTURE §4),
# so this cue has to be long enough to sit under the whole slide.
use_random_seed 21

with_fx :reverb, room: 0.5, mix: 0.18 do
  # The mass moving: filtered low, swelling rather than hitting.
  with_fx :lpf, cutoff: 70 do
    use_synth :bnoise
    play 60, attack: 0.22, sustain: 0.55, release: 0.70, cutoff: 66, amp: 0.50
  end

  # The grains: forty small stones, thinning as the slope finds its rest.
  with_fx :lpf, cutoff: 96 do
    use_synth :cnoise
    40.times do |i|
      t = i / 40.0
      play 60, attack: 0.001, release: 0.02 + rrand(0, 0.04),
           cutoff: rrand(75, 100), res: 0.5,
           amp: 0.20 * (1.0 - t * 0.7) * rrand(0.3, 1.0)
      sleep rrand(0.015, 0.05)
    end
  end
end
