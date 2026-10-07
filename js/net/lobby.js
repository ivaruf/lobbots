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
 */

import { WORDS, CODE_LENGTH } from './codes.js';
import { cleanName } from './protocol.js';
import { PALETTE } from '../config.js';

const NAME_KEY = 'lobbots.callsign.v1';

const $ = (id) => document.getElementById(id);

function wordChips(box, words, slots = 0) {
  box.textContent = '';
  const n = Math.max(slots, words.length);
  for (let i = 0; i < n; i++) {
    const w = words[i];
    const chip = document.createElement('span');
    chip.className = w ? 'code-word' : 'code-word empty';
    chip.textContent = w ? w.toUpperCase() : '·';
    box.appendChild(chip);
  }
  box.setAttribute('aria-label', words.length ? words.join(' ') : 'empty');
}

/**
 * @param onHost(name)        open a hangar
 * @param onJoin(code, name)  find one; resolves or throws with a message to show
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

  function show(which) {
    view = which;
    for (const [key, node] of Object.entries(views)) node.hidden = key !== which;
    back.textContent = which === 'room' ? 'Leave hangar' : 'Back';
    say('');
  }

  function say(text, tone = '') {
    status.textContent = text || '';
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
    b.textContent = w.toUpperCase();
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

  // A keyboard spells words: buffer letters until one word is unambiguous.
  let spelled = '';
  window.addEventListener('keydown', (e) => {
    if (view !== 'pad' || $('lobby').hidden || e.target === callsign) return;
    if (e.key === 'Backspace') { typed.pop(); spelled = ''; renderPad(); e.preventDefault(); return; }
    if (e.key === 'Enter' && typed.length === CODE_LENGTH) { join(); e.preventDefault(); return; }
    if (!/^[a-z]$/i.test(e.key)) return;
    spelled += e.key.toLowerCase();
    const hits = WORDS.filter((w) => w.startsWith(spelled));
    if (hits.length === 1) { press(hits[0]); spelled = ''; }
    else if (!hits.length) spelled = '';
  });

  async function join() {
    if (busy || typed.length < CODE_LENGTH) return;
    setBusy(true);
    say('Looking for that hangar…');
    try {
      await onJoin(typed.join('-'), name());
    } catch (error) {
      say(error?.message || 'Could not reach that hangar.', 'warn');
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
    say('Opening a hangar…');
    try {
      await onHost(name());
    } catch (error) {
      say(error?.message || 'Could not open a hangar.', 'warn');
    } finally {
      setBusy(false);
    }
  });

  $('lobby-join').addEventListener('click', (e) => {
    e.stopPropagation();
    typed = [];
    renderPad();
    show('pad');
    setText(title, 'Join a hangar');
  });

  back.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view === 'room') { onLeave(); return; }
    if (view === 'pad' && !busy) { open(); return; }
    onBack();
  });

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function open(message = '', tone = '') {
    show('choose');
    setText(kicker, 'Play online');
    setText(title, 'Crew up');
    if (message) say(message, tone);
  }

  /**
   * A guest's view of the hangar. `room` is the host's last word on it:
   * { code, seats: [{ name, colorIndex, kind, you }], rules }.
   */
  function showRoom(room) {
    if (view !== 'room') show('room');
    setText(kicker, 'In the hangar');
    setText(title, 'Waiting to deploy');
    wordChips($('room-code'), String(room.code || '').split('-'));
    setText($('room-rules'), room.rules || '');
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
      tag.textContent = seat.you ? 'you' : seat.kind;
      row.appendChild(tag);
      box.appendChild(row);
    }
    say(`${room.host || 'The host'} deploys when the crew is ready.`, 'live');
  }

  return {
    open,
    showRoom,
    say,
    get name() { return name(); },
  };
}
