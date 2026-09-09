import { describe, expect, it } from 'vitest';
import { segmentWords } from '../src/analysis/segments.js';
import { detectSilenceRemovals, parseSilenceDetect } from '../src/analysis/silence.js';
import { script, utterance } from './helpers.js';

describe('parseSilenceDetect', () => {
  it('pairs silence_start with silence_end', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 4.212',
      '[silencedetect @ 0x1] silence_end: 6.804 | silence_duration: 2.592',
      '[silencedetect @ 0x1] silence_start: 11.02',
      '[silencedetect @ 0x1] silence_end: 12.5 | silence_duration: 1.48',
    ].join('\n');
    expect(parseSilenceDetect(stderr, 30)).toEqual([
      { start: 4.212, end: 6.804 },
      { start: 11.02, end: 12.5 },
    ]);
  });

  it('closes a trailing silence that runs to the end of the file', () => {
    const stderr = '[silencedetect @ 0x1] silence_start: 25.0';
    expect(parseSilenceDetect(stderr, 30)).toEqual([{ start: 25, end: 30 }]);
  });

  it('clamps a negative silence_start to zero', () => {
    const stderr = 'silence_start: -0.008\nsilence_end: 2.0 | silence_duration: 2.008';
    expect(parseSilenceDetect(stderr, 10)).toEqual([{ start: 0, end: 2 }]);
  });

  it('returns nothing for output with no silence', () => {
    expect(parseSilenceDetect('frame= 100 fps=0.0', 10)).toEqual([]);
  });
});

describe('detectSilenceRemovals', () => {
  const speech = script(
    utterance(0.5, 'The first idea is a print on demand store.'),
    utterance(8.0, 'The second one is a weekend photography service.'),
  );
  const segments = segmentWords(speech);
  const duration = 14;

  it('removes a long gap between two utterances, keeping padding on both sides', () => {
    const acoustic = [{ start: 3.9, end: 8.0 }, { start: 11.5, end: 14 }];
    const removals = detectSilenceRemovals(segments, acoustic, duration, {
      thresholdSeconds: 1,
      padPreMs: 160,
      padPostMs: 200,
    });

    const middle = removals.find((removal) => removal.start > 1 && removal.end < 8.5);
    expect(middle).toBeDefined();
    // Starts 200ms after the last word, ends 160ms before the next one.
    expect(middle!.start).toBeCloseTo(segments[0]!.end + 0.2, 3);
    expect(middle!.end).toBeCloseTo(segments[1]!.start - 0.16, 3);
  });

  it('leaves short natural pauses alone', () => {
    const tight = segmentWords(
      script(utterance(0.0, 'First point here.'), utterance(1.6, 'Second point here.')),
    );
    const removals = detectSilenceRemovals(tight, [{ start: 0.9, end: 1.6 }], 4, {
      thresholdSeconds: 1,
    });
    expect(removals.filter((r) => r.start > 0.5 && r.end < 2)).toHaveLength(0);
  });

  it('refuses to cut a gap the audio says is not silent', () => {
    // The transcript has a gap, but silencedetect found nothing there — a breath, a
    // sigh or off-mic speech. Cutting it would be wrong.
    const removals = detectSilenceRemovals(segments, [{ start: 12.0, end: 14 }], duration, {
      thresholdSeconds: 1,
    });
    expect(removals.find((r) => r.start > 3 && r.end < 8)).toBeUndefined();
  });

  it('trims dead air at the head and the tail', () => {
    const removals = detectSilenceRemovals(segments, [{ start: 0, end: 0.5 }, { start: 11.5, end: 14 }], duration, {
      thresholdSeconds: 0.4,
    });
    expect(removals.some((r) => r.start === 0)).toBe(true);
    expect(removals.some((r) => r.end === duration)).toBe(true);
  });

  it('applies no acoustic gate when silencedetect produced nothing at all', () => {
    // Silent input to silencedetect (no audio track, or an unusual noise floor):
    // fall back to the transcript rather than refusing to edit.
    const removals = detectSilenceRemovals(segments, [], duration, { thresholdSeconds: 1 });
    expect(removals.length).toBeGreaterThan(0);
  });
});
