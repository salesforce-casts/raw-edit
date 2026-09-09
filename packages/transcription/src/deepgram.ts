import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  TranscriptionError,
  type TranscribeInput,
  type TranscriptionProvider,
  type TranscriptResult,
  type TranscriptWord,
} from '@rawedit/core';

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
}

/**
 * Deepgram, called over plain HTTP rather than the SDK so this package has no
 * provider dependency and the request shape is visible in one place.
 *
 * Word-level timings with punctuation are non-negotiable — `punctuate=true` is what
 * lets the segmenter tell a finished sentence from an abandoned one.
 */
export class DeepgramTranscription implements TranscriptionProvider {
  readonly name = 'deepgram';
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly options: DeepgramOptions) {
    this.model = options.model ?? 'nova-3';
    this.baseUrl = options.baseUrl ?? 'https://api.deepgram.com/v1/listen';
  }

  isConfigured(): boolean {
    return this.options.apiKey.length > 0;
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    if (!this.isConfigured()) {
      throw new TranscriptionError('DEEPGRAM_API_KEY is not set', this.name, false);
    }

    const params = new URLSearchParams({
      model: this.model,
      // Punctuation is what lets the segmenter tell a finished sentence from an
      // abandoned one, so it is required rather than cosmetic.
      punctuate: 'true',
      smart_format: 'true',
      utterances: 'false',
    });
    if (input.language) params.set('language', input.language);
    else params.set('detect_language', 'true');

    const url = `${this.baseUrl}?${params.toString()}`;
    const { body, contentType, contentLength } = await this.buildBody(input);

    input.onProgress?.(0.05);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.options.apiKey}`,
          'Content-Type': contentType,
          ...(contentLength !== undefined ? { 'Content-Length': String(contentLength) } : {}),
        },
        body,
        // Node needs this to stream a request body rather than buffering it.
        ...(body instanceof Readable ? { duplex: 'half' } : {}),
        signal: input.signal,
      } as RequestInit);
    } catch (error: unknown) {
      throw new TranscriptionError('Could not reach Deepgram', this.name, true, { cause: error });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 429 and 5xx are worth another attempt; 4xx means the request is wrong.
      const retryable = response.status === 429 || response.status >= 500;
      throw new TranscriptionError(
        `Deepgram returned ${response.status}: ${text.slice(0, 300)}`,
        this.name,
        retryable,
      );
    }

    input.onProgress?.(0.9);
    const payload = (await response.json()) as {
      results?: {
        channels?: { alternatives?: { words?: DeepgramWord[]; confidence?: number }[] }[];
      };
      metadata?: { detected_language?: string; model_info?: Record<string, { name?: string }> };
    };

    const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
    const rawWords = alternative?.words ?? [];
    if (rawWords.length === 0) {
      throw new TranscriptionError(
        'Deepgram returned no words — the audio may be silent or contain no speech.',
        this.name,
        false,
      );
    }

    const words: TranscriptWord[] = rawWords.map((word) => ({
      text: word.punctuated_word ?? word.word,
      start: word.start,
      end: word.end,
      confidence: word.confidence ?? 1,
    }));

    input.onProgress?.(1);
    return {
      words,
      language: payload.metadata?.detected_language ?? input.language ?? null,
      provider: this.name,
      model: this.model,
      confidence: alternative?.confidence ?? averageConfidence(words),
      raw: payload,
    };
  }

  private async buildBody(
    input: TranscribeInput,
  ): Promise<{ body: string | Readable; contentType: string; contentLength?: number }> {
    if (input.audioPath) {
      const size = statSync(input.audioPath).size;
      return {
        body: createReadStream(input.audioPath),
        contentType: 'audio/wav',
        contentLength: size,
      };
    }
    if (input.audioUrl) {
      return {
        body: JSON.stringify({ url: input.audioUrl }),
        contentType: 'application/json',
      };
    }
    throw new TranscriptionError('Neither audioPath nor audioUrl was provided', this.name, false);
  }
}

export function averageConfidence(words: readonly TranscriptWord[]): number {
  if (words.length === 0) return 0;
  return words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
}
