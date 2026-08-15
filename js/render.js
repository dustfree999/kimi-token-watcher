/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   渲染 + 定价弹窗
   依赖：全局 el/esc/keyOf/copyText/changed/fmtTok/fmtYi/fmtFull/
         costOf/totOf/peakRange/hourRateTrend（js/utils.js）、
         current/range/prices/chartGranularity/autoFollow/
         evFilter（js/data.js）
   ============================================================ */
"use strict";

/* ---------- 渲染专属状态 ---------- */
let evMore = false;          // 事件流：默认 60 条，true 展示最多 200 条
const expandedSessions = new Set(); // 记住已展开的会话，轮询重绘时恢复

/* ---------- 渲染 ---------- */
function render(data) {
  current = data;
  // 非概览视图：只做全局状态 + 视图分发（views.js）
  if (window.Views && window.Views.currentView() !== "overview") {
    renderStatus(data);
    window.Views.renderView(data, range);
    return;
  }
  const rd = buildRangeData(data);
  const d = rd.day;

  // 指标区
  el("m-total-label").textContent = rd.label + "总 Tokens";
  el("m-total").textContent = fmtYi(totOf(d));
  el("m-total").title = fmtFull(totOf(d)) + " tokens · " + (d.calls || 0) + " 回合 · 平均 " + fmtTok(d.calls ? totOf(d) / d.calls : 0) + " /回合";
  // 副行：输入/输出（带色点）+ 较昨日趋势
  let totalSub =
    `<span style="white-space:nowrap;">输入 ${fmtTok(d.inputOther)} <i class="dot-out"></i>输出 ${fmtTok(d.output)}</span>`;
  const vs = (range === "today" && data.vs_yesterday && data.vs_yesterday.pct != null) ? data.vs_yesterday.pct : null;
  if (vs != null) {
    const up = vs >= 0;
    const pct = Math.abs(vs).toFixed(Math.abs(vs) >= 10 ? 1 : 2);
    totalSub += `<br><span class="${up ? "trend-up" : "trend-down"}">较昨日 ${up ? "↑" : "↓"}${pct}%</span>`;
  }
  el("m-total-sub").innerHTML = totalSub;
  el("m-cost").textContent = costOf(d).toFixed(2);
  el("m-cost").title = "¥" + costOf(d).toFixed(4);
  el("m-cost-sub").textContent = "输入 ¥" + ((d.inputOther/1e6)*prices.miss).toFixed(2) +
    " · 缓存 ¥" + ((d.inputCacheRead/1e6)*prices.cache).toFixed(2) +
    " · 缓存写 ¥" + ((d.inputCacheCreation/1e6)*prices.cwrite).toFixed(2) +
    " · 输出 ¥" + ((d.output/1e6)*prices.out).toFixed(2);
  const inp = d.inputOther + d.inputCacheRead;
  el("m-cache").textContent = inp > 0 ? (d.inputCacheRead / inp * 100).toFixed(1) + "%" : "—";
  el("m-cache-sub").textContent = inp > 0
    ? "缓存读 " + fmtTok(d.inputCacheRead) + " · 缓存写 " + fmtTok(d.inputCacheCreation)
    : "暂无输入";
  el("m-cache").title = inp > 0 ? `${fmtFull(d.inputCacheRead)} / ${fmtFull(inp)} tokens 输入缓存率` : "";
  el("m-calls").textContent = fmt.format(d.requests || d.calls);
  el("m-calls").title = `${fmtFull(d.requests || 0)} 次请求 (step) · ${fmtFull(d.calls)} 回合 (turn)`;
  el("m-calls-sub").textContent = "回合数 " + fmt.format(d.calls);
  // 峰值 / 速率（仅今日有意义）
  if (range === "today") {
    const peak = data.peak_hour;
    el("m-peak").textContent = peak ? peakRange(peak.hour) : "—";
    el("m-peak-sub").textContent = peak ? fmtTok(peak.total) + " tokens" : "今日暂无";
    el("m-peak").title = peak ? fmtFull(peak.total) + " tokens" : "";
    // 速率：主显示近 1 分钟速率（xx/s），副行小字 xx/min；趋势并入 title
    const rates = data.rates || {};
    const rateEl = el("m-rate");
    const rateSubEl = el("m-rate-sub");
    let perMin = null;
    if (rates.m1 != null) {
      perMin = Math.round(rates.m1);
      rateEl.textContent = fmtTok(perMin / 60) + "/s";
      rateEl.title = "近 1 分钟 " + fmtFull(perMin) + " tokens/分钟" +
        (rates.m5 != null ? " · 5分 " + fmtFull(rates.m5) : "") +
        (rates.m15 != null ? " · 15分 " + fmtFull(rates.m15) : "") +
        (data.rate_per_min != null ? " · 本小时平均 " + fmtFull(data.rate_per_min) : "");
    } else if (data.rate_per_min != null) {
      perMin = Math.round(data.rate_per_min);
      rateEl.textContent = fmtTok(perMin / 60) + "/s";
      rateEl.title = "本小时平均 " + fmtFull(perMin) + " tokens/分钟";
    } else {
      rateEl.textContent = "—";
      rateEl.title = "";
    }
    // 较1小时前：当前小时速率 vs 上一小时速率（%），并入副行与 title
    const hourlyRates = hourRateTrend(d);
    let subText = perMin != null ? fmt.format(perMin) + "/min" : "tokens / min";
    if (hourlyRates != null) {
      const up = hourlyRates >= 0;
      const pct = Math.abs(hourlyRates).toFixed(Math.abs(hourlyRates) >= 10 ? 1 : 2);
      subText += ` · 较1小时前 <span class="${up ? "trend-up" : "trend-down"}">${up ? "↑" : "↓"}${pct}%</span>`;
      if (rateEl.title) rateEl.title += " · 较1小时前 " + (up ? "↑" : "↓") + Math.abs(hourlyRates).toFixed(1) + "%";
    }
    rateSubEl.innerHTML = subText;
  } else {
    el("m-peak").textContent = "—";
    el("m-peak-sub").textContent = "仅今日维度";
    el("m-peak").title = "";
    el("m-rate").textContent = "—";
    el("m-rate").title = "";
    el("m-rate-sub").textContent = "tokens / min";
  }

  renderChart(rd);
  renderScope(d, rd.label);
  renderRows(d, data.session_meta || {});
  renderHistory(data);
  renderStatus(data);
  // 多页面视图分发（views.js）：非概览视图由各视图渲染器处理
  if (window.Views) window.Views.dispatch(data, range);
}

