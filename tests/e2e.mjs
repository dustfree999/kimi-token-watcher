/* ============================================================
   Kimi Code Token 监控 · 端到端冒烟测试（playwright 无头浏览器）
   ------------------------------------------------------------
   用法：
     1. 先启动一个临时服务（避免动 8787 上的正式实例）：
          python server.py --port 8799
     2. 运行测试：
          node tests/e2e.mjs http://127.0.0.1:8799
     省略参数则默认测 http://127.0.0.1:8787。

   依赖：playwright（项目 node_modules 或全局 npm 安装均可）。
   说明：测试在独立的浏览器上下文中运行，写入的 localStorage
         （定价/告警）只存在于临时上下文，不影响你自己的浏览器。
   ============================================================ */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { execSync } from "child_process";

/* ---------- 解析 playwright（项目内 → 全局 npm） ---------- */
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  ({ chromium } = require(path.join(globalRoot, "playwright")));
}

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

/* ---------- 先取 API 数据，让断言随真实数据走 ---------- */
const api = await (await fetch(BASE + "/api/usage")).json();
const todayKey = api.today;
const todayFailed = (api.days?.[todayKey]?.failed) || 0;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", e => consoleErrors.push("pageerror: " + e.message));

await page.goto(BASE + "/", { waitUntil: "load" });
await page.waitForFunction(() => document.getElementById("m-total")?.textContent !== "—", null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// 1. 概览页请求卡：回合数常驻，失败数仅当 API 有失败时出现
const callsSub = await page.textContent("#m-calls-sub");
const subOk = /回合数\s*[\d,.]+/.test(callsSub || "") &&
  (todayFailed === 0 ? true : /失败\s*[\d,.]+/.test(callsSub || ""));
ok("概览-请求卡回合/失败副行", subOk, JSON.stringify(callsSub) + ` (api failed=${todayFailed})`);

// 2. 模型分析页 11 列 + 失败率
await page.click('.nav-item[data-view="models"]');
await page.waitForTimeout(800);
const headInfo = await page.evaluate(() => {
  const h = document.querySelector("#mo-rows .tt-head.mot");
  if (!h) return null;
  return { cols: h.children.length, text: h.textContent, gridCols: getComputedStyle(h).gridTemplateColumns.split(" ").length };
});
ok("模型表-表头11列含失败率", !!headInfo && headInfo.cols === 11 && headInfo.text.includes("失败率"),
  headInfo ? `cols=${headInfo.cols} gridCols=${headInfo.gridCols}` : "表头不存在");
const rowInfo = await page.evaluate(() => {
  const r = document.querySelector("#mo-rows .tt-row.mot");
  return r ? { cols: r.children.length } : null;
});
ok("模型表-数据行11列", !!rowInfo && rowInfo.cols === 11, rowInfo ? `cols=${rowInfo.cols}` : "无数据行");

// 2b. 模型详情页（默认「今日」范围）：渲染不抛错、不误报连接失败
const mdOk = await page.evaluate(async () => {
  const n = document.querySelector("#mo-rows .tt-row .tt-name");
  if (!n) return { clicked: false };
  n.click();
  await new Promise(r => setTimeout(r, 800));
  const badge = document.getElementById("conn-status")?.textContent || "";
  const refresh = document.getElementById("last-refresh")?.textContent || "";
  return {
    clicked: true,
    name: document.getElementById("md-name")?.textContent || "",
    total: document.getElementById("md-total")?.textContent || "",
    failBadge: /连接失败/.test(badge),
    renderErr: /渲染异常/.test(refresh),
  };
});
ok("模型详情-默认今日范围渲染正常不误报连接失败",
  mdOk.clicked && mdOk.name && mdOk.total && !mdOk.failBadge && !mdOk.renderErr,
  JSON.stringify(mdOk));


// 3. 设置页：CSV 导出按钮（位于「数据管理」标签页）
await page.click('.nav-item[data-view="settings"]');
await page.waitForTimeout(800);
await page.click('.settings-tab[data-tab="data"]');
await page.waitForTimeout(300);
const btnD = await page.$("#export-daily-csv"), btnM = await page.$("#export-models-csv");
ok("设置页-两个导出按钮存在", !!btnD && !!btnM);
if (btnD) {
  await btnD.scrollIntoViewIfNeeded();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), btnD.click()]);
  if (dl) {
    const buf = fs.readFileSync(await dl.path());
    const hasBOM = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const head = buf.toString("utf8").replace(/^\ufeff/, "").split("\r\n")[0];
    ok("CSV按日-下载成功+BOM+表头", hasBOM && head.startsWith("日期,"), `file=${dl.suggestedFilename()}`);
  } else ok("CSV按日-下载成功+BOM+表头", false, "无 download 事件");
}
if (btnM) {
  await btnM.scrollIntoViewIfNeeded();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), btnM.click()]);
  if (dl) {
    const buf = fs.readFileSync(await dl.path());
    const head = buf.toString("utf8").replace(/^\ufeff/, "").split("\r\n")[0];
    ok("CSV按模型-下载成功+表头", head.startsWith("模型,"), `file=${dl.suggestedFilename()}`);
  } else ok("CSV按模型-下载成功+表头", false, "无 download 事件");
}

