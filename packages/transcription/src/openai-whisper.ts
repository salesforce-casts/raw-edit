import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  TranscriptionError,
  type TranscribeInput,
  type TranscriptionProvider,
  type TranscriptResult,
  type TranscriptWord,
} from '@rawedit/core';
import { averageConfidence } from './deepgram.js';

export interface OpenAiWhisperOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface VerboseJsonResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
  segments?: { text: string; start: number; end: number; avg_logprob?: number; no_speech_prob?: number }[];
}

/**
 * OpenAI's hosted Whisper.
 *
 * `timestamp_granularities[]=word` is mandatory here: without word timings there is
 * no way to place a cut, so a response that lacks them is treated as a failure rather
 * than silently degrading to segment-level accuracy.
 */
export class OpenAiWhisperTranscription implements TranscriptionProvider {
  readonly name = 'openai-whisper';
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAiWhisperOptions) {
    this.model = options.model ?? 'whisper-1';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  }

  isConfigured(): boolean {
    return this.options.apiKey.length > 0;
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    if (!this.isConfigured()) {
      throw new TranscriptionError('OPENAI_API_KEY is not set', this.name, false);
    }
    if (!input.audioPath) {
      throw new TranscriptionError('This provider needs a local audio file', this.name, false);
    }

    const bytes = await readFile(input.audioPath);
    // The hosted endpoint caps uploads at 25 MB; 16 kHz mono PCM is ~32 kB/s, so that
    // is roughly 13 minutes. Say so plainly instead of failing with a raw 413.
    const MAX_BYTES = 25 * 1024 * 1024;
    if (bytes.byteLength > MAX_BYTES) {
      throw new TranscriptionError(
        `Audio is ${(bytes.byteLength / 1024 / 1024).toFixed(0)} MB, above the hosted Whisper 25 MB limit. ` +
          'Use TRANSCRIPTION_PROVIDER=deepgram or faster-whisper for long recordings.',
        this.name,
        false,
      );
    }

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), basename(input.audioPath));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (input.language) form.append('language', input.language);

    input.onProgress?.(0.05);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: input.signal,
      });
    } catch (error: unknown) {
      throw new TranscriptionError('Could not reach the OpenAI API', this.name, true, { cause: error });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      throw new TranscriptionError(
        `OpenAI returned ${response.status}: ${text.slice(0, 300)}`,
        this.name,
        retryable,
      );
    }

    input.onProgress?.(0.9);
    const payload = (await response.json()) as VerboseJsonResponse;
    const rawWords = payload.words ?? [];
    if (rawWords.length === 0) {
      throw new TranscriptionError(
        'Whisper returned no word timings. Word-level timestamps are required to place cuts.',
        this.name,
        false,
      );
    }

    // Whisper does not give per-word confidence; derive it from the containing
    // segment's average log-probability rather than inventing a flat 1.0.
    const words: TranscriptWord[] = rawWords.map((word) => ({
      text: word.word,
      start: word.start,
      end: word.end,
      confidence: confidenceAt(payload.segments ?? [], word.start),
    }));

    input.onProgress?.(1);
    return {
      words,
      language: payload.language ?? input.language ?? null,
      provider: this.name,
      model: this.model,
      confidence: averageConfidence(words),
      raw: payload,
    };
  }
}

function confidenceAt(
  segments: readonly { start: number; end: number; avg_logprob?: number; no_speech_prob?: number }[],
  time: number,
): number {
  const segment = segments.find((candidate) => time >= candidate.start && time <= candidate.end);
  if (!segment || segment.avg_logprob === undefined) return 0.9;
  // avg_logprob is a log probability; exp() maps it back into 0..1.
  const fromLogprob = Math.exp(segment.avg_logprob);
  const speech = 1 - (segment.no_speech_prob ?? 0);
  return Math.max(0, Math.min(1, fromLogprob * speech));
}
