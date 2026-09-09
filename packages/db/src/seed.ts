/**
 * Seed data for local development.
 *
 * Creates a demo creator plus one video that is already READY_FOR_REVIEW, with a
 * transcript containing the classic three-takes-of-one-sentence pattern, so the review
 * screen and the timeline can be worked on without uploading a real file first.
 *
 * The seeded video has no bytes in storage: it is explicitly marked as demo data and
 * its render button is disabled in the UI. Run `npm run db:seed -- --reset` to wipe.
 */
import { randomUUID } from 'node:crypto';
import { scryptSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  buildEdl,
  DEFAULT_EDIT_SETTINGS,
  newId,
  segmentWords,
  StorageKeys,
  type TranscriptWord,
} from '@rawedit/core';
import { createDb } from './client.js';
import {
  detectedTake,
  detectedTakeMember,
  editDecision,
  editSettings,
  transcript,
  transcriptSegment,
  transcriptWord,
  user,
  userSettings,
  video,
} from './schema/index.js';

const DEMO_EMAIL = 'demo@rawedit.local';
const DEMO_PASSWORD = 'rawedit-demo-1234';

function utterance(start: number, text: string, wordsPerSecond = 2.8): TranscriptWord[] {
  const tokens = text.trim().split(/\s+/);
  const perWord = 1 / wordsPerSecond;
  return tokens.map((token, index) => ({
    text: token,
    start: Number((start + index * perWord).toFixed(3)),
    end: Number((start + index * perWord + perWord * 0.85).toFixed(3)),
    confidence: 0.93 + (index % 5) * 0.01,
  }));
}

/** Better Auth's default credential hash format: scrypt, `salt:hash` hex. */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password.normalize('NFKC'), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return `${salt}:${derived.toString('hex')}`;
}

async function main(): Promise<void> {
  const { db, sql } = createDb();
  const reset = process.argv.includes('--reset');

  const existing = await db.select().from(user).where(eq(user.email, DEMO_EMAIL)).limit(1);
  if (existing[0] && !reset) {
    console.log(`Demo user already exists (${DEMO_EMAIL}). Re-run with --reset to recreate.`);
    await sql.end();
    return;
  }
  if (existing[0]) {
    await db.delete(user).where(eq(user.id, existing[0].id));
    console.log('Removed the previous demo user and everything it owned.');
  }

  const userId = newId('usr');
  await db.insert(user).values({
    id: userId,
    name: 'Demo Creator',
    email: DEMO_EMAIL,
    emailVerified: true,
    planTier: 'CREATOR',
  });
  await db.insert(userSettings).values({ userId });

  // Better Auth stores credentials in `account` with providerId 'credential'.
  await sql`
    insert into account (id, user_id, account_id, provider_id, password, created_at, updated_at)
    values (${randomUUID()}, ${userId}, ${userId}, 'credential', ${hashPassword(DEMO_PASSWORD)}, now(), now())
  `;

  const videoId = newId('vid');
  const duration = 48;
  const words = [
    ...utterance(1.2, "Today I'll show you three business ideas"),
    ...utterance(7.4, "Today I'll show you"),
    ...utterance(11.8, "Today I'll show you three business ideas that you can start under fifty thousand rupees."),
    ...utterance(22.5, 'The first one is a print on demand store.'),
    ...utterance(28.0, 'The um second one is a weekend photography service for local businesses.'),
    ...utterance(36.5, 'And finally you could run a home bakery from your own kitchen.'),
  ];

  await db.insert(video).values({
    id: videoId,
    userId,
    title: 'Three business ideas (demo)',
    originalFilename: 'IMG_4821.MOV',
    storageKey: StorageKeys.original(userId, videoId, 'IMG_4821.MOV'),
    storageBucket: process.env['R2_BUCKET'] ?? 'rawedit-dev',
    mimeType: 'video/quicktime',
    fileSize: 486_000_000,
    status: 'READY_FOR_REVIEW',
    statusDetail: 'Seeded demo data — no media is stored for this video.',
    progress: 100,
    duration,
    width: 1080,
    height: 1920,
    rotation: 0,
    displayAspectRatio: '9:16',
    frameRate: 30,
    avgFrameRate: 30,
    isVariableFrameRate: false,
    videoCodec: 'hevc',
    videoProfile: 'Main 10',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    audioCodec: 'aac',
    audioChannels: 2,
    audioSampleRate: 48000,
    bitrate: 81_000_000,
    colorPrimaries: 'bt2020',
    colorTransfer: 'arib-std-b67',
    colorSpace: 'bt2020nc',
    colorRange: 'tv',
    isHdr: true,
    hdrFormat: 'HLG',
  });

  const segments = segmentWords(words);
  const acousticSilence = [
    { start: 0, end: 1.2 },
    { start: 4.5, end: 7.4 },
    { start: 9.0, end: 11.8 },
    { start: 21.0, end: 22.5 },
    { start: 26.2, end: 28.0 },
    { start: 34.8, end: 36.5 },
    { start: 45.6, end: 48 },
  ];
  const result = buildEdl({ segments, acousticSilence, duration, settings: DEFAULT_EDIT_SETTINGS });

  const transcriptId = newId('trx');
  await db.insert(transcript).values({
    id: transcriptId,
    videoId,
    provider: 'seed',
    model: 'seed-v1',
    language: 'en',
    duration,
    wordCount: words.length,
    confidence: 0.95,
  });

  for (const segment of segments) {
    const segmentId = newId('seg');
    await db.insert(transcriptSegment).values({
      id: segmentId,
      transcriptId,
      videoId,
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
    await db.insert(transcriptWord).values(
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

  /** In-memory group id (`take_0`) -> the row id we inserted for it. */
  const takeIdByGroupId = new Map<string, string>();

  for (const group of result.takes) {
    const takeId = newId('tak');
    takeIdByGroupId.set(group.id, takeId);
    await db.insert(detectedTake).values({
      id: takeId,
      videoId,
      groupIndex: group.groupIndex,
      canonicalText: group.canonicalText,
      memberCount: group.members.length,
      chosenSegmentIndex: group.chosenSegmentIndex,
      similarity: group.similarity,
      confidence: group.confidence,
      reason: group.reason,
    });
    await db.insert(detectedTakeMember).values(
      group.members.map((member, index) => ({
        id: newId('tkm'),
        takeId,
        videoId,
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

  await db.insert(editSettings).values({ videoId, edlVersion: 1 });
  if (result.decisions.length > 0) {
    await db.insert(editDecision).values(
      result.decisions.map((decision, index) => ({
        id: newId('edd'),
        videoId,
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

  console.log('Seed complete.');
  console.log(`  email:    ${DEMO_EMAIL}`);
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(`  video:    ${videoId} (${result.decisions.length} proposed edits, ${result.takes.length} take groups)`);
  console.log(`  original ${result.summary.originalDuration}s -> proposed ${result.summary.proposedDuration}s`);
  await sql.end();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