/** Token 资源分配（主/子智能体占比进度条）：真实数据来自 by_scope */
function renderScope(d, label) {
  const by = d.by_scope || {};
  const empty = { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0 };
  const main = by.main || empty;
  const sub = by.subagent || empty;
  const mainTot = totOf(main), subTot = totOf(sub), all = mainTot + subTot;
  const pctMain = all ? (mainTot / all * 100) : 0;
  const pctSub = all ? (subTot / all * 100) : 0;
  el("scope-main-total").textContent = fmtTok(mainTot);
  el("scope-main-info").textContent =
    `输入 ${fmtTok(main.inputOther)} · 缓存 ${fmtTok(main.inputCacheRead)} · 输出 ${fmtTok(main.output)} · ${fmt.format(main.calls || 0)} 次`;
  el("scope-sub-total").textContent = fmtTok(subTot);
  el("scope-sub-info").textContent =
    `输入 ${fmtTok(sub.inputOther)} · 缓存 ${fmtTok(sub.inputCacheRead)} · 输出 ${fmtTok(sub.output)} · ${fmt.format(sub.calls || 0)} 次`;
  el("scope-bar-main").style.width = (all ? pctMain : 50) + "%";
  el("scope-bar-sub").style.width = (all ? pctSub : 0) + "%";
  el("scope-bar-main-2").style.width = (all ? pctMain : 50) + "%";
  el("scope-bar-sub-2").style.width = (all ? pctSub : 0) + "%";
  el("scope-pct-main").textContent = all ? `主 ${pctMain.toFixed(1)}%` : "该范围暂无记录";
  el("scope-pct-sub").textContent = all ? `子 ${pctSub.toFixed(1)}%` : "";
  const sum = el("scope-summary");
  if (sum) sum.textContent = all ? `${label}合计 ${fmtTok(all)}` : "";

  renderScopeModelBar(main, mainTot, "scope-head-bar-main", "scope-main-legend", "main");
  renderScopeModelBar(sub, subTot, "scope-head-bar-sub", "scope-sub-legend", "sub");
}

const SCOPE_TOP_N = 4; // 子智能体分段条最多展示的模型数，其余归为“其他”