// 4. 自定义时间范围（先回概览页，概览卡片才会随 range 更新）
await page.click('.nav-item[data-view="overview"]');
await page.waitForTimeout(400);
await page.click('#range-switch button[data-range="custom"]');
await page.waitForTimeout(400);
const overlayVisible = await page.evaluate(() => !document.getElementById("custom-range-overlay").classList.contains("hidden"));
ok("自定义范围-弹窗打开", overlayVisible);
if (overlayVisible) {
  const fmt = d => d.toISOString().slice(0, 10);
  const start = new Date(Date.now() - 2 * 864e5);
  await page.fill("#cr-start", fmt(start));
  await page.fill("#cr-end", fmt(new Date()));
  await page.click("#cr-apply");
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    hidden: document.getElementById("custom-range-overlay").classList.contains("hidden"),
    activeBtn: document.querySelector("#range-switch button.active")?.dataset.range,
    mTotal: document.getElementById("m-total")?.textContent,
    mLabel: document.getElementById("m-total-label")?.textContent,
  }));
  ok("自定义范围-应用后弹窗关闭+custom激活+标签含~",
    after.hidden && after.activeBtn === "custom" && /~/.test(after.mLabel || "") && after.mTotal && after.mTotal !== "—",
    JSON.stringify(after));
  await page.click('#range-switch button[data-range="today"]');
  await page.waitForTimeout(500);
}

// 5. 设置页：按模型定价 UI + 告警面板
await page.click('.nav-item[data-view="settings"]');
await page.waitForTimeout(800);
await page.click('.settings-tab[data-tab="pricing"]');
await page.waitForTimeout(300);
const setInfo = await page.evaluate(() => ({
  pmRows: !!document.getElementById("pm-rows"),
  pmAdd: !!document.getElementById("pm-add"),
  pmSearch: !!document.getElementById("pm-search"),
  alEnabled: !!document.getElementById("al-enabled"),
  alCost: !!document.getElementById("al-cost"),
  alFail: !!document.getElementById("al-fail"),
  pmRowCount: document.getElementById("pm-rows")?.querySelectorAll("tr").length || 0,
}));
ok("设置页-按模型定价区块", setInfo.pmRows && setInfo.pmAdd && setInfo.pmSearch, `rows=${setInfo.pmRowCount}`);
ok("设置页-告警面板控件", setInfo.alEnabled && setInfo.alCost && setInfo.alFail);

// 5b. 添加一条按模型覆盖行
if (setInfo.pmAdd) {
  await page.click("#pm-add");
  await page.waitForTimeout(300);
  const added = await page.evaluate(() => {
    const rows = document.getElementById("pm-rows").querySelectorAll("tr");
    const last = rows[rows.length - 1];
    return last ? last.querySelectorAll("input").length : null;
  });
  ok("按模型定价-添加行出现输入框", added >= 2, `inputs=${added}`);
}

