import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { EXPORT_PRESETS, PLAN_LIMITS, RETENTION_POLICIES } from '@rawedit/core';
import {
  getOrCreateUserSettings,
  getPlanTier,
  getUsageTotals,
  userSettings,
  video,
} from '@rawedit/db';
import { and, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/container';
import { jsonError, requireUser, route } from '@/lib/authz';

export const runtime = 'nodejs';

const SettingsSchema = z.object({
  silenceThresholdSeconds: z.number().min(0.1).max(10).optional(),
  padPreMs: z.number().int().min(0).max(2000).optional(),
  padPostMs: z.number().int().min(0).max(2000).optional(),
  removeFillerWords: z.boolean().optional(),
  detectRetakes: z.boolean().optional(),
  removeSilence: z.boolean().optional(),
  minSegmentSeconds: z.number().min(0).max(5).optional(),
  defaultExportPreset: z.enum(EXPORT_PRESETS).optional(),
  sourceRetention: z.enum(RETENTION_POLICIES).optional(),
});

/** GET /api/settings — editing defaults, plan limits and current usage. */
export const GET = route(async () => {
  const user = await requireUser();
  const database = db();
  const [settings, tier, usage] = await Promise.all([
    getOrCreateUserSettings(database, user.id),
    getPlanTier(database, user.id),
    getUsageTotals(database, user.id),
  ]);

  return NextResponse.json({
    settings,
    plan: PLAN_LIMITS[tier],
    usage,
  });
});

/**
 * PATCH /api/settings — update the creator's defaults.
 *
 * Changing the retention policy re-dates every video that has not already had its
 * original deleted. Shortening it can therefore schedule a deletion, which is why
 * the response says exactly how many videos were affected rather than doing it
 * quietly.
 */
export const PATCH = route(async (request: NextRequest) => {
  const user = await requireUser();
  const parsed = SettingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid settings.', 400, 'INVALID_REQUEST');
  }

  const database = db();
  await getOrCreateUserSettings(database, user.id);

  const [updated] = await database
    .update(userSettings)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(userSettings.userId, user.id))
    .returning();

  let retentionApplied = 0;
  if (parsed.data.sourceRetention) {
    const policy = parsed.data.sourceRetention;
    const rows = await database
      .update(video)
      .set({
        sourceRetention: policy,
        // The deadline is measured from when the video was uploaded, not from now,
        // so switching to "7 days" does not give an old video a fresh week.
        deleteSourceAfter:
          policy === 'NEVER'
            ? null
            : sql`${video.createdAt} + ${retentionIntervalSql(policy)}::interval`,
      })
      .where(and(eq(video.userId, user.id), isNull(video.sourceDeletedAt)))
      .returning({ id: video.id });
    retentionApplied = rows.length;
  }

  return NextResponse.json({ settings: updated, retentionApplied });
});

function retentionIntervalSql(policy: (typeof RETENTION_POLICIES)[number]): string {
  switch (policy) {
    case 'DAYS_7':
      return '7 days';
    case 'DAYS_30':
      return '30 days';
    case 'DAYS_90':
      return '90 days';
    default:
      return '100 years';
  }
}
