"""ZCode CLI collector: incremental scan of its SQLite model_usage table.

ZCode (~/.zcode/cli/db/db.sqlite) records every completed model call with
exact token fields. We map them into the shared aggregate state as an
external source ("zcode"): usage lands only in days[date].by_source.zcode,
never in the top-level Kimi totals.
"""

import json
import os
import sqlite3
import time

import state
from aggregate import apply_record, apply_turn_end
from state import LOCK, STATE

DB_PATH = os.path.expanduser("~/.zcode/cli/db/db.sqlite")


def _part_text(con, mid, limit):
    """取某条消息的所有 type=text 分片拼接文本（截断保留尾部 limit 字符）。
    model_usage 通过 parent_user_message_id / assistant_message_id 关联到
    message/part 表，可还原该次调用的用户输入与助手输出（与 kimi 事件流同义）。"""
    if not mid:
        return ""
    try:
        rows = con.execute(
            "SELECT data FROM part WHERE message_id=? ORDER BY sequence", (mid,)
        ).fetchall()
    except sqlite3.Error:
        return ""
    parts = []
    for (data,) in rows:
        try:
            d = json.loads(data)
        except Exception:
            continue
        if isinstance(d, dict) and d.get("type") == "text" and d.get("text"):
            parts.append(d["text"])
    return "\n".join(parts)[-limit:]

# session_id -> meta dict, re-merged into STATE["session_meta"] every scan
# (collector_loop replaces session_meta wholesale, so we must keep re-adding ours)
_title_cache = {}


def _fix_title(raw):
    """ZCode session titles arrive as @"..." wrapped, often GBK-mojibake."""
    if not raw:
        return ""
    t = raw.strip()
    if t.startswith('@"') and t.endswith('"'):
        t = t[2:-1]
    # try to recover UTF-8/GBK text that was mis-decoded as latin-1
    try:
        for enc in ("gbk", "utf-8"):
            try:
                t = t.encode("latin-1").decode(enc)
                break
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
    except Exception:
        pass
    return t[:80]


