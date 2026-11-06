'use strict';

const { cleanText } = require('./utils');

function normalizeForMatch(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function bigrams(text) {
  const result = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    result.push(text.slice(i, i + 2));
  }
  return result;
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const first = bigrams(a);
  const second = bigrams(b);
  const pool = new Map();
  for (const gram of second) pool.set(gram, (pool.get(gram) || 0) + 1);
  let hits = 0;
  for (const gram of first) {
    const count = pool.get(gram) || 0;
    if (count > 0) {
      hits += 1;
      pool.set(gram, count - 1);
    }
  }
  return (2 * hits) / (first.length + second.length);
}

function subsequenceScore(query, target) {
  if (!query || !target) return 0;
  let index = 0;
  let hits = 0;
  let lastHit = -1;
  for (let i = 0; i < target.length && index < query.length; i += 1) {
    if (target[i] === query[index]) {
      hits += 1;
      lastHit = i;
      index += 1;
    }
  }
  if (hits < Math.min(3, query.length)) return 0;
  const coverage = hits / query.length;
  const compact = 1 - Math.min(1, (lastHit - hits + 1) / Math.max(1, target.length));
  return coverage * 0.85 + compact * 0.15;
}

function tokenScore(query, target) {
  const tokens = target.split(/[\s\-_!·:：]+/).filter(Boolean);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => token.startsWith(query) || query.startsWith(token));
  return matched.length ? Math.min(1, matched.length / tokens.length + 0.35) : 0;
}

function fuzzyScore(query, item) {
  const q = normalizeForMatch(query);
  if (!q) return 0;
  const name = normalizeForMatch(item.name);
  const author = normalizeForMatch(item.author);
  const summary = normalizeForMatch(item.summary || item.description);
  let score = diceCoefficient(q, name) * 0.65 + subsequenceScore(q, name) * 0.25;
  score += tokenScore(q, String(item.name || '').toLowerCase()) * 0.1;
  if (author.includes(q)) score += 0.08;
  if (summary.includes(q)) score += 0.06;
  return Math.max(0, Math.min(1, score));
}

/**
 * Split a combined result list into the two blocks the UI shows:
 * exact (name equals / starts with / contains the query) and fuzzy.
 */
function classifyItem(item, query) {
  const q = normalizeForMatch(query);
  if (!q) return { ...item, match: 'fuzzy', matchRank: 9, matchScore: 0 };
  const name = normalizeForMatch(item.name);
  const author = normalizeForMatch(item.author);
  if (name === q) return { ...item, match: 'exact', matchRank: 0, matchScore: 1 };
  if (name.startsWith(q)) return { ...item, match: 'exact', matchRank: 1, matchScore: 1 };
  if (name.includes(q)) return { ...item, match: 'exact', matchRank: 2, matchScore: 1 };
  if (q.length >= 2 && author && author.includes(q)) {
    return { ...item, match: 'exact', matchRank: 3, matchScore: 0.95 };
  }
  return {
    ...item,
    match: 'fuzzy',
    matchRank: 9,
    matchScore: Number(fuzzyScore(query, item).toFixed(3)),
  };
}

function splitSearchResults(items, query) {
  const classified = (Array.isArray(items) ? items : []).map((item) => classifyItem(item, query));
  const exact = classified
    .filter((item) => item.match === 'exact')
    .sort(
      (a, b) =>
        a.matchRank - b.matchRank ||
        (b.downloads || b.favorites || 0) - (a.downloads || a.favorites || 0) ||
        String(a.name).localeCompare(String(b.name), 'zh-CN'),
    );
  const fuzzy = classified
    .filter((item) => item.match !== 'exact')
    .sort(
      (a, b) =>
        b.matchScore - a.matchScore ||
        (b.downloads || b.favorites || 0) - (a.downloads || a.favorites || 0),
    );
  return { exact, fuzzy };
}

module.exports = {
  normalizeForMatch,
  fuzzyScore,
  classifyItem,
  splitSearchResults,
};
