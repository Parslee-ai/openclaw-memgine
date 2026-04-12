/**
 * Memgine v2 Phase B — Heuristic Conversation Compaction + Self-Reflection.
 *
 * Compaction: merge consecutive same-speaker turns, drop low-value exchanges,
 * summarize with first+last sentence extraction.
 * No LLM — pure heuristic for v1.
 *
 * Self-reflection: detect corrections, preferences, and friction from
 * conversation history.
 *
 * Spec ref: Section 4 "Conversation Compaction", Section 8 Phase B.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  speaker: string;
  text: string;
  ts: number;
}

export interface CompactionResult {
  compacted: ConversationTurn[];
  removed: number;
  merged: number;
  original: number;
}

export interface ReflectionInsight {
  type: "correction" | "preference" | "friction";
  speaker: string;
  text: string;
  ts: number;
  /** Original turn text that triggered the insight. */
  source: string;
}

// ── Low-Value Patterns ───────────────────────────────────────────────────────

const LOW_VALUE_PATTERNS = [
  /^(ok|okay|sure|yes|yeah|yep|yup|right|got it|ack|acknowledged|roger|k|👍|✅|np|no problem|sounds good|makes sense|understood|will do|on it|noted)[\s.!]*$/i,
  /^(thanks|thank you|ty|thx|cheers)[\s.!]*$/i,
  /^(hi|hello|hey|yo|sup)[\s.!]*$/i,
  /^(lol|haha|heh|😂|💀|🙌|nice|cool|great|awesome|perfect|sweet|neat)[\s.!]*$/i,
];

function isLowValue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {return true;}
  if (trimmed.length > 100) {return false;} // Long messages are never low-value
  return LOW_VALUE_PATTERNS.some((p) => p.test(trimmed));
}

// ── Consecutive Same-Speaker Merge ───────────────────────────────────────────

/**
 * Merge consecutive turns from the same speaker into one turn.
 * Preserves the timestamp of the first turn in each group.
 */
function mergeConsecutiveSpeaker(turns: ConversationTurn[]): { merged: ConversationTurn[]; mergeCount: number } {
  if (turns.length === 0) {return { merged: [], mergeCount: 0 };}

  const result: ConversationTurn[] = [];
  let current = { ...turns[0] };
  let mergeCount = 0;

  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker === current.speaker) {
      // Same speaker — merge text
      current.text = current.text + "\n" + turns[i].text;
      mergeCount++;
    } else {
      result.push(current);
      current = { ...turns[i] };
    }
  }
  result.push(current);

  return { merged: result, mergeCount };
}

// ── Summarize Long Turn ──────────────────────────────────────────────────────

/**
 * Heuristic summarization: keep first and last sentences.
 * Only applied to turns longer than threshold.
 */
function summarizeTurn(text: string, maxSentences: number = 4): string {
  // Split on sentence boundaries
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length <= maxSentences) {return text;}

  // Keep first 2 and last 2 sentences
  const keepFirst = Math.ceil(maxSentences / 2);
  const keepLast = maxSentences - keepFirst;

  const kept = [
    ...sentences.slice(0, keepFirst),
    `[...${sentences.length - maxSentences} turns omitted...]`,
    ...sentences.slice(-keepLast),
  ];

  return kept.join(" ");
}

// ── Main Compaction ──────────────────────────────────────────────────────────

/**
 * Compact conversation turns using heuristics (no LLM).
 *
 * Strategy:
 * 1. Protect the keep-recent window (last N turns, never compacted)
 * 2. Merge consecutive same-speaker turns
 * 3. Drop low-value exchanges (acks, greetings, filler)
 * 4. Summarize long turns (keep first+last sentences)
 *
 * @param turns - All conversation turns in chronological order
 * @param keepRecentCount - Number of recent turns to protect (default 6 per spec)
 * @param longTurnThreshold - Char count above which a turn gets summarized (default 500)
 */
