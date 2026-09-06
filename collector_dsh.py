"""dsh 采集器：解析 ~/.dsh/sessions/**/session.jsonl.zstd（zstd 压缩的 JSONL）。

与 kimi 主采集器完全隔离：dsh 记录带 source="dsh"，聚合层只把它们
写进 days[date].by_source.dsh 槽，不碰顶层 kimi 总量。

数据事实（来自真实文件分析）：
- 首行 {"type":"session","id":"session-...","createdAt":ms,"cwd":...}
- 用量只在 {"type":"assistant/message"} 行：
    data.usage = {"inputTokens": N, "outputTokens": N}（camelCase）
    data.message.source.model = 模型名；data.message.id = 消息 id（入指纹）
  ⚠️ assistant/chunk 里的 usage 事件是同一份数据的流式重复，绝不能计。
- {"type":"turn/end"} 的失败原因在 data.reason.kind
- {"type":"session/title"} 的标题在 data.title（可能 GBK 乱码，试修复）

水位：ext_state["dsh_files"][path] = {"mtime":..., "size":...}。
文件是追加写的，mtime/size 变了就整文件流式重解——重复记录由
aggregate 的全局指纹（含 dsh: 命名空间的 message id）自动去重。
"""

import glob
import json
import os
import time
import traceback

import state
from aggregate import apply_record, apply_turn_end
from state import LOCK, STATE, POLL_INTERVAL

try:
    import zstandard
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False

DSH_DIR = os.path.expanduser("~/.dsh/sessions")

_title_cache = {}
_zstd_warned = False


def _fix_title(s):
    """dsh 的 title 事件可能出现 latin-1 误解的 GBK 字节，尝试修复。"""
    if not isinstance(s, str) or not s:
        return s
    s = s.strip().strip('"').strip()
    try:
        raw = s.encode("latin-1")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s[:80]
    for enc in ("gbk", "utf-8"):
        try:
            fixed = raw.decode(enc)
            if fixed and not any("\ufffd" in fixed):
                return fixed[:80]
        except (UnicodeDecodeError, UnicodeEncodeError):
            continue
    return s[:80]


