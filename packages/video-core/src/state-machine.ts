import { PROCESSING_STATES, type VideoStatus } from "@raw-edit/contracts";

const ALLOWED: Record<VideoStatus, VideoStatus[]> = {
  CREATED: ["UPLOADING", "DELETING", "FAILED"],
  UPLOADING: ["UPLOADED", "FAILED", "DELETING"],
  UPLOADED: ["ANALYZING", "FAILED", "DELETING"],
  ANALYZING: ["TRANSCRIBING", "READY_FOR_REVIEW", "FAILED", "DELETING"],
  TRANSCRIBING: ["DETECTING_EDITS", "FAILED", "DELETING"],
  DETECTING_EDITS: ["READY_FOR_REVIEW", "FAILED", "DELETING"],
  READY_FOR_REVIEW: ["RENDERING", "DETECTING_EDITS", "DELETING", "FAILED"],
  RENDERING: ["COMPLETE", "FAILED", "DELETING"],
  COMPLETE: ["RENDERING", "DELETING"],
  FAILED: ["ANALYZING", "TRANSCRIBING", "DETECTING_EDITS", "RENDERING", "DELETING", "UPLOADING"],
  DELETING: ["DELETED", "FAILED"],
  DELETED: [],
};

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: VideoStatus, to: VideoStatus) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal video status transition ${from} → ${to}`);
  }
}

export function isProcessing(status: VideoStatus): boolean {
  return PROCESSING_STATES.includes(status);
}
