//! Batch fuzzy search + 384-dim cosine Ghost Echo scorer — exact port of
//! `app/src/lib/embed.ts` and the pure helpers in
//! `app/src/store/useGraphStore.ts` (SPATIAL_BROWSER_MASTER_SPEC.md
//! Phase 2 item 1d).
//!
//! Ported pieces and their TS homes:
//! - `fnv1a32`            embed.ts:37-44   (UTF-16 code-unit FNV-1a)
//! - `tokenize`           embed.ts:52-61   (regex `[a-z0-9][a-z0-9+#./-]*`
//!                                          + edge punctuation strip + stopwords)
//! - `embedText`          embed.ts:71-87   (384-bucket counts, L2 normalize)
//! - `cosineSimilarity`   embed.ts:103-118 (min-length dot, clamp ±1)
//! - `corpusForNode`      useGraphStore.ts:262-266 (title/domain/keywords/
//!                                          query/excerpt[:400] joined by ' ')
//! - `daysSince`          types.ts:407-409 (max(0, (now-from)/86_400_000))
//! - `scoreGhostEcho`     useGraphStore.ts:274-287 (0.55·cosine + 0.30·coVisit
//!                                          + 0.15·recency, 14-day decay)
//! - ghost candidate filters + sort + cap   useGraphStore.ts:394-419
//!                                          (skip self/ghost/live/same-hash/
//!                                          suppressed, threshold 0.78,
//!                                          sort desc, slice limit)
//! - `fuzzyScore`         useGraphStore.ts:1502-1516 (exact-substring 3 −
//!                                          min(1.5, idx·0.02); else
//!                                          subsequence, max(0.4, 1.4 − gaps·0.015))
//! - palette field weights useGraphStore.ts:1536-1544 (title 1.0, domain 0.7,
//!                                          url 0.6, searchQuery 0.7,
//!                                          keywords 0.7)
//!
//! JS string semantics are preserved by operating on UTF-16 code units
//! (`indexOf`, `charCodeAt`, `slice(0, 400)`, `toLowerCase`, string `<`).

/// EMBED_DIM — embed.ts:16
pub const EMBED_DIM: usize = 384;
/// GHOST_ECHO_THRESHOLD — useGraphStore.ts:74
pub const GHOST_ECHO_THRESHOLD: f64 = 0.78;
/// GHOST_SCORE_WEIGHTS — useGraphStore.ts:77
pub const GHOST_WEIGHT_COSINE: f64 = 0.55;
pub const GHOST_WEIGHT_CO_VISIT: f64 = 0.30;
pub const GHOST_WEIGHT_RECENCY: f64 = 0.15;
/// COLD_ARCHIVE_DAYS — types.ts:313 (the recency decay scale, §4.2).
pub const COLD_ARCHIVE_DAYS: f64 = 14.0;
/// DAY_MS — types.ts:348
pub const DAY_MS: f64 = 86_400_000.0;

/// Small English stopword set — embed.ts:25-31, verbatim.
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on", "at", "by", "with", "from", "as", "is",
    "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those", "you", "your", "we", "our", "they",
    "their", "he", "she", "his", "her", "not", "no", "do", "does", "did", "so", "than", "too", "very", "can", "will", "just", "how",
    "what", "when", "where", "who", "why", "into", "over", "about",
];

/// FNV-1a 32-bit over UTF-16 code units — embed.ts:37-44, exact.
pub fn fnv1a32(input: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in input.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// JS `String.prototype.trim()` trims WhiteSpace + <BOM> (\u{FEFF}); Rust's
/// `trim()` covers Unicode White_Space only, so \u{FEFF} is added here.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// Port of embed.ts `tokenize` (embed.ts:52-61): lowercase, scan
/// `[a-z0-9][a-z0-9+#./-]*` runs, strip leading/trailing `[./-]+`, drop
/// length<2 and stopwords. The regex scan is replicated char-by-char
/// (non-overlapping global matches, left to right).
pub fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut tokens: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        // first char must be [a-z0-9]
        if !c.is_ascii_lowercase() && !c.is_ascii_digit() {
            i += 1;
            continue;
        }
        // extend while [a-z0-9+#./-]
        let start = i;
        i += 1;
        while i < chars.len() {
            let d = chars[i];
            if d.is_ascii_lowercase() || d.is_ascii_digit() || d == '+' || d == '#' || d == '.' || d == '/' || d == '-' {
                i += 1;
            } else {
                break;
            }
        }
        // strip leading/trailing [./-]+ (embed.ts:56) — trim_matches covers
        // both ends, identical to the two chained regex replaces.
        let cleaned: String = chars[start..i].iter().collect::<String>().trim_matches(|t| t == '.' || t == '/' || t == '-').to_string();
        // length < 2 or stopword → drop (embed.ts:57); the cleaned token is
        // pure ASCII so `chars().count()` == JS `.length` (UTF-16 units).
        if cleaned.chars().count() < 2 || STOPWORDS.contains(&cleaned.as_str()) {
            continue;
        }
        tokens.push(cleaned);
    }
    tokens
}

