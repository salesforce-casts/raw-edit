import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  applyEdlOverrides,
  buildEdl,
  DEFAULT_EDIT_SETTINGS,
  segmentWords,
  summarizeEdl,
  type EdlOverride,
  type EditSettings,
} from '@rawedit/core';
import {
  editSettings,
  getActiveEdl,
  getTranscriptWithSegments,
  replaceActiveEdl,
  requireVideoForUser,
} from '@rawedit/db';
import { db } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const OverrideSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('restore'), decisionId: z.string().min(1) }),
  z.object({
    type: z.literal('remove'),
    startTime: z.number().nonnegative(),
    endTime: z.number().positive(),
    reason: z.string().max(300).optional(),
    segmentIndex: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('adjust'),
    decisionId: z.string().min(1),
    startTime: z.number().nonnegative(),
    endTime: z.number().positive(),
  }),
  z.object({
    type: z.literal('keepTake'),
    takeId: z.string().min(1),
    segmentIndex: z.number().int().nonnegative(),
  }),
]);

const SettingsSchema = z.object({
  silenceThresholdSeconds: z.number().min(0.1).max(10).optional(),
  padPreMs: z.number().int().min(0).max(2000).optional(),
  padPostMs: z.number().int().min(0).max(2000).optional(),
  removeFillerWords: z.boolean().optional(),
  detectRetakes: z.boolean().optional(),
  removeSilence: z.boolean().optional(),
  minSegmentSeconds: z.number().min(0).max(5).optional(),
});

const PatchSchema = z.object({
  /** The full override stack, replayed over the automatic proposal. */
  overrides: z.array(OverrideSchema).max(1000).optional(),
  /** Changing a setting re-derives the proposal from the stored transcript. */
  settings: SettingsSchema.optional(),
  /** Drop every user edit and go back to the automatic proposal. */
  reset: z.boolean().optional(),
});

/**
 * PATCH /api/videos/:id/edl — apply the review screen's edits.
 *
 * The client sends its whole override stack rather than individual mutations, which
 * makes undo/redo trivial on the client and idempotent on the server: replaying the
 * same stack always produces the same EDL.
 *
 * Changing a *setting* re-runs detection from the stored transcript. That costs
 * nothing — no re-transcription, no re-download — because the analysis layer is
 * deterministic and the transcript is already in Postgres.
 */
export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  if (row.status === 'UPLOADING' || row.status === 'UPLOADED') {
    return jsonError('This video has not been analysed yet.', 409, 'NOT_READY');
  }

  const parsed = PatchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid edit.', 400, 'INVALID_REQUEST');
  }
  const { overrides = [], settings: settingsPatch, reset } = parsed.data;
  const duration = row.duration ?? 0;

  const currentRows = await database
    .select()
    .from(editSettings)
    .where(eq(editSettings.videoId, id))
    .limit(1);
  const current = currentRows[0];

  const settings: EditSettings = {
    ...DEFAULT_EDIT_SETTINGS,
    ...(current
      ? {
          silenceThresholdSeconds: current.silenceThresholdSeconds,
          padPreMs: current.padPreMs,
          padPostMs: current.padPostMs,
          removeFillerWords: current.removeFillerWords,
          detectRetakes: current.detectRetakes,
          removeSilence: current.removeSilence,
          minSegmentSeconds: current.minSegmentSeconds,
          mergeGapMs: current.mergeGapMs,
          retakeSimilarityThreshold: current.retakeSimilarityThreshold,
          retakeMinOpeningTokens: current.retakeMinOpeningTokens,
          retakeLookaheadSegments: current.retakeLookaheadSegments,
          retakeLookaheadSeconds: current.retakeLookaheadSeconds,
        }
      : {}),
    ...settingsPatch,
  };

  const settingsChanged = Boolean(settingsPatch) || Boolean(reset);
  let baseDecisions = await getActiveEdl(database, id);

  if (settingsChanged) {
    // Re-derive from the transcript we already hold.
    const transcriptData = await getTranscriptWithSegments(database, id);
    if (!transcriptData) {
      return jsonError('This video has no transcript to re-analyse.', 409, 'NO_TRANSCRIPT');
    }

    const words = transcriptData.segments.flatMap((segment) =>
      segment.words.map((word) => ({
        text: word.text,
        start: word.startTime,
        end: word.endTime,
        confidence: word.confidence ?? 1,
      })),
    );

    // Silence was established acoustically at analysis time. Re-deriving it from the
    // transcript's gaps would be a different (and worse) signal, so the previously
    // accepted silence removals are reused as the acoustic evidence.
    const previousSilence = baseDecisions
      .filter((decision) => decision.kind === 'silence')
      .map((decision) => ({ start: decision.startTime, end: decision.endTime }));

    const rebuilt = buildEdl({
      segments: segmentWords(words),
      acousticSilence: previousSilence,
      duration,
      settings,
      idPrefix: `ed_${id.slice(-6)}`,
    });
    baseDecisions = rebuilt.decisions;
  }

  const finalDecisions = reset
    ? baseDecisions
    : applyEdlOverrides(baseDecisions, overrides as EdlOverride[], duration);

  const version = await replaceActiveEdl(database, id, finalDecisions);

  await database
    .update(editSettings)
    .set({
      silenceThresholdSeconds: settings.silenceThresholdSeconds,
      padPreMs: settings.padPreMs,
      padPostMs: settings.padPostMs,
      removeFillerWords: settings.removeFillerWords,
      detectRetakes: settings.detectRetakes,
      removeSilence: settings.removeSilence,
      minSegmentSeconds: settings.minSegmentSeconds,
      overrides: (reset ? [] : overrides) as never,
      updatedAt: new Date(),
    })
    .where(eq(editSettings.videoId, id));

  const decisions = await getActiveEdl(database, id);
  return NextResponse.json({
    decisions,
    summary: summarizeEdl(decisions, duration),
    settings,
    edlVersion: version,
  });
});

/** GET /api/videos/:id/edl — the active EDL and its summary. */
export const GET = route(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await context.params;
  const database = db();

  const row = await requireVideoForUser(database, id, user.id);
  const decisions = await getActiveEdl(database, id);
  return NextResponse.json({
    decisions,
    summary: summarizeEdl(decisions, row.duration ?? 0),
  });
});
