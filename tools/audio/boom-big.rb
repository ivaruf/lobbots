# The big one — mega shell, nuke: a sub thump you feel first, a long low tail, and crackle
# rolling off it for a second afterwards. The loudest thing in the set on purpose (hub §9:
# the one-shot encoder applies ONE shared gain, so this `amp:` is what makes it the loudest
# in the game as well).
#
# The tail is long but it is not INFINITE, and that is a rendering constraint as much as a
# musical choice: the hub's one-shot encoder finds the take between the first and last
# silence in the recording, so a piece whose reverb never reaches the noise floor inside the
# render window comes back untrimmed — with the recorder's own second of lead-in still on the
# front, which on a cue means a boom that arrives a beat after the flash. room 0.9 with a
# 1.9 s release did exactly that, and so did :misc_cineboom, which is many seconds long and
# sat under everything at -20 dB until the recording stopped. Hence the envelope on the
# sample below: it is a boom, not a bed. The piece now dies out around 5 s, inside a 7 s
# render.
use_random_seed 5

with_fx :reverb, room: 0.72, mix: 0.34 do
  # sustain/release truncate the sample: we want its first two seconds and none of its
  # long drone.
  sample :misc_cineboom, rate: 0.85, amp: 0.85, attack: 0.01, sustain: 1.1, release: 1.3
  sample :bd_boom, rate: 0.50, amp: 1.0

  # The sub: a long slide into the basement, where the "big" actually lives.
  use_synth :sine
  s = play 40, note_slide: 1.4, attack: 0.008, release: 1.6, amp: 1.0
  control s, note: 21

  # A dirty low roar over it, distorted just enough to have grit without being gritty.
  with_fx :distortion, distort: 0.28, mix: 0.28 do
    use_synth :bnoise
    play 60, attack: 0.02, sustain: 0.30, release: 1.10, cutoff: 88, amp: 0.45
  end

  sleep 0.12

  # Crackle: a longer, sparser debris shower than boom.rb's, so the two are
  # recognisably the same event at two sizes.
  with_fx :hpf, cutoff: 70 do
    use_synth :cnoise
    22.times do |i|
      fade = 1.0 - i / 26.0
      play 60, attack: 0.001, release: 0.05 + rrand(0, 0.08),
           cutoff: rrand(80, 118), res: 0.55,
           amp: 0.38 * fade * rrand(0.3, 1.0)
      sleep rrand(0.03, 0.08)
    end
  end
end
