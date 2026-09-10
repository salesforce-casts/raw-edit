import { PROCESSING_STATES, type JobStatus, type VideoStatus } from "./types";

const VIDEO_ALLOWED: Record<VideoStatus, VideoStatus[]> = {
  CREATED: ["UPLOADING", "DELETING", "FAILED"],
  UPLOADING: ["UPLOADED", "FAILED", "DELETING"],
  UPLOADED: ["ANALYZING", "FAILED", "DELETING"],
  ANALYZING: ["TRANSCRIBING", "READY_FOR_REVIEW", "FAILED", "DELETING"],
  TRANSCRIBING: ["DETECTING_TAKES", "DETECTING_EDITS", "FAILED", "DELETING"],
  DETECTING_TAKES: ["READY_FOR_REVIEW", "FAILED", "DELETING"],
  DETECTING_EDITS: ["READY_FOR_REVIEW", "FAILED", "DELETING"],
  READY_FOR_REVIEW: ["RENDERING", "DETECTING_TAKES", "DETECTING_EDITS", "DELETING", "FAILED"],
  RENDERING: ["COMPLETE", "READY_FOR_REVIEW", "FAILED", "DELETING"],
  COMPLETE: ["RENDERING", "DELETING"],
  FAILED: ["ANALYZING", "TRANSCRIBING", "DETECTING_TAKES", "DETECTING_EDITS", "RENDERING", "DELETING", "UPLOADING"],
  DELETING: ["DELETED", "FAILED"],
  DELETED: [],
};

export function canonicalizeVideoStatus(status: VideoStatus): VideoStatus {
  return status === "DETECTING_EDITS" ? "DETECTING_TAKES" : status;
}

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return VIDEO_ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: VideoStatus, to: VideoStatus) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal video status transition ${from} → ${to}`);
  }
}

export function isProcessing(status: VideoStatus): boolean {
  return PROCESSING_STATES.includes(status);
}

export function canonicalizeJobStatus(status: JobStatus): "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD" {
  if (status === "ACTIVE" || status === "RUNNING") return "RUNNING";
  if (status === "COMPLETED" || status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "DEAD_LETTER" || status === "DEAD") return "DEAD";
  if (status === "FAILED") return "FAILED";
  return "QUEUED";
}

const JOB_ALLOWED: Record<ReturnType<typeof canonicalizeJobStatus>, Array<ReturnType<typeof canonicalizeJobStatus>>> = {
  QUEUED: ["RUNNING", "DEAD"],
  RUNNING: ["SUCCEEDED", "FAILED", "DEAD", "RUNNING"],
  SUCCEEDED: [],
  FAILED: ["RUNNING", "DEAD"],
  DEAD: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_ALLOWED[canonicalizeJobStatus(from)].includes(canonicalizeJobStatus(to));
}

export function assertJobTransition(from: JobStatus, to: JobStatus) {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Illegal job status transition ${from} → ${to}`);
  }
}

export function persistJobStatus(status: JobStatus): JobStatus {
  const canonical = canonicalizeJobStatus(status);
  if (canonical === "RUNNING") return "RUNNING";
  if (canonical === "SUCCEEDED") return "SUCCEEDED";
  if (canonical === "DEAD") return "DEAD";
  return canonical;
}
