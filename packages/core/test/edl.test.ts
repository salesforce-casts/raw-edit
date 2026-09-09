import { describe, expect, it } from 'vitest';
import { segmentWords } from '../src/analysis/segments.js';
import { applyEdlOverrides, buildEdl, dedupeDecisions, summarizeEdl } from '../src/analysis/edl.js';
import { applyAdvisor, HeuristicEditAdvisor } from '../src/analysis/edl.js';
import type { EditAdvisor, TakeGroupForReview } from '../src/types/takes.js';
import type { EditDecision } from '../src/types/edl.js';
import { script, utterance } from './helpers.js';

/** The brief's worked example, end to end. */
function workedExample() {
  const words = script(
    utterance(0.0, "Today I'll show you three business ideas"),
    utterance(5.9, "Today I'll show you"),
    utterance(9.2, "Today I'll show you three business ideas that you can start under fifty thousand rupees."),
    utterance(22.0, 'The first one is a print on demand store.'),
  );
  const segments = segmentWords(words);
  const duration = 30;
  const acousticSilence = [
    { start: 2.7, end: 5.9 },
    { start: 7.6, end: 9.2 },
    { start: 18.5, end: 22.0 },
    { start: 25.5, end: 30 },
  ];
  return { segments, duration, acousticSilence };
}

describe('buildEdl', () => {
  it('removes the two failed takes and keeps the complete one', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const result = buildEdl({ segments, acousticSilence, duration });

    const retakes = result.decisions.filter((decision) => decision.kind === 'retake');
    expect(retakes.length).toBeGreaterThanOrEqual(2);

    const kept = segments[2]!;
    // Nothing inside the surviving take is proposed for removal.
    for (const decision of result.decisions) {
      const overlapsKeeper = decision.startTime < kept.end && decision.endTime > kept.start;
      expect(overlapsKeeper).toBe(false);
    }
  });

  it('gives every automatic decision the four required fields', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const result = buildEdl({ segments, acousticSilence, duration });
    expect(result.decisions.length).toBeGreaterThan(0);

    for (const decision of result.decisions) {
      expect(typeof decision.startTime).toBe('number');
      expect(typeof decision.endTime).toBe('number');
      expect(decision.endTime).toBeGreaterThan(decision.startTime);
      expect(['keep', 'remove']).toContain(decision.decision);
      expect(decision.reason.length).toBeGreaterThan(10);
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('produces a reason shaped like the brief’s example', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const result = buildEdl({ segments, acousticSilence, duration });
    const retake = result.decisions.find((decision) => decision.kind === 'retake');
    expect(retake!.reason).toMatch(/retake|version|attempt/i);
    expect(retake!.reason).toMatch(/\d+:\d\d/);
  });

  it('reports original, proposed and removed durations', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const { summary } = buildEdl({ segments, acousticSilence, duration });
    expect(summary.originalDuration).toBe(30);
    expect(summary.removedDuration).toBeGreaterThan(0);
    expect(summary.proposedDuration).toBeCloseTo(30 - summary.removedDuration, 3);
    expect(summary.removedByRetake).toBeGreaterThan(0);
  });

  it('never emits overlapping removals', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const { decisions } = buildEdl({ segments, acousticSilence, duration });
    const removals = decisions
      .filter((decision) => decision.decision === 'remove')
      .sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < removals.length; i += 1) {
      expect(removals[i]!.startTime).toBeGreaterThanOrEqual(removals[i - 1]!.endTime - 1e-6);
    }
  });

  it('leaves filler words alone by default', () => {
    const words = utterance(0, 'So um this is uh the first idea you know.');
    const result = buildEdl({ segments: segmentWords(words), acousticSilence: [], duration: 6 });
    expect(result.decisions.filter((decision) => decision.kind === 'filler')).toHaveLength(0);
  });

  it('removes filler words only when the setting is turned on', () => {
    const words = utterance(0, 'So um this is uh the first idea.');
    const result = buildEdl({
      segments: segmentWords(words),
      acousticSilence: [],
      duration: 6,
      settings: { removeFillerWords: true },
    });
    const fillers = result.decisions.filter((decision) => decision.kind === 'filler');
    expect(fillers.length).toBe(2);
    expect(fillers[0]!.reason).toContain('Filler word');
  });

  it('honours a raised silence threshold', () => {
    const segments = segmentWords(
      script(utterance(0, 'First sentence here.'), utterance(3.0, 'Second sentence here.')),
    );
    const acoustic = [{ start: 1.1, end: 3.0 }];
    const loose = buildEdl({ segments, acousticSilence: acoustic, duration: 6, settings: { silenceThresholdSeconds: 3 } });
    const tight = buildEdl({ segments, acousticSilence: acoustic, duration: 6, settings: { silenceThresholdSeconds: 0.5 } });
    expect(loose.summary.removedBySilence).toBeLessThan(tight.summary.removedBySilence);
  });

  it('can be turned off entirely', () => {
    const { segments, duration, acousticSilence } = workedExample();
    const result = buildEdl({
      segments,
      acousticSilence,
      duration,
      settings: { detectRetakes: false, removeSilence: false },
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.summary.proposedDuration).toBe(30);
  });
});