/** 模型缩写（分段条内的小标签，空间不足时隐藏） */
function shortModelName(m) {
  if (m === "__secondary__") return "二级";
  let n = String(m).split(":")[0];            // 去掉 :版本 后缀
  n = n.substring(n.lastIndexOf("/") + 1);     // 去掉 厂商/ 前缀
  if (n.length > 10) n = n.slice(0, 10) + "…";
  return n || m;
}

/** 子智能体顶部条：按各模型占子智能体总 token 比例渲染彩色分段（TOP N，其余归“其他”） */
function renderScopeModelBar(scopeData, scopeTotal, barId, legendId, scopeKey) {
  const bar = el(barId);
  const legend = el(legendId);
  if (!bar) return;
  const models = Object.values(scopeData.by_model || {}).filter(m => totOf(m) > 0);
  models.sort((a, b) => totOf(b) - totOf(a));
  const knownTotal = models.reduce((a, m) => a + totOf(m), 0);
  const total = scopeTotal || knownTotal;
  const emptyColor = scopeKey === "main" ? "var(--accent)" : "var(--out)";
  const emptyLabel = scopeKey === "main" ? "主" : "子";
  const emptyName = scopeKey === "main" ? "主智能体" : "子智能体";
  if (!models.length || !total) {
    bar.innerHTML = `<span class="sm-seg" style="width:100%;background:${emptyColor};color:rgba(0,0,0,.7);font-size:10px;">${emptyLabel}</span>`;
    if (total > 0) {
      bar.title = `该范围${emptyName}共 ${fmtFull(total)} tokens，但历史记录未包含模型维度\n（新版聚合后产生的 usage 会写入模型维度）`;
      if (legend) legend.innerHTML = `<span class="sml" style="color:var(--muted)">历史数据未含模型维度</span>`;
    } else {
      bar.title = `${emptyName}模型记录收集中…\n（需新产生的 usage 记录后才会显示模型维度）`;
      if (legend) legend.innerHTML = `<span class="sml" style="color:var(--muted)">模型数据收集中</span>`;
    }
    return;
  }
  const top = models.slice(0, SCOPE_TOP_N);
  const rest = models.slice(SCOPE_TOP_N);
  const segs = top.map((m, i) => ({
    label: shortModelName(m.model), full: m.model,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
    pct: (totOf(m) / total) * 100, tokens: totOf(m),
  }));
  if (rest.length) {
    const rTot = rest.reduce((a, m) => a + totOf(m), 0);
    segs.push({ label: "其他", full: null, color: "#8b949e",
      pct: (rTot / total) * 100, tokens: rTot });
  }
  // 服务升级前已聚合的历史数据没有 by_model，用灰色段补齐，保证条子填满且百分比真实
  if (total > knownTotal) {
    const unclassified = total - knownTotal;
    segs.push({ label: "历史未分类", full: "历史未分类数据", color: "#484f58",
      pct: (unclassified / total) * 100, tokens: unclassified });
  }
  bar.innerHTML = segs.map(s =>
    `<span class="sm-seg" style="width:${s.pct.toFixed(2)}%;background:${s.color}" ` +
    `title="${s.full ? esc(s.full) : "其他模型"} · ${fmtFull(s.tokens)} tokens (${s.pct.toFixed(1)}%)">` +
    (s.pct >= 8 ? esc(s.label) : "") + `</span>`
  ).join("");
  bar.title = `${emptyName}模型构成 · ${fmtFull(total)} tokens`;
  if (legend) {
    legend.innerHTML = segs.map(s =>
      `<span class="sml" title="${s.full ? esc(s.full) : "其他模型"} · ${fmtFull(s.tokens)} tokens (${s.pct.toFixed(1)}%)">` +
      `<i style="background:${s.color}"></i>${esc(s.label)} ${s.pct.toFixed(0)}%</span>`
    ).join("");
  }
}

