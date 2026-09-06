/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   工具函数 + 格式化
   依赖：共享全局 prices（js/data.js）用于费用计算
   ============================================================ */
"use strict";

const fmt = new Intl.NumberFormat("zh-CN");
const sigs = {};             // 各区块数据签名，相同则跳过重建（局部更新）

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* ---------- 工具：事件键 / 签名 / 复制 ---------- */
/** 事件稳定键：优先 eventId（int），缺失回退时间戳 */
function keyOf(ev) { return ev.eventId != null ? ev.eventId : ev.time; }
/** 数据签名变化检测：与上次一致返回 false（跳过该区块重建） */
function changed(key, val) {
  const s = JSON.stringify(val);
  if (sigs[key] === s) return false;
  sigs[key] = s;
  return true;
}
/** 复制文本到剪贴板，失败回退隐藏 textarea + execCommand */
function copyText(text, btn) {
  const flash = (msg) => {
    btn.textContent = msg;
    setTimeout(() => { if (btn.isConnected) btn.textContent = btn.dataset.label || "复制"; }, 1200);
  };
  const done = () => flash("已复制");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done, flash));
  } else {
    fallbackCopy(text, done, flash);
  }
}
function fallbackCopy(text, done, flash) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  ta.remove();
  ok ? done() : (flash && flash("复制失败"));
}

/* ---------- 格式化 ---------- */
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e7) return (n / 1e6).toFixed(1) + "M";
  if (n >= 999.95e3) return (n / 1e6).toFixed(2) + "M"; // 近 1000k 进位为 M，避免 1000.0k
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return fmt.format(Math.round(n));
}
/** 亿为主单位：x.x亿 token；<1亿 时退回 M/k */
function fmtYi(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  return fmtTok(n);
}
/** 完整数字（悬浮提示用） */
function fmtFull(n) { return fmt.format(Math.round(n || 0)); }
/* ---------- 计价 ---------- */
/** 取某模型的计价：用户手动覆盖 > 价格目录（内置/同步，js/data.js catalogPriceOf）> 全局默认 prices */
function priceOf(model) {
  const m = prices.models || {};
  if (model != null && m[model]) return m[model];
  const cp = catalogPriceOf(model);
  if (cp) return cp;
  return prices;
}
/** 单槽位计价：model 参数可选，给了则按该模型（覆盖或默认）计价 */
function costOf(d, model) {
  const p = model != null ? priceOf(model) : prices;
  return ((d.inputOther || 0) / 1e6) * p.miss
       + ((d.inputCacheRead || 0) / 1e6) * p.cache
       + ((d.inputCacheCreation || 0) / 1e6) * p.cwrite
       + ((d.output || 0) / 1e6) * p.out;
}
/** 混合槽位（日/会话）计价：有 by_model 时按各模型分别计价求和（精确），否则退回 costOf(d) */
function costOfAgg(d) {
  const bm = d.by_model;
  if (bm && Object.keys(bm).length) {
    let s = 0;
    for (const m of Object.values(bm)) s += costOf(m, m.model);
    return s;
  }
  return costOf(d);
}
/* 费用四分类调色板：经 CSS 变量取色（见 base.css --cc-*），随主题切换 */
const COST_CAT_COLORS = ["var(--cc-0)", "var(--cc-1)", "var(--cc-2)", "var(--cc-3)"];
const COST_CAT_LABELS = ["输入未命中", "缓存命中", "缓存写入", "输出"];
/** 四分类费用构成 [{label,value,color,key}]：model 给定按单模型计价；否则混合槽位按 by_model 分摊后汇总四类 */
function costPartsOf(d, model) {
  let miss = 0, cache = 0, cwrite = 0, out = 0;
  if (model != null) {
    const p = priceOf(model);
    miss = ((d.inputOther || 0) / 1e6) * p.miss;
    cache = ((d.inputCacheRead || 0) / 1e6) * p.cache;
    cwrite = ((d.inputCacheCreation || 0) / 1e6) * p.cwrite;
    out = ((d.output || 0) / 1e6) * p.out;
  } else if (d.by_model && Object.keys(d.by_model).length) {
    for (const m of Object.values(d.by_model)) {
      const p = priceOf(m.model);
      miss += ((m.inputOther || 0) / 1e6) * p.miss;
      cache += ((m.inputCacheRead || 0) / 1e6) * p.cache;
      cwrite += ((m.inputCacheCreation || 0) / 1e6) * p.cwrite;
      out += ((m.output || 0) / 1e6) * p.out;
    }
  } else {
    miss = ((d.inputOther || 0) / 1e6) * prices.miss;
    cache = ((d.inputCacheRead || 0) / 1e6) * prices.cache;
    cwrite = ((d.inputCacheCreation || 0) / 1e6) * prices.cwrite;
    out = ((d.output || 0) / 1e6) * prices.out;
  }
  return [
    { label: COST_CAT_LABELS[0], value: miss, color: COST_CAT_COLORS[0], key: "¥" + miss.toFixed(2) },
    { label: COST_CAT_LABELS[1], value: cache, color: COST_CAT_COLORS[1], key: "¥" + cache.toFixed(2) },
    { label: COST_CAT_LABELS[2], value: cwrite, color: COST_CAT_COLORS[2], key: "¥" + cwrite.toFixed(2) },
    { label: COST_CAT_LABELS[3], value: out, color: COST_CAT_COLORS[3], key: "¥" + out.toFixed(2) },
  ];
}
function totOf(d) { return (d.inputOther || 0) + (d.inputCacheRead || 0) + (d.output || 0); }
function shortSid(s) {
  return s.length > 16 ? s.slice(0, 10) + "…" + s.slice(-5) : s;
}
/** 峰值小时区间格式，如 14 点 → "14:00 - 15:00" */
function peakRange(h) {
  return String(h).padStart(2, "0") + ":00 - " + String((+h + 1) % 24).padStart(2, "0") + ":00";
}
/** 较1小时前速率趋势（%）：当前小时累计/已过分钟 vs 上一小时整时速率；无上一小时数据返回 null */
function hourRateTrend(d) {
  const hv = d && d.hourly;
  if (!hv) return null;
  const now = new Date();
  const cur = hv[String(now.getHours())];
  const prev = hv[String((now.getHours() + 23) % 24)];
  if (!cur || !prev) return null;
  const curRate = (cur.input + cur.cached + cur.output) / Math.max(now.getMinutes() + 1, 1);
  const prevRate = (prev.input + prev.cached + prev.output) / 60;
  if (prevRate <= 0) return null;
  return ((curRate - prevRate) / prevRate) * 100;
}
