import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  analyzeProgress,
  analyzeStageLabel,
  analyzeStageStatus,
  applyAdvisor,
  buildEdl,
  DEFAULT_EDIT_SETTINGS,
  newId,
  PermanentError,
  segmentWords,
  StorageKeys,
  TransientError,
  type AnalyzeStageKey,
  type EditSettings,
  type MediaMetadata,
} from '@rawedit/core';
import {
  detectedTake,
  detectedTakeMember,
  editDecision,
  editSettings,
  getOrCreateUserSettings,
  recordUsage,
  setVideoStatus,
  transcript,
  transcriptSegment,
  transcriptWord,
  video,
} from '@rawedit/db';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { withScratchDir, type WorkerContext } from '../lib/context.js';
import type { JobTracker } from '../lib/job-tracker.js';

export interface AnalyzeInput {
  videoId: string;
  userId: string;
}

/**
 * ANALYZE_VIDEO: probe -> extract audio -> silence -> previews -> transcribe ->
 * detect takes -> EDL -> READY_FOR_REVIEW.
 *
 * Every result is written in a single transaction at the very end, so a crash
 * half-way through leaves the previous transcript and EDL untouched.
 */
export async function handleAnalyze(
  ctx: WorkerContext,
  tracker: JobTracker,
  input: AnalyzeInput,
): Promise<void> {
  const row = await loadVideo(ctx, input.videoId, input.userId);

  const report = async (stage: AnalyzeStageKey, fraction: number, message?: string) => {
    await tracker.progress(analyzeProgress(stage, fraction), {
      stage: analyzeStageLabel(stage),
      status: analyzeStageStatus(stage),
      message,
    });
  };

  await setVideoStatus(ctx.db, input.videoId, 'ANALYZING', {
    progress: 0,
    statusDetail: 'Reading video metadata',
    errorMessage: null,
  });

  await withScratchDir(`analyze-${input.videoId}`, async (dir) => {
    // ---- 1. Probe -------------------------------------------------------------
    // ffprobe reads the header over a signed URL; a 4GB master is never downloaded.
    const sourceUrl = await ctx.storage.signDownloadUrl(row.storageKey, env.sourceUrlTtlSeconds);
    await report('probe', 0.1);

    const metadata = await ctx.processor.probe({ source: sourceUrl });
    assertUsable(metadata);
    await persistMetadata(ctx, input.videoId, metadata);
    await report('probe', 1);

    // ---- 2. Extract audio -----------------------------------------------------
    const audioPath = join(dir, 'audio.wav');
    await ctx.processor.extractAudio({
      source: sourceUrl,
      outputPath: audioPath,
      durationSeconds: metadata.duration,
      onProgress: (fraction) => void report('audio', fraction),
    });

    // Verify the stored object is byte-for-byte what the browser uploaded. The audio
    // pass already streamed the file, so this is the cheapest honest moment to check.
    if (row.checksumSha256 && !row.checksumVerifiedAt) {
      await verifyChecksum(ctx, row.id, row.storageKey, row.checksumSha256);
    }

    // ---- 3. Silence -----------------------------------------------------------
    const acousticSilence = await ctx.processor.detectSilence(audioPath, metadata.duration);
    await report('silence', 1);
    logger.info({ videoId: input.videoId, silenceRanges: acousticSilence.length }, 'Silence detected');

    // ---- 4. Preview derivatives (never a render source) -----------------------
    const previewKeys = env.generatePreviews
      ? await buildPreviews(ctx, row.userId, input.videoId, sourceUrl, audioPath, metadata, report)
      : {};
    await report('preview', 1);

    // ---- 5. Transcribe --------------------------------------------------------
    await setVideoStatus(ctx.db, input.videoId, 'TRANSCRIBING', { statusDetail: 'Transcribing audio' });
    const result = await ctx.transcription.transcribe({
      audioPath,
      durationSeconds: metadata.duration,
      onProgress: (fraction) => void report('transcribe', fraction),
    });
    await report('transcribe', 1);
    logger.info(
      { videoId: input.videoId, words: result.words.length, provider: result.provider },
      'Transcription complete',
    );

    // ---- 6. Segment, detect retakes, build the EDL ----------------------------
    await setVideoStatus(ctx.db, input.videoId, 'DETECTING_TAKES', { statusDetail: 'Finding retakes' });
    const settings = await resolveSettings(ctx, row.userId);
    const segments = segmentWords(result.words);
    await report('takes', 0.4);

    let edl = buildEdl({
      segments,
      acousticSilence,
      duration: metadata.duration,
      settings,
      idPrefix: `ed_${input.videoId.slice(-6)}`,
    });
    await report('takes', 0.7);

    // The advisor only ever re-picks which member of an already-detected group is
    // kept; it cannot introduce, move or delete a cut.
    edl = await applyAdvisor(edl, ctx.advisor);
    await report('takes', 0.9);

    logger.info(
      {
        videoId: input.videoId,
        segments: segments.length,
        takeGroups: edl.takes.length,
        decisions: edl.decisions.length,
        original: edl.summary.originalDuration,
        proposed: edl.summary.proposedDuration,
      },
      'Edit proposal built',
    );

    // ---- 7. Persist everything atomically -------------------------------------
    await persistAnalysis(ctx, {
      videoId: input.videoId,
      userId: row.userId,
      metadata,
      result,
      segments,
      edl,
      settings,
      previewKeys,
    });

    await recordUsage(ctx.db, {
      userId: row.userId,
      videoId: input.videoId,
      kind: 'TRANSCRIBED_MINUTES',
      quantity: metadata.duration / 60,
      unit: 'minutes',
    });

    await setVideoStatus(ctx.db, input.videoId, 'READY_FOR_REVIEW', {
      progress: 100,
      statusDetail: null,
      errorMessage: null,
    });
    await tracker.progress(100, { stage: 'Ready for review', status: 'READY_FOR_REVIEW' });
  });
}

