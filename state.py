#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 实时监控 —— 共享状态与持久化
============================================
集中存放全局去重集合 SEEN_*、聚合状态 STATE、线程锁 LOCK、TRUNCATED_FLAG
与常量，以及 SQLite（data.db）的持久化逻辑。其余模块 import 本模块后通过
`from state import ...` 或 `import state` 引用同一对象（注意可变对象引用：
对集合/字典只做原地修改，不做整体替换，避免各模块引用分叉）。

存储设计（data.db，9 张表）：
    meta            小量杂项：tracked_files / session_meta / last_text /
                    last_model / recent_seq / last_scan_time / scan_errors（各 JSON 化）
    days            逐日聚合槽位（date 主键，整日槽位 JSON，含
                    by_model/by_session/by_scope/hourly 嵌套）
    recent          实时事件流（eventId 主键，细粒度列）
    seen_usage / seen_req / seen_turn         主去重指纹（含来源 src）
    seen_usage_g / seen_req_g / seen_turn_g   全局兜底去重指纹（不含 src）
每次操作开新连接，连接时执行 PRAGMA journal_mode=WAL 与
PRAGMA synchronous=NORMAL；save_state 在锁内单事务全量同步。
首次启动若同目录存在旧 data.json 则自动一次性迁移（见 _migrate_from_json）。

模块结构：
    state.py     本模块：STATE / LOCK / SEEN_* / 常量 + 持久化
    aggregate.py 聚合槽位与记录累加（apply_record / apply_request / apply_turn_end）
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
SEEN_TURN = set()     # (time, src, turnId) turn.ended 失败回合指纹
SEEN_TURN_G = set()   # (time, turnId) turn.ended 全局兜底

# ---------------------------------------------------------------------------
# 聚合状态
# ---------------------------------------------------------------------------
LOCK = threading.Lock()
STATE = {
    # "days": { "2026-08-14": {date, inputOther, inputCacheRead, output,
    #                          calls, requests, failed, by_model:{model:{...}},
    #                          by_session:{session:{...}},
    #                          hourly:{0..23:{input, output, cached, calls}}} }
    "days": {},
    "recent": [],  # 最近事件流（usage.record / turn.ended 失败），最多保留 RECENT_LIMIT 条
    "recent_seq": 0,  # recent 事件流递增 eventId（服务运行期内唯一）
    "fails": [],  # 失败回合明细（模型详情等页面展示），最多保留 FAILS_LIMIT 条
    "session_meta": {},  # { session_id: {title, cwd, is_custom, last_prompt} }
    "last_text": {},  # path -> {"input": str, "output": str} 最近输入/输出文本
    "last_model": {},  # path -> 最近一次 llm.request 的模型名（turn.ended 失败回合归属用）
    "last_scan_time": 0,
    "tracked_files": {},  # path -> offset (已读字节偏移)
    "ext_state": {},  # 外部数据源采集状态（zcode 水位 / dsh 文件指纹），随 meta 持久化
    "scan_errors": [],
}

RECENT_LIMIT = 10000  # 事件流滚动缓冲：覆盖「近 30 天」回补窗口（高峰期每天 ~1500 条）
FAILS_LIMIT = 1000   # 失败回合缓冲：失败量远小于调用量，1000 条约覆盖数周

# 文件被截断/重建导致偏移重置为 0 时置位，collector 模块的 collector_loop
# 每轮开头检查并立即存档。由 collector 通过 `state.TRUNCATED_FLAG` 读写，
# 保证各模块持有同一对象（布尔值需以模块属性方式共享，而非重新赋值局部名）。
TRUNCATED_FLAG = False

# 历史失败回合回补标记：旧库升级到新版后，各 wire 的读取偏移已在末尾，
# 增量扫描永远不会重读历史 turn.ended(failed)。首次启动时全量回扫一次，
# 完成后置位并随 meta 持久化（键 turn_backfill_done），后续启动跳过。
TURN_BACKFILL_DONE = False

# 事件流历史回补标记：recent 是滚动缓冲（回放 bug / 容量溢出会冲掉旧事件），
# 首次启动时从 wire.jsonl 重读最近 RECENT_BACKFILL_DAYS 天的事件明细补回
# recent/fails（只补展示层，不动聚合统计），完成后置位（键 recent_backfill_done）。
RECENT_BACKFILL_DONE = False
RECENT_BACKFILL_DAYS = 30  # 回补窗口：与「近 30 天」时间筛选对齐

