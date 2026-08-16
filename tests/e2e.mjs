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

// 3. 设置页：CSV 导出按钮（位于「数据管理」面板）
await page.click('.nav-item[data-view="settings"]');
await page.waitForTimeout(800);
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
const setInfo = await page.evaluate(() => ({
  pmRows: !!document.getElementById("pm-rows"),
  pmAdd: !!document.getElementById("pm-add"),
  pmModels: !!document.getElementById("pm-models"),
  alEnabled: !!document.getElementById("al-enabled"),
  alCost: !!document.getElementById("al-cost"),
  alFail: !!document.getElementById("al-fail"),
  pmRowCount: document.getElementById("pm-rows")?.children.length || 0,
}));
ok("设置页-按模型定价区块", setInfo.pmRows && setInfo.pmAdd && setInfo.pmModels, `rows=${setInfo.pmRowCount}`);
ok("设置页-告警面板控件", setInfo.alEnabled && setInfo.alCost && setInfo.alFail);

// 5b. 添加一条按模型覆盖行
if (setInfo.pmAdd) {
  await page.click("#pm-add");
  await page.waitForTimeout(300);
  const added = await page.evaluate(() => {
    const last = document.getElementById("pm-rows").lastElementChild;
    return last ? last.querySelectorAll("input").length : null;
  });
  ok("按模型定价-添加行出现输入框", added >= 2, `inputs=${added}`);
}

// 6. 告警配置保存到 localStorage
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

// 9. 控制台错误
ok("无控制台错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" ;; "));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
