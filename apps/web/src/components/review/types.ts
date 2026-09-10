import type {
  DetectedTakeGroup,
  EditDecision,
  EditSettings,
  EdlSummary,
  VideoStatus,
} from '@rawedit/core';

export interface ReviewWord {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  confidence: number | null;
  isFiller: boolean;
}

export interface ReviewSegment {
  id: string;
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  isCompleteSentence: boolean;
  fillerCount: number;
  internalPauseCount: number;
  words: ReviewWord[];
}

export interface ReviewVideo {
  id: string;
  title: string | null;
  originalFilename: string;
  status: VideoStatus;
  statusDetail: string | null;
  progress: number;
  errorMessage: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  rotation: number;
  frameRate: number | null;
  fileSize: number;
  videoCodec: string | null;
  audioCodec: string | null;
  isHdr: boolean;
  hdrFormat: string | null;
  sourceDeletedAt: string | null;
  playbackUrl: string | null;
  usingProxy: boolean;
  originalUrl: string | null;
  waveformUrl: string | null;
}

export interface TakeMemberRow {
  id: string;
  segmentIndex: number;
  index: number;
  startTime: number;
  endTime: number;
  text: string;
  isChosen: boolean;
  score: number;
}

export interface TakeRow extends Omit<DetectedTakeGroup, 'members'> {
  memberCount: number;
  chosenSegmentIndex: number;
  members: TakeMemberRow[];
}

export interface ExportRow {
  id: string;
  preset: string;
  status: 'QUEUED' | 'RENDERING' | 'COMPLETE' | 'FAILED';
  progress: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  fileSize: number | null;
  estimatedSize: number | null;
  duration: number | null;
  warnings: string[];
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ReviewPayload {
  video: ReviewVideo;
  decisions: EditDecision[];
  takes: TakeRow[];
  segments: ReviewSegment[];
  summary: EdlSummary;
  exports: ExportRow[];
  /** The settings that produced the current proposal, so the panel opens truthfully. */
  settings: Partial<EditSettings> | null;
}

export interface PresetOption {
  id: string;
  label: string;
  description: string;
  result: {
    width: number;
    height: number;
    frameRate: number;
    videoCodec: string;
    estimatedSize: number;
    warnings: string[];
    toneMapped: boolean;
    scaled: boolean;
  };
}

export type { EditDecision, EditSettings, EdlSummary };
