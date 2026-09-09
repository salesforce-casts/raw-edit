import {
  HeuristicEditAdvisor,
  type AdvisorVerdict,
  type EditAdvisor,
  type TakeGroupForReview,
} from '@rawedit/core';

export interface LlmEditAdvisorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Hard ceiling on groups sent per video, so one long recording cannot run away. */
  maxGroups?: number;
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You judge which of several attempts at the same spoken sentence a video editor should keep.

You will be given numbered candidates, in the order they were spoken. Choose the one that reads as the most complete, fluent, finished delivery of the line. Prefer a complete sentence over a fragment, fewer stumbles and filler words, and — when two candidates are equally good — the later attempt.

Reply with JSON only, in this exact shape:
{"choice": <number>, "reason": "<one short sentence>", "confidence": <0..1>}

"choice" must be one of the candidate numbers shown. Do not add commentary.`;

/**
 * The optional AI layer.
 *
 * It is shown candidate *text* and returns a candidate *index*. It never sees a
 * timestamp, never proposes a cut, and every answer is validated against the
 * candidate list before it is applied — a malformed or out-of-range reply is
 * discarded and the deterministic pick stands. This is what keeps the model out of
 * the timeline while still letting it arbitrate ambiguous English.
 */
export class LlmEditAdvisor implements EditAdvisor {
  readonly name = 'llm';
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly options: LlmEditAdvisorOptions) {
    this.model = options.model ?? 'claude-sonnet-5';
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com/v1/messages';
  }

  async arbitrate(groups: TakeGroupForReview[]): Promise<AdvisorVerdict[]> {
    const limited = groups.slice(0, this.options.maxGroups ?? 25);
    const verdicts = await Promise.all(limited.map((group) => this.judge(group)));
    return verdicts.filter((verdict): verdict is AdvisorVerdict => verdict !== null);
  }

  private async judge(group: TakeGroupForReview): Promise<AdvisorVerdict | null> {
    const candidates = group.candidates
      .map((candidate) => `${candidate.index}. ${candidate.text}`)
      .join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Candidates:\n${candidates}` }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      const text = payload.content?.find((block) => block.type === 'text')?.text ?? '';
      return this.parseVerdict(group, text);
    } catch {
      // An advisor failure is never fatal: the deterministic pick is already valid.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Every field is validated; anything unexpected means we keep the local decision. */
  private parseVerdict(group: TakeGroupForReview, text: string): AdvisorVerdict | null {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;

    let parsed: { choice?: unknown; reason?: unknown; confidence?: unknown };
    try {
      parsed = JSON.parse(match[0]) as typeof parsed;
    } catch {
      return null;
    }

    const choice = Number(parsed.choice);
    const valid = group.candidates.some((candidate) => candidate.index === choice);
    if (!Number.isInteger(choice) || !valid) return null;

    const confidence = Number(parsed.confidence);
    return {
      groupId: group.groupId,
      chosenIndex: choice,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : '',
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7,
    };
  }
}

/**
 * Advisors are opt-in. With nothing configured the system stays fully deterministic,
 * which is the documented default.
 */
export function createEditAdvisorFromEnv(env: NodeJS.ProcessEnv = process.env): EditAdvisor {
  const mode = (env['EDIT_ADVISOR'] ?? 'heuristic').toLowerCase().trim();
  if (mode !== 'llm') return new HeuristicEditAdvisor();

  const apiKey = env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    // Falling back silently beats failing every analysis job over an optional feature.
    console.warn('EDIT_ADVISOR=llm but ANTHROPIC_API_KEY is not set; using the deterministic advisor.');
    return new HeuristicEditAdvisor();
  }

  return new LlmEditAdvisor({
    apiKey,
    model: env['EDIT_ADVISOR_MODEL'],
    maxGroups: env['EDIT_ADVISOR_MAX_GROUPS'] ? Number(env['EDIT_ADVISOR_MAX_GROUPS']) : undefined,
  });
}
