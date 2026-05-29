// tts.js
// Thin wrapper around the Web Speech API (window.speechSynthesis) for word
// pronunciation. Native ES module, no dependencies.
//
// Design goals:
//   - Graceful degradation: every export is a safe no-op when speechSynthesis
//     is unavailable (older browsers, locked-down environments). The UI calls
//     isSupported() to decide whether to show the pronounce button.
//   - Single voice at a time: speak() cancels any in-flight utterance first so
//     rapid taps / card advances never queue overlapping speech.
//   - Best-effort voice quality: pick a non-"compact" English voice when one is
//     available (iOS defaults to a robotic "compact" voice otherwise). Voices
//     load lazily on iOS, so we listen for the async 'voiceschanged' event and
//     cache the chosen voice once resolved.

/**
 * Whether the Web Speech synthesis API is available in this environment.
 * @returns {boolean}
 */
export function isSupported() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

// ---------------------------------------------------------------------------
// Voice selection (cached; resolved lazily because iOS populates voices async)
// ---------------------------------------------------------------------------

// Cached chosen voice (null = not yet resolved or none suitable found).
let chosenVoice = null;
// Whether we have attached the one-time 'voiceschanged' listener.
let voicesListenerAttached = false;

// Preferred well-known good English voice names (highest priority first).
const PREFERRED_VOICE_NAMES = [
  'Samantha',
  'Daniel',
  'Karen',
  'Google US English',
  'Google UK English',
  'Google UK English Female',
  'Google UK English Male',
];

// Substrings marking the low-quality voices we want to avoid when possible.
const AVOID_SUBSTRINGS = ['compact', 'eloquence'];

/**
 * Choose the best available English voice from a voice list.
 * Priority:
 *   1. A well-known good name (Samantha/Daniel/Karen/Google ...) that is English.
 *   2. Any English voice whose name does NOT contain "compact"/"eloquence".
 *   3. Any English voice at all.
 * Returns null when the list has no English voice.
 * @param {SpeechSynthesisVoice[]} voices
 * @returns {SpeechSynthesisVoice|null}
 */
function pickBestVoice(voices) {
  const list = Array.isArray(voices) ? voices : [];
  const isEnglish = (v) => typeof v.lang === 'string' && v.lang.toLowerCase().startsWith('en');
  const english = list.filter(isEnglish);
  if (english.length === 0) return null;

  const nameOf = (v) => String(v.name || '');
  const isAvoided = (v) => {
    const lower = nameOf(v).toLowerCase();
    return AVOID_SUBSTRINGS.some((s) => lower.includes(s));
  };

  // 1. Preferred well-known name (and not an avoided variant).
  for (const preferred of PREFERRED_VOICE_NAMES) {
    const match = english.find((v) => nameOf(v) === preferred && !isAvoided(v));
    if (match) return match;
  }
  // Loose match: name contains a preferred token (e.g. localized suffix).
  for (const preferred of PREFERRED_VOICE_NAMES) {
    const match = english.find((v) => nameOf(v).includes(preferred) && !isAvoided(v));
    if (match) return match;
  }

  // 2. Any English voice that is not a "compact"/"eloquence" variant.
  const nonAvoided = english.find((v) => !isAvoided(v));
  if (nonAvoided) return nonAvoided;

  // 3. Fall back to the first English voice, robotic or not.
  return english[0];
}

/**
 * Resolve (and cache) the best English voice. iOS loads voices lazily, so when
 * getVoices() is initially empty we attach a one-time 'voiceschanged' listener
 * to fill the cache as soon as voices arrive.
 * @returns {SpeechSynthesisVoice|null}
 */
function resolveVoice() {
  if (chosenVoice) return chosenVoice;
  if (!isSupported()) return null;

  let voices = [];
  try {
    voices = window.speechSynthesis.getVoices() || [];
  } catch (err) {
    void err;
    voices = [];
  }

  if (voices.length > 0) {
    chosenVoice = pickBestVoice(voices);
    return chosenVoice;
  }

  // Voices not ready yet: populate the cache when the engine emits them.
  if (!voicesListenerAttached && typeof window.speechSynthesis.addEventListener === 'function') {
    voicesListenerAttached = true;
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      try {
        const next = window.speechSynthesis.getVoices() || [];
        if (next.length > 0) chosenVoice = pickBestVoice(next);
      } catch (err) {
        void err;
      }
    });
  }
  return null;
}

/**
 * Cancel any in-flight or queued speech. Safe to call when unsupported.
 * @returns {void}
 */
export function cancel() {
  if (!isSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch (err) {
    // Some engines throw if cancel() is called in an odd state; ignore.
    void err;
  }
}

/**
 * Speak the given text. Cancels any current utterance first so only one plays.
 * No-op (returns false) when unsupported or text is empty.
 *
 * Uses the best available English voice (see resolveVoice) when one is found,
 * otherwise lets the engine pick its default for the given lang.
 *
 * @param {string} text - the word/phrase to pronounce
 * @param {{ lang?: string, rate?: number }} [opts]
 *   lang : BCP-47 language tag (default 'en-US')
 *   rate : speech rate 0.1..10 (default 0.95, slightly slower for clarity)
 * @returns {boolean} true if an utterance was dispatched
 */
export function speak(text, { lang = 'en-US', rate = 0.95 } = {}) {
  if (!isSupported()) return false;

  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return false;

  // Stop anything currently speaking before starting the new utterance.
  cancel();

  try {
    const utterance = new window.SpeechSynthesisUtterance(value);
    utterance.lang = lang;
    utterance.rate = rate;

    // Prefer a good cached voice; align utterance.lang to it when chosen so the
    // engine honours the selection.
    const voice = resolveVoice();
    if (voice) {
      utterance.voice = voice;
      if (typeof voice.lang === 'string' && voice.lang) utterance.lang = voice.lang;
    }

    window.speechSynthesis.speak(utterance);
    return true;
  } catch (err) {
    console.warn('[tts] speak failed:', err);
    return false;
  }
}
