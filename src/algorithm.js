// src/algorithm.js
// ⚠️ 本文件为 v1.0.0 原始算法，未做任何修正。
// 任何改动必须同步提升 MODEL_VERSION。

export const MODEL_VERSION = 'v1.0.0';

export function runAlgorithm(seq, draws) {
  const categories = ['大双', '大单', '小双', '小单'];
  const N = seq ? seq.length : 0;

  if (N < 10) {
    const scores = {};
    categories.forEach(c => scores[c] = { score: 0.25, note: '样本积累中' });
    return {
      kill: categories[0],
      main: [categories[1], categories[2]],
      defend: categories[3],
      scores,
      bestParams: '样本积累中(<10期)',
    };
  }

  const windowSize = Math.min(50, N);
  const recentSeq = seq.slice(-windowSize);
  const recentDraws = draws ? draws.slice(-windowSize) : [];

  const counts = { '大双': 0, '大单': 0, '小双': 0, '小单': 0 };
  const omission = { '大双': 0, '大单': 0, '小双': 0, '小单': 0 };

  recentSeq.forEach(c => { if (counts[c] !== undefined) counts[c]++; });
  categories.forEach(c => {
    const lastIdx = recentSeq.lastIndexOf(c);
    omission[c] = lastIdx === -1 ? windowSize : (recentSeq.length - 1 - lastIdx);
  });

  let pivotCount = 0;
  recentDraws.slice(-10).forEach(d => {
    if (d.sum_val === 13 || d.sum_val === 14) pivotCount++;
  });

  const scores = {};
  categories.forEach(c => {
    const freqScore = (counts[c] / windowSize) * 100;
    const omisScore = omission[c] * 1.5;
    let totalScore = freqScore + omisScore;

    if (pivotCount >= 4 && (c === '小单' || c === '大双')) {
      totalScore += 12.0;
    }

    scores[c] = {
      score: Number(totalScore.toFixed(2)),
      note: `频次:${counts[c]} 遗漏:${omission[c]}`,
    };
  });

  const ranked = [...categories].sort((a, b) => scores[a].score - scores[b].score);

  return {
    kill: ranked[0],
    defend: ranked[1],
    main: [ranked[3], ranked[2]],
    ranked,
    scores,
    bestParams: `信号融合策略 [分析窗口:${windowSize}期]`,
  };
}

// 审计用窗口指纹（FNV-1a 32bit）
export function hashWindow(draws) {
  const s = draws.map(d => `${d.issue}:${d.sum_val}`).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
