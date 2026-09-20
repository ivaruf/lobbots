# A shell lands: one deep thud, then dirt and bolts raining back down on the hill.
# The workhorse cue — main.js plays it at a lower playbackRate for a wider blast, so it
# is kept short and dry enough to survive being stretched.
use_random_seed 3

with_fx :reverb, room: 0.55, mix: 0.22 do
  sample :bd_boom, rate: 0.72, amp: 0.95

  # The thud under the thud: a sine dropping two octaves in a third of a second.
  use_synth :sine
  s = play 45, note_slide: 0.32, attack: 0.004, release: 0.65, amp: 0.75
  control s, note: 28

  sleep 0.05

  # Debris: resonant grains thinning out as the shower lands.
  with_fx :hpf, cutoff: 80 do
    use_synth :cnoise
    12.times do |i|
      fade = 1.0 - i / 14.0
      play 60, attack: 0.001, release: 0.04 + rrand(0, 0.05),
           cutoff: rrand(85, 115), res: 0.6,
           amp: 0.32 * fade * rrand(0.4, 1.0)
      sleep rrand(0.02, 0.06)
    end
  end
end