async function loadVideo(ctx: WorkerContext, videoId: string, userId: string) {
  const rows = await ctx.db.select().from(video).where(eq(video.id, videoId)).limit(1);
  const row = rows[0];
  if (!row) throw new PermanentError(`Video ${videoId} no longer exists`, 'VIDEO_MISSING');
  if (row.userId !== userId) throw new PermanentError('Video does not belong to this user', 'FORBIDDEN');
  if (row.sourceDeletedAt) {
    throw new PermanentError('The original file was deleted under the retention policy.', 'SOURCE_DELETED');
  }
  return row;
}

/** Reject files that cannot produce an edit, with a reason a creator can act on. */
function assertUsable(metadata: MediaMetadata): void {
  if (!metadata.video) {
    throw new PermanentError('This file has no video stream.', 'NO_VIDEO_STREAM');
  }
  if (!metadata.audio) {
    throw new PermanentError(
      'This video has no audio track, so there is no speech to edit against.',
      'NO_AUDIO_STREAM',
    );
  }
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
    throw new PermanentError('This file appears to be corrupt — it has no duration.', 'INVALID_DURATION');
  }
  if (metadata.video.width <= 0 || metadata.video.height <= 0) {
    throw new PermanentError('This file appears to be corrupt — it has no frame size.', 'INVALID_DIMENSIONS');
  }
}

async function persistMetadata(ctx: WorkerContext, videoId: string, metadata: MediaMetadata): Promise<void> {
  const stream = metadata.video!;
  await ctx.db
    .update(video)
    .set({
      duration: metadata.duration,
      width: stream.width,
      height: stream.height,
      rotation: stream.rotation,
      displayAspectRatio: stream.displayAspectRatio,
      frameRate: stream.frameRate,
      avgFrameRate: stream.avgFrameRate,
      isVariableFrameRate: stream.isVariableFrameRate,
      videoCodec: stream.codec,
      videoProfile: stream.profile,
      pixelFormat: stream.pixelFormat,
      bitDepth: stream.bitDepth,
      audioCodec: metadata.audio?.codec ?? null,
      audioChannels: metadata.audio?.channels ?? null,
      audioSampleRate: metadata.audio?.sampleRate ?? null,
      bitrate: metadata.bitrate,
      colorPrimaries: stream.colorPrimaries,
      colorTransfer: stream.colorTransfer,
      colorSpace: stream.colorSpace,
      colorRange: stream.colorRange,
      isHdr: metadata.hdr.isHdr,
      hdrFormat: metadata.hdr.format,
      masterDisplay: metadata.hdr.masterDisplay,
      maxCll: metadata.hdr.maxCll,
      probeJson: metadata.raw as never,
      updatedAt: new Date(),
    })
    .where(eq(video.id, videoId));
}

/**
 * Recompute SHA-256 over the stored object and compare it with what the browser
 * computed while uploading. A mismatch fails the video rather than rendering from
 * bytes that are not what the creator picked.
 */
