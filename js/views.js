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
  /** 毫秒时间 → "MM-DD HH:mm:ss"（失败记录行用） */
  function mmddTime(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
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
    // 事件流跟随顶部范围筛选（今日 / 近 7 天 / 近 30 天 / 自定义）
    const rl = rangeLabel();
    const validKeys = new Set(rangeDayKeys(data));
    const isFailScope = evFilter.scope === "failed";
    // 失败模式从独立失败缓冲读取，避免被 recent 60 条截断
    const cap = evAll ? 200 : (isFailScope ? 500 : 60);
    let evs;
    if (isFailScope) {
      evs = (data.fails || [])
        .filter(e => validKeys.has(e.date))
        .slice(0, cap)
        .map(e => Object.assign({}, e, { kind: "failed", input: 0, cached: 0, output: 0, total: 0, input_text: "", output_text: "" }));
    } else {
      evs = (data.recent || []).filter(e => validKeys.has(e.date)).slice(0, cap);
    }
    const hint = el("event-follow-hint");
    if (hint) hint.textContent = "每 2 秒自动刷新 · 点击行展开详情 · " + rl;
    let shown = evs;
    if (!isFailScope) {
      if (evFilter.scope === "main") shown = shown.filter(e => e.scope !== "subagent");
      else if (evFilter.scope === "sub") shown = shown.filter(e => e.scope === "subagent");
    }
    if (evFilter.model) shown = shown.filter(e => e.model === evFilter.model);
    const countEl = el("event-count");
    if (countEl) countEl.textContent = shown.length + " events · " + rl;
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
    const sigKey = "ev" + pages.events + "|" + evFilter.scope + "|" + evFilter.model + "|" + (isFailScope ? "F" : "N") + "|" + (evAll ? "A" : "B") + "|" +
      slice.map(e => keyOf(e)).join(",");
    if (chg(sigKey, slice.map(e => [keyOf(e), e.scope, e.model, e.input, e.cached, e.output, e.kind, e.err_code]))) {
      rowsEl.innerHTML = "";
      if (!slice.length) {
        rowsEl.innerHTML = '<div class="tt-empty">该过滤条件下暂无事件</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head evt";
        head.innerHTML =
          `<span>时间</span><span>类型</span><span>模型</span><span>主/子</span>` +
          `<span class="tt-num">输入</span><span class="tt-num">缓存命中</span><span class="tt-num">命中率</span><span class="tt-num">输出</span>` +
          `<span class="tt-num">总 Tokens</span><span>会话 ID</span><span>操作</span>`;
        rowsEl.appendChild(head);
        for (const ev of slice) {
          const key = keyOf(ev);
          const scope = ev.scope === "subagent" ? "sub" : "main";
          const meta = (data.session_meta || {})[ev.session] || {};
          const sTitle = sessionLabel(ev.session, meta) || shortSid(ev.session);
          const isOpen = evExpanded.has(key);
          const isFailed = ev.kind === "failed";
          const hasErr = isFailed && (ev.err_msg && String(ev.err_msg).trim());
          const detail = document.createElement("div");
          detail.className = "tt-detail" + (isOpen ? "" : " hidden");
          const hasText = hasErr || (ev.input_text && ev.input_text.trim()) || (ev.output_text && ev.output_text.trim());
          if (hasText) {
            let h = "";
            if (hasErr) {
              if (ev.err_code) h += `<div class="evd-label">错误码</div><div class="evd-text">${esc(ev.err_code)}</div>`;
              h += `<div class="evd-label">错误信息</div><div class="evd-text">${esc(ev.err_msg)}</div>`;
            }
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
            detail.innerHTML = isFailed
              ? '<div class="evd-empty">该事件无错误信息</div>'
              : '<div class="evd-empty">该事件未捕获输入/输出文本</div>';
          }
          // 类型徽标：usage 绿色 / 失败红色
          const typeBadge = isFailed
            ? '<span class="lbl" style="color:var(--err);background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.3);padding:1px 7px;border-radius:999px">失败</span>'
            : '<span class="lbl" style="color:var(--ok);background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);padding:1px 7px;border-radius:999px">usage</span>';
          const row = document.createElement("div");
          row.className = "tt-row evt";
          const totalIn = (ev.input || 0) + (ev.cached || 0);
          const cacheRate = isFailed || totalIn === 0
            ? "—"
            : ((ev.cached || 0) / totalIn * 100).toFixed(1) + "%";
          row.innerHTML =
            `<span class="tt-num" style="color:var(--muted)">${esc(String(new Date(ev.time).toTimeString().slice(0, 8)))}</span>` +
            `<span>${typeBadge}</span>` +
            `<span class="tt-name" style="cursor:default" title="${esc(ev.model)}">${esc(modelLabel(ev.model))}</span>` +
            `<span><span class="ev-scope ${scope}">${scope === "sub" ? "子" : "主"}</span></span>` +
            `<span class="tt-num">${isFailed ? "—" : fmtTok(ev.input)}</span>` +
            `<span class="tt-num">${isFailed ? "—" : fmtTok(ev.cached)}</span>` +
            `<span class="tt-num">${cacheRate}</span>` +
            (isFailed
              ? `<span class="tt-num">—</span>`
              : `<span class="tt-num" style="color:var(--out)">${fmtTok(ev.output)}</span>`) +
            `<span class="tt-num">${isFailed ? "—" : fmtTok(ev.total)}</span>` +
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
    if (moreBtn) moreBtn.textContent = evAll
      ? `收起（${isFailScope ? 500 : 200} 条）`
      : (isFailScope ? "查看全部失败 →" : "查看全部事件 →");
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
    if (chg("mo" + pages.models, slice.map(m => [m.model, totOf(m), m.failed || 0, (m.calls || 0) + (m.failed || 0)]))) {
      rowsEl.innerHTML = "";
      if (!slice.length) {
        rowsEl.innerHTML = '<div class="tt-empty">暂无记录</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head mot";
        head.innerHTML =
          `<span>模型</span><span class="tt-num">输入 Tokens</span><span class="tt-num">缓存命中</span>` +
          `<span class="tt-num">输出 Tokens</span><span class="tt-num">总 Tokens</span><span class="tt-num">命中率</span>` +
          `<span class="tt-num">请求数</span><span class="tt-num">回合数</span><span class="tt-num">失败</span>` +
          `<span class="tt-num">失败率</span><span class="tt-num">费用预估</span>`;
        rowsEl.appendChild(head);
        for (const m of slice) {
          const r = document.createElement("div");
          r.className = "tt-row mot";
          // 失败率：失败回合 / 总回合（失败回合不产生 usage，分母 = calls + failed）
          const failDen = (m.calls || 0) + (m.failed || 0);
          const failRate = failDen > 0 ? ((m.failed || 0) / failDen) * 100 : null;
          const frCls = failRate == null ? "" : failRate >= 20 ? "pct-bad" : failRate >= 5 ? "pct-warn" : "";
          r.innerHTML =
            `<span class="tt-name" title="${esc(m.model)}">${modelBadge(models.indexOf(m))}${esc(modelLabel(m.model))}</span>` +
            `<span class="tt-num">${fmtTok(m.inputOther)}</span>` +
            `<span class="tt-num">${fmtTok(m.inputCacheRead)}</span>` +
            `<span class="tt-num" style="color:var(--out)">${fmtTok(m.output)}</span>` +
            `<span class="tt-num">${fmtTok(totOf(m))}</span>` +
            `<span class="tt-num ${cacheRateOf(m) != null ? hitCls(cacheRateOf(m)) : ""}">${cacheRateOf(m) != null ? cacheRateOf(m).toFixed(1) + "%" : "—"}</span>` +
            `<span class="tt-num">${fmt.format(m.requests || 0)}</span>` +
            `<span class="tt-num">${fmt.format(m.calls || 0)}</span>` +
            `<span class="tt-num${(m.failed || 0) > 0 ? " pct-bad" : ""}">${m.failed || 0}</span>` +
            `<span class="tt-num ${frCls}" title="失败回合 / 总回合">${failRate != null ? failRate.toFixed(1) + "%" : "—"}</span>` +
            `<span class="tt-num ${costCls(costOf(m, m.model))}">¥${costOf(m, m.model).toFixed(2)}</span>`;
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
    el("md-cost").textContent = "¥" + costOf(mm, model).toFixed(2);
    // 使用趋势（跟随顶部范围切换）：今日按小时，其他按日
    const rl = rangeLabel();
    const mdSub = el("md-trend-sub");
    const dKeys = rangeDayKeys(data); // 当前范围日期键（今日=[today]），下方失败记录过滤也依赖它
    let bks;
    if (range === "today") {
      if (mdSub) mdSub.textContent = rl + " · 按小时";
      const mh = ((((data.days || {})[data.today] || {}).by_model || {})[model] || {});
      const hourly = mh.hourly || {};
      bks = [];
      for (let h = 0; h < 24; h++) {
        const hv = hourly[String(h)] || { input: 0, cached: 0, output: 0 };
        bks.push({ label: String(h).padStart(2, "0"), v: [hv.input || 0, hv.cached || 0, hv.output || 0] });
      }
    } else {
      if (mdSub) mdSub.textContent = rl + " · 按日";
      bks = dKeys.map(k => {
        const dm = (((data.days || {})[k] || {}).by_model || {})[model] || {};
        return { label: k.slice(5), v: [dm.inputOther || 0, dm.inputCacheRead || 0, dm.output || 0] };
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
            `<span class="tt-num">${fmtTok(t)} · ¥${costOf(sm, model).toFixed(2)}</span>`;
          r.querySelector(".tt-name").addEventListener("click", () => switchView("session-detail", { session: s.session }));
          srows.appendChild(r);
        }
      }
    }
    // 失败记录（当前范围，最多 20 条，倒序；数据源为独立失败缓冲 data.fails）
    const fKeys = new Set(dKeys);
    const fails = (data.fails || [])
      .filter(e => e.model === model && fKeys.has(e.date))
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);
    const failSub = el("md-fail-sub");
    if (failSub) failSub.textContent = rl + " · " + fails.length + " 次";
    const fr = el("md-fail-rows");
    if (chg("mdfail" + dKeys.join(""), fails.map(e => [e.time, e.err_code, e.err_msg]))) {
      fr.innerHTML = "";
      if (!fails.length) {
        fr.innerHTML = '<div class="tt-empty">该模型在选定范围内无失败记录</div>';
      } else {
        const head = document.createElement("div");
        head.className = "tt-head";
        head.style.gridTemplateColumns = "130px 150px minmax(160px, 1fr)";
        head.innerHTML = `<span>时间</span><span>错误码</span><span>错误信息</span>`;
        fr.appendChild(head);
        for (const e of fails) {
          const r = document.createElement("div");
          r.className = "tt-row";
          r.style.gridTemplateColumns = "130px 150px minmax(160px, 1fr)";
          r.innerHTML =
            `<span class="tt-num" style="color:var(--muted)">${esc(mmddTime(e.time))}</span>` +
            `<span class="tt-num" style="color:var(--muted)">${esc(e.err_code || "—")}</span>` +
            `<span class="tt-name" style="cursor:default" title="${esc(e.err_msg || "")}">${esc(e.err_msg || "—")}</span>`;
          fr.appendChild(r);
        }
      }
    }
    // 费用构成（按该模型计价）
    const comps = costPartsOf(mm, model);
    donutChart(el("md-donut"), el("md-donut-legend"), el("md-donut-total"), comps, v => "¥" + v.toFixed(2));
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
    el("sd-cost").textContent = "¥" + costOfAgg(sd).toFixed(2);
    // 使用趋势（跟随顶部范围切换）
    const dKeys = rangeDayKeys(data);
    const rl = rangeLabel();
    const sdSub = el("sd-trend-sub");
    if (sdSub) sdSub.textContent = rl + " · 按日";
    const bks = dKeys.map(k => {
      const dm = (((data.days || {})[k] || {}).by_session || {})[sid] || {};
      return { label: k.slice(5), v: [dm.inputOther || 0, dm.inputCacheRead || 0, dm.output || 0] };
    });
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
            `<span class="tt-num">${fmtTok(totOf(m))} · ¥${costOf(m, m.model).toFixed(2)}</span>`;
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
    // 历史窗口跟随顶部切换（今日 / 7天 / 30天 / 自定义）
    const dKeys = rangeDayKeys(data);
    const keySet = new Set(dKeys);
    const sliceDays = allDays.filter(d => keySet.has(d.date)); // 窗口内升序
    const rl = rangeLabel();
    const hsSub = el("hs-cost-sub");
    if (hsSub) hsSub.textContent = rl;
    const htSub = el("ht-trend-sub");
    if (htSub) htSub.textContent = rl + " · 每日 Token 消耗";
    const costSum = sliceDays.reduce((a, d) => a + costOfAgg(d), 0);
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
    if (chg("ht" + pages.history + dKeys.join(""), slice2.map(d => [d.date, totOf(d)]))) {
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
            `<span class="tt-num ${costCls(costOfAgg(d))}">¥${costOfAgg(d).toFixed(2)}</span>`;
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
    const dKeys = rangeDayKeys(data);
    const rl = rangeLabel();
    const k30 = dayList(data, 30).map(x => x.key);
    const todayK = dayList(data, 1)[0].key;
    const yKey = dayList(data, 2)[0].key;
    const costOfKey = k => costOfAgg(days[k] || emptyDay(k));
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
    // 面板标题同步窗口
    const subEl = el("cs-trend-sub");
    if (subEl) subEl.textContent = rl + " · 按日";
    const donutSubEl = el("cs-donut-sub");
    if (donutSubEl) donutSubEl.textContent = rl;
    // 费用趋势（按窗口天数折线）
    const lineBks = dKeys.map(k => ({ label: k.slice(5), v: costOfKey(k) }));
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
    // 费用构成（按窗口天数，尊重按模型定价）
    const partAgg = { miss: 0, cache: 0, cwrite: 0, out: 0 };
    for (const k of dKeys) {
      const comps = costPartsOf(days[k] || emptyDay(k));
      partAgg.miss += comps[0].value;
      partAgg.cache += comps[1].value;
      partAgg.cwrite += comps[2].value;
      partAgg.out += comps[3].value;
    }
    donutChart(el("cs-donut"), el("cs-donut-legend"), el("cs-donut-total"), [
      { label: CAT_LABELS[0], value: partAgg.miss, color: CAT_COLORS[0], text: "¥" + partAgg.miss.toFixed(2) },
      { label: CAT_LABELS[1], value: partAgg.cache, color: CAT_COLORS[1], text: "¥" + partAgg.cache.toFixed(2) },
      { label: CAT_LABELS[2], value: partAgg.cwrite, color: CAT_COLORS[2], text: "¥" + partAgg.cwrite.toFixed(2) },
      { label: CAT_LABELS[3], value: partAgg.out, color: CAT_COLORS[3], text: "¥" + partAgg.out.toFixed(2) },
    ], v => "¥" + v.toFixed(2));
    // 费用明细（窗口天数倒序分页）
    const desc = dKeys.slice().reverse();
    const totalPg = Math.max(Math.ceil(desc.length / PAGE10), 1);
    if (pages.cost > totalPg) pages.cost = totalPg;
    const slice2 = desc.slice((pages.cost - 1) * PAGE10, pages.cost * PAGE10);
    const rowsEl = el("cs-rows");
    if (chg("cs" + pages.cost + dKeys.join(""), slice2.map(k => [k, costOfKey(k)]))) {
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
          const comps = costPartsOf(days[k] || emptyDay(k));
          const ms = comps[0].value, ck = comps[1].value, cw = comps[2].value, ot = comps[3].value;
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
    const ae = document.activeElement;
    // 全局默认价：跳过正在编辑的输入框
    if (ae !== el("p-miss")) el("p-miss").value = prices.miss;
    if (ae !== el("p-cache")) el("p-cache").value = prices.cache;
    if (ae !== el("p-cwrite")) el("p-cwrite").value = prices.cwrite;
    if (ae !== el("p-out")) el("p-out").value = prices.out;
    // 按模型定价表格：如果当前焦点不在表格内则重建，否则只同步来源标签与计数
    const tbody = el("pm-rows");
    if (tbody && !tbody.contains(ae)) {
      buildModelRows();
    } else if (tbody) {
      updateModelRowSources();
    }
    updateModelCount();
    // 搜索过滤
    filterModelRows();
    // 告警配置同步（跳过正在编辑的输入框）
    const al = loadAlerts();
    const aEn = el("al-enabled"), aCost = el("al-cost"), aFail = el("al-fail");
    if (aEn) aEn.checked = al.enabled;
    if (aCost && ae !== aCost && String(aCost.value) !== String(al.costLimit)) aCost.value = al.costLimit > 0 ? al.costLimit : "";
    if (aFail && ae !== aFail && String(aFail.value) !== String(al.failLimit)) aFail.value = al.failLimit > 0 ? al.failLimit : "";
    // 主题/密度按钮同步
    const theme = document.documentElement.dataset.theme || "dark";
    document.querySelectorAll("#set-theme button").forEach(b => b.classList.toggle("active", b.dataset.themeMode === theme));
    const density = document.body.dataset.density || "full";
    document.querySelectorAll("#set-density button").forEach(b => b.classList.toggle("active", b.dataset.density === density));
    // 内置价格目录卡片
    renderCatalogCard();
    // 数据管理信息
    const gsDir = el("gs-dir"), gsFiles = el("gs-files");
    if (gsDir) gsDir.textContent = current && current.session_root ? current.session_root : state.SESSION_ROOT || "~/.kimi-code/sessions";
    if (gsFiles) gsFiles.textContent = (current && current.tracked_files != null ? current.tracked_files : "—") + " 个日志文件";
  }

  /* 获取模型最终生效价的来源标签 */
  function sourceBadgeOf(model) {
    const hasManual = (prices.models || {})[model];
    if (hasManual) return { cls: "manual", text: "手动" };
    const cp = catalogPriceOf(model);
    if (cp) return { cls: "catalog", text: "目录" };
    return { cls: "default", text: "默认" };
  }

  /* ---------- 设置页：内置价格目录卡片 ---------- */
  /** 渲染目录卡片的来源/日期/模型数；汇率输入仅在未聚焦且为空时填充默认值 */
  function renderCatalogCard() {
    const cat = getCatalog();
    const srcEl = el("catalog-source"), dateEl = el("catalog-date"), cntEl = el("catalog-count");
    if (srcEl) srcEl.textContent = (cat && cat.source) ? cat.source : "—";
    if (dateEl) dateEl.textContent = (cat && cat.fetchedAt) ? cat.fetchedAt : "—";
    if (cntEl) cntEl.textContent = (cat && cat.models) ? Object.keys(cat.models).length : 0;
    const rateEl = el("catalog-rate");
    if (rateEl && document.activeElement !== rateEl && rateEl.value === "") {
      rateEl.value = (cat && cat.usdToCny) ? cat.usdToCny : 7.2;
    }
  }
  /** 数值兜底：非数字一律按 0 处理 */
  function numOf(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  /** 同步在线目录（models.dev）：用户手动触发，换算成元存入 localStorage CATALOG_KEY */
  async function syncCatalog() {
    const st = el("catalog-status");
    const btn = el("catalog-sync");
    const rate = parseFloat(el("catalog-rate") ? el("catalog-rate").value : "") || 7.2;
    if (btn) btn.disabled = true;
    if (st) { st.textContent = "正在从 models.dev 同步价格…"; st.style.color = "var(--text-2)"; }
    try {
      const res = await fetch("https://models.dev/api.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const raw = await res.json();
      // api.json 结构：{ providerId: { name, models: { modelId: { name, cost:{input,cache_read,output}, ... } } } }
      // 只收录带 cost 的模型，按汇率换算成元/百万 tokens
      const models = {};
      for (const [pid, pv] of Object.entries(raw || {})) {
        const pmodels = (pv && pv.models) || {};
        for (const [mid, m] of Object.entries(pmodels)) {
          const cost = m && m.cost;
          if (!cost || typeof cost !== "object") continue;
          const usd = { input: numOf(cost.input), cache_read: numOf(cost.cache_read), output: numOf(cost.output) };
          const tail = mid.split("/").pop();
          models[mid] = {
            name: m.name || mid,
            miss: Math.round(usd.input * rate * 1e6) / 1e6,
            cache: Math.round(usd.cache_read * rate * 1e6) / 1e6,
            cwrite: 0,
            out: Math.round(usd.output * rate * 1e6) / 1e6,
            usd,
            aliases: [tail, String(m.name || mid).toLowerCase(), mid],
          };
        }
      }
      const catalog = {
        source: "models.dev",
        fetchedAt: new Date().toISOString().slice(0, 10),
        usdToCny: rate,
        models,
      };
      try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)); }
      catch (e) { throw new Error("本地存储不可用"); }
      if (st) { st.textContent = "已同步 " + Object.keys(models).length + " 个模型价格（元/百万 tokens，汇率 " + rate + "）。"; st.style.color = "var(--ok)"; }
      renderCatalogCard();
      if (current) render(current); // 刷新页面费用显示
    } catch (e) {
      if (st) { st.textContent = "同步失败：" + (e && e.message ? e.message : e) + "，请检查网络后重试。"; st.style.color = "var(--err)"; }
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  /** 恢复内置目录：删除 localStorage 同步版，回退到静态 PRICING_CATALOG */
  function restoreCatalog() {
    try { localStorage.removeItem(CATALOG_KEY); } catch (e) {}
    const cat = getCatalog();
    const st = el("catalog-status");
    if (st) {
      st.textContent = cat ? "已恢复内置目录（" + cat.source + " · " + cat.fetchedAt + "）。" : "已清除本地目录（当前无内置目录可回退）。";
      st.style.color = "var(--text-2)";
    }
    renderCatalogCard();
    if (current) render(current);
  }

  /* ---------- 设置页：按模型定价表格 ---------- */
  function addModelRow(name, vals) {
    const tbody = el("pm-rows");
    if (!tbody) return;
    const tr = document.createElement("tr");
    tr.dataset.model = name || "";
    const source = sourceBadgeOf(name);
    const priceFields = ["miss", "cache", "cwrite", "out"];
    const inputsHtml = priceFields.map(k =>
      `<td><input type="number" step="0.001" min="0" data-field="${k}" value="${vals && vals[k] != null ? esc(String(vals[k])) : ""}"></td>`
    ).join("");
    tr.innerHTML =
      `<td><input type="text" class="pm-name" placeholder="模型名" value="${esc(name || "")}"></td>` +
      `<td><span class="pm-source ${source.cls}">${source.text}</span></td>` +
      inputsHtml +
      `<td><button type="button" class="pm-del" title="删除">✕</button></td>`;
    tr.querySelector(".pm-del").addEventListener("click", () => tr.remove());
    // 模型名变化时更新来源标签
    tr.querySelector(".pm-name").addEventListener("input", () => {
      tr.dataset.model = tr.querySelector(".pm-name").value.trim();
      const badge = sourceBadgeOf(tr.dataset.model);
      const span = tr.querySelector(".pm-source");
      span.className = "pm-source " + badge.cls;
      span.textContent = badge.text;
      filterModelRows();
    });
    tbody.appendChild(tr);
  }
  /** 更新表格中每行的来源标签（不重建，避免丢失焦点） */
  function updateModelRowSources() {
    const tbody = el("pm-rows");
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll("tr")) {
      const nm = tr.querySelector(".pm-name").value.trim();
      const badge = sourceBadgeOf(nm);
      const span = tr.querySelector(".pm-source");
      if (!span) continue;
      span.className = "pm-source " + badge.cls;
      span.textContent = badge.text;
    }
  }
  /** 从 prices.models 重建全部按模型定价行 */
  function buildModelRows() {
    const tbody = el("pm-rows");
    if (!tbody) return;
    tbody.innerHTML = "";
    const models = prices.models || {};
    if (!Object.keys(models).length) {
      tbody.innerHTML = '<tr><td colspan="7" class="pm-empty">暂无手动定价模型，可点击「从目录填充」或「+ 添加」。</td></tr>';
      return;
    }
    for (const [name, vals] of Object.entries(models).sort((a, b) => a[0].localeCompare(b[0]))) {
      addModelRow(name, vals);
    }
  }
  /** 搜索过滤模型表格 */
  function filterModelRows() {
    const input = el("pm-search");
    const tbody = el("pm-rows");
    if (!input || !tbody) return;
    const q = input.value.trim().toLowerCase();
    for (const tr of tbody.querySelectorAll("tr")) {
      if (tr.querySelector(".pm-empty")) continue;
      const nm = tr.querySelector(".pm-name").value.toLowerCase();
      tr.style.display = !q || nm.includes(q) ? "" : "none";
    }
  }
  function updateModelCount() {
    const cnt = Object.keys(prices.models || {}).length;
    const elc = el("pm-count");
    if (elc) elc.textContent = cnt + " 个模型";
  }
  /** 从数据中出现过的模型一键生成按模型定价行：价格预填目录价，目录未命中的预填全局默认价；已有行跳过 */
  function fillFromCatalog() {
    const tbody = el("pm-rows");
    if (!tbody || !current) return;
    const seen = new Set();
    for (const tr of tbody.querySelectorAll("tr")) {
      const nm = tr.querySelector(".pm-name")?.value.trim();
      if (nm) seen.add(nm);
    }
    const names = new Set();
    for (const d of Object.values(current.days || {})) {
      for (const mk of Object.keys(d.by_model || {})) names.add(mk);
    }
    let added = 0;
    for (const nm of [...names].sort()) {
      if (seen.has(nm)) continue;
      const cp = catalogPriceOf(nm);
      addModelRow(nm, cp || { miss: prices.miss, cache: prices.cache, cwrite: prices.cwrite, out: prices.out });
      added++;
    }
    // 移除空提示行
    const empty = tbody.querySelector(".pm-empty");
    if (empty && Object.keys(prices.models || {}).length + added > 0) empty.closest("tr").remove();
    filterModelRows();
    updateModelCount();
    const st = el("pm-fill-status");
    if (st) {
      st.textContent = added ? `已填充 ${added} 个模型行，点「保存」生效。` : "无需填充：数据中未出现新模型。";
      st.style.color = "var(--muted)";
    }
  }

  /* ---------- 设置页：CSV 导出 ---------- */
  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCSV(filename, rows) {
    const csv = "\ufeff" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function ymd() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function exportDailyCSV() {
    if (!current) return;
    const days = current.days || {};
    const rows = [["日期", "输入未命中", "缓存命中", "缓存写入", "输出", "总Tokens", "请求数", "回合数", "失败数", "费用(元)"]];
    Object.keys(days).sort().forEach(k => {
      const d = days[k];
      rows.push([k, d.inputOther || 0, d.inputCacheRead || 0, d.inputCacheCreation || 0, d.output || 0,
        totOf(d), d.requests || 0, d.calls || 0, d.failed || 0, +(costOfAgg(d).toFixed(4))]);
    });
    downloadCSV("kimi-token-daily-" + ymd(), rows);
  }
  function exportModelsCSV() {
    if (!current) return;
    const agg = {};
    for (const d of Object.values(current.days || {})) {
      for (const [mk, m] of Object.entries(d.by_model || {})) {
        if (!agg[mk]) agg[mk] = { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, calls: 0, requests: 0, failed: 0 };
        const a = agg[mk];
        a.inputOther += m.inputOther || 0; a.inputCacheRead += m.inputCacheRead || 0;
        a.inputCacheCreation += m.inputCacheCreation || 0; a.output += m.output || 0;
        a.calls += m.calls || 0; a.requests += m.requests || 0; a.failed += m.failed || 0;
      }
    }
    const list = Object.entries(agg).map(([name, a]) => ({ name, ...a, tot: totOf(a) }));
    list.sort((x, y) => y.tot - x.tot);
    const rows = [["模型", "输入未命中", "缓存命中", "缓存写入", "输出", "总Tokens", "请求数", "回合数", "失败数", "费用(元)"]];
    for (const m of list) {
      rows.push([m.name, m.inputOther, m.inputCacheRead, m.inputCacheCreation, m.output, m.tot,
        m.requests, m.calls, m.failed, +(costOf(m, m.name).toFixed(4))]);
    }
    downloadCSV("kimi-token-models-" + ymd(), rows);
  }

  /* ---------- 告警通知 ---------- */
  const ALERT_KEY = "kimi_token_alerts";
  const ALERT_COOLDOWN = 30 * 60 * 1000; // 同类 30 分钟内不重复提醒
  const alertLast = { cost: 0, fail: 0 };
  function loadAlerts() {
    try {
      const raw = localStorage.getItem(ALERT_KEY);
      if (raw) {
        const a = JSON.parse(raw);
        return { enabled: !!a.enabled, costLimit: +a.costLimit || 0, failLimit: +a.failLimit || 0 };
      }
    } catch (e) {}
    return { enabled: false, costLimit: 0, failLimit: 0 };
  }
  /** 从设置页表单读取并保存告警配置 */
  function saveAlerts() {
    const a = {
      enabled: el("al-enabled") ? el("al-enabled").checked : false,
      costLimit: parseFloat(el("al-cost") ? el("al-cost").value : 0) || 0,
      failLimit: parseInt(el("al-fail") ? el("al-fail").value : 0, 10) || 0,
    };
    try { localStorage.setItem(ALERT_KEY, JSON.stringify(a)); } catch (e) {}
    return a;
  }
  /** 轮询后检查：今日费用 / 今日失败次数超阈值触发告警（每类 30 分钟冷却） */
  function checkAlerts(data) {
    const cfg = loadAlerts();
    if (!cfg.enabled || !data) return;
    const day = (data.days || {})[data.today] || emptyDay(data.today);
    const now = Date.now();
    const cost = costOfAgg(day);
    if (cfg.costLimit > 0 && cost > cfg.costLimit) {
      fireAlert("cost", "今日费用超限", "今日费用 ¥" + cost.toFixed(2) + "，超过阈值 ¥" + cfg.costLimit.toFixed(2), now);
    }
    if (cfg.failLimit > 0 && (day.failed || 0) > cfg.failLimit) {
      fireAlert("fail", "今日失败次数超限", "今日失败 " + (day.failed || 0) + " 次，超过阈值 " + cfg.failLimit + " 次", now);
    }
  }
  function fireAlert(type, title, body, now) {
    if (now - (alertLast[type] || 0) < ALERT_COOLDOWN) return;
    alertLast[type] = now;
    // 浏览器通知（权限已授予时）
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body, tag: "kimi-alert-" + type }); } catch (e) { /* 通知失败忽略，仍展示 toast */ }
    }
    // 页面右上角 toast
    let box = el("toast-box");
    if (!box) {
      box = document.createElement("div");
      box.id = "toast-box";
      box.className = "toast-box";
      document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<div class="t">${esc(title)}</div><div>${esc(body)}</div>`;
    box.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, 10000);
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
    // 设置页：标签切换
    document.querySelectorAll(".settings-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        document.querySelectorAll(".settings-tab").forEach(t => t.classList.toggle("active", t === tab));
        document.querySelectorAll(".settings-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === target));
      });
    });
    // 设置页：定价表单
    const ps = el("set-price-save");
    if (ps) {
      ps.addEventListener("click", () => {
        prices.miss = parseFloat(el("p-miss").value) || 0;
        prices.cache = parseFloat(el("p-cache").value) || 0;
        prices.cwrite = parseFloat(el("p-cwrite").value) || 0;
        prices.out = parseFloat(el("p-out").value) || 0;
        // 按模型定价表格：模型名非空的行写入 prices.models
        prices.models = {};
        const tbody = el("pm-rows");
        if (tbody) {
          for (const tr of tbody.querySelectorAll("tr")) {
            const nm = tr.querySelector(".pm-name")?.value.trim();
            if (!nm || tr.querySelector(".pm-empty")) continue;
            const vals = {};
            let hasValue = false;
            for (const inp of tr.querySelectorAll("input[data-field]")) {
              const v = inp.value.trim();
              if (v !== "") hasValue = true;
              vals[inp.dataset.field] = parseFloat(v) || 0;
            }
            // 只填了模型名、未填任何价格：跳过该行，避免全 0 覆盖目录/默认价
            if (!hasValue) continue;
            prices.models[nm] = vals;
          }
        }
        savePrices();
        buildModelRows();
        updateModelCount();
        const st = el("pm-fill-status");
        if (st) { st.textContent = "已保存"; st.style.color = "var(--ok)"; setTimeout(() => st.textContent = "", 1500); }
        if (current) render(current);
      });
    }
    const pr = el("set-price-reset");
    if (pr) pr.addEventListener("click", () => {
      prices = { ...DEFAULT_PRICES, models: {} };
      savePrices();
      buildModelRows();
      updateModelCount();
      renderSettings();
      if (current) render(current);
    });
    const pmc = el("pm-clear");
    if (pmc) pmc.addEventListener("click", () => {
      prices.models = {};
      savePrices();
      buildModelRows();
      updateModelCount();
      if (current) render(current);
    });
    // 按模型定价：添加行 + 搜索 + 初始重建
    const pma = el("pm-add");
    if (pma) pma.addEventListener("click", () => {
      const tbody = el("pm-rows");
      const empty = tbody?.querySelector(".pm-empty");
      if (empty) empty.closest("tr").remove();
      addModelRow("", null);
      updateModelCount();
    });
    const pmf = el("pm-fill");
    if (pmf) pmf.addEventListener("click", fillFromCatalog);
    const pms = el("pm-search");
    if (pms) pms.addEventListener("input", filterModelRows);
    buildModelRows();
    updateModelCount();
    // 内置价格目录：同步在线 / 恢复内置
    const cs = el("catalog-sync");
    if (cs) cs.addEventListener("click", syncCatalog);
    const cr = el("catalog-restore");
    if (cr) cr.addEventListener("click", restoreCatalog);
    // 告警通知面板
    const aEn = el("al-enabled");
    if (aEn) aEn.addEventListener("change", () => {
      if (aEn.checked && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
      saveAlerts();
    });
    const aCost = el("al-cost"), aFail = el("al-fail");
    if (aCost) aCost.addEventListener("change", saveAlerts);
    if (aFail) aFail.addEventListener("change", saveAlerts);
    // 数据管理：导出 CSV
    const exD = el("export-daily-csv");
    if (exD) exD.addEventListener("click", exportDailyCSV);
    const exM = el("export-models-csv");
    if (exM) exM.addEventListener("click", exportModelsCSV);
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
        if (window.confirm("确认清空浏览器本地配置（定价/主题/展开状态）？不影响服务器统计 data.db。")) {
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
    checkAlerts,
    saveAlerts,
  };
})();
