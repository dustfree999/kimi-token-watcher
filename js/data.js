/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   定价 + 数据聚合 + 跨文件共享状态
   ============================================================ */
"use strict";

const PRICE_KEY = "kimi_token_prices";
const DEFAULT_PRICES = { miss: 3.0, cache: 0.1, cwrite: 0, out: 9.0, models: {} };
const DAY_MS = 86400000;

/* ---------- 跨文件共享状态（经典 script 全局作用域共享，render/main/views 均可读写） ---------- */
let current = null;
let range = "today"; // today | week | month | custom
let customRange = { start: null, end: null }; // 自定义范围（YYYY-MM-DD，含首尾）
let prices = loadPrices();
let chartGranularity = "hour"; // Token 使用趋势粒度：hour | day
const evFilter = { scope: "all", model: "" }; // 事件流过滤：全部/主/子/失败 + 模型
let sourceFilter = "all"; // 来源筛选：all=全部（顶层+Σ外部源）| kimi | zcode | dsh ...（外部源自带前缀）

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

/* ---------- 内置价格目录（models.dev，元/百万 tokens） ---------- */
const CATALOG_KEY = "kimi_token_price_catalog"; // localStorage 存用户手动同步下来的目录

/** 取当前生效的价格目录：优先 localStorage 同步版，其次内置静态 PRICING_CATALOG（js/pricing-catalog.js），都没有返回 null */
function getCatalog() {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && c.models) return c;
    }
  } catch (e) {}
  if (typeof PRICING_CATALOG !== "undefined" && PRICING_CATALOG && PRICING_CATALOG.models) return PRICING_CATALOG;
  return null;
}

/** 在价格目录中按策略匹配模型，命中返回 {miss, cache, cwrite:0, out}（元/百万 tokens），未命中返回 null */
function catalogPriceOf(model) {
  if (model == null) return null;
  const cat = getCatalog();
  if (!cat || !cat.models) return null;
  const models = cat.models;
  const target = String(model).trim();
  if (!target) return null;

  // 命中的目录条目 → 统一输出 4 槽位（cwrite 目录没有就补 0）
  const hit = id => {
    const m = models[id];
    if (!m) return null;
    return {
      miss: m.miss || 0,
      cache: m.cache || 0,
      cwrite: m.cwrite || 0,
      out: m.out || 0,
    };
  };

  // 1. 精确匹配
  if (models[target]) return hit(target);
  // 2. 双方小写后匹配
  const lower = target.toLowerCase();
  if (models[lower]) return hit(lower);
  // 3. aliases 小写匹配
  for (const [id, m] of Object.entries(models)) {
    if (m.aliases && m.aliases.some(a => String(a).toLowerCase() === lower)) return hit(id);
  }
  // 4. 模糊匹配：去掉 provider 前缀（如 火山codingplan/Kimi-K2.7-Code → Kimi-K2.7-Code）、转小写、去空格后，
  //    与目录模型 ID 的尾部或 aliases 做包含匹配
  const norm = target.split("/").pop().toLowerCase().replace(/\s+/g, "");
  if (norm && norm.length >= 3) {
    for (const [id, m] of Object.entries(models)) {
      const idNorm = String(id).toLowerCase().replace(/\s+/g, "");
      if (idNorm === norm || idNorm.endsWith(norm)) return hit(id);
      if (m.aliases) {
        for (const a of m.aliases) {
          const an = String(a).toLowerCase().replace(/\s+/g, "");
          if (an === norm || an.includes(norm) || norm.includes(an)) return hit(id);
        }
      }
    }
  }
  return null;
}