# 一次性标记：外部源（zcode/dsh）事件输入/输出文本回填是否已完成
EXT_TEXT_BACKFILL_DONE = False

# 指纹去重集合只保留最近 30 天的记录（超过的不会再被 fork 复制段触发），控制内存
SEEN_RETENTION_MS = 30 * 24 * 3600 * 1000

# 外部源（zcode/dsh）指纹不携带时间戳，按来源分桶、每来源最多保留 EXT_FP_KEEP 条
# （裁剪逻辑见 prune_seen / _trim_ext_bucket）。
EXT_FP_KEEP = 5000

# 老记录回放阈值：记录的 ts 距当前处理时刻超过该时长时，仅查全局兜底集合去重
SEEN_OLD_THRESHOLD_MS = 10 * 60 * 1000

# ---------------------------------------------------------------------------
# 定价（DeepSeek 官方价，元/百万 tokens）—— 前端也可覆盖
# 2026-08-17 起 DeepSeek-V4-Flash 高峰时段价格：输入未命中 ¥3/M、缓存命中 ¥0.1/M、输出 ¥9/M
# ---------------------------------------------------------------------------
DEFAULT_PRICES = {
    "input_miss": 3.0,      # 输入未命中 ¥3/M
    "cache_read": 0.1,      # 输入缓存命中 ¥0.1/M
    "cache_write": 0.0,     # 缓存写入 ¥0/M（默认 0，前端可覆盖配置）
    "output": 9.0,          # 输出 ¥9/M
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
                                 --       last_model/recent_seq/last_scan_time/scan_errors
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
        output_text TEXT,                 -- 最近输出文本
        kind        TEXT,                 -- 事件类型：usage（用量）/ failed（失败回合）
        err_code    TEXT,                 -- 失败错误码（failed 事件，如 provider.api_error）
        err_msg     TEXT                  -- 失败错误信息（failed 事件，截断 300 字符）
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
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_turn (
        ts INTEGER,     -- 记录时间（毫秒）
        src TEXT,       -- 来源 wire 文件绝对路径
        turnId INTEGER, -- 会话内回合 id
        PRIMARY KEY (ts, src, turnId)
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS seen_turn_g (
        ts INTEGER,     -- 记录时间（毫秒）
        turnId INTEGER, -- 会话内回合 id
        PRIMARY KEY (ts, turnId)
    )""")
    # 老库迁移：recent 表若缺 kind/err_code/err_msg 列（早期版本建的库）则逐列补齐。
    # CREATE TABLE IF NOT EXISTS 不会给已有表加列，缺列会导致后续 INSERT 列数不匹配。
    recent_cols = {r[1] for r in conn.execute("PRAGMA table_info(recent)")}
    if "kind" not in recent_cols:
        conn.execute("ALTER TABLE recent ADD COLUMN kind TEXT DEFAULT 'usage'")
    if "err_code" not in recent_cols:
        conn.execute("ALTER TABLE recent ADD COLUMN err_code TEXT DEFAULT ''")
    if "err_msg" not in recent_cols:
        conn.execute("ALTER TABLE recent ADD COLUMN err_msg TEXT DEFAULT ''")
    if "source" not in recent_cols:
        conn.execute("ALTER TABLE recent ADD COLUMN source TEXT DEFAULT 'kimi'")


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
            "session, scope, input, cached, output, total, input_text, output_text, "
            "kind, err_code, err_msg) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(r.get("eventId"), r.get("time"), r.get("date"), r.get("hour"),
              r.get("model"), r.get("session"), r.get("scope"),
              r.get("input"), r.get("cached"), r.get("output"), r.get("total"),
              r.get("input_text") or "", r.get("output_text") or "",
              r.get("kind") or "usage", r.get("err_code") or "", r.get("err_msg") or "")
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
        for t in (tuple(x) for x in data.get("seen_turn", [])):
            if len(t) == 3:
                conn.execute("INSERT OR IGNORE INTO seen_turn "
                             "(ts, src, turnId) VALUES (?,?,?)", t)
            else:
                conn.execute("INSERT OR IGNORE INTO seen_turn_g "
                             "(ts, turnId) VALUES (?,?)", t)
        for t in (tuple(x) for x in data.get("seen_turn_g", [])):
            conn.execute("INSERT OR IGNORE INTO seen_turn_g (ts, turnId) VALUES (?,?)", t)
        # meta：旧 JSON 未持久化 recent_seq，取 recent 最大 eventId+1 续接
        max_eid = conn.execute(
            "SELECT COALESCE(MAX(eventId), -1) FROM recent").fetchone()[0]
        meta = {
            "tracked_files": data.get("tracked_files") or {},
            "session_meta": data.get("session_meta") or {},
            "last_text": data.get("last_text") or {},
            "last_model": data.get("last_model") or {},
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
    global TURN_BACKFILL_DONE, RECENT_BACKFILL_DONE, EXT_TEXT_BACKFILL_DONE
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
                    "input, cached, output, total, input_text, output_text, "
                    "kind, err_code, err_msg, source "
                    "FROM recent ORDER BY eventId"):
                (eventId, tm, date, hour, model, session, scope, inp,
                 cached, out, total, input_text, output_text,
                 kind, err_code, err_msg, source) = row
                recent.append({
                    "time": tm, "date": date, "hour": hour,
                    "model": model, "session": session, "scope": scope,
                    "input": inp, "cached": cached, "output": out,
                    "total": total, "eventId": eventId,
                    "kind": kind or "usage",
                    "err_code": err_code or "",
                    "err_msg": err_msg or "",
                    "source": source or "kimi",
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
            seen_turn = {tuple(r) for r in
                         conn.execute("SELECT ts, src, turnId FROM seen_turn")}
            seen_turn_g = {tuple(r) for r in
                           conn.execute("SELECT ts, turnId FROM seen_turn_g")}
            meta = {}
            for key, value in conn.execute("SELECT key, value FROM meta"):
                try:
                    meta[key] = json.loads(value)
                except Exception:
                    meta[key] = None
            # meta 杂项组装回 STATE（boot_replay 未覆盖的字段在此恢复）；
            # tracked_files 同时作为 9 元组首元素返回。
            # 迁移期间 add_error 已追加的告警需保留，与存档中的 scan_errors 合并。
            saved_errors = list(STATE["scan_errors"])
            STATE["tracked_files"] = meta.get("tracked_files") or {}
            STATE["session_meta"] = meta.get("session_meta") or {}
            STATE["last_text"] = meta.get("last_text") or {}
            STATE["last_model"] = meta.get("last_model") or {}
            STATE["fails"] = meta.get("fails") or []
            TURN_BACKFILL_DONE = bool(meta.get("turn_backfill_done"))
            RECENT_BACKFILL_DONE = bool(meta.get("recent_backfill_done"))
            EXT_TEXT_BACKFILL_DONE = bool(meta.get("ext_text_backfill_done"))
            STATE["recent_seq"] = int(meta.get("recent_seq") or 0)
            STATE["last_scan_time"] = float(meta.get("last_scan_time") or 0)
            STATE["ext_state"] = meta.get("ext_state") or {}
            STATE["scan_errors"] = (saved_errors + (meta.get("scan_errors") or []))[-10:]
            return (STATE["tracked_files"], days, seen_usage, seen_req,
                    seen_usage_g, seen_req_g, seen_turn, seen_turn_g, recent)
    except Exception:
        return {}, {}, set(), set(), set(), set(), set(), set(), []


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
                        ("seen_turn", SEEN_TURN,
                         "INSERT OR REPLACE INTO seen_turn "
                         "(ts, src, turnId) VALUES (?,?,?)"),
                        ("seen_turn_g", SEEN_TURN_G,
                         "INSERT OR REPLACE INTO seen_turn_g "
                         "(ts, turnId) VALUES (?,?)"),
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
                        "session, scope, input, cached, output, total, input_text, output_text, "
                        "kind, err_code, err_msg, source) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        [(r.get("eventId"), r.get("time"), r.get("date"), r.get("hour"),
                          r.get("model"), r.get("session"), r.get("scope"),
                          r.get("input"), r.get("cached"), r.get("output"), r.get("total"),
                          r.get("input_text") or "", r.get("output_text") or "",
                          r.get("kind") or "usage", r.get("err_code") or "",
                          r.get("err_msg") or "", r.get("source") or "kimi")
                         for r in STATE["recent"]])
                    meta = {
                        "tracked_files": STATE["tracked_files"],
                        "session_meta": STATE["session_meta"],
                        "last_text": STATE["last_text"],
                        "last_model": STATE["last_model"],
                        "fails": STATE["fails"],
                        "turn_backfill_done": bool(TURN_BACKFILL_DONE),
                        "recent_backfill_done": bool(RECENT_BACKFILL_DONE),
                        "ext_text_backfill_done": bool(EXT_TEXT_BACKFILL_DONE),
                        "recent_seq": str(STATE["recent_seq"]),
                        "last_scan_time": str(STATE["last_scan_time"]),
                        "ext_state": STATE["ext_state"],
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


def _ext_fp_key(fp):
    """ext 指纹的裁剪排序键：fp[1]/fp[2] 中 id 段可解析为数值（zcode rowid 等
    单调 id）→ (0, id)，数值小的（旧）排前优先被裁、大的（新）保留；dsh 消息
    uuid / zcode turnId 等不可排序段 → (1, 0) 整体排后，仅当该来源桶总量超过
    EXT_FP_KEEP 时才参与剪裁。"""
    for part in fp[1:3]:
        if isinstance(part, str) and ":" in part:
            try:
                return (0, int(part.split(":", 1)[1]))
            except ValueError:
                continue
    return (1, 0)


def _trim_ext_bucket(items):
    """单个外部源来源桶的有界保留：超出 EXT_FP_KEEP 时只保留“最近”的条数。"""
    if len(items) <= EXT_FP_KEEP:
        return items
    items.sort(key=_ext_fp_key)
    return items[len(items) - EXT_FP_KEEP:]


def prune_seen(force=False):
    """按时间清理过期的 SEEN 指纹（主/全局集合），控制内存有界。
    用 intersection_update 原地收缩集合：保持各模块持有的 SEEN_* 引用为
    同一对象（若改为整体替换赋值，其他模块仍会看到旧集合，导致去重失效/漏存；
    且增强赋值会把集合名绑定为局部变量，需避免）。
    外部源（zcode/dsh）指纹首元素为字符串 "ext"（不携带时间戳，见 aggregate
    模块），不能按时间裁剪：改为按来源分桶、每来源最多保留 EXT_FP_KEEP 条
    （见 _trim_ext_bucket）。裁剪窗口 5000 远大于采集器单次回放跨度——zcode
    增量扫描只会重读水位之后的新行（rowid 单调递增，按 id 裁旧保新正好只丢
    永远不再重读的旧行）；dsh 整文件重扫以消息 id 为身份去重，单次全量重放
    的消息条数远小于该上限，去重幂等性不受影响。"""
    now = time.time() * 1000
    with LOCK:
        if (force or len(SEEN_USAGE) > 20000 or len(SEEN_REQ) > 20000
                or len(SEEN_USAGE_G) > 20000 or len(SEEN_REQ_G) > 20000
                or len(SEEN_TURN) > 20000 or len(SEEN_TURN_G) > 20000):
            cutoff = now - SEEN_RETENTION_MS

            def _trim(seenset):
                keep = []
                ext_buckets = {}
                for fp in seenset:
                    if isinstance(fp[0], str):
                        # 外部源指纹：("ext", <source 或 "source:id">, ...)
                        src = fp[1] if isinstance(fp[1], str) else str(fp[1])
                        ext_buckets.setdefault(src.split(":", 1)[0], []).append(fp)
                    elif fp[0] >= cutoff:
                        keep.append(fp)  # kimi 指纹：30 天窗口
                for bucket_fps in ext_buckets.values():
                    keep.extend(_trim_ext_bucket(bucket_fps))
                seenset.intersection_update(keep)

            _trim(SEEN_USAGE)
            _trim(SEEN_REQ)
            _trim(SEEN_USAGE_G)
            _trim(SEEN_REQ_G)
            _trim(SEEN_TURN)
            _trim(SEEN_TURN_G)