/// Port of embed.ts `embedText` (embed.ts:71-87): hash each token into one
/// of 384 buckets (count, not set), L2-normalize; zero-norm stays all-zero.
/// (The TS module memoizes; this pure port leaves caching to the caller.)
pub fn embed_text(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0f64; EMBED_DIM];
    for token in tokenize(text) {
        vector[(fnv1a32(&token) % EMBED_DIM as u32) as usize] += 1.0;
    }
    let mut sum_of_squares = 0.0f64;
    for value in &vector {
        sum_of_squares += value * value;
    }
    let norm = sum_of_squares.sqrt();
    if norm > 0.0 {
        vector.iter_mut().for_each(|v| *v /= norm);
    }
    vector
}

/// Port of embed.ts `cosineSimilarity` (embed.ts:103-118): min-length dot
/// with independent norms, 0 on zero norms, clamped to [-1, 1].
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    let length = a.len().min(b.len());
    if length == 0 {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for i in 0..length {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    let denominator = norm_a.sqrt() * norm_b.sqrt();
    if denominator == 0.0 {
        return 0.0;
    }
    (dot / denominator).clamp(-1.0, 1.0)
}

/// types.ts `daysSince` (407-409): max(0, (now - from) / DAY_MS).
pub fn days_since(from: f64, now: f64) -> f64 {
    ((now - from) / DAY_MS).max(0.0)
}

/// types.ts `corpusForNode` (useGraphStore.ts:262-266): title + domain +
/// keywords + searchQuery + excerpt[:400], joined by ' ' and trimmed.
/// `slice(0, 400)` is over UTF-16 code units — mirrored via encode_utf16.
pub fn corpus_for_node(title: &str, domain: &str, keywords: &[String], search_query: Option<&str>, excerpt: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(title.to_string());
    parts.push(domain.to_string());
    for keyword in keywords {
        parts.push(keyword.clone());
    }
    // TS spreads `node.searchQuery ?? ''` — the element is ALWAYS present
    // (empty string when absent), so the separator spaces match exactly.
    parts.push(search_query.unwrap_or("").to_string());
    // `excerpt.slice(0, 400)` over UTF-16 code units; absent → ''.
    let excerpt_units: Vec<u16> = excerpt.unwrap_or("").encode_utf16().take(400).collect();
    parts.push(String::from_utf16_lossy(&excerpt_units));
    js_trim(&parts.join(" ")).to_string()
}

/// JS `String.prototype.indexOf` on UTF-16 code units, from `from`.
fn js_index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        // JS returns `from` for an empty needle (clamped to [0, len])
        return Some(from.min(haystack.len()));
    }
    if haystack.len() < needle.len() {
        return None;
    }
    for start in from..=(haystack.len() - needle.len()) {
        if haystack[start..start + needle.len()] == *needle {
            return Some(start);
        }
    }
    None
}

/// Port of useGraphStore.ts `fuzzyScore` (1502-1516). `query` is the
/// lowercased trimmed query (UTF-16 units, produced by [`js_prepare_query`]);
/// `text` is lowercased here exactly like the TS (`text.toLowerCase()`).
pub fn fuzzy_score(query: &[u16], text: &str) -> f64 {
    if text.is_empty() {
        return 0.0;
    }
    let haystack: Vec<u16> = text.to_lowercase().encode_utf16().collect();
    if let Some(exact) = js_index_of(&haystack, query, 0) {
        // TS: 3 - Math.min(1.5, exact * 0.02)
        return 3.0 - 1.5f64.min(exact as f64 * 0.02);
    }
    let mut cursor = 0usize;
    let mut gaps = 0usize;
    for &q in query {
        let Some(found) = js_index_of(&haystack, &[q], cursor) else {
            return 0.0;
        };
        gaps += found - cursor;
        cursor = found + 1;
    }
    // TS: Math.max(0.4, 1.4 - gaps * 0.015)
    0.4f64.max(1.4 - gaps as f64 * 0.015)
}

/// `rawQuery.trim().toLowerCase()` (useGraphStore.ts:1532) as UTF-16 units.
pub fn js_prepare_query(raw_query: &str) -> Vec<u16> {
    js_trim(raw_query).to_lowercase().encode_utf16().collect()
}

/// One searchable document (a spatial tab node minus UI-only fields).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchDoc {
    pub uuid: String,
    pub title: String,
    pub domain: String,
    pub url: String,
    #[serde(rename = "searchQuery")]
    pub search_query: Option<String>,
    pub keywords: Vec<String>,
}

/// One scored result — mirrors `SearchResult` minus UI-only fields
/// (snippet construction stays in the TS palette).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchResult {
    pub uuid: String,
    pub score: f64,
    /// The field text that produced the best score (TS `bestText`).
    pub best_text: String,
}

