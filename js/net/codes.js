/*
 * codes.js — a hangar's code is three words.
 *
 * fishtank and NeonFox use three pictures, for a seven-year-old with a tablet
 * and no interest in typing, and the reasoning carries over whole: one code
 * that is the same thing on the keypad, read out across a room, and pasted
 * into a chat. Three slots of twelve is 1,728 codes — the owner's call in
 * fishtank (fishtank/client/js/codes.js has the arithmetic), and right here
 * for the same reason: only hangars open at the same moment can collide, a
 * taken code is reported rather than silently wrong, and fewer taps matter
 * more than a bigger space.
 *
 * WORDS, NOT EMOJI. This game's stylesheet bans emoji outright — an emoji is
 * a font somebody else chose, and a different picture on every platform — so
 * the keys are words in the game's own type. Short, concrete, things a small
 * child already owns and can say down a phone, no two of the same kind, and
 * every one unique in its first two letters so a half-remembered "mo" still
 * finds MOON.
 */

export const WORDS = Object.freeze([
  'anvil', 'bell', 'crab', 'drum', 'eagle', 'fox',
  'gear', 'hill', 'kite', 'lamp', 'moon', 'rock',
]);
export const CODE_LENGTH = 3;

const known = new Set(WORDS);

export const newCode = () =>
  Array.from({ length: CODE_LENGTH }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join('-');

/* A whole word, or a prefix only one word starts with. Only shorter, never
 * longer: forgiving extra letters would start matching words nobody meant,
 * and landing in the wrong hangar is worse than being asked again. */
function match(word) {
  if (known.has(word)) return word;
  if (word.length < 2) return null;
  const hits = WORDS.filter((w) => w.startsWith(word));
  return hits.length === 1 ? hits[0] : null;
}

/** "Anvil Fox Moon", "anvil-fox-moon", "an fo mo" -> "anvil-fox-moon"; else null. */
export function parseCode(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean).map(match);
  return words.length === CODE_LENGTH && words.every(Boolean) ? words.join('-') : null;
}

/** The words of a code, for drawing it. */
export const codeWords = (code) => String(code ?? '').split('-').filter(Boolean);

/** "anvil-fox-moon" as "ANVIL FOX MOON", for reading aloud. */
export const spellCode = (code) => codeWords(code).join(' ').toUpperCase();
