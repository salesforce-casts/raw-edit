const PUNCTUATION = /[^\p{L}\p{N}\s']/gu;
const FILLERS = ["um", "uh", "uhm", "err", "er", "ah", "you know"];
const EXCLUDED_FILLERS = new Set(["like", "i mean", "i'mean"]);

const CONTRACTIONS: Record<string, string[]> = {
  "i'll": ["i", "will"],
  "i'm": ["i", "am"],
  "i've": ["i", "have"],
  "i'd": ["i", "would"],
  "you're": ["you", "are"],
  "you'll": ["you", "will"],
  "you've": ["you", "have"],
  "we're": ["we", "are"],
  "we'll": ["we", "will"],
  "they're": ["they", "are"],
  "that's": ["that", "is"],
  "it's": ["it", "is"],
  "don't": ["do", "not"],
  "doesn't": ["does", "not"],
  "can't": ["can", "not"],
  "won't": ["will", "not"],
  "let's": ["let", "us"],
};

export function normalizeText(input: string): string {
  return input.toLowerCase().replace(PUNCTUATION, " ").replace(/\s+/g, " ").trim();
}

export function expandContractions(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    const replacement = CONTRACTIONS[token];
    if (replacement) expanded.push(...replacement);
    else expanded.push(token);
  }
  return expanded;
}

export function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es") && !token.endsWith("sses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return expandContractions(normalized.split(" ")).map(stemToken);
}

export function isFillerToken(token: string): boolean {
  return FILLERS.includes(token) && !EXCLUDED_FILLERS.has(token);
}

export function stripFillers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "you" && tokens[i + 1] === "know") {
      i += 1;
      continue;
    }
    if (!isFillerToken(tokens[i])) out.push(tokens[i]);
  }
  return out;
}

export function contentTokens(input: string): string[] {
  return tokenize(input).filter((token) => !isFillerToken(token) && token.length > 1);
}

export function fillerTokens(input: string): string[] {
  const text = ` ${normalizeText(input)} `;
  const found: string[] = [];
  for (const filler of FILLERS) {
    if (EXCLUDED_FILLERS.has(filler)) continue;
    const needle = ` ${filler} `;
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(needle, from);
      if (index === -1) break;
      found.push(filler);
      from = index + needle.length - 1;
    }
  }
  return found;
}

export function countFillers(text: string): number {
  return fillerTokens(text).length;
}

function levenshteinAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const diff = Math.abs(a.length - b.length);
  if (diff > 1) return false;
  if (a.length === b.length) {
    let mismatches = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) mismatches += 1;
      if (mismatches > 1) return false;
    }
    return true;
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

export function fuzzyTokenEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (stemToken(a) === stemToken(b)) return true;
  return a.length >= 3 && b.length >= 3 && levenshteinAtMostOne(a, b);
}

export function longestCommonPrefix(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && fuzzyTokenEqual(a[index], b[index])) index += 1;
  return index;
}

export function isFuzzyPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return shorter.length > 0 && shorter.length <= longer.length && longestCommonPrefix(shorter, longer) === shorter.length;
  return longestCommonPrefix(shorter, longer) === shorter.length;
}

export function bigrams(tokens: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < tokens.length - 1; i += 1) pairs.push([tokens[i], tokens[i + 1]]);
  return pairs;
}

export function diceBigram(a: string[], b: string[]): number {
  const left = bigrams(a).map(([x, y]) => `${x} ${y}`);
  const right = bigrams(b).map(([x, y]) => `${x} ${y}`);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  let intersection = 0;
  for (const gram of left) {
    if (rightSet.has(gram)) {
      intersection += 1;
      rightSet.delete(gram);
    }
  }
  return (2 * intersection) / (left.length + right.length);
}

export function containment(shorter: string[], longer: string[]): number {
  if (shorter.length === 0) return 1;
  const pool = [...longer];
  let found = 0;
  for (const token of shorter) {
    const index = pool.findIndex((candidate) => fuzzyTokenEqual(candidate, token));
    if (index >= 0) {
      found += 1;
      pool.splice(index, 1);
    }
  }
  return found / shorter.length;
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

export function endsLikeSentence(text: string): boolean {
  return /[.!?]"?$/.test(text.trim());
}

export function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/(\.\.\.|…)$/.test(trimmed)) return true;
  if (/[,;:\-–—]$/.test(trimmed)) return true;
  const tokens = tokenize(trimmed);
  return tokens.length > 0 && tokens.length < 7 && !/[.!?]$/.test(trimmed);
}

export function countInternalPauses(words: Array<{ startMs: number; endMs: number }>, pauseMs = 800): number {
  let count = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].startMs - words[i - 1].endMs >= pauseMs) count += 1;
  }
  return count;
}
