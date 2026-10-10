/*
 * lobby.js — the panel where an online game is opened or found.
 *
 * NeonFox's lobby taught the shape (neonfox/js/net/lobby.js): first choose,
 * then the code is the screen. Three views in one panel, one at a time:
 *
 *   choose  a callsign, and two doors of equal size — opening a hangar is not
 *           a bigger decision than joining one (hub §2, equal peers).
 *   pad     the twelve words as keys, three slots filling as they are tapped.
 *           Typing works too: the callsign field is the only text box here,
 *           and a physical keyboard's letters go to the pad otherwise.
 *   room    a guest's hangar: the code, the rules, the crew, and a line that
 *           says whose move it is (the host's — deploying is theirs).
 *
 * A host never sits in here. Opening a hangar sends them back to the setup
 * screen, which is where the rules and the crew already are, and their
 * friends arrive there as seat cards (js/ui.js). That is the lobby's one
 * departure from NeonFox, and it is deliberate: a second roster editor in a
 * second panel would be two places to set the same thing.
 *
 * The markup is in index.html's #lobby and the look is style.css's, built
 * from the setup screen's own parts — .field, .primary, .ghost, the seat
 * swatches — so the hangar looks like the rest of the hangar. This file
 * draws no DOM of its own beyond the keys and the roster lines.
 *
 * TWO LANGUAGES. Every line here is made by a function rather than stored as
 * a string, and the last one of each is kept, so an `arcade:lang` from
 * js/i18n.js can say all of it again in the other language without the view
 * moving. The code words are a wire format — 'anvil-fox-moon' whatever the
 * language — and only their faces are translated: a Norwegian keypad reads
 * AMBOLT, and the same key joins the same game. The room a host describes
 * arrives as numbers and keys, never as a sentence (js/i18n.js says why).
 */

import { WORDS, CODE_LENGTH } from './codes.js';
import { cleanName } from './protocol.js';
import { PALETTE, PRESETS } from '../config.js';
import { t, codeWord, errText, num } from '../i18n.js';

const NAME_KEY = 'lobbots.callsign.v1';

const $ = (id) => document.getElementById(id);

/** A word's face on a key or a slot, in this device's language. */
const face = (w) => codeWord(w).toLocaleUpperCase();

function wordChips(box, words, slots = 0) {
  box.textContent = '';
  const n = Math.max(slots, words.length);
  for (let i = 0; i < n; i++) {
    const w = words[i];
    const chip = document.createElement('span');
    chip.className = w ? 'code-word' : 'code-word empty';
    chip.textContent = w ? face(w) : '·';
    box.appendChild(chip);
  }
  box.setAttribute('aria-label', words.length ? words.map(codeWord).join(' ') : t('pad.empty'));
}

/** Text, or a function that makes it — so it can be made again in another language. */
const make = (x) => (typeof x === 'function' ? x() : x || '');

/**
 * @param onHost(name)        open a hangar
 * @param onJoin(code, name)  find one; resolves or throws an error js/i18n.js can say
 * @param onBack()            leave the lobby for the setup screen
 * @param onLeave()           a guest leaving the hangar it is in
 */
