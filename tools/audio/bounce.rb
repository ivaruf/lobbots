# A bouncer shell skips off the ground: a metallic spring boing, pitch snapping upward.
# Quiet in the set — a bouncer can hit four times in one shot and must not shout each time.

with_fx :reverb, room: 0.35, mix: 0.18 do
  # The contact itself.
  sample :perc_snap, rate: 1.15, amp: 0.30

  # The spring: a fast rise, which is what makes a boing a boing.
  use_synth :tri
  s = play 62, note_slide: 0.22, attack: 0.002, release: 0.34, cutoff: 102, amp: 0.34
  control s, note: 86

  # A ring-modulated twin an octave up gives it the metal without a cymbal.
  with_fx :ring_mod, freq: 95, mix: 0.35 do
    use_synth :sine
    s2 = play 74, note_slide: 0.24, attack: 0.002, release: 0.30, amp: 0.20
    control s2, note: 93
  end
end
