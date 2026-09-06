#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 实时监控 —— 本地桥服务（入口 + HTTP）
====================================================
- 后台线程每 2 秒增量扫描 ~/.kimi-code/sessions/**/agents/*/wire.jsonl
  （只读新追加的行），解析 type == "usage.record" 的事件并聚合。
- 仅监听 127.0.0.1:8787，纯本地，不联网。
- GET /           -> index.html
- GET /api/usage  -> 聚合 JSON

去重策略（防止 fork 复制段 / 多会话同记录重复计数）：
  a) is_fork_copy 元数据检查（fork 会话复制段直接跳过）；
  b) 主指纹含来源 src（wire 文件绝对路径），区分不同会话/Agent；
  c) 全局兜底集合（不含 src），仅对距当前超过 10 分钟的历史回放记录生效。

模块结构（规范化拆分）：
    state.py     共享状态（STATE / LOCK / SEEN_* / 常量）与持久化
    aggregate.py 聚合槽位与记录累加（apply_record / apply_request）
    collector.py 增量扫描解析与扫描循环
    server.py    本模块：入口 + HTTP 服务（Handler / build_response / main）

用法：
    python server.py [--port 8787] [--dir <sessions根目录>]
"""

import argparse
import datetime
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import state
from collector import boot_replay, collector_loop, shutdown_save, backfill_all
import collector_dsh
import collector_oai
import collector_zcode


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默访问日志（保持终端干净）
        pass

    def _send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name, ctype):
        base = os.path.dirname(os.path.abspath(__file__))
        path = os.path.realpath(os.path.join(base, name))
        # 防路径穿越：解析后的文件必须位于项目根目录内
        if not (path == base or path.startswith(base + os.sep)):
            self.send_response(404)
            self.end_headers()
            return
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # 剥离查询串再匹配路由：支持 /?range=week 等带参数直链
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/events"):
            self._send_json(build_events(self.path))
        elif path.startswith("/api/usage"):
            self._send_json(build_response())
        elif path == "/api/open":
            self._open_dir()
        elif path == "/" or path == "/index.html":
            self._send_file("index.html", "text/html; charset=utf-8")
        elif path.startswith("/js/") and path.endswith(".js"):
            self._send_file(path.lstrip("/"), "application/javascript; charset=utf-8")
        elif path.startswith("/css/") and path.endswith(".css"):
            self._send_file(path.lstrip("/"), "text/css; charset=utf-8")
        else:
            self.send_response(404)
            self.end_headers()

    def _open_dir(self):
        """用系统资源管理器打开数据源目录（仅本机使用）。
        ?source=kimi|zcode|dsh：跟随前端来源筛选打开对应目录；
        zcode 的数据源是 SQLite 文件，打开其所在文件夹。"""
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        source = (qs.get("source") or ["kimi"])[0]
        if source == "zcode":
            target = os.path.dirname(collector_zcode.DB_PATH)
        elif source == "dsh":
            target = collector_dsh.DSH_DIR
        elif source == "oaicopilot":
            target = collector_oai.OAI_LOG_DIR
        else:
            target = state.SESSION_ROOT
        if not os.path.isdir(target):
            target = state.SESSION_ROOT  # 目标不存在时回退 kimi 主目录
        try:
            if os.name == "nt":
                os.startfile(target)  # noqa: S606 本地工具按设计提供
            else:
                import subprocess
                subprocess.Popen(["xdg-open", target])
            self._send_json({"ok": True})
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(e)})

    def do_POST(self):
        self.do_GET()


def build_events(raw_path):
    """事件流服务端分页查询。
    GET /api/events?from=YYYY-MM-DD&to=YYYY-MM-DD&source=all|kimi|zcode|dsh
        &scope=all|main|sub|failed&model=<精确模型名>&page=1&size=20
    返回 {total, page, size, items, models}：
    - items 按时间倒序，含完整输入/输出文本（单页数据量小，无需裁剪）；
    - models 为日期+来源过滤后的可选模型列表（供前端下拉，不受 scope/model 影响）；
    - scope=failed 时改读 fails 失败明细缓冲，映射成事件形态。"""
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(raw_path).query)

    def one(key, default=""):
        v = qs.get(key)
        return v[0] if v and v[0] else default

    today = datetime.datetime.now().strftime("%Y-%m-%d")
    frm = one("from") or today
    to = one("to") or frm
    if frm > to:
        frm, to = to, frm
    source = one("source") or "all"
    scope = one("scope") or "all"
    model = one("model")
    try:
        page = max(1, int(one("page") or 1))
    except ValueError:
        page = 1
    try:
        size = min(200, max(1, int(one("size") or 20)))
    except ValueError:
        size = 20

    with state.LOCK:
        if scope == "failed":
            # fails 条目无 eventId/hour/input_text，映射成事件行形态（与前端旧逻辑一致）
            pool = [{
                "time": f.get("time"), "date": f.get("date"),
                "hour": f.get("hour"),
                "model": f.get("model"), "session": f.get("session"),
                "scope": f.get("scope") or "main",
                "source": f.get("source") or "kimi",
                "kind": "failed",
                "input": 0, "cached": 0, "output": 0, "total": 0,
                "err_code": f.get("err_code") or "",
                "err_msg": f.get("err_msg") or "",
                "input_text": "", "output_text": "",
            } for f in state.STATE["fails"]]
        else:
            pool = [dict(r) for r in state.STATE["recent"]]

    pool = [e for e in pool if frm <= (e.get("date") or "") <= to]
    if source != "all":
        pool = [e for e in pool if (e.get("source") or "kimi") == source]
    models = sorted({e.get("model") for e in pool if e.get("model")})
    if scope == "main":
        pool = [e for e in pool if e.get("scope") != "subagent"]
    elif scope == "sub":
        pool = [e for e in pool if e.get("scope") == "subagent"]
    if model:
        pool = [e for e in pool if e.get("model") == model]
    pool.sort(key=lambda e: e.get("time") or 0, reverse=True)
    total = len(pool)
    return {
        "total": total,
        "page": page,
        "size": size,
        "items": pool[(page - 1) * size: page * size],
        "models": models,
    }


def build_response():
    with state.LOCK:
        now = datetime.datetime.now()
        today = now.strftime("%Y-%m-%d")
        days = json.loads(json.dumps(state.STATE["days"]))  # 深拷贝快照
        last_scan = state.STATE["last_scan_time"]
        errors = list(state.STATE["scan_errors"])
        tracked = dict(state.STATE["tracked_files"])
        recent = sorted(
            (dict(r) for r in state.STATE["recent"]),
            key=lambda r: r["time"], reverse=True
        )[:200]  # 概览/速率只需最新一段；完整事件流走 /api/events 分页查询
        fails = sorted(
            (dict(r) for r in state.STATE["fails"]),
            key=lambda r: r["time"], reverse=True
        )

        # ---- 滚动窗口速率（tokens/分钟）：基于实时事件流 recent（RECENT_LIMIT 条上限） ----
        now_ms = time.time() * 1000
        rates = {}
        for name, mins in (("m1", 1), ("m5", 5), ("m15", 15)):
            cutoff = now_ms - mins * 60 * 1000
            total = sum(r.get("total", 0) for r in state.STATE["recent"]
                        if (r.get("time") or 0) >= cutoff)
            rates[name] = int(total / mins) if total else 0

        # ---- 较昨日趋势（total 口径 = inputOther + inputCacheRead + output） ----
        def tot_of(slot):
            return ((slot.get("inputOther") or 0) + (slot.get("inputCacheRead") or 0)
                    + (slot.get("output") or 0))
        t_today = tot_of(days.get(today)) if days.get(today) else 0
        yesterday = (now - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        t_yest = tot_of(days.get(yesterday)) if days.get(yesterday) else 0
        pct = None if t_yest == 0 else (t_today - t_yest) / t_yest * 100
        vs_yesterday = {"today": t_today, "yesterday": t_yest, "pct": pct}

    # ---- 周 / 月汇总（从 days 聚合） ----
    def sum_days(date_list):
        agg = {"inputOther": 0, "inputCacheRead": 0, "inputCacheCreation": 0,
               "output": 0, "calls": 0, "requests": 0, "days": 0}
        for d in date_list:
            s = days.get(d)
            if not s:
                continue
            agg["inputOther"] += s.get("inputOther", 0)
            agg["inputCacheRead"] += s.get("inputCacheRead", 0)
            agg["inputCacheCreation"] += s.get("inputCacheCreation", 0)
            agg["output"] += s.get("output", 0)
            agg["calls"] += s.get("calls", 0)
            agg["requests"] += s.get("requests", 0)
            agg["days"] += 1
        return agg

    week_dates = [(now - datetime.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(6, -1, -1)]
    month_prefix = today[:7]
    month_dates = [d for d in sorted(days) if d.startswith(month_prefix)]
    week = sum_days(week_dates)
    month = sum_days(month_dates)

    # ---- 今日峰值小时 ----
    today_slot = days.get(today)
    peak_hour = None
    if today_slot:
        best = 0
        for h, v in (today_slot.get("hourly") or {}).items():
            tot = v.get("input", 0) + v.get("cached", 0) + v.get("output", 0) \
                + (v.get("cacheWrite") or 0)
            if tot > best:
                best = tot
                peak_hour = {"hour": h, "total": tot}
    # ---- 当前小时速率（tokens/分钟） ----
    rate_per_min = None
    if today_slot:
        h = str(now.hour)
        hv = (today_slot.get("hourly") or {}).get(h)
        if hv:
            mins = now.minute + 1
            rate_per_min = int((hv.get("input", 0) + hv.get("cached", 0) + hv.get("output", 0)
                                + (hv.get("cacheWrite") or 0)) / max(mins, 1))

    # ---- 来源清单:kimi 恒在(顶层口径),外部源有数据才出现 ----
    labels = {"zcode": "ZCode", "dsh": "DSH", "oaicopilot": "Copilot(OAI)"}
    kimi_calls = sum((d.get("calls") or 0) for d in days.values())
    sources = [{"id": "kimi", "label": "Kimi Code", "calls": kimi_calls}]
    ext_calls = {}
    for d in days.values():
        for src, slot in (d.get("by_source") or {}).items():
            ext_calls[src] = ext_calls.get(src, 0) + (slot.get("calls") or 0)
    for src in sorted(ext_calls):
        if ext_calls[src] > 0:
            sources.append({"id": src, "label": labels.get(src, src), "calls": ext_calls[src]})

    resp = {
        "now": time.time(),
        "today": today,
        "days": days,
        "week": week,
        "month": month,
        "recent": recent,
        "fails": fails,
        "session_root": state.SESSION_ROOT,
        # 各来源的数据源路径（前端侧栏/设置页跟随来源筛选显示，打开目录同口径）
        "source_paths": {
            "kimi": state.SESSION_ROOT,
            "zcode": collector_zcode.DB_PATH,
            "dsh": collector_dsh.DSH_DIR,
            "oaicopilot": collector_oai.OAI_LOG_DIR,
        },
        "rates": rates,
        "vs_yesterday": vs_yesterday,
        "peak_hour": peak_hour,
        "rate_per_min": rate_per_min,
        "session_meta": dict(state.STATE["session_meta"]),
        "prices": state.DEFAULT_PRICES,
        "last_scan": last_scan,
        "tracked_files": len(tracked),
        "errors": errors,
        "sources": sources,
    }
    return resp


def main():
    ap = argparse.ArgumentParser(description="Kimi Code token usage local bridge")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--dir", default=state.SESSION_ROOT, help="sessions 根目录")
    ap.add_argument("--zcode-db", default=None, help="ZCode SQLite 路径(默认 ~/.zcode/cli/db/db.sqlite)")
    ap.add_argument("--dsh-dir", default=None, help="DSH sessions 目录(默认 ~/.dsh/sessions)")
    ap.add_argument("--oai-dir", default=None, help="oaicopilot 日志目录(默认 ~/.copilot/oaicopilot/logs)")
    args = ap.parse_args()
    # 就地更新共享状态（同一对象），供 collector 扫描与 build_response 读取同一目录
    state.SESSION_ROOT = os.path.abspath(args.dir)
    if args.zcode_db:
        collector_zcode.DB_PATH = os.path.abspath(args.zcode_db)
    if args.dsh_dir:
        collector_dsh.DSH_DIR = os.path.abspath(args.dsh_dir)
    if args.oai_dir:
        collector_oai.OAI_LOG_DIR = os.path.abspath(args.oai_dir)

    # 端口冲突防护：已有实例在跑时直接退出，避免新旧两个进程同时写数据文件（现为 data.db）
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", args.port))
        except OSError:
            print(f"[kimi-token-watcher] 端口 {args.port} 已被占用，监控服务似乎已在运行。")
            print("[kimi-token-watcher] 如需重启：先停止旧进程（任务面板 / 任务管理器），再重新运行。")
            sys.exit(1)

    print(f"[kimi-token-watcher] 数据根: {state.SESSION_ROOT}")
    print(f"[kimi-token-watcher] 启动采集线程 ...")
    boot_replay()
    t = threading.Thread(target=collector_loop, daemon=True)
    t.start()
    # 外部源采集线程:ZCode(SQLite) / DSH(zstd JSONL) / oaicopilot(JSONL 日志),
    # 各自带水位与容错
    threading.Thread(target=collector_zcode.collector_loop, daemon=True).start()
    threading.Thread(target=collector_dsh.collector_loop, daemon=True).start()
    threading.Thread(target=collector_oai.collector_loop, daemon=True).start()
    # 一次性事件流历史回补 + 外部源文本回填（后台线程：30 天窗口的 wire 有
    # ~300MB，解析需数十秒，不阻塞 HTTP 启动；完成后前端下一次轮询即可见历史）
    threading.Thread(target=backfill_all, daemon=True).start()
    print(f"[kimi-token-watcher] 打开 http://127.0.0.1:{args.port}")
    print(f"[kimi-token-watcher] 纯本地服务，Ctrl+C 退出")
    try:
        ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n[kimi-token-watcher] 退出，保存状态 ...")
        shutdown_save()


if __name__ == "__main__":
    main()
