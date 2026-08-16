#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kimi Code Token 监控 —— 演示数据生成器（Demo Data Generator）
==============================================================
在指定输出目录下生成一批合成的 Kimi Code 会话目录（wire.jsonl + state.json），
目录结构与字段名严格对齐 collector.py / aggregate.py 实际读取的 schema，
用于：
  1) 开源仓库 README 配图 / 本地「演示模式」使用（不含任何真实个人数据）；
  2) 开发调试 / 端到端测试提供确定性的数据源。

用法：
    python tests/gen_demo.py <输出目录>

生成的目录结构（与真实 ~/.kimi-code/sessions 一致）：
    <输出目录>/
      <项目分组>/session_<uuid>/state.json
      <项目分组>/session_<uuid>/agents/main/wire.jsonl          # 主智能体
      <项目分组>/session_<uuid>/agents/agent-<uuid>/wire.jsonl  # 子智能体（部分会话）

查看效果：
    python server.py --port 8799 --dir <输出目录>
    然后浏览器打开 http://127.0.0.1:8799

仅使用 Python 标准库，无第三方依赖。
"""

import argparse
import datetime
import json
import os
import random
import sys
import uuid

# ---------------------------------------------------------------------------
# 常量：模型名 / 失败错误码（均为真实会出现的形式）
# ---------------------------------------------------------------------------
MODELS = (
    "kimi-for-coding/k2.6",
    "kimi-code/k3",
    "火山codingplan/Kimi-K2.7-Code",
)

ERROR_POOL = (
    ("provider.api_error", "The provider returned an unexpected error (HTTP 529)."),
    ("rate_limit_exceeded", "Rate limit exceeded, please retry later."),
    ("context_length_exceeded", "Input exceeds the model's context window."),
    ("provider.overloaded", "Upstream service is temporarily overloaded."),
)

# 通用输出片段池：无害占位文本，模拟助手逐步输出（每次回合取 1~3 段）
OUTPUT_PARTS = (
    "已按照需求完成修改，核心逻辑保持不变。",
    "调整后的实现更简洁，同时补充了边界情况的处理。",
    "新增了单元测试覆盖主要分支，全部用例通过。",
    "这里顺带优化了原有实现，减少了重复代码。",
    "改动涉及两处文件，已同步更新相关引用。",
    "已验证本地运行正常，输出与预期一致。",
)

# ---------------------------------------------------------------------------
# 会话规格：标题 / 工作目录 / 距今天数 / 模型 / 回合数 / 子代理回合数 /
#           失败回合下标（从 1 开始计）/ 每回合的用户提问
# ---------------------------------------------------------------------------
SESSION_SPECS = (
    {
        "title": "修复登录页样式问题",
        "cwd": r"D:\coding\my-project\web\frontend",
        "days_ago": 6,
        "model": "kimi-for-coding/k2.6",
        "turns": 6,
        "sub_turns": 0,
        "failed_at": (),
        "prompts": (
            "帮我优化登录页的样式，按钮的对齐有问题",
            "改成圆角卡片风格，和整体设计保持一致",
            "移动端适配一下，输入框在窄屏下太小了",
            "错误提示改成弹窗形式，别再用内联文字",
            "加载动画太突兀，换一个淡入效果",
            "调整一下主题色深浅，顺便检查对比度",
        ),
    },
    {
        "title": "重构数据采集模块",
        "cwd": r"D:\coding\my-project\data-pipeline",
        "days_ago": 4,
        "model": "kimi-code/k3",
        "turns": 7,
        "sub_turns": 0,
        "failed_at": (5,),
        "prompts": (
            "把数据采集模块拆成独立的增量扫描器",
            "扫描逻辑里加一层缓冲，避免频繁读盘",
            "解析失败的行应该跳过而不是中断整批",
            "给扫描器补充一个启动自检流程",
            "把偏移量持久化改成原子写入",
            "处理一下文件被截断后偏移重置的情况",
            "最后跑一遍全量回归，确认行为一致",
        ),
    },
    {
        "title": "优化报表导出性能",
        "cwd": r"D:\coding\my-project\report-service",
        "days_ago": 2,
        "model": "火山codingplan/Kimi-K2.7-Code",
        "turns": 5,
        "sub_turns": 3,
        "failed_at": (3,),
        "prompts": (
            "报表导出太慢，定位一下瓶颈在哪里",
            "把大表查询改成流式读取，分批写入",
            "导出进度加一个实时百分比提示",
            "并发导出时加个队列防止内存打满",
            "对比优化前后的耗时数据",
        ),
        "sub_prompts": (
            "子代理：分析这个模块的调用链，找出耗时最长的环节",
            "子代理：评估流式导出方案对内存的影响",
            "子代理：整理一份并发队列的压测结果",
        ),
    },
    {
        "title": "排查接口超时问题",
        "cwd": r"D:\coding\my-project\gateway",
        "days_ago": 1,
        "model": "kimi-for-coding/k2.6",
        "turns": 4,
        "sub_turns": 0,
        "failed_at": (),
        "prompts": (
            "网关转发偶尔超时，帮忙看下日志规律",
            "超时集中在下午高峰期，是不是线程池满了",
            "给上游调用加上熔断和重试策略",
            "验证一下压测下超时率有没有降下来",
        ),
    },
    {
        "title": "编写单元测试用例",
        "cwd": r"D:\coding\my-project\core-lib",
        "days_ago": 0,
        "model": "kimi-code/k3",
        "turns": 6,
        "sub_turns": 0,
        "failed_at": (2,),
        "prompts": (
            "给配置解析模块补一组单元测试",
            "边界输入：空字符串和超长 key 的处理",
            "mock 掉网络依赖，让测试可以离线跑",
            "把测试用例按功能分组组织一下",
            "补充失败路径的断言，覆盖率到 80%",
            "跑一遍全量测试并修复失败用例",
        ),
    },
)


def project_group(cwd):
    """从工作目录取项目名作为分组目录名（与真实目录结构一致：<分组>/<会话>）。"""
    return os.path.basename(cwd.rstrip("\\/")) or "default"


def rand_tokens(rng, failed=False):
    """生成量级合理的 token 数：input 几百~几千、cached 有时很大、output 几十~几千。
    failed=True 表示失败回合，消耗明显更小。"""
    if failed:
        return rng.randint(80, 900), rng.choice((0, rng.randint(100, 1500))), \
            rng.randint(0, 80), rng.randint(0, 200)
    other = rng.randint(150, 3500)
    cached = rng.choice((0, rng.randint(300, 9000), rng.randint(9000, 18000)))
    creation = rng.randint(0, 300)
    out = rng.randint(20, 2800)
    return other, cached, creation, out


class WireWriter:
    """把一条 wire.jsonl 的会话事件按真实顺序写出。
    回合内顺序：turn.prompt -> llm.request -> (输出片段) -> usage.record -> turn.ended
    与 collector._track_text 的文本跟踪逻辑对应，保证 usage.record 挂到本回合文本。
    """

    def __init__(self, path, model, cwd, tick, rng):
        self.path = path
        self.model = model
        self.cwd = cwd
        self.tick = tick  # 全局单调毫秒时间戳发生器，保证所有事件 time 唯一（防去重误杀）
        self.rng = rng
        self.lines = []
        self.turn_no = 0
        self.turn_id = 0

    def _ts(self, dt):
        """datetime -> 全局唯一毫秒时间戳。"""
        return self.tick(int(dt.timestamp() * 1000))

    def add_turn(self, prompt, outputs, dt, failed=False, error=None):
        """写一个完整回合。outputs 为输出文本片段列表；failed 时携带 error(code,msg)。"""
        self.turn_no += 1
        self.turn_id += 1

        # 1) turn.prompt：开启新回合，写入用户输入（collector 据此重置/记录 input）
        self.lines.append({
            "type": "turn.prompt",
            "time": self._ts(dt),
            "cwd": self.cwd,
            "input": [{"type": "text", "text": prompt}],
        })

        # 2) llm.request：记录最近一次请求的模型名（turn.ended 失败回合归属用）
        self.lines.append({
            "type": "llm.request",
            "time": self._ts(dt + datetime.timedelta(seconds=2)),
            "cwd": self.cwd,
            "modelAlias": self.model,
            "turnStep": "0.%d" % self.turn_no,  # 字符串步号，与 seen_req 指纹一致
        })

        # 3) context.append_loop_event：逐步累积输出文本（collector 据此累积 output）
        step = 4
        for text in outputs:
            self.lines.append({
                "type": "context.append_loop_event",
                "time": self._ts(dt + datetime.timedelta(seconds=step)),
                "event": {"part": {"type": "text", "text": text}},
            })
            step += 3

        # 4) usage.record：本回合 token 用量（turn 级，usageScope 为 "session" 会被跳过）
        other, cached, creation, out = rand_tokens(self.rng, failed=failed)
        self.lines.append({
            "type": "usage.record",
            "time": self._ts(dt + datetime.timedelta(seconds=step)),
            "model": self.model,
            "usageScope": "turn",
            "usage": {
                "inputOther": other,
                "inputCacheRead": cached,
                "inputCacheCreation": creation,
                "output": out,
            },
        })

        # 5) turn.ended：回合结束；reason=failed 才会被计入失败统计
        ended = {
            "type": "turn.ended",
            "time": self._ts(dt + datetime.timedelta(seconds=step + 2)),
            "turnId": self.turn_id,
            "reason": "failed" if failed else "success",
        }
        if failed and error:
            ended["error"] = {"code": error[0], "message": error[1]}
        self.lines.append(ended)

    def write(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as fh:
            for line in self.lines:
                fh.write(json.dumps(line, ensure_ascii=False) + "\n")


def write_state(path, spec, created_at_ms, last_prompt):
    """写会话元数据 state.json（collector.collect_session_meta 读取的字段）。"""
    data = {
        "title": spec["title"],
        "cwd": spec["cwd"],
        "isCustomTitle": True,
        "lastPrompt": last_prompt,
        "createdAt": created_at_ms,
        "forkedFrom": "",
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(
        description="生成 Kimi Code Token 监控的合成演示会话数据（wire.jsonl + state.json）")
    parser.add_argument("out_dir", help="输出目录（会话根目录，即 server.py 的 --dir 参数）")
    args = parser.parse_args()

    out = os.path.abspath(args.out_dir)
    if os.path.exists(out) and any(os.scandir(out)):
        print(f"错误：输出目录 {out} 已存在且非空，请换一个目录或先清空它。", file=sys.stderr)
        sys.exit(1)

    rng = random.Random(20260816)  # 固定种子，演示数据可复现
    now = datetime.datetime.now()
    g_ms = 0

    # 规格里的模型名必须是上面 MODELS 中真实会出现的名字
    bad_models = sorted({s["model"] for s in SESSION_SPECS} - set(MODELS))
    if bad_models:
        print(f"错误：会话规格使用了未登记的模型名：{bad_models}", file=sys.stderr)
        sys.exit(1)

    def tick(base_ms):
        """全局单调毫秒时间戳：保证所有事件 time 唯一，避免与去重指纹误碰撞。"""
        nonlocal g_ms
        g_ms = max(g_ms + 1, int(base_ms))
        return g_ms

    created = 0
    wires = 0
    events = 0
    failures = 0
    for spec in SESSION_SPECS:
        sid = "session_" + uuid.uuid4().hex
        group = project_group(spec["cwd"])
        sess_dir = os.path.join(out, group, sid)
        os.makedirs(sess_dir, exist_ok=True)

        # 会话起始时间：非今天取过去某天 9~17 点；今天则确保早于当前时刻
        if spec["days_ago"] == 0:
            start_dt = now.replace(hour=max(0, now.hour - 1),
                                   minute=rng.randint(0, 55), second=0, microsecond=0)
            if start_dt >= now:  # 极端边界（刚过整点/凌晨）：至少保证起点落在过去
                start_dt = (now - datetime.timedelta(minutes=5)).replace(second=0, microsecond=0)
        else:
            day = (now - datetime.timedelta(days=spec["days_ago"]))
            start_dt = day.replace(hour=rng.randint(9, 17),
                                   minute=rng.randint(0, 55), second=0, microsecond=0)

        writer = WireWriter(
            os.path.join(sess_dir, "agents", "main", "wire.jsonl"),
            spec["model"], spec["cwd"], tick, rng)
        last_prompt = spec["prompts"][0]
        dt = start_dt
        for i in range(1, spec["turns"] + 1):
            prompt = spec["prompts"][(i - 1) % len(spec["prompts"])]
            last_prompt = prompt
            failed = i in spec["failed_at"]
            outputs = rng.sample(OUTPUT_PARTS, rng.randint(1, 3))
            error = rng.choice(ERROR_POOL) if failed else None
            writer.add_turn(prompt, outputs, dt, failed=failed, error=error)
            if failed:
                failures += 1
            events += 1 + 1 + len(outputs) + 1 + 1  # prompt + request + output段 + record + ended
            dt += datetime.timedelta(seconds=rng.randint(90, 600))
            # 今天的会话：事件不得晚于当前时刻（模拟“进行中”的会话）
            if spec["days_ago"] == 0 and dt >= now:
                break
        writer.write()
        wires += 1

        # 子代理（部分会话）：独立的 agents/agent-<uuid>/wire.jsonl
        if spec.get("sub_turns"):
            sub_writer = WireWriter(
                os.path.join(sess_dir, "agents", "agent-" + uuid.uuid4().hex[:12],
                             "wire.jsonl"),
                spec["model"], spec["cwd"], tick, rng)
            sub_dt = dt + datetime.timedelta(minutes=2)
            for i, sp in enumerate(spec.get("sub_prompts", ()), 1):
                if i > spec["sub_turns"]:
                    break
                outputs = rng.sample(OUTPUT_PARTS, rng.randint(1, 2))
                sub_writer.add_turn(sp, outputs, sub_dt, failed=False)
                events += 4 + len(outputs)
                sub_dt += datetime.timedelta(seconds=rng.randint(60, 300))
            sub_writer.write()
            wires += 1

        write_state(os.path.join(sess_dir, "state.json"), spec,
                    int(start_dt.timestamp() * 1000), last_prompt)
        created += 1

    print(f"已生成 {created} 个演示会话 -> {out}")
    print(f"  会话目录：{len(SESSION_SPECS)} 个分组目录下的 session_* 会话")
    print(f"  wire 文件：{wires} 个（main 主代理 + 子代理）")
    print(f"  事件总数：{events} 行（turn.prompt / llm.request / usage.record / turn.ended 等）")
    print(f"  失败回合：{failures} 个（turn.ended reason=failed）")
    print("查看效果：python server.py --port 8799 --dir <输出目录> 后访问 http://127.0.0.1:8799")


if __name__ == "__main__":
    main()