// 5c. 从目录填充：为数据中出现过的模型生成带预填价格的按模型定价行
const fillInfo = await page.evaluate(async () => {
  const before = document.getElementById("pm-rows").querySelectorAll("tr").length;
  document.getElementById("pm-fill").click();
  await new Promise(r => setTimeout(r, 300));
  const rows = [...document.getElementById("pm-rows").querySelectorAll("tr")].filter(r => !r.querySelector(".pm-empty"));
  const filled = rows.slice(before);
  const prefilled = filled.length > 0 && filled.every(r => {
    const ins = r.querySelectorAll("input[data-field]");
    return [...ins].every(i => i.value !== "");
  });
  const status = document.getElementById("pm-fill-status").textContent;
  return { before, after: rows.length, filled: filled.length, prefilled, status };
});
ok("从目录填充-生成预填价格行", fillInfo.filled > 0 && fillInfo.prefilled && /已填充/.test(fillInfo.status || ""),
  JSON.stringify(fillInfo));

// 5d. 只填模型名、不填价格 → 保存时跳过，不写入全 0 覆盖
const skipInfo = await page.evaluate(async () => {
  document.getElementById("pm-add").click();
  await new Promise(r => setTimeout(r, 200));
  const rows = [...document.getElementById("pm-rows").querySelectorAll("tr")].filter(r => !r.querySelector(".pm-empty"));
  const last = rows[rows.length - 1];
  last.querySelector(".pm-name").value = "__e2e_skip_model__";
  document.getElementById("set-price-save").click();
  await new Promise(r => setTimeout(r, 300));
  const saved = JSON.parse(localStorage.getItem("kimi_token_prices") || "{}");
  const m = (saved.models || {})["__e2e_skip_model__"];
  return { skipped: !m };
});
ok("按模型定价-空价格行保存跳过", skipInfo.skipped, JSON.stringify(skipInfo));

// 6. 告警配置保存到 localStorage
await page.click('.settings-tab[data-tab="alerts"]');
await page.waitForTimeout(300);
await page.check("#al-enabled");
await page.fill("#al-cost", "999");
await page.fill("#al-fail", "999");
await page.waitForTimeout(600);
const alertSaved = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("kimi_token_alerts")); } catch { return null; }
});
ok("告警-配置写入localStorage", !!alertSaved && alertSaved.enabled === true && alertSaved.costLimit === 999,
  JSON.stringify(alertSaved));

// 7. 历史统计页范围同步
await page.click('.nav-item[data-view="history"]');
await page.waitForTimeout(800);
const histSummary = await page.textContent("#history-summary").catch(() => "");
ok("历史页-摘要含范围标签", /今日|近 7 天|近 30 天|~/.test(histSummary || ""), JSON.stringify(histSummary));

// 8. 实时事件页范围同步
await page.click('.nav-item[data-view="events"]');
await page.waitForTimeout(800);
const evCount = await page.textContent("#event-count").catch(() => "");
ok("事件页-计数跟随范围标签", /今日|近 7 天|近 30 天|~/.test(evCount || ""), JSON.stringify(evCount));

// 8b. 实时事件页：失败 scope 筛选
const failBtn = await page.$("#ev-filter-scope button[data-scope='failed']");
if (failBtn) {
  await failBtn.click();
  await page.waitForTimeout(800);
  const failInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#event-rows .tt-row.evt")];
    const badges = rows.map(r => (r.querySelector(".lbl") || {}).textContent || "").filter(Boolean);
    const active = document.querySelector("#ev-filter-scope button[data-scope='failed']")?.classList.contains("active");
    const countTxt = document.getElementById("event-count")?.textContent || "";
    return { rows: rows.length, allFail: badges.length > 0 && badges.every(b => b === "失败"), active, countTxt };
  });
  ok("事件页-失败筛选只显示失败事件",
    failInfo.active && (failInfo.allFail || failInfo.rows === 0),
    JSON.stringify(failInfo));
  await failBtn.click(); // 还原
  await page.waitForTimeout(400);
} else {
  ok("事件页-失败筛选按钮存在", false, "无 #ev-filter-scope button[data-scope='failed']");
}

// 9. 控制台错误
ok("无控制台错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ;; "));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
