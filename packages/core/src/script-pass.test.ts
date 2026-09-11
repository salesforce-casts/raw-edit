import { describe, expect, it } from "vitest";
import {
  applyScriptPassGuards,
  buildIndexedScript,
  chunkWordRanges,
  mapDecisionToSegment,
  scriptPassCacheKey,
  validateScriptPassDecision,
} from "./script-pass";
import type { Word } from "./types";

const words: Word[] = [
  { text: "Today", startMs: 0, endMs: 400 },
  { text: "I'll", startMs: 400, endMs: 700 },
  { text: "show", startMs: 700, endMs: 1000 },
  { text: "you", startMs: 1000, endMs: 1200 },
  { text: "sorry", startMs: 2000, endMs: 2400 },
  { text: "Today", startMs: 4000, endMs: 4400 },
  { text: "I'll", startMs: 4400, endMs: 4700 },
  { text: "show", startMs: 4700, endMs: 5000 },
  { text: "you", startMs: 5000, endMs: 5300 },
];

describe("script pass", () => {
  it("builds the script from the same word array with stable ordinals", () => {
    const script = buildIndexedScript(words);
    expect(script.split("\n")[4]).toBe("4\tsorry");
    expect(script.split("\n")).toHaveLength(words.length);
  });

  it("chunks with 200-word overlap so a restart spanning a boundary is visible twice", () => {
    const chunks = chunkWordRanges(1600, 1500, 200);
    expect(chunks[0]).toEqual({ fromWord: 0, toWord: 1499 });
    expect(chunks[1]?.fromWord).toBe(1300);
  });

  it("rejects out-of-range indices instead of clamping them", () => {
    const result = validateScriptPassDecision(
      { fromWord: 0, toWord: 99, category: "retake", reason: "duplicate", confidence: 0.9 },
      words.length,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("index out of range");
  });

  it("rejects a decision with no reason", () => {
    const result = validateScriptPassDecision(
      { fromWord: 4, toWord: 4, category: "falseStart", reason: "  ", confidence: 0.9 },
      words.length,
    );
    expect(result.ok).toBe(false);
  });

  it("maps index ranges to ms from the timestamped word array", () => {
    const segment = mapDecisionToSegment(
      { fromWord: 4, toWord: 4, category: "falseStart", reason: "verbal delete", confidence: 0.92 },
      words,
    );
    expect(segment).toMatchObject({ startMs: 2000, endMs: 2400, action: "REMOVE", source: "AUTO_SCRIPT" });
  });

  it("falls back when a batch exceeds the removal budget", () => {
    const result = applyScriptPassGuards(
      [{ fromWord: 0, toWord: 8, category: "tangent", reason: "drop everything", confidence: 0.99 }],
      words,
      5300,
    );
    expect(result.applied).toHaveLength(0);
    expect(result.warning).toMatch(/too much/);
  });

  it("shows below-floor decisions without applying them", () => {
    const result = applyScriptPassGuards(
      [{ fromWord: 4, toWord: 4, category: "falseStart", reason: "maybe a stumble", confidence: 0.4 }],
      words,
      5300,
    );
    expect(result.applied).toHaveLength(0);
    expect(result.unapplied[0]?.action).toBe("KEEP");
    expect(result.unapplied[0]?.reason).toBe("maybe a stumble");
  });

  it("keys the cache on transcript + prompt version + model", () => {
    const a = scriptPassCacheKey({ words, promptVersion: "script-pass.v1", model: "gpt-4.1-mini" });
    const b = scriptPassCacheKey({ words, promptVersion: "script-pass.v1", model: "gpt-4.1-mini" });
    const c = scriptPassCacheKey({ words, promptVersion: "script-pass.v2", model: "gpt-4.1-mini" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
