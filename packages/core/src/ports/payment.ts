import type { PlanTier, UsageKind } from '../types/status.js';

/**
 * Billing is deliberately thin for v1: plan limits are enforced from usage records,
 * and the payment provider is behind an interface so a real one can be dropped in
 * without touching the app.
 */

export interface PlanLimits {
  tier: PlanTier;
  label: string;
  /** Minutes of video that can be uploaded per billing period. */
  monthlyUploadMinutes: number;
  /** Largest single file, in bytes. */
  maxFileSizeBytes: number;
  /** Longest single video, in seconds. */
  maxVideoDurationSeconds: number;
  /** Total stored bytes across originals plus exports. */
  storageBytes: number;
  /** How many jobs of this user's may run at once. */
  concurrentJobs: number;
  features: {
    hdrPreserve: boolean;
    customRetention: boolean;
    shareLinkExpiry: boolean;
    cloudImport: boolean;
  };
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: {
    tier: 'FREE',
    label: 'Free',
    monthlyUploadMinutes: 30,
    maxFileSizeBytes: 2 * 1024 ** 3,
    maxVideoDurationSeconds: 15 * 60,
    storageBytes: 5 * 1024 ** 3,
    concurrentJobs: 1,
    features: { hdrPreserve: false, customRetention: false, shareLinkExpiry: false, cloudImport: false },
  },
  CREATOR: {
    tier: 'CREATOR',
    label: 'Creator',
    monthlyUploadMinutes: 600,
    maxFileSizeBytes: 10 * 1024 ** 3,
    maxVideoDurationSeconds: 60 * 60,
    storageBytes: 100 * 1024 ** 3,
    concurrentJobs: 2,
    features: { hdrPreserve: true, customRetention: true, shareLinkExpiry: true, cloudImport: true },
  },
  PRO: {
    tier: 'PRO',
    label: 'Pro',
    monthlyUploadMinutes: 3000,
    maxFileSizeBytes: 25 * 1024 ** 3,
    maxVideoDurationSeconds: 4 * 60 * 60,
    storageBytes: 1024 ** 4,
    concurrentJobs: 4,
    features: { hdrPreserve: true, customRetention: true, shareLinkExpiry: true, cloudImport: true },
  },
};

export interface UsageTotals {
  uploadedMinutes: number;
  transcribedMinutes: number;
  renderedMinutes: number;
  storageBytes: number;
}

export interface QuotaCheck {
  allowed: boolean;
  reason?: string;
  limit?: number;
  used?: number;
}

export function checkUploadQuota(
  tier: PlanTier,
  usage: UsageTotals,
  incoming: { fileSizeBytes: number; estimatedDurationSeconds?: number },
): QuotaCheck {
  const limits = PLAN_LIMITS[tier];
  if (incoming.fileSizeBytes > limits.maxFileSizeBytes) {
    return {
      allowed: false,
      reason: `This file is larger than the ${limits.label} plan's ${formatGb(limits.maxFileSizeBytes)} per-file limit.`,
      limit: limits.maxFileSizeBytes,
      used: incoming.fileSizeBytes,
    };
  }
  if (usage.uploadedMinutes >= limits.monthlyUploadMinutes) {
    return {
      allowed: false,
      reason: `You have used all ${limits.monthlyUploadMinutes} upload minutes on the ${limits.label} plan this month.`,
      limit: limits.monthlyUploadMinutes,
      used: usage.uploadedMinutes,
    };
  }
  if (usage.storageBytes + incoming.fileSizeBytes > limits.storageBytes) {
    return {
      allowed: false,
      reason: `This upload would exceed the ${limits.label} plan's ${formatGb(limits.storageBytes)} of storage.`,
      limit: limits.storageBytes,
      used: usage.storageBytes,
    };
  }
  if (
    incoming.estimatedDurationSeconds !== undefined &&
    incoming.estimatedDurationSeconds > limits.maxVideoDurationSeconds
  ) {
    return {
      allowed: false,
      reason: `Videos on the ${limits.label} plan can be up to ${Math.round(limits.maxVideoDurationSeconds / 60)} minutes.`,
    };
  }
  return { allowed: true };
}

function formatGb(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

export interface UsageEvent {
  userId: string;
  videoId?: string;
  kind: UsageKind;
  quantity: number;
  unit: 'minutes' | 'bytes';
  occurredAt: Date;
}

export interface CheckoutSession {
  url: string;
  sessionId: string;
}

/** No payment provider ships in v1; the interface exists so one can be added later. */
export interface PaymentProvider {
  readonly name: string;
  isConfigured(): boolean;
  createCheckoutSession(input: {
    userId: string;
    email: string;
    tier: Exclude<PlanTier, 'FREE'>;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSession>;
  createBillingPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Returns the plan change a verified webhook implies, or null. */
  handleWebhook(rawBody: string, signature: string): Promise<{ userId: string; tier: PlanTier } | null>;
}
