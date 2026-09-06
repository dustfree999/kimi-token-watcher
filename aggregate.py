#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 实时监控 —— 聚合槽位与记录累加
==============================================
把 usage.record / llm.request / turn.ended(failed) 记录累加进共享 STATE
（定义于 state 模块）。包含日期/小时解析（day_of / hour_of）与各维度聚合
槽位（*_slot）、apply_record / apply_request / apply_turn_end。

注意：is_fork_copy 定义于 collector 模块（元数据/扫描相关），此处通过
函数内延迟导入引用，避免 aggregate <-> collector 的模块循环依赖。
"""

import datetime
import time

from state import (LOCK, STATE, RECENT_LIMIT, FAILS_LIMIT,
                   SEEN_USAGE, SEEN_USAGE_G, SEEN_REQ, SEEN_REQ_G,
                   SEEN_TURN, SEEN_TURN_G,
                   SEEN_OLD_THRESHOLD_MS)


def day_of(ts_ms):
    """毫秒时间戳 -> 本地日期 'YYYY-MM-DD'，未来时间(时钟偏差)按当前日期归拢。"""
    now = datetime.datetime.now()
    try:
        dt = datetime.datetime.fromtimestamp(ts_ms / 1000.0)
    except (ValueError, OSError, OverflowError):
        return now.strftime("%Y-%m-%d")
    if dt > now + datetime.timedelta(minutes=1):
        return now.strftime("%Y-%m-%d")
    return dt.strftime("%Y-%m-%d")


def hour_of(ts_ms):
    try:
        return datetime.datetime.fromtimestamp(ts_ms / 1000.0).hour
    except (ValueError, OSError, OverflowError):
        return datetime.datetime.now().hour


def _slot(days, date):
    s = days.get(date)
    if s is None:
        s = {
            "date": date,
            "inputOther": 0, "inputCacheRead": 0, "inputCacheCreation": 0,
            "output": 0, "calls": 0, "requests": 0, "failed": 0,
            "by_model": {}, "by_session": {}, "hourly": {},
            "by_scope": {},  # { "main": {...}, "subagent": {...} }
            "by_source": {},  # 外部源（zcode/dsh）独立槽，不进顶层总量
        }
        days[date] = s
    return s


def _source_slot(s, source):
    """外部数据源（zcode/dsh）的日槽位：只存 by_source，不进顶层总量。"""
    if "by_source" not in s:
        s["by_source"] = {}  # 兼容旧存档
    x = s["by_source"].get(source)
    if x is None:
        x = {"source": source, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0, "by_model": {}, "hourly": {}}
        s["by_source"][source] = x
    return x


def _scope_slot(s, scope):
    x = s["by_scope"].get(scope)
    if x is None:
        x = {"scope": scope, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0, "by_model": {}}
        s["by_scope"][scope] = x
    elif "by_model" not in x:
        # 兼容旧版 data.json：旧格式的 scope 槽位没有 by_model 键，
        # 首次访问前补齐，避免 _scope_model_slot 抛 KeyError。
        x["by_model"] = {}
    return x


def _scope_model_slot(x, model):
    """by_scope[scope] 下再按模型聚合的槽位。"""
    m = x["by_model"].get(model)
    if m is None:
        m = {"model": model, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0}
        x["by_model"][model] = m
    return m


def _model_slot(s, model):
    m = s["by_model"].get(model)
    if m is None:
        # 不预建 "hourly" 死字段：kimi 路径的模型槽由 _model_hour_slot 按需
        # 创建并填充；外部源（zcode/dsh）的 by_source 模型槽从不累计小时数据。
        m = {"model": model, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0}
        s["by_model"][model] = m
    elif "hourly" not in m:
        # 兼容旧存档：已存在但无 hourly 的模型槽位补齐
        m["hourly"] = {}
    return m


def _model_hour_slot(m, h):
    """by_model[model] 下按小时聚合的槽位。"""
    key = str(h)
    if "hourly" not in m:
        m["hourly"] = {}
    hh = m["hourly"].get(key)
    if hh is None:
        hh = {"input": 0, "cached": 0, "output": 0, "calls": 0, "requests": 0, "cacheWrite": 0}
        m["hourly"][key] = hh
    return hh


def _session_slot(s, session):
    x = s["by_session"].get(session)
    if x is None:
        x = {"session": session, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0, "by_model": {}, "hourly": {}}
        s["by_session"][session] = x
    return x


def _session_model_slot(x, model):
    m = x["by_model"].get(model)
    if m is None:
        m = {"model": model, "inputOther": 0, "inputCacheRead": 0,
             "inputCacheCreation": 0, "output": 0, "calls": 0, "requests": 0,
             "failed": 0}
        x["by_model"][model] = m
    return m


def _session_hour_slot(x, h):
    key = str(h)  # 统一 str 键，避免 int/str 混存导致 JSON 序列化丢数据
    hh = x["hourly"].get(key)
    if hh is None:
        hh = {"input": 0, "cached": 0, "output": 0, "calls": 0, "requests": 0}
        x["hourly"][key] = hh
    return hh


def _hour_slot(s, h):
    key = str(h)  # 统一 str 键，避免 int/str 混存导致 JSON 序列化丢数据
    hh = s["hourly"].get(key)
    if hh is None:
        # 注意：旧存档的 hourly 条目可能没有 cacheWrite 键，
        # 累加处一律 .get("cacheWrite", 0) 兜底（见 apply_record）。
        hh = {"input": 0, "cached": 0, "output": 0, "calls": 0, "requests": 0,
              "cacheWrite": 0}
        s["hourly"][key] = hh
    return hh


def _num(d, k):
    v = d.get(k)
    return v if isinstance(v, (int, float)) else 0


def apply_record(rec):
    """把一条 usage.record 记录累加到 STATE。"""
    with LOCK:
        # 排除 session 级快照记录：它与 turn 级记录是同一用量的重复统计
        if rec.get("usageScope") == "session":
            return

        source = rec.get("source") or "kimi"

        us = rec.get("usage") or {}
        other = _num(us, "inputOther")
        cached = _num(us, "inputCacheRead")
        creation = _num(us, "inputCacheCreation")
        out = _num(us, "output")

        ts = rec.get("time") or time.time() * 1000
        session = rec.get("session_id") or "(unknown)"

        # Fork 会话复制段：fork 会话会把父会话的历史 wire 整段复制，
        # 复制段内记录的 time 早于 fork 创建时刻，直接跳过避免重复计数。
        # （延迟导入：is_fork_copy 定义于 collector 模块，避免模块循环依赖）
        from collector import is_fork_copy
        if source == "kimi" and is_fork_copy(session, ts):
            return

        # 指纹去重（三层防线，见 state 模块文件头注释）。
        # 主指纹含来源 src：不同会话/Agent 的同毫秒同模型同 token 数记录不再误去重。
        # 外部源（zcode/dsh）的记录天然是历史回放（表/文件水位重扫），唯一身份
        # 由 src 承担（zcode 用 rowid、dsh 用 msg_id），指纹去掉 ts —— 否则
        # 水位变化触发整文件重扫时，同一条消息因重扫时刻不同而重复计数。
        if source != "kimi":
            fp = ("ext", rec.get("src") or f"{source}:{rec.get('model')}",
                  rec.get("model"), other, out, cached, creation)
            if fp in SEEN_USAGE:
                return
            SEEN_USAGE.add(fp)
        else:
            fp = (ts, rec.get("src") or "", rec.get("model"), other, out, cached, creation)
            fp_g = (ts, rec.get("model"), other, out, cached, creation)
            # 老记录回放（距当前处理时刻超 10 分钟）：只查全局兜底集合丢弃；
            # 活并发记录被扫描时永远不超 10 分钟，走主指纹不会误杀。
            if time.time() * 1000 - ts > SEEN_OLD_THRESHOLD_MS:
                if fp_g in SEEN_USAGE_G:
                    return
            else:
                if fp in SEEN_USAGE:
                    return
                SEEN_USAGE.add(fp)
            SEEN_USAGE_G.add(fp_g)  # 通过（被计数）的记录同时加入全局兜底集合

        date = day_of(ts)
        s = _slot(STATE["days"], date)
        model = rec.get("model") or "(unknown)"
        scope = rec.get("scope") or "main"

        # 外部数据源（zcode/dsh）：只写 by_source 槽，不进顶层总量/scope/session
        if source != "kimi":
            ss = _source_slot(s, source)
            ss["inputOther"] = ss.get("inputOther", 0) + other
            ss["inputCacheRead"] = ss.get("inputCacheRead", 0) + cached
            ss["inputCacheCreation"] = ss.get("inputCacheCreation", 0) + creation
            ss["output"] = ss.get("output", 0) + out
            ss["calls"] = ss.get("calls", 0) + 1

            m = _model_slot(ss, model)
            m["inputOther"] = m.get("inputOther", 0) + other
            m["inputCacheRead"] = m.get("inputCacheRead", 0) + cached
            m["inputCacheCreation"] = m.get("inputCacheCreation", 0) + creation
            m["output"] = m.get("output", 0) + out
            m["calls"] = m.get("calls", 0) + 1

            h = hour_of(ts)
            hh = _hour_slot(ss, h)
            hh["input"] = hh.get("input", 0) + other
            hh["cached"] = hh.get("cached", 0) + cached
            hh["output"] = hh.get("output", 0) + out
            hh["calls"] = hh.get("calls", 0) + 1
            hh["cacheWrite"] = hh.get("cacheWrite", 0) + creation

            state_recent = STATE["recent"]
            if not rec.get("replay"):  # 历史回放不推实时事件流（避免首次全扫淹没 kimi 实时事件）
                state_recent.append({
                    "time": int(ts), "date": date, "hour": h,
                    "model": model, "session": session, "scope": scope,
                    "input": int(other), "cached": int(cached), "output": int(out),
                    "total": int(other + cached + out),
                    "eventId": STATE["recent_seq"],
                    "kind": "usage",
                    "source": source,
                    "input_text": rec.get("input_text") or "",
                    "output_text": rec.get("output_text") or "",
                })
                STATE["recent_seq"] = STATE.get("recent_seq", 0) + 1
                if len(state_recent) > RECENT_LIMIT:
                    del state_recent[: len(state_recent) - RECENT_LIMIT]
            return

        # 兼容旧存档缺键：一律用 .get(k, 0) + v 防御累加
        s["inputOther"] = s.get("inputOther", 0) + other
        s["inputCacheRead"] = s.get("inputCacheRead", 0) + cached
        s["inputCacheCreation"] = s.get("inputCacheCreation", 0) + creation
        s["output"] = s.get("output", 0) + out
        s["calls"] = s.get("calls", 0) + 1

        sc = _scope_slot(s, scope)
        sc["inputOther"] = sc.get("inputOther", 0) + other
        sc["inputCacheRead"] = sc.get("inputCacheRead", 0) + cached
        sc["inputCacheCreation"] = sc.get("inputCacheCreation", 0) + creation
        sc["output"] = sc.get("output", 0) + out
        sc["calls"] = sc.get("calls", 0) + 1
        scm = _scope_model_slot(sc, model)
        scm["inputOther"] = scm.get("inputOther", 0) + other
        scm["inputCacheRead"] = scm.get("inputCacheRead", 0) + cached
        scm["inputCacheCreation"] = scm.get("inputCacheCreation", 0) + creation
        scm["output"] = scm.get("output", 0) + out
        scm["calls"] = scm.get("calls", 0) + 1

        m = _model_slot(s, model)
        m["inputOther"] = m.get("inputOther", 0) + other
        m["inputCacheRead"] = m.get("inputCacheRead", 0) + cached
        m["inputCacheCreation"] = m.get("inputCacheCreation", 0) + creation
        m["output"] = m.get("output", 0) + out
        m["calls"] = m.get("calls", 0) + 1

        x = _session_slot(s, session)
        # 置位主/子会话标记，供前端区分主/子会话（缺失的键保持缺失）
        if scope == "main":
            x["has_main"] = True
        else:
            x["has_sub"] = True
        x["inputOther"] = x.get("inputOther", 0) + other
        x["inputCacheRead"] = x.get("inputCacheRead", 0) + cached
        x["inputCacheCreation"] = x.get("inputCacheCreation", 0) + creation
        x["output"] = x.get("output", 0) + out
        x["calls"] = x.get("calls", 0) + 1
        sm = _session_model_slot(x, model)
        sm["inputOther"] = sm.get("inputOther", 0) + other
        sm["inputCacheRead"] = sm.get("inputCacheRead", 0) + cached
        sm["inputCacheCreation"] = sm.get("inputCacheCreation", 0) + creation
        sm["output"] = sm.get("output", 0) + out
        sm["calls"] = sm.get("calls", 0) + 1

        h = hour_of(ts)
        hh = _hour_slot(s, h)
        hh["input"] = hh.get("input", 0) + other
        hh["cached"] = hh.get("cached", 0) + cached
        hh["output"] = hh.get("output", 0) + out
        hh["calls"] = hh.get("calls", 0) + 1
        hh["cacheWrite"] = hh.get("cacheWrite", 0) + creation
        sh = _session_hour_slot(x, h)
        sh["input"] = sh.get("input", 0) + other
        sh["cached"] = sh.get("cached", 0) + cached
        sh["output"] = sh.get("output", 0) + out
        sh["calls"] = sh.get("calls", 0) + 1
        sh["cacheWrite"] = sh.get("cacheWrite", 0) + creation
        mh = _model_hour_slot(m, h)
        mh["input"] = mh.get("input", 0) + other
        mh["cached"] = mh.get("cached", 0) + cached
        mh["output"] = mh.get("output", 0) + out
        mh["calls"] = mh.get("calls", 0) + 1
        mh["cacheWrite"] = mh.get("cacheWrite", 0) + creation

        # 实时事件流：保留最近若干条原始记录（eventId 服务运行期内唯一）
        state_recent = STATE["recent"]
        state_recent.append({
            "time": int(ts), "date": date, "hour": h,
            "model": model, "session": session, "scope": scope,
            "input": int(other), "cached": int(cached), "output": int(out),
            "total": int(other + cached + out),
            "eventId": STATE["recent_seq"],
            "kind": "usage",
            "source": source,
            "input_text": rec.get("input_text") or "",
            "output_text": rec.get("output_text") or "",
        })
        STATE["recent_seq"] = STATE.get("recent_seq", 0) + 1
        if len(state_recent) > RECENT_LIMIT:
            del state_recent[: len(state_recent) - RECENT_LIMIT]


def apply_request(rec):
    """把一条 llm.request 事件（step 级请求）累加到 STATE，仅计数。"""
    with LOCK:
        # 外部数据源没有 request 事件，直接跳过
        if (rec.get("source") or "kimi") != "kimi":
            return
        model = rec.get("modelAlias") or rec.get("model") or "(unknown)"
        ts = rec.get("time") or time.time() * 1000
        session = rec.get("session_id") or "(unknown)"

        # fork 会话复制段跳过（同 usage.record）
        # （延迟导入：is_fork_copy 定义于 collector 模块，避免模块循环依赖）
        from collector import is_fork_copy
        if is_fork_copy(session, ts):
            return

        # 指纹去重（fork 复制段 + 极端重复的三层防线，见 state 模块文件头注释）。
        # 主指纹含来源 src 与 turnStep（llm.request 自带，如 "0.1"，缺失用空串）。
        fp = (ts, rec.get("src") or "", model, rec.get("turnStep") or "")
        fp_g = (ts, model)
        # 老记录回放（距当前处理时刻超 10 分钟）：只查全局兜底集合
        if time.time() * 1000 - ts > SEEN_OLD_THRESHOLD_MS:
            if fp_g in SEEN_REQ_G:
                return
        else:
            if fp in SEEN_REQ:
                return
            SEEN_REQ.add(fp)
        SEEN_REQ_G.add(fp_g)  # 通过（被计数）的记录同时加入全局兜底集合

        date = day_of(ts)
        s = _slot(STATE["days"], date)
        scope = rec.get("scope") or "main"

        # 兼容旧存档缺键：一律用 .get(k, 0) + v 防御累加
        s["requests"] = s.get("requests", 0) + 1

        m = _model_slot(s, model)
        m["requests"] = m.get("requests", 0) + 1

        sc = _scope_slot(s, scope)
        sc["requests"] = sc.get("requests", 0) + 1
        scm = _scope_model_slot(sc, model)
        scm["requests"] = scm.get("requests", 0) + 1

        x = _session_slot(s, session)
        # 置位主/子会话标记，供前端区分主/子会话（缺失的键保持缺失）
        if scope == "main":
            x["has_main"] = True
        else:
            x["has_sub"] = True
        x["requests"] = x.get("requests", 0) + 1
        sm = _session_model_slot(x, model)
        sm["requests"] = sm.get("requests", 0) + 1

        h = hour_of(ts)
        hh = _hour_slot(s, h)
        hh["requests"] = hh.get("requests", 0) + 1
        sh = _session_hour_slot(x, h)
        sh["requests"] = sh.get("requests", 0) + 1


def apply_turn_end(rec):
    """把一条 turn.ended(failed) 事件累加到 STATE（调用失败统计）。
    结构仿照 apply_record：锁内处理、fork 复制段跳过、三层指纹去重、
    各层 failed 累加（hourly 不统计失败）、追加 recent 失败事件并裁剪。
    只有 reason == "failed" 才统计（cancelled 为用户主动取消，不算失败）。"""
    with LOCK:
        if rec.get("reason") != "failed":
            return

        source = rec.get("source") or "kimi"

        ts = rec.get("time") or time.time() * 1000
        session = rec.get("session_id") or "(unknown)"

        # fork 会话复制段跳过（同 usage.record）
        # （延迟导入：is_fork_copy 定义于 collector 模块，避免模块循环依赖）
        from collector import is_fork_copy
        if source == "kimi" and is_fork_copy(session, ts):
            return

        # 指纹去重（三层防线，见 state 模块文件头注释）。turn.ended 本身无 model
        # 字段，主指纹用 (ts, src, turnId)；老记录回放只查全局兜底 (ts, turnId)。
        # 外部源的 turnId 加 source 前缀，避免与 kimi 的 turnId 撞全局兜底；
        # 其指纹同样去掉 ts：以 turnId 为准，保证水位重扫幂等（同源同回合只计一次）。
        # 主指纹保持 3 元（ts, src, turnId）结构：外部源首个元素用占位串 "ext"，
        # 第二个元素放 source，与 seen_turn 表 3 列兼容。
        turn_id = rec.get("turnId")
        if source != "kimi":
            turn_id = f"{source}:{turn_id}"
            fp = ("ext", source, turn_id)
            if fp in SEEN_TURN:
                return
            SEEN_TURN.add(fp)
        else:
            fp = (ts, rec.get("src") or "", turn_id)
            fp_g = (ts, turn_id)
            if time.time() * 1000 - ts > SEEN_OLD_THRESHOLD_MS:
                if fp_g in SEEN_TURN_G:
                    return
            else:
                if fp in SEEN_TURN:
                    return
                SEEN_TURN.add(fp)
            SEEN_TURN_G.add(fp_g)  # 通过（被计数）的记录同时加入全局兜底集合

        date = day_of(ts)
        s = _slot(STATE["days"], date)

        # 外部数据源（zcode/dsh）：失败只记 by_source 槽，不进顶层 requests/fails
        # （顶部守卫已保证 reason == "failed"）
        if source != "kimi":
            ss = _source_slot(s, source)
            ss["failed"] = ss.get("failed", 0) + 1
            model = rec.get("model") or "(unknown)"
            fm = _model_slot(ss, model)
            fm["failed"] = fm.get("failed", 0) + 1
            scope = rec.get("scope") or "main"
            err = rec.get("error") or {}
            err_code = err.get("code") or ""
            err_msg = (err.get("message") or "")[:300]

            state_recent = STATE["recent"]
            if not rec.get("replay"):  # 历史回放不推实时事件流/失败缓冲
                state_recent.append({
                    "time": int(ts), "date": date, "hour": hour_of(ts),
                    "model": model, "session": session, "scope": scope,
                    "input": 0, "cached": 0, "output": 0, "total": 0,
                    "eventId": STATE["recent_seq"],
                    "kind": "failed",
                    "source": source,
                    "err_code": err_code,
                    "err_msg": err_msg,
                    "input_text": rec.get("input_text") or "",
                    "output_text": "",
                })
                STATE["recent_seq"] = STATE.get("recent_seq", 0) + 1
                if len(state_recent) > RECENT_LIMIT:
                    del state_recent[: len(state_recent) - RECENT_LIMIT]

                state_fails = STATE["fails"]
                state_fails.append({
                    "time": int(ts), "date": date, "hour": hour_of(ts),
                    "model": model, "session": session, "scope": scope,
                    "source": source,
                    "err_code": err_code, "err_msg": err_msg,
                })
                if len(state_fails) > FAILS_LIMIT:
                    del state_fails[: len(state_fails) - FAILS_LIMIT]
            return

        # 模型归属：turn.ended 无 model 字段，取该 wire 最近一次 llm.request 的模型
        model = STATE["last_model"].get(rec.get("src") or "") or "(unknown)"
        scope = rec.get("scope") or "main"

        # 兼容旧存档缺键：一律用 .get(k, 0) + v 防御累加（hourly 不加 failed）
        s["failed"] = s.get("failed", 0) + 1

        sc = _scope_slot(s, scope)
        sc["failed"] = sc.get("failed", 0) + 1
        scm = _scope_model_slot(sc, model)
        scm["failed"] = scm.get("failed", 0) + 1

        m = _model_slot(s, model)
        m["failed"] = m.get("failed", 0) + 1

        x = _session_slot(s, session)
        # 置位主/子会话标记，供前端区分主/子会话（缺失的键保持缺失）
        if scope == "main":
            x["has_main"] = True
        else:
            x["has_sub"] = True
        x["failed"] = x.get("failed", 0) + 1
        sm = _session_model_slot(x, model)
        sm["failed"] = sm.get("failed", 0) + 1

        err = rec.get("error") or {}
        err_code = err.get("code") or ""
        err_msg = (err.get("message") or "")[:300]

        # 实时事件流：失败回合事件（input/cached/output/total 全为 0）
        state_recent = STATE["recent"]
        state_recent.append({
            "time": int(ts), "date": date, "hour": hour_of(ts),
            "model": model, "session": session, "scope": scope,
            "input": 0, "cached": 0, "output": 0, "total": 0,
            "eventId": STATE["recent_seq"],
            "kind": "failed",
            "source": source,
            "err_code": err_code,
            "err_msg": err_msg,
            "input_text": rec.get("input_text") or "",
            "output_text": "",
        })
        STATE["recent_seq"] = STATE.get("recent_seq", 0) + 1
        if len(state_recent) > RECENT_LIMIT:
            del state_recent[: len(state_recent) - RECENT_LIMIT]

        # 失败明细缓冲（独立于 recent，供模型详情等页面回溯历史失败）
        state_fails = STATE["fails"]
        state_fails.append({
            "time": int(ts), "date": date, "hour": hour_of(ts),
            "model": model, "session": session, "scope": scope,
            "source": source,
            "err_code": err_code, "err_msg": err_msg,
        })
        if len(state_fails) > FAILS_LIMIT:
            del state_fails[: len(state_fails) - FAILS_LIMIT]
