/* ============================================================
   Kimi Code Token 监控 · 通用图表工具（独立模块）
   堆叠柱状图 / 单色柱图 / 折线面积图 / 环形图
   对外暴露 window.Charts = { stackedChart, barChart, lineChart, donutChart }
   依赖 js/utils.js 全局：esc、fmtTok、fmt
   ============================================================ */
window.Charts = (function () {

  const SEG_COLORS = ["var(--in)", "var(--cache)", "var(--out)", "var(--req)", "var(--cwrite)"];
  const SEG_LABELS = ["输入", "缓存命中", "输出", "请求", "缓存写"];

  /** 堆叠柱状图：buckets=[{label, v:[n...]}]，axisEl 写刻度 */
  function stackedChart(container, axisEl, buckets) {
    if (!container) return;
    let max = 1;
    for (const b of buckets) {
      const t = b.v.reduce((a, x) => a + (x || 0), 0);
      if (t > max) max = t;
    }
    container.innerHTML = "";
    for (const b of buckets) {
      const col = document.createElement("div");
      col.className = "col";
      let has = false;
      for (let i = 0; i < b.v.length; i++) {
        const v = b.v[i] || 0;
        if (v <= 0) continue;
        has = true;
        const seg = document.createElement("div");
        seg.className = "seg";
        seg.style.background = SEG_COLORS[i % SEG_COLORS.length];
        seg.style.height = Math.max((v / max) * 100, 1.5) + "%";
        col.appendChild(seg);
      }
      if (!has) {
        const seg = document.createElement("div");
        seg.className = "seg";
        seg.style.background = "var(--panel-2)";
        seg.style.height = "2%";
        col.appendChild(seg);
      }
      const tip = document.createElement("div");
      tip.className = "tip";
      tip.innerHTML = `<div class="t">${esc(b.label)}</div>` +
        SEG_LABELS.map((l, i) => (b.v[i] ? l + " " + fmtTok(b.v[i]) + "<br>" : "")).join("") +
        `<span style="color:var(--muted)">总计 ${fmtTok(b.v.reduce((a, x) => a + (x || 0), 0))}</span>`;
      col.appendChild(tip);
      container.appendChild(col);
    }
    if (axisEl) {
      // 轴刻度：约 5 个点
      axisEl.innerHTML = "";
      const n = buckets.length;
      if (n) {
        const idxs = [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1];
        [...new Set(idxs)].forEach(i => {
          const s = document.createElement("span");
          s.textContent = buckets[i].label;
          axisEl.appendChild(s);
        });
      }
    }
  }

  /** 单色柱图（历史趋势）：buckets=[{label,v}] */
  function barChart(container, buckets) {
    if (!container) return;
    let max = 1;
    for (const b of buckets) if (b.v > max) max = b.v;
    container.innerHTML = "";
    for (const b of buckets) {
      const col = document.createElement("div");
      col.className = "col";
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.background = "var(--accent)";
      seg.style.height = Math.max((b.v / max) * 100, b.v > 0 ? 2 : 0.6) + "%";
      if (b.v <= 0) seg.style.opacity = ".2";
      col.appendChild(seg);
      const tip = document.createElement("div");
      tip.className = "tip";
      tip.innerHTML = `<div class="t">${esc(b.label)}</div>${fmtTok(b.v)} tokens`;
      col.appendChild(tip);
      container.appendChild(col);
    }
  }

  /** line/area chart: buckets=[{label, v}] (CNY) */
  function lineChart(container, buckets) {
    if (!container) return;
    const n = buckets.length;
    const maxRaw = Math.max(...buckets.map(b => b.v), 1);
    // nice Y-axis step and max
    const roughStep = maxRaw / 4;
    const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const norm = roughStep / pow10;
    let step = norm <= 1 ? pow10 : norm <= 2 ? 2 * pow10 : norm <= 5 ? 5 * pow10 : 10 * pow10;
    if (step <= 0) step = 1;
    const yMax = Math.ceil(maxRaw / step) * step;
    container.innerHTML = "";
    container.style.position = "relative";
    container.style.paddingLeft = "42px";
    // Y-axis labels
    for (let y = 0; y <= yMax + 1e-9; y += step) {
      const yPct = 95 - (y / yMax) * 86;
      const label = document.createElement("div");
      label.className = "y-axis-label";
      label.textContent = "¥" + (y >= 100 ? Math.round(y) : y.toFixed(1));
      label.style.top = yPct + "%";
      container.appendChild(label);
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "position:absolute;left:42px;right:0;top:0;bottom:0;width:calc(100% - 42px);height:100%;pointer-events:none";
    // horizontal grid lines
    for (let y = 0; y <= yMax + 1e-9; y += step) {
      const yPct = 95 - (y / yMax) * 86;
      const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
      grid.setAttribute("x1", "0"); grid.setAttribute("x2", "100");
      grid.setAttribute("y1", yPct.toFixed(2)); grid.setAttribute("y2", yPct.toFixed(2));
      grid.setAttribute("stroke", "var(--line)");
      grid.setAttribute("stroke-width", "0.5");
      grid.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(grid);
    }
    const pts = buckets.map((b, i) => ({
      x: ((i + 0.5) / n) * 100,
      y: 95 - (b.v / yMax) * 86,
      b,
    }));
    const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    area.setAttribute("points", "0,100 " + pts.map(p => p.x.toFixed(2) + "," + p.y.toFixed(2)).join(" ") + " 100,100");
    area.setAttribute("class", "area-path");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts.map(p => p.x.toFixed(2) + "," + p.y.toFixed(2)).join(" "));
    line.setAttribute("class", "area-line");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(area);
    svg.appendChild(line);
    container.appendChild(svg);
    for (const p of pts) {
      const d = document.createElement("div");
      d.style.cssText = "position:absolute;left:calc(42px + (100% - 42px) * " + (p.x / 100).toFixed(4) + ");top:" + p.y.toFixed(2) + "%;transform:translate(-50%,-50%);width:6px;height:6px;border-radius:50%;background:var(--accent);cursor:default;pointer-events:auto";
      const tip = document.createElement("div");
      tip.className = "tip";
      tip.style.cssText = "display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:11px;white-space:nowrap;z-index:12";
      tip.innerHTML = `<div class="t">${esc(p.b.label)}</div>¥${fmt.format(Math.round(p.b.v * 100) / 100)}`;
      d.appendChild(tip);
      d.addEventListener("mouseenter", () => { tip.style.display = "block"; });
      d.addEventListener("mouseleave", () => { tip.style.display = "none"; });
      container.appendChild(d);
    }
  }

  function arcPath(cx, cy, rIn, rOut, startAngle, endAngle) {
    const toRad = a => (a - 90) * Math.PI / 180;
    const x1 = cx + rOut * Math.cos(toRad(startAngle));
    const y1 = cy + rOut * Math.sin(toRad(startAngle));
    const x2 = cx + rOut * Math.cos(toRad(endAngle));
    const y2 = cy + rOut * Math.sin(toRad(endAngle));
    const x3 = cx + rIn * Math.cos(toRad(endAngle));
    const y3 = cy + rIn * Math.sin(toRad(endAngle));
    const x4 = cx + rIn * Math.cos(toRad(startAngle));
    const y4 = cy + rIn * Math.sin(toRad(startAngle));
    const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOut} ${rOut} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${rIn} ${rIn} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z`;
  }

  /** 环形图：entries=[{label,value,color}]，支持扇区 hover 提示 */
  function donutChart(donutEl, legendEl, centerEl, entries, centerText) {
    if (!donutEl) return;
    const total = entries.reduce((a, e) => a + Math.max(e.value, 0), 0);
    if (centerEl) centerEl.textContent = centerText ? centerText(total) : fmtTok(total);
    // 保留中心文字元素
    const centerDiv = donutEl.querySelector(".donut-center");
    donutEl.innerHTML = "";
    donutEl.style.background = "transparent";
    if (!total) {
      donutEl.style.background = "var(--bg)";
      if (legendEl) legendEl.innerHTML = '<span class="muted">暂无数据</span>';
      if (centerDiv) donutEl.appendChild(centerDiv);
      return;
    }
    // 全局共享 tooltip：附加到 body，避免被 donut overflow:hidden 截断
    let tip = donutEl._donutTip;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "tip donut-tip";
      tip.style.cssText = "display:none;position:fixed;background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:11px;white-space:nowrap;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:none;";
      document.body.appendChild(tip);
      donutEl._donutTip = tip;
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    let accAngle = 0;
    const valid = entries.filter(e => e.value > 0);
    for (const e of valid) {
      const pct = (e.value / total) * 100;
      const angle = (e.value / total) * 360;
      const endAngle = accAngle + angle;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", arcPath(50, 50, 33, 48, accAngle, endAngle));
      path.setAttribute("fill", e.color);
      path.setAttribute("stroke", "var(--panel)");
      path.setAttribute("stroke-width", "0.5");
      path.style.cursor = "default";
      path.style.transition = "opacity .15s";
      // 扇区中心角度，用于 tooltip 定位
      const midAngle = accAngle + angle / 2;
      const toRad = a => (a - 90) * Math.PI / 180;
      const r = (33 + 48) / 2;
      // 给扇区加一个更大的透明热区，方便悬浮小扇区
      const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      hitPath.setAttribute("d", arcPath(50, 50, 26, 55, accAngle, endAngle));
      hitPath.setAttribute("fill", "transparent");
      hitPath.style.cursor = "default";
      const show = () => {
        const rect = donutEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const px = (r / 100) * rect.width;
        const py = (r / 100) * rect.height;
        const x = cx + px * Math.cos(toRad(midAngle));
        const y = cy + py * Math.sin(toRad(midAngle));
        tip.innerHTML = `<div class="t">${esc(e.label)}</div>¥${fmt.format(Math.round(e.value * 100) / 100)} (${pct.toFixed(1)}%)`;
        tip.style.display = "block";
        tip.style.left = (x - tip.offsetWidth / 2) + "px";
        tip.style.top = (y - tip.offsetHeight - 8) + "px";
        path.style.opacity = "0.82";
      };
      const hide = () => { tip.style.display = "none"; path.style.opacity = "1"; };
      path.addEventListener("mouseenter", show);
      path.addEventListener("mouseleave", hide);
      hitPath.addEventListener("mouseenter", show);
      hitPath.addEventListener("mouseleave", hide);
      svg.appendChild(path);
      svg.appendChild(hitPath);
      accAngle = endAngle;
    }
    donutEl.appendChild(svg);
    if (centerDiv) donutEl.appendChild(centerDiv);
    // 图例
    if (legendEl) {
      const rows = valid.map(e => {
        const pct = (e.value / total) * 100;
        return `<div class="dl-row"><span class="dl-swatch" style="background:${e.color}"></span>` +
          `<span class="dl-name" title="${esc(e.label)}">${esc(e.label)}</span>` +
          `<span class="dl-num">${e.text != null ? e.text + " (" + pct.toFixed(1) + "%)" : fmtTok(e.value) + " (" + pct.toFixed(1) + "%)"}</span></div>`;
      });
      legendEl.innerHTML = rows.join("");
    }
  }

  return {
    stackedChart,
    barChart,
    lineChart,
    donutChart,
  };
})();