export function compactConversation(
  turns: ConversationTurn[],
  keepRecentCount: number = 6,
  longTurnThreshold: number = 500,
): CompactionResult {
  const original = turns.length;
  if (original <= keepRecentCount) {
    return { compacted: [...turns], removed: 0, merged: 0, original };
  }

  // Split into compactable zone and keep-recent zone
  const cutoff = Math.max(0, original - keepRecentCount);
  const compactableZone = turns.slice(0, cutoff);
  const recentZone = turns.slice(cutoff);

  // Step 1: Merge consecutive same-speaker turns in compactable zone
  const { merged: afterMerge, mergeCount } = mergeConsecutiveSpeaker(compactableZone);

  // Step 2: Drop low-value turns
  const afterFilter = afterMerge.filter((turn) => !isLowValue(turn.text));
  const droppedCount = afterMerge.length - afterFilter.length;

  // Step 3: Summarize long turns
  const afterSummarize = afterFilter.map((turn) => {
    if (turn.text.length > longTurnThreshold) {
      return { ...turn, text: summarizeTurn(turn.text) };
    }
    return turn;
  });

  // Recombine
  const compacted = [...afterSummarize, ...recentZone];

  return {
    compacted,
    removed: droppedCount,
    merged: mergeCount,
    original,
  };
}

// ── Self-Reflection Detection ────────────────────────────────────────────────

/** Patterns that indicate a correction ("actually X not Y"). */
const CORRECTION_PATTERNS = [
  /\bactually\b.*\bnot\b/i,
  /\bactually,?\s/i,
  /\bwait,?\s.*\bwrong\b/i,
  /\bthat'?s?\s+(incorrect|wrong|not right|not true|inaccurate)\b/i,
  /\bno,?\s+it'?s?\s/i,
  /\bcorrection:/i,
  /\blet me correct\b/i,
  /\bi (was|were) wrong\b/i,
  /\bi meant\b/i,
  /\bsorry,?\s+i meant\b/i,
  /\bto clarify[,:]\b/i,
];

/** Patterns that indicate a preference ("I prefer X", "I like X better"). */
const PREFERENCE_PATTERNS = [
  /\bi (prefer|like|want|need|always|never)\b/i,
  /\bdon'?t\s+(like|want|use|do)\b/i,
  /\bplease\s+(always|never|don'?t)\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\binstead of\b.*\buse\b/i,
  /\bmy preference\b/i,
  /\blet'?s?\s+(always|never)\b/i,
  /\bremember (that|to)\b/i,
  /\bkeep in mind\b/i,
  /\bi'?d?\s+rather\b/i,
];

/** Patterns that indicate friction (repeated asks, frustration). */
const FRICTION_PATTERNS = [
  /\bi (already|just) (said|told|asked|mentioned)\b/i,
  /\bas i (said|mentioned|noted)\b/i,
  /\bagain,?\s/i,
  /\bfor the (\d+)(st|nd|rd|th) time\b/i,
  /\bhow many times\b/i,
  /\bdidn'?t (you|we) (already|just)\b/i,
  /\brepeat(ing)?\b/i,
  /\bstill (not|hasn'?t|haven'?t|waiting)\b/i,
  /\bthis is (frustrat|annoy)/i,
  /\bwhy (isn'?t|hasn'?t|haven'?t|doesn'?t|don'?t)\b/i,
];

/**
 * Detect self-reflection insights from conversation history.
 *
 * Scans for:
 * - Corrections: "actually X not Y", "I was wrong about..."
 * - Preferences: "I prefer X", "always use Y", "don't do Z"
 * - Friction: repeated asks, frustration signals
 */
export function detectReflections(turns: ConversationTurn[]): ReflectionInsight[] {
  const insights: ReflectionInsight[] = [];

  for (const turn of turns) {
    const text = turn.text;

    // Check corrections
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(text)) {
        insights.push({
          type: "correction",
          speaker: turn.speaker,
          text: extractRelevantSentence(text, pattern),
          ts: turn.ts,
          source: text,
        });
        break; // One insight per type per turn
      }
    }

    // Check preferences
    for (const pattern of PREFERENCE_PATTERNS) {
      if (pattern.test(text)) {
        insights.push({
          type: "preference",
          speaker: turn.speaker,
          text: extractRelevantSentence(text, pattern),
          ts: turn.ts,
          source: text,
        });
        break;
      }
    }

    // Check friction
    for (const pattern of FRICTION_PATTERNS) {
      if (pattern.test(text)) {
        insights.push({
          type: "friction",
          speaker: turn.speaker,
          text: extractRelevantSentence(text, pattern),
          ts: turn.ts,
          source: text,
        });
        break;
      }
    }
  }

  return insights;
}

/**
 * Extract the sentence containing the matched pattern.
 */
function extractRelevantSentence(text: string, pattern: RegExp): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (pattern.test(sentence)) {
      return sentence.trim();
    }
  }
  // Fallback: return first 200 chars
  return text.length > 200 ? text.slice(0, 200) + "..." : text;
}