function renderChart(rd) {
  el("chart-title").textContent = rd.title;
  // 桶数据未变化则跳过重建（局部更新）
  const sig = rd.buckets.map(b => [b.key, b.in, b.cache, b.out, b.cw || 0, b.req || 0]);
  if (!changed("chart", sig)) return;
  const chart = el("chart");
  chart.innerHTML = "";
  const buckets = rd.buckets;
  let max = 1, maxReq = 1;
  for (const b of buckets) {
    max = Math.max(max, b.in + b.cache + b.out + (b.cw || 0));
    if (b.req) maxReq = Math.max(maxReq, b.req);
  }
  const n = buckets.length;
  for (let i = 0; i < n; i++) {
    const b = buckets[i];
    const col = document.createElement("div");
    col.className = "col";
    const segs = [
      { cls: "in", v: b.in },
      { cls: "cache", v: b.cache },
      { cls: "out", v: b.out },
      { cls: "cwrite", v: b.cw || 0 },
    ];
    for (const s of segs) {
      if (s.v <= 0) continue;
      const seg = document.createElement("div");
      seg.className = "seg " + s.cls;
      seg.style.height = Math.max((s.v / max) * 100, 2) + "%";
      col.appendChild(seg);
    }
    if (b.in + b.cache + b.out <= 0) {
      const seg = document.createElement("div");
      seg.className = "seg out";
      seg.style.height = "1.5%";
      seg.style.opacity = "0.25";
      col.appendChild(seg);
    }
    const tip = document.createElement("div");
    tip.className = "tip";
    const isHourly = typeof b.key === "number";
    const tipTitle = isHourly
      ? `${b.label}:00 - ${String((+b.label + 1) % 24).padStart(2, "0")}:00`
      : b.label;
    tip.innerHTML =
      `<div class="t">${esc(tipTitle)}</div>` +
      `输入未命中 ${fmtTok(b.in)}<br>缓存读取 ${fmtTok(b.cache)}<br>缓存写入 ${fmtTok(b.cw || 0)}<br>输出 ${fmtTok(b.out)}<br>` +
      `<span style="color:var(--muted)">总计 ${fmtTok(b.in + b.cache + b.out)}</span>` +
      (b.req ? `<br>请求次数 ${fmt.format(b.req)}` : "");
    col.appendChild(tip);
    chart.appendChild(col);
  }
  // 叠加 step 级请求数曲线（SVG overlay）
  if (n > 0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 100;
      const y = 100 - ((buckets[i].req || 0) / maxReq) * 92 - 3;
      pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "req-overlay");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts.join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#a855f7");
    line.setAttribute("stroke-width", "1.2");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.setAttribute("stroke-dasharray", "3 2");
    svg.appendChild(line);
    chart.appendChild(svg);
  }
  // 轴刻度
  const axis = el("chart-axis");
  axis.innerHTML = "";
  const isHourlyAxis = typeof buckets[0].key === "number";
  if (isHourlyAxis) {
    ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "23:00"].forEach(t => {
      const s = document.createElement("span"); s.textContent = t; axis.appendChild(s);
    });
  } else if (n >= 5) {
    ["", rd.buckets[Math.floor(n * 0.25)].label, rd.buckets[Math.floor(n * 0.5)].label,
     rd.buckets[Math.floor(n * 0.75)].label, rd.buckets[n - 1].label].forEach(t => {
      const s = document.createElement("span"); s.textContent = t; axis.appendChild(s);
    });
  } else {
    rd.buckets.forEach(b => {
      const s = document.createElement("span"); s.textContent = b.label; axis.appendChild(s);
    });
  }
}

const MODEL_COLORS = ["#f0883e", "#58a6ff", "#3fb950", "#a371f7", "#d29922", "#34d399", "#f85149", "#8b949e", "#f0883e", "#58a6ff"];

function renderModelDonut(models) {
  // 模型 Token 分布占比（按 totOf 总 tokens，规格书第十节语义区分）
  const donut = el("model-donut");
  const legend = el("model-legend");
  const center = el("model-donut-total");
  if (!models.length) {
    donut.style.background = "var(--bg)";
    if (center) center.textContent = "—";
    legend.innerHTML = '<span class="muted">暂无记录</span>';
    return;
  }
  const total = models.reduce((a, m) => a + totOf(m), 0) || 1;
  if (center) center.textContent = fmtTok(total);
  let acc = 0;
  const stops = [];
  const swatches = [];
  models.forEach((m, i) => {
    const t = totOf(m);
    if (t <= 0) return;
    const pct = (t / total) * 100;
    const col = MODEL_COLORS[i % MODEL_COLORS.length];
    stops.push(`${col} ${acc}% ${acc + pct}%`);
    acc += pct;
    swatches.push(
      `<div class="dl-row"><span class="dl-swatch" style="background:${col}"></span>` +
      `<span class="dl-name" title="${esc(m.model)}">${esc(modelLabel(m.model))}</span>` +
      `<span class="dl-num">${fmtTok(t)} (${pct.toFixed(1)}%)</span></div>`
    );
  });
  donut.style.background = `conic-gradient(${stops.join(", ")})`;
  legend.innerHTML = swatches.join("");
}

