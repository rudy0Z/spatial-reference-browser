/**
 * app/src/lib/embed.ts — deterministic toy hash embedder (SPEC §8).
 *
 * 384-dim bag-of-words hashing: tokenize → FNV-1a hash each token into one
 * of 384 buckets → count → L2-normalize. Fully deterministic across runs,
 * platforms and reloads (no Math.random, no Date.now, no locale-dependent
 * casing).
 *
 * Same interface the real `all-MiniLM-L6-v2` (transformers.js) will have in
 * Phase 2/3: an embedding is a fixed-length numeric vector per text, and
 * `cosineSimilarity(a, b)` compares two of them. The async facade
 * (`embedTextAsync`) mirrors the real model's async call shape so the swap
 * point stays signature-stable.
 */

export const EMBED_DIM = 384

/** Fixed-length embedding; plain array so it JSON-persists cleanly. */
export type EmbeddingVector = number[]

/**
 * Small English stopword set — keeps the toy vectors from being dominated
 * by function words that the real model would handle via attention.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it',
  'its', 'this', 'that', 'these', 'those', 'you', 'your', 'we', 'our', 'they', 'their', 'he',
  'she', 'his', 'her', 'not', 'no', 'do', 'does', 'did', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'how', 'what', 'when', 'where', 'who', 'why', 'into', 'over', 'about',
])

/**
 * FNV-1a 32-bit hash over UTF-16 code units — deterministic everywhere.
 * Exported because the URL hasher (`urlHashOf`) and stress seeder reuse it.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Tokenizer shared with the palette search and stress seeder: lowercase,
 * keep word-ish tokens (letters/digits and embedded + # . / - so `c++`,
 * `node.js`, `webgpu` and `f1` survive), strip edge punctuation, drop
 * stopwords and 1-char tokens.
 */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9][a-z0-9+#./-]*/g) ?? []
  const tokens: string[] = []
  for (const candidate of raw) {
    const cleaned = candidate.replace(/^[./-]+/, '').replace(/[./-]+$/, '')
    if (cleaned.length < 2 || STOPWORDS.has(cleaned)) continue
    tokens.push(cleaned)
  }
  return tokens
}

const embedCache = new Map<string, EmbeddingVector>()
const EMBED_CACHE_LIMIT = 4096

/**
 * Core embedder — synchronous, deterministic, memoized per input string.
 * Empty/stopword-only text yields the all-zero vector (cosine 0 with
 * everything), which the Ghost Echo matcher treats as "no semantic signal".
 */
export function embedText(text: string): EmbeddingVector {
  const cached = embedCache.get(text)
  if (cached) return cached

  const vector = new Array<number>(EMBED_DIM).fill(0)
  for (const token of tokenize(text)) {
    vector[fnv1a32(token) % EMBED_DIM] += 1
  }
  let sumOfSquares = 0
  for (const value of vector) sumOfSquares += value * value
  const norm = Math.sqrt(sumOfSquares)
  const embedding = norm > 0 ? vector.map((value) => value / norm) : vector

  if (embedCache.size >= EMBED_CACHE_LIMIT) embedCache.clear()
  embedCache.set(text, embedding)
  return embedding
}

/**
 * Async facade matching the Phase 2/3 transformers.js call shape
 * (`await model.embed(text)`); keeps every call site signature-stable
 * when the toy hasher is swapped for the real MiniLM model.
 */
export function embedTextAsync(text: string): Promise<EmbeddingVector> {
  return Promise.resolve(embedText(text))
}

/**
 * Cosine similarity in [-1, 1]; 0 when either vector is zero-length or the
 * lengths differ. Works for the toy hasher now and the real MiniLM
 * (already-normalized) vectors later.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0
  return Math.max(-1, Math.min(1, dot / denominator))
}