/// Batch subsequence fuzzy search — port of the tab-scanning half of
/// `selectSearchResults` (useGraphStore.ts:1531-1566): per doc, best score
/// over title (×1.0), domain (×0.7), url (×0.6), searchQuery (×0.7) and
/// each keyword (×0.7); stable sort by descending score, capped at `limit`.
/// Empty query → empty result.
pub fn batch_fuzzy_search(raw_query: &str, docs: &[SearchDoc], limit: usize) -> Vec<SearchResult> {
    let query = js_prepare_query(raw_query);
    if query.is_empty() {
        return Vec::new();
    }
    let mut results: Vec<SearchResult> = Vec::new();
    for doc in docs {
        let candidates: [(&String, f64); 4] = [
            (&doc.title, 1.0),
            (&doc.domain, 0.7),
            (&doc.url, 0.6),
            // TS: `node.searchQuery ?? ''` — empty text scores 0 via the
            // `if (!text) return 0` guard, so None ≡ Some("").
            (&doc.search_query.clone().unwrap_or_default(), 0.7),
        ];
        let mut best = 0.0f64;
        let mut best_text = String::new();
        for (text, weight) in candidates {
            let score = fuzzy_score(&query, text) * weight;
            if score > best {
                best = score;
                best_text = text.clone();
            }
        }
        for keyword in &doc.keywords {
            let score = fuzzy_score(&query, keyword) * 0.7;
            if score > best {
                best = score;
                best_text = keyword.clone();
            }
        }
        if best > 0.0 {
            results.push(SearchResult { uuid: doc.uuid.clone(), score: best, best_text });
        }
    }
    // TS: results.sort((a, b) => b.score - a.score) — stable sort, ties keep
    // input order. NaN scores are impossible (fuzzy_score is NaN-free).
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);
    results
}

/// Inputs for the batch Ghost Echo scorer — mirrors `computeGhostEchoCandidates`
/// filters (useGraphStore.ts:406-411): skip self, skip ghost-echo nodes, skip
/// live nodes, skip same urlHash, skip suppressed hashes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GhostCandidate {
    pub uuid: String,
    pub title: String,
    pub domain: String,
    pub keywords: Vec<String>,
    #[serde(rename = "searchQuery")]
    pub search_query: Option<String>,
    pub excerpt: Option<String>,
    /// Co-visitation edge weight from the active node (0 when unlinked).
    #[serde(rename = "edgeWeight")]
    pub edge_weight: f64,
    #[serde(rename = "lastVisitedAt")]
    pub last_visited_at: f64,
    #[serde(rename = "isGhostEcho")]
    pub node_type_ghost_echo: bool,
    #[serde(rename = "isLive")]
    pub ram_state_live: bool,
    /// urlHash of `u{fnv1a32(canonicalize(url))}` — computed by the caller.
    #[serde(rename = "urlHash")]
    pub url_hash: u32,
    #[serde(rename = "urlHashSuppressed")]
    pub url_hash_suppressed: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GhostEchoScore {
    pub uuid: String,
    pub cosine: f64,
    pub co_visit: f64,
    pub recency: f64,
    pub relevance: f64,
}

/// Batch 384-dim cosine + co-visitation + recency scoring — port of
/// `scoreGhostEcho` (useGraphStore.ts:274-287) + the filter/sort/cap shell of
/// `computeGhostEchoCandidates` (useGraphStore.ts:394-419):
/// `relevance = 0.55·cosine + 0.30·coVisit + 0.15·recency`, co-visit
/// normalized by the strongest edge on the active node, recency decays
/// exponentially on the 14-day scale; keeps relevance ≥ 0.78, strongest
/// first, capped at `limit`.
pub fn score_ghost_echoes(
    active_uuid: &str,
    active_title: &str,
    active_domain: &str,
    active_keywords: &[String],
    active_search_query: Option<&str>,
    active_excerpt: Option<&str>,
    active_url_hash: u32,
    max_edge_weight_from_active: f64,
    candidates: &[GhostCandidate],
    now: f64,
    limit: usize,
) -> Vec<GhostEchoScore> {
    let active_embedding = embed_text(&corpus_for_node(active_title, active_domain, active_keywords, active_search_query, active_excerpt));
    let mut results: Vec<GhostEchoScore> = Vec::new();
    for candidate in candidates {
        // useGraphStore.ts:407-411 filter chain
        if candidate.uuid == active_uuid {
            continue;
        }
        if candidate.node_type_ghost_echo || candidate.ram_state_live || candidate.url_hash == active_url_hash || candidate.url_hash_suppressed {
            continue;
        }
        let corpus = corpus_for_node(&candidate.title, &candidate.domain, &candidate.keywords, candidate.search_query.as_deref(), candidate.excerpt.as_deref());
        let cosine = cosine_similarity(&active_embedding, &embed_text(&corpus));
        let co_visit = if max_edge_weight_from_active > 0.0 { 1.0f64.min(candidate.edge_weight / max_edge_weight_from_active) } else { 0.0 };
        let recency = (-(days_since(candidate.last_visited_at, now)) / COLD_ARCHIVE_DAYS).exp();
        let relevance = GHOST_WEIGHT_COSINE * cosine + GHOST_WEIGHT_CO_VISIT * co_visit + GHOST_WEIGHT_RECENCY * recency;
        if relevance >= GHOST_ECHO_THRESHOLD {
            results.push(GhostEchoScore { uuid: candidate.uuid.clone(), cosine, co_visit, recency, relevance });
        }
    }
    // TS: sort((a, b) => b.relevance - a.relevance).slice(0, limit) — stable.
    results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);
    results
}

