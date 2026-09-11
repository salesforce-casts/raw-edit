import type { Word } from "./types";
import type { MsRange } from "./ranges";

type TimedOutputWord = Word & { outputStartMs: number; outputEndMs: number };

function srtTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const milliseconds = safe % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function buildEditedTimelineSrt(words: Word[], keepRanges: MsRange[]): string {
  const orderedRanges = [...keepRanges].sort((a, b) => a.startMs - b.startMs);
  const outputWords: TimedOutputWord[] = [];
  let outputCursor = 0;
  for (const range of orderedRanges) {
    const selected = words.filter((word) => {
      const center = (word.startMs + word.endMs) / 2;
      return center >= range.startMs && center < range.endMs;
    });
    for (const word of selected) {
      outputWords.push({
        ...word,
        outputStartMs: outputCursor + Math.max(0, word.startMs - range.startMs),
        outputEndMs: outputCursor + Math.min(range.endMs - range.startMs, word.endMs - range.startMs),
      });
    }
    outputCursor += Math.max(0, range.endMs - range.startMs);
  }

  const cues: TimedOutputWord[][] = [];
  let current: TimedOutputWord[] = [];
  const flush = () => {
    if (current.length) cues.push(current);
    current = [];
  };
  for (const word of outputWords) {
    const previous = current.at(-1);
    if (previous && (word.outputStartMs - previous.outputEndMs > 700 || current.length >= 12 || word.outputEndMs - current[0].outputStartMs > 4_500)) flush();
    current.push(word);
    if (/[.!?]["'”’)]?$/.test(word.text.trim())) flush();
  }
  flush();

  return cues
    .map((cue, index) => {
      const first = cue[0];
      const last = cue.at(-1)!;
      return `${index + 1}\n${srtTime(first.outputStartMs)} --> ${srtTime(last.outputEndMs)}\n${cue.map((word) => word.text).join(" ")}`;
    })
    .join("\n\n");
}
