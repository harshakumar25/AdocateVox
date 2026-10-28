/**
 * DocVex — Natural Voice Selector & Robotic Voice Ban System
 * Prioritizes high-definition neural and enhanced voices while strictly
 * barring archaic, metallic, novelty, and robotic synthesizers (e.g. Alex, Fred).
 */

export const BANNED_ROBOTIC_VOICE_NAMES = Object.freeze(new Set([
  'daniel', 'alex', 'albert', 'fred', 'ralph', 'junior',
  'bad news', 'bahh', 'bells', 'boing', 'bubbles',
  'cellos', 'deranged', 'good news', 'hysterical', 'jester',
  'organ', 'superstar', 'trinoids', 'whisper', 'wobble', 'zarvox',
  'grandpa', 'grandma', 'flo', 'eddy', 'reed', 'rocko', 'sandy', 'shelley'
]));

/**
 * Returns true if the voice name matches any known harsh, novelty, or robotic voice.
 */
export function isBannedRoboticVoice(voiceName) {
  if (!voiceName || typeof voiceName !== 'string') return false;
  const lower = voiceName.toLowerCase();
  for (const bad of BANNED_ROBOTIC_VOICE_NAMES) {
    // Word boundary or parenthetical match: catches "Alex", "Alex (US)", "Mac Fred", etc.
    const pattern = new RegExp(`(^|\\b|[\\s(_-])${bad}(\\b|[\\s)_\\-]|\$)`, 'i');
    if (pattern.test(lower)) return true;
  }
  return false;
}

/**
 * Ranks installed voices by locale and advertised voice metadata.
 * These heuristics cannot measure perceived naturalness. Returns a numeric score (-1000 for banned voices).
 */
export function scoreSpeechVoice(voice) {
  if (!voice || !voice.name) return -1000;
  const name = (voice.name || '').toLowerCase();
  const lang = (voice.lang || '').toLowerCase();

  // 1. Permanently disqualify harsh, robotic, and novelty voices
  if (isBannedRoboticVoice(name)) return -1000;

  let score = 0;

  // 2. Language: prioritize English variants
  if (lang.startsWith('en-in')) score += 750;
  else if (lang.startsWith('en-us')) score += 140;
  else if (lang.startsWith('en-gb')) score += 120;
  else if (lang.startsWith('en-ca') || lang.startsWith('en-au')) score += 110;
  else if (lang.startsWith('en')) score += 90;
  else return -500; // Demote non-English for English technical tutoring

  // 3. Compact voice penalty (legacy 8kHz robotic Mac synthesizers)
  if (name.includes('compact')) {
    score -= 300;
  }

  // 4. Modern Cloud / Neural voices (highest human naturalness)
  if (name.includes('natural') || name.includes('neural')) score += 500;
  if (name.includes('google us english')) score += 450;
  else if (name.includes('google uk english')) score += 420;
  else if (name.includes('google')) score += 350;

  // 5. System Enhanced / Premium / Siri voices
  if (name.includes('enhanced') || name.includes('premium')) score += 380;
  if (name.includes('siri')) score += 360;
  if (name.includes('online')) score += 250;

  // 6. Warm, articulate human voice favorites
  const flagshipVoices = [
    'samantha', 'ava', 'oliver', 'serena', 'tom',
    'jenny', 'guy', 'aria', 'christopher', 'evan', 'nathan', 'zoe'
  ];
  const secondaryWarmVoices = [
    'karen', 'tessa', 'victoria', 'allison', 'rishi', 'moira'
  ];
  for (const flagship of flagshipVoices) {
    if (name.includes(flagship)) {
      score += 200;
      break;
    }
  }
  for (const secondary of secondaryWarmVoices) {
    if (name.includes(secondary)) {
      score += 160;
      break;
    }
  }

  // 7. System default bonus
  if (voice.default) score += 15;

  return score;
}

/**
 * Selects the highest quality, most natural SpeechSynthesisVoice from an array.
 * Guarantees that harsh or robotic voices (like Alex, Fred) are NEVER selected.
 */
export function selectBestSpeechVoice(voices) {
  if (!voices || !Array.isArray(voices) || voices.length === 0) return null;

  const scoredVoices = [];
  for (const v of voices) {
    const score = scoreSpeechVoice(v);
    if (score > -1000) {
      scoredVoices.push({ voice: v, score });
    }
  }

  if (scoredVoices.length === 0) {
    // Extreme edge-case: If all voices were disqualified, try finding any English voice
    // that is NOT in the robotic banlist.
    const fallback = voices.find((v) => {
      const n = (v.name || '').toLowerCase();
      return (v.lang || '').startsWith('en') && !isBannedRoboticVoice(n);
    });
    return fallback || null;
  }

  // Sort descending by score
  scoredVoices.sort((a, b) => b.score - a.score);
  return scoredVoices[0].voice;
}

// Browser voices have no portable gender field. Only recognised names or explicit
// provider labels are assigned to a profile; unknown voices remain selectable by name.
export function voiceProfile(voice) {
  const name = String(voice?.name || '').toLowerCase();
  if (/\bfemale\b|\b(samantha|ava|serena|jenny|aria|zoe|karen|tessa|victoria|allison|moira|veena)\b/.test(name)) return 'female';
  if (/\bmale\b|\b(oliver|tom|guy|christopher|evan|nathan|rishi|daniel|alex)\b/.test(name)) return 'male';
  return null;
}
export function selectPreferredVoice(voices, preference = 'auto') {
  const english = (voices || []).filter((v) => /^en(?:-|$)/i.test(v.lang));
  if (preference === 'auto') return selectBestSpeechVoice(english);
  if (preference.startsWith('voice:')) return english.find((v) => `voice:${v.voiceURI}` === preference) || null;
  const candidates = english.filter((v) => voiceProfile(v) === preference);
  // An explicit male choice may use an installed Daniel/Alex voice; the old blanket
  // ban must not silently replace a user's requested male narrator with a female one.
  return candidates.sort((a,b) => scoreSpeechVoice(b) - scoreSpeechVoice(a))[0] || null;
}
export const normaliseSpeechRate = (value) => Math.min(1.3, Math.max(0.7, Number(value) || 0.95));
