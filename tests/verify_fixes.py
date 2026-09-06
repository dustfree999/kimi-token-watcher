#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复清单回归验证脚本（临时，验证后可删）。
覆盖：
  T1  gen_demo 演示数据走完整聚合路径：日级 hourly 含 cacheWrite 且数值正确；
      failed 事件（fails 缓冲）含 hour。
  T2  手工最小事件：外部源（zcode）槽 hourly 的 cacheWrite；旧存档缺键 .get
      兜底；外部源 by_source 模型槽无死字段 hourly；外部源 failed 含 hour。
  T3  dsh 按文件粒度判定回放：新文件首见不推实时事件流；已入水位文件按实时
      事件处理；聚合计数幂等。
  T4  zcode rowid 重置守卫（水位远大于表内 MAX(rowid) 时全量回放不丢行）；
      error 分支 scope 按 query_source 判定（subagent）。
  T5  server.sum_days 对缺键旧存档 .get 兜底；/api/events?scope=failed 映射
      出的条目含 hour。

安全：不启动真实服务；state.DB_FILE 指向临时目录，绝不读写生产 data.db。
用法：python tests/verify_fixes.py
"""
import datetime
import glob
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="kimi_fix_verify_")
PASS = 0
FAIL = 0


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name}  {extra}")


import state  # noqa: E402
state.DB_FILE = os.path.join(TMP, "state.db")  # 防误写生产 data.db
import aggregate  # noqa: E402
import collector  # noqa: E402
import server  # noqa: E402
import collector_dsh  # noqa: E402
import collector_zcode  # noqa: E402


def t1_demo_kimi_aggregation():
    print("\n== T1: gen_demo 数据走聚合路径（日级 hourly cacheWrite / fails hour）==")
    sessions = os.path.join(TMP, "sessions")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tests", "gen_demo.py"), sessions],
                       capture_output=True, text=True, cwd=ROOT)
    check("T1 gen_demo.py 运行成功", r.returncode == 0, r.stderr[-500:])
    state.SESSION_ROOT = sessions
    collector.scan_once()

    # 独立解析 wire.jsonl，按 (date, hour) 汇总 inputCacheCreation 作期望值
    expect = {}
    total_usages = 0
    for path in glob.glob(os.path.join(sessions, "*", "*", "agents", "*", "wire.jsonl")):
        with open(path, encoding="utf-8") as fh:
            for ln in fh:
                ln = ln.strip()
                if not ln:
                    continue
                obj = json.loads(ln)
                if obj.get("type") != "usage.record":
                    continue
                if obj.get("usageScope") == "session":
                    continue
                us = obj.get("usage") or {}
                ts = obj.get("time")
                if not ts:
                    continue
                key = (aggregate.day_of(ts), str(aggregate.hour_of(ts)))
                e = expect.setdefault(key, {"creation": 0, "other": 0, "calls": 0})
                e["creation"] += us.get("inputCacheCreation") or 0
                e["other"] += us.get("inputOther") or 0
                e["calls"] += 1
                total_usages += 1

    check("T1 演示数据非空（usage.record >= 20）", total_usages >= 20, str(total_usages))
    days = state.STATE["days"]
    check("T1 聚合产生多个日槽", len(days) >= 3, str(sorted(days)))
    any_write = False
    for (date, h), exp in expect.items():
        slot = days.get(date)
        check(f"T1 {date} {h}:00 日槽存在", slot is not None)
        if slot is None:
            continue
        hh = (slot.get("hourly") or {}).get(h)
        check(f"T1 {date} {h}:00 hourly 条目存在", hh is not None)
        if hh is None:
            continue
        check(f"T1 {date} {h}:00 hourly 含 cacheWrite 键", "cacheWrite" in hh, repr(hh))
        check(f"T1 {date} {h}:00 cacheWrite 数值正确",
              hh.get("cacheWrite") == exp["creation"],
              f"got {hh.get('cacheWrite')} expect {exp['creation']}")
        if exp["creation"] > 0:
            any_write = True
    check("T1 至少一个小时的 cacheWrite > 0", any_write)

    # 所有日级 hourly 条目（含本无写入的小时）都必须带 cacheWrite 键
    all_have = all("cacheWrite" in hh for slot in days.values()
                   for hh in (slot.get("hourly") or {}).values())
    check("T1 全部日级 hourly 条目带 cacheWrite", all_have)

    fails = state.STATE["fails"]
    check("T1 fails 缓冲非空（演示数据含失败回合）", len(fails) > 0, str(len(fails)))
    for f in fails:
        check(f"T1 fails 条目含 int hour（{f.get('session')}）",
              isinstance(f.get("hour"), int) and 0 <= f["hour"] <= 23,
              repr(f.get("hour")))


def t2_ext_slots_and_old_archive():
    print("\n== T2: 外部源槽 cacheWrite / 旧存档 .get 兜底 / 死字段删除 ==")
    # 模拟旧存档：hourly 条目无 cacheWrite 键（用过去日期，day_of 对未来时间戳
    # 会按时钟偏差归拢到今天）
    state.STATE["days"]["2001-01-01"] = {
        "date": "2001-01-01", "inputOther": 0, "inputCacheRead": 0,
        "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
        "failed": 0, "by_model": {}, "by_session": {}, "by_scope": {},
        "by_source": {}, "hourly": {"5": {"input": 1, "cached": 2, "output": 3,
                                          "calls": 1, "requests": 0}},
    }
    ts5 = int(datetime.datetime(2001, 1, 1, 5, 30).timestamp() * 1000)
    aggregate.apply_record({
        "time": ts5, "session_id": "zcode:s1", "model": "zm1", "scope": "main",
        "source": "zcode", "src": "zcode:77", "replay": True,
        "usage": {"inputOther": 10, "inputCacheRead": 20,
                  "inputCacheCreation": 30, "output": 5},
    })
    aggregate.apply_record({
        "time": ts5, "session_id": "sess_k1", "model": "km1", "scope": "main",
        "src": "wirex",
        "usage": {"inputOther": 4, "inputCacheRead": 6,
                  "inputCacheCreation": 25, "output": 7},
    })
    day = state.STATE["days"]["2001-01-01"]
    zs = day["by_source"]["zcode"]
    check("T2 外部源槽 hourly.cacheWrite == 30",
          zs["hourly"]["5"].get("cacheWrite") == 30, repr(zs["hourly"]["5"]))
    check("T2 外部源槽顶层 inputCacheCreation == 30", zs.get("inputCacheCreation") == 30)
    check("T2 外部源槽顶层 inputOther/inputCacheRead/output 累加",
          zs.get("inputOther") == 10 and zs.get("inputCacheRead") == 20
          and zs.get("output") == 5 and zs.get("calls") == 1)
    k5 = day["hourly"]["5"]
    check("T2 旧格式 hourly 条目 .get 兜底：cacheWrite == 25",
          k5.get("cacheWrite") == 25, repr(k5))
    check("T2 旧格式条目原有计数仍累加（input 1+4、calls 1+1）",
          k5.get("input") == 5 and k5.get("calls") == 2, repr(k5))
    check("T2 外部源模型槽无死字段 hourly",
          "hourly" not in zs["by_model"]["zm1"], repr(zs["by_model"]["zm1"]))
    check("T2 kimi 模型槽 hourly 仍由 _model_hour_slot 按需填充",
          isinstance(day["by_model"]["km1"].get("hourly", {}).get("5"), dict))

    # 外部源 failed 事件含 hour（recent 与 fails 缓冲同源）
    aggregate.apply_turn_end({
        "reason": "failed", "time": ts5, "session_id": "dsh:s2", "source": "dsh",
        "turnId": "t1", "model": "dm1", "scope": "main", "replay": False,
        "error": {"code": "x", "message": "boom"}, "src": "dsh",
    })
    last = state.STATE["fails"][-1]
    check("T2 外部源 fails 条目含 hour == 5", last.get("hour") == 5, repr(last))
    check("T2 外部源 fails 条目含 scope/source/err_code",
          last.get("source") == "dsh" and last.get("err_code") == "x")


def t3_dsh_per_file_replay():
    print("\n== T3: dsh 按文件粒度判定回放 ==")
    dsh_dir = os.path.join(TMP, "dsh")
    os.makedirs(dsh_dir, exist_ok=True)

    def mk_session(sid):
        return json.dumps({"type": "session", "id": sid,
                           "createdAt": int(time.time() * 1000)})

    def mk_msg(sid, idx, extra_creation=0):
        msg = {"type": "assistant/message", "time": time.time(),
               "data": {"message": {"id": "msg-%s-%d" % (sid, idx),
                                    "source": {"model": "dm"}},
                        "usage": {"inputTokens": 100, "outputTokens": 50}}}
        if extra_creation:
            msg["data"]["usage"]["cacheCreationInputTokens"] = extra_creation
        return json.dumps(msg)

    files = {
        "A": {"lines": [mk_session("sa"), mk_msg("sa", 1), mk_msg("sa", 2)],
              "mtime": 1000.0, "size": 100},
    }

    def fake_iter():
        for name in sorted(files):
            p = os.path.join(dsh_dir, name + ".jsonl.zstd")
            yield p, files[name]["mtime"], files[name]["size"]

    def fake_read(path):
        name = os.path.basename(path)[:-len(".jsonl.zstd")]
        for line in files[name]["lines"]:
            yield line

    collector_dsh.DSH_DIR = dsh_dir
    collector_dsh.HAS_ZSTD = True
    collector_dsh._iter_session_files = fake_iter
    collector_dsh._read_lines = fake_read

    now_ms = int(time.time() * 1000)
    dkey = aggregate.day_of(now_ms)
    hkey = str(aggregate.hour_of(now_ms))

    before = len(state.STATE["recent"])
    collector_dsh.scan_once()
    zs = state.STATE["days"][dkey]["by_source"]["dsh"]
    check("T3 首扫：dsh 槽 calls == 2", zs.get("calls") == 2, repr(zs.get("calls")))
    recent = [e for e in state.STATE["recent"][before:] if e.get("source") == "dsh"]
    check("T3 首扫（文件首次出现）：历史回放不推实时事件流", len(recent) == 0, str(len(recent)))
    check("T3 首扫 hourly cacheWrite 存在且为 0（无 creation）",
          zs["hourly"][hkey].get("cacheWrite") == 0, repr(zs["hourly"][hkey]))

    # A 追加一行（mtime/size 变化，已入水位→按增量）；新增文件 B（未入水位→回放）
    files["A"]["lines"].append(mk_msg("sa", 3, extra_creation=40))
    files["A"]["mtime"] += 1
    files["A"]["size"] += 200
    files["B"] = {"lines": [mk_session("sb"), mk_msg("sb", 1), mk_msg("sb", 2)],
                  "mtime": 2000.0, "size": 200}
    before = len(state.STATE["recent"])
    collector_dsh.scan_once()
    zs = state.STATE["days"][dkey]["by_source"]["dsh"]
    check("T3 二次扫描：A 累计 3 条 + B 计 2 条 == 5（去重幂等）",
          zs.get("calls") == 5, str(zs.get("calls")))
    check("T3 二次扫描 hourly cacheWrite == 40（A 新行 creation 计入）",
          zs["hourly"][hkey].get("cacheWrite") == 40, repr(zs["hourly"][hkey]))
    recent = [e for e in state.STATE["recent"][before:] if e.get("source") == "dsh"]
    check("T3 已入水位文件按实时事件推流：仅新行 msg3 计 1 条（旧行去重提前返回不重复推流）",
          len(recent) == 1 and recent[0].get("session") == "dsh:sa",
          str([e.get("session") for e in recent]))
    check("T3 新文件 B 首见视为历史回放：无任何 B 事件",
          all(e.get("session") != "dsh:sb" for e in recent))

    # 再对 A 追加一行：应仍只有 1 条新事件（增量语义稳定，旧行永不重复推流）
    files["A"]["lines"].append(mk_msg("sa", 4))
    files["A"]["mtime"] += 1
    files["A"]["size"] += 200
    before = len(state.STATE["recent"])
    collector_dsh.scan_once()
    recent = [e for e in state.STATE["recent"][before:] if e.get("source") == "dsh"]
    check("T3 三次扫描：A 再追加 1 行 → 仅 1 条新事件", len(recent) == 1 and
          recent[0].get("session") == "dsh:sa", str([e.get("session") for e in recent]))
    zs = state.STATE["days"][dkey]["by_source"]["dsh"]
    check("T3 三次扫描聚合幂等：calls == 6、cacheWrite 仍为 40",
          zs.get("calls") == 6 and zs["hourly"][hkey].get("cacheWrite") == 40,
          f"calls={zs.get('calls')} cw={zs['hourly'][hkey].get('cacheWrite')}")


def t4_zcode_rowid_guard_and_scope():
    print("\n== T4: zcode rowid 重置守卫 / 失败回合 scope ==")
    db = os.path.join(TMP, "zcode.sqlite")
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE model_usage (rowid INTEGER PRIMARY KEY AUTOINCREMENT, "
                "status TEXT, session_id TEXT, model_id TEXT, input_tokens INTEGER, "
                "output_tokens INTEGER, cache_creation_input_tokens INTEGER, "
                "cache_read_input_tokens INTEGER, started_at INTEGER, completed_at INTEGER, "
                "turn_id TEXT, logical_request_id TEXT, error_type TEXT, error_code TEXT, "
                "error_message TEXT, query_source TEXT, assistant_message_id TEXT, "
                "parent_user_message_id TEXT)")
    con.execute("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, "
                "time_created INTEGER)")
    ts = int(time.time() * 1000)

    def ins(status, qsrc, turn_id=None, req_id=None, ecode="", emsg=""):
        con.execute(
            "INSERT INTO model_usage (status, session_id, model_id, input_tokens, "
            "output_tokens, cache_creation_input_tokens, cache_read_input_tokens, "
            "started_at, completed_at, turn_id, logical_request_id, error_type, "
            "error_code, error_message, query_source) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (status, "sid1", "zm", 100, 200, 30, 40, ts, ts, turn_id, req_id,
             "", ecode, emsg, qsrc))

    ins("completed", "main")
    ins("completed", "main")
    con.commit()
    con.close()

    collector_zcode.DB_PATH = db
    state.STATE["ext_state"]["zcode_last_rowid"] = 50  # 模拟表被重建且水位未重置
    dkey = aggregate.day_of(ts)
    hkey = str(aggregate.hour_of(ts))
    before = len(state.STATE["recent"])
    collector_zcode.scan_once()
    zs = state.STATE["days"][dkey]["by_source"]["zcode"]
    check("T4a 表重建守卫：水位重置后全量回放 2 行", zs.get("calls") == 2, repr(zs.get("calls")))
    check("T4b 守卫重置触发 first_batch 回放：不推实时事件流",
          len([e for e in state.STATE["recent"][before:] if e.get("source") == "zcode"]) == 0)
    check("T4c 外部源 hourly cacheWrite == 60（2 行 × 30）",
          zs["hourly"][hkey].get("cacheWrite") == 60, repr(zs["hourly"][hkey]))
    check("T4c2 外部源 hourly cached == 80（2 行 × 40）",
          zs["hourly"][hkey].get("cached") == 80)

    # 增量新增：error 行（query_source=subagent）+ completed 行（subagent）
    con = sqlite3.connect(db)
    ins("error", "subagent", turn_id="turn-abc", ecode="boom", emsg="msg")
    ins("completed", "subagent")
    con.commit()
    con.close()

    before = len(state.STATE["recent"])
    collector_zcode.scan_once()
    events = [e for e in state.STATE["recent"][before:] if e.get("source") == "zcode"]
    failed_ev = [e for e in events if e.get("kind") == "failed"]
    check("T4d 失败回合 scope=subagent（与 completed 分支同口径）",
          len(failed_ev) == 1 and failed_ev[0].get("scope") == "subagent",
          repr(failed_ev))
    check("T4e 失败回合事件含 hour", failed_ev and failed_ev[0].get("hour") == aggregate.hour_of(ts),
          repr(failed_ev and failed_ev[0].get("hour")))
    usage_ev = [e for e in events if e.get("kind") == "usage"]
    check("T4f completed 行 scope=subagent",
          usage_ev and usage_ev[0].get("scope") == "subagent", repr(usage_ev))
    check("T4g fails 缓冲最新条目含 hour",
          isinstance(state.STATE["fails"][-1].get("hour"), int))
    check("T4h 水位推进到 4",
          state.STATE["ext_state"].get("zcode_last_rowid") == 4,
          repr(state.STATE["ext_state"].get("zcode_last_rowid")))


def t5_server_aggregation_compat():
    print("\n== T5: server sum_days .get 兜底 / failed 池 hour ==")
    # sum_days 是 build_response 的内部闭包（周/月汇总），构造近 7 天缺键旧存档
    # 覆盖该路径：旧存档只含 date 键，缺全部计数键。
    now = datetime.datetime.now()
    week_dates = [(now - datetime.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    state.STATE["days"] = {d: {"date": d} for d in week_dates}
    resp = server.build_response()
    check("T5a 缺键旧存档下 week 汇总 .get 兜底不抛异常",
          resp["week"]["calls"] == 0 and resp["week"]["requests"] == 0
          and resp["week"]["inputOther"] == 0 and resp["week"]["output"] == 0
          and resp["week"]["days"] == 7, repr(resp["week"]))
    month_days = sum(1 for d in week_dates if d.startswith(now.strftime("%Y-%m")))
    check("T5a2 month 汇总同样兜底", resp["month"]["calls"] == 0
          and resp["month"]["days"] == month_days, repr(resp["month"]))

    resp = server.build_events("/api/events?scope=failed&from=2000-01-01&to=2010-12-31")
    failed_items = resp["items"]
    check("T5b failed 映射条目均带 hour 键（缺失时 None）",
          len(failed_items) > 0
          and all("hour" in e for e in failed_items), repr(failed_items[:1]))
    check("T5c T2 的失败条目 hour == 5 经映射后原样保留",
          any(e.get("hour") == 5 for e in failed_items), repr(failed_items[:2]))


def main():
    try:
        t1_demo_kimi_aggregation()
        t2_ext_slots_and_old_archive()
        t3_dsh_per_file_replay()
        t4_zcode_rowid_guard_and_scope()
        t5_server_aggregation_compat()
    finally:
        pass
    print()
    print(f"结果：{PASS} 通过，{FAIL} 失败")
    print("临时目录（未清理，供排查）：", TMP)
    print("注意：未触碰生产 data.db（state.DB_FILE 已指向临时库）")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()