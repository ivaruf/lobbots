/*
 * i18n.js — every word Lobbots says to a player, in bokmål and in English.
 *
 * The hub's contract (CLAUDE.md §2, "Two languages, Norwegian first"), worked
 * out first in kitchens/js/i18n.js and kept to its shape here:
 *
 *   t(key, ...args)   the current language, else English, else the key itself,
 *                     warning once per missing key. A value may be a function,
 *                     because a language is not a template with blanks in it:
 *                     "1 runde" / "3 runder", and Norwegian puts the name in a
 *                     different place in half the sentences below.
 *   getLang()         'nb' or 'en'.
 *   setLang(lang)     validates, stores, sets <html lang>, repaints every
 *                     [data-i18n], then dispatches `arcade:lang` on document.
 *                     Everything built at runtime (js/ui.js, js/net/lobby.js,
 *                     js/main.js's banners and exit button) listens for that
 *                     and repaints itself; js/screen.js and js/update.js import
 *                     nothing and keep their own few words for the same event.
 *   paintStatic(root) [data-i18n] -> textContent, [data-i18n-label] ->
 *                     aria-label and title; and two this game adds:
 *                     [data-i18n-aria] -> aria-label only (a canvas or a
 *                     group, where a hover tooltip would sit over the game),
 *                     [data-i18n-placeholder] -> placeholder.
 *
 * NORWEGIAN BY DEFAULT, whatever the browser prefers: that is the owner's
 * call for the whole arcade. The choice lives in `arcade.lang.v1`, the one key
 * every game on the origin shares — a language is a fact about the player,
 * not about this cabinet — so it holds "nb" or "en" and never anything else.
 * index.html sets <html lang> from it in the head, before first paint, and
 * the static text in index.html is written in Norwegian, so the default never
 * flashes English on the way in.
 *
 * NOT TRANSLATED: the name Lobbots, names players type (and the colour a bot
 * was named after once it is on the hill — by then it is a name), the hangar
 * code's wire form, the manifest, console output and storage keys.
 *
 * ONLINE, THE LANGUAGE STAYS HOME. Nothing in js/net/ sends a sentence: a
 * refusal is the key 'full', a guest's room is { preset, rounds, money }, and
 * each device renders those in its own language here. Errors thrown by the
 * network files carry `.key` and `.args` for errText() below; their English
 * `.message` is for the console.
 */

const KEY = 'arcade.lang.v1';

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'nb' || saved === 'en') return saved;
  } catch {
    // No storage: the default stands.
  }
  return 'nb';
}

let lang = initial();
document.documentElement.lang = lang;

export const getLang = () => lang;

/* ------------------------------------------------------------ helpers */

