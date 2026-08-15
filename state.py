#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 实时监控 —— 共享状态与持久化
============================================
集中存放全局去重集合 SEEN_*、聚合状态 STATE、线程锁 LOCK、TRUNCATED_FLAG
与常量，以及 SQLite（data.db）的持久化逻辑。其余模块 import 本模块后通过
`from state import ...` 或 `import state` 引用同一对象（注意可变对象引用：
对集合/字典只做原地修改，不做整体替换，避免各模块引用分叉）。

存储设计（data.db，7 张表）：
    meta            小量杂项：tracked_files / session_meta / last_text /
                    recent_seq / last_scan_time / scan_errors（各 JSON 化）
    days            逐日聚合槽位（date 主键，整日槽位 JSON，含
                    by_model/by_session/by_scope/hourly 嵌套）
    recent          实时事件流（eventId 主键，细粒度列）
    seen_usage / seen_req          主去重指纹（含来源 src）
    seen_usage_g / seen_req_g      全局兜底去重指纹（不含 src）
每次操作开新连接，连接时执行 PRAGMA journal_mode=WAL 与
PRAGMA synchronous=NORMAL；save_state 在锁内单事务全量同步。
首次启动若同目录存在旧 data.json 则自动一次性迁移（见 _migrate_from_json）。

模块结构：
    state.py     本模块：STATE / LOCK / SEEN_* / 常量 + 持久化
    aggregate.py 聚合槽位与记录累加（apply_record / apply_request）
    collector.py 增量扫描解析与扫描循环
    server.py    入口 + HTTP 服务
