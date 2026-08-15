/* ============================================================
   Kimi Code Token 监控 · 视图渲染
   视图切换（switchView/currentView/dispatch/renderView）· 各页面渲染 · 分页
   通用图表取自 js/charts.js（window.Charts）
   依赖全局：buildRangeData/emptyDay/localDateKey/modelLabel/sessionLabel/
   shortSid/totOf/costOf/MODEL_COLORS/evFilter/expandedSessions/
   renderSessionDetail/prices/savePrices/current/range/fmtTok/fmtYi/fmt/esc
   （js/utils.js、js/data.js、js/render.js）
   ============================================================ */
window.Views = (function () {

  const state = { view: "overview", model: null, session: null };
  const pages = { events: 1, models: 1, sessions: 1, history: 1, cost: 1 };
  const EV_PAGE = 20;     // 实时事件每页 20 条（设计稿）
  const PAGE10 = 10;      // 其余列表每页 10 条（设计稿）
  let evAll = false;      // 事件页：默认 60 条，true 最多 200
  let evExpanded = new Set();
  let settingsInit = false;
  let lastSig = "";

  const TITLES = {
    overview: ["概览", "今日数据总览"],
    events: ["实时事件", "实时事件流（Live）"],
    models: ["模型分析", "模型维度统计 · 点击模型名查看详情"],
    "model-detail": ["模型详情", "模型维度统计"],
    sessions: ["会话分析", "会话维度统计 · 点击行展开"],
    "session-detail": ["会话详情", "会话维度统计"],
    history: ["历史统计", "按日期回溯"],
    cost: ["费用分析", "费用预估与趋势"],
    settings: ["设置", "系统与定价配置"],
  };
  const NAV_OF = { "model-detail": "models", "session-detail": "sessions" };
  const CAT_COLORS = ["#f59e0b", "#3b82f6", "#ec4899", "#8b5cf6"];
  const CAT_LABELS = ["输入未命中", "缓存命中", "缓存写入", "输出"];

  function el(id) { return document.getElementById(id); }
  function chg(key, val) {
    // 对比「全局最后渲染签名」（key+内容），而非按 key 记忆：按 key 记忆时
    // A→B→A 切换（如事件页全部→子→全部）回到 A 且内容未变会误判「无需重建」，
    // 导致 DOM 停留在 B 的渲染结果上。
    const s = key + "\u0000" + JSON.stringify(val);
    if (lastSig === s) return false;
    lastSig = s;
    return true;
  }
  function cacheRateOf(d) {
    const inp = (d.inputOther || 0) + (d.inputCacheRead || 0);
    return inp > 0 ? (d.inputCacheRead / inp * 100) : null;
  }
  /** 命中率语义色：>=90 绿 / >=70 黄 / 其他红 */
  function hitCls(p) { return p >= 90 ? "pct-good" : p >= 70 ? "pct-warn" : "pct-bad"; }
  /** 费用语义色：>=2 红 / >=1 黄 / 其他绿（¥） */
  function costCls(c) { return c >= 2 ? "cost-high" : c >= 1 ? "cost-mid" : "cost-low"; }
  /** 模型字形徽标（配合 MODEL_COLORS 循环取色） */
  const GLYPHS = ["★", "●", "■", "▲", "◆", "✚", "●", "◆", "★", "✚"];
  function modelBadge(i) {
    const c = MODEL_COLORS[i % MODEL_COLORS.length];
    return '<span class="model-badge" style="background:' + c + '22;color:' + c + '">' + GLYPHS[i % GLYPHS.length] + "</span>";
  }
  /** 按当前全局范围聚合日数据 */
  function aggDay(data) { return buildRangeData(data).day; }
  /** 近 n 天的 [{key,label,day}] */
  function dayList(data, n) {
    const now = new Date(data.now * 1000);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY_MS);
      const key = localDateKey(d);
      out.push({ key, label: key.slice(5), day: (data.days || {})[key] || emptyDay(key) });
    }
    return out;
  }

  /* ---------- 视图切换 ---------- */
  function switchView(view, opts) {
    if (opts && opts.model) state.model = opts.model;
    if (opts && opts.session) state.session = opts.session;
    state.view = view;
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    const target = document.getElementById("view-" + view);
    if (target) target.classList.add("active");
    const navKey = NAV_OF[view] || view;
    document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === navKey));
    const t = TITLES[view] || TITLES.overview;
    const tEl = document.getElementById("page-title");
    if (tEl) tEl.textContent = t[0];
    const sEl = document.getElementById("page-subtitle");
    if (sEl) sEl.textContent = t[1];
    window.scrollTo(0, 0);
    if (current) {
      if (view === "overview") render(current);  // 概览由 render() 全权渲染，立即刷新
      else renderView(current, range);
    }
  }
  function currentView() { return state.view; }
  function dispatch(data, r) { renderView(data, r); }

  /* ---------------- 通用图表（js/charts.js） ---------------- */
  const { stackedChart, barChart, lineChart, donutChart } = window.Charts;
  /** 通用分页器 */
  function putPager(container, page, totalPg, onGo) {
    if (!container) return;
    if (totalPg <= 1) { container.innerHTML = ""; return; }
    const parts = [`<span class="pg-info">共 ${totalPg} 页</span>`];
    parts.push(`<button data-goto="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹</button>`);
    const nums = [];
    for (let i = 1; i <= totalPg; i++) {
      if (i === 1 || i === totalPg || Math.abs(i - page) <= 3) nums.push(i);
      else if (nums[nums.length - 1] !== "…") nums.push("…");
    }
    for (const n of nums) {
      parts.push(n === "…"
        ? `<span style="color:var(--muted);font-size:11px;padding:0 4px">…</span>`
        : `<button data-goto="${n}" class="${n === page ? "active" : ""}">${n}</button>`);
    }
    parts.push(`<button data-goto="${page + 1}" ${page >= totalPg ? "disabled" : ""}>›</button>`);
    container.innerHTML = parts.join("");
    container.querySelectorAll("button[data-goto]").forEach(b => {
      b.addEventListener("click", () => {
        if (b.disabled) return;
        onGo(parseInt(b.dataset.goto, 10));
      });
    });
  }

  /* ---------------- 视图渲染 ---------------- */
  function renderView(data, r) {
    const v = state.view;
    if (v === "overview") { return; } // 概览由 app.js render() 全权渲染（轮询持续刷新）
    if (v === "events") renderEventsView(data);
    else if (v === "models") renderModels(data);
    else if (v === "model-detail") renderModelDetail(data);
    else if (v === "sessions") renderSessions(data);
    else if (v === "session-detail") renderSessionDetailView(data);
    else if (v === "history") renderHistoryView(data);
    else if (v === "cost") renderCost(data);
    else if (v === "settings") renderSettings();
  }

  /* ---------- 视图：实时事件 ---------- */
  function renderEventsView(data) {
    const evs = (data.recent || []).slice(0, evAll ? 200 : 60);
    const countEl = el("event-count");
    if (countEl) countEl.textContent = evs.length + " events";
    const hint = el("event-follow-hint");
    if (hint) hint.textContent = "每 2 秒自动刷新 · 点击行展开详情";
    let shown = evs;
    if (evFilter.scope === "main") shown = shown.filter(e => e.scope !== "subagent");
    else if (evFilter.scope === "sub") shown = shown.filter(e => e.scope === "subagent");
    if (evFilter.model) shown = shown.filter(e => e.model === evFilter.model);
    const sel = el("ev-model-filter");
    if (sel) {
      const models = [...new Set(evs.map(e => e.model).filter(Boolean))].sort();
      const cur = sel.value;
      sel.innerHTML = '<option value="">全部模型</option>' +
        models.map(m => `<option value="${esc(m)}">${esc(modelLabel(m))}</option>`).join("");
      if (models.includes(cur)) sel.value = cur;
    }
    const totalPg = Math.max(Math.ceil(shown.length / EV_PAGE), 1);
    if (pages.events > totalPg) pages.events = totalPg;
    const slice = shown.slice((pages.events - 1) * EV_PAGE, pages.events * EV_PAGE);
    const rowsEl = el("event-rows");
    if (!rowsEl) return;
    const sigKey = "ev" + pages.events + "|" + evFilter.scope + "|" + evFilter.model + "|" + (evAll ? "A" : "B") + "|" +
      slice.map(e => keyOf(e)).join(",");
    if (chg(sigKey, slice.map(e => [keyOf(e), e.scope, e.model, e.input, e.cached, e.output]))) {
      rowsEl.innerHTML = "";
      if (!slice.length) {
        rowsEl.innerHTML = '<div class="tt-empty">该过滤条件下暂无事件</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head evt";
        head.innerHTML =
          `<span>时间</span><span>类型</span><span>模型</span><span>主/子</span>` +
          `<span class="tt-num">输入</span><span class="tt-num">缓存命中</span><span class="tt-num">输出</span>` +
          `<span class="tt-num">总 Tokens</span><span>会话 ID</span><span>操作</span>`;
        rowsEl.appendChild(head);
        for (const ev of slice) {
          const key = keyOf(ev);
          const scope = ev.scope === "subagent" ? "sub" : "main";
          const meta = (data.session_meta || {})[ev.session] || {};
          const sTitle = sessionLabel(ev.session, meta) || shortSid(ev.session);
          const isOpen = evExpanded.has(key);
          const detail = document.createElement("div");
          detail.className = "tt-detail" + (isOpen ? "" : " hidden");
          const hasText = (ev.input_text && ev.input_text.trim()) || (ev.output_text && ev.output_text.trim());
          if (hasText) {
            let h = "";
            if (ev.input_text && ev.input_text.trim()) h += `<div class="evd-label">输入</div><div class="evd-text">${esc(ev.input_text)}</div>`;
            if (ev.output_text && ev.output_text.trim()) h += `<div class="evd-label">输出</div><div class="evd-text">${esc(ev.output_text)}</div>`;
            h += '<div class="evd-copybar">';
            if (ev.input_text && ev.input_text.trim()) h += '<button class="evd-copy" data-c="in" data-label="复制输入">复制输入</button>';
            if (ev.output_text && ev.output_text.trim()) h += '<button class="evd-copy" data-c="out" data-label="复制输出">复制输出</button>';
            h += '<button class="evd-copy" data-c="all" data-label="复制全部">复制全部</button></div>';
            detail.innerHTML = h;
            detail.querySelectorAll(".evd-copy").forEach(btn => {
              btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const t = btn.dataset.c === "in" ? (ev.input_text || "")
                  : btn.dataset.c === "out" ? (ev.output_text || "")
                  : [(ev.input_text || ""), (ev.output_text || "")].filter(Boolean).join("\n\n");
                copyText(t, btn);
              });
            });
          } else {
            detail.innerHTML = '<div class="evd-empty">该事件未捕获输入/输出文本</div>';
          }
          const row = document.createElement("div");
          row.className = "tt-row evt";
          row.innerHTML =
            `<span class="tt-num" style="color:var(--muted)">${esc(String(new Date(ev.time).toTimeString().slice(0, 8)))}</span>` +
            `<span><span class="lbl" style="color:var(--ok);background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);padding:1px 7px;border-radius:999px">usage</span></span>` +
            `<span class="tt-name" style="cursor:default" title="${esc(ev.model)}">${esc(modelLabel(ev.model))}</span>` +
            `<span><span class="ev-scope ${scope}">${scope === "sub" ? "子" : "主"}</span></span>` +
            `<span class="tt-num">${fmtTok(ev.input)}</span>` +
            `<span class="tt-num">${fmtTok(ev.cached)}</span>` +
            `<span class="tt-num" style="color:var(--out)">${fmtTok(ev.output)}</span>` +
            `<span class="tt-num">${fmtTok(ev.total)}</span>` +
            `<span class="tt-name" style="cursor:default" title="${esc(meta.cwd || "")} · ${esc(ev.session)}">${esc(sTitle)}</span>` +
            `<span class="tt-exp" title="展开详情">${hasText ? (isOpen ? "▲" : "▼") : "—"}</span>`;
          row.appendChild(detail);
          if (hasText) {
            row.addEventListener("click", () => {
              const open = detail.classList.contains("hidden");
              detail.classList.toggle("hidden", !open);
              const t = row.querySelector(".tt-exp");
              if (t) t.textContent = open ? "▲" : "▼";
              if (open) { evExpanded.add(key); } else { evExpanded.delete(key); }
            });
          }
          rowsEl.appendChild(row);
        }
      }
    }
    const moreBtn = el("ev-more");
    if (moreBtn) moreBtn.textContent = evAll ? "收起（60 条）" : "查看全部事件 →";
    putPager(el("ev-pager"), pages.events, totalPg, p => { pages.events = p; if (current) renderView(current, range); });
  }

  /* ---------- 件：模型分析 ---------- */
  function renderModels(data) {
    const agg = aggDay(data);
    const models = Object.values(agg.by_model || {});
    models.sort((a, b) => totOf(b) - totOf(a));
    const totalTok = models.reduce((a, m) => a + totOf(m), 0);
    const totalInp = models.reduce((a, m) => a + (m.inputOther || 0) + (m.inputCacheRead || 0), 0);
    const totalCached = models.reduce((a, m) => a + (m.inputCacheRead || 0), 0);
    el("mo-count").textContent = String(models.length);
    el("mo-total").textContent = fmtYi(totalTok);
    el("mo-cache").textContent = totalInp > 0 ? (totalCached / totalInp * 100).toFixed(1) + "%" : "—";
    el("mo-req").textContent = fmt.format(models.reduce((a, m) => a + (m.requests || 0), 0));
    el("mo-calls-sub").textContent = fmt.format(models.reduce((a, m) => a + (m.calls || 0), 0)) + " 回合";
    const totalPg = Math.max(Math.ceil(models.length / PAGE10), 1);
    if (pages.models > totalPg) pages.models = totalPg;
    const slice = models.slice((pages.models - 1) * PAGE10, pages.models * PAGE10);
    const rowsEl = el("mo-rows");
    if (chg("mo" + pages.models, slice.map(m => [m.model, totOf(m)]))) {
      rowsEl.innerHTML = "";
      if (!slice.length) {
        rowsEl.innerHTML = '<div class="tt-empty">暂无记录</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head mot";
        head.innerHTML =
          `<span>模型</span><span class="tt-num">输入 Tokens</span><span class="tt-num">缓存命中</span>` +
          `<span class="tt-num">输出 Tokens</span><span class="tt-num">总 Tokens</span><span class="tt-num">命中率</span>` +
          `<span class="tt-num">请求数</span><span class="tt-num">回合数</span><span class="tt-num">费用预估</span>`;
        rowsEl.appendChild(head);
        for (const m of slice) {
          const r = document.createElement("div");
          r.className = "tt-row mot";
          r.innerHTML =
            `<span class="tt-name" title="${esc(m.model)}">${modelBadge(models.indexOf(m))}${esc(modelLabel(m.model))}</span>` +
            `<span class="tt-num">${fmtTok(m.inputOther)}</span>` +
            `<span class="tt-num">${fmtTok(m.inputCacheRead)}</span>` +
            `<span class="tt-num" style="color:var(--out)">${fmtTok(m.output)}</span>` +
            `<span class="tt-num">${fmtTok(totOf(m))}</span>` +
            `<span class="tt-num ${cacheRateOf(m) != null ? hitCls(cacheRateOf(m)) : ""}">${cacheRateOf(m) != null ? cacheRateOf(m).toFixed(1) + "%" : "—"}</span>` +
            `<span class="tt-num">${fmt.format(m.requests || 0)}</span>` +
            `<span class="tt-num">${fmt.format(m.calls || 0)}</span>` +
            `<span class="tt-num ${costCls(costOf(m))}">¥${costOf(m).toFixed(2)}</span>`;
          r.querySelector(".tt-name").addEventListener("click", () => switchView("model-detail", { model: m.model }));
          rowsEl.appendChild(r);
        }
      }
    }
    putPager(el("mo-pager"), pages.models, totalPg, p => { pages.models = p; if (current) renderView(current, range); });
  }

  /* ---------- 件：模型详情 ---------- */
  function renderModelDetail(data) {
    const model = state.model;
    const agg = aggDay(data);
    const mm = model ? ((agg.by_model || {})[model] || emptyDay("__m__")) : emptyDay("__m__");
    el("md-name").textContent = model ? modelLabel(model) : "—";
    el("md-alias").textContent = model || "";
    el("md-total").textContent = fmtYi(totOf(mm));
    el("md-cache").textContent = cacheRateOf(mm) != null ? cacheRateOf(mm).toFixed(1) + "%" : "—";
    el("md-req").textContent = fmt.format(mm.requests || 0);
    el("md-calls").textContent = (mm.calls || 0) + " 回合";
    el("md-cost").textContent = "¥" + costOf(mm).toFixed(2);
    // 使用趋势（跟随顶部范围切换）
    const win = range === "today" ? 1 : range === "week" ? 7 : 30;
    const mdSub = el("md-trend-sub");
    if (mdSub) mdSub.textContent = `近 ${win} 天 · 按日`;
    const days = dayList(data, win);
    const bks = [];
    for (const dd of days) {
      const dm = (dd.day.by_model || {})[model] || {};
      bks.push({
        label: dd.label,
        v: [dm.inputOther || 0, dm.inputCacheRead || 0, dm.output || 0],
      });
    }
    stackedChart(el("md-chart"), el("md-axis"), bks);
    // 会话内分析（当前范围）
    const sessions = Object.values(agg.by_session || {});
    const inSess = sessions.filter(s => (s.by_model || {})[model]);
    const maxS = Math.max(...inSess.map(s => totOf((s.by_model || {})[model] || {})), 1);
    const srows = el("md-sess-rows");
    const sSig = inSess.map(s => [s.session, totOf((s.by_model || {})[model] || {})]);
    if (chg("mdsess", sSig)) {
      srows.innerHTML = "";
      if (!inSess.length) {
        srows.innerHTML = '<div class="tt-empty">该模型在选定范围无会话记录</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head";
        head.style.gridTemplateColumns = "minmax(110px, 1fr) 80px 90px";
        head.innerHTML = `<span>会话</span><span class="tt-num">占比</span><span class="tt-num">Tokens · 费用</span>`;
        srows.appendChild(head);
        for (const s of inSess) {
          const sm = (s.by_model || {})[model] || {};
          const t = totOf(sm);
          const r = document.createElement("div");
          r.className = "tt-row";
          r.style.gridTemplateColumns = "minmax(110px, 1fr) 80px 90px";
          const meta = (data.session_meta || {})[s.session] || {};
          r.innerHTML =
            `<span class="tt-name" title="${esc(s.session)}">${esc(sessionLabel(s.session, meta) || shortSid(s.session))}</span>` +
            `<span class="tt-num">${(t / (maxS || 1) * 100).toFixed(1)}%</span>` +
            `<span class="tt-num">${fmtTok(t)} · ¥${costOf(sm).toFixed(2)}</span>`;
          r.querySelector(".tt-name").addEventListener("click", () => switchView("session-detail", { session: s.session }));
          srows.appendChild(r);
        }
      }
    }
    // 费用构成
    const comps = costParts(mm);
    donutChart(el("md-donut"), el("md-donut-legend"), el("md-donut-total"), comps, v => "¥" + v.toFixed(2));
  }

  /** 成本四分类：[{label,value,color,key}] */
  function costParts(d) {
    const ms = (d.inputOther || 0) / 1e6 * prices.miss;
    const ck = (d.inputCacheRead || 0) / 1e6 * prices.cache;
    const cw = (d.inputCacheCreation || 0) / 1e6 * prices.cwrite;
    const ot = (d.output || 0) / 1e6 * prices.out;
    return [
      { label: CAT_LABELS[0], value: ms, color: CAT_COLORS[0], key: "¥" + ms.toFixed(2) },
      { label: CAT_LABELS[1], value: ck, color: CAT_COLORS[1], key: "¥" + ck.toFixed(2) },
      { label: CAT_LABELS[2], value: cw, color: CAT_COLORS[2], key: "¥" + cw.toFixed(2) },
      { label: CAT_LABELS[3], value: ot, color: CAT_COLORS[3], key: "¥" + ot.toFixed(2) },
    ].filter(x => x.value > 0);
  }

  /* ---------- 件：会话分析 ---------- */
  function renderSessions(data) {
    const agg = aggDay(data);
    const sessions = Object.values(agg.by_session || {});
    sessions.sort((a, b) => totOf(b) - totOf(a));
    el("ss-count").textContent = String(sessions.length);
    el("ss-total").textContent = fmtYi(sessions.reduce((a, s) => a + totOf(s), 0));
    el("ss-req").textContent = fmt.format(sessions.reduce((a, s) => a + (s.requests || 0), 0));
    el("ss-calls").textContent = fmt.format(sessions.reduce((a, s) => a + (s.calls || 0), 0));
    const totalPg = Math.max(Math.ceil(sessions.length / PAGE10), 1);
    if (pages.sessions > totalPg) pages.sessions = totalPg;
    const slice = sessions.slice((pages.sessions - 1) * PAGE10, pages.sessions * PAGE10);
    const rowsEl = el("ss-rows");
    const sig = slice.map(s => [s.session, totOf(s)]);
    if (chg("ss" + pages.sessions, sig)) {
      rowsEl.innerHTML = "";
      if (!slice.length) {
        rowsEl.innerHTML = '<div class="tt-empty">暂无记录</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head sst";
        head.style.gridTemplateColumns = "minmax(110px, 1.4fr) 34px 62px 60px 58px 72px 58px 50px 50px 30px";
        head.innerHTML =
          `<span>会话 ID</span><span>主/子</span><span class="tt-num">输入 Tokens</span><span class="tt-num">缓存命中</span>` +
          `<span class="tt-num">输出</span><span class="tt-num">总 Tokens</span><span class="tt-num">命中率</span>` +
          `<span class="tt-num">请求数</span><span class="tt-num">回合数</span><span>操作</span>`;
        rowsEl.appendChild(head);
        for (const s of slice) {
          const meta = (data.session_meta || {})[s.session] || {};
          const isOpen = expandedSessions.has(s.session);
          const detail = document.createElement("div");
          detail.className = "tt-detail sdt" + (isOpen ? "" : " hidden");
          detail.innerHTML = renderSessionDetail(s);
          const scopeChip = s.has_sub
            ? (s.has_main ? '<span class="ev-scope main">混合</span>' : '<span class="ev-scope sub">子</span>')
            : '<span class="ev-scope main">主</span>';
          const row = document.createElement("div");
          row.className = "tt-row sst";
          row.style.gridTemplateColumns = "minmax(110px, 1.4fr) 34px 62px 60px 58px 72px 58px 50px 50px 30px";
          row.innerHTML =
            `<span class="tt-name" title="${esc(meta.cwd || "")} · ${esc(s.session)}">${esc(sessionLabel(s.session, meta) || shortSid(s.session))}</span>` +
            scopeChip +
            `<span class="tt-num">${fmtTok(s.inputOther || 0)}</span>` +
            `<span class="tt-num">${fmtTok(s.inputCacheRead || 0)}</span>` +
            `<span class="tt-num" style="color:var(--out)">${fmtTok(s.output || 0)}</span>` +
            `<span class="tt-num">${fmtTok(totOf(s))}</span>` +
            `<span class="tt-num ${cacheRateOf(s) != null ? hitCls(cacheRateOf(s)) : ""}">${cacheRateOf(s) != null ? cacheRateOf(s).toFixed(1) + "%" : "—"}</span>` +
            `<span class="tt-num">${fmt.format(s.requests || 0)}</span>` +
            `<span class="tt-num">${fmt.format(s.calls || 0)}</span>` +
            `<span class="tt-exp">${isOpen ? "▲" : "▼"}</span>`;
          row.appendChild(detail);
          row.querySelector(".tt-name").addEventListener("click", (e) => {
            e.stopPropagation();
            switchView("session-detail", { session: s.session });
          });
          row.addEventListener("click", () => {
            const open = detail.classList.contains("hidden");
            detail.classList.toggle("hidden", !open);
            const t = row.querySelector(".tt-exp");
            if (t) t.textContent = open ? "▲" : "▼";
            if (open) expandedSessions.add(s.session);
            else expandedSessions.delete(s.session);
          });
          rowsEl.appendChild(row);
        }
      }
    }
    putPager(el("ss-pager"), pages.sessions, totalPg, p => { pages.sessions = p; if (current) renderView(current, range); });
  }

  /* ---------- 件：会话详情 ---------- */
  function renderSessionDetailView(data) {
    const sid = state.session;
    const agg = aggDay(data);
    const sd = (agg.by_session || {})[sid] || emptyDay("__s__");
    const meta = (data.session_meta || {})[sid] || {};
    const name = sessionLabel(sid, meta) || shortSid(sid);
    el("sd-name").textContent = name;
    el("sd-id").textContent = sid || "";
    el("sd-total").textContent = fmtYi(totOf(sd));
    el("sd-cache").textContent = cacheRateOf(sd) != null ? cacheRateOf(sd).toFixed(1) + "%" : "—";
    el("sd-io").textContent = fmtTok(sd.inputOther || 0) + " / " + fmtTok(sd.output || 0);
    el("sd-cost").textContent = "¥" + costOf(sd).toFixed(2);
    // 使用趋势（跟随顶部范围切换）
    const win = range === "today" ? 1 : range === "week" ? 7 : 30;
    const sdSub = el("sd-trend-sub");
    if (sdSub) sdSub.textContent = `近 ${win} 天 · 按日`;
    const days = dayList(data, win);
    const bks = [];
    for (const dd of days) {
      const dm = (dd.day.by_session || {})[sid] || {};
      bks.push({ label: dd.label, v: [dm.inputOther || 0, dm.inputCacheRead || 0, dm.output || 0] });
    }
    stackedChart(el("sd-chart"), el("sd-axis"), bks);
    // 模型使用占比
    const sms = Object.values(sd.by_model || {});
    sms.sort((a, b) => totOf(b) - totOf(a));
    const maxM = Math.max(...sms.map(x => totOf(x)), 1);
    const mr = el("sd-model-rows");
    if (chg("sdmodel", sms.map(x => [x.model, totOf(x)]))) {
      mr.innerHTML = "";
      if (!sms.length) { mr.innerHTML = '<div class="tt-empty">无模型记录</div>'; }
      else {
        for (const m of sms) {
          const r = document.createElement("div");
          r.className = "tt-row";
          r.style.gridTemplateColumns = "minmax(110px, 1fr) 90px 110px";
          r.innerHTML =
            `<span class="tt-name" title="${esc(m.model)}">${esc(modelLabel(m.model))}</span>` +
            `<span class="tt-num">${(totOf(m) / maxM * 100).toFixed(1)}%</span>` +
            `<span class="tt-num">${fmtTok(totOf(m))} · ¥${costOf(m).toFixed(2)}</span>`;
          mr.appendChild(r);
        }
      }
    }
    // 小时分布（今日）
    const hr = el("sd-hour-rows");
    const hSig = JSON.stringify(Object.entries(sd.hourly || {}).sort((a, b) => +a[0] - +b[0]).map(([h, v]) => [h, v.input + v.cached + v.output]));
    if (chg("sdhour", hSig)) {
      hr.innerHTML = "";
      const hv = Object.entries(sd.hourly || {}).sort((a, b) => +a[0] - +b[0]);
      if (!hv.length) { hr.innerHTML = '<div class="tt-empty">无小时记录</div>'; }
      else {
        const hMax = Math.max(...hv.map(([, v]) => v.input + v.cached + v.output), 1);
        for (const [h, v] of hv) {
          const tot = v.input + v.cached + v.output;
          const r = document.createElement("div");
          r.className = "tt-row";
          r.style.gridTemplateColumns = "44px 1fr 90px";
          r.innerHTML =
            `<span class="tt-num" style="color:var(--muted)">${String(h).padStart(2, "0")}:00</span>` +
            `<div class="mini-bar"><i style="width:${(tot / hMax * 100).toFixed(1)}%"></i></div>` +
            `<span class="tt-num">${fmtTok(tot)} · ${fmt.format(v.requests || 0)}请求</span>`;
          hr.appendChild(r);
        }
      }
    }
  }

  /* ---------- 件：历史统计 ---------- */
  function renderHistoryView(data) {
    const allDays = Object.values(data.days || {}).sort((a, b) => a.date.localeCompare(b.date));
    // 历史窗口跟随顶部切换（今日=1 / 7天 / 30天）
    const win = range === "today" ? 1 : range === "week" ? 7 : 30;
    const sliceDays = allDays.slice(-win);
    const hsSub = el("hs-cost-sub");
    if (hsSub) hsSub.textContent = "近 " + win + " 天";
    const htSub = el("ht-trend-sub");
    if (htSub) htSub.textContent = "近 " + win + " 天 · 每日 Token 消耗";
    const costSum = sliceDays.reduce((a, d) => a + costOf(d), 0);
    const reqSum = sliceDays.reduce((a, d) => a + (d.requests || 0), 0);
    const callSum = sliceDays.reduce((a, d) => a + (d.calls || 0), 0);
    const iSum = sliceDays.reduce((a, d) => a + (d.inputOther || 0) + (d.inputCacheRead || 0), 0);
    const cSum = sliceDays.reduce((a, d) => a + (d.inputCacheRead || 0), 0);
    el("hs-cost").textContent = "¥" + costSum.toFixed(2);
    el("hs-daily").textContent = "¥" + (sliceDays.length ? (costSum / sliceDays.length).toFixed(2) : "0.00");
    el("hs-cache").textContent = iSum > 0 ? (cSum / iSum * 100).toFixed(1) + "%" : "—";
    el("hs-req").textContent = fmt.format(reqSum);
    el("hs-calls-sub").textContent = callSum + " 回合";
    // 趋势柱（单橙）
    const bks = sliceDays.map(d => ({ label: d.date.slice(5), v: totOf(d) }));
    barChart(el("ht-chart"), bks);
    // axis
    const axisEl = el("ht-axis");
    if (axisEl) {
      axisEl.innerHTML = "";
      const n = bks.length;
      [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1].forEach(i => {
        const s = document.createElement("span");
        s.textContent = bks[i] ? bks[i].label : "";
        axisEl.appendChild(s);
      });
    }
    // 明细表（倒序，分页）
    const desc = sliceDays.slice().reverse();
    const totalPg = Math.max(Math.ceil(desc.length / PAGE10), 1);
    if (pages.history > totalPg) pages.history = totalPg;
    const slice2 = desc.slice((pages.history - 1) * PAGE10, pages.history * PAGE10);
    const rowsEl = el("ht-rows");
    if (chg("ht" + pages.history + win, slice2.map(d => [d.date, totOf(d)]))) {
      rowsEl.innerHTML = "";
      if (!slice2.length) { rowsEl.innerHTML = '<div class="tt-empty">暂无记录</div>'; }
      else {
        const head = document.createElement("div");
        head.className = "tt-head htt";
        head.style.gridTemplateColumns = "92px 70px 64px 64px 58px 62px 52px 52px 60px";
        head.innerHTML =
          `<span>日期</span><span class="tt-num">总 Tokens</span><span class="tt-num">输入</span><span class="tt-num">缓存命中</span>` +
          `<span class="tt-num">输出</span><span class="tt-num">命中率</span><span class="tt-num">请求数</span><span class="tt-num">回合数</span><span class="tt-num">费用</span>`;
        rowsEl.appendChild(head);
        for (const d of slice2) {
          const r = document.createElement("div");
          r.className = "tt-row htt";
          r.style.gridTemplateColumns = "92px 70px 64px 64px 58px 62px 52px 52px 60px";
          r.innerHTML =
            `<span style="color:var(--text)">${esc(d.date)}</span>` +
            `<span class="tt-num">${fmtTok(totOf(d))}</span>` +
            `<span class="tt-num">${fmtTok(d.inputOther || 0)}</span>` +
            `<span class="tt-num">${fmtTok(d.inputCacheRead || 0)}</span>` +
            `<span class="tt-num" style="color:var(--out)">${fmtTok(d.output || 0)}</span>` +
            `<span class="tt-num ${cacheRateOf(d) != null ? hitCls(cacheRateOf(d)) : ""}">${cacheRateOf(d) != null ? cacheRateOf(d).toFixed(1) + "%" : "—"}</span>` +
            `<span class="tt-num">${fmt.format(d.requests || 0)}</span>` +
            `<span class="tt-num">${fmt.format(d.calls || 0)}</span>` +
            `<span class="tt-num ${costCls(costOf(d))}">¥${costOf(d).toFixed(2)}</span>`;
          rowsEl.appendChild(r);
        }
      }
    }
    putPager(el("ht-pager"), pages.history, totalPg, p => { pages.history = p; if (current) renderView(current, range); });
  }

  /* ---------- 件：费用分析 ---------- */
  function renderCost(data) {
    const days = data.days || {};
    // 主内容区（趋势/构成/明细）跟随顶部范围切换；KPI 四卡保持固定对比口径
    const win = range === "today" ? 1 : range === "week" ? 7 : 30;
    const keys = dayList(data, win).map(x => x.key);
    const k30 = dayList(data, 30).map(x => x.key);
    const todayK = dayList(data, 1)[0].key;
    const yKey = dayList(data, 2)[0].key;
    const costOfKey = k => costOf(days[k] || emptyDay(k));
    const cToday = costOfKey(todayK);
    const cYest = costOfKey(yKey);
    const cWeek = k30.slice(-7).reduce((a, k) => a + costOfKey(k), 0);
    const cMonth = k30.reduce((a, k) => a + costOfKey(k), 0);
    el("cs-today").textContent = "¥" + cToday.toFixed(2);
    el("cs-yesterday").textContent = "¥" + cYest.toFixed(2);
    const vs = cYest > 0 ? ((cToday - cYest) / cYest * 100) : null;
    const vsEl = el("cs-vs");
    if (vs != null) {
      const up = vs >= 0;
      vsEl.innerHTML = `<span class="${up ? "trend-up" : "trend-down"}">${up ? "↑" : "↓"} ${Math.abs(vs).toFixed(1)}%</span> 较昨日`;
    } else {
      vsEl.textContent = "昨日无数据";
    }
    el("cs-week").textContent = "¥" + cWeek.toFixed(2);
    el("cs-month").textContent = "¥" + cMonth.toFixed(2);
    // 面板标题同步窗口天数
    const subEl = el("cs-trend-sub");
    if (subEl) subEl.textContent = `近 ${win} 天 · 按日`;
    const donutSubEl = el("cs-donut-sub");
    if (donutSubEl) donutSubEl.textContent = `近 ${win} 天`;
    // 费用趋势（按窗口天数折线）
    const lineBks = dayList(data, win).map(x => ({ label: x.label, v: costOfKey(x.key) }));
    lineChart(el("cs-chart"), lineBks);
    const axisEl = el("cs-axis");
    if (axisEl) {
      axisEl.innerHTML = "";
      const n = lineBks.length;
      [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1].forEach(i => {
        const s = document.createElement("span");
        s.textContent = lineBks[i].label;
        axisEl.appendChild(s);
      });
    }
    // 费用构成（按窗口天数）
    const parts = { ms: 0, ck: 0, cw: 0, ot: 0 };
    for (const k of keys) {
      const dd = days[k] || emptyDay(k);
      parts.ms += (dd.inputOther || 0) / 1e6 * prices.miss;
      parts.ck += (dd.inputCacheRead || 0) / 1e6 * prices.cache;
      parts.cw += (dd.inputCacheCreation || 0) / 1e6 * prices.cwrite;
      parts.ot += (dd.output || 0) / 1e6 * prices.out;
    }
    donutChart(el("cs-donut"), el("cs-donut-legend"), el("cs-donut-total"), [
      { label: CAT_LABELS[0], value: parts.ms, color: CAT_COLORS[0], text: "¥" + parts.ms.toFixed(2) },
      { label: CAT_LABELS[1], value: parts.ck, color: CAT_COLORS[1], text: "¥" + parts.ck.toFixed(2) },
      { label: CAT_LABELS[2], value: parts.cw, color: CAT_COLORS[2], text: "¥" + parts.cw.toFixed(2) },
      { label: CAT_LABELS[3], value: parts.ot, color: CAT_COLORS[3], text: "¥" + parts.ot.toFixed(2) },
    ], v => "¥" + v.toFixed(2));
    // 费用明细（窗口天数倒序分页）
    const desc = keys.slice().reverse();
    const totalPg = Math.max(Math.ceil(desc.length / PAGE10), 1);
    if (pages.cost > totalPg) pages.cost = totalPg;
    const slice2 = desc.slice((pages.cost - 1) * PAGE10, pages.cost * PAGE10);
    const rowsEl = el("cs-rows");
    if (chg("cs" + pages.cost, slice2.map(k => [k, costOfKey(k)]))) {
      rowsEl.innerHTML = "";
      if (!slice2.length) { rowsEl.innerHTML = '<div class="tt-empty">暂无记录</div>'; }
      else {
        const head = document.createElement("div");
        head.className = "tt-head cst";
        head.style.gridTemplateColumns = "92px 110px 100px 90px 100px";
        head.innerHTML =
          `<span>日期</span><span class="tt-num">输入未命中</span><span class="tt-num">缓存</span>` +
          `<span class="tt-num">输出</span><span class="tt-num">总费用</span>`;
        rowsEl.appendChild(head);
        for (const k of slice2) {
          const dd = days[k] || emptyDay(k);
          const ms = (dd.inputOther || 0) / 1e6 * prices.miss;
          const ck = (dd.inputCacheRead || 0) / 1e6 * prices.cache;
          const cw = (dd.inputCacheCreation || 0) / 1e6 * prices.cwrite;
          const ot = (dd.output || 0) / 1e6 * prices.out;
          const r = document.createElement("div");
          r.className = "tt-row cst";
          r.style.gridTemplateColumns = "92px 110px 100px 90px 100px";
          r.innerHTML =
            `<span style="color:var(--text)">${esc(k.slice(5))}</span>` +
            `<span class="tt-num">¥${ms.toFixed(2)}</span>` +
            `<span class="tt-num">¥${(ck + cw).toFixed(2)}</span>` +
            `<span class="tt-num">¥${ot.toFixed(2)}</span>` +
            `<span class="tt-num ${costCls(ms + ck + cw + ot)}">¥${(ms + ck + cw + ot).toFixed(2)}</span>`;
          rowsEl.appendChild(r);
        }
      }
    }
    putPager(el("cs-pager"), pages.cost, totalPg, p => { pages.cost = p; if (current) renderView(current, range); });
  }

  /* ---------- 件：设置 ---------- */
  function renderSettings() {
    if (!settingsInit) return;
    // 轮询重绘时跳过正在编辑的定价输入框，避免覆盖用户输入
    if (document.activeElement !== el("p-miss")) el("p-miss").value = prices.miss;
    if (document.activeElement !== el("p-cache")) el("p-cache").value = prices.cache;
    if (document.activeElement !== el("p-cwrite")) el("p-cwrite").value = prices.cwrite;
    if (document.activeElement !== el("p-out")) el("p-out").value = prices.out;
    // 主题/密度按钮同步
    const theme = document.documentElement.dataset.theme || "dark";
    document.querySelectorAll("#set-theme button").forEach(b => b.classList.toggle("active", b.dataset.themeMode === theme));
    const density = document.body.dataset.density || "full";
    document.querySelectorAll("#set-density button").forEach(b => b.classList.toggle("active", b.dataset.density === density));
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    // 概览跳转
    const gs = el("goto-sessions"); if (gs) gs.addEventListener("click", () => switchView("sessions"));
    const gm = el("goto-models"); if (gm) gm.addEventListener("click", () => switchView("models"));
    // 详情返回
    const mb = el("md-back"); if (mb) mb.addEventListener("click", () => switchView("models"));
    const sb2 = el("sd-back"); if (sb2) sb2.addEventListener("click", () => switchView("sessions"));
    // 事件页：查看全部
    const em = el("ev-more");
    if (em) em.addEventListener("click", () => { evAll = !evAll; if (current) renderView(current, range); });
    // 设置页：定价表单
    const ps = el("set-price-save");
    if (ps) {
      ps.addEventListener("click", () => {
        prices.miss = parseFloat(el("p-miss").value) || 0;
        prices.cache = parseFloat(el("p-cache").value) || 0;
        prices.cwrite = parseFloat(el("p-cwrite").value) || 0;
        prices.out = parseFloat(el("p-out").value) || 0;
        savePrices();
        if (current) render(current);
      });
    }
    const pr = el("set-price-reset");
    if (pr) pr.addEventListener("click", () => {
      prices = { ...DEFAULT_PRICES };
      savePrices();
      renderSettings();
      if (current) render(current);
    });
    // 主题模式
    document.querySelectorAll("#set-theme button").forEach(b => {
      b.addEventListener("click", () => {
        document.documentElement.dataset.theme = b.dataset.themeMode;
        try { localStorage.setItem("kimi_theme", b.dataset.themeMode); } catch (er) { /* ignore */ }
        renderSettings();
      });
    });
    const savedTheme = (() => { try { return localStorage.getItem("kimi_theme"); } catch (er) { return null; } })();
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    const sbT = el("theme-toggle");
    if (sbT) sbT.classList.toggle("on", (document.documentElement.dataset.theme || "dark") === "dark");
    // 显示模式（简洁/完整）
    document.querySelectorAll("#set-density button").forEach(b => {
      b.addEventListener("click", () => {
        document.body.dataset.density = b.dataset.density;
        try { localStorage.setItem("kimi_density", b.dataset.density); } catch (er) { /* ignore */ }
        renderSettings();
      });
    });
    const savedDensity = (() => { try { return localStorage.getItem("kimi_density"); } catch (er) { return null; } })();
    if (savedDensity) document.body.dataset.density = savedDensity;
    // 导出配置
    const ex = el("export-config");
    if (ex) {
      ex.addEventListener("click", () => {
        const payload = {
          exportedAt: new Date().toISOString(),
          prices: { ...prices },
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "kimi-token-config.json";
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }
    // 清空本地数据
    const cl = el("clear-local");
    if (cl) {
      cl.addEventListener("click", () => {
        if (window.confirm("确认清空浏览器本地配置（定价/主题/展开状态）？不影响服务器统计 data.json。")) {
          try { localStorage.clear(); } catch (er) { /* ignore */ }
          location.reload();
        }
      });
    }
    // 侧边栏深色模式开关（与设置页分段控件同步）
    const sbTheme = el("theme-toggle");
    if (sbTheme) {
      sbTheme.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        sbTheme.classList.toggle("on", next === "dark");
        try { localStorage.setItem("kimi_theme", next); } catch (er) { /* ignore */ }
        renderSettings();
      });
    }
    // 设置页打开数据目录
    const od2 = el("open-dir2");
    if (od2) {
      od2.addEventListener("click", async () => {
        try {
          await fetch("/api/open", { cache: "no-store" });
        } catch (er) { /* 静默 */ }
      });
    }
    settingsInit = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    switchView,
    currentView,
    dispatch: renderView,
    renderView,
  };
})();
