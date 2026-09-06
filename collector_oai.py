#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oaicopilot 采集器：解析 VSCode oai-compatible-copilot 插件的请求日志。

插件（johnny-zhao.oai-compatible-copilot）把 Copilot Chat 接到 OpenAI 兼容的
三方模型，每次流式请求结束在 finally 里调用 reportUsage()，以 INFO 级别写一条
usage.report 到 ~/.copilot/oaicopilot/logs/oaicopilot-YYYYMMDD.log：

    {"ts":"2026-08-22T08:45:13.521Z","level":"info","tag":"usage.report",
     "data":{"modelId":"K3","usage":{"prompt_tokens":1234,
             "completion_tokens":567,"total_tokens":1801,
             "prompt_tokens_details":{"cached_tokens":100}}}}

数据事实（来自插件源码 out/*/…Api.js，六条 API 路径已逐一核对）：
- usage 统一归一化为 prompt_tokens / completion_tokens / total_tokens，
  可选 prompt_tokens_details.cached_tokens（OpenAI/Responses/Gemini 路径）；
  Anthropic 路径把 input+cache_creation+cache_read 合并进 prompt_tokens，
  缓存拆分不可还原，cached 只能取 OpenAI 系路径提供的值。
- usage.report 每次真实 API 调用恰好一条（含重试：重试是独立计费的独立调用）；
  debug 级别的 usage.capture 与之重复，绝不统计。
- 日志按天分文件，插件自动清理 7 天前的旧文件；无 session/会话概念，
  会话维度统一归入 "oaicopilot:chat"。
- 前置条件：VSCode 设置 "oaicopilot.logLevel" >= "info"，否则不落任何日志
  （历史数据无法回补，只能统计开启之后的调用）。

与 kimi 主采集器完全隔离：记录带 source="oaicopilot"，聚合层只写
days[date].by_source.oaicopilot 槽，不碰顶层 kimi 总量。

水位：ext_state["oai_files"][path] = offset（字节偏移，同 kimi tracked_files）。
文件为追加写，只读新追加部分；offset > size 视为截断/重建，从 0 重放
（重放行由 aggregate 的外部源指纹去重兜底）。首次见到的文件整体按历史回放处理
（replay=True，不推实时事件流），之后该文件的追加按实时事件处理。
"""

import glob
import json
import os
import time

import state
from aggregate import apply_record
from state import LOCK, STATE, POLL_INTERVAL

OAI_LOG_DIR = os.path.expanduser("~/.copilot/oaicopilot/logs")
# 无会话概念，统一会话桶（聚合按天分槽，桶内即“当天全部 Copilot 调用”）
OAI_SESSION = "oaicopilot:chat"


def _ts_to_ms(s):
    """ISO 时间串 -> 毫秒时间戳。插件用 JS toISOString()（固定 3 位毫秒+Z），
    防御性兼容其他精度与时区写法；解析失败返回当前时刻。"""
    if not isinstance(s, str) or not s:
        return int(time.time() * 1000)
    try:
        t = s.strip()
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        # 截断超长小数位（fromisoformat 只认最多 6 位）
        head, sep, frac = t.partition(".")
        if sep and frac:
            digits = ""
            rest = frac
            while rest and rest[0].isdigit():
                digits += rest[0]
                rest = rest[1:]
            t = head + "." + (digits[:6].ljust(3, "0")) + rest
        from datetime import datetime
        return int(datetime.fromisoformat(t).timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def _normalize_usage(usage):
    """把插件日志里的 usage 对象转成 aggregate 口径：
    返回 (inputOther, cacheRead, cacheCreation, output)。"""
    if not isinstance(usage, dict):
        return 0, 0, 0, 0

    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    prompt = _int(usage.get("prompt_tokens"))
    output = _int(usage.get("completion_tokens"))
    details = usage.get("prompt_tokens_details") or {}
    cached = _int(details.get("cached_tokens") if isinstance(details, dict) else None)
    cached = min(cached, prompt)  # 防御：cached 不应超过 prompt
    return max(prompt - cached, 0), cached, 0, output


def _apply_line(obj, replay):
    """处理一行 JSONL，只认 tag == "usage.report"。"""
    if obj.get("tag") != "usage.report":
        return
    data = obj.get("data") or {}
    model = str(data.get("modelId") or "(unknown)")
    other, cached, creation, out = _normalize_usage(data.get("usage"))
    if other <= 0 and cached <= 0 and out <= 0:
        return
    apply_record({
        "time": _ts_to_ms(obj.get("ts")),
        "session_id": OAI_SESSION,
        "model": model,
        "scope": "main",
        "source": "oaicopilot",
        "src": f"oai:{obj.get('ts')}:{model}",
        "replay": replay,  # 历史回放不推实时事件流
        "usage": {
            "inputOther": other,
            "inputCacheRead": cached,
            "inputCacheCreation": creation,
            "output": out,
        },
        "input_text": "",   # 插件日志不含对话文本
        "output_text": "",
    })


def _iter_log_files():
    if not os.path.isdir(OAI_LOG_DIR):
        return
    for path in glob.glob(os.path.join(OAI_LOG_DIR, "oaicopilot-*.log")):
        yield path


def _read_new_lines(path, offset):
    """从字节偏移 offset 起读一个日志文件的完整行。
    返回 (new_offset, lines)；无完整新行时 new_offset == offset。"""
    with open(path, "rb") as fh:
        fh.seek(offset)
        raw = fh.read()
    nl = raw.rfind(b"\n")
    if nl == -1:
        return offset, []
    text = raw[:nl].decode("utf-8", errors="replace")
    return offset + nl + 1, text.split("\n")


def scan_once():
    if not os.path.isdir(OAI_LOG_DIR):
        return
    with LOCK:
        marks = dict(STATE["ext_state"].get("oai_files") or {})
    new_marks = {}
    first_seen = False
    for path in _iter_log_files():
        mark = marks.get(path)
        first_seen = first_seen or mark is None
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        orig_offset = int(mark or 0)
        # 文件被截断/重建：从头重放，按回放口径处理（指纹去重兜底）
        truncated = orig_offset > size
        replay = mark is None or truncated
        try:
            new_offset, lines = _read_new_lines(path, 0 if truncated else orig_offset)
        except OSError:
            continue  # 文件被插件清理等瞬时错误，下轮重试
        for ln in lines:
            ln = ln.strip()
            if not ln:
                continue
            try:
                obj = json.loads(ln)
            except Exception:
                continue  # 写到一半的尾行 / 非 JSON 行
            if not isinstance(obj, dict):
                continue
            try:
                _apply_line(obj, replay=replay)
            except Exception as e:
                state.add_error(f"[oai] line: {type(e).__name__}: {e}")
        new_marks[path] = new_offset

    # 插件按 7 天保留期清理旧文件：同步清掉已消失文件的水位条目
    gone = set(marks) - set(new_marks)

    if first_seen or gone or new_marks != marks:
        with LOCK:
            STATE["ext_state"]["oai_files"] = dict(new_marks)
        if first_seen:
            state.save_state()  # 固化首扫水位，防止重启后整目录重放


def backfill_recent(cutoff_ms):
    """一次性回补：全量重读所有日志，把窗口内（>= cutoff_ms）的 usage.report
    转成 recent 展示条目，返回 (recent_items, fails_items)。
    只补展示层：不走 _apply_line/apply_record，不动聚合、指纹与水位。
    日志里没有失败事件（失败请求拿不到 usage），fails 恒为空。"""
    from collector import _recent_usage_entry
    items = []
    for path in _iter_log_files():
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for ln in fh:
                    ln = ln.strip()
                    if not ln:
                        continue
                    try:
                        obj = json.loads(ln)
                    except Exception:
                        continue
                    if not isinstance(obj, dict) or obj.get("tag") != "usage.report":
                        continue
                    ts = _ts_to_ms(obj.get("ts"))
                    if ts < cutoff_ms:
                        continue
                    data = obj.get("data") or {}
                    other, cached, _, out = _normalize_usage(data.get("usage"))
                    if other <= 0 and cached <= 0 and out <= 0:
                        continue
                    items.append(_recent_usage_entry(
                        ts, str(data.get("modelId") or "(unknown)"),
                        OAI_SESSION, "main", "oaicopilot", other, cached, out))
        except OSError:
            continue
    return items, []


def collector_loop():
    i = 0
    while True:
        try:
            scan_once()
        except Exception as e:
            state.add_error(f"[oai] scan failed: {type(e).__name__}: {e}")
        i += 1
        if i % 15 == 0:
            try:
                state.save_state()
            except Exception:
                pass
        time.sleep(POLL_INTERVAL)
