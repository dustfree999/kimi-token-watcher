/* ============================================================
   Kimi Code Token 监控 · 前端逻辑
   轮询 + 初始化 + setRange
   依赖：全局 el/esc/copyText/fmtTok（js/utils.js）、
         current/range/prices/chartGranularity/autoFollow/
         evFilter（js/data.js）、render/updateEventFollowHint（js/render.js）
   ============================================================ */
"use strict";

/* ---------- 轮询 ---------- */
function isFileProtocol() { return window.location.protocol === "file:"; }

let inflight = false; // 请求进行中：防止慢响应乱序覆盖新数据
let pollTimer = null; // 轮询定时器句柄（file:// 引导页时清理）

async function refresh() {
  if (isFileProtocol()) {
    document.body.innerHTML =
      `<div class="guide-page"><h2>请通过本地服务访问</h2>` +
      `<p>直接双击打开文件是 <code>file://</code> 协议，浏览器会拦截数据请求。</p>` +
      `<p>请先运行目录下的 <b>启动.bat</b>（或执行 <code>python server.py</code>），` +
      `然后访问 <a href="http://127.0.0.1:8787">http://127.0.0.1:8787</a>。</p></div>`;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } // 停止轮询，避免每 2 秒重建引导页
    return;
  }
  if (inflight) return; // 上一次请求未完成时跳过本次
  inflight = true;
  try {
    let data;
    try {
      const resp = await fetch("/api/usage", { cache: "no-store" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      data = await resp.json();
    } catch (e) {
      // 网络 / HTTP 错误：连接失败
      const badge = el("conn-status");
      badge.querySelector(".dot").className = "dot err";
      badge.lastChild.textContent = " 连接失败";
      el("last-refresh").textContent = String(e);
      return;
    }
    render(data);
    // 告警通知检查（今日费用 / 失败次数超阈值）
    if (window.Views && window.Views.checkAlerts) window.Views.checkAlerts(data);
  } catch (e) {
    // 渲染异常与连接无关，单独展示真实错误，避免误报“连接失败”
    el("last-refresh").textContent = "渲染异常: " + e;
  } finally {
    inflight = false;
  }
}

function setRange(r, btn) {
  // 设计稿入口：与现有范围映射
  range = r === "live" ? "today" : r;
  if (btn) document.querySelectorAll("#range-switch button").forEach(b => b.classList.toggle("active", b === btn));

  // 今日维度下按天无意义，强制切回按小时并禁用按天按钮
  const dayBtn = document.querySelector('#chart-filter button[data-gran="day"]');
  const hourBtn = document.querySelector('#chart-filter button[data-gran="hour"]');
  if (dayBtn) dayBtn.disabled = (range === "today");
  if (range === "today" && chartGranularity === "day" && hourBtn) {
    chartGranularity = "hour";
    document.querySelectorAll("#chart-filter button").forEach(b => b.classList.toggle("active", b === hourBtn));
  }

  if (current) render(current);
}

/* ---------- 初始化 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  // Token 使用趋势粒度切换（按小时 / 按天）
  el("chart-filter").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-gran]");
    if (!btn) return;
    chartGranularity = btn.dataset.gran;
    document.querySelectorAll("#chart-filter button").forEach(b => b.classList.toggle("active", b === btn));
    if (current) render(current);
  });

  // 事件流过滤：范围（全部/主/子/失败）+ 模型下拉
  el("ev-filter-scope").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-scope]");
    if (!btn) return;
    evFilter.scope = btn.dataset.scope;
    document.querySelectorAll("#ev-filter-scope button").forEach(b => b.classList.toggle("active", b === btn));
    if (current) render(current);
  });
  el("ev-model-filter").addEventListener("change", (e) => {
    evFilter.model = e.target.value;
    if (current) render(current);
  });

  // 自动滚动（旧事件流卡片已移除，保留防错）
  const evStream = el("event-stream");
  if (evStream) {
    evStream.addEventListener("scroll", () => {
      autoFollow = evStream.scrollTop < 30;
      updateEventFollowHint();
    });
  }
  updateEventFollowHint();

  // 范围切换
  el("range-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    if (btn.dataset.range === "custom") { openCustomRange(); return; } // 自定义只弹日期选择，不改 range
    setRange(btn.dataset.range, btn);
  });

  /* ---------- 自定义时间范围弹窗 ---------- */
  function openCustomRange() {
    el("cr-start").value = customRange.start || "";
    el("cr-end").value = customRange.end || "";
    el("cr-hint").textContent = "";
    el("custom-range-overlay").classList.remove("hidden");
  }
  el("cr-apply").addEventListener("click", () => {
    const s = el("cr-start").value, e = el("cr-end").value;
    if (!s || !e) { el("cr-hint").textContent = "请选择开始与结束日期"; return; }
    let st = s, en = e;
    if (st > en) { const t = st; st = en; en = t; } // 防呆：交换
    if (current && current.today && en > current.today) en = current.today; // end 不超过今日
    customRange = { start: st, end: en };
    el("custom-range-overlay").classList.add("hidden");
    const cBtn = document.querySelector('#range-switch button[data-range="custom"]');
    setRange("custom", cBtn); // 复用 setRange：激活态 + 粒度按钮禁用态一并处理
  });
  el("cr-cancel").addEventListener("click", () => el("custom-range-overlay").classList.add("hidden"));
  el("custom-range-overlay").addEventListener("click", (e) => {
    if (e.target === el("custom-range-overlay")) el("custom-range-overlay").classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (el("custom-range-overlay").classList.contains("hidden")) return;
    if (e.key === "Escape") el("custom-range-overlay").classList.add("hidden");
    else if (e.key === "Enter" && e.target && (e.target.id === "cr-start" || e.target.id === "cr-end")) {
      e.preventDefault();
      el("cr-apply").click();
    }
  });

  // 支持 URL ?range=week|month|today|custom（custom 需 ?start=&end= 日期）
  const urlRange = new URLSearchParams(location.search).get("range");
  if (urlRange === "custom") {
    const qs = new URLSearchParams(location.search);
    const st = qs.get("start"), en = qs.get("end");
    if (st && en) {
      customRange = { start: st, end: en };
      range = "custom";
      const btn = document.querySelector('#range-switch button[data-range="custom"]');
      if (btn) btn.classList.add("active");
    }
  } else if (urlRange && ["live", "today", "week", "month"].includes(urlRange)) {
    const btn = document.querySelector(`#range-switch button[data-range="${urlRange}"]`);
    if (btn) setRange(urlRange, btn);
  }
  // 初始化粒度按钮禁用状态
  const initDayBtn = document.querySelector('#chart-filter button[data-gran="day"]');
  if (initDayBtn) initDayBtn.disabled = (range === "today");

  // 侧边栏导航：切换多页面视图（views.js）
  document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.Views) window.Views.switchView(item.dataset.view);
    });
  });
  document.querySelectorAll(".nav-item").forEach(n => {
    n.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); n.click(); }
    });
  });
  // 手动刷新
  const rn = el("refresh-now");
  if (rn) rn.addEventListener("click", refresh);

  // 打开数据目录（尝试通知本地服务；失败时静默降级）
  const dirBtn = el("open-dir");
  if (dirBtn) {
    dirBtn.addEventListener("click", async () => {
      const orig = dirBtn.textContent;
      try {
        const resp = await fetch("/api/open", { cache: "no-store" });
        const j = await resp.json();
        dirBtn.textContent = j.ok ? "已打开" : "无法打开";
      } catch (e) {
        dirBtn.textContent = "无法打开";
      }
      setTimeout(() => { dirBtn.textContent = orig; }, 1600);
    });
  }

  refresh();
  pollTimer = setInterval(refresh, 2000);
});
