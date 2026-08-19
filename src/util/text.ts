/**
 * The text functions search is built on: what goes into the index, and how close two terms are.
 *
 * Pure and dependency-free on purpose. These decide what a query can ever match, so they are worth
 * reading and testing without a database in the way (tests/search-text.test.mjs). They live here
 * rather than in db/mongo.ts because nothing about them is Mongo — the storage layer only happens
 * to be where the output is written.
 *
 * Every function takes its limits as arguments and keeps no state between calls, so indexing a
 * message and ranking a query are reproducible from their inputs alone.
 */

/** Splits on anything that isn't a letter or digit. Unicode-aware, so non-Latin text survives. */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

/**
 * Splits a message body into the tokens stored in `bodyTokens`, which back prefix search.
 *
 * Deliberately simple: lowercase, split, drop empties. Long tokens are truncated and the count is
 * capped, so one enormous message can't produce an enormous index entry.
 */
export function tokenizeBody(body: string, maxTokenLength: number, maxTokens: number): string[] {
  const seen = new Set<string>();
  for (const raw of body.toLowerCase().split(SEPARATORS)) {
    if (!raw) continue;
    seen.add(raw.slice(0, maxTokenLength));
    if (seen.size >= maxTokens) break;
  }
  return [...seen];
}

/**
 * The sliding three-character windows of one term: "design" -> des, esi, sig, ign.
 *
 * This is what makes typo tolerance an index lookup instead of a scan. A misspelling keeps most of
 * its windows ("desgin" -> des, esg, sgi, gin), so the original is still reachable — including when
 * the typo is in the *first* character, which prefix matching can never recover from.
 *
 * Terms shorter than three characters yield themselves, so short words stay reachable rather than
 * silently dropping out of the fuzzy path.
 */
export function trigramsOf(term: string): string[] {
  const lower = term.toLowerCase();
  if (lower.length < 3) return lower ? [lower] : [];

  const seen = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) seen.add(lower.slice(i, i + 3));
  return [...seen];
}

/**
 * The trigrams stored on a message: every token's windows, de-duplicated and capped.
 *
 * Capped for the same reason `bodyTokens` is — one very long message must not be allowed to write
 * an unbounded index entry.
 */
export function bodyTrigramsOf(
  body: string,
  maxTokenLength: number,
  maxTokens: number,
  maxTrigrams: number,
): string[] {
  const seen = new Set<string>();
  for (const token of tokenizeBody(body, maxTokenLength, maxTokens)) {
    for (const trigram of trigramsOf(token)) {
      seen.add(trigram);
      if (seen.size >= maxTrigrams) return [...seen];
    }
  }
  return [...seen];
}

/**
 * Levenshtein distance, bailing out once it is certain the result exceeds `ceiling`.
 *
 * Plain Levenshtein rather than Damerau: a transposition costs 2, not 1, which the caller's
 * threshold accounts for. The early exit matters because this runs over every candidate the
 * trigram lookup returns — a candidate that is obviously unrelated should cost one row of the
 * matrix, not the whole thing. When it bails it returns `ceiling + 1`, which is truthful for the
 * only question the caller asks: "is this within the threshold?"
 *
 * Two rolling rows instead of a full matrix, so memory is O(min(a, b)) rather than O(a * b).
 */
export function editDistance(a: string, b: string, ceiling = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  // Length alone can rule a candidate out before any work happens.
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowBest = current[0];

    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        substitution,
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
      );
      if (current[j] < rowBest) rowBest = current[j];
    }

    // Every later row is at least this good, so nothing below the ceiling can still be reached.
    if (rowBest > ceiling) return ceiling + 1;

    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/**
 * How far a query term is from the closest token in a body — the score the fuzzy strategy ranks by.
 *
 * Returns `ceiling + 1` when nothing is close enough, so callers can filter and sort on one number.
 */
export function closestTokenDistance(
  term: string,
  body: string,
  maxTokenLength: number,
  maxTokens: number,
  ceiling: number,
): number {
  let best = ceiling + 1;
  for (const token of tokenizeBody(body, maxTokenLength, maxTokens)) {
    const distance = editDistance(term, token, ceiling);
    if (distance < best) best = distance;
    if (best === 0) break;
  }
  return best;
}

/**
 * How many edits to tolerate for a term of this length.
 *
 * Short terms get a tighter budget: at distance 2, a four-letter word is closer to being a
 * different word than a misspelling of this one, and a loose threshold there turns search into
 * noise. Five characters is where a transposition (which costs 2) becomes worth catching.
 */
export function editThresholdFor(term: string): number {
  if (term.length < 4) return 0;
  return term.length < 5 ? 1 : 2;
}
