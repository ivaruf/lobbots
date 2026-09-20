# A purchase at the parts counter: the till, a bright bell over it, and a handful of bolts
# dropping into the tray. The shop is a counter, not a storefront, so it rattles.
use_random_seed 4

with_fx :reverb, room: 0.45, mix: 0.24 do
  sample :perc_till, rate: 1.05, amp: 0.55

  use_synth :pretty_bell
  play :e6, release: 0.50, amp: 0.36
  play :b6, release: 0.42, amp: 0.22

  sleep 0.12

  # The bolts: eight small ticks at random pitches, which is the whole joke.
  8.times do
    sample :elec_tick, rate: rrand(1.4, 2.4), amp: rrand(0.09, 0.20)
    sleep rrand(0.03, 0.08)
  end
end