/* ---------- 数据选择：按范围聚合 days ---------- */
function buildRangeData(data, granularity = chartGranularity) {
  const days = data.days || {};
  const today = data.today;

  if (range === "today") {
    const day = projectDay(days[today]) || emptyDay(today);
    if (granularity === "hour") {
      return { day, buckets: todayBuckets(day), title: "今日小时趋势", label: "今日" };
    }
    return {
      day,
      buckets: [{
        key: today, label: today.slice(5), day,
        in: day.inputOther || 0, cache: day.inputCacheRead || 0, out: day.output || 0, req: day.requests || 0,
        cw: day.inputCacheCreation || 0,
      }],
      title: "今日日趋势", label: "今日",
    };
  }

  // week / month / custom：按日期键枚举（升序），口径统一走 rangeDayKeys
  const keys = rangeDayKeys(data);
  const dayBuckets = keys.map(k => ({ key: k, label: k.slice(5), day: projectDay(days[k]) || emptyDay(k) }));
  const agg = emptyDay("__agg__");
  for (const b of dayBuckets) mergeDay(agg, b.day);
  const label = rangeLabel();
  const title = label + (granularity === "day" ? (range === "custom" ? "日趋势" : "趋势") : "小时聚合");

  if (granularity === "day") {
    const buckets = dayBuckets.map(b => ({
      key: b.key, label: b.label, day: b.day,
      in: b.day.inputOther || 0, cache: b.day.inputCacheRead || 0, out: b.day.output || 0, req: b.day.requests || 0,
      cw: b.day.inputCacheCreation || 0,
    }));
    return { day: agg, buckets, title, label };
  }

  // hour granularity for week/month/custom: aggregate hourly data across days
  const hourly = new Array(24).fill(null).map((_, h) => ({
    key: h, label: String(h).padStart(2, "0"),
    in: 0, cache: 0, out: 0, cw: 0, req: 0,
  }));
  for (const b of dayBuckets) {
    const dayHourly = b.day.hourly || {};
    for (let h = 0; h < 24; h++) {
      const hv = dayHourly[h] || { input: 0, cached: 0, output: 0, requests: 0 };
      hourly[h].in += hv.input || 0;
      hourly[h].cache += hv.cached || 0;
      hourly[h].out += hv.output || 0;
      hourly[h].cw += hv.cacheWrite || 0;
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
  return { date, inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0, by_model: {}, by_session: {}, hourly: {}, by_scope: {}, by_source: {} };
}
/** 来源筛选投影：把某天的原始槽位投影为当前 sourceFilter 视角。
 *  kimi=顶层原样；all=顶层（纯 kimi）+Σ外部源槽（mergeDay 复用嵌套合并）；
 *  具体外部源=仅该源槽（零值补全），by_session/by_scope 只存在于顶层，外部源视角下保持空。 */
function projectDay(day) {
  if (!day) return null;
  if (sourceFilter === "kimi") return day;
  const bs = day.by_source || {};
  if (sourceFilter === "all") {
    // by_model/hourly/by_session/by_scope 全部重建为独立副本：与原始 day 共享引用时，
    // mergeDay 对已存在键原地 += 会污染 current 数据（by_session 条目含嵌套 by_model/hourly，
    // 由 mergeDay 从空对象拷出即得够深拷贝；by_source 只读不重建）
    const out = Object.assign({}, day, { by_model: {}, hourly: {}, by_session: {}, by_scope: {} });
    // 先把 kimi 顶层自身的嵌套并入新对象，再叠加外部源槽
    mergeDay(out, { by_model: day.by_model, hourly: day.hourly, by_session: day.by_session, by_scope: day.by_scope });
    for (const [src, slot] of Object.entries(bs)) {
      if (src !== "kimi" && slot) mergeDay(out, slot);
    }
    return out;
  }
  return Object.assign(emptyDay(day.date), bs[sourceFilter] || {});
}
function mergeDay(acc, d) {
  if (!d) return;
  // 所有累加点统一 (x||0)+(v||0)：缺键（如旧版本/外部源槽位）数据不产 NaN
  const add = (o, k, v) => { o[k] = (o[k] || 0) + (v || 0); };
  add(acc, "inputOther", d.inputOther);
  add(acc, "inputCacheRead", d.inputCacheRead);
  add(acc, "inputCacheCreation", d.inputCacheCreation);
  add(acc, "output", d.output);
  add(acc, "calls", d.calls);
  add(acc, "requests", d.requests);
  add(acc, "failed", d.failed);
  // 顶层小时分布（by_session 内的嵌套 hourly 在下方单独处理）
  for (const [hk, hv] of Object.entries(d.hourly || {})) {
    if (!acc.hourly) acc.hourly = {};
    if (!acc.hourly[hk]) acc.hourly[hk] = { input: 0, cached: 0, output: 0, calls: 0, requests: 0, cacheWrite: 0 };
    const hh = acc.hourly[hk];
    add(hh, "input", hv.input); add(hh, "cached", hv.cached); add(hh, "output", hv.output);
    add(hh, "calls", hv.calls); add(hh, "requests", hv.requests); add(hh, "cacheWrite", hv.cacheWrite);
  }
  for (const [k, v] of Object.entries(d.by_model || {})) {
    if (!acc.by_model[k]) {
      acc.by_model[k] = { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, ...v, model: k, failed: v.failed || 0 };
    } else {
      const m = acc.by_model[k];
      add(m, "inputOther", v.inputOther); add(m, "inputCacheRead", v.inputCacheRead);
      add(m, "inputCacheCreation", v.inputCacheCreation); add(m, "output", v.output);
      add(m, "calls", v.calls); add(m, "requests", v.requests); add(m, "failed", v.failed);
    }
  }
  for (const [k, v] of Object.entries(d.by_session || {})) {
    if (!acc.by_session[k]) {
      acc.by_session[k] = { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, ...v, session: k, by_model: {}, hourly: {}, failed: v.failed || 0 };
    } else {
      const x = acc.by_session[k];
      add(x, "inputOther", v.inputOther); add(x, "inputCacheRead", v.inputCacheRead);
      add(x, "inputCacheCreation", v.inputCacheCreation); add(x, "output", v.output);
      add(x, "calls", v.calls); add(x, "requests", v.requests); add(x, "failed", v.failed);
    }
    // 嵌套合并会话内模型构成与小时分布
    const xs = acc.by_session[k];
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!xs.by_model[mk]) {
        xs.by_model[mk] = { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, ...mv, model: mk, failed: mv.failed || 0 };
      } else {
        const mm = xs.by_model[mk];
        add(mm, "inputOther", mv.inputOther); add(mm, "inputCacheRead", mv.inputCacheRead);
        add(mm, "inputCacheCreation", mv.inputCacheCreation); add(mm, "output", mv.output);
        add(mm, "calls", mv.calls); add(mm, "requests", mv.requests); add(mm, "failed", mv.failed);
      }
    }
    for (const [hk, hv] of Object.entries(v.hourly || {})) {
      if (!xs.hourly[hk]) {
        xs.hourly[hk] = { input: 0, cached: 0, output: 0, calls: 0, requests: 0, cacheWrite: 0, ...hv };
      } else {
        const hh = xs.hourly[hk];
        add(hh, "input", hv.input); add(hh, "cached", hv.cached); add(hh, "output", hv.output);
        add(hh, "calls", hv.calls); add(hh, "requests", hv.requests); add(hh, "cacheWrite", hv.cacheWrite);
      }
    }
  }
  for (const [k, v] of Object.entries(d.by_scope || {})) {
    if (!acc.by_scope[k]) {
      acc.by_scope[k] = { scope: k, inputOther: 0, inputCacheRead: 0,
        inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0, by_model: {} };
    }
    const sc = acc.by_scope[k];
    add(sc, "inputOther", v.inputOther); add(sc, "inputCacheRead", v.inputCacheRead);
    add(sc, "inputCacheCreation", v.inputCacheCreation); add(sc, "output", v.output);
    add(sc, "calls", v.calls); add(sc, "requests", v.requests); add(sc, "failed", v.failed);
    // 嵌套合并作用域内各模型的用量（by_scope[scope].by_model）
    for (const [mk, mv] of Object.entries(v.by_model || {})) {
      if (!sc.by_model[mk]) {
        sc.by_model[mk] = { model: mk, inputOther: 0, inputCacheRead: 0,
          inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0 };
      }
      const mm = sc.by_model[mk];
      add(mm, "inputOther", mv.inputOther); add(mm, "inputCacheRead", mv.inputCacheRead);
      add(mm, "inputCacheCreation", mv.inputCacheCreation); add(mm, "output", mv.output);
      add(mm, "calls", mv.calls); add(mm, "requests", mv.requests); add(mm, "failed", mv.failed);
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
