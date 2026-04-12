/**
 * Memgine v2 — Text utilities for seed matching.
 *
 * Tokenization, stemming, synonym expansion — ported from Rust reference.
 * Pure synchronous TypeScript, no dependencies.
 */

// ── Tokenizer ──────────────────────────────────────────────────────────────────

/** Tokenize text on common delimiters for seed matching. */
export function tokenize(text: string): Set<string> {
  const result = new Set<string>();
  const parts = text.split(/[\s/:\-_.,]+/);
  for (const p of parts) {
    const t = p.trim().toLowerCase();
    if (t.length > 0) {
      result.add(t);
    }
  }
  return result;
}

// ── Stemmer ────────────────────────────────────────────────────────────────────

const SUFFIXES = [
  "ation",
  "tion",
  "ment",
  "ness",
  "able",
  "ible",
  "ence",
  "ance",
  "ing",
  "ful",
  "ous",
  "ive",
  "ize",
  "ise",
  "ify",
  "ate",
  "ed",
  "er",
  "ly",
  "al",
  "es",
];

/** Minimal suffix-stripping stemmer. Minimum stem length 3. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length < 4) {
    return w;
  }

  for (const suffix of SUFFIXES) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, w.length - suffix.length);
      if (s.length >= 3) {
        return s;
      }
    }
  }
  // Trailing 's' (but not 'ss')
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) {
    return w.slice(0, w.length - 1);
  }
  return w;
}

// ── Synonym Groups ─────────────────────────────────────────────────────────────

const SYNONYM_GROUPS: string[][] = [
  ["auth", "authenticate", "authorization", "credential", "login", "jwt", "token", "verify"],
  ["db", "database", "sql", "query", "postgres", "sqlite", "mysql"],
  ["err", "error", "exception", "panic", "fail", "failure"],
  ["config", "configuration", "setting", "preference", "option"],
  ["msg", "message", "notification", "alert", "event"],
  ["req", "request", "http", "api", "endpoint", "route"],
  ["resp", "response", "reply", "result", "output"],
  ["mem", "memory", "cache", "buffer", "storage"],
  ["exec", "execute", "run", "invoke", "call", "dispatch"],
  ["parse", "deserialize", "decode", "unmarshal", "extract"],
  ["serial", "serialize", "encode", "marshal", "format"],
  ["nav", "navigate", "redirect", "goto"],
];

/** Find synonym expansions for a token. */
export function synonymExpand(token: string): Set<string> {
  const result = new Set<string>();
  const lower = token.toLowerCase();
  const stemmed = stem(lower);
  for (const group of SYNONYM_GROUPS) {
    const matches = group.some((t) => t === lower || stem(t) === stemmed);
    if (matches) {
      for (const t of group) {
        result.add(t);
      }
    }
  }
  return result;
}
