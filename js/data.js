/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   定价 + 数据聚合 + 跨文件共享状态
   ============================================================ */
"use strict";

const PRICE_KEY = "kimi_token_prices";
const DEFAULT_PRICES = { miss: 1.0, cache: 0.02, cwrite: 0, out: 2.0 };
const DAY_MS = 86400000;

/* ---------- 跨文件共享状态（经典 script 全局作用域共享，render/main/views 均可读写） ---------- */
let current = null;
let range = "today"; // today | week | month
let prices = loadPrices();
let autoFollow = true;       // 事件流是否自动跟随顶部（用户滚离顶部即暂停）
let chartGranularity = "hour"; // Token 使用趋势粒度：hour | day
const evFilter = { scope: "all", model: "" }; // 事件流过滤：全部/主/子 + 模型

/* ---------- 定价 ---------- */
function loadPrices() {
  try {
    const raw = localStorage.getItem(PRICE_KEY);
    if (raw) return { ...DEFAULT_PRICES, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_PRICES };
}
function savePrices() { localStorage.setItem(PRICE_KEY, JSON.stringify(prices)); }

/* ---------- 数据选择：按范围聚合 days ---------- */
function buildRangeData(data, granularity = chartGranularity) {
  const days = data.days || {};
  const today = data.today;
  const todayDate = new Date(data.now * 1000);

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

  const nDays = range === "week" ? 7 : 31;
  const dayBuckets = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date(todayDate.getTime() - i * DAY_MS);
    const localKey = localDateKey(d);
    const day = days[localKey] || emptyDay(localKey);
    dayBuckets.push({ key: localKey, label: localKey.slice(5), day });
  }
  const agg = emptyDay("__agg__");
  for (const b of dayBuckets) mergeDay(agg, b.day);

  if (granularity === "day") {
    const buckets = dayBuckets.map(b => ({
      key: b.key, label: b.label, day: b.day,
      in: b.day.inputOther || 0, cache: b.day.inputCacheRead || 0, out: b.day.output || 0, req: b.day.requests || 0,
    }));
    return { day: agg, buckets, title: range === "week" ? "近 7 天趋势" : "近 30 天趋势", label: range === "week" ? "近 7 天" : "近 30 天" };
  }

  // hour granularity for week/month: aggregate hourly data across days
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
  return { day: agg, buckets: hourly, title: range === "week" ? "近 7 天小时聚合" : "近 30 天小时聚合", label: range === "week" ? "近 7 天" : "近 30 天" };
}
function localDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function emptyDay(date) {
  return { date, inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, by_model: {}, by_session: {}, hourly: {}, by_scope: {} };
}
function mergeDay(acc, d) {
  if (!d) return;
  acc.inputOther += d.inputOther || 0;
  acc.inputCacheRead += d.inputCacheRead || 0;
  acc.inputCacheCreation += d.inputCacheCreation || 0;
  acc.output += d.output || 0;
  acc.calls += d.calls || 0;
  acc.requests += d.requests || 0;
  for (const [k, v] of Object.entries(d.by_model || {})) {
    if (!acc.by_model[k]) acc.by_model[k] = { ...v, model: k };
    else {
      const m = acc.by_model[k];
      m.inputOther += v.inputOther || 0; m.inputCacheRead += v.inputCacheRead || 0;
      m.inputCacheCreation += v.inputCacheCreation || 0; m.output += v.output || 0; m.calls += v.calls || 0; m.requests += v.requests || 0;
    }
  }
  for (const [k, v] of Object.entries(d.by_session || {})) {
    if (!acc.by_session[k]) acc.by_session[k] = { ...v, session: k, by_model: {}, hourly: {} };
    else {
      const x = acc.by_session[k];
      x.inputOther += v.inputOther || 0; x.inputCacheRead += v.inputCacheRead || 0;
      x.inputCacheCreation += v.inputCacheCreation || 0; x.output += v.output || 0; x.calls += v.calls || 0; x.requests += v.requests || 0;
    }
    // 嵌套合并会话内模型构成与小时分布
    const xs = acc.by_session[k];
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!xs.by_model[mk]) xs.by_model[mk] = { ...mv, model: mk };
      else {
        const mm = xs.by_model[mk];
        mm.inputOther += mv.inputOther || 0; mm.inputCacheRead += mv.inputCacheRead || 0;
        mm.inputCacheCreation += mv.inputCacheCreation || 0; mm.output += mv.output || 0; mm.calls += mv.calls || 0; mm.requests += mv.requests || 0;
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
        inputCacheCreation: 0, output: 0, calls: 0, requests: 0, by_model: {} };
    }
    const sc = acc.by_scope[k];
    sc.inputOther += v.inputOther || 0; sc.inputCacheRead += v.inputCacheRead || 0;
    sc.inputCacheCreation += v.inputCacheCreation || 0; sc.output += v.output || 0;
    sc.calls += v.calls || 0; sc.requests += v.requests || 0;
    // 嵌套合并作用域内各模型的用量（by_scope[scope].by_model）
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!sc.by_model[mk]) {
        sc.by_model[mk] = { model: mk, inputOther: 0, inputCacheRead: 0,
          inputCacheCreation: 0, output: 0, calls: 0, requests: 0 };
      }
      const mm = sc.by_model[mk];
      mm.inputOther += mv.inputOther || 0; mm.inputCacheRead += mv.inputCacheRead || 0;
      mm.inputCacheCreation += mv.inputCacheCreation || 0; mm.output += mv.output || 0;
      mm.calls += mv.calls || 0; mm.requests += mv.requests || 0;
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
