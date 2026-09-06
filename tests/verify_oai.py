#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""collector_oai 端到端验证（隔离环境：临时目录 + 临时 data.db，不碰真实数据）。"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

tmp = tempfile.mkdtemp(prefix="oai_test_")
log_dir = os.path.join(tmp, "logs")
os.makedirs(log_dir)

# 隔离持久化：指向临时库，绝不触碰项目真实 data.db
import state
state.DB_FILE = os.path.join(tmp, "test.db")

import collector_oai
collector_oai.OAI_LOG_DIR = log_dir

LINE_TPL = '{"ts":"%s","level":"info","tag":"%s","data":%s}\n'
# 覆盖六条 API 路径的 usage 形态 + 干扰行
lines = [
    # OpenAI chat completions：含 prompt_tokens_details.cached_tokens
    LINE_TPL % ("2026-08-22T08:00:00.000Z", "usage.report",
                json.dumps({"modelId": "glm-5.1", "usage": {
                    "prompt_tokens": 1000, "completion_tokens": 200,
                    "total_tokens": 1200,
                    "prompt_tokens_details": {"cached_tokens": 400}}})),
    # Anthropic 路径：插件已归一化，无 cached 拆分
    LINE_TPL % ("2026-08-22T08:05:00.123Z", "usage.report",
                json.dumps({"modelId": "K3", "usage": {
                    "prompt_tokens": 500, "completion_tokens": 300,
                    "total_tokens": 800}})),
    # debug 级 usage.capture：必须忽略
    LINE_TPL % ("2026-08-22T08:05:01.000Z", "usage.capture",
                json.dumps({"modelId": "K3", "usage": {
                    "prompt_tokens": 99999, "completion_tokens": 99999,
                    "total_tokens": 199998}})),
    # 非 usage 行：忽略
    LINE_TPL % ("2026-08-22T08:45:13.521Z", "models.loaded",
                json.dumps({"count": 37, "source": "config"})),
    'not a json line\n',
]
log_path = os.path.join(log_dir, "oaicopilot-20260822.log")
with open(log_path, "w", encoding="utf-8") as fh:
    fh.writelines(lines)

failures = []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name}" + (f" | {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ---- 第 1 轮扫描：首见文件 -> 历史回放 ----
collector_oai.scan_once()

day = state.STATE["days"].get("2026-08-22")
check("回放聚合计数", day is not None)
src = (day or {}).get("by_source", {}).get("oaicopilot")
check("by_source.oaicopilot 存在", src is not None)
if src:
    check("calls == 2（capture/models/坏行被滤）", src["calls"] == 2, f"got {src['calls']}")
    check("inputOther == 1100 (600+500)", src.get("inputOther") == 1100, f"got {src.get('inputOther')}")
    check("inputCacheRead == 400", src.get("inputCacheRead") == 400, f"got {src.get('inputCacheRead')}")
    check("output == 500 (200+300)", src.get("output") == 500, f"got {src.get('output')}")
m = (src or {}).get("by_model", {})
check("按模型分桶 glm-5.1/K3", set(m) == {"glm-5.1", "K3"}, f"got {set(m)}")
check("回放不进 recent", len(state.STATE["recent"]) == 0, f"got {len(state.STATE['recent'])}")
wm = state.STATE["ext_state"].get("oai_files", {}).get(log_path)
check("水位推进到文件尾", wm and wm > 0, f"got {wm}")

# ---- backfill_recent：展示层回补 ----
items, fails = collector_oai.backfill_recent(0)
check("backfill 返回 2 条", len(items) == 2, f"got {len(items)}")
check("backfill 无失败明细", fails == [])
if items:
    check("backfill 条目 source 正确",
          all(i["source"] == "oaicopilot" for i in items))
    check("backfill 时间戳解析正确",
          items[0]["time"] == int(__import__("datetime").datetime(
              2026, 8, 22, 16, 0, 0).timestamp() * 1000), f"got {items[0]['time']}")

# ---- 第 2 轮扫描：追加新行 -> 实时事件 ----
live_line = LINE_TPL % ("2026-08-22T09:30:00.000Z", "usage.report",
                        json.dumps({"modelId": "K3", "usage": {
                            "prompt_tokens": 800, "completion_tokens": 100,
                            "total_tokens": 900}}))
with open(log_path, "a", encoding="utf-8") as fh:
    fh.write(live_line)
collector_oai.scan_once()

src = state.STATE["days"]["2026-08-22"]["by_source"]["oaicopilot"]
check("增量后 calls == 3", src["calls"] == 3, f"got {src['calls']}")
recent = [r for r in state.STATE["recent"] if r.get("source") == "oaicopilot"]
check("实时事件进 recent", len(recent) == 1, f"got {len(recent)}")
if recent:
    r = recent[0]
    check("实时事件 token 正确", (r["input"], r["cached"], r["output"]) == (800, 0, 100),
          f"got {r['input']}/{r['cached']}/{r['output']}")

# ---- 截断重建：offset 重置 -> 重放被指纹去重，不重复计数 ----
with open(log_path, "w", encoding="utf-8") as fh:
    fh.write(live_line)  # 文件被截断只剩一行（模拟插件重写）
collector_oai.scan_once()
src_after = state.STATE["days"]["2026-08-22"]["by_source"]["oaicopilot"]
check("截断重放不重复计数 calls==3", src_after["calls"] == 3, f"got {src_after['calls']}")
recent2 = [r for r in state.STATE["recent"] if r.get("source") == "oaicopilot"]
check("截断重放不重复推 recent", len(recent2) == 1, f"got {len(recent2)}")

# ---- 持久化往返：save/load 后水位与聚合一致 ----
state.save_state()
saved_marks = {}
import sqlite3
with sqlite3.connect(state.DB_FILE) as conn:
    v = conn.execute("SELECT value FROM meta WHERE key='ext_state'").fetchone()
    saved_marks = json.loads(v[0]).get("oai_files", {})
check("水位随 meta 持久化", saved_marks.get(log_path) == state.STATE["ext_state"]["oai_files"][log_path],
      f"db={saved_marks}")

# ---- _ts_to_ms 边界 ----
check("_ts_to_ms Z 后缀", collector_oai._ts_to_ms("2026-08-22T08:45:13.521Z") ==
      int(__import__("datetime").datetime(2026, 8, 22, 16, 45, 13, 521000).timestamp() * 1000))
check("_ts_to_ms 7 位小数防御", isinstance(
    collector_oai._ts_to_ms("2026-08-22T08:45:13.5214567Z"), int))
check("_ts_to_ms 坏值兜底", isinstance(collector_oai._ts_to_ms("garbage"), int))

print()
if failures:
    print(f"共 {len(failures)} 项失败: {failures}")
    sys.exit(1)
print("全部通过")
