const PUNCTUATION = /[^\p{L}\p{N}\s']/gu;
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "is",
  "am",
  "are",
  "i",
  "i'm",
  "im",
  "you",
  "we",
]);

export function normalizeText(input: string): string {
  return input.toLowerCase().replace(PUNCTUATION, " ").replace(/\s+/g, " ").trim();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  return normalized ? normalized.split(" ") : [];
}

export function contentTokens(input: string): string[] {
  return tokenize(input).filter((token) => !STOP_WORDS.has(token) && token.length > 1);
}

export function longestCommonPrefix(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length] / max;
}

export function prefixSimilarity(a: string[], b: string[]): number {
  const prefix = longestCommonPrefix(a, b);
  const min = Math.min(a.length, b.length);
  return min === 0 ? 0 : prefix / min;
}

export function ngramSet(tokens: string[], n = 3): Set<string> {
  const grams = new Set<string>();
  const joined = tokens.join(" ");
  if (joined.length < n) {
    if (joined) grams.add(joined);
    return grams;
  }
  for (let i = 0; i <= joined.length - n; i += 1) {
    grams.add(joined.slice(i, i + n));
  }
  return grams;
}

export function semanticSimilarity(a: string[], b: string[]): number {
  const left = ngramSet(a);
  const right = ngramSet(b);
  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/(\.\.\.|…)$/.test(trimmed)) return true;
  if (/[,;:\-–—]$/.test(trimmed)) return true;
  const tokens = tokenize(trimmed);
  return tokens.length > 0 && tokens.length < 7 && !/[.!?]$/.test(trimmed);
}

export function endsLikeSentence(text: string): boolean {
  return /[.!?]"?$/.test(text.trim());
}

export function countFillers(text: string): number {
  const normalized = ` ${normalizeText(text)} `;
  const fillers = [" um ", " uh ", " uhm ", " err ", " er ", " ah ", " you know ", " i mean "];
  let count = 0;
  for (const filler of fillers) {
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(filler, from);
      if (index === -1) break;
      count += 1;
      from = index + filler.length;
    }
  }
  return count;
}
