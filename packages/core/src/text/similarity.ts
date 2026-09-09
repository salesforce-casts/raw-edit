/**
 * Token- and string-level similarity used by retake detection.
 *
 * The tolerance here exists because ASR output is noisy: "fifty" vs "50",
 * "ideas" vs "idea", "I'll" vs "I will". Two takes of one sentence rarely
 * transcribe identically, so exact matching would miss most real retakes.
 */

/** Bounded Levenshtein: returns `max + 1` as soon as it is certain the distance exceeds `max`. */
export function levenshteinAtMost(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  let previous = new Array<number>(shorter.length + 1);
  let current = new Array<number>(shorter.length + 1);
  for (let i = 0; i <= shorter.length; i += 1) previous[i] = i;

  for (let j = 1; j <= longer.length; j += 1) {
    current[0] = j;
    let rowMin = current[0]!;
    for (let i = 1; i <= shorter.length; i += 1) {
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      const value = Math.min(current[i - 1]! + 1, previous[i]! + 1, previous[i - 1]! + cost);
      current[i] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[shorter.length]!;
}

/**
 * Two tokens are "the same word" when they are equal, within one edit of each other
 * (for words long enough that one edit is not a different word), or when one is a
 * prefix of the other by at least four characters (plural/tense noise).
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const minLength = Math.min(a.length, b.length);
  if (minLength < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) {
    return minLength >= 4 && Math.abs(a.length - b.length) <= 3;
  }
  const allowance = minLength >= 8 ? 2 : 1;
  return levenshteinAtMost(a, b, allowance) <= allowance;
}

/** Longest common prefix length under fuzzy token matching. */
export function longestCommonPrefix(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit && tokensMatch(a[count]!, b[count]!)) count += 1;
  return count;
}

/** True when `a` is a fuzzy prefix of `b` and strictly shorter. */
export function isFuzzyPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || a.length >= b.length) return false;
  return longestCommonPrefix(a, b) === a.length;
}

function bigrams(tokens: readonly string[]): string[] {
  if (tokens.length < 2) return tokens.length === 1 ? [tokens[0]!] : [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/** Dice coefficient over token bigrams — sensitive to word order, unlike Jaccard. */
export function bigramDice(a: readonly string[], b: readonly string[]): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 && right.length === 0) return a.length === 0 && b.length === 0 ? 1 : 0;
  if (left.length === 0 || right.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let intersection = 0;
  for (const gram of right) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      counts.set(gram, remaining - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (left.length + right.length);
}

/**
 * Fraction of the shorter token list that appears (fuzzily, in order-insensitive
 * fashion) in the longer one. An aborted take is close to a subset of the good one.
 */
export function containment(a: readonly string[], b: readonly string[]): number {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length === 0) return 0;

  const used = new Array<boolean>(longer.length).fill(false);
  let found = 0;
  for (const token of shorter) {
    for (let i = 0; i < longer.length; i += 1) {
      if (!used[i] && tokensMatch(token, longer[i]!)) {
        used[i] = true;
        found += 1;
        break;
      }
    }
  }
  return found / shorter.length;
}
