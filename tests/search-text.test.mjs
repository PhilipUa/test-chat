import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editDistance, tokenizeBody, trigramsOf } from '../src/util/text.ts';

/**
 * The pure text functions behind search indexing and fuzzy ranking.
 *
 * These decide what ends up in `bodyTokens` and `bodyTrigrams` — i.e. what a query can ever match —
 * so they are worth testing without a database in the way. The Mongo-side behaviour (that the
 * trigram index is actually range-scanned rather than collection-scanned) is a separate concern,
 * covered by the integration test and by `explain`.
 */

describe('tokenizeBody', () => {
  it('lowercases and splits on anything that is not a letter or digit', () => {
    assert.deepEqual(tokenizeBody('Hello, World! 42', 32, 200).sort(), ['42', 'hello', 'world']);
  });

  it('keeps non-Latin text intact rather than mangling it', () => {
    // Unicode-aware splitting: the app is not English-only.
    assert.deepEqual(tokenizeBody('привіт світ', 32, 200).sort(), ['привіт', 'світ'].sort());
  });

  it('truncates long tokens and caps how many one message contributes', () => {
    assert.deepEqual(tokenizeBody('abcdefghij', 4, 200), ['abcd']);
    assert.equal(tokenizeBody('a b c d e f g', 32, 3).length, 3);
  });

  it('de-duplicates, so a repeated word costs one index entry', () => {
    assert.deepEqual(tokenizeBody('spam spam spam', 32, 200), ['spam']);
  });
});

describe('trigramsOf', () => {
  it('produces the sliding three-character windows of a term', () => {
    assert.deepEqual(trigramsOf('design'), ['des', 'esi', 'sig', 'ign']);
  });

  it('shares most of its trigrams with a typo of the same word', () => {
    // This is the whole premise of the fuzzy strategy: a typo keeps enough trigrams that the
    // original is still reachable through the index.
    const right = new Set(trigramsOf('design'));
    const typo = trigramsOf('desgin');
    assert.ok(
      typo.some((t) => right.has(t)),
      'a transposition must still share a trigram',
    );

    const firstCharTypo = trigramsOf('fesign');
    assert.ok(
      firstCharTypo.some((t) => right.has(t)),
      'a first-character typo must still share a trigram — this is what prefix search cannot do',
    );
  });

  it('returns the term itself when it is shorter than a trigram', () => {
    // Otherwise two-letter words would be unreachable by the fuzzy path entirely.
    assert.deepEqual(trigramsOf('hi'), ['hi']);
  });

  it('de-duplicates repeated windows', () => {
    assert.deepEqual(trigramsOf('aaaa'), ['aaa']);
  });
});

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    assert.equal(editDistance('design', 'design'), 0);
  });

  it('counts a substitution, an insertion and a deletion as one each', () => {
    assert.equal(editDistance('design', 'fesign'), 1);
    assert.equal(editDistance('design', 'designs'), 1);
    assert.equal(editDistance('design', 'desin'), 1);
  });

  it('counts a transposition as the two edits it is', () => {
    // Plain Levenshtein, not Damerau — a transposition costs 2. The threshold accounts for it.
    assert.equal(editDistance('design', 'desgin'), 2);
  });

  it('stops early once the distance exceeds the ceiling it was given', () => {
    // The ranking only cares whether a candidate is within the threshold, so the implementation is
    // allowed to bail out; it must still report something above the ceiling rather than lying.
    assert.ok(editDistance('design', 'completely-different', 2) > 2);
  });
});
