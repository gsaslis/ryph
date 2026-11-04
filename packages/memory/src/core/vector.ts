// The small vector arithmetic hybrid search needs. Pure.

/** Cosine similarity of two vectors; 0 for a length mismatch or a zero vector. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * A cosine similarity as a relevance in [0, 1]. Sentence embeddings rarely go below ~0.3 even
 * for unrelated text, so the useful range is rescaled: 0.35 and under is 0, 0.9 and over is 1.
 */
export function relevanceOf(similarity: number): number {
  const floor = 0.35;
  const ceiling = 0.9;
  return Math.min(1, Math.max(0, (similarity - floor) / (ceiling - floor)));
}

/** Whether a vector-only match counts as a match at all for `matchOnly` searches. */
export const VECTOR_MATCH_FLOOR = 0.5;
