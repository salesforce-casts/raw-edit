import type { DecisionKind } from '@rawedit/core';

/**
 * One colour vocabulary shared by the transcript and the timeline.
 *
 * The two views describe the same cuts, so they must agree at a glance: an orange
 * band on the timeline is the same silence removal as the orange strike-through in
 * the transcript.
 */
export const CUT_STYLES: Record<
  DecisionKind,
  { label: string; text: string; bg: string; border: string; bar: string; dot: string }
> = {
  silence: {
    label: 'Silence',
    text: 'text-cut-silence',
    bg: 'bg-cut-silence-soft',
    border: 'border-cut-silence/40',
    bar: 'bg-cut-silence',
    dot: 'bg-cut-silence',
  },
  retake: {
    label: 'Retake',
    text: 'text-cut-retake',
    bg: 'bg-cut-retake-soft',
    border: 'border-cut-retake/40',
    bar: 'bg-cut-retake',
    dot: 'bg-cut-retake',
  },
  filler: {
    label: 'Filler',
    text: 'text-cut-filler',
    bg: 'bg-cut-filler-soft',
    border: 'border-cut-filler/40',
    bar: 'bg-cut-filler',
    dot: 'bg-cut-filler',
  },
  manual: {
    label: 'Your cut',
    text: 'text-cut-manual',
    bg: 'bg-cut-manual-soft',
    border: 'border-cut-manual/40',
    bar: 'bg-cut-manual',
    dot: 'bg-cut-manual',
  },
};

export const CUT_KINDS: DecisionKind[] = ['retake', 'silence', 'filler', 'manual'];