def _content_text(content):
    """从 message.content（[{"type":"text","text":...}] 或字符串）提取纯文本。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            c["text"] for c in content
            if isinstance(c, dict) and c.get("type") == "text" and c.get("text")
        )
    return ""


def _read_lines(path):
    """流式解压 zstd 文件，逐行 yield 文本。"""
    import zstandard as zstd
    dctx = zstd.ZstdDecompressor()
    with open(path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            buf = b""
            while True:
                chunk = reader.read(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        yield line.decode("utf-8", errors="replace")
            if buf.strip():
                yield buf.decode("utf-8", errors="replace")


def _iter_session_files():
    if not os.path.isdir(DSH_DIR):
        return
    for path in glob.glob(os.path.join(DSH_DIR, "**", "session.jsonl.zstd"), recursive=True):
        try:
            st = os.stat(path)
        except OSError:
            continue
        yield path, st.st_mtime, st.st_size


def _apply_line(obj, session_id, session_meta_local, replay=False):
    """处理一行 JSONL。session_id 可能在本行首次出现（session 头）。"""
    t = obj.get("type", "")
    data = obj.get("data") or {}

    if t == "session":
        sid = obj.get("id") or data.get("id")
        if sid:
            session_id[0] = sid
        cwd = obj.get("cwd") or data.get("cwd")
        if cwd:
            session_meta_local.setdefault("cwd", cwd)
        return session_id[0]

    if t == "session/title":
        title = _fix_title(data.get("title") or "")
        if title and session_id[0]:
            session_meta_local["title"] = title
        return session_id[0]

    if t == "user/message":
        # 跟踪最近一条用户输入，供随后的 assistant/message 挂载为 input_text
        # （与 kimi 侧 _track_text 同义）
        txt = _content_text(data.get("content"))
        if txt:
            session_meta_local["_input"] = txt
        return session_id[0]

    if t == "assistant/message":
        if not session_id[0]:
            return session_id[0]
        usage = data.get("usage") or {}
        msg = data.get("message") or {}
        model = ((msg.get("source") or {}).get("model")) or ""
        msg_id = msg.get("id") or ""
        ts = obj.get("time") or 0
        if isinstance(ts, (int, float)) and 0 < ts < 1e12:  # 秒 → 毫秒
            ts = ts * 1000

        in_tokens = int(usage.get("inputTokens") or 0)
        out_tokens = int(usage.get("outputTokens") or 0)
        # 防御性兼容未来可能出现的 cache 字段
        cache_read = 0
        for k in ("cacheReadInputTokens", "cache_read_input_tokens", "cacheReadTokens"):
            if usage.get(k):
                cache_read = int(usage[k])
                break
        cache_creation = 0
        for k in ("cacheCreationInputTokens", "cache_creation_input_tokens", "cacheWriteTokens"):
            if usage.get(k):
                cache_creation = int(usage[k])
                break
        if in_tokens <= 0 and out_tokens <= 0:
            return session_id[0]

        apply_record({
            "time": ts or int(time.time() * 1000),
            "session_id": "dsh:" + session_id[0],
            "model": model,
            "scope": "main",
            "source": "dsh",
            "src": "dsh:" + (msg_id or "line"),
            "replay": replay,  # 首扫回放不推实时事件流
            "usage": {
                "inputOther": max(in_tokens - cache_read, 0),
                "inputCacheRead": cache_read,
                "inputCacheCreation": cache_creation,
                "output": out_tokens,
            },
            # 用户提问（最近的 user/message）+ 本条助手回答文本
            "input_text": (session_meta_local.get("_input") or "")[-600:],
            "output_text": _content_text(msg.get("content"))[-1500:],
        })
        return session_id[0]

    if t == "turn/end":
        reason = ((data.get("reason") or {}).get("kind")) or ""
        if reason == "failed" and session_id[0]:
            ts = obj.get("time") or int(time.time() * 1000)
            if isinstance(ts, (int, float)) and 0 < ts < 1e12:
                ts = ts * 1000
            apply_turn_end({
                "reason": "failed",
                "time": ts,
                "session_id": "dsh:" + session_id[0],
                "source": "dsh",
                "turnId": data.get("turnId") or ("dsh-line-%d" % int(ts)),
                "model": "",
                "scope": "main",
                "replay": replay,  # 首扫回放不推实时事件流/失败缓冲
                "error": {"code": "", "message": ""},
                "src": "dsh",
            })
        return session_id[0]

    return session_id[0]


def scan_once():
    global _zstd_warned
    if not HAS_ZSTD:
        if not _zstd_warned:
            state.add_error("dsh 采集已跳过：缺少 zstandard 库（pip install zstandard）")
            _zstd_warned = True
        return
    if not os.path.isdir(DSH_DIR):
        return

    with LOCK:
        file_marks = dict(STATE["ext_state"].get("dsh_files") or {})

    changed = []
    for path, mtime, size in _iter_session_files():
        mark = file_marks.get(path)
        if mark and mark.get("mtime") == mtime and mark.get("size") == size:
            continue
        changed.append((path, mtime, size))

    if not changed:
        # 标题仍要每轮补进 session_meta（collector_loop 会整体重置）
        if _title_cache:
            with LOCK:
                STATE["session_meta"].update(_title_cache)
        return

    new_marks = dict(file_marks)
    for path, mtime, size in changed:
        # 按文件粒度判断回放：path 尚未入水位（首次出现——包括首次全扫与
        # 此后新建的会话文件）→ 历史回放，不推实时事件流，避免整文件历史
        # 事件挤进 STATE["recent"]；已在水位中的文件是追加写的活动会话，
        # 其 mtime/size 变化带来的行按实时事件处理（replay=False）。
        replay = path not in file_marks
        session_id = [None]
        meta_local = {}
        try:
            for line in _read_lines(path):
                try:
                    obj = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue  # 追加写到一半的尾行
                if not isinstance(obj, dict):
                    continue
                try:
                    _apply_line(obj, session_id, meta_local, replay=replay)
                except Exception:
                    continue
        except Exception as e:
            state.add_error("dsh 文件解析失败 %s: %s" % (os.path.basename(path), e))
            continue  # 不更新水位，下轮重试

        sid = session_id[0]
        if sid:
            key = "dsh:" + sid
            title = meta_local.get("title") or ""
            cwd = meta_local.get("cwd") or ""
            if not title and cwd:
                title = os.path.basename(cwd.rstrip("/\\")) or cwd
            with LOCK:
                _title_cache[key] = {
                    "title": title or key,
                    "cwd": cwd,
                    "is_custom": False,
                }
        new_marks[path] = {"mtime": mtime, "size": size}

    with LOCK:
        STATE["ext_state"]["dsh_files"] = new_marks
        if _title_cache:
            STATE["session_meta"].update(_title_cache)

    # 首次发现历史文件时立即固化水位，防止丢失后重复全量
    if not file_marks and new_marks:
        state.save_state()


def backfill_recent(cutoff_ms):
    """一次性回补：重读所有 session.jsonl.zstd，把窗口内（>= cutoff_ms）的
    assistant/message 与 turn/end(failed) 转成 recent/fails 展示条目，
    返回 (recent_items, fails_items)。
    只补展示层：不走 _apply_line/apply_record，不动聚合、指纹与水位。"""
    from collector import _recent_usage_entry, _recent_failed_entry
    items, fails = [], []
    if not HAS_ZSTD or not os.path.isdir(DSH_DIR):
        return items, fails
    for path, _mtime, _size in _iter_session_files():
        session_id = None
        last_input = ""
        try:
            for line in _read_lines(path):
                try:
                    obj = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(obj, dict):
                    continue
                t = obj.get("type", "")
                data = obj.get("data") or {}
                if t == "session":
                    session_id = obj.get("id") or data.get("id") or session_id
                    continue
                if t == "user/message":
                    txt = _content_text(data.get("content"))
                    if txt:
                        last_input = txt
                    continue
                ts = obj.get("time") or 0
                if isinstance(ts, (int, float)) and 0 < ts < 1e12:  # 秒 → 毫秒
                    ts = ts * 1000
                if not ts or ts < cutoff_ms:
                    continue
                if t == "assistant/message" and session_id:
                    usage = data.get("usage") or {}
                    msg = data.get("message") or {}
                    model = ((msg.get("source") or {}).get("model")) or ""
                    in_tokens = int(usage.get("inputTokens") or 0)
                    out_tokens = int(usage.get("outputTokens") or 0)
                    if in_tokens <= 0 and out_tokens <= 0:
                        continue
                    cache_read = 0
                    for k in ("cacheReadInputTokens", "cache_read_input_tokens",
                              "cacheReadTokens"):
                        if usage.get(k):
                            cache_read = int(usage[k])
                            break
                    entry = _recent_usage_entry(
                        ts, model, "dsh:" + session_id, "main", "dsh",
                        max(in_tokens - cache_read, 0), cache_read, out_tokens)
                    entry["input_text"] = last_input[-600:]
                    entry["output_text"] = _content_text(msg.get("content"))[-1500:]
                    items.append(entry)
                elif t == "turn/end" and session_id:
                    reason = ((data.get("reason") or {}).get("kind")) or ""
                    if reason != "failed":
                        continue
                    entry = _recent_failed_entry(
                        ts, "", "dsh:" + session_id, "main", "dsh", "", "")
                    items.append(entry)
                    fails.append({
                        "time": entry["time"], "date": entry["date"],
                        "hour": entry["hour"],
                        "model": entry["model"], "session": "dsh:" + session_id,
                        "scope": "main", "source": "dsh",
                        "err_code": "", "err_msg": "",
                    })
        except Exception:
            continue  # 单文件解析失败不影响其他文件
    return items, fails


def collector_loop():
    i = 0
    while True:
        try:
            scan_once()
        except Exception:
            state.add_error("dsh 采集循环异常: " + traceback.format_exc(limit=2))
        i += 1
        if i % 15 == 0:
            try:
                state.save_state()
            except Exception:
                pass
        time.sleep(POLL_INTERVAL)
