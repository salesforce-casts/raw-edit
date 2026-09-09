import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TranscriptionError,
  type TranscribeInput,
  type TranscriptionProvider,
  type TranscriptResult,
  type TranscriptWord,
} from '@rawedit/core';
import { averageConfidence } from './deepgram.js';

export interface FasterWhisperOptions {
  /** Python entry point. The worker image installs `faster-whisper` into this. */
  pythonPath?: string;
  model?: string;
  device?: 'cpu' | 'cuda' | 'auto';
  computeType?: string;
  beamSize?: number;
}

/**
 * Self-hosted faster-whisper, run as a subprocess inside the worker container.
 *
 * Chosen when there is no per-minute budget or when audio must not leave the
 * infrastructure. The Python side is a small script embedded here so the image does
 * not need a second source tree; it prints one JSON document on stdout and streams
 * progress markers on stderr.
 */
export class FasterWhisperTranscription implements TranscriptionProvider {
  readonly name = 'faster-whisper';
  readonly model: string;
  private readonly python: string;

  constructor(private readonly options: FasterWhisperOptions = {}) {
    this.model = options.model ?? process.env['FASTER_WHISPER_MODEL'] ?? 'base.en';
    this.python = options.pythonPath ?? process.env['PYTHON_PATH'] ?? 'python3';
  }

  isConfigured(): boolean {
    // Availability is proved by the process starting; a missing interpreter surfaces
    // as a clear PermanentError on the first job rather than a silent fallback.
    return true;
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    if (!input.audioPath) {
      throw new TranscriptionError('faster-whisper needs a local audio file', this.name, false);
    }

    const outputPath = join(tmpdir(), `fw-${randomUUID()}.json`);
    const args = [
      '-c',
      PYTHON_SCRIPT,
      input.audioPath,
      outputPath,
      this.model,
      this.options.device ?? process.env['FASTER_WHISPER_DEVICE'] ?? 'auto',
      this.options.computeType ?? process.env['FASTER_WHISPER_COMPUTE'] ?? 'int8',
      String(this.options.beamSize ?? 5),
      input.language ?? '',
    ];

    try {
      await this.run(args, input);
      const raw = JSON.parse(await readFile(outputPath, 'utf8')) as {
        language?: string;
        words?: { word: string; start: number; end: number; probability?: number }[];
        error?: string;
      };

      if (raw.error) throw new TranscriptionError(raw.error, this.name, false);
      const rawWords = raw.words ?? [];
      if (rawWords.length === 0) {
        throw new TranscriptionError('No speech was detected in the audio.', this.name, false);
      }

      const words: TranscriptWord[] = rawWords.map((word) => ({
        text: word.word.trim(),
        start: word.start,
        end: word.end,
        confidence: word.probability ?? 0.9,
      }));

      return {
        words,
        language: raw.language ?? input.language ?? null,
        provider: this.name,
        model: this.model,
        confidence: averageConfidence(words),
      };
    } finally {
      await rm(outputPath, { force: true });
    }
  }

  private run(args: string[], input: TranscribeInput): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
        // The script prints `PROGRESS <seconds done>` as it consumes the audio.
        for (const match of text.matchAll(/PROGRESS\s+([\d.]+)/g)) {
          const done = Number.parseFloat(match[1]!);
          if (input.durationSeconds && input.durationSeconds > 0 && Number.isFinite(done)) {
            input.onProgress?.(Math.min(0.99, done / input.durationSeconds));
          }
        }
      });

      input.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

      child.on('error', (error) => {
        reject(
          new TranscriptionError(
            `Could not start ${this.python}. Is faster-whisper installed in this image?`,
            this.name,
            false,
            { cause: error },
          ),
        );
      });

      child.on('close', (code) => {
        if (code === 0) {
          input.onProgress?.(1);
          resolve();
        } else {
          reject(
            new TranscriptionError(
              `faster-whisper exited with code ${code}: ${stderr.slice(-500)}`,
              this.name,
              // A killed process (OOM, container restart) is worth one more attempt.
              code === null || code === 137,
            ),
          );
        }
      });
    });
  }
}

/**
 * Kept inline so the Docker image only needs `pip install faster-whisper` and no
 * second source tree to keep in sync.
 */
const PYTHON_SCRIPT = `
import json, sys
audio_path, out_path, model_name, device, compute_type, beam_size, language = sys.argv[1:8]
try:
    from faster_whisper import WhisperModel
except ImportError:
    json.dump({"error": "faster-whisper is not installed in this image"}, open(out_path, "w"))
    sys.exit(0)

try:
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        audio_path,
        beam_size=int(beam_size),
        word_timestamps=True,
        language=language or None,
        vad_filter=False,
    )

    words = []
    for segment in segments:
        print("PROGRESS %.2f" % segment.end, file=sys.stderr, flush=True)
        for word in (segment.words or []):
            words.append({
                "word": word.word,
                "start": round(word.start, 4),
                "end": round(word.end, 4),
                "probability": round(getattr(word, "probability", 0.9), 4),
            })

    with open(out_path, "w") as handle:
        json.dump({"language": info.language, "words": words}, handle)
except Exception as exc:
    with open(out_path, "w") as handle:
        json.dump({"error": str(exc)}, handle)
    sys.exit(1)
`;