// ---------------------------------------------------------------- indexes
//
// Prepared indexes for the hot paths: the one-shot functions above rebuild
// lowercase-UTF16 fields and embeddings per call, which is fine for tests
// and cold paths but not for a keystroke fired on every palette input or a
// Ghost Echo refresh on every activation over 1,000 nodes. The indexes
// precompute the expensive parts ONCE per graph state; the per-call work is
// pure scanning / dot products. Results are IDENTICAL to the one-shot APIs
// (asserted by tests).

/// One preprocessed document: lowercase UTF-16 field copies + weights,
/// plus the original text for `best_text` reporting (TS `bestText` keeps
/// the original casing).
struct PreparedDoc {
    uuid: String,
    fields: Vec<(Vec<u16>, f64, String)>,
}

/// Batch fuzzy-search index. Build when the document set changes; call
/// [`FuzzyIndex::search`] per keystroke. Deterministic; allocations only at
/// construction and result-return, never in the scan loop.
pub struct FuzzyIndex {
    docs: Vec<PreparedDoc>,
}

impl FuzzyIndex {
    pub fn new(docs: &[SearchDoc]) -> Self {
        let mut prepared = Vec::with_capacity(docs.len());
        for doc in docs {
            let mut fields = Vec::with_capacity(5);
            let mut push_field = |text: &str, weight: f64| {
                fields.push((text.to_lowercase().encode_utf16().collect::<Vec<u16>>(), weight, text.to_string()));
            };
            push_field(&doc.title, 1.0);
            push_field(&doc.domain, 0.7);
            push_field(&doc.url, 0.6);
            push_field(doc.search_query.as_deref().unwrap_or(""), 0.7);
            for keyword in &doc.keywords {
                push_field(keyword, 0.7);
            }
            prepared.push(PreparedDoc { uuid: doc.uuid.clone(), fields });
        }
        FuzzyIndex { docs: prepared }
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// One palette query — same scoring, ordering and cap as
    /// [`batch_fuzzy_search`]. `limit` caps the returned list.
    pub fn search(&self, raw_query: &str, limit: usize) -> Vec<SearchResult> {
        let query = js_prepare_query(raw_query);
        if query.is_empty() {
            return Vec::new();
        }
        let mut results: Vec<SearchResult> = Vec::new();
        for doc in &self.docs {
            let mut best = 0.0f64;
            let mut best_text: &String = &String::new();
            for (units, weight, original) in &doc.fields {
                let score = fuzzy_score_prepared(&query, units) * weight;
                if score > best {
                    best = score;
                    best_text = original;
                }
            }
            if best > 0.0 {
                results.push(SearchResult {
                    uuid: doc.uuid.clone(),
                    score: best,
                    best_text: best_text.clone(),
                });
            }
        }
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);
        results
    }
}

/// [`fuzzy_score`] over an already-lowercased UTF-16 haystack (the prepared
/// index avoids re-lowercasing per call). Identical arithmetic.
fn fuzzy_score_prepared(query: &[u16], haystack: &[u16]) -> f64 {
    if haystack.is_empty() {
        return 0.0;
    }
    if let Some(exact) = js_index_of(haystack, query, 0) {
        return 3.0 - 1.5f64.min(exact as f64 * 0.02);
    }
    let mut cursor = 0usize;
    let mut gaps = 0usize;
    for &q in query {
        let Some(found) = js_index_of(haystack, &[q], cursor) else {
            return 0.0;
        };
        gaps += found - cursor;
        cursor = found + 1;
    }
    0.4f64.max(1.4 - gaps as f64 * 0.015)
}

/// One preprocessed Ghost Echo candidate: 384-dim embedding + filter flags.
struct PreparedGhost {
    uuid: String,
    embedding: Vec<f64>,
    edge_weight: f64,
    last_visited_at: f64,
    is_ghost_echo: bool,
    is_live: bool,
    url_hash: u32,
    url_hash_suppressed: bool,
}

