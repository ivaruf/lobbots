# Firing: a pneumatic thump out of the breech, then the servo settling the barrel back.
# Air and machinery, not a gunshot — the walkers are plant equipment that happens to lob things.
use_random_seed 11

with_fx :reverb, room: 0.25, mix: 0.10 do
  # The charge: fat and short, with the click of the breech on top of it.
  sample :bd_fat, rate: 0.85, amp: 0.8
  sample :elec_tick, rate: 0.7, amp: 0.25

  # The air going out around the shell.
  with_fx :hpf, cutoff: 92 do
    use_synth :bnoise
    play 60, attack: 0.004, sustain: 0.04, release: 0.20, cutoff: 112, amp: 0.38
  end

  sleep 0.09

  # Servo: the barrel dropping back to rest, a short whine downward.
  use_synth :tri
  s = play 76, note_slide: 0.22, attack: 0.01, release: 0.30, cutoff: 96, amp: 0.26
  control s, note: 61
end
