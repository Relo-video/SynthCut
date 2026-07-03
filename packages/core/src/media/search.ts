import type { MediaAsset } from "../types.js";

export interface TranscriptHit {
  assetId: string;
  assetName: string;
  /** Seconds within the asset. */
  start: number;
  end: number;
  text: string;
  /** Relevance score (higher = better). */
  score: number;
}

const WORD = /[\p{L}\p{N}']+/gu;
const terms = (s: string): string[] => (s.toLowerCase().match(WORD) ?? []);

/**
 * Rank spoken-word hits across all indexed asset transcripts for a free-text
 * query. Scoring favors exact phrase matches, then the fraction of query terms
 * present in a segment. Pure and deterministic (unit-testable).
 */
export function rankTranscript(assets: MediaAsset[], query: string, limit = 20): TranscriptHit[] {
  const qTerms = terms(query);
  const phrase = query.trim().toLowerCase();
  if (qTerms.length === 0) return [];
  const qSet = new Set(qTerms);

  const hits: TranscriptHit[] = [];
  for (const asset of assets) {
    const segs = asset.transcript?.segments;
    if (!segs?.length) continue;
    for (const seg of segs) {
      const lower = seg.text.toLowerCase();
      const segTerms = terms(seg.text);
      let matched = 0;
      for (const t of segTerms) if (qSet.has(t)) matched++;
      if (matched === 0 && !lower.includes(phrase)) continue;
      // term coverage 0..1, plus a strong bonus for the full phrase appearing.
      const coverage = matched / qTerms.length;
      const phraseBonus = phrase.length > 1 && lower.includes(phrase) ? 1 : 0;
      const score = coverage + phraseBonus * 2;
      if (score <= 0) continue;
      hits.push({
        assetId: asset.id,
        assetName: asset.name,
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
        score: Number(score.toFixed(4)),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.start - b.start);
  return hits.slice(0, limit);
}