def _fetch(db_path):
    """Read new model_usage rows (rowid watermark) plus the session table."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        with LOCK:
            watermark = STATE["ext_state"].get("zcode_last_rowid", 0)
        # rowid 重置守卫：model_usage 表被重建/清空重灌后 rowid 会从 1 重新分配，
        # 若表内最大 rowid 不大于存量水位（或表空而水位非 0），`WHERE rowid > ?`
        # 会把整张新表永久跳过。此时把水位重置为 0 重新全量回放——指纹以 rowid
        # 为身份（"zcode:<rowid>"），已计数的旧行重放时被指纹命中丢弃、新行照常
        # 计数，不会重复；重建后旧行已不存在，rowid 复用在指纹层造成误判的
        # 概率（同 rowid + 同模型 + 同 token 数）可忽略。
        if watermark:
            max_rowid = con.execute(
                "SELECT COALESCE(MAX(rowid), 0) FROM model_usage").fetchone()[0]
            if not max_rowid or max_rowid <= watermark:
                watermark = 0
        rows = con.execute(
            "SELECT rowid, status, session_id, model_id, input_tokens, output_tokens, "
            "cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at, "
            "turn_id, logical_request_id, error_type, error_code, error_message, query_source, "
            "assistant_message_id, parent_user_message_id "
            "FROM model_usage WHERE rowid > ? ORDER BY rowid",
            (watermark,),
        ).fetchall()
        sessions = []
        try:
            sessions = con.execute(
                "SELECT id, title, directory, time_created FROM session"
            ).fetchall()
        except sqlite3.Error:
            pass
        return watermark, rows, sessions
    finally:
        con.close()


def scan_once():
    if not os.path.exists(DB_PATH):
        return
    try:
        last_rowid, rows, sessions = _fetch(DB_PATH)
    except sqlite3.Error as e:
        state.add_error(f"[zcode] db read failed: {e}")
        return

    if not rows and not sessions:
        return

    first_batch = last_rowid == 0 and bool(rows)
    applied = 0
    max_rowid = last_rowid
    now_ms = int(time.time() * 1000)
    # 有 completed 行时需要二次连接查 part 表取输入/输出文本
    text_con = None
    if any(r[1] == "completed" for r in rows):
        try:
            text_con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        except sqlite3.Error:
            text_con = None

    try:
        for r in rows:
            (rowid, status, sid, model, tin, tout, tcreate, tread,
             started, completed, turn_id, req_id, etype, ecode, emsg, qsrc,
             amid, umid) = r
            if rowid > max_rowid:
                max_rowid = rowid
            try:
                if status == "completed":
                    cached = tread or 0
                    apply_record({
                        "time": completed or started or now_ms,
                        "session_id": f"zcode:{sid}",
                        "model": model or "",
                        "scope": "subagent" if qsrc == "subagent" else "main",
                        "source": "zcode",
                        "src": f"zcode:{rowid}",
                        "replay": first_batch,  # 历史回放不推实时事件流（避免淹没 kimi 事件）
                        "usage": {
                            "inputOther": max((tin or 0) - cached, 0),
                            "inputCacheRead": cached,
                            "inputCacheCreation": tcreate or 0,
                            "output": tout or 0,
                        },
                        # 用户提问（parent_user_message）+ 助手回答（assistant_message）
                        "input_text": _part_text(text_con, umid, 600) if text_con else "",
                        "output_text": _part_text(text_con, amid, 1500) if text_con else "",
                    })
                    applied += 1
                elif status == "error":
                    apply_turn_end({
                        "reason": "failed",
                        "time": completed or started or now_ms,
                        "session_id": f"zcode:{sid}",
                        "source": "zcode",
                        "replay": first_batch,  # 历史回放不推实时事件流/失败缓冲
                        "turnId": turn_id or req_id or f"row{rowid}",
                        "model": model or "",
                        "scope": "subagent" if qsrc == "subagent" else "main",
                        "error": {"code": ecode or etype or "", "message": emsg or ""},
                        "src": "zcode",
                    })
                # status == "cancelled": not counted
            except Exception as e:
                state.add_error(f"[zcode] row {rowid}: {type(e).__name__}: {e}")
    finally:
        if text_con is not None:
            text_con.close()

    # refresh titles + watermark
    with LOCK:
        for sid, title, directory, created in sessions:
            key = f"zcode:{sid}"
            _title_cache[key] = {
                "title": _fix_title(title) or os.path.basename(directory or "") or key,
                "cwd": directory or "",
                "is_custom": False,
                "last_prompt": "",
                "created_at": created or 0,
                "forked_from": "",
            }
        STATE["session_meta"].update(_title_cache)
        STATE["ext_state"]["zcode_last_rowid"] = max_rowid

    if first_batch and applied:
        state.save_state()


def backfill_recent(cutoff_ms):
    """一次性回补：全量读 model_usage，把窗口内（>= cutoff_ms）的行转成
    recent/fails 展示条目，返回 (recent_items, fails_items)。
    只补展示层：不走 apply_record/apply_turn_end，不动聚合、指纹与水位。
    error 行的 model 用行内 model_id（比 kimi 侧的 last_model 推断更准）。"""
    from collector import _recent_usage_entry, _recent_failed_entry
    items, fails = [], []
    if not os.path.exists(DB_PATH):
        return items, fails
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT rowid, status, session_id, model_id, input_tokens, output_tokens, "
            "cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at, "
            "error_type, error_code, error_message, query_source, "
            "assistant_message_id, parent_user_message_id "
            "FROM model_usage ORDER BY rowid"
        ).fetchall()
        for r in rows:
            (rowid, status, sid, model, tin, tout, tcreate, tread,
             started, completed, etype, ecode, emsg, qsrc, amid, umid) = r
            ts = completed or started or 0
            if not ts or ts < cutoff_ms:
                continue
            session = f"zcode:{sid}"
            if status == "completed":
                cached = tread or 0
                scope = "subagent" if qsrc == "subagent" else "main"
                entry = _recent_usage_entry(
                    ts, model or "", session, scope, "zcode",
                    max((tin or 0) - cached, 0), cached, tout or 0)
                entry["input_text"] = _part_text(con, umid, 600)
                entry["output_text"] = _part_text(con, amid, 1500)
                items.append(entry)
            elif status == "error":
                scope = "subagent" if qsrc == "subagent" else "main"
                entry = _recent_failed_entry(
                    ts, model or "", session, scope, "zcode",
                    ecode or etype or "", emsg or "")
                items.append(entry)
                fails.append({
                    "time": entry["time"], "date": entry["date"],
                    "hour": entry["hour"],
                    "model": entry["model"], "session": session, "scope": scope,
                    "source": "zcode",
                    "err_code": entry["err_code"], "err_msg": entry["err_msg"],
                })
            # status == "cancelled": 与 scan_once 口径一致，不计
    finally:
        con.close()
    return items, fails


def collector_loop():
    i = 0
    while True:
        try:
            scan_once()
        except Exception as e:
            state.add_error(f"[zcode] scan failed: {type(e).__name__}: {e}")
        i += 1
        if i % 15 == 0:
            try:
                state.save_state()
            except Exception:
                pass
        time.sleep(state.POLL_INTERVAL)
