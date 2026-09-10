import { describe, expect, it } from "vitest";
import {
  analysisInputVersion,
  decideJobClaim,
  isStaleHeartbeat,
  jobIdempotencyKey,
  renderInputVersion,
  retryDelayMs,
  selectJobByIdempotencyKey,
} from "./jobs";
import { createShareToken, encodeShareSlug } from "./share-token";
import { fileFingerprint, isOriginalsKey, multipartPartSizeBytes, originalsKey, shouldUseMultipart } from "./upload";
import { isBlockedIp } from "./ssrf";
import { SHARE_ALPHABET, SHARE_SLUG_LENGTH } from "./types";
import { parseFfmpegProgress } from "./ffmpeg";

describe("job identity", () => {
  it("keys work by type, video, and input version so a second render is not skipped", () => {
    const first = jobIdempotencyKey("RENDER_EXPORT", "vid", renderInputVersion(1, "HIGH_QUALITY"));
    const second = jobIdempotencyKey("RENDER_EXPORT", "vid", renderInputVersion(2, "HIGH_QUALITY"));
    expect(first).not.toBe(second);
    expect(first).toBe(jobIdempotencyKey("RENDER_EXPORT", "vid", "1|HIGH_QUALITY"));
    expect(analysisInputVersion("abc")).toBe("abc");
  });

  it("uses classified retry delays", () => {
    expect(retryDelayMs(0)).toBe(10_000);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(300_000);
    expect(retryDelayMs(9)).toBe(300_000);
  });

  it("treats a missing or old heartbeat as stale after 90s", () => {
    expect(isStaleHeartbeat(null, 100_000)).toBe(true);
    expect(isStaleHeartbeat(new Date(0), 100_000)).toBe(true);
    expect(isStaleHeartbeat(new Date(20_000), 100_000)).toBe(false);
  });

  it("claims by idempotency key so a second render is not skipped", () => {
    const jobs = [
      { id: "old", status: "SUCCEEDED" as const, idempotencyKey: "key-v1" },
      { id: "next", status: "QUEUED" as const, idempotencyKey: "key-v2" },
    ];
    expect(selectJobByIdempotencyKey(jobs, "key-v2")?.id).toBe("next");
    expect(decideJobClaim(jobs[0], "worker-a")).toBe("already-done");
    expect(decideJobClaim(jobs[1], "worker-a")).toBe("claim");
    expect(
      decideJobClaim(
        { status: "FAILED", lockedBy: null, heartbeatAt: new Date() },
        "worker-a",
      ),
    ).toBe("claim");
    expect(
      decideJobClaim(
        { status: "RUNNING", lockedBy: "other", heartbeatAt: new Date(Date.now() - 120_000) },
        "worker-a",
      ),
    ).toBe("reclaim");
  });
});

describe("upload part sizing", () => {
  it("clamps part size between 8 MiB and 512 MiB targeting 9000 parts", () => {
    expect(multipartPartSizeBytes(8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
    expect(multipartPartSizeBytes(90_000 * 8 * 1024 * 1024)).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(multipartPartSizeBytes(20 * 1024 * 1024 * 1024)).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(shouldUseMultipart(50 * 1024 * 1024)).toBe(false);
    expect(shouldUseMultipart(100 * 1024 * 1024)).toBe(true);
  });

  it("fingerprints a file for resume-after-refresh", () => {
    expect(fileFingerprint({ name: "clip.mov", size: 12, lastModified: 9 })).toBe("clip.mov|12|9");
  });

  it("stores originals under originals/ and rejects other prefixes for retention", () => {
    const key = originalsKey("user-1", "video-1", "Take 3.MOV");
    expect(key).toBe("users/user-1/videos/video-1/originals/original.mov");
    expect(isOriginalsKey(key)).toBe(true);
    expect(isOriginalsKey("users/user-1/videos/video-1/exports/x.mp4")).toBe(false);
  });
});

describe("share slugs", () => {
  it("encodes 12 characters from the 31-symbol alphabet", () => {
    const token = encodeShareSlug(new Uint8Array(16).fill(7));
    expect(token).toHaveLength(SHARE_SLUG_LENGTH);
    expect([...token].every((char) => SHARE_ALPHABET.includes(char))).toBe(true);
    const created = createShareToken(new Uint8Array(16).map((_, index) => index + 1));
    expect(created.tokenHash).toHaveLength(64);
  });
});

describe("ssrf denylist", () => {
  it("blocks loopback, private, link-local and CGNAT addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("192.168.1.9")).toBe(true);
    expect(isBlockedIp("169.254.1.1")).toBe(true);
    expect(isBlockedIp("100.64.1.2")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });
});

describe("ffmpeg progress", () => {
  it("prefers out_time_us from ffmpeg", () => {
    expect(parseFfmpegProgress("out_time_us=1500000\n")).toEqual({ outTimeMs: 1500 });
  });
});
