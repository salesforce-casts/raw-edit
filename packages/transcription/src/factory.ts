import type { TranscriptionProvider } from '@rawedit/core';
import { DeepgramTranscription } from './deepgram.js';
import { OpenAiWhisperTranscription } from './openai-whisper.js';
import { FasterWhisperTranscription } from './faster-whisper.js';

export type TranscriptionProviderId = 'deepgram' | 'openai-whisper' | 'faster-whisper';

/**
 * The one place a transcription provider is chosen.
 *
 * Switching vendor is `TRANSCRIPTION_PROVIDER=faster-whisper` plus its key — no code
 * in the app or the worker refers to a specific vendor.
 */
export function createTranscriptionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionProvider {
  const requested = (env['TRANSCRIPTION_PROVIDER'] ?? '').toLowerCase().trim();
  const id: TranscriptionProviderId = isKnown(requested) ? requested : inferDefault(env);

  switch (id) {
    case 'deepgram': {
      const apiKey = env['DEEPGRAM_API_KEY'];
      if (!apiKey) {
        throw new Error('TRANSCRIPTION_PROVIDER=deepgram but DEEPGRAM_API_KEY is not set.');
      }
      return new DeepgramTranscription({ apiKey, model: env['DEEPGRAM_MODEL'] });
    }
    case 'openai-whisper': {
      const apiKey = env['OPENAI_API_KEY'];
      if (!apiKey) {
        throw new Error('TRANSCRIPTION_PROVIDER=openai-whisper but OPENAI_API_KEY is not set.');
      }
      return new OpenAiWhisperTranscription({ apiKey, model: env['OPENAI_WHISPER_MODEL'] });
    }
    case 'faster-whisper':
      return new FasterWhisperTranscription({
        model: env['FASTER_WHISPER_MODEL'],
        pythonPath: env['PYTHON_PATH'],
      });
    default: {
      const exhaustive: never = id;
      throw new Error(`Unhandled transcription provider: ${String(exhaustive)}`);
    }
  }
}

function isKnown(value: string): value is TranscriptionProviderId {
  return value === 'deepgram' || value === 'openai-whisper' || value === 'faster-whisper';
}

/** With nothing configured, pick whichever credential is present. */
function inferDefault(env: NodeJS.ProcessEnv): TranscriptionProviderId {
  if (env['DEEPGRAM_API_KEY']) return 'deepgram';
  if (env['OPENAI_API_KEY']) return 'openai-whisper';
  return 'faster-whisper';
}