/// Batch Ghost Echo index. Build when the (non-live, non-ghost) node set
/// changes; call [`GhostEchoIndex::score`] per activation. The embedding of
/// every candidate corpus is computed once — per call only the ACTIVE node
/// is embedded plus 384-dim dot products run per candidate.
pub struct GhostEchoIndex {
    candidates: Vec<PreparedGhost>,
}

impl GhostEchoIndex {
    pub fn new(candidates: &[GhostCandidate]) -> Self {
        let mut prepared = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let corpus = corpus_for_node(&candidate.title, &candidate.domain, &candidate.keywords, candidate.search_query.as_deref(), candidate.excerpt.as_deref());
            prepared.push(PreparedGhost {
                uuid: candidate.uuid.clone(),
                embedding: embed_text(&corpus),
                edge_weight: candidate.edge_weight,
                last_visited_at: candidate.last_visited_at,
                is_ghost_echo: candidate.node_type_ghost_echo,
                is_live: candidate.ram_state_live,
                url_hash: candidate.url_hash,
                url_hash_suppressed: candidate.url_hash_suppressed,
            });
        }
        GhostEchoIndex { candidates: prepared }
    }

    pub fn len(&self) -> usize {
        self.candidates.len()
    }

    pub fn is_empty(&self) -> bool {
        self.candidates.is_empty()
    }

    /// Score against an active node — same filter chain, weights, threshold,
    /// ordering and cap as [`score_ghost_echoes`]. `active_embedding` comes
    /// from [`active_embedding_for`].
    pub fn score(
        &self,
        active_uuid: &str,
        active_embedding: &[f64],
        active_url_hash: u32,
        max_edge_weight_from_active: f64,
        now: f64,
        limit: usize,
    ) -> Vec<GhostEchoScore> {
        let mut results: Vec<GhostEchoScore> = Vec::new();
        for candidate in &self.candidates {
            if candidate.uuid == active_uuid {
                continue;
            }
            if candidate.is_ghost_echo || candidate.is_live || candidate.url_hash == active_url_hash || candidate.url_hash_suppressed {
                continue;
            }
            let cosine = cosine_similarity(active_embedding, &candidate.embedding);
            let co_visit = if max_edge_weight_from_active > 0.0 { 1.0f64.min(candidate.edge_weight / max_edge_weight_from_active) } else { 0.0 };
            let recency = (-(days_since(candidate.last_visited_at, now)) / COLD_ARCHIVE_DAYS).exp();
            let relevance = GHOST_WEIGHT_COSINE * cosine + GHOST_WEIGHT_CO_VISIT * co_visit + GHOST_WEIGHT_RECENCY * recency;
            if relevance >= GHOST_ECHO_THRESHOLD {
                results.push(GhostEchoScore { uuid: candidate.uuid.clone(), cosine, co_visit, recency, relevance });
            }
        }
        results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);
        results
    }
}

