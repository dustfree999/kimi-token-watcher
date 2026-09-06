#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 实时监控 —— 增量扫描与采集循环
==============================================
扫描 sessions/**/agents/*/wire.jsonl 的新追加行，解析 usage.record /
llm.request / turn.ended 事件并调用 aggregate.apply_record / apply_request /
apply_turn_end 累加，同时维护文本跟踪、会话元数据、启动回放与后台采集线程逻辑。
共享状态统一经 `state.` 引用（同一对象，见 state 模块）。
"""

import datetime
import glob
import json
import os
import re
import time

import state
from aggregate import apply_record, apply_request, apply_turn_end

SESSION_ID_RE = re.compile(r"[/\\](session_[0-9a-f-]+|ses_[0-9a-f-]+)[/\\]")


def collect_session_meta(root):
    """扫描 sessions/*/<session_id>/state.json，提取 会话标题 / 工作目录 / 自定义标记。
    返回 { session_id: {title, cwd, is_custom, last_prompt, created_at, forked_from} }"""
    meta = {}
    try:
        pattern = os.path.join(root, "*", "*", "state.json")
        for sp in glob.glob(pattern):
            sid = os.path.basename(os.path.dirname(sp))
            try:
                with open(sp, "r", encoding="utf-8", errors="replace") as fh:
                    d = json.load(fh)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            meta[sid] = {
                "title": (d.get("title") or "")[:80],
                "cwd": d.get("cwd") or "",
                "is_custom": bool(d.get("isCustomTitle")),
                "last_prompt": (d.get("lastPrompt") or "")[:200],
                "created_at": d.get("createdAt") or 0,
                "forked_from": d.get("forkedFrom") or "",
            }
    except Exception:
        pass
    return meta


def is_fork_copy(session_id, ts_ms, meta=None):
    """判断某条记录是否来自 fork 会话的复制段。
    fork 会话会把父会话的 wire.jsonl（含历史 usage.record）复制进来，
    那些复制记录的 time 早于 fork 会话的 createdAt，应跳过避免重复计数。
    注意：本函数不获取 LOCK（调用方 apply_record/apply_request 已在锁内，
    且 threading.Lock 不可重入，若在此再加锁会造成死锁）。"""
    if meta is None:
        meta = state.STATE["session_meta"]
    m = meta.get(session_id) or {}
    created = m.get("created_at") or 0
    if created and m.get("forked_from") and ts_ms < created:
        return True
    return False


def session_id_of(path):
    m = SESSION_ID_RE.search(path)
    return m.group(1) if m else os.path.basename(os.path.dirname(os.path.dirname(path)))


def scope_of(path):
    """按文件路径判断记录归属：agents/main -> 主智能体；agents/agent-* -> 子智能体。"""
    norm = path.replace("\\", "/")
    if "/agents/agent-" in norm:
        return "subagent"
    return "main"


def list_wires(root):
    try:
        return sorted(
            glob.glob(os.path.join(root, "*", "*", "agents", "*", "wire.jsonl"), recursive=True)
        )
    except Exception:
        return []


def extract_text(content):
    """从 turn.prompt.input / message.content 提取纯文本（截断）。content 可为 dict 或 list。"""
    if isinstance(content, str):
        return content[:2000]
    if isinstance(content, dict):
        content = content.get("content") or content.get("parts") or content.get("text")
        if isinstance(content, str):
            return content[:2000]
        if isinstance(content, list):
            return extract_text(content)
        return ""
    if isinstance(content, list):
        parts = []
        for c in content:
            if not isinstance(c, dict):
                continue
            t = c.get("type")
            if t == "text" and c.get("text"):
                parts.append(c["text"])
            elif t in ("tool_use", "tool_call"):
                parts.append(f"[工具调用: {c.get('name', '?')}]")
            elif t == "input_text" and c.get("text"):
                parts.append(c["text"])
            elif c.get("text"):
                parts.append(c["text"])
        joined = "\n".join(parts)
        return joined[:2000]
    return ""


def _track_text(slot, etype, obj):
    """按事件类型更新该文件的最近输入/输出文本。
    turn.prompt 标志着新回合开始：重置输出，写入输入；随后同回合的文本片段累积进输出。
    这样 usage.record 挂载的是“本回合”的输入与输出，避免跨回合混叠。"""
    if etype == "turn.prompt":
        txt = extract_text(obj.get("input"))
        if txt:
            slot["input"] = txt
            slot["output"] = ""  # 新回合开始，清空上一个回合的输出
    elif etype == "context.append_message":
        msg = obj.get("message") or {}
        if msg.get("role") == "user":
            txt = extract_text(msg.get("content"))
            # 过滤系统注入的消息（<system>/<notification>/<cron-fire> 等以 < 开头的
            # 操作指令包裹），它们是系统提醒而非用户真实提问，不应作为“输入”展示
            if txt and not txt.lstrip().startswith("<"):
                slot["input"] = txt
                slot["output"] = ""
    elif etype == "context.append_loop_event":
        part = (obj.get("event") or {}).get("part") or {}
        if part.get("type") == "text" and part.get("text"):
            slot["output"] = (slot["output"] + part["text"])[-4000:]
    return slot


def scan_once():
    root = state.SESSION_ROOT
    wires = list_wires(root)
    # 删除已消失文件的记录
    with state.LOCK:
        known = set(state.STATE["tracked_files"].keys())
        for p in known:
            if p not in wires:
                state.STATE["tracked_files"].pop(p, None)
    for path in wires:
        try:
            with state.LOCK:
                offset = state.STATE["tracked_files"].get(path, 0)
            size = os.path.getsize(path)
            if offset > size:
                offset = 0  # 文件被截断/重建，重置；置标志让 collector_loop 立即存档
                state.TRUNCATED_FLAG = True
            if offset == size:
                continue  # 无新内容
            with open(path, "rb") as fh:
                fh.seek(offset)
                raw = fh.read()
            nl = raw.rfind(b"\n")
            if nl == -1:
                # 没有任何完整行（有写入进行中的残行），留待下次
                continue
            full = raw[:nl]
            new_offset = offset + nl + 1  # 字节偏移，指向最后完整行之后
            with state.LOCK:
                state.STATE["tracked_files"][path] = new_offset
            text = full.decode("utf-8", errors="replace")
            for ln in text.split("\n"):
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    obj = json.loads(ln)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                etype = obj.get("type")
                # 跟踪最近的输入/输出文本，供事件流点击查看（按 turn 重置）
                slot = state.STATE["last_text"].setdefault(path, {"input": "", "output": ""})
                if etype in ("turn.prompt", "context.append_message", "context.append_loop_event"):
                    _track_text(slot, etype, obj)
                if etype == "usage.record":
                    obj["session_id"] = session_id_of(path)
                    obj["scope"] = scope_of(path)
                    obj["src"] = path  # 来源 wire 文件绝对路径，用于去重指纹区分会话/Agent
                    obj["input_text"] = slot["input"][-600:]
                    obj["output_text"] = slot["output"][-1500:]
                    # 单行异常不中断整批解析：偏移已推进，中断会丢掉剩余行
                    try:
                        apply_record(obj)
                    except Exception as e:
                        state.add_error(f"{os.path.basename(path)}: record: {e}")
                elif etype == "llm.request":
                    obj["session_id"] = session_id_of(path)
                    obj["scope"] = scope_of(path)
                    obj["src"] = path  # 来源 wire 文件绝对路径，用于去重指纹区分会话/Agent
                    # 记录该 wire 最近一次 llm.request 的模型名，供 turn.ended
                    # 失败回合归属（turn.ended 事件本身没有 model 字段）
                    with state.LOCK:
                        state.STATE["last_model"][path] = (
                            obj.get("modelAlias") or obj.get("model") or "(unknown)")
                    try:
                        apply_request(obj)
                    except Exception as e:
                        state.add_error(f"{os.path.basename(path)}: request: {e}")
                elif etype == "turn.ended":
                    obj["session_id"] = session_id_of(path)
                    obj["scope"] = scope_of(path)
                    obj["src"] = path  # 来源 wire 文件绝对路径，用于去重指纹区分会话/Agent
                    obj["input_text"] = slot["input"][-600:]
                    try:
                        apply_turn_end(obj)
                    except Exception as e:
                        state.add_error(f"{os.path.basename(path)}: turn_end: {e}")
        except FileNotFoundError:
            with state.LOCK:
                state.STATE["tracked_files"].pop(path, None)
        except Exception as e:
            state.add_error(f"{os.path.basename(path)}: {e}")


def collector_loop():
    save_counter = 0
    meta_counter = 0
    while True:
        try:
            # 文件被截断/重建（偏移重置为 0）后立即存档，避免重启后重复计数
            if state.TRUNCATED_FLAG:
                state.save_state()
                state.TRUNCATED_FLAG = False
            scan_once()
            save_counter += 1
            # 每 30 秒持久化一次偏移，避免重启重复计数
            if save_counter >= 15:
                state.save_state()
                save_counter = 0
            # 每 30 秒刷新一次会话标题映射（state.json 变化不频繁）
            meta_counter += 1
            if meta_counter >= 15:
                try:
                    state.STATE["session_meta"] = collect_session_meta(state.SESSION_ROOT)
                except Exception as e:
                    state.add_error(f"meta: {e}")
                # 只保留最近 90 天的 day 槽，控制 data.db 长期增长
                cutoff = (datetime.datetime.now() - datetime.timedelta(days=90)).strftime("%Y-%m-%d")
                with state.LOCK:
                    state.STATE["days"] = {d: s for d, s in state.STATE["days"].items() if d >= cutoff}
                # 同时按大小触发一次 SEEN 清理（容量达到阈值才真正执行）
                state.prune_seen()
                meta_counter = 0
        except Exception as e:
            state.add_error(str(e))
        state.STATE["last_scan_time"] = time.time()
        time.sleep(state.POLL_INTERVAL)


def shutdown_save():
    try:
        state.save_state()
        print("[kimi-token-watcher] 状态已保存到 data.db")
    except Exception as e:
        print("[kimi-token-watcher] 保存失败:", e)


def warmup_text():
    """启动时回填每个文件的最近输入/输出文本，不做任何聚合、不移动偏移。
    为性能只读取每个文件尾部 TAIL_BYTES，从最近一个完整行开始解析。"""
    root = state.SESSION_ROOT
    TAIL_BYTES = 2 * 1024 * 1024  # 每个文件只回读尾部 2MB，足够覆盖最近的 prompt/输出
    for path in list_wires(root):
        slot = state.STATE["last_text"].setdefault(path, {"input": "", "output": ""})
        try:
            size = os.path.getsize(path)
            start = max(0, size - TAIL_BYTES)
            with open(path, "rb") as fh:
                fh.seek(start)
                raw = fh.read()
            # 从最近一个完整行开始（丢弃可能被截断的首行）
            nl = raw.find(b"\n")
            if nl == -1:
                continue
            text = raw[nl + 1:].decode("utf-8", errors="replace")
            for ln in text.split("\n"):
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    obj = json.loads(ln)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                etype = obj.get("type")
                if etype in ("turn.prompt", "context.append_message", "context.append_loop_event"):
                    _track_text(slot, etype, obj)
                elif etype == "llm.request":
                    # 顺带回填最近一次 llm.request 的模型名（供失败回合归属）
                    state.STATE["last_model"][path] = (
                        obj.get("modelAlias") or obj.get("model") or "(unknown)")
        except Exception:
            pass


def backfill_turns():
    """一次性回补：全量扫描所有 wire 的历史 turn.ended(failed)。
    旧库升级到新版后，各 wire 的读取偏移已在末尾，增量扫描永远不会重读
    历史失败事件；升级后首次启动全量回补一次（只补失败统计，不动用量/
    请求计数；apply_turn_end 的三层去重保证与增量扫描不重复计数）。
    完成后置 state.TURN_BACKFILL_DONE 并立即持久化，后续启动跳过。"""
    if state.TURN_BACKFILL_DONE:
        return
    if not state.STATE["tracked_files"]:
        # 全新安装（无存档）：boot_replay 的 scan_once 会从头全量扫描，
        # 历史失败会一并统计，无需单独回补
        state.TURN_BACKFILL_DONE = True
        return
    count = 0
    for path in list_wires(state.SESSION_ROOT):
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            continue
        text = raw.decode("utf-8", errors="replace")
        for ln in text.split("\n"):
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            etype = obj.get("type")
            if etype == "llm.request":
                # 顺序扫描顺带记录最近请求模型，供当时失败回合的归属
                state.STATE["last_model"][path] = (
                    obj.get("modelAlias") or obj.get("model") or "(unknown)")
            elif etype == "turn.ended" and obj.get("reason") == "failed":
                obj["session_id"] = session_id_of(path)
                obj["scope"] = scope_of(path)
                obj["src"] = path
                obj["input_text"] = ""  # 历史回补不还原当时输入文本
                try:
                    apply_turn_end(obj)
                    count += 1
                except Exception as e:
                    state.add_error(f"backfill: {os.path.basename(path)}: {e}")
    state.TURN_BACKFILL_DONE = True
    state.save_state()
    print(f"[kimi-token-watcher] 历史失败回合回补完成：扫描到 {count} 条 turn.ended(failed)")


def boot_replay():
    """启动时：恢复偏移、days 与去重集合，重启后保持一致性。
    首次运行（无存档）则从头全量扫描一次（会统计历史全部）。"""
    (offsets, days, seen_usage, seen_req, seen_usage_g, seen_req_g,
     seen_turn, seen_turn_g, recent) = state.load_state()
    state.STATE["tracked_files"] = offsets
    # 原地替换去重集合内容：保持 state.SEEN_* 与各模块（aggregate 等）持有的
    # 引用为同一集合对象（若重新赋值，其他模块仍会看到空的旧集合）。
    state.SEEN_USAGE.clear()
    state.SEEN_USAGE.update(seen_usage)
    state.SEEN_REQ.clear()
    state.SEEN_REQ.update(seen_req)
    state.SEEN_USAGE_G.clear()
    state.SEEN_USAGE_G.update(seen_usage_g)
    state.SEEN_REQ_G.clear()
    state.SEEN_REQ_G.update(seen_req_g)
    state.SEEN_TURN.clear()
    state.SEEN_TURN.update(seen_turn)
    state.SEEN_TURN_G.clear()
    state.SEEN_TURN_G.update(seen_turn_g)
    state.prune_seen(force=True)  # 启动时清理一次过期的去重指纹
    if days:
        state.STATE["days"] = days
    # 恢复实时事件流（recent 已持久化）；eventId 需续接最大值，
    # 否则新记录与历史记录 id 重叠，前端展开状态会串
    state.STATE["recent"] = list(recent)
    state.STATE["recent_seq"] = max((r.get("eventId", 0) for r in recent), default=-1) + 1
    try:
        backfill_turns()  # 一次性：旧库升级后回补历史失败回合（幂等，带标记）
        warmup_text()
        scan_once()
    except Exception as e:
        with state.LOCK:
            state.STATE["scan_errors"] = [str(e)]
    try:
        state.STATE["session_meta"] = collect_session_meta(state.SESSION_ROOT)
    except Exception as e:
        with state.LOCK:
            state.STATE["scan_errors"] = [str(e)]


def _recent_usage_entry(ts, model, session, scope, source, other, cached, out):
    """构造一条 usage 类型的 recent 条目（不含 eventId，finalize 时统一编号）。"""
    from aggregate import day_of, hour_of
    return {
        "time": int(ts), "date": day_of(ts), "hour": hour_of(ts),
        "model": model or "(unknown)", "session": session, "scope": scope,
        "input": int(other), "cached": int(cached), "output": int(out),
        "total": int(other + cached + out),
        "kind": "usage", "source": source,
        "input_text": "", "output_text": "",
    }


def _recent_failed_entry(ts, model, session, scope, source, err_code, err_msg):
    """构造一条 failed 类型的 recent 条目（不含 eventId）。"""
    from aggregate import day_of, hour_of
    return {
        "time": int(ts), "date": day_of(ts), "hour": hour_of(ts),
        "model": model or "(unknown)", "session": session, "scope": scope,
        "input": 0, "cached": 0, "output": 0, "total": 0,
        "kind": "failed", "source": source,
        "err_code": err_code or "", "err_msg": (err_msg or "")[:300],
        "input_text": "", "output_text": "",
    }


def _backfill_kimi_recent(cutoff_ms, fails_out):
    """重读最近 RECENT_BACKFILL_DAYS 天有改动的 wire.jsonl，把其中的
    usage.record / turn.ended(failed) 转成 recent/fails 展示条目。
    只补展示层：不走 apply_record/apply_turn_end，不动聚合与去重指纹。
    返回 recent 条目列表；fails 条目追加进 fails_out。"""
    items = []
    for path in list_wires(state.SESSION_ROOT):
        try:
            # 文件最后修改时间早于回补窗口，里面不可能有窗口内事件
            if os.path.getmtime(path) * 1000 < cutoff_ms:
                continue
        except OSError:
            continue
        session = session_id_of(path)
        scope = scope_of(path)
        last_model = "(unknown)"
        try:
            fh = open(path, "r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for ln in fh:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    obj = json.loads(ln)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                etype = obj.get("type")
                if etype == "llm.request":
                    last_model = obj.get("modelAlias") or obj.get("model") or "(unknown)"
                    continue
                ts = obj.get("time") or 0
                if not isinstance(ts, (int, float)) or ts < cutoff_ms:
                    continue
                # fork 会话复制段与聚合层口径一致，跳过避免展示重复
                if is_fork_copy(session, ts):
                    continue
                if etype == "usage.record":
                    if obj.get("usageScope") == "session":
                        continue
                    us = obj.get("usage") or {}
                    other = us.get("inputOther") or 0
                    cached = us.get("inputCacheRead") or 0
                    out = us.get("output") or 0
                    items.append(_recent_usage_entry(
                        ts, obj.get("model"), session, scope, "kimi",
                        other, cached, out))
                elif etype == "turn.ended" and obj.get("reason") == "failed":
                    err = obj.get("error") or {}
                    items.append(_recent_failed_entry(
                        ts, last_model, session, scope, "kimi",
                        err.get("code"), err.get("message")))
                    fails_out.append({
                        "time": int(ts),
                        "date": items[-1]["date"],
                        "hour": items[-1]["hour"],
                        "model": last_model, "session": session, "scope": scope,
                        "source": "kimi",
                        "err_code": err.get("code") or "",
                        "err_msg": (err.get("message") or "")[:300],
                    })
    return items


def backfill_recent():
    """一次性回补：把最近 RECENT_BACKFILL_DAYS 天的历史事件补进 recent/fails
    展示缓冲（kimi wire + zcode 库 + dsh 文件）。
    背景：recent 是滚动缓冲，旧事件会被新事件物理挤出，增量扫描永远
    不会重读历史，扩容 RECENT_LIMIT 只对未来生效——需要一次性重读历史。
    只补展示层，不走 apply_record/apply_turn_end，聚合统计与去重指纹
    完全不受影响；与现有 recent/fails 按内容键去重，天然幂等。
    完成后置 state.RECENT_BACKFILL_DONE 并持久化，后续启动跳过。"""
    if state.RECENT_BACKFILL_DONE:
        return
    if not state.STATE["tracked_files"]:
        # 全新安装（无存档）：boot_replay 的 scan_once 已从头全量扫描，
        # 历史事件已全部进 recent，无需回补
        state.RECENT_BACKFILL_DONE = True
        return
    cutoff = time.time() * 1000 - state.RECENT_BACKFILL_DAYS * 86400 * 1000
    items = []
    fails = []
    try:
        items += _backfill_kimi_recent(cutoff, fails)
    except Exception as e:
        state.add_error(f"recent backfill kimi: {e}")
    # 延迟导入：collector_zcode/collector_dsh 均 import aggregate，
    # 模块级导入会造成 collector <-> collector_zcode 循环依赖
    try:
        import collector_zcode
        zi, zf = collector_zcode.backfill_recent(cutoff)
        items += zi
        fails += zf
    except Exception as e:
        state.add_error(f"recent backfill zcode: {e}")
    try:
        import collector_dsh
        di, df = collector_dsh.backfill_recent(cutoff)
        items += di
        fails += df
    except Exception as e:
        state.add_error(f"recent backfill dsh: {e}")
    try:
        import collector_oai
        oi, of_ = collector_oai.backfill_recent(cutoff)
        items += oi
        fails += of_
    except Exception as e:
        state.add_error(f"recent backfill oai: {e}")

    with state.LOCK:
        recent = state.STATE["recent"]
        # 与现有事件按内容键去重（同毫秒同会话同模型同 token 的重复概率极低）
        seen = {(r.get("time"), r.get("session"), r.get("model"), r.get("kind"),
                 r.get("input"), r.get("cached"), r.get("output")) for r in recent}
        added = 0
        for it in items:
            key = (it["time"], it["session"], it["model"], it["kind"],
                   it["input"], it["cached"], it["output"])
            if key in seen:
                continue
            seen.add(key)
            recent.append(it)
            added += 1
        state_fails = state.STATE["fails"]
        seen_f = {(f.get("time"), f.get("session"), f.get("model")) for f in state_fails}
        added_f = 0
        for f in fails:
            key = (f["time"], f["session"], f["model"])
            if key in seen_f:
                continue
            seen_f.add(key)
            state_fails.append(f)
            added_f += 1
        # 按时间重排并统一重编 eventId（一次性；浏览器展开状态失效可接受）
        recent.sort(key=lambda r: r.get("time") or 0)
        if len(recent) > state.RECENT_LIMIT:
            del recent[: len(recent) - state.RECENT_LIMIT]
        for i, r in enumerate(recent):
            r["eventId"] = i
        state.STATE["recent_seq"] = len(recent)
        state_fails.sort(key=lambda f: f.get("time") or 0)
        if len(state_fails) > state.FAILS_LIMIT:
            del state_fails[: len(state_fails) - state.FAILS_LIMIT]
    state.RECENT_BACKFILL_DONE = True
    state.save_state()
    print(f"[kimi-token-watcher] 事件流历史回补完成：新增 {added} 条事件 / {added_f} 条失败明细"
          f"（窗口 {state.RECENT_BACKFILL_DAYS} 天）")


def backfill_ext_text():
    """一次性回填：给已在事件流里的 zcode/dsh 历史事件补上输入/输出文本。
    旧版本采集器不挂文本，升级后已有事件 input_text/output_text 为空；
    复用两个采集器的 backfill_recent（cutoff=0 全量）重建 (time, session, model)
    → 文本映射，原地更新 STATE["recent"]（只补文本，不动其他任何字段）。
    完成后置 state.EXT_TEXT_BACKFILL_DONE 并持久化，后续启动跳过。"""
    if state.EXT_TEXT_BACKFILL_DONE:
        return
    textmap = {}
    try:
        import collector_zcode
        for it in collector_zcode.backfill_recent(0)[0]:
            if it.get("input_text") or it.get("output_text"):
                textmap[(it["time"], it["session"], it["model"])] = (
                    it["input_text"], it["output_text"])
    except Exception as e:
        state.add_error(f"ext text backfill zcode: {e}")
    try:
        import collector_dsh
        for it in collector_dsh.backfill_recent(0)[0]:
            if it.get("input_text") or it.get("output_text"):
                textmap[(it["time"], it["session"], it["model"])] = (
                    it["input_text"], it["output_text"])
    except Exception as e:
        state.add_error(f"ext text backfill dsh: {e}")
    n = 0
    with state.LOCK:
        for r in state.STATE["recent"]:
            if (r.get("source") or "kimi") == "kimi":
                continue
            if r.get("input_text") or r.get("output_text"):
                continue
            t = textmap.get((r.get("time"), r.get("session"), r.get("model")))
            if t:
                r["input_text"], r["output_text"] = t
                n += 1
    state.EXT_TEXT_BACKFILL_DONE = True
    state.save_state()
    print(f"[kimi-token-watcher] 外部源事件文本回填完成：补文本 {n} 条")


def backfill_all():
    """启动后台线程入口：事件流历史回补 + 外部源文本回填（各自带一次性标记）。"""
    backfill_recent()
    backfill_ext_text()