describe('dedupeDecisions', () => {
  it('lets a retake win over an overlapping silence cut', () => {
    const decisions: EditDecision[] = [
      { id: 'a', startTime: 5, endTime: 10, decision: 'remove', kind: 'silence', reason: 'pause', confidence: 0.8, source: 'auto' },
      { id: 'b', startTime: 4, endTime: 8, decision: 'remove', kind: 'retake', reason: 'retake', confidence: 0.9, source: 'auto' },
    ];
    const result = dedupeDecisions(decisions, 20);
    expect(result).toHaveLength(2);
    const retake = result.find((decision) => decision.kind === 'retake')!;
    const silence = result.find((decision) => decision.kind === 'silence')!;
    expect(retake.startTime).toBe(4);
    expect(retake.endTime).toBe(8);
    expect(silence.startTime).toBe(8);
    expect(silence.endTime).toBe(10);
  });

  it('drops a decision that is entirely covered by a higher-priority one', () => {
    const decisions: EditDecision[] = [
      { id: 'a', startTime: 5, endTime: 6, decision: 'remove', kind: 'filler', reason: 'um', confidence: 0.7, source: 'auto' },
      { id: 'b', startTime: 4, endTime: 8, decision: 'remove', kind: 'retake', reason: 'retake', confidence: 0.9, source: 'auto' },
    ];
    expect(dedupeDecisions(decisions, 20)).toHaveLength(1);
  });

  it('clamps decisions to the media duration', () => {
    const decisions: EditDecision[] = [
      { id: 'a', startTime: -2, endTime: 25, decision: 'remove', kind: 'manual', reason: 'x', confidence: 1, source: 'user' },
    ];
    const [only] = dedupeDecisions(decisions, 20);
    expect(only!.startTime).toBe(0);
    expect(only!.endTime).toBe(20);
  });
});

describe('summarizeEdl', () => {
  it('counts overlapping removals once', () => {
    const decisions: EditDecision[] = [
      { id: 'a', startTime: 0, endTime: 5, decision: 'remove', kind: 'silence', reason: 'x', confidence: 1, source: 'auto' },
      { id: 'b', startTime: 3, endTime: 8, decision: 'remove', kind: 'retake', reason: 'y', confidence: 1, source: 'auto' },
    ];
    const summary = summarizeEdl(decisions, 20);
    expect(summary.removedDuration).toBe(8);
    expect(summary.proposedDuration).toBe(12);
  });
});

