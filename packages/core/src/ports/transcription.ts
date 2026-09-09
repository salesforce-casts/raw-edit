import type { TranscriptResult } from '../types/transcript.js';

/**
 * Speech-to-text. Word-level timings are mandatory: without them there is no edit.
 * A provider that cannot supply them must throw at construction time, not at runtime.
 */
export interface TranscribeInput {
  /** Local path to 16 kHz mono PCM WAV. Preferred — providers can stream it. */
  audioPath?: string;
  /** Alternative for providers that fetch by URL. */
  audioUrl?: string;
  /** BCP-47 hint, or null to auto-detect. */
  language?: string | null;
  /** Media duration in seconds, so providers can report real progress. */
  durationSeconds?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string | null;
  /** True when the provider can be reached with the current configuration. */
  isConfigured(): boolean;
  transcribe(input: TranscribeInput): Promise<TranscriptResult>;
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TranscriptionError';
  }
}
