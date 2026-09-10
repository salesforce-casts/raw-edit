import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { and, desc, eq } from 'drizzle-orm';
import {
  getActiveEdl,
  getTakesWithMembers,
  getTranscriptWithSegments,
  getVideoForUser,
  videoExport,
} from '@rawedit/db';
import { summarizeEdl } from '@rawedit/core';
import { URL_TTL, db, storage } from '@/lib/container';
import { requireUser } from '@/lib/authz';
import { ReviewScreen } from '@/components/review/review-screen';
import type { ReviewPayload } from '@/components/review/types';

export const dynamic = 'force-dynamic';

/**
 * The review screen is rendered on the server with everything already loaded, so the
 * first paint shows the real edit rather than a spinner. Live updates take over from
 * there via SSE.
 */
export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const database = db();

  const row = await getVideoForUser(database, id, user.id);
  if (!row) notFound();

  const [decisions, takes, transcriptData, exports] = await Promise.all([
    getActiveEdl(database, id),
    getTakesWithMembers(database, id),
    getTranscriptWithSegments(database, id),
    database
      .select()
      .from(videoExport)
      .where(and(eq(videoExport.videoId, id), eq(videoExport.userId, user.id)))
      .orderBy(desc(videoExport.createdAt)),
  ]);

  const sign = async (key: string | null) =>
    key ? storage().signDownloadUrl(key, URL_TTL.playback) : null;

  // The player prefers the proxy so scrubbing works on cellular. Rendering always
  // reads the original regardless of what is being previewed.
  const [proxyUrl, originalUrl, waveformUrl] = await Promise.all([
    sign(row.proxyKey),
    row.sourceDeletedAt ? null : sign(row.storageKey),
    sign(row.waveformKey),
  ]);

  const payload: ReviewPayload = {
    video: {
      id: row.id,
      title: row.title,
      originalFilename: row.originalFilename,
      status: row.status,
      statusDetail: row.statusDetail,
      progress: row.progress,
      errorMessage: row.errorMessage,
      duration: row.duration,
      width: row.width,
      height: row.height,
      rotation: row.rotation,
      frameRate: row.avgFrameRate ?? row.frameRate,
      fileSize: row.fileSize,
      videoCodec: row.videoCodec,
      audioCodec: row.audioCodec,
      isHdr: row.isHdr,
      hdrFormat: row.hdrFormat,
      sourceDeletedAt: row.sourceDeletedAt ? row.sourceDeletedAt.toISOString() : null,
      playbackUrl: proxyUrl ?? originalUrl,
      usingProxy: Boolean(proxyUrl),
      originalUrl,
      waveformUrl,
    },
    decisions,
    takes: takes.map((take) => ({
      id: take.id,
      groupIndex: take.groupIndex,
      canonicalText: take.canonicalText,
      memberCount: take.memberCount,
      chosenSegmentIndex: take.chosenSegmentIndex,
      similarity: take.similarity,
      confidence: take.confidence,
      reason: take.reason,
      members: take.members.map((member) => ({
        id: member.id,
        segmentIndex: member.segmentIndex,
        index: member.index,
        startTime: member.startTime,
        endTime: member.endTime,
        text: member.text,
        isChosen: member.isChosen,
        score: member.score,
      })),
    })),
    segments: (transcriptData?.segments ?? []).map((segment) => ({
      id: segment.id,
      index: segment.index,
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: segment.text,
      isCompleteSentence: segment.isCompleteSentence,
      fillerCount: segment.fillerCount,
      internalPauseCount: segment.internalPauseCount,
      words: segment.words.map((word) => ({
        id: word.id,
        index: word.index,
        startTime: word.startTime,
        endTime: word.endTime,
        text: word.text,
        confidence: word.confidence,
        isFiller: word.isFiller,
      })),
    })),
    summary: summarizeEdl(decisions, row.duration ?? 0),
    exports: exports.map((row) => ({
      id: row.id,
      preset: row.preset,
      status: row.status,
      progress: row.progress,
      width: row.width,
      height: row.height,
      frameRate: row.frameRate,
      videoCodec: row.videoCodec,
      fileSize: row.fileSize,
      estimatedSize: row.estimatedSize,
      duration: row.duration,
      warnings: row.warnings,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    })),
  };

  return (
    <>
      <Link
        href="/dashboard"
        className="mt-4 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        All videos
      </Link>
      <ReviewScreen initial={payload} />
    </>
  );
}
