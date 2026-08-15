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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import state
from collector import boot_replay, collector_loop, shutdown_save


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
        if path.startswith("/api/usage"):
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
        """用系统资源管理器打开数据源目录（仅本机使用）。"""
        try:
            if os.name == "nt":
                os.startfile(state.SESSION_ROOT)  # noqa: S606 本地工具按设计提供
            else:
                import subprocess
                subprocess.Popen(["xdg-open", state.SESSION_ROOT])
            self._send_json({"ok": True})
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(e)})

    def do_POST(self):
        self.do_GET()


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
        )[:200]

        # ---- 滚动窗口速率（tokens/分钟）：基于实时事件流 recent（500 条上限） ----
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
            agg["inputOther"] += s["inputOther"]
            agg["inputCacheRead"] += s["inputCacheRead"]
            agg["inputCacheCreation"] += s["inputCacheCreation"]
            agg["output"] += s["output"]
            agg["calls"] += s["calls"]
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

    resp = {
        "now": time.time(),
        "today": today,
        "days": days,
        "week": week,
        "month": month,
        "recent": recent,
        "session_root": state.SESSION_ROOT,
        "rates": rates,
        "vs_yesterday": vs_yesterday,
        "peak_hour": peak_hour,
        "rate_per_min": rate_per_min,
        "session_meta": dict(state.STATE["session_meta"]),
        "prices": state.DEFAULT_PRICES,
        "last_scan": last_scan,
        "tracked_files": len(tracked),
        "errors": errors,
    }
    return resp


def main():
    ap = argparse.ArgumentParser(description="Kimi Code token usage local bridge")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--dir", default=state.SESSION_ROOT, help="sessions 根目录")
    args = ap.parse_args()
    # 就地更新共享状态（同一对象），供 collector 扫描与 build_response 读取同一目录
    state.SESSION_ROOT = os.path.abspath(args.dir)

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
    print(f"[kimi-token-watcher] 打开 http://127.0.0.1:{args.port}")
    print(f"[kimi-token-watcher] 纯本地服务，Ctrl+C 退出")
    try:
        ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n[kimi-token-watcher] 退出，保存状态 ...")
        shutdown_save()


if __name__ == "__main__":
    main()