async function verifyChecksum(
  ctx: WorkerContext,
  videoId: string,
  storageKey: string,
  expected: string,
): Promise<void> {
  const hash = createHash('sha256');
  const stream = await ctx.storage.getObjectStream(storageKey);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  const actual = hash.digest('hex');

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new PermanentError(
      'The stored file does not match the checksum computed during upload. Please upload it again.',
      'CHECKSUM_MISMATCH',
    );
  }
  await ctx.db.update(video).set({ checksumVerifiedAt: new Date() }).where(eq(video.id, videoId));
  logger.info({ videoId }, 'Source checksum verified');
}

/**
 * Thumbnail, 720p proxy and waveform peaks. These exist purely so the review screen
 * is usable on cellular; the render always reads the original master.
 */
async function buildPreviews(
  ctx: WorkerContext,
  userId: string,
  videoId: string,
  sourceUrl: string,
  audioPath: string,
  metadata: MediaMetadata,
  report: (stage: AnalyzeStageKey, fraction: number) => Promise<void>,
): Promise<{ thumbnailKey?: string; proxyKey?: string; waveformKey?: string }> {
  const keys: { thumbnailKey?: string; proxyKey?: string; waveformKey?: string } = {};

  try {
    const thumbPath = `${audioPath}.thumb.jpg`;
    await ctx.processor.generateThumbnail(sourceUrl, thumbPath, Math.min(metadata.duration * 0.1, 10));
    const thumbKey = StorageKeys.thumbnail(userId, videoId);
    await ctx.storage.uploadStream(thumbKey, createReadStream(thumbPath), 'image/jpeg');
    keys.thumbnailKey = thumbKey;
    await report('preview', 0.2);
  } catch (error: unknown) {
    logger.warn({ err: error, videoId }, 'Thumbnail generation failed; continuing');
  }

  try {
    const waveform = await ctx.processor.computeWaveform(audioPath, metadata.duration, 20);
    const waveformKey = StorageKeys.waveform(userId, videoId);
    await ctx.storage.putObject({
      key: waveformKey,
      body: Buffer.from(JSON.stringify(waveform)),
      contentType: 'application/json',
    });
    keys.waveformKey = waveformKey;
    await report('preview', 0.35);
  } catch (error: unknown) {
    logger.warn({ err: error, videoId }, 'Waveform generation failed; continuing');
  }

  try {
    const proxyPath = `${audioPath}.proxy.mp4`;
    await ctx.processor.generateProxy(sourceUrl, proxyPath, metadata, (fraction) => {
      void report('preview', 0.35 + fraction * 0.6);
    });
    const proxyKey = StorageKeys.proxy(userId, videoId);
    const info = await stat(proxyPath);
    await ctx.storage.uploadStream(proxyKey, createReadStream(proxyPath), 'video/mp4');
    keys.proxyKey = proxyKey;
    logger.info({ videoId, proxyBytes: info.size }, 'Preview proxy uploaded');
  } catch (error: unknown) {
    // A missing proxy degrades the player to streaming the original; it is not fatal.
    logger.warn({ err: error, videoId }, 'Proxy generation failed; the player will use the original');
  }

  return keys;
}

async function resolveSettings(ctx: WorkerContext, userId: string): Promise<EditSettings> {
  const saved = await getOrCreateUserSettings(ctx.db, userId);
  return {
    ...DEFAULT_EDIT_SETTINGS,
    silenceThresholdSeconds: saved.silenceThresholdSeconds,
    padPreMs: saved.padPreMs,
    padPostMs: saved.padPostMs,
    removeFillerWords: saved.removeFillerWords,
    detectRetakes: saved.detectRetakes,
    removeSilence: saved.removeSilence,
    minSegmentSeconds: saved.minSegmentSeconds,
  };
}

interface PersistInput {
  videoId: string;
  userId: string;
  metadata: MediaMetadata;
  result: Awaited<ReturnType<WorkerContext['transcription']['transcribe']>>;
  segments: ReturnType<typeof segmentWords>;
  edl: ReturnType<typeof buildEdl>;
  settings: EditSettings;
  previewKeys: { thumbnailKey?: string; proxyKey?: string; waveformKey?: string };
}

/**
 * One transaction for the whole analysis result. Either the video has a complete
 * transcript, take groups and EDL, or it has exactly what it had before.
 */