describe('applyAdvisor', () => {
  const ambiguous = () =>
    buildEdl({
      segments: segmentWords(
        script(
          utterance(0, 'Subscribe to the channel for more videos.'),
          utterance(5, 'Subscribe to the channel for more videos.'),
        ),
      ),
      acousticSilence: [],
      duration: 12,
    });

  it('keeps the deterministic pick with the default advisor', async () => {
    const before = ambiguous();
    const after = await applyAdvisor(before, new HeuristicEditAdvisor());
    expect(after.takes[0]!.chosenSegmentIndex).toBe(before.takes[0]!.chosenSegmentIndex);
  });

  it('lets an advisor change which member is kept', async () => {
    const advisor: EditAdvisor = {
      name: 'test',
      async arbitrate(groups: TakeGroupForReview[]) {
        return groups.map((group) => ({
          groupId: group.groupId,
          chosenIndex: 0,
          reason: 'The first take reads better.',
          confidence: 0.8,
        }));
      },
    };
    const before = ambiguous();
    expect(before.takes[0]!.chosenSegmentIndex).toBe(1);
    const after = await applyAdvisor(before, advisor);
    expect(after.takes[0]!.chosenSegmentIndex).toBe(0);
    expect(after.decisions.some((d) => d.kind === 'retake' && d.segmentIndex === 1)).toBe(true);
  });

  it('discards a verdict that names a candidate that does not exist', async () => {
    const advisor: EditAdvisor = {
      name: 'rogue',
      async arbitrate(groups) {
        return groups.map((group) => ({ groupId: group.groupId, chosenIndex: 99, reason: 'nope', confidence: 1 }));
      },
    };
    const before = ambiguous();
    const after = await applyAdvisor(before, advisor);
    expect(after.takes[0]!.chosenSegmentIndex).toBe(before.takes[0]!.chosenSegmentIndex);
  });

  it('falls back to the deterministic pick when the advisor throws', async () => {
    const advisor: EditAdvisor = {
      name: 'broken',
      async arbitrate() {
        throw new Error('provider down');
      },
    };
    const before = ambiguous();
    const after = await applyAdvisor(before, advisor);
    expect(after.decisions).toEqual(before.decisions);
  });

  it('cannot introduce a cut outside an already-detected group', async () => {
    const advisor: EditAdvisor = {
      name: 'greedy',
      async arbitrate(groups) {
        return groups.map((group) => ({ groupId: group.groupId, chosenIndex: 0, reason: '', confidence: 1 }));
      },
    };
    const before = ambiguous();
    const after = await applyAdvisor(before, advisor);
    const groupSpan = { start: before.takes[0]!.members[0]!.start, end: before.takes[0]!.members.at(-1)!.end };
    for (const decision of after.decisions.filter((d) => d.kind === 'retake')) {
      expect(decision.startTime).toBeGreaterThanOrEqual(groupSpan.start - 1e-6);
      expect(decision.endTime).toBeLessThanOrEqual(groupSpan.end + 1e-6);
    }
  });
});

describe('applyEdlOverrides', () => {
  const base: EditDecision[] = [
    { id: 'a', startTime: 1, endTime: 2, decision: 'remove', kind: 'silence', reason: 'pause', confidence: 0.8, source: 'auto' },
    { id: 'b', startTime: 5, endTime: 7, decision: 'remove', kind: 'retake', reason: 'retake', confidence: 0.9, source: 'auto' },
  ];

  it('restores a removed segment', () => {
    const result = applyEdlOverrides(base, [{ type: 'restore', decisionId: 'a' }], 20);
    expect(result.find((decision) => decision.id === 'a')).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  it('adds a manual removal', () => {
    const result = applyEdlOverrides(base, [{ type: 'remove', startTime: 10, endTime: 12 }], 20);
    const manual = result.find((decision) => decision.kind === 'manual');
    expect(manual).toBeDefined();
    expect(manual!.source).toBe('user');
    expect(manual!.confidence).toBe(1);
  });

  it('adjusts a cut boundary', () => {
    const result = applyEdlOverrides(base, [{ type: 'adjust', decisionId: 'b', startTime: 5.5, endTime: 6.5 }], 20);
    const adjusted = result.find((decision) => decision.id === 'b')!;
    expect(adjusted.startTime).toBe(5.5);
    expect(adjusted.endTime).toBe(6.5);
    expect(adjusted.source).toBe('user');
  });

  it('ignores an override that names a decision that is not there', () => {
    const result = applyEdlOverrides(base, [{ type: 'restore', decisionId: 'zzz' }], 20);
    expect(result).toHaveLength(2);
  });
});
