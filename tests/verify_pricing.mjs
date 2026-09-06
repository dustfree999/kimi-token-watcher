/* ============================================================
   定价回归验证（node tests/verify_pricing.mjs）
   用例来自真实 data.db 中出现过的模型 id，断言其目录命中价格。
   运行：node tests/verify_pricing.mjs
   ============================================================ */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 浏览器环境 stub：data.js 依赖 localStorage */
const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
global.window = global;

/* 载入被测代码：经典 script 共享全局作用域，合并同一函数体（目录 → data.js） */
const combined =
  fs.readFileSync(path.join(root, "js/pricing-catalog.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(root, "js/data.js"), "utf8") + "\n" +
  "\n; return { catalogPriceOf, getCatalog, PRICING_CATALOG };";
const { catalogPriceOf, getCatalog } = new Function(combined)();

/* 期望值（元/百万 tokens，USD × 7.2）：来自 models.dev api.json 官方价 */
const K3 = { miss: 21.6, cache: 2.16, cwrite: 0, out: 108 };            // moonshotai/kimi-k3 $3/$0.3/$15
const K27CODE = { miss: 6.84, cache: 1.368, cwrite: 0, out: 28.8 };     // moonshotai/kimi-k2.7-code
const K27HS = { miss: 13.68, cache: 2.736, cwrite: 0, out: 57.6 };      // kimi-k2.7-code-highspeed
const LUNA = { miss: 1.44, cache: 0.144, cwrite: 1.8, out: 8.64 };      // openai/gpt-5.6-luna
const DSFLASH = { miss: 1.008, cache: 0.0202, cwrite: 0, out: 2.016 };  // deepseek/deepseek-v4-flash
const MIMO = { miss: 1.008, cache: 0.0202, cwrite: 0, out: 2.016 };     // xiaomi/mimo-v2.5
const GLM52 = { miss: 7.92, cache: 1.98, cwrite: 0, out: 27.7272 };     // alibaba-cn/glm-5.2

const CASES = [
  // [模型 id, 期望价格 | null=不得命中（应交给手动/默认价）]
  ["kimi-code/k3-256k", K3],                    // 订阅条目按 kimi-k3 API 价折算，不得为 0
  ["kimi-code/k3", K3],                         // 不得落 DeepSeek 默认价
  ["kimi-for-coding/kimi-for-coding", K27CODE], // 订阅折算
  ["kimi-for-coding/kimi-for-coding-highspeed", K27HS],
  ["opencode-go-resp/gpt-5.6-luna", LUNA],      // 不得被 openai/gpt-5 吸附
  ["opencode-go/gpt-5.6-luna", LUNA],
  ["Sub2API/deepseek/deepseek-v4-flash", DSFLASH], // 渠道提示命中官方 deepseek 条目（缓存价 0.0028，非网关旧价 0.028）
  ["火山codingplan/DeepSeek-V4-Flash", { miss: 1.008, cache: 0.2016, cwrite: 0, out: 2.016 }], // 无渠道提示 → 众数价（多数渠道一致）
  ["deepseek/deepseek-v4-flash", DSFLASH],
  ["opencode-go/mimo-v2.5", MIMO],              // xiaomi/mimo-v2.5（旧目录缺失）
  ["newapi/cline-free/glm-5.2", { miss: 10.08, cache: 1.872, cwrite: 0, out: 31.68 }], // 目录众数价（多数渠道一致）
  ["agentrouter-anthropic/claude-opus-5", { miss: 36, cache: 3.6, cwrite: 45, out: 180 }], // cache_write 6.25×7.2=45；众数价压过 abacus 缺 cache 的异常条目
  // glm-5.3 系：新目录已收录官方条目，应命中 glm-5.3 众数价而非吸附 glm-5
  ["Sub2API/z-ai/glm-5.3-flash", { miss: 1.08, cache: 0.216, cwrite: 0, out: 3.6 }],
  ["火山codingplan/GLM-5.3", { miss: 10.08, cache: 1.872, cwrite: 0, out: 31.68 }],
];

let fail = 0;
for (const [id, want] of CASES) {
  const got = catalogPriceOf(id);
  let pass;
  if (want === null) pass = got === null;
  else pass = !!got && ["miss", "cache", "cwrite", "out"].every(k => Math.abs((got[k] || 0) - want[k]) < 0.01);
  if (!pass) fail++;
  console.log(`${pass ? "PASS" : "FAIL"} | ${id}`);
  console.log(`       期望 ${want === null ? "null（不命中）" : JSON.stringify(want)}`);
  console.log(`       实际 ${got ? JSON.stringify(got) : "null"}`);
}
/* 目录健康检查：全目录不得有全零价条目 */
const cat = getCatalog();
const zero = Object.entries(cat.models).filter(([, m]) => !m.miss && !m.cache && !m.cwrite && !m.out);
if (zero.length) fail++;
console.log(`${zero.length ? "FAIL" : "PASS"} | 目录无全零价条目${zero.length ? "：\n       " + zero.map(([k]) => k).join("\n       ") : ""}`);
/* 目录必须含 cache_write 字段（抽样 claude-opus-5） */
const opus = cat.models["anthropic/claude-opus-5"];
const hasCw = opus && opus.cwrite > 0;
if (!hasCw) fail++;
console.log(`${hasCw ? "PASS" : "FAIL"} | 目录含 cache_write（claude-opus-5.cwrite=${opus && opus.cwrite}）`);

console.log(fail === 0 ? "\n=== 全部通过 ===" : `\n=== ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
