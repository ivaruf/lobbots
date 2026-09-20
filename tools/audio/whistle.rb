# The shell on its way down: a long descending whistle with a breath of rushing air behind it.
# Deliberately clean and cartoonish — the sound of an arc, not of incoming fire.

with_fx :reverb, room: 0.4, mix: 0.16 do
  use_synth :tri
  s = play 97, note_slide: 1.30, attack: 0.07, sustain: 1.05, release: 0.28, cutoff: 108, amp: 0.36
  control s, note: 63

  # A sine an octave up, quieter, so the whistle has a point rather than a body.
  use_synth :sine
  s2 = play 109, note_slide: 1.30, attack: 0.10, sustain: 1.00, release: 0.28, amp: 0.15
  control s2, note: 75

  # The air it is falling through.
  with_fx :hpf, cutoff: 100 do
    use_synth :pnoise
    play 60, attack: 0.30, sustain: 0.75, release: 0.40, cutoff: 120, amp: 0.10
  end
end