function renderRows(d, sessionMeta) {
  // 概览：模型 Token 分布 Donut + 模型使用明细 TOP3（完整表在“模型分析”页）
  const models = Object.values(d.by_model || {});
  models.sort((a, b) => totOf(b) - totOf(a));
  renderModelDonut(models);
  el("model-count").textContent = models.length + " 个模型";
  const om = el("ov-model-rows");
  const mSig = JSON.stringify(models.slice(0, 3).map(m => [m.model, totOf(m)]));
  if (!om) return;
  if (changed("ovmodels", mSig)) {
    om.innerHTML = "";
    if (!models.length) {
      om.innerHTML = '<div class="tt-empty">暂无记录</div>';
    } else {
      const head = document.createElement("div");
      head.className = "tt-head ovt";
      head.innerHTML = `<span>模型</span><span class="tt-num">总 Tokens</span><span class="tt-num">命中率</span><span class="tt-num">输出</span><span class="tt-num">请求</span>`;
      om.appendChild(head);
      for (const m of models.slice(0, 3)) {
        const r = document.createElement("div");
        r.className = "tt-row ovt";
        const mIn = m.inputOther + m.inputCacheRead;
        const mCache = mIn > 0 ? (m.inputCacheRead / mIn * 100) : null;
        r.innerHTML =
          `<span class="tt-name" title="${esc(m.model)}" data-goto-model="${esc(m.model)}">${modelBadgeOf(models.indexOf(m))}${esc(modelLabel(m.model))}</span>` +
          `<span class="tt-num" title="${fmtFull(totOf(m))} tokens">${fmtTok(totOf(m))}</span>` +
          `<span class="tt-num ${mCache != null ? hitClsOf(mCache) : ""}">${mCache != null ? mCache.toFixed(1) + "%" : "—"}</span>` +
          `<span class="tt-num" style="color:var(--out)">${fmtTok(m.output)}</span>` +
          `<span class="tt-num">${fmt.format(m.requests || 0)}</span>`;
        r.querySelector(".tt-name").addEventListener("click", () => {
          if (window.Views) window.Views.switchView("model-detail", { model: m.model });
        });
        om.appendChild(r);
      }
    }
  }

  // 概览：会话 TOP3 条形（详情在“会话分析”页）
  const sessions = Object.values(d.by_session || {});
  sessions.sort((a, b) => (totOf(b)) - (totOf(a)));
  const osr = el("ov-session-rows");
  if (!osr) return;
  const sSig = JSON.stringify(sessions.slice(0, 3).map(s => [s.session, totOf(s)]));
  if (changed("ovsessions", sSig)) {
    osr.innerHTML = "";
    if (!sessions.length) {
      osr.innerHTML = '<div class="tt-empty">暂无记录</div>';
    } else {
      const maxTot = Math.max(...sessions.map(s => totOf(s)), 1);
      const head = document.createElement("div");
      head.className = "tt-head ovt";
      head.innerHTML = `<span>会话</span><span class="tt-num">总 Tokens</span><span class="tt-num">命中率</span><span class="tt-num">输出</span><span class="tt-num">请求</span>`;
      osr.appendChild(head);
      for (const s of sessions.slice(0, 3)) {
        const r = document.createElement("div");
        r.className = "tt-row ovt";
        const sIn = s.inputOther + s.inputCacheRead;
        const sCache = sIn > 0 ? (s.inputCacheRead / sIn * 100) : null;
        const meta = sessionMeta[s.session] || {};
        const title = sessionLabel(s.session, meta);
        r.innerHTML =
          `<span class="tt-name" title="${esc(meta.cwd || "")} · ${esc(s.session)}">${esc(title || shortSid(s.session))}</span>` +
          `<span class="tt-num" title="${fmtFull(totOf(s))} tokens">${fmtTok(totOf(s))}</span>` +
          `<span class="tt-num ${sCache != null ? hitClsOf(sCache) : ""}">${sCache != null ? sCache.toFixed(1) + "%" : "—"}</span>` +
          `<span class="tt-num" style="color:var(--out)">${fmtTok(s.output)}</span>` +
          `<span class="tt-num">${fmt.format(s.requests || 0)}</span>`;
        r.querySelector(".tt-name").addEventListener("click", () => {
          if (window.Views) window.Views.switchView("session-detail", { session: s.session });
        });
        osr.appendChild(r);
      }
    }
  }
}

