// src/index.js
import { runAlgorithm, hashWindow, MODEL_VERSION } from './algorithm.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPipeline(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 手动同步开关：?sync=1 时触发一次完整 pipeline（运维调试用，前端不用）
    if (url.searchParams.get('sync') === '1') {
      ctx.waitUntil(runPipeline(env));
    }

    try {
      if (url.pathname === '/api/history') {
        // ✅ 修复：API 请求不再触发抓数；抓数只走 Cron
        const { results } = await env.DB.prepare(
          'SELECT * FROM draws ORDER BY CAST(issue AS INTEGER) DESC LIMIT 300'
        ).all();
        return json({ success: true, data: results || [] });
      }

      // ✅ 补丁 2：快照接口 —— 前端唯一战绩来源
      if (url.pathname === '/api/predictions') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const { results } = await env.DB.prepare(`
          SELECT p.target_issue, p.predict_kill, p.predict_main, p.predict_defend,
                 p.model_version, p.window_hash, p.window_size,
                 p.actual_combo, p.hit, p.created_at,
                 d.draw_time, d.num_a, d.num_b, d.num_c, d.sum_val, d.combo
          FROM predictions p
          LEFT JOIN draws d ON d.issue = p.target_issue
          WHERE p.actual_combo IS NOT NULL
          ORDER BY CAST(p.target_issue AS INTEGER) DESC
          LIMIT ?
        `).bind(limit).all();
        return json({ success: true, data: results || [] });
      }

      // ✅ 补丁 2：当前未开奖的最新预测
      if (url.pathname === '/api/predictions/latest') {
        const row = await env.DB.prepare(`
          SELECT target_issue, predict_kill, predict_main, predict_defend,
                 model_version, window_hash, window_size, created_at
          FROM predictions
          WHERE actual_combo IS NULL
          ORDER BY CAST(target_issue AS INTEGER) DESC
          LIMIT 1
        `).first();
        return json({ success: true, data: row || null });
      }

      return new Response('PC28 Worker API Running', { status: 200, headers: CORS });
    } catch (err) {
      return json({ success: false, error: err.message }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

// ========== Pipeline ==========
async function runPipeline(env) {
  try {
    await fetchAndSaveData(env);
    await backfillHits(env);
    await generateAndSnapshot(env);
  } catch (e) {
    console.error('Pipeline error:', e);
  }
}

// 抓数 + 幂等写入（原逻辑保留，去重依赖唯一索引）
async function fetchAndSaveData(env) {
  const apis = [
    { url: 'https://yu28.top/api/kj?nbr=100', headers: { 'X-Api-Key': 'yu28_6e21b2467d66f604' } },
    { url: 'https://pc28.help/api/kj.json?nbr=100', headers: {} },
  ];

  for (const api of apis) {
    try {
      const res = await fetch(api.url, { headers: api.headers, cache: 'no-store' });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.message === 'success' && Array.isArray(j.data)) {
        for (const item of j.data) {
          let nums, sum, combo, dateStr, timeStr;

          if (item.number && item.number.includes('+') && !item.number.includes('=')) {
            nums = item.number.split('+').map(Number);
            sum = item.num != null ? item.num : nums.reduce((a, b) => a + b, 0);
            combo = item.combination;
            dateStr = item.date;
            timeStr = item.time;
          } else if (item.number && item.number.includes('=')) {
            const m = item.number.match(/(\d+)\+(\d+)\+(\d+)=(\d+)/);
            if (!m) continue;
            nums = [Number(m[1]), Number(m[2]), Number(m[3])];
            sum = Number(m[4]);
            combo = item.combination;
            const parts = (item.time || '').split(' ').filter(Boolean);
            dateStr = parts[0] || '';
            timeStr = parts[1] || '';
          } else continue;

          const size = sum >= 14 ? '大' : '小';
          const parity = sum % 2 === 1 ? '单' : '双';
          const finalCombo = combo || (size + parity);
          const drawTime = `${dateStr} ${timeStr}`.trim();

          await env.DB.prepare(`
            INSERT OR IGNORE INTO draws (issue, draw_time, num_a, num_b, num_c, sum_val, combo)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(String(item.nbr), drawTime, nums[0], nums[1], nums[2], sum, finalCombo).run();
        }
        return; // 主源成功即返回，不试备源
      }
    } catch (e) {
      console.error('Data fetch error:', e);
    }
  }
}

// ✅ 补丁 1：回填 hit（已开奖但未回填的预测）
async function backfillHits(env) {
  await env.DB.prepare(`
    UPDATE predictions
    SET actual_combo = (SELECT combo FROM draws d WHERE d.issue = predictions.target_issue),
        hit = CASE
          WHEN (SELECT combo FROM draws d WHERE d.issue = predictions.target_issue)
             = predictions.predict_kill THEN 0
          ELSE 1
        END
    WHERE actual_combo IS NULL
      AND EXISTS (SELECT 1 FROM draws d WHERE d.issue = predictions.target_issue)
  `).run();
}

// ✅ 补丁 1 + 4：生成下一期预测快照（幂等）
async function generateAndSnapshot(env) {
  const { results } = await env.DB.prepare(
    'SELECT issue, sum_val, combo FROM draws ORDER BY CAST(issue AS INTEGER) DESC LIMIT 51'
  ).all();
  if (!results || results.length < 30) return;

  const asc = results.reverse(); // 时间正序
  const lastIssue = Number(asc[asc.length - 1].issue);
  const nextIssue = String(lastIssue + 1);

  // 幂等：该期已生成过则跳过
  const exists = await env.DB.prepare(
    'SELECT 1 FROM predictions WHERE target_issue = ?'
  ).bind(nextIssue).first();
  if (exists) return;

  const windowDraws = asc.slice(-50);
  const seq = windowDraws.map(d => d.combo);
  const pred = runAlgorithm(seq, windowDraws);

  await env.DB.prepare(`
    INSERT OR IGNORE INTO predictions
      (target_issue, predict_kill, predict_main, predict_defend,
       signals_json, model_version, window_hash, window_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    nextIssue,
    pred.kill,
    JSON.stringify(pred.main),
    pred.defend,
    JSON.stringify(pred.scores),
    MODEL_VERSION,
    hashWindow(windowDraws),
    windowDraws.length
  ).run();
}
