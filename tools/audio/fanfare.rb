# Round won: three notes up and a chord held over them. Bright and a bit silly rather than
# triumphant — winning a round of this is funny, not heroic.

with_fx :reverb, room: 0.6, mix: 0.32 do
  # A thump under the first note so the sting has weight, like the rest of the game.
  sample :bd_fat, rate: 0.9, amp: 0.35

  use_synth :prophet
  [:d5, :fs5, :a5].each do |n|
    play n, attack: 0.005, release: 0.34, cutoff: 108, amp: 0.42
    sleep 0.13
  end

  # The landing chord, an octave up, left to ring out into the reverb.
  play_chord [:d6, :fs6, :a6], attack: 0.01, release: 1.5, cutoff: 114, amp: 0.46

  # And one bolt rattling off the winner, half a beat late.
  sleep 0.18
  sample :elec_tick, rate: 1.9, amp: 0.16
end