"""

import datetime
import json
import os
import sqlite3
import threading
import time

SESSION_ROOT = os.path.expanduser("~/.kimi-code/sessions")
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.db")
# 旧版 JSON 存档路径，仅用于首次启动的一次性迁移（见 _migrate_from_json）
JSON_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
POLL_INTERVAL = 2.0

# Fork 会话会复制父会话的 wire.jsonl（含历史 usage.record），
# 用指纹去重避免同一记录被多个会话文件重复计数。三层防线：
#   a) is_fork_copy 元数据检查（第一道防线）；
#   b) 主指纹含来源 src（wire 文件绝对路径），区分不同会话/Agent 的同毫秒
#      同模型同 token 数记录，避免跨文件误去重少算；
#   c) 全局兜底集合（不含 src），仅当记录的 ts 距当前处理时刻超过 10 分钟
#      （历史回放，如 fork 复制段缺 state.json 元数据）时才查它并丢弃，
#      活并发记录被扫描时永远不超 10 分钟，不会被误杀；被计数的记录
#      同时加入全局集合。
SEEN_USAGE = set()   # (time, src, model, inputOther, output, cacheRead, cacheCreation)
SEEN_REQ = set()     # (time, src, model, turnStep)
SEEN_USAGE_G = set()  # (time, model, inputOther, output, cacheRead, cacheCreation) 全局兜底
SEEN_REQ_G = set()    # (time, model) 全局兜底

# ---------------------------------------------------------------------------
# 聚合状态
# ---------------------------------------------------------------------------
LOCK = threading.Lock()
STATE = {
    # "days": { "2026-08-14": {date, inputOther, inputCacheRead, output,
    #                          calls, by_model:{model:{...}}, by_session:{session:{...}},
    #                          hourly:{0..23:{input, output, cached, calls}}} }
    "days": {},
    "recent": [],  # 最近 usage 记录（实时事件流），最多保留 RECENT_LIMIT 条
    "recent_seq": 0,  # recent 事件流递增 eventId（服务运行期内唯一）
    "session_meta": {},  # { session_id: {title, cwd, is_custom, last_prompt} }
    "last_text": {},  # path -> {"input": str, "output": str} 最近输入/输出文本
    "last_scan_time": 0,
    "tracked_files": {},  # path -> offset (已读字节偏移)
    "scan_errors": [],
}

RECENT_LIMIT = 500

# 文件被截断/重建导致偏移重置为 0 时置位，collector 模块的 collector_loop
# 每轮开头检查并立即存档。由 collector 通过 `state.TRUNCATED_FLAG` 读写，
# 保证各模块持有同一对象（布尔值需以模块属性方式共享，而非重新赋值局部名）。
TRUNCATED_FLAG = False

# 指纹去重集合只保留最近 30 天的记录（超过的不会再被 fork 复制段触发），控制内存
SEEN_RETENTION_MS = 30 * 24 * 3600 * 1000

# 老记录回放阈值：记录的 ts 距当前处理时刻超过该时长时，仅查全局兜底集合去重
SEEN_OLD_THRESHOLD_MS = 10 * 60 * 1000

# ---------------------------------------------------------------------------
# 定价（DeepSeek 官方价，元/百万 tokens）—— 前端也可覆盖
# ---------------------------------------------------------------------------
DEFAULT_PRICES = {
    "input_miss": 1.0,      # 输入未命中 ¥1/M
    "cache_read": 0.02,     # 输入缓存命中 ¥0.02/M
    "cache_write": 0.0,     # 缓存写入 ¥0/M（默认 0，前端可覆盖配置）
    "output": 2.0,          # 输出 ¥2/M
}


def _init_db(conn):
    """建表（幂等）。列类型亲和性说明：
    - seen_* 数值列：ts 用 INTEGER、token 数用 REAL —— 内存里的整数写读后虽变
      float（223 -> 223.0），但 Python 数值相等语义（223 == 223.0 且 hash 相同）
      保证与内存指纹集合的成员判断/集合相等完全一致；
    - seen_req.turnStep 必须用 TEXT：内存中是字符串（如 "0.8"），若用 INTEGER
      会被 SQLite 亲和性转成数值（0.8 / 0），重启后指纹失配导致去重失效。"""
    conn.execute("""CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,  -- 键名：tracked_files/session_meta/last_text/
                                 --       recent_seq/last_scan_time/scan_errors
        value TEXT               -- JSON 字符串值
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS days (
        date TEXT PRIMARY KEY,   -- 日期 YYYY-MM-DD
        data TEXT                -- 当日完整聚合槽位 JSON：顶层计数 + by_model/
                                 -- by_session/by_scope/hourly 嵌套结构
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS recent (
        eventId     INTEGER PRIMARY KEY,  -- 事件流递增 id（服务运行期续接）
        time        INTEGER,              -- 事件毫秒时间戳
        date        TEXT,                 -- 所属日期 YYYY-MM-DD
        hour        TEXT,                 -- 所属小时（字符串键）
        model       TEXT,                 -- 模型名
        session     TEXT,                 -- 会话 id
        scope       TEXT,                 -- main=主智能体 / subagent=子智能体
        input       INTEGER,              -- 输入未命中 tokens
        cached      INTEGER,              -- 缓存命中 tokens
        output      INTEGER,              -- 输出 tokens
        total       INTEGER,              -- input+cached+output
        input_text  TEXT,                 -- 最近输入文本（点击行展开查看）
        output_text TEXT                  -- 最近输出文本
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_usage (
        ts INTEGER,     -- 记录时间（毫秒）
        src TEXT,       -- 来源 wire 文件绝对路径
        model TEXT,     -- 模型名
        i REAL,         -- inputOther tokens
        o REAL,         -- output tokens
        c REAL,         -- inputCacheRead tokens
        cc REAL,        -- inputCacheCreation tokens
        PRIMARY KEY (ts, src, model, i, o, c, cc)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_req (
        ts INTEGER,     -- 记录时间（毫秒）
        src TEXT,       -- 来源 wire 文件绝对路径
        model TEXT,     -- 模型名
        turnStep TEXT,  -- 会话内步号（字符串，必须 TEXT 保持指纹一致）
        PRIMARY KEY (ts, src, model, turnStep)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_usage_g (
        ts INTEGER,     -- 记录时间（毫秒）
        model TEXT,     -- 模型名
        i REAL,         -- inputOther tokens
        o REAL,         -- output tokens
        c REAL,         -- inputCacheRead tokens
        cc REAL,        -- inputCacheCreation tokens
        PRIMARY KEY (ts, model, i, o, c, cc)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_req_g (
        ts INTEGER,     -- 记录时间（毫秒）
        model TEXT,     -- 模型名
        PRIMARY KEY (ts, model)
    )""")


def _migrate_from_json(conn):
    """一次性迁移：旧 data.json -> SQLite 各表。
    成功：data.json 改名为 data.json.migrated-YYYYMMDD.bak；
    失败（JSON 损坏等）：回滚、改名 data.json.corrupt-YYYYMMDD.bak 并记录错误，
    以空状态继续（与旧版 load_state 损坏即返回空一致）。"""
    stamp = datetime.date.today().strftime("%Y%m%d")
    try:
        with open(JSON_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        conn.executemany("INSERT OR REPLACE INTO days (date, data) VALUES (?, ?)",
                         [(str(date), json.dumps(day))
                          for date, day in (data.get("days") or {}).items()])
        conn.executemany(
            "INSERT OR REPLACE INTO recent (eventId, time, date, hour, model, "
            "session, scope, input, cached, output, total, input_text, output_text) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(r.get("eventId"), r.get("time"), r.get("date"), r.get("hour"),
              r.get("model"), r.get("session"), r.get("scope"),
              r.get("input"), r.get("cached"), r.get("output"), r.get("total"),
              r.get("input_text") or "", r.get("output_text") or "")
             for r in data.get("recent") or []])
        # seen 指纹按元组长度分流：7/4 元进主集合表，其余长度（旧格式 6/2 元）
        # 进全局兜底表 —— 与旧 load_state 按长度分流进全局集合的行为一致
        for t in (tuple(x) for x in data.get("seen_usage", [])):
            if len(t) == 7:
                conn.execute("INSERT OR IGNORE INTO seen_usage "
                             "(ts, src, model, i, o, c, cc) VALUES (?,?,?,?,?,?,?)", t)
            else:
                conn.execute("INSERT OR IGNORE INTO seen_usage_g "
                             "(ts, model, i, o, c, cc) VALUES (?,?,?,?,?,?)", t)
        for t in (tuple(x) for x in data.get("seen_req", [])):
            if len(t) == 4:
                conn.execute("INSERT OR IGNORE INTO seen_req "
                             "(ts, src, model, turnStep) VALUES (?,?,?,?)", t)
            else:
                conn.execute("INSERT OR IGNORE INTO seen_req_g "
                             "(ts, model) VALUES (?,?)", t)
        for t in (tuple(x) for x in data.get("seen_usage_g", [])):
            conn.execute("INSERT OR IGNORE INTO seen_usage_g "
                         "(ts, model, i, o, c, cc) VALUES (?,?,?,?,?,?)", t)
        for t in (tuple(x) for x in data.get("seen_req_g", [])):
            conn.execute("INSERT OR IGNORE INTO seen_req_g (ts, model) VALUES (?,?)", t)
        # meta：旧 JSON 未持久化 recent_seq，取 recent 最大 eventId+1 续接
        max_eid = conn.execute(
            "SELECT COALESCE(MAX(eventId), -1) FROM recent").fetchone()[0]
        meta = {
            "tracked_files": data.get("tracked_files") or {},
            "session_meta": data.get("session_meta") or {},
            "last_text": data.get("last_text") or {},
            "recent_seq": str(int(max_eid) + 1),
            "last_scan_time": str(data.get("last_scan_time", 0)),
            "scan_errors": data.get("scan_errors") or [],
        }
        for key, value in meta.items():
            conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                         (key, json.dumps(value)))
        conn.commit()
        os.replace(JSON_FILE, JSON_FILE + f".migrated-{stamp}.bak")
    except Exception as e:
        try:
            conn.rollback()
            os.replace(JSON_FILE, JSON_FILE + f".corrupt-{stamp}.bak")
        except Exception:
            pass
        add_error(f"migrate: {e}")


def load_state():
    """从 SQLite 恢复已读偏移、已聚合的 days、去重集合（重启后保持一致性）。
    首次启动且 data.json 存在时自动一次性迁移；数据损坏等异常回退为空状态
    （与旧版 except 行为一致）。seen 指纹按列存储天然区分主/全局集合，无需分流。"""
    try:
        first_run = not os.path.exists(DB_FILE)
        with sqlite3.connect(DB_FILE) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            _init_db(conn)
            if first_run and os.path.exists(JSON_FILE):
                _migrate_from_json(conn)

            days = {date: json.loads(data) for date, data in
                    conn.execute("SELECT date, data FROM days")}
            recent = []
            for row in conn.execute(
                    "SELECT eventId, time, date, hour, model, session, scope, "
                    "input, cached, output, total, input_text, output_text "
                    "FROM recent ORDER BY eventId"):
                (eventId, tm, date, hour, model, session, scope, inp,
                 cached, out, total, input_text, output_text) = row
                recent.append({
                    "time": tm, "date": date, "hour": hour,
                    "model": model, "session": session, "scope": scope,
                    "input": inp, "cached": cached, "output": out,
                    "total": total, "eventId": eventId,
                    "input_text": input_text or "",
                    "output_text": output_text or "",
                })
            seen_usage = {tuple(r) for r in
                          conn.execute("SELECT ts, src, model, i, o, c, cc FROM seen_usage")}
            seen_req = {tuple(r) for r in
                        conn.execute("SELECT ts, src, model, turnStep FROM seen_req")}
            seen_usage_g = {tuple(r) for r in
                            conn.execute("SELECT ts, model, i, o, c, cc FROM seen_usage_g")}
            seen_req_g = {tuple(r) for r in
                          conn.execute("SELECT ts, model FROM seen_req_g")}
            meta = {}
            for key, value in conn.execute("SELECT key, value FROM meta"):
                try:
                    meta[key] = json.loads(value)
                except Exception:
                    meta[key] = None
            # meta 杂项组装回 STATE（boot_replay 未覆盖的字段在此恢复）；
            # tracked_files 同时作为 7 元组首元素返回。
            # 迁移期间 add_error 已追加的告警需保留，与存档中的 scan_errors 合并。
            saved_errors = list(STATE["scan_errors"])
            STATE["tracked_files"] = meta.get("tracked_files") or {}
            STATE["session_meta"] = meta.get("session_meta") or {}
            STATE["last_text"] = meta.get("last_text") or {}
            STATE["recent_seq"] = int(meta.get("recent_seq") or 0)
            STATE["last_scan_time"] = float(meta.get("last_scan_time") or 0)
            STATE["scan_errors"] = (saved_errors + (meta.get("scan_errors") or []))[-10:]
            return (STATE["tracked_files"], days, seen_usage, seen_req,
                    seen_usage_g, seen_req_g, recent)
    except Exception:
        return {}, {}, set(), set(), set(), set(), []


def save_state():
    """全量同步 STATE / SEEN_* 到 SQLite（单事务，with conn 自动提交/回滚）。
    内存为唯一事实来源：days/recent/seen 每次先清空再重写，天然完成裁剪；
    meta 按键覆盖。整个同步（含连接与事务）在锁内完成，避免读到采集线程的
    并发中间态。SQLite 事务本身原子，无需 tmp+os.replace。"""
    try:
        with LOCK:
            with sqlite3.connect(DB_FILE) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                _init_db(conn)
                with conn:
                    tables = (
                        ("seen_usage", SEEN_USAGE,
                         "INSERT OR REPLACE INTO seen_usage "
                         "(ts, src, model, i, o, c, cc) VALUES (?,?,?,?,?,?,?)"),
                        ("seen_req", SEEN_REQ,
                         "INSERT OR REPLACE INTO seen_req "
                         "(ts, src, model, turnStep) VALUES (?,?,?,?)"),
                        ("seen_usage_g", SEEN_USAGE_G,
                         "INSERT OR REPLACE INTO seen_usage_g "
                         "(ts, model, i, o, c, cc) VALUES (?,?,?,?,?,?)"),
                        ("seen_req_g", SEEN_REQ_G,
                         "INSERT OR REPLACE INTO seen_req_g "
                         "(ts, model) VALUES (?,?)"),
                    )
                    for name, source, sql in tables:
                        conn.execute(f"DELETE FROM {name}")
                        if source:
                            conn.executemany(sql, list(source))
                    conn.execute("DELETE FROM days")
                    conn.executemany(
                        "INSERT OR REPLACE INTO days (date, data) VALUES (?, ?)",
                        [(date, json.dumps(day))
                         for date, day in STATE["days"].items()])
                    conn.execute("DELETE FROM recent")
                    conn.executemany(
                        "INSERT OR REPLACE INTO recent (eventId, time, date, hour, model, "
                        "session, scope, input, cached, output, total, input_text, output_text) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        [(r.get("eventId"), r.get("time"), r.get("date"), r.get("hour"),
                          r.get("model"), r.get("session"), r.get("scope"),
                          r.get("input"), r.get("cached"), r.get("output"), r.get("total"),
                          r.get("input_text") or "", r.get("output_text") or "")
                         for r in STATE["recent"]])
                    meta = {
                        "tracked_files": STATE["tracked_files"],
                        "session_meta": STATE["session_meta"],
                        "last_text": STATE["last_text"],
                        "recent_seq": str(STATE["recent_seq"]),
                        "last_scan_time": str(STATE["last_scan_time"]),
                        "scan_errors": STATE["scan_errors"],
                    }
                    for key, value in meta.items():
                        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                                     (key, json.dumps(value)))
    except Exception as e:
        add_error(f"save: {e}")


def add_error(msg):
    """线程安全地追加一条采集告警。"""
    with LOCK:
        STATE["scan_errors"] = (STATE["scan_errors"] + [msg])[-10:]


def prune_seen(force=False):
    """按时间清理过期的 SEEN 指纹（主/全局集合），控制内存有界。
    用 intersection_update 原地收缩集合：保持各模块持有的 SEEN_* 引用为
    同一对象（若改为整体替换赋值，其他模块仍会看到旧集合，导致去重失效/漏存；
    且增强赋值会把集合名绑定为局部变量，需避免）。"""
    now = time.time() * 1000
    with LOCK:
        if (force or len(SEEN_USAGE) > 20000 or len(SEEN_REQ) > 20000
                or len(SEEN_USAGE_G) > 20000 or len(SEEN_REQ_G) > 20000):
            cutoff = now - SEEN_RETENTION_MS
            SEEN_USAGE.intersection_update({fp for fp in SEEN_USAGE if fp[0] >= cutoff})
            SEEN_REQ.intersection_update({fp for fp in SEEN_REQ if fp[0] >= cutoff})
            SEEN_USAGE_G.intersection_update({fp for fp in SEEN_USAGE_G if fp[0] >= cutoff})
            SEEN_REQ_G.intersection_update({fp for fp in SEEN_REQ_G if fp[0] >= cutoff})
