import { Keyword, KeywordSource } from './kw-summon';

const SOURCE_WEIGHT_MAP: Record<KeywordSource, number> = {
  [KeywordSource.Edit]: 10,
  [KeywordSource.AST]: 8,
  [KeywordSource.Select]: 5,
  [KeywordSource.CursorContext]: 2,
};

const CO_OCCURRENCE_BONUS_RATE = 0.5;

function mergeKeywords(keywords: Keyword[]): Keyword[] {
  const mergedKeywords = new Map<string, Keyword>();
  keywords.forEach(kw => {
    if (mergedKeywords.has(kw.keyword)) {
      const merged = mergedKeywords.get(kw.keyword)!;
      kw.sources.forEach(source => merged.sources.add(source));
    } else {
      mergedKeywords.set(kw.keyword, {
        ...kw,
        sources: new Set([...Array.from(kw.sources)]),
      });
    }
  });
  return Array.from(mergedKeywords.values());
}

export function sortKeywords(keywords: Keyword[]): Keyword[] {
  keywords = mergeKeywords(keywords);
  const scoredKeywords = keywords.map(kw => {
    let sourceScore = 0;
    kw.sources.forEach(source => {
      sourceScore += SOURCE_WEIGHT_MAP[source] || 1;
    });
    const sourceCount = kw.sources.size;
    const multiplier = 1 + CO_OCCURRENCE_BONUS_RATE * Math.max(0, sourceCount - 1);
    kw.weight = (kw.weight + sourceScore) * multiplier + kw.keyword.length * 0.01;
    return kw;
  });
  return scoredKeywords.sort((a, b) => b.weight - a.weight);
}
