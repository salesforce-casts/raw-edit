import { sha256Hex } from "./sha256";
import { canonicalizeJobStatus } from "./state-machine";
import type { JobType } from "./types";

export function jobIdempotencyKey(type: JobType, videoId: string, inputVersion: string): string {
  return sha256Hex(`${type}|${videoId}|${inputVersion}`);
}

export function analysisInputVersion(sourceSha256: string): string {
  return sourceSha256;
}

export function renderInputVersion(editVersion: number | string, preset: string): string {
  return `${editVersion}|${preset}`;
}

export function retryDelayMs(attempt: number, delays = [10_000, 60_000, 300_000]): number {
  return delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
}

export function isStaleHeartbeat(heartbeatAt: Date | string | null | undefined, now = Date.now(), staleMs = 90_000): boolean {
  if (!heartbeatAt) return true;
  const time = heartbeatAt instanceof Date ? heartbeatAt.getTime() : new Date(heartbeatAt).getTime();
  return now - time >= staleMs;
}

export type ClaimDecision = "already-done" | "busy" | "claim" | "reclaim";

export function decideJobClaim(
  job:
    | {
        status: import("./types").JobStatus;
        idempotencyKey?: string | null;
        lockedBy?: string | null;
        heartbeatAt?: Date | string | null;
      }
    | null,
  workerId: string,
  now = Date.now(),
): ClaimDecision {
  if (!job) return "claim";
  const status = canonicalizeJobStatus(job.status);
  if (status === "SUCCEEDED" || status === "DEAD") return "already-done";
  if (status === "RUNNING" && job.lockedBy && job.lockedBy !== workerId && !isStaleHeartbeat(job.heartbeatAt, now)) {
    return "busy";
  }
  if (status === "RUNNING" && isStaleHeartbeat(job.heartbeatAt, now)) return "reclaim";
  return "claim";
}

export function selectJobByIdempotencyKey<T extends { idempotencyKey?: string | null }>(
  jobs: T[],
  key: string,
): T | undefined {
  return jobs.find((job) => job.idempotencyKey === key);
}