/** 命中率语义色（与 views.js 一致） */
function hitClsOf(p) { return p >= 90 ? "pct-good" : p >= 70 ? "pct-warn" : "pct-bad"; }
/** 模型字形徽标 */
function modelBadgeOf(i) {
  const glyphs = ["★", "●", "■", "▲", "◆", "✚", "●", "◆", "★", "✚"];
  const c = MODEL_COLORS[i % MODEL_COLORS.length];
  return '<span class="model-badge" style="background:' + c + '22;color:' + c + '">' + glyphs[i % glyphs.length] + "</span>";
}

function renderSessionDetail(s) {
  const sm = Object.values(s.by_model || {});
  sm.sort((a, b) => totOf(b) - totOf(a));
  const mMax = sm.length ? Math.max(...sm.map(x => totOf(x)), 1) : 1;
  const parts = [];
  parts.push('<div class="sd-label">模型构成</div>');
  if (!sm.length) parts.push('<div class="empty">无模型记录</div>');
  for (const m of sm) {
    const pct = mMax ? (totOf(m) / mMax * 100) : 0;
    parts.push(
      `<div class="sd-row">` +
      `<span class="sd-name" title="${esc(m.model)}">${esc(modelLabel(m.model))}</span>` +
      `<span class="sd-pct" style="width:${pct.toFixed(1)}%"title="${fmtFull(totOf(m))} tokens"></span>` +
      `<span class="sd-num" title="入 ${fmtFull(m.inputOther)} · 缓 ${fmtFull(m.inputCacheRead)} · 出 ${fmtFull(m.output)}">${fmtTok(totOf(m))} · ${fmt.format(m.calls)}回合</span>` +
      `</div>`
    );
  }
  parts.push('<div class="sd-label">小时分布</div>');
  const hv = Object.entries(s.hourly || {}).sort((a, b) => +a[0] - +b[0]);
  if (!hv.length) parts.push('<div class="empty">无小时记录</div>');
  const hMax = Math.max(...hv.map(([, v]) => v.input + v.cached + v.output), 1);
  for (const [h, v] of hv) {
    const tot = v.input + v.cached + v.output;
    parts.push(
      `<div class="sd-row">` +
      `<span class="sd-name mono">${String(h).padStart(2, "0")}:00</span>` +
      `<span class="sd-pct" style="width:${(tot / hMax * 100).toFixed(1)}%" title="${fmtFull(tot)} tokens"></span>` +
      `<span class="sd-num" title="入 ${fmtFull(v.input)} · 缓 ${fmtFull(v.cached)} · 出 ${fmtFull(v.output)} · 请求 ${fmtFull(v.requests || 0)}">${fmtTok(tot)} · ${fmt.format(v.requests || 0)}请求</span>` +
      `</div>`
    );
  }
  return parts.join("");
}

/** __secondary__ 显示为可读名称（数据源无真实模型信息，指向配置里的二级模型默认值） */
function modelLabel(m) {
  if (m === "__secondary__") return "二级模型 (配置默认: 火山codingplan/DeepSeek-V4-Flash)";
  return m;
}

/** 会话显示名：优先标题（自定义标题加星标），无标题则回退 session ID */
function sessionLabel(sid, meta) {
  if (!meta || !meta.title) return null;
  const tag = meta.is_custom ? "★ " : "";
  return tag + meta.title;
}

function renderHistory(data) {
  const days = data.days || {};
  const list = el("history-list");
  const allEntries = Object.values(days).sort((a, b) => b.date.localeCompare(a.date));
  // 历史范围跟随顶部切换（今日=1 / 7天 / 30天）
  const win = range === "today" ? 1 : range === "week" ? 7 : 30;
  const entries = allEntries.slice(0, win);
  el("history-summary").textContent = "近 " + win + " 天 · " + entries.length + " 天有记录";
  // 数据未变化则跳过重建（局部更新）
  const hSig = entries.map(e => [e.date, e.inputOther, e.inputCacheRead, e.inputCacheCreation, e.output, e.calls, e.requests || 0]);
  if (!changed("history", hSig)) return;
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = '<div class="empty">暂无历史数据</div>';
    return;
  }
  let max = 1;
  entries.forEach(e => { max = Math.max(max, totOf(e)); });
  for (const e of entries) {
    const tot = totOf(e);
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML =
      `<div class="history-date">${esc(e.date)}</div>` +
      `<div class="history-bar"><i style="width:${Math.max((tot / max) * 100, tot > 0 ? 3 : 0)}%"></i></div>` +
      `<div class="history-num" title="输入 ${fmtFull(e.inputOther)} · 缓存 ${fmtFull(e.inputCacheRead)} · 输出 ${fmtFull(e.output)} · 回合 ${fmtFull(e.calls)} · 请求 ${fmtFull(e.requests || 0)}">${fmtTok(tot)} · ¥${costOf(e).toFixed(2)} · ${fmt.format(e.calls)} 回合</div>`;
    list.appendChild(item);
  }
}