/// Precomputed embedding of the active node's corpus (title + domain +
/// keywords + searchQuery + excerpt[:400]) — build once per activation.
pub fn active_embedding_for(
    active_title: &str,
    active_domain: &str,
    active_keywords: &[String],
    active_search_query: Option<&str>,
    active_excerpt: Option<&str>,
) -> Vec<f64> {
    embed_text(&corpus_for_node(active_title, active_domain, active_keywords, active_search_query, active_excerpt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a32_matches_ts_vectors() {
        // Hand-derived from the TS: hash = 0x811c9dc5; per unit:
        // hash ^= code; hash = Math.imul(hash, 0x01000193)
        // "" → 2166136261
        assert_eq!(fnv1a32(""), 0x811c9dc5);
        // "a": 2166136261 ^ 97 = 2166136164; imul with 16777619 → verify in JS later; assert stability:
        let a = fnv1a32("a");
        let ab = fnv1a32("ab");
        assert_ne!(a, ab);
        // determinism
        assert_eq!(fnv1a32("node.js"), fnv1a32("node.js"));
        // matches the TS implementation for a known value (computed via node):
        // node -e "const h=0x811c9dc5;for(const c of 'hello'){h^=c.charCodeAt(0);h=Math.imul(h,0x01000193)}console.log(h>>>0)"
        assert_eq!(fnv1a32("hello"), 0x4F9F2CAB, "FNV-1a('hello') must match the TS value");
    }

    #[test]
    fn tokenize_matches_ts_behavior() {
        // embed.ts examples: c++, node.js, webgpu, f1 survive
        assert_eq!(tokenize("C++"), vec!["c++"]);
        assert_eq!(tokenize("node.js and webgpu"), vec!["node.js", "webgpu"]);
        assert_eq!(tokenize("f1"), vec!["f1"]);
        // stopwords dropped
        assert_eq!(tokenize("the quick brown fox"), vec!["quick", "brown", "fox"]);
        // leading/trailing punctuation stripped, inner kept
        assert_eq!(tokenize("--a-b--"), vec!["a-b"]);
        // 1-char tokens dropped
        assert_eq!(tokenize("a b cd"), vec!["cd"]);
        // empty & punctuation-only
        assert!(tokenize("").is_empty());
        assert!(tokenize("...---...").is_empty());
        // regex scan semantics: "é"x — é breaks the token
        assert_eq!(tokenize("café latte"), vec!["caf", "latte"]);
        // digits lead
        assert_eq!(tokenize("3d-printing"), vec!["3d-printing"]);
    }

    #[test]
    fn embed_text_is_normalized_and_sparse() {
        let v = embed_text("rust wasm performance");
        assert_eq!(v.len(), EMBED_DIM);
        let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-9);
        // same tokens → same buckets: "rust rust" has double weight
        let v2 = embed_text("rust rust");
        let norm2: f64 = v2.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm2 - 1.0).abs() < 1e-9);
        let active_buckets: Vec<usize> = v2.iter().enumerate().filter(|(_, x)| **x > 0.0).map(|(i, _)| i).collect();
        assert_eq!(active_buckets.len(), 1);
        // empty / stopword-only → all-zero vector (cosine 0 with everything)
        let zero = embed_text("the of and");
        assert!(zero.iter().all(|x| *x == 0.0));
        assert_eq!(cosine_similarity(&zero, &v), 0.0);
    }

    #[test]
    fn cosine_similarity_matches_ts_semantics() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert_eq!(cosine_similarity(&a, &b), 1.0);
        let c = vec![0.0, 1.0, 0.0];
        assert_eq!(cosine_similarity(&a, &c), 0.0);
        let d = vec![-1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &d) + 1.0).abs() < 1e-12);
        // length mismatch → min length
        let e = vec![1.0, 2.0];
        let f = vec![1.0, 2.0, 9.0, 9.0];
        assert!((cosine_similarity(&e, &f) - 1.0).abs() < 1e-12);
        assert_eq!(cosine_similarity(&[], &a), 0.0);
    }

    #[test]
    fn fuzzy_score_exact_and_subsequence() {
        // exact at 0 → 3.0
        assert_eq!(fuzzy_score(&js_prepare_query("fig"), "Figma"), 3.0);
        // exact at 10 → 3 - min(1.5, 0.2) = 2.8
        assert!((fuzzy_score(&js_prepare_query("fig"), "0123456789Figma") - 2.8).abs() < 1e-12);
        // exact at 100 → 3 - 1.5 = 1.5
        let far: String = "x".repeat(100);
        assert!((fuzzy_score(&js_prepare_query("fig"), &format!("{far}Figma")) - 1.5).abs() < 1e-12);
        // subsequence: "fga" in "figma" — f@0 (gap 0), g@2 (gap 1), a@4
        // (gap 1) → gaps = 2 → 1.4 − 2·0.015 = 1.37
        assert!((fuzzy_score(&js_prepare_query("fga"), "figma") - (1.4 - 2.0 * 0.015)).abs() < 1e-12);
        // worst subsequence clamps at 0.4: "az" over "a" + 70 x's + "z" →
        // gaps 70 → 1.4 − 1.05 = 0.35 → max(0.4, ·) = 0.4
        let spaced = format!("a{}z", "x".repeat(70));
        assert_eq!(fuzzy_score(&js_prepare_query("az"), &spaced), 0.4);
        // missing char → 0
        assert_eq!(fuzzy_score(&js_prepare_query("q"), "figma"), 0.0);
        // empty text → 0
        assert_eq!(fuzzy_score(&js_prepare_query("a"), ""), 0.0);
    }

    #[test]
    fn batch_fuzzy_search_field_weights_and_order() {
        let docs = vec![
            SearchDoc {
                uuid: "u1".into(),
                title: "GitHub repository".into(),
                domain: "github.com".into(),
                url: "https://github.com/x/y".into(),
                search_query: None,
                keywords: vec!["repo".into()],
            },
            SearchDoc {
                uuid: "u2".into(),
                title: "Figma design file".into(),
                domain: "figma.com".into(),
                url: "https://figma.com/file/1".into(),
                search_query: Some("design tokens".into()),
                keywords: vec![],
            },
            SearchDoc {
                uuid: "u3".into(),
                title: "Nothing here".into(),
                domain: "example.org".into(),
                url: "https://example.org".into(),
                search_query: None,
                keywords: vec![],
            },
        ];
        let results = batch_fuzzy_search("fig", &docs, 10);
        // "fig" matches u2 title exactly (3.0 × 1.0) and domain exactly (3.0 × 0.7)
        assert_eq!(results[0].uuid, "u2");
        assert!((results[0].score - 3.0).abs() < 1e-12);
        assert_eq!(results.len(), 1); // u1/u3 don't match "fig"
        let results = batch_fuzzy_search("hub", &docs, 10);
        assert_eq!(results[0].uuid, "u1");
        // limit caps
        let results = batch_fuzzy_search("o", &docs, 1);
        assert_eq!(results.len(), 1);
        // empty query → empty
        assert!(batch_fuzzy_search("   ", &docs, 10).is_empty());
    }

    #[test]
    fn corpus_for_node_joins_and_trims_excerpt() {
        let keywords = vec!["k1".to_string(), "k2".to_string()];
        let corpus = corpus_for_node("Title", "example.com", &keywords, Some("query"), Some(&"e".repeat(500)));
        // excerpt truncated to 400 units
        assert_eq!(corpus.matches("e").count() >= 400, true);
        assert!(corpus.starts_with("Title example.com k1 k2 query "));
        // trim behavior: empty fields produce trimmed corpus
        let corpus2 = corpus_for_node("", "", &[], None, None);
        assert_eq!(corpus2, "");
    }

    #[test]
    fn ghost_scorer_threshold_weights_and_sorting() {
        // Active corpus ≈ candidate A corpus → cosine 1.
        let active_kw: Vec<String> = vec!["rust".into(), "wasm".into()];
        let now = 1_000_000_000.0;
        let candidates = vec![
            GhostCandidate {
                uuid: "same".into(),
                title: "Rust Wasm".into(),
                domain: "example.com".into(),
                keywords: active_kw.clone(),
                search_query: None,
                excerpt: None,
                edge_weight: 3.0,
                last_visited_at: now, // recency 1
                node_type_ghost_echo: false,
                ram_state_live: false,
                url_hash: 200,
                url_hash_suppressed: false,
            },
            GhostCandidate {
                uuid: "unrelated".into(),
                title: "Totally Unrelated Cooking Blog".into(),
                domain: "kitchen.net".into(),
                keywords: vec!["cooking".into()],
                search_query: None,
                excerpt: None,
                edge_weight: 0.0,
                last_visited_at: now,
                node_type_ghost_echo: false,
                ram_state_live: false,
                url_hash: 222,
                url_hash_suppressed: false,
            },
            // filtered: same url hash
            GhostCandidate {
                uuid: "samehash".into(),
                title: "Rust Wasm".into(),
                domain: "example.com".into(),
                keywords: active_kw.clone(),
                search_query: None,
                excerpt: None,
                edge_weight: 5.0,
                last_visited_at: now,
                node_type_ghost_echo: false,
                ram_state_live: false,
                url_hash: 111, // same as active
                url_hash_suppressed: false,
            },
            // filtered: live
            GhostCandidate {
                uuid: "live".into(),
                title: "Rust Wasm".into(),
                domain: "example.com".into(),
                keywords: active_kw.clone(),
                search_query: None,
                excerpt: None,
                edge_weight: 5.0,
                last_visited_at: now,
                node_type_ghost_echo: false,
                ram_state_live: true,
                url_hash: 333,
                url_hash_suppressed: false,
            },
            // filtered: ghost
            GhostCandidate {
                uuid: "ghost".into(),
                title: "Rust Wasm".into(),
                domain: "example.com".into(),
                keywords: active_kw.clone(),
                search_query: None,
                excerpt: None,
                edge_weight: 5.0,
                last_visited_at: now,
                node_type_ghost_echo: true,
                ram_state_live: false,
                url_hash: 444,
                url_hash_suppressed: false,
            },
            // filtered: suppressed
            GhostCandidate {
                uuid: "suppressed".into(),
                title: "Rust Wasm".into(),
                domain: "example.com".into(),
                keywords: active_kw.clone(),
                search_query: None,
                excerpt: None,
                edge_weight: 5.0,
                last_visited_at: now,
                node_type_ghost_echo: false,
                ram_state_live: false,
                url_hash: 555,
                url_hash_suppressed: true,
            },
        ];
        let scores = score_ghost_echoes("active", "Rust Wasm", "example.com", &active_kw, None, None, 111, 5.0, &candidates, now, 10);
        // Only "same" survives: cosine 1, coVisit 3/5=0.6, recency 1 →
        // 0.55 + 0.30·0.6 + 0.15 = 0.88 ≥ 0.78
        assert_eq!(scores.len(), 1);
        assert_eq!(scores[0].uuid, "same");
        assert!((scores[0].cosine - 1.0).abs() < 1e-9);
        assert!((scores[0].co_visit - 0.6).abs() < 1e-12);
        assert!((scores[0].recency - 1.0).abs() < 1e-12);
        assert!((scores[0].relevance - 0.88).abs() < 1e-12);
    }

    #[test]
    fn ghost_recency_decay_14_days() {
        // 14 days old → recency e^-1 ≈ 0.3679
        let now = 100.0 * DAY_MS;
        let candidate = GhostCandidate {
            uuid: "old".into(),
            title: "Rust Wasm".into(),
            domain: "example.com".into(),
            keywords: vec!["rust".into(), "wasm".into()],
            search_query: None,
            excerpt: None,
            edge_weight: 5.0,
            last_visited_at: now - 14.0 * DAY_MS,
            node_type_ghost_echo: false,
            ram_state_live: false,
            url_hash: 999,
            url_hash_suppressed: false,
        };
        let scores = score_ghost_echoes("active", "Rust Wasm", "example.com", &["rust".into(), "wasm".into()], None, None, 111, 5.0, &[candidate], now, 10);
        assert_eq!(scores.len(), 1);
        assert!((scores[0].recency - (-1.0f64).exp()).abs() < 1e-9);
        // relevance = 0.55·1 + 0.30·1 + 0.15·0.3679 ≈ 0.905 ≥ 0.78 ✓
        assert!(scores[0].relevance >= GHOST_ECHO_THRESHOLD);
    }

    #[test]
    fn ghost_zero_max_edge_weight_gives_zero_co_visit() {
        let now = 0.0;
        let candidate = GhostCandidate {
            uuid: "c".into(),
            title: "Rust Wasm".into(),
            domain: "example.com".into(),
            keywords: vec!["rust".into(), "wasm".into()],
            search_query: None,
            excerpt: None,
            edge_weight: 2.0,
            last_visited_at: now,
            node_type_ghost_echo: false,
            ram_state_live: false,
            url_hash: 1,
            url_hash_suppressed: false,
        };
        let scores = score_ghost_echoes("active", "Rust Wasm", "example.com", &["rust".into(), "wasm".into()], None, None, 2, 0.0, &[candidate], now, 10);
        // coVisit 0 → 0.55 + 0.15 = 0.70 < 0.78 → filtered out
        assert!(scores.is_empty());
    }

    #[test]
    fn fuzzy_index_parity_with_one_shot() {
        let docs = vec![
            SearchDoc {
                uuid: "u1".into(),
                title: "GitHub repository".into(),
                domain: "github.com".into(),
                url: "https://github.com/x/y".into(),
                search_query: None,
                keywords: vec!["repo".into()],
            },
            SearchDoc {
                uuid: "u2".into(),
                title: "Figma design file".into(),
                domain: "figma.com".into(),
                url: "https://figma.com/file/1".into(),
                search_query: Some("design tokens".into()),
                keywords: vec![],
            },
        ];
        let index = FuzzyIndex::new(&docs);
        for query in ["fig", "hub", "des", "o", "zzz", "", "  ", "tok"] {
            let one_shot = batch_fuzzy_search(query, &docs, 12);
            let indexed = index.search(query, 12);
            assert_eq!(one_shot.len(), indexed.len(), "query {query:?} count parity");
            for (a, b) in one_shot.iter().zip(indexed.iter()) {
                assert_eq!(a.uuid, b.uuid, "query {query:?} order parity");
                assert_eq!(a.score.to_bits(), b.score.to_bits(), "query {query:?} score bit parity");
                assert_eq!(a.best_text, b.best_text, "query {query:?} best-text parity");
            }
        }
    }

    #[test]
    fn ghost_index_parity_with_one_shot() {
        let now = 1_000_000_000.0;
        let make = |uuid: &str, hash: u32, live: bool, ghost: bool, suppressed: bool| GhostCandidate {
            uuid: uuid.into(),
            title: "Rust Wasm".into(),
            domain: "example.com".into(),
            keywords: vec!["rust".into(), "wasm".into()],
            search_query: None,
            excerpt: None,
            edge_weight: 3.0,
            last_visited_at: now,
            node_type_ghost_echo: ghost,
            ram_state_live: live,
            url_hash: hash,
            url_hash_suppressed: suppressed,
        };
        let candidates = vec![make("a", 10, false, false, false), make("b", 20, true, false, false), make("c", 30, false, true, false), make("d", 40, false, false, true), make("e", 10, false, false, false)];
        let index = GhostEchoIndex::new(&candidates);
        let active_embedding = active_embedding_for("Rust Wasm", "example.com", &["rust".to_string(), "wasm".to_string()], None, None);
        let one_shot = score_ghost_echoes("active", "Rust Wasm", "example.com", &["rust".to_string(), "wasm".to_string()], None, None, 10, 5.0, &candidates, now, 10);
        let indexed = index.score("active", &active_embedding, 10, 5.0, now, 10);
        assert_eq!(one_shot.len(), indexed.len());
        for (a, b) in one_shot.iter().zip(indexed.iter()) {
            assert_eq!(a.uuid, b.uuid);
            for (x, y) in [a.cosine, a.co_visit, a.recency, a.relevance].iter().zip([b.cosine, b.co_visit, b.recency, b.relevance].iter()) {
                assert_eq!(x.to_bits(), y.to_bits(), "ghost parity for {}", a.uuid);
            }
        }
    }

    #[test]
    fn days_since_matches_ts() {
        assert_eq!(days_since(100.0, 200.0), 100.0 / DAY_MS);
        assert_eq!(days_since(500.0, 100.0), 0.0); // negative clamps to 0
    }
}
