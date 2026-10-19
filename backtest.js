// backtest.js  —— 用法：node backtest.js draws.json
import fs from 'fs';
import { runAlgorithm, MODEL_VERSION } from './src/algorithm.js';

// ---------- 1. 载入 & 归一化 ----------
const raw = JSON.parse(fs.readFileSync(process.argv[2] || 'draws.json', 'utf8'));
const draws = (Array.isArray(raw) ? raw : raw.results || raw.data || [])
  .map(d => ({ issue: String(d.issue), sum_val: Number(d.sum_val), combo: d.combo }))
  .filter(d => d.combo && Number.isFinite(d.sum_val))
  .sort((a, b) => Number(a.issue) - Number(b.issue));

if (draws.length < 60) {
  console.error(`样本不足：${draws.length} 期，至少需要 60 期`);
  process.exit(1);
}

// ---------- 2. Walk-Forward 主循环 ----------
const WINDOW = 50;
const results = [];
for (let i = WINDOW; i < draws.length; i++) {
  const win = draws.slice(i - WINDOW, i);           // ← 严格 [i-WINDOW, i)
  const seq = win.map(d => d.combo);
  const pred = runAlgorithm(seq, win);
  const actual = draws[i].combo;
  results.push({
    issue: draws[i].issue,
    kill: pred.kill,
    actual,
    hit: actual !== pred.kill ? 1 : 0,
    pivotCount: win.slice(-10).filter(d => d.sum_val === 13 || d.sum_val === 14).length,
  });
}

// ---------- 3. 统计 ----------
const n = results.length;
const hits = results.reduce((s, r) => s + r.hit, 0);
const phat = hits / n;

// 理论概率（三个 0-9 均匀骰）
const PRIOR = { '小双': 0.231, '小单': 0.269, '大双': 0.269, '大单': 0.231 };
const BASE_RANDOM = 0.75;                                // 随机杀
const BASE_FIXED  = 1 - PRIOR['小双'];                   // 76.9% 固定杀小双/大单

function zTest(p0) {
  const se = Math.sqrt(p0 * (1 - p0) / n);
  const z = (phat - p0) / se;
  return { z, p: 2 * (1 - normalCDF(Math.abs(z))), se };
}

const tRandom = zTest(BASE_RANDOM);
const tFixed  = zTest(BASE_FIXED);

// ---------- 4. 分布诊断 ----------
function groupBy(key) {
  const m = {};
  results.forEach(r => { (m[r[key]] ||= []).push(r.hit); });
  return Object.entries(m).map(([k, arr]) => ({
    key: k, n: arr.length, hits: arr.reduce((a,b)=>a+b,0), rate: arr.reduce((a,b)=>a+b,0)/arr.length,
  }));
}

console.log('════════════════ PC28 Walk-Forward 回测 ════════════════');
console.log(`模型版本      : ${MODEL_VERSION}`);
console.log(`窗口          : ${WINDOW} 期`);
console.log(`样本期数 n    : ${n}`);
console.log(`覆盖期号      : ${results[0].issue} → ${results[n-1].issue}`);
console.log('');
console.log('───── 1. 总体命中 ─────');
console.log(`命中 / 总数   : ${hits} / ${n} = ${(phat*100).toFixed(2)}%`);
console.log(`随机基线 75%  : z = ${tRandom.z.toFixed(3)}, p = ${tRandom.p.toFixed(4)} ${sig(tRandom.p)}`);
console.log(`固定基线 76.9%: z = ${tFixed.z.toFixed(3)}, p = ${tFixed.p.toFixed(4)} ${sig(tFixed.p)}`);
console.log(`95% CI        : [${((phat-1.96*tRandom.se)*100).toFixed(2)}%, ${((phat+1.96*tRandom.se)*100).toFixed(2)}%]`);
console.log('');
console.log('───── 2. 按被杀类别分组 ─────');
groupBy('kill').sort((a,b)=>b.n-a.n).forEach(g => {
  console.log(`  杀 ${g.key.padEnd(3)} : ${g.hits}/${g.n} = ${(g.rate*100).toFixed(2)}%  (该类真实概率 ${(PRIOR[g.key]*100).toFixed(1)}%)`);
});
console.log('');
console.log('───── 3. 按 pivotCount 分组 ─────');
groupBy('pivotCount').sort((a,b)=>Number(a.key)-Number(b.key)).forEach(g => {
  console.log(`  pivot=${g.key} : ${g.hits}/${g.n} = ${(g.rate*100).toFixed(2)}%`);
});
console.log('');
console.log('───── 4. 分段稳定性（每 n/4）─────');
const q = Math.floor(n / 4);
for (let k = 0; k < 4; k++) {
  const seg = results.slice(k*q, (k+1)*q);
  const h = seg.reduce((s,r)=>s+r.hit,0);
  console.log(`  段${k+1} : ${h}/${seg.length} = ${(h/seg.length*100).toFixed(2)}%  (期号 ${seg[0].issue}–${seg[seg.length-1].issue})`);
}
console.log('');
console.log('───── 5. 结论 ─────');
if (tFixed.p < 0.05 && phat > BASE_FIXED) {
  console.log('✅ 显著超越固定最优基线 76.9%，当前算法有真实 alpha。');
} else if (tRandom.p < 0.05 && phat > BASE_RANDOM) {
  console.log('⚠ 显著优于随机 75%，但未超越固定最优基线 76.9%。');
  console.log('   说明优势可能来自"杀类选择偏好"，而非动量信号。');
} else if (tRandom.p >= 0.05) {
  console.log('❌ 与随机无显著差异。当前算法无统计意义上的预测能力。');
  console.log('   建议：保留工程闭环，废弃 v1.0.0 算法，重新设计。');
} else {
  console.log('❌ 显著劣于随机基线，算法方向性错误，建议停用。');
}

// ---------- 工具 ----------
function sig(p){ return p<0.001?'***':p<0.01?'**':p<0.05?'*':p<0.1?'.':''; }
function normalCDF(z) {
  // Abramowitz & Stegun 近似，误差 < 7.5e-8
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return 0.5 * (1 + s * y);
}