export function createLobby({ onHost, onJoin, onBack, onLeave }) {
  const views = { choose: $('lobby-choose'), pad: $('lobby-pad'), room: $('lobby-room') };
  const title = $('lobby-title');
  const kicker = $('lobby-kicker');
  const callsign = $('callsign');
  const status = $('lobby-status');
  const back = $('lobby-back');
  const slots = $('pad-slots');
  const keys = $('pad-keys');
  const go = $('pad-go');
  let view = 'choose';
  let busy = false;
  let typed = [];
  /** What the heading, the status line and the room last said, as makers. */
  let head = { kicker: 'lobby.kicker', title: 'lobby.title' };
  let line = { text: '', tone: '' };
  let lastRoom = null;

  try {
    callsign.value = localStorage.getItem(NAME_KEY) || '';
  } catch {
    /* Private mode: ask again next time. */
  }
  callsign.addEventListener('input', () => {
    try {
      localStorage.setItem(NAME_KEY, callsign.value);
    } catch {
      /* Not remembering a name is not a reason to stop anyone playing. */
    }
  });

  const name = () => cleanName(callsign.value, 'Lobbot');

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function heading(kickerKey, titleKey) {
    head = { kicker: kickerKey, title: titleKey };
    setText(kicker, t(kickerKey));
    setText(title, t(titleKey));
  }

  function show(which) {
    view = which;
    for (const [key, node] of Object.entries(views)) node.hidden = key !== which;
    setText(back, t(which === 'room' ? 'leave' : 'back'));
    say('');
  }

  /** `text` may be a function; it is kept and called again on a language switch. */
  function say(text, tone = '') {
    line = { text, tone };
    status.textContent = make(text);
    status.className = tone ? `blurb ${tone}` : 'blurb';
  }

  function setBusy(on) {
    busy = on;
    for (const b of document.querySelectorAll('#lobby-host, #lobby-join, #pad-go')) b.disabled = on || (b.id === 'pad-go' && typed.length < CODE_LENGTH);
  }

  // ---- the pad ------------------------------------------------------------

  for (const w of WORDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = face(w);
    b.dataset.w = w;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      press(w);
    });
    keys.appendChild(b);
  }

  function renderPad() {
    wordChips(slots, typed, CODE_LENGTH);
    go.disabled = busy || typed.length < CODE_LENGTH;
  }

  function press(w) {
    if (busy) return;
    if (typed.length >= CODE_LENGTH) typed = [];
    typed.push(w);
    say('');
    renderPad();
    if (typed.length === CODE_LENGTH) go.focus();
  }

  $('pad-clear').addEventListener('click', (e) => {
    e.stopPropagation();
    typed = [];
    say('');
    renderPad();
  });

  // A keyboard spells words — the words on the keys, so a Norwegian keypad
  // is spelled in Norwegian, æøå and all. Letters are buffered until one
  // word is unambiguous; every face is unique in its first two letters.
  let spelled = '';
  window.addEventListener('keydown', (e) => {
    if (view !== 'pad' || $('lobby').hidden || e.target === callsign) return;
    if (e.key === 'Backspace') { typed.pop(); spelled = ''; renderPad(); e.preventDefault(); return; }
    if (e.key === 'Enter' && typed.length === CODE_LENGTH) { join(); e.preventDefault(); return; }
    if (!/^\p{L}$/u.test(e.key)) return;
    spelled += e.key.toLocaleLowerCase();
    const hits = WORDS.filter((w) => codeWord(w).toLocaleLowerCase().startsWith(spelled));
    if (hits.length === 1) { press(hits[0]); spelled = ''; }
    else if (!hits.length) spelled = '';
  });

  async function join() {
    if (busy || typed.length < CODE_LENGTH) return;
    setBusy(true);
    say(() => t('looking'));
    try {
      await onJoin(typed.join('-'), name());
    } catch (error) {
      say(() => errText(error, 'why.joinFail'), 'warn');
    } finally {
      setBusy(false);
      renderPad();
    }
  }
  go.addEventListener('click', (e) => {
    e.stopPropagation();
    join();
  });

  // ---- the doors ----------------------------------------------------------

  $('lobby-host').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    say(() => t('opening'));
    try {
      await onHost(name());
    } catch (error) {
      say(() => errText(error, 'why.hostFail'), 'warn');
    } finally {
      setBusy(false);
    }
  });

  $('lobby-join').addEventListener('click', (e) => {
    e.stopPropagation();
    typed = [];
    renderPad();
    show('pad');
    heading('lobby.kicker', 'lobby.joinTitle');
  });

  back.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view === 'room') { onLeave(); return; }
    if (view === 'pad' && !busy) { open(); return; }
    onBack();
  });

  /** `message` may be a function, as for say(). */
  function open(message = '', tone = '') {
    show('choose');
    heading('lobby.kicker', 'lobby.title');
    if (message) say(message, tone);
  }

  /** The host's description of the rules, said here: { preset, rounds, money }. */
  function rulesText(rules) {
    if (!rules || typeof rules !== 'object') return '';
    const preset = PRESETS[rules.preset] ? rules.preset : 'default';
    const rounds = Number.isFinite(rules.rounds) ? Math.max(1, Math.round(rules.rounds)) : 1;
    const money = Number.isFinite(rules.money) ? Math.max(0, rules.money) : 0;
    return t('roomRules', t(`preset.${preset}`), rounds, num(money));
  }

  const KINDS = new Set(['online', 'bot', 'host']);

  /**
   * A guest's view of the hangar. `room` is the host's last word on it:
   * { code, host, rules: { preset, rounds, money }, seats: [{ name, colorIndex, kind, you }] }.
   */
  function showRoom(room) {
    lastRoom = room;
    if (view !== 'room') show('room');
    heading('lobby.roomKicker', 'lobby.roomTitle');
    wordChips($('room-code'), String(room.code || '').split('-').filter(Boolean));
    setText($('room-rules'), rulesText(room.rules));
    const box = $('room-seats');
    box.textContent = '';
    for (const seat of room.seats || []) {
      const row = document.createElement('div');
      row.className = 'room-seat';
      const color = PALETTE[seat.colorIndex] || PALETTE[0];
      row.style.setProperty('--c', color.hex);
      const sw = document.createElement('i');
      sw.className = 'swatch';
      row.appendChild(sw);
      const b = document.createElement('b');
      b.textContent = seat.name;
      row.appendChild(b);
      const tag = document.createElement('span');
      tag.className = seat.you ? 'tag won' : 'tag';
      tag.textContent = t(`kind.${seat.you ? 'you' : KINDS.has(seat.kind) ? seat.kind : 'bot'}`);
      row.appendChild(tag);
      box.appendChild(row);
    }
    // A host name is a name; only the fallback is ours to translate.
    const host = typeof room.host === 'string' && room.host ? room.host : null;
    say(() => t('roomWait', host || t('theHost')), 'live');
  }

  // A language switch: say everything again where it stands. The keys keep
  // their wire words; only their faces change.
  document.addEventListener('arcade:lang', () => {
    for (const b of keys.children) b.textContent = face(b.dataset.w);
    renderPad();
    setText(back, t(view === 'room' ? 'leave' : 'back'));
    setText(kicker, t(head.kicker));
    setText(title, t(head.title));
    if (view === 'room' && lastRoom) {
      const kept = line;
      showRoom(lastRoom);
      say(kept.text, kept.tone);
    } else {
      say(line.text, line.tone);
    }
  });

  return {
    open,
    showRoom,
    say,
    get name() { return name(); },
  };
}