/** "a, b og c" / "a, b and c". */
function list(words, and) {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} ${and} ${words[words.length - 1]}`;
}

/**
 * Thousands separators, the way each language writes them. Not Intl: this
 * game never asked Intl, and a Norwegian reading "1,200" sees one point two.
 */
export function num(n) {
  const s = String(Math.round(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'nb' ? ' ' : ',');
}

/** 1200 -> "1.2k" / "1,2k", 800 -> "800": short enough for six pills. */
export function shortNum(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const s = Number.isInteger(k) ? String(k) : k.toFixed(1);
  return `${lang === 'nb' ? s.replace('.', ',') : s}k`;
}

/** The hangar code's words in this language, for reading aloud. */
export function codeWord(w) {
  return t(`word.${w}`);
}

/** A whole code as this device would read it out: "DRAGE HJUL MÅNE". */
function spell(code) {
  return String(code ?? '').split('-').filter(Boolean).map(codeWord).join(' ').toLocaleUpperCase();
}

/**
 * A network error as a sentence: its key if it carries one, else the
 * fallback. A bare Error (a TypeError, a browser's own text) is not shown —
 * it would be English, and rarely something a child can act on.
 */
export function errText(error, fallback) {
  if (error && error.why) return whyText(error.why);
  if (error && error.key) return t(`err.${error.key}`, ...(error.args || []));
  return t(fallback);
}

/**
 * A reason another device sent ('full', 'hostEnded'), said in this device's
 * language. Anything not on the list is shown as the generic refusal — except
 * a whole sentence, which is an older host's English and still beats nothing.
 */
export function whyText(why) {
  const key = `why.${why}`;
  if (why && key in STRINGS.en) return t(key);
  if (/\s/.test(String(why || ''))) return String(why);
  return t('why.refused');
}

/* ------------------------------------------------------------ the words */

const STRINGS = {
  nb: {
    // ---- static page
    'field': 'Slagmarken i Lobbots',
    'setup.kicker': 'Presisjonsrobotikk',
    'setup.tagline': 'Store roboter, enda større skudd.',
    'art.caption': 'LB-01 / Artilleriplattform',
    'art.online': '● Systemer klare',
    'rules': 'Regler',
    'rounds': 'Runder',
    'howMany': 'Hvor mange',
    'money': 'Start\u00adbolter',
    'players': 'Spillere',
    'seatLess': 'Én spiller færre',
    'seatMore': 'Én spiller til',
    'code': 'Kode',
    'close': 'Lukk',
    'play': 'Spill',
    'playOnline': 'Spill på nett',
    'back': 'Tilbake',
    'language': 'Språk',
    'name': 'Navn',
    'namePlaceholder': 'Hva heter du?',
    'host': 'Lag et spill',
    'join': 'Bli med',
    'lobby.fine':
      'Enheten til vennen din snakker rett med din. En åpen møteplass på nettet kobler dere sammen og ser de tre ordene, aldri selve spillet.',
    'pad.hint': 'Trykk på de tre ordene vennen din leser opp.',
    'pad.keys': 'Kodeord',
    'pad.clear': 'Tøm',
    'pad.empty': 'tom',
    'thinking': 'tenker …',
    'skip': 'Hopp til resultatene ▸▸',
    'angle': 'Vinkel',
    'power': 'Kraft',
    'walk': 'Gå',
    'fire': 'Skyt',
    'lessPower': 'Mindre kraft',
    'morePower': 'Mer kraft',
    'swingLeft': 'Sving løpet mot venstre',
    'swingRight': 'Sving løpet mot høyre',
    'walkLeft': 'Flytt gåmålet mot venstre',
    'walkRight': 'Flytt gåmålet mot høyre',
    'loadout': 'Våpen',
    'sb.kicker': 'Dette kostet det',
    'continue': 'Fortsett',
    'shop': 'Butikk',
    'done': 'Ferdig',
    'sound': 'Lyd',
    'botSpeed': 'Robot\u00adfart',
    'mo.kicker': 'Sluttresultat',
    'mo.title': 'Kampen er over',
    'again': 'Spill igjen',
    'pause': 'Pause',

    // ---- setup
    'preset.default': 'Vanlig',
    'preset.classic': 'Klassisk',
    'preset.quick': 'Rask',
    'preset.mayhem': 'Kaos',
    'presetd.default': 'Slik spillet er ment å spilles.',
    'presetd.classic': 'Lang kamp, ny vind hver runde, og skudd som går ut av banen er borte.',
    'presetd.quick': 'Tre runder, tjue sekunder per skudd, og vind som aldri står stille.',
    'presetd.mayhem': 'Flere roboter, mer penger, og bakken slutter aldri å rase.',
    'roundsOther': 'Annet',
    'moneyEach': (n) => `${n} bolter hver i starten`,
    'you': 'Du',
    'robot': 'Robot',
    'online': 'På nett',
    'colourTitle': (c) => `${c} – trykk for en annen farge`,
    'colourLabel': (c) => `Farge: ${c}. Trykk for en annen.`,
    'seatName': (i) => `Navn på plass ${i}`,
    'seatWho': (i) => `Hvem styrer plass ${i}`,
    'seatStyle': (i) => `Robottype på plass ${i}`,
    'color.red': 'Glød',
    'color.blue': 'Kobolt',
    'color.yellow': 'Messing',
    'color.green': 'Mose',
    'color.orange': 'Rust',
    'color.purple': 'Fiolett',
    'color.cyan': 'Kjøler',
    'color.pink': 'Bluss',
    'color.white': 'Kritt',
    'color.lime': 'Syre',

    // ---- the seven bots
    'bot.rookie': 'Ferskingen',
    'bot.improviser': 'Improvisatoren',
    'bot.calculator': 'Kalkulatoren',
    'bot.sniper': 'Snikskytteren',
    'bot.maniac': 'Villmannen',
    'bot.economist': 'Gnieren',
    'bot.chaos': 'Kaosgopheren',
    'botd.rookie': 'Store sving, kort hukommelse. Farlig ved et uhell.',
    'botd.improviser': 'Sikter greit, men bruker aldri samme våpen to ganger.',
    'botd.calculator': 'Lærer av forrige bom. Gi den to skudd, og bli redd.',
    'botd.sniper': 'Flatt, presist og gjerrig. Bruker det gode bare når den er sikker.',
    'botd.maniac': 'Kjøper det største i butikken og skyter det på den som står nærmest.',
    'botd.economist': 'Sparer halvparten av alt. Plager de som allerede er skadet.',
    'botd.chaos': 'Fornuftige valg i en ufornuftig rekkefølge. Gøy å se på – på god avstand.',

    // ---- the arsenal
    'w.shell': 'Granat',
    'w.heavy': 'Tung granat',
    'w.mega': 'Megagranat',
    'w.cluster': 'Klasebombe',
    'w.mirv': 'MIRV',
    'w.roller': 'Rulleren',
    'w.bouncer': 'Spretteren',
    'w.dirt': 'Jordbombe',
    'w.earthmover': 'Spaden',
    'w.burrower': 'Boreren',
    'w.napalm': 'Napalm',
    'w.volcano': 'Vulkan',
    'w.funky': 'Tullebombe',
    'w.nuke': 'Atombombe',
    'w.move': 'Gå',
    'w.bomblet': 'Småbombe',
    'w.mirv-head': 'MIRV-spiss',
    'w.fire': 'Ild',
    'w.lava-rock': 'Lavastein',
    'w.spark': 'Gnist',
    'wd.shell': 'Den du alltid har. Liten, ærlig og gratis.',
    'wd.heavy': 'Samme bue, dobbelt så stort hull.',
    'wd.mega': 'Et vanlig smell som slutter å være høflig.',
    'wd.cluster': 'Spretter opp i seks småbomber når den treffer. De gjør jobben.',
    'wd.mirv': 'Deler seg på toppen av buen i fem sprenghoder. Ta med paraply.',
    'wd.roller': 'Lander, og triller nedover til den finner noen.',
    'wd.bouncer': 'Spretter tre ganger, så bestemmer den seg.',
    'wd.dirt': 'Lager en haug der den lander. Begrav en motstander – eller deg selv.',
    'wd.earthmover': 'Graver ut en skål og legger jorda på hver side.',
    'wd.burrower': 'Borer seg inn i åsen og fortsetter. Smeller dypt nede.',
    'wd.napalm': 'Skvetter brennende drivstoff nedover bakken. Graver ingenting, men gjør vondt.',
    'wd.volcano': 'Bryter ut fra krateret: sju glødende steiner rett opp og ut.',
    'wd.funky': 'Spretter akkurat som den vil og spruter gnister hver gang. Herlig.',
    'wd.nuke': 'Fjerner åsen. Og det meste av nabolaget. Helt urimelig å se på.',
    'wd.move': 'Bruk en tur på å gå i stedet for å skyte. Et lite stykke til hver side; den klatrer ikke opp en klippe og går ikke utfor en.',

    // ---- HUD
    'hull': (hp, max) => `Skrog ${hp} av ${max}`,
    'roundOf': (r, n) => `Runde ${r} / ${n}`,
    'calm': 'stille',
    'windCalm': 'Vindstille',
    'wind': (mag, left) => `Vind ${mag} mot ${left ? 'venstre' : 'høyre'}`,

    // ---- scoreboard
    'sb.title': (r) => `Resultater, runde ${r}`,
    'standing': 'står',
    'wrecked': 'knust',
    'tookRound': 'vant runden',
    'stat.damage': 'skade',
    'stat.wrecks': 'knuste',
    'stat.wins': 'seire',
    'stat.score': 'poeng',
    'stat.rounds': 'runder',
    'stat.bolts': 'bolter',
    'reason.damage': 'skade',
    'reason.kills': 'knuste',
    'reason.survived': 'overlevde',
    'reason.round win': 'rundeseier',
    'reason.salary': 'lønn',
    'reason.underdog': 'ekstra hjelp',
    'inTheTin': 'i boksen',
    'waitingFor': (names) => `Venter på ${list(names, 'og')}`,

    // ---- shop
    'shopWrecked': 'knust, men handler likevel',
    'pack': (n) => (n === 1 ? '1 runde' : `×${n} runder`),
    'holding': (n) => `har ${n}`,
    'buy': 'Kjøp',
    'bolts': 'bolter',
    'shopWatch': (name) => `${name} handler på sin egen skjerm …`,
    'shopLooking': (name) => `${name} ser på hyllene …`,
    'bought': (name, items) => `${name} kjøpte ${list(items, 'og')}`,
    'boughtNothing': (name) => `${name} kjøpte ingenting`,

    // ---- match over
    'champ': (name) => `${name} vinner hele kampen!`,
    'noChamp': 'Ingen vant denne gangen.',

    // ---- pause
    'pause.kicker': 'Ingenting skjer før du sier fra',
    'pause.kickerOnline': 'På nett – kampen går videre',
    'pause.title': 'Pause',
    'pause.titleOnline': 'Meny',
    'pause.noteHost': 'Alle andre spiller fortsatt. Robotfarten gjelder hele kampen.',
    'pause.noteGuest': 'Alle andre spiller fortsatt, og kontrollene dine virker.',
    'resume': 'Fortsett',
    'quit': 'Avslutt kampen',
    'quitHost': 'Avslutt for alle',
    'quitGuest': 'Forlat kampen',
    'exit.arcade': 'Tilbake til arkaden',
    'exit.app': 'Lukk',
    // ---- the corner and the menu panel's sound rows (hub §2: three plates,
    // and MUSIC / EFFECTS in every game, in the game's own case)
    'menu': 'Meny',
    'mute': 'Slå av lyden',
    'unmute': 'Slå på lyden',
    'music': 'Musikk',
    'effects': 'Effekter',
    'musicHint': 'Lobbots har ingen musikk ennå. Nivået huskes til den kommer.',
    'settings': 'Innstillinger',
    'settings.kicker': 'Lyd, språk og robotfart',

    // ---- banners
    'roundBanner': (r, n) => `Runde ${r} av ${n}`,
    'hill.rolling': 'Bølgende åser',
    'hill.mountains': 'Bratte fjell',
    'hill.valley': 'Dyp dal',
    'hill.canyon': 'Juvet',
    'hill.chaos': 'Taggete kaos',
    'hill.flat': 'Nesten flatt',
    'yourTurn': (name) => `${name}, din tur`,
    'yourTurnSub': 'Vinkel, kraft, skyt',
    'aiming': (name) => `${name} sikter`,
    'ownScreen': 'På sin egen skjerm',
    'onTheMove': (name) => `${name} flytter seg`,
    'bot': 'robot',
    'cannotWalk': 'Kan ikke gå dit',
    'cannotWalkSub': 'Velg den andre siden, eller skyt',
    'stopped': 'Stoppet',
    'stoppedSub': 'For bratt til å gå videre',
    'reactor': (name) => `Reaktoren til ${name} eksploderer`,
    'nukeShout': 'ATOMBOMBE',
    'cooksOff': (name) => `Vraket til ${name} smeller`,
    'isWrecked': (name) => `${name} er knust`,
    'groundGave': 'Bakken raste sammen',
    'takesRound': (name) => `${name} vinner runden`,
    'nobodyLeft': 'Ingen står igjen',
    'paidAnyway': 'Alle får betalt likevel',
    'droppedOut': (name) => `${name} falt ut`,
    'botHasIt': 'En robot tar over',
    'time': 'Tiden er ute!',
    'timeSub': 'Skuddet går som det står',
    'netWontLoad': 'Nettspill ville ikke laste',
    'netWontLoadSub': 'Sjekk nettet, og prøv igjen',
    'youLeft': 'Du forlot spillet.',
    'aboard': (name) => `${name} er med`,
    'left': (name) => `${name} gikk`,
    'seatIsBot': 'Plassen er en robot igjen',
    'everyoneOut': 'Alle er ute',
    'youOut': 'Du er ute',
    'botsSettle': 'Robotene gjør det opp',
    'botsSettleAt': (s) => `Robotene gjør det opp på ×${s}`,
    'botSpeedWhere': 'Robotfarten finner du i pausemenyen',
    'wontClose': 'Dette vinduet lukker seg ikke selv',
    'wontCloseSub': 'Lukk det i nettleseren',

    // ---- online: the open game on the setup screen
    'hangar.idle': 'Les disse tre ordene for en venn. På vennens enhet: Spill på nett, så Bli med.',
    'hangar.friends': (n) =>
      `${n === 1 ? 'Én venn' : `${n} venner`} er med. Trykk Spill når alle er klare.`,
    'hangar.tabs': (detail) =>
      `Fant ikke møteplassen (${detail}) – bare andre faner i denne nettleseren kan bli med.`,
    'hangar.reconnecting': 'Kobler til møteplassen igjen …',

    // ---- online: the lobby
    'lobby.kicker': 'Med venner',
    'lobby.title': 'Spill på nett',
    'lobby.joinTitle': 'Bli med',
    'lobby.roomKicker': 'Du er med',
    'lobby.roomTitle': 'Venter på verten',
    'leave': 'Forlat spillet',
    'looking': 'Leter etter spillet …',
    'opening': 'Lager et spill …',
    'theHost': 'Verten',
    'roomRules': (preset, rounds, money) =>
      `${preset} · ${rounds === 1 ? '1 runde' : `${rounds} runder`} · ${money} bolter i starten`,
    'roomWait': (host) => `${host} starter når alle er klare.`,
    'kind.you': 'deg',
    'kind.online': 'på nett',
    'kind.bot': 'robot',
    'kind.host': 'vert',

    // ---- why a game ended or would not have us (keys sent by the host)
    'why.version': 'Du og verten har ulike versjoner av Lobbots. Last inn siden på nytt begge to, og prøv igjen.',
    'why.busy': 'Det spillet er midt i en kamp. Prøv igjen når den er ferdig.',
    'why.full': 'Spillet er fullt – ti roboter er alt en ås har plass til.',
    'why.hostEnded': 'Verten avsluttet kampen.',
    'why.closed': 'Verten stengte spillet.',
    'why.refused': 'Spillet slapp oss ikke inn.',
    'why.lineHost': 'Forbindelsen til verten ble brutt.',
    'why.gone': 'Spillet ble stengt.',
    'why.joinFail': 'Fant ikke frem til det spillet.',
    'why.hostFail': 'Klarte ikke å lage et spill.',

    // ---- errors thrown by js/net/, rendered here
    'err.timeout': 'Spillet svarte aldri. Sjekk ordene, og be vennen din holde det åpent.',
    'err.lineDropped': 'Forbindelsen til spillet ble brutt.',
    'err.offline': 'Du er frakoblet, så den andre enheten kan ikke bli funnet.',
    'err.noBroker': 'Koden for møteplassen ville ikke laste, verken fra nettet eller fra denne siden.',
    'err.brokerBroken': 'Koden for møteplassen lastet, men virker ikke.',
    'err.mmTimeout': 'Møteplassen svarte ikke i tide.',
    'err.codeTaken': 'Den koden er allerede i bruk. Lag et nytt spill for å få en ny.',
    'err.mmFailed': (type) => `Møteplassen feilet (${type}).`,
    'err.noGame': (code) =>
      `Fant ikke noe spill på ${spell(code)}. Sjekk koden, og at vennen din fortsatt har spillet åpent med skjermen på.`,
    'err.unreachable': (type) => `Fikk ikke kontakt med spillet (${type}).`,
    'err.hostSilent': 'Verten svarte ikke.',
    'err.noTurn':
      'Verten svarte aldri. Sjekk koden – noen nettverk kan rett og slett ikke nå hverandre.',
    'err.reopening': 'Åpner spillet igjen – koden virker kanskje ikke akkurat nå.',
    'err.codeStolen': 'Noe annet tok denne koden. Lag et nytt spill for å få en ny.',
    'err.mmTrouble': (type) => `Trøbbel med møteplassen (${type}).`,

    // ---- the twelve code words, as a Norwegian child would read them out
    'word.anvil': 'ambolt',
    'word.bell': 'bjelle',
    'word.crab': 'krabbe',
    'word.drum': 'tromme',
    'word.eagle': 'ørn',
    'word.fox': 'rev',
    'word.gear': 'hjul',
    'word.hill': 'bakke',
    'word.kite': 'drage',
    'word.lamp': 'lampe',
    'word.moon': 'måne',
    'word.rock': 'stein',
  },

  en: {
    'field': 'Lobbots battlefield',
    'setup.kicker': 'Precision robotics',
    'setup.tagline': 'Big robots, bigger lobs.',
    'art.caption': 'LB-01 / Artillery platform',
    'art.online': '● Systems online',
    'rules': 'Rules',
    'rounds': 'Rounds',
    'howMany': 'How many',
    'money': 'Start bolts',
    'players': 'Players',
    'seatLess': 'One player fewer',
    'seatMore': 'One more player',
    'code': 'Code',
    'close': 'Close',
    'play': 'Play',
    'playOnline': 'Play online',
    'back': 'Back',
    'language': 'Language',
    'name': 'Name',
    'namePlaceholder': 'What should we call you?',
    'host': 'Host a game',
    'join': 'Join a game',
    'lobby.fine':
      "Your friend's device talks straight to yours. A public matchmaker introduces the two and sees the three words, never the game.",
    'pad.hint': 'Tap the three words your friend reads out.',
    'pad.keys': 'Code words',
    'pad.clear': 'Clear',
    'pad.empty': 'empty',
    'thinking': 'thinking…',
    'skip': 'Skip to results ▸▸',
    'angle': 'Angle',
    'power': 'Power',
    'walk': 'Walk',
    'fire': 'Fire',
    'lessPower': 'Less power',
    'morePower': 'More power',
    'swingLeft': 'Swing barrel left',
    'swingRight': 'Swing barrel right',
    'walkLeft': 'Walk target left',
    'walkRight': 'Walk target right',
    'loadout': 'Loadout',
    'sb.kicker': 'What that cost everyone',
    'continue': 'Continue',
    'shop': 'Shop',
    'done': 'Done',
    'sound': 'Sound',
    'botSpeed': 'Bot speed',
    'mo.kicker': 'Final standings',
    'mo.title': 'Match over',
    'again': 'Play again',
    'pause': 'Pause',

    'preset.default': 'Default',
    'preset.classic': 'Classic',
    'preset.quick': 'Quick',
    'preset.mayhem': 'Mayhem',
    'presetd.default': 'The way it is meant to be played.',
    'presetd.classic': 'Long match, wind per round, shells leave the field for good.',
    'presetd.quick': 'Three rounds, twenty seconds a shot, wind that will not sit still.',
    'presetd.mayhem': 'More of everyone, more money, the ground will not stop moving.',
    'roundsOther': 'Custom',
    'moneyEach': (n) => `${n} bolts each to start`,
    'you': 'You',
    'robot': 'Bot',
    'online': 'Online',
    'colourTitle': (c) => `${c} — tap for another colour`,
    'colourLabel': (c) => `Colour: ${c}. Tap for another.`,
    'seatName': (i) => `Name for seat ${i}`,
    'seatWho': (i) => `Who drives seat ${i}`,
    'seatStyle': (i) => `Bot style for seat ${i}`,
    'color.red': 'Ember',
    'color.blue': 'Cobalt',
    'color.yellow': 'Alloy',
    'color.green': 'Moss',
    'color.orange': 'Rust',
    'color.purple': 'Violet',
    'color.cyan': 'Coolant',
    'color.pink': 'Flare',
    'color.white': 'Chalk',
    'color.lime': 'Acid',

    'bot.rookie': 'Rookie',
    'bot.improviser': 'Improviser',
    'bot.calculator': 'Calculator',
    'bot.sniper': 'Sniper',
    'bot.maniac': 'Maniac',
    'bot.economist': 'Economist',
    'bot.chaos': 'Chaos Gopher',
    'botd.rookie': 'Big swings, short memory. Dangerous by accident.',
    'botd.improviser': 'Decent aim, never the same weapon twice.',
    'botd.calculator': 'Dials in from the last miss. Give it two shots and worry.',
    'botd.sniper': 'Flat, accurate, stingy. Spends the good ammo only when sure.',
    'botd.maniac': 'Buys the biggest thing in the shop and fires it at whoever is closest.',
    'botd.economist': 'Saves half of everything. Picks on the wounded.',
    'botd.chaos': 'Plausible choices in an implausible order. Delightful to watch, from a distance.',

    'w.shell': 'Shell',
    'w.heavy': 'Heavy Shell',
    'w.mega': 'Mega Shell',
    'w.cluster': 'Cluster Bomb',
    'w.mirv': 'MIRV',
    'w.roller': 'Roller',
    'w.bouncer': 'Bouncer',
    'w.dirt': 'Dirt Bomb',
    'w.earthmover': 'Earth Mover',
    'w.burrower': 'Burrower',
    'w.napalm': 'Napalm',
    'w.volcano': 'Volcano',
    'w.funky': 'Funky Bomb',
    'w.nuke': 'Nuke',
    'w.move': 'Move',
    'w.bomblet': 'Bomblet',
    'w.mirv-head': 'MIRV warhead',
    'w.fire': 'Fire',
    'w.lava-rock': 'Lava rock',
    'w.spark': 'Spark',
    'wd.shell': 'The one you always have. Small, honest, free.',
    'wd.heavy': 'Same arc, twice the hole.',
    'wd.mega': 'A conventional explosion that stops being polite.',
    'wd.cluster': 'Pops on impact into six bomblets that do the real work.',
    'wd.mirv': 'Splits at the top of its arc into five warheads. Bring an umbrella.',
    'wd.roller': 'Lands, then rolls downhill until it finds someone.',
    'wd.bouncer': 'Three bounces, then it makes up its mind.',
    'wd.dirt': 'Builds a hill where it lands. Bury a rival, or yourself.',
    'wd.earthmover': 'Scoops a bowl out and piles it up either side.',
    'wd.burrower': 'Goes into the hill and keeps going. Detonates deep.',
    'wd.napalm': 'Splashes burning fuel across the slope. Digs nothing, hurts plenty.',
    'wd.volcano': 'Erupts from the crater: seven hot rocks straight up and out.',
    'wd.funky': 'Bounces however it feels like and sheds sparks on every hop. Glorious.',
    'wd.nuke': 'Removes the hill. And most of the neighbourhood. Visually unreasonable.',
    'wd.move': 'Spend a turn walking instead of shooting. Up to a short way either side; will not climb a cliff or step off one.',

    'hull': (hp, max) => `Hull ${hp} of ${max}`,
    'roundOf': (r, n) => `Round ${r} / ${n}`,
    'calm': 'calm',
    'windCalm': 'Wind calm',
    'wind': (mag, left) => `Wind ${mag} to the ${left ? 'left' : 'right'}`,

    'sb.title': (r) => `Round ${r} results`,
    'standing': 'standing',
    'wrecked': 'wrecked',
    'tookRound': 'took the round',
    'stat.damage': 'damage',
    'stat.wrecks': 'wrecks',
    'stat.wins': 'wins',
    'stat.score': 'score',
    'stat.rounds': 'rounds',
    'stat.bolts': 'bolts',
    'reason.damage': 'damage',
    'reason.kills': 'kills',
    'reason.survived': 'survived',
    'reason.round win': 'round win',
    'reason.salary': 'salary',
    'reason.underdog': 'underdog',
    'inTheTin': 'in the tin',
    'waitingFor': (names) => `Waiting for ${list(names, 'and')}`,

    'shopWrecked': 'wrecked, still shopping',
    'pack': (n) => (n === 1 ? '1 round' : `×${n} rounds`),
    'holding': (n) => `holding ${n}`,
    'buy': 'Buy',
    'bolts': 'bolts',
    'shopWatch': (name) => `${name} is at the counter on their own screen…`,
    'shopLooking': (name) => `${name} is looking at the shelves…`,
    'bought': (name, items) => `${name} bought ${list(items, 'and')}`,
    'boughtNothing': (name) => `${name} bought nothing`,

    'champ': (name) => `${name} walks away with it.`,
    'noChamp': 'Nobody walks away.',

    'pause.kicker': 'Nothing moves until you say so',
    'pause.kickerOnline': 'Online — the hill keeps going',
    'pause.title': 'Paused',
    'pause.titleOnline': 'Menu',
    'pause.noteHost': 'Everyone else is still playing. Bot speed here is for the whole match.',
    'pause.noteGuest': 'Everyone else is still playing, and your controls still work.',
    'resume': 'Resume',
    'quit': 'End match',
    'quitHost': 'End match for everyone',
    'quitGuest': 'Leave match',
    'exit.arcade': 'Back to arcade',
    'exit.app': 'Close',
    // ---- the corner and the menu panel's sound rows
    'menu': 'Menu',
    'mute': 'Mute',
    'unmute': 'Unmute',
    'music': 'Music',
    'effects': 'Effects',
    'musicHint': 'Lobbots has no music yet. The level is kept for when it arrives.',
    'settings': 'Settings',
    'settings.kicker': 'Sound, language and bot speed',

    'roundBanner': (r, n) => `Round ${r} of ${n}`,
    'hill.rolling': 'Rolling hills',
    'hill.mountains': 'Steep mountains',
    'hill.valley': 'Deep valley',
    'hill.canyon': 'The canyon',
    'hill.chaos': 'Jagged chaos',
    'hill.flat': 'Mostly flat',
    'yourTurn': (name) => `${name}, your turn`,
    'yourTurnSub': 'Angle, power, fire',
    'aiming': (name) => `${name} is aiming`,
    'ownScreen': 'On their own screen',
    'onTheMove': (name) => `${name} is on the move`,
    'bot': 'bot',
    'cannotWalk': 'Cannot walk that way',
    'cannotWalkSub': 'Pick the other side, or shoot',
    'stopped': 'Stopped short',
    'stoppedSub': 'Too steep to go on',
    'reactor': (name) => `${name}'s reactor goes critical`,
    'nukeShout': 'NUKE',
    'cooksOff': (name) => `${name}'s wreck cooks off`,
    'isWrecked': (name) => `${name} is wrecked`,
    'groundGave': 'The ground gave way',
    'takesRound': (name) => `${name} takes the round`,
    'nobodyLeft': 'Nobody left standing',
    'paidAnyway': 'Everyone gets paid anyway',
    'droppedOut': (name) => `${name} dropped out`,
    'botHasIt': 'A bot has the controls',
    'time': 'Time!',
    'timeSub': 'The shot goes as it stands',
    'netWontLoad': 'Online play would not load',
    'netWontLoadSub': 'Check the connection, then try again',
    'youLeft': 'You left the game.',
    'aboard': (name) => `${name} is aboard`,
    'left': (name) => `${name} left`,
    'seatIsBot': 'Their seat is a bot again',
    'everyoneOut': 'Everyone is out',
    'youOut': 'You are out',
    'botsSettle': 'The bots settle it',
    'botsSettleAt': (s) => `The bots settle it at ×${s}`,
    'botSpeedWhere': 'Bot speed is in the pause menu',
    'wontClose': 'This window will not close itself',
    'wontCloseSub': 'Close it from the browser',

    'hangar.idle': 'Read these three words to a friend. On their device: Play online, then Join a game.',
    'hangar.friends': (n) =>
      `${n === 1 ? 'One friend' : `${n} friends`} aboard. Press Play when everyone is in.`,
    'hangar.tabs': (detail) =>
      `Matchmaking is out of reach (${detail}) — only other tabs in this browser can join.`,
    'hangar.reconnecting': 'Reconnecting to matchmaking…',

    'lobby.kicker': 'With friends',
    'lobby.title': 'Play online',
    'lobby.joinTitle': 'Join a game',
    'lobby.roomKicker': "You're in",
    'lobby.roomTitle': 'Waiting for the host',
    'leave': 'Leave game',
    'looking': 'Looking for that game…',
    'opening': 'Hosting a game…',
    'theHost': 'The host',
    'roomRules': (preset, rounds, money) =>
      `${preset} rules · ${rounds === 1 ? '1 round' : `${rounds} rounds`} · ${money} bolts to start`,
    'roomWait': (host) => `${host} starts when everyone is ready.`,
    'kind.you': 'you',
    'kind.online': 'online',
    'kind.bot': 'bot',
    'kind.host': 'host',

    'why.version': 'You and the host are on different builds of Lobbots. Both reload and try again.',
    'why.busy': 'That game is in the middle of a match. Try again when it is over.',
    'why.full': 'That game is full — ten lobbots is all a hill holds.',
    'why.hostEnded': 'The host ended the match.',
    'why.closed': 'The host closed the game.',
    'why.refused': 'The game turned us away.',
    'why.lineHost': 'The line to the host dropped.',
    'why.gone': 'The game closed.',
    'why.joinFail': 'Could not reach that game.',
    'why.hostFail': 'Could not host a game.',

    'err.timeout': 'The game never answered. Check the words, and ask your friend to keep it open.',
    'err.lineDropped': 'The line to the game dropped.',
    'err.offline': 'You are offline, so there is no way to find the other device.',
    'err.noBroker': 'The matchmaking code could not load, from the CDN or from this site.',
    'err.brokerBroken': 'The matchmaking code loaded but is unusable.',
    'err.mmTimeout': 'Matchmaking timed out.',
    'err.codeTaken': 'That code is already in use. Host again for a fresh one.',
    'err.mmFailed': (type) => `Matchmaking failed (${type}).`,
    'err.noGame': (code) =>
      `No game found at ${spell(code)}. Check the code, and that your friend still has it open with their screen awake.`,
    'err.unreachable': (type) => `Could not reach the game (${type}).`,
    'err.hostSilent': 'The host did not answer.',
    'err.noTurn':
      'The host never answered. Check the code — and that there is no TURN here, so a few networks simply cannot reach each other.',
    'err.reopening': 'Reopening the game — the code may not work just now.',
    'err.codeStolen': 'Something else took this code. Host again for a fresh one.',
    'err.mmTrouble': (type) => `Matchmaking trouble (${type}).`,

    'word.anvil': 'anvil',
    'word.bell': 'bell',
    'word.crab': 'crab',
    'word.drum': 'drum',
    'word.eagle': 'eagle',
    'word.fox': 'fox',
    'word.gear': 'gear',
    'word.hill': 'hill',
    'word.kite': 'kite',
    'word.lamp': 'lamp',
    'word.moon': 'moon',
    'word.rock': 'rock',
  },
};

