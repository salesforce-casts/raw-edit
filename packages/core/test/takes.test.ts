import { describe, expect, it } from 'vitest';
import { segmentWords } from '../src/analysis/segments.js';
import { detectIntraSegmentRestarts, detectRetakes, scorePair } from '../src/analysis/takes.js';
import { tokenize } from '../src/text/normalize.js';
import { script, utterance } from './helpers.js';

const DETECT_DEFAULTS = {
  similarityThreshold: 0.72,
  minOpeningTokens: 3,
  lookaheadSegments: 6,
  lookaheadSeconds: 60,
};

describe('scorePair', () => {
  it('scores an aborted opening against its completed version very highly', () => {
    const a = tokenize("Today I'll show you");
    const b = tokenize("Today I'll show you three business ideas that you can start under fifty thousand rupees.");
    const pair = scorePair(a, b);
    expect(pair.isPrefixOf).toBe(true);
    expect(pair.lcp).toBeGreaterThanOrEqual(5);
    expect(pair.score).toBeGreaterThan(0.9);
  });

  it('does not link two unrelated sentences', () => {
    const a = tokenize('The second idea is a home bakery run from your kitchen.');
    const b = tokenize('Let me know in the comments which one you would pick.');
    expect(scorePair(a, b).score).toBeLessThan(0.4);
  });

  it('tolerates transcription noise in a repeated line', () => {
    const a = tokenize("Today I'll show you three business idea");
    const b = tokenize('Today I will show you three business ideas');
    const pair = scorePair(a, b);
    expect(pair.lcp).toBeGreaterThanOrEqual(6);
    expect(pair.score).toBeGreaterThan(0.85);
  });

  it('does not treat a shared two-word opener as a retake signal', () => {
    const a = tokenize('So the first thing you need is a camera.');
    const b = tokenize('So the best part is that it costs nothing.');
    expect(scorePair(a, b).lcp).toBeLessThan(3);
  });
});

describe('detectRetakes', () => {
  it('keeps the final complete take from the brief’s worked example', () => {
    const words = script(
      utterance(0.0, "Today I'll show you three business ideas"),
      utterance(5.9, "Today I'll show you"),
      utterance(
        9.2,
        "Today I'll show you three business ideas that you can start under fifty thousand rupees.",
      ),
    );
    const segments = segmentWords(words);
    expect(segments).toHaveLength(3);

    const groups = detectRetakes({ segments, ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(1);

    const group = groups[0]!;
    expect(group.members).toHaveLength(3);
    expect(group.chosenSegmentIndex).toBe(2);
    expect(group.members[0]!.isChosen).toBe(false);
    expect(group.members[1]!.isChosen).toBe(false);
    expect(group.members[2]!.isChosen).toBe(true);
    expect(group.confidence).toBeGreaterThan(0.8);
  });

  it('marks aborted attempts as prefixes of the surviving take', () => {
    const words = script(
      utterance(0.0, 'The first business idea'),
      utterance(3.0, 'The first business idea is a print on demand store.'),
    );
    const groups = detectRetakes({ segments: segmentWords(words), ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members[0]!.breakdown.isPrefixOfLater).toBe(true);
    expect(groups[0]!.members[1]!.isChosen).toBe(true);
  });

  it('prefers the later take when two attempts are otherwise equivalent', () => {
    const words = script(
      utterance(0.0, 'Subscribe to the channel for more videos like this.'),
      utterance(5.0, 'Subscribe to the channel for more videos like this.'),
    );
    const groups = detectRetakes({ segments: segmentWords(words), ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.chosenSegmentIndex).toBe(1);
  });

  it('prefers the take without filler words', () => {
    const words = script(
      utterance(0.0, 'And the um third idea uh is a small um catering service today.'),
      utterance(8.0, 'And the third idea is a small catering service today.'),
    );
    const segments = segmentWords(words);
    const groups = detectRetakes({ segments, ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.chosenSegmentIndex).toBe(1);
    expect(segments[0]!.fillerCount).toBeGreaterThan(0);
  });

  it('leaves genuinely different sentences alone', () => {
    const words = script(
      utterance(0.0, 'The first idea is a print on demand store.'),
      utterance(4.0, 'The second one is a weekend photography service.'),
      utterance(8.0, 'And finally you could run a home bakery.'),
    );
    const groups = detectRetakes({ segments: segmentWords(words), ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(0);
  });

  it('does not group two attempts separated by more than the lookahead window', () => {
    const words = script(
      utterance(0.0, "Today I'll show you three business ideas"),
      utterance(200.0, "Today I'll show you three business ideas that work."),
    );
    const groups = detectRetakes({
      segments: segmentWords(words),
      ...DETECT_DEFAULTS,
      lookaheadSeconds: 60,
    });
    expect(groups).toHaveLength(0);
  });

  it('produces stable output for the same input', () => {
    const words = script(
      utterance(0.0, "Today I'll show you three business ideas"),
      utterance(5.9, "Today I'll show you"),
      utterance(9.2, "Today I'll show you three business ideas that you can start today."),
    );
    const segments = segmentWords(words);
    const first = detectRetakes({ segments, ...DETECT_DEFAULTS });
    const second = detectRetakes({ segments, ...DETECT_DEFAULTS });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('handles four attempts and keeps the most complete one', () => {
    const words = script(
      utterance(0.0, 'So the biggest mistake'),
      utterance(2.5, 'So the biggest mistake creators'),
      utterance(5.0, 'So the biggest mistake creators make is'),
      utterance(8.0, 'So the biggest mistake creators make is filming without a plan.'),
    );
    const groups = detectRetakes({ segments: segmentWords(words), ...DETECT_DEFAULTS });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(4);
    expect(groups[0]!.chosenSegmentIndex).toBe(3);
  });
});

describe('detectIntraSegmentRestarts', () => {
  it('finds a restart that happened without a pause', () => {
    const words = utterance(0.0, "Today I'll show you Today I'll show you three business ideas that work", {
      wordsPerSecond: 4,
    });
    const segment = segmentWords(words)[0]!;
    const restart = detectIntraSegmentRestarts(segment);
    expect(restart).not.toBeNull();
    expect(restart!.start).toBe(segment.start);
    // The cut ends where the second "Today" begins — word index 4.
    expect(words[4]!.text).toBe('Today');
    expect(restart!.end).toBeCloseTo(words[4]!.start, 3);
    expect(restart!.keptFromWordIndex).toBe(4);
  });

  it('ignores rhetorical repetition where the continuation is not longer', () => {
    const words = utterance(0.0, 'This is big this is big', { wordsPerSecond: 4 });
    const segment = segmentWords(words)[0]!;
    expect(detectIntraSegmentRestarts(segment)).toBeNull();
  });

  it('returns null for a clean sentence', () => {
    const words = utterance(0.0, 'The second idea is a weekend photography service for local businesses.');
    const segment = segmentWords(words)[0]!;
    expect(detectIntraSegmentRestarts(segment)).toBeNull();
  });
});
