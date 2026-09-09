/**
 * Text normalisation shared by every comparison in the analysis layer.
 * Deliberately conservative: it must not merge words that a creator would consider
 * different, because that would make us cut a take that is not a retake.
 */

const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bi'?m\b/g, 'i am'],
  [/\bi'?ll\b/g, 'i will'],
  [/\bi'?ve\b/g, 'i have'],
  [/\bi'?d\b/g, 'i would'],
  [/\byou'?re\b/g, 'you are'],
  [/\byou'?ll\b/g, 'you will'],
  [/\byou'?ve\b/g, 'you have'],
  [/\bwe'?re\b/g, 'we are'],
  [/\bwe'?ll\b/g, 'we will'],
  [/\bthey'?re\b/g, 'they are'],
  [/\bit'?s\b/g, 'it is'],
  [/\bthat'?s\b/g, 'that is'],
  [/\bhere'?s\b/g, 'here is'],
  [/\bthere'?s\b/g, 'there is'],
  [/\bwhat'?s\b/g, 'what is'],
  [/\blet'?s\b/g, 'let us'],
  [/\bdon'?t\b/g, 'do not'],
  [/\bdoesn'?t\b/g, 'does not'],
  [/\bdidn'?t\b/g, 'did not'],
  [/\bcan'?t\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bwon'?t\b/g, 'will not'],
  [/\bisn'?t\b/g, 'is not'],
  [/\baren'?t\b/g, 'are not'],
  [/\bwasn'?t\b/g, 'was not'],
  [/\bgonna\b/g, 'going to'],
  [/\bwanna\b/g, 'want to'],
  [/\bgotta\b/g, 'got to'],
];

/** Digits a transcriber may emit either way; comparison should not care. */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  '10': 'ten',
  '100': 'hundred',
  '1000': 'thousand',
};

export const SENTENCE_TERMINATORS = /[.!?]["')\]]*\s*$/;

export function endsWithTerminator(text: string): boolean {
  return SENTENCE_TERMINATORS.test(text.trim());
}

/** Lowercase, strip punctuation, expand contractions, collapse whitespace. */
export function normalize(input: string): string {
  let text = input.toLowerCase();
  // Normalise the several apostrophes a transcriber may emit.
  text = text.replace(/[‘’ʼ`]/g, "'");
  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement);
  }
  // Em/en dashes mark restarts in many transcripts; treat them as separators.
  text = text.replace(/[–—\-]+/g, ' ');
  text = text.replace(/[^\p{L}\p{N}\s']/gu, ' ');
  text = text.replace(/'/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalize(input);
  if (normalized === '') return [];
  return normalized.split(' ').map((token) => NUMBER_WORDS[token] ?? token);
}

/**
 * Filler matching works on normalised token windows so multi-word phrases
 * ("you know") are detected the same way as single tokens ("um").
 */
export function buildFillerMatcher(phrases: readonly string[]): (tokens: readonly string[], at: number) => number {
  const normalized = phrases
    .map((phrase) => tokenize(phrase))
    .filter((tokens) => tokens.length > 0)
    // Longest first so "you know" wins over a bare "know" entry.
    .sort((a, b) => b.length - a.length);

  return (tokens, at) => {
    for (const phrase of normalized) {
      if (at + phrase.length > tokens.length) continue;
      let matched = true;
      for (let i = 0; i < phrase.length; i += 1) {
        if (tokens[at + i] !== phrase[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return phrase.length;
    }
    return 0;
  };
}
