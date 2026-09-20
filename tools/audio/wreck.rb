# A walker goes down: sheet metal folding in three clanks, then steam out of the broken line.
# Industrial rather than fatal — nobody is inside these things, and the sound should not
# suggest otherwise.
use_random_seed 13

with_fx :reverb, room: 0.6, mix: 0.28 do
  # The first hit: the body meeting the hill.
  sample :drum_tom_lo_hard, rate: 0.70, amp: 0.65

  # Three clanks, each lower and shorter, ring-modulated into sheet metal.
  with_fx :ring_mod, freq: 128, mix: 0.35 do
    use_synth :hollow
    [59, 52, 45].each_with_index do |n, i|
      play n, attack: 0.002, release: 0.50 - i * 0.08, cutoff: 98, amp: 0.46 - i * 0.08
      sample :perc_snap2, rate: 0.8 + i * 0.2, amp: 0.16
      sleep 0.18 + i * 0.06
    end
  end

  # One bolt letting go.
  sample :elec_twang, rate: 0.75, amp: 0.22

  # Steam out of the hydraulics, which is what says "machine" rather than "explosion".
  with_fx :hpf, cutoff: 104 do
    use_synth :pnoise
    play 60, attack: 0.14, sustain: 0.55, release: 0.85, cutoff: 124, amp: 0.26
  end
end