async function persistAnalysis(ctx: WorkerContext, input: PersistInput): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    // Replace any previous analysis (re-analysis after a settings change).
    await tx.delete(transcript).where(eq(transcript.videoId, input.videoId));
    await tx.delete(detectedTake).where(eq(detectedTake.videoId, input.videoId));
    await tx.delete(editDecision).where(eq(editDecision.videoId, input.videoId));

    const transcriptId = newId('trx');
    await tx.insert(transcript).values({
      id: transcriptId,
      videoId: input.videoId,
      provider: input.result.provider,
      model: input.result.model,
      language: input.result.language,
      duration: input.metadata.duration,
      wordCount: input.result.words.length,
      confidence: input.result.confidence,
      rawJson: (input.result.raw ?? null) as never,
    });

    for (const segment of input.segments) {
      const segmentId = newId('seg');
      await tx.insert(transcriptSegment).values({
        id: segmentId,
        transcriptId,
        videoId: input.videoId,
        index: segment.index,
        startTime: segment.start,
        endTime: segment.end,
        text: segment.text,
        normalizedText: segment.normalizedText,
        confidence: segment.confidence,
        isCompleteSentence: segment.endsWithTerminator,
        fillerCount: segment.fillerCount,
        internalPauseCount: segment.internalPauseCount,
      });

      if (segment.words.length > 0) {
        await tx.insert(transcriptWord).values(
          segment.words.map((word, index) => ({
            id: newId('wrd'),
            transcriptId,
            segmentId,
            index,
            startTime: word.start,
            endTime: word.end,
            text: word.text,
            confidence: word.confidence,
            isFiller: segment.fillerWordIndices.includes(index),
          })),
        );
      }
    }

    const takeIdByGroupId = new Map<string, string>();
    for (const group of input.edl.takes) {
      const takeId = newId('tak');
      takeIdByGroupId.set(group.id, takeId);
      await tx.insert(detectedTake).values({
        id: takeId,
        videoId: input.videoId,
        groupIndex: group.groupIndex,
        canonicalText: group.canonicalText,
        memberCount: group.members.length,
        chosenSegmentIndex: group.chosenSegmentIndex,
        similarity: group.similarity,
        confidence: group.confidence,
        reason: group.reason,
      });
      await tx.insert(detectedTakeMember).values(
        group.members.map((member, index) => ({
          id: newId('tkm'),
          takeId,
          videoId: input.videoId,
          segmentIndex: member.segmentIndex,
          index,
          startTime: member.start,
          endTime: member.end,
          text: member.text,
          isChosen: member.isChosen,
          score: member.score,
          scoreBreakdown: member.breakdown,
        })),
      );
    }

    if (input.edl.decisions.length > 0) {
      await tx.insert(editDecision).values(
        input.edl.decisions.map((decision, index) => ({
          id: newId('edd'),
          videoId: input.videoId,
          index,
          startTime: decision.startTime,
          endTime: decision.endTime,
          action: decision.decision,
          kind: decision.kind,
          reason: decision.reason,
          confidence: decision.confidence,
          source: decision.source,
          takeId: decision.takeId ? takeIdByGroupId.get(decision.takeId) ?? null : null,
          segmentIndex: decision.segmentIndex ?? null,
          active: true,
          edlVersion: 1,
        })),
      );
    }

    await tx
      .insert(editSettings)
      .values({
        videoId: input.videoId,
        edlVersion: 1,
        silenceThresholdSeconds: input.settings.silenceThresholdSeconds,
        padPreMs: input.settings.padPreMs,
        padPostMs: input.settings.padPostMs,
        removeFillerWords: input.settings.removeFillerWords,
        detectRetakes: input.settings.detectRetakes,
        removeSilence: input.settings.removeSilence,
        minSegmentSeconds: input.settings.minSegmentSeconds,
        mergeGapMs: input.settings.mergeGapMs,
        retakeSimilarityThreshold: input.settings.retakeSimilarityThreshold,
        retakeMinOpeningTokens: input.settings.retakeMinOpeningTokens,
        retakeLookaheadSegments: input.settings.retakeLookaheadSegments,
        retakeLookaheadSeconds: input.settings.retakeLookaheadSeconds,
        overrides: [],
      })
      .onConflictDoUpdate({
        target: editSettings.videoId,
        set: { edlVersion: 1, overrides: [], updatedAt: new Date() },
      });

    if (Object.keys(input.previewKeys).length > 0) {
      await tx
        .update(video)
        .set({
          thumbnailKey: input.previewKeys.thumbnailKey ?? null,
          proxyKey: input.previewKeys.proxyKey ?? null,
          waveformKey: input.previewKeys.waveformKey ?? null,
        })
        .where(eq(video.id, input.videoId));
    }
  });
}

export { TransientError };
