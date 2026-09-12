import { describe, expect, it } from "vitest";
import {
  CANONICAL_SCRIPT_PROMPT_VERSION,
  buildNarrativeUnits,
  compileCanonicalScript,
  sourceWordId,
  type CanonicalScriptPlan,
  type Word,
} from "./index";

function timedWords(text: string, startMs = 0): Word[] {
  return text.split(/\s+/).map((token, index) => ({
    text: token,
    startMs: startMs + index * 300,
    endMs: startMs + index * 300 + 240,
  }));
}

function plan(fromWord: number, toWord: number): CanonicalScriptPlan {
  return {
    version: CANONICAL_SCRIPT_PROMPT_VERSION,
    keepSpans: [{
      fromWordId: sourceWordId(fromWord),
      toWordId: sourceWordId(toWord),
      reason: "complete final delivery",
      confidence: 0.98,
    }],
    restoreSpans: [],
  };
}

describe("source-linked canonical script", () => {
  it("keeps the selected complete take and removes earlier near-duplicates", () => {
    const words = timedWords(
      "To start this business you need chocolate base. " +
      "To start this business you need chocolate base and gold foil decorative paper. " +
      "To start this business you would need chocolate base and gold foiled decorative papers.",
    );
    const units = buildNarrativeUnits(words);
    expect(units).toHaveLength(3);
    const final = units[2];
    const compiled = compileCanonicalScript(plan(final.fromWord, final.toWord), words, words.at(-1)!.endMs + 500);

    expect(compiled.keptSourceRanges).toEqual([{ startMs: final.startMs, endMs: final.endMs }]);
    expect(compiled.removals.some((cut) => cut.startMs === 0 && cut.endMs <= final.startMs)).toBe(true);
  });

  it("restores only the exact unique process step requested by the safety review", () => {
    const words = timedWords(
      "The process is super simple. First, you need to melt the chocolate. Then you need to load it into the cartridge.",
    );
    const units = buildNarrativeUnits(words);
    expect(units).toHaveLength(3);
    const unsafePlan: CanonicalScriptPlan = {
      version: CANONICAL_SCRIPT_PROMPT_VERSION,
      keepSpans: [
        {
          fromWordId: sourceWordId(units[0].fromWord),
          toWordId: sourceWordId(units[0].toWord),
          reason: "introduction",
          confidence: 0.99,
        },
        {
          fromWordId: sourceWordId(units[2].fromWord),
          toWordId: sourceWordId(units[2].toWord),
          reason: "second step",
          confidence: 0.99,
        },
      ],
      restoreSpans: [
        {
          fromWordId: sourceWordId(units[1].fromWord),
          toWordId: sourceWordId(units[1].toWord),
          reason: "unique first step",
          confidence: 0.99,
        },
      ],
    };
    const compiled = compileCanonicalScript(unsafePlan, words, words.at(-1)!.endMs);
    const kept = new Set(compiled.keepWordIndexes);

    for (let index = units[1].fromWord; index <= units[1].toWord; index += 1) expect(kept.has(index)).toBe(true);
    expect(compiled.restoredUnitCount).toBe(1);
  });

  it("does not expand an exact source span into surrounding retakes", () => {
    const words = timedWords(
      "Instead of creating regular chocolates and competing with other markets " +
      "instead of creating regular chocolates and competing with other markets " +
      "instead of creating homemade chocolates and competing with other markets you need to create 3D chocolates.",
    );
    const finalStart = 20;
    const compiled = compileCanonicalScript(plan(finalStart, words.length - 1), words, words.at(-1)!.endMs);

    expect(compiled.keepWordIndexes).toEqual(words.map((_, index) => index).slice(finalStart));
    expect(compiled.keepWordIndexes).not.toContain(0);
    expect(compiled.removals[0]).toMatchObject({ startMs: 0, action: "REMOVE" });
  });

  it("can split a useful passage around an internal repeated phrase", () => {
    const words = timedWords(
      "Then you need to upload the 3D. Then you need to upload the 3D design. Finally the machine deposits chocolate.",
    );
    const compiled = compileCanonicalScript(
      {
        version: CANONICAL_SCRIPT_PROMPT_VERSION,
        keepSpans: [
          {
            fromWordId: sourceWordId(7),
            toWordId: sourceWordId(words.length - 1),
            reason: "complete corrected instruction and continuation",
            confidence: 0.99,
          },
        ],
        restoreSpans: [],
      },
      words,
      words.at(-1)!.endMs,
    );

    expect(compiled.keepWordIndexes).toEqual(words.map((_, index) => index).slice(7));
    expect(compiled.keepWordIndexes).not.toContain(4);
  });

  it("keeps all speech when the canonical plan is empty", () => {
    const words = timedWords("Keep every word when selection fails.");
    const compiled = compileCanonicalScript(
      { version: CANONICAL_SCRIPT_PROMPT_VERSION, keepSpans: [], restoreSpans: [] },
      words,
      words.at(-1)!.endMs,
    );
    expect(compiled.removals).toEqual([]);
    expect(compiled.keepWordIndexes).toHaveLength(words.length);
    expect(compiled.warning).toContain("all speech was kept");
  });
});
