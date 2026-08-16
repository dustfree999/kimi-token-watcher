/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   定价 + 数据聚合 + 跨文件共享状态
   ============================================================ */
"use strict";

const PRICE_KEY = "kimi_token_prices";
const DEFAULT_PRICES = { miss: 1.0, cache: 0.02, cwrite: 0, out: 2.0, models: {} };
const DAY_MS = 86400000;

/* ---------- 跨文件共享状态（经典 script 全局作用域共享，render/main/views 均可读写） ---------- */
let current = null;
let range = "today"; // today | week | month | custom
let customRange = { start: null, end: null }; // 自定义范围（YYYY-MM-DD，含首尾）
let prices = loadPrices();
let autoFollow = true;       // 事件流是否自动跟随顶部（用户滚离顶部即暂停）
let chartGranularity = "hour"; // Token 使用趋势粒度：hour | day
const evFilter = { scope: "all", model: "" }; // 事件流过滤：全部/主/子 + 模型

/* ---------- 定价 ---------- */
function loadPrices() {
  const base = { ...DEFAULT_PRICES, models: { ...DEFAULT_PRICES.models } }; // 深拷贝 models，避免污染默认模板
  try {
    const raw = localStorage.getItem(PRICE_KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch (e) {}
  // 兼容旧格式：无 models 键（或为空）时补齐
  if (!base.models || typeof base.models !== "object") base.models = {};
  return base;
}
function savePrices() { localStorage.setItem(PRICE_KEY, JSON.stringify(prices)); }

/* ---------- 数据选择：按范围聚合 days ---------- */
function buildRangeData(data, granularity = chartGranularity) {
  const days = data.days || {};
  const today = data.today;

  if (range === "today") {
    const day = days[today] || emptyDay(today);
    if (granularity === "hour") {
      return { day, buckets: todayBuckets(day), title: "今日小时趋势", label: "今日" };
    }
    return {
      day,
      buckets: [{
        key: today, label: today.slice(5), day,
        in: day.inputOther || 0, cache: day.inputCacheRead || 0, out: day.output || 0, req: day.requests || 0,
      }],
      title: "今日日趋势", label: "今日",
    };
  }

  // week / month / custom：按日期键枚举（升序），口径统一走 rangeDayKeys
  const keys = rangeDayKeys(data);
  const dayBuckets = keys.map(k => ({ key: k, label: k.slice(5), day: days[k] || emptyDay(k) }));
  const agg = emptyDay("__agg__");
  for (const b of dayBuckets) mergeDay(agg, b.day);
  const label = rangeLabel();
  const title = label + (granularity === "day" ? (range === "custom" ? "日趋势" : "趋势") : "小时聚合");

  if (granularity === "day") {
    const buckets = dayBuckets.map(b => ({
      key: b.key, label: b.label, day: b.day,
      in: b.day.inputOther || 0, cache: b.day.inputCacheRead || 0, out: b.day.output || 0, req: b.day.requests || 0,
    }));
    return { day: agg, buckets, title, label };
  }

  // hour granularity for week/month/custom: aggregate hourly data across days
  const hourly = new Array(24).fill(null).map((_, h) => ({
    key: h, label: String(h).padStart(2, "0"),
    in: 0, cache: 0, out: 0, req: 0,
  }));
  for (const b of dayBuckets) {
    const dayHourly = b.day.hourly || {};
    for (let h = 0; h < 24; h++) {
      const hv = dayHourly[h] || { input: 0, cached: 0, output: 0, requests: 0 };
      hourly[h].in += hv.input || 0;
      hourly[h].cache += hv.cached || 0;
      hourly[h].out += hv.output || 0;
      hourly[h].req += hv.requests || 0;
    }
  }
  return { day: agg, buckets: hourly, title, label };
}
/** 当前 range 的日期键数组（升序）：today→[今日]；week→近7天；month→近30天；custom→start..end 闭区间 */
function rangeDayKeys(data) {
  const today = data.today;
  if (range === "today") return [today];
  if (range === "week" || range === "month") {
    const n = range === "week" ? 7 : 30;
    const nowMs = data.now != null ? data.now * 1000 : Date.now();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(nowMs - i * DAY_MS);
      out.push(localDateKey(d));
    }
    return out;
  }
  // custom：start..end 逐日（防呆：start>end 交换、跨度上限 366 天、end 不超过今日）
  let s = customRange.start, e = customRange.end;
  if (!s || !e) return [today];
  if (s > e) { const t = s; s = e; e = t; }
  if (today && e > today) e = today;
  const out = [];
  const cur = new Date(s + "T00:00:00");
  const end = new Date(e + "T00:00:00");
  let guard = 0;
  while (cur <= end && guard < 366) {
    out.push(localDateKey(cur));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return out;
}
/** 当前范围的中文标签：今日 / 近 7 天 / 近 30 天 / MM-DD ~ MM-DD */
function rangeLabel() {
  if (range === "today") return "今日";
  if (range === "week") return "近 7 天";
  if (range === "month") return "近 30 天";
  const s = customRange.start, e = customRange.end;
  if (!s || !e) return "今日";
  return s.slice(5) + " ~ " + e.slice(5);
}
function localDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function emptyDay(date) {
  return { date, inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0, by_model: {}, by_session: {}, hourly: {}, by_scope: {} };
}
function mergeDay(acc, d) {
  if (!d) return;
  acc.inputOther += d.inputOther || 0;
  acc.inputCacheRead += d.inputCacheRead || 0;
  acc.inputCacheCreation += d.inputCacheCreation || 0;
  acc.output += d.output || 0;
  acc.calls += d.calls || 0;
  acc.requests += d.requests || 0;
  acc.failed += d.failed || 0;
  for (const [k, v] of Object.entries(d.by_model || {})) {
    if (!acc.by_model[k]) acc.by_model[k] = { ...v, model: k, failed: v.failed || 0 };
    else {
      const m = acc.by_model[k];
      m.inputOther += v.inputOther || 0; m.inputCacheRead += v.inputCacheRead || 0;
      m.inputCacheCreation += v.inputCacheCreation || 0; m.output += v.output || 0; m.calls += v.calls || 0; m.requests += v.requests || 0;
      m.failed = (m.failed || 0) + (v.failed || 0);
    }
  }
  for (const [k, v] of Object.entries(d.by_session || {})) {
    if (!acc.by_session[k]) acc.by_session[k] = { ...v, session: k, by_model: {}, hourly: {}, failed: v.failed || 0 };
    else {
      const x = acc.by_session[k];
      x.inputOther += v.inputOther || 0; x.inputCacheRead += v.inputCacheRead || 0;
      x.inputCacheCreation += v.inputCacheCreation || 0; x.output += v.output || 0; x.calls += v.calls || 0; x.requests += v.requests || 0;
      x.failed = (x.failed || 0) + (v.failed || 0);
    }
    // 嵌套合并会话内模型构成与小时分布
    const xs = acc.by_session[k];
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!xs.by_model[mk]) xs.by_model[mk] = { ...mv, model: mk, failed: mv.failed || 0 };
      else {
        const mm = xs.by_model[mk];
        mm.inputOther += mv.inputOther || 0; mm.inputCacheRead += mv.inputCacheRead || 0;
        mm.inputCacheCreation += mv.inputCacheCreation || 0; mm.output += mv.output || 0; mm.calls += mv.calls || 0; mm.requests += mv.requests || 0;
        mm.failed = (mm.failed || 0) + (mv.failed || 0);
      }
    }
    for (const [hk, hv] of Object.entries(v.hourly || {})) {
      if (!xs.hourly[hk]) xs.hourly[hk] = { ...hv };
      else {
        const hh = xs.hourly[hk];
        hh.input += hv.input || 0; hh.cached += hv.cached || 0; hh.output += hv.output || 0; hh.calls += hv.calls || 0; hh.requests += hv.requests || 0;
      }
    }
  }
  for (const [k, v] of Object.entries(d.by_scope || {})) {
    if (!acc.by_scope[k]) {
      acc.by_scope[k] = { scope: k, inputOther: 0, inputCacheRead: 0,
        inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0, by_model: {} };
    }
    const sc = acc.by_scope[k];
    sc.inputOther += v.inputOther || 0; sc.inputCacheRead += v.inputCacheRead || 0;
    sc.inputCacheCreation += v.inputCacheCreation || 0; sc.output += v.output || 0;
    sc.calls += v.calls || 0; sc.requests += v.requests || 0;
    sc.failed = (sc.failed || 0) + (v.failed || 0);
    // 嵌套合并作用域内各模型的用量（by_scope[scope].by_model）
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!sc.by_model[mk]) {
        sc.by_model[mk] = { model: mk, inputOther: 0, inputCacheRead: 0,
          inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0 };
      }
      const mm = sc.by_model[mk];
      mm.inputOther += mv.inputOther || 0; mm.inputCacheRead += mv.inputCacheRead || 0;
      mm.inputCacheCreation += mv.inputCacheCreation || 0; mm.output += mv.output || 0;
      mm.calls += mv.calls || 0; mm.requests += mv.requests || 0;
      mm.failed = (mm.failed || 0) + (mv.failed || 0);
    }
  }
}
function todayBuckets(day) {
  // 今日：24 个小时桶
  const buckets = [];
  for (let h = 0; h < 24; h++) {
    const hv = (day && day.hourly && day.hourly[h]) || { input: 0, cached: 0, output: 0 };
    buckets.push({
      key: h, label: String(h).padStart(2, "0"),
      in: hv.input || 0, cache: hv.cached || 0, out: hv.output || 0,
      cw: hv.cacheWrite || 0,
      req: hv.requests || 0,
    });
  }
  return buckets;
}
