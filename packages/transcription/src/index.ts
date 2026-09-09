import { loadConfig } from "@raw-edit/config";
import {
  AppError,
  type TranscriptionInput,
  type TranscriptionResult,
  type TranscriptSegment,
  type Word,
} from "@raw-edit/contracts";

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

function wordsFromSegment(text: string, startMs: number, endMs: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const span = Math.max(1, endMs - startMs);
  return tokens.map((token, index) => {
    const start = startMs + Math.round((index / tokens.length) * span);
    const end = startMs + Math.round(((index + 1) / tokens.length) * span);
    return { text: token, startMs: start, endMs: end };
  });
}

export function createOpenAiWhisperProvider(apiKey = loadConfig().transcriptionApiKey): TranscriptionProvider {
  return {
    name: "openai-whisper",
    async transcribe(input) {
      if (!apiKey) throw new AppError("TRANSCRIPTION_FAILED", "TRANSCRIPTION_API_KEY is not configured", 500);
      const { default: fs } = await import("node:fs");
      const form = new FormData();
      form.set("model", process.env.OPENAI_TRANSCRIPTION_MODEL ?? "whisper-1");
      form.set("response_format", "verbose_json");
      form.set("timestamp_granularities[]", "word");
      form.set("timestamp_granularities[]", "segment");
      const bytes = fs.readFileSync(input.audioPath);
      form.set("file", new Blob([bytes], { type: "audio/wav" }), "transcription.wav");
      if (input.language) form.set("language", input.language);
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!response.ok) {
        throw new AppError("TRANSCRIPTION_FAILED", `OpenAI transcription failed: ${response.status}`, 502);
      }
      const json = (await response.json()) as {
        text?: string;
        duration?: number;
        language?: string;
        words?: Array<{ word: string; start: number; end: number }>;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      const words: Word[] = (json.words ?? []).map((word) => ({
        text: word.word,
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
      }));
      const segments: TranscriptSegment[] = (json.segments ?? []).map((segment) => {
        const startMs = Math.round(segment.start * 1000);
        const endMs = Math.round(segment.end * 1000);
        const segmentWords = words.filter((word) => word.startMs >= startMs && word.endMs <= endMs + 20);
        return {
          startMs,
          endMs,
          text: segment.text.trim(),
          words: segmentWords.length > 0 ? segmentWords : wordsFromSegment(segment.text, startMs, endMs),
        };
      });
      if (segments.length === 0) {
        throw new AppError("TRANSCRIPTION_FAILED", "Provider returned no timed segments", 502);
      }
      return {
        provider: "openai",
        model: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "whisper-1",
        language: json.language,
        fullText: json.text ?? segments.map((segment) => segment.text).join(" "),
        durationMs: Math.round((json.duration ?? 0) * 1000),
        segments,
      };
    },
  };
}

export function createFasterWhisperProvider(baseUrl = loadConfig().fasterWhisperUrl): TranscriptionProvider {
  return {
    name: "faster-whisper",
    async transcribe(input) {
      if (!baseUrl) throw new AppError("TRANSCRIPTION_FAILED", "FASTER_WHISPER_URL is not configured", 500);
      const { default: fs } = await import("node:fs");
      const form = new FormData();
      form.set("file", new Blob([fs.readFileSync(input.audioPath)]), "transcription.wav");
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw new AppError("TRANSCRIPTION_FAILED", `faster-whisper failed: ${response.status}`, 502);
      }
      const json = (await response.json()) as TranscriptionResult;
      if (!json.segments?.every((segment) => segment.words?.length)) {
        throw new AppError("TRANSCRIPTION_FAILED", "faster-whisper response lacked word timestamps", 502);
      }
      return { ...json, provider: json.provider ?? "faster-whisper" };
    },
  };
}

export function createDeepgramProvider(apiKey = loadConfig().transcriptionApiKey): TranscriptionProvider {
  return {
    name: "deepgram",
    async transcribe(input) {
      if (!apiKey) throw new AppError("TRANSCRIPTION_FAILED", "TRANSCRIPTION_API_KEY is not configured", 500);
      const { default: fs } = await import("node:fs");
      const audio = fs.readFileSync(input.audioPath);
      const response = await fetch(
        "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": "audio/wav",
          },
          body: audio,
        },
      );
      if (!response.ok) {
        throw new AppError("TRANSCRIPTION_FAILED", `Deepgram failed: ${response.status}`, 502);
      }
      const json = (await response.json()) as {
        results?: {
          utterances?: Array<{
            start: number;
            end: number;
            transcript: string;
            words?: Array<{ word: string; start: number; end: number; confidence?: number }>;
          }>;
        };
      };
      const utterances = json.results?.utterances ?? [];
      const segments: TranscriptSegment[] = utterances.map((utterance) => ({
        startMs: Math.round(utterance.start * 1000),
        endMs: Math.round(utterance.end * 1000),
        text: utterance.transcript,
        words: (utterance.words ?? []).map((word) => ({
          text: word.word,
          startMs: Math.round(word.start * 1000),
          endMs: Math.round(word.end * 1000),
          confidence: word.confidence,
        })),
      }));
      if (segments.some((segment) => segment.words.length === 0)) {
        throw new AppError("TRANSCRIPTION_FAILED", "Deepgram response lacked word timestamps", 502);
      }
      return {
        provider: "deepgram",
        model: "nova-2",
        fullText: segments.map((segment) => segment.text).join(" "),
        durationMs: segments.at(-1)?.endMs ?? 0,
        segments,
      };
    },
  };
}

export function getTranscriptionProvider(name = loadConfig().transcriptionProvider): TranscriptionProvider {
  switch (name) {
    case "faster-whisper":
      return createFasterWhisperProvider();
    case "deepgram":
      return createDeepgramProvider();
    default:
      return createOpenAiWhisperProvider();
  }
}