/** 事件流自动跟随提示（实时事件页专用，views.js 已接管事件列表渲染） */
function updateEventFollowHint() {
  const h = el("event-follow-hint");
  if (!h) return;
  h.textContent = autoFollow
    ? (evMore ? "已显示全部事件 · 自动跟随" : "自动跟随")
    : "已暂停跟随 · 滚动回顶部恢复";
  h.classList.toggle("follow-paused", !autoFollow);
}

function renderStatus(data) {
  const badge = el("conn-status");
  const dot = badge.querySelector(".dot");
  if (data.tracked_files >= 0) {
    dot.className = "dot ok";
    badge.lastChild.textContent = " 已连接 · " + data.tracked_files + " 个日志";
  }
  // 侧边栏：最后更新 / 数据源目录 / 服务地址
  const upEl = el("sb-updated");
  if (upEl && data.last_scan) {
    upEl.textContent = new Date(data.last_scan * 1000).toLocaleTimeString("zh-CN", { hour12: false });
  }
  const dirEl = el("sb-dir");
  if (dirEl && data.session_root) {
    if (dirEl.textContent !== data.session_root) {
      dirEl.textContent = data.session_root;
      dirEl.title = data.session_root;
    }
  }
  const svcEl = el("sb-service");
  if (svcEl) svcEl.textContent = location.host;
  // 设置页数据管理信息
  const gd = el("gs-dir");
  if (gd && data.session_root && gd.textContent !== data.session_root) gd.textContent = data.session_root;
  const gf = el("gs-files");
  if (gf) gf.textContent = (data.tracked_files || 0) + " 个日志文件";
  el("last-refresh").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  let old = document.querySelector(".errstrip");
  if (old) old.remove();
  if (data.errors && data.errors.length) {
    const div = document.createElement("div");
    div.className = "errstrip";
    div.textContent = "采集告警：\n" + data.errors.join("\n");
    document.querySelector("main").prepend(div);
  }
}
/** 打开定价弹窗（顶栏按钮） */
function openPriceModal() {
  el("pm-miss").value = prices.miss;
  el("pm-cache").value = prices.cache;
  el("pm-cwrite").value = prices.cwrite;
  el("pm-out").value = prices.out;
  el("price-overlay").classList.remove("hidden");
  el("pm-miss").focus();
}

/* ---------- 定价弹窗 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  el("price-toggle").addEventListener("click", openPriceModal);
  el("price-save").addEventListener("click", () => {
    prices.miss = parseFloat(el("pm-miss").value) || 0;
    prices.cache = parseFloat(el("pm-cache").value) || 0;
    prices.cwrite = parseFloat(el("pm-cwrite").value) || 0;
    prices.out = parseFloat(el("pm-out").value) || 0;
    savePrices();
    el("price-overlay").classList.add("hidden");
    if (current) render(current);
  });
  el("price-reset").addEventListener("click", () => {
    prices = { ...DEFAULT_PRICES };
    savePrices();
    el("pm-miss").value = prices.miss;
    el("pm-cache").value = prices.cache;
    el("pm-cwrite").value = prices.cwrite;
    el("pm-out").value = prices.out;
    if (current) render(current);
  });
  el("price-overlay").addEventListener("click", (e) => {
    if (e.target === el("price-overlay")) el("price-overlay").classList.add("hidden");
  });
  // ESC 关闭 / Enter 保存（规格书第十八节：Modal 交互）
  document.addEventListener("keydown", (e) => {
    if (el("price-overlay").classList.contains("hidden")) return;
    if (e.key === "Escape") {
      el("price-overlay").classList.add("hidden");
    } else if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
      e.preventDefault();
      el("price-save").click();
    }
  });
});
