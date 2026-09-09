# 7. Retake Detection

The product exists for this algorithm. It is deterministic first, AI second, and it
never lets a model touch a timestamp.

## Worked example

```
 0.00–4.10  "Today I'll show you three business ideas..."
 4.10–5.90  (silence)
 5.90–7.40  "Today I'll show you..."
 7.40–9.20  (silence)
 9.20–15.8  "Today I'll show you three business ideas that you can start
             under fifty thousand rupees."
```

Expected result: remove `0.00–4.10` and `5.90–7.40`, keep `9.20–15.8`.

## Step 1 — Segmentation

`segmentWords(words, { gapSeconds: 0.45 })` groups word-level transcript output into
utterances, splitting when the gap between two words is ≥ `gapSeconds` **or** the
previous word ends a sentence (`.`, `!`, `?`) and the gap is ≥ 0.2 s.

Each segment records `internalPauseCount` (internal gaps ≥ 0.8 s) and
`endsWithSentenceTerminator`.

## Step 2 — Normalisation

`normalize(text)` → lowercase, strip punctuation, collapse whitespace, expand a small
table of spoken-number and contraction variants (`i'll → i will`, `fifty thousand`
kept as-is). Tokens are compared with a similarity that tolerates transcription
noise: two tokens match if they are equal, or their Levenshtein distance ≤ 1 for
length ≥ 4, or one is a prefix of the other with length ≥ 4.

## Step 3 — Pairwise candidate scoring

For every segment `i`, look ahead over segments `j` within
`lookaheadSegments` (6) **and** `lookaheadSeconds` (60). Compute:

| Signal | Meaning |
|---|---|
| `lcp` | longest common **prefix** in fuzzy-matched tokens |
| `openingScore` | `lcp / min(len_i, len_j)` — a restart always shares its opening |
| `dice` | token-bigram Dice coefficient over the whole pair |
| `containment` | `\|shorter ∩ longer\| / \|shorter\|` — an aborted take is a subset |
| `isPrefixOf` | `tokens_i` is a fuzzy prefix of `tokens_j` (the strongest signal) |

```
score = 0.50·openingScore + 0.25·dice + 0.25·containment
score = max(score, 0.93) when isPrefixOf and lcp ≥ 3
```

A pair is a retake candidate when `lcp ≥ minOpeningTokens` (3, or 2 when the shorter
segment has ≤ 3 tokens) **and** `score ≥ similarityThreshold` (0.72).

Both thresholds are configurable per video.

## Step 4 — Grouping

Candidate pairs are unioned (disjoint-set) into groups, then each group is sorted by
`startTime`. Transitive linking is what handles three or more attempts.

## Step 5 — Choosing the keeper

Every member is scored; **higher is better**:

```
completeness   +3.0  ends with a sentence terminator
               −4.0  is a fuzzy prefix of a later member  (definitively aborted)
               +1.0  is the longest member by token count
content        +1.2 · (tokens / maxTokensInGroup)
fluency        −0.35 · fillerCount
               −0.50 · internalPauseCount
recency        +0.15 · (memberIndex / (memberCount − 1))   ← ties go to the last take
speech rate    −0.40  if words-per-second is > 1.8× the group median (a rushed abort)
```

The highest score wins; on an exact tie the **later** take wins, which is the rule the
brief asks for. Losing members become `REMOVE` decisions of kind `RETAKE`.

`confidence` for each removal is
`clamp(0.55 + 0.35·pairScore + 0.10·scoreMargin, 0, 0.99)`, where `scoreMargin` is the
normalised gap between the winner and this member. Prefix-of-a-later-take removals
floor at 0.90 because that case is not ambiguous.

Each decision carries a human-readable `reason`, e.g.

```json
{
  "startTime": 5.90,
  "endTime": 7.40,
  "decision": "remove",
  "reason": "Incomplete retake — the same sentence is finished at 9.2s.",
  "confidence": 0.94
}
```

## Step 6 — Intra-segment restarts

When the speaker restarts without pausing ("Today I'll show you— today I'll show you
three ideas"), there is only one segment. `detectIntraSegmentRestarts` looks for the
segment's opening n-gram (3–6 tokens) recurring later in the same segment, where the
continuation after the recurrence is strictly longer. It proposes removing
`[segment.start, word[recurrenceIndex].start)`.

## Step 7 — The AI layer

`EditAdvisor` is an interface:

```ts
interface EditAdvisor {
  arbitrate(groups: TakeGroupForReview[]): Promise<AdvisorVerdict[]>;
}
```

* `HeuristicEditAdvisor` — the default. No network, returns the deterministic pick.
* `LlmEditAdvisor` — optional (`EDIT_ADVISOR=llm`). It is called **only** for groups
  whose top-two score margin is under `ADVISOR_MARGIN` (0.6), it receives only the
  candidate *texts* and their indices, and it may only return an index from that list
  plus a one-sentence reason. A malformed or out-of-range answer is discarded and the
  deterministic pick stands. It cannot create, move or delete a cut.

This is the "deterministic algorithms plus AI" split the brief asks for: the model
arbitrates ambiguous English, the code owns the timeline.

## Guarantees

* Nothing is ever deleted from the source. Removals are rows in `edit_decision`.
* Every automatic decision has `startTime`, `endTime`, `decision`, `reason`,
  `confidence`.
* Detection is deterministic given the same transcript and settings, so
  "Reset automatic edits" reproduces the original proposal exactly without re-running
  transcription.