const warned = new Set();

export function t(key, ...args) {
  let v = STRINGS[lang][key];
  if (v === undefined) {
    v = STRINGS.en[key];
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`Lobbots: no ${lang} words for "${key}"`);
    }
  }
  if (v === undefined) return key;
  return typeof v === 'function' ? v(...args) : v;
}

/**
 * A key's words in both languages. For telling whether a name is still one
 * the game chose ("Du" / "You", a colour) rather than one a player typed:
 * only the first kind follows a language switch.
 */
export function variants(key) {
  return [STRINGS.nb[key], STRINGS.en[key]].filter((v) => typeof v === 'string');
}

/** Every marked node in `root` gets its words in the current language. */
export function paintStatic(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-label]')) {
    const words = t(n.dataset.i18nLabel);
    n.setAttribute('aria-label', words);
    n.title = words;
  }
  // aria-label alone, for a group or a canvas a hover tooltip would cover.
  for (const n of root.querySelectorAll('[data-i18n-aria]')) {
    n.setAttribute('aria-label', t(n.dataset.i18nAria));
  }
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) {
    n.placeholder = t(n.dataset.i18nPlaceholder);
  }
}

export function setLang(next) {
  if (next !== 'nb' && next !== 'en') return;
  lang = next;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Not remembered; this visit still switches.
  }
  paintStatic();
  document.dispatchEvent(new CustomEvent('arcade:lang', { detail: lang }));
}

// The static page is written in Norwegian; an English player's first frame
// is repainted here, before main.js builds anything on top of it.
if (lang !== 'nb') paintStatic();
