# Kimi Code Token 监控

> **非官方社区项目**：本项目与 Moonshot AI / Kimi 官方无任何关联，数据仅存储在本地，不会上传任何内容。

Kimi Code CLI 的本地 Token 用量监控面板。Python 后台扫描 `~/.kimi-code/sessions` 下的 `wire.jsonl` 日志，增量解析 `usage.record` / `llm.request` / `turn.ended` 事件并聚合统计，通过本地 HTTP 服务 + 原生 JS 仪表盘实时展示。

**纯本地运行：服务只监听 `127.0.0.1:8787`，不联网、不上传任何数据。**

## 功能特性

- **7 个页面**：概览、实时事件、模型分析、会话分析、历史统计、费用分析、设置
- **实时事件流**：每 2 秒自动刷新，事件行可展开查看输入/输出文本，支持主/子智能体与模型筛选、分页
- **多维度统计**：按模型、按会话、按主智能体（main）/ 子智能体（agent-*）三个维度聚合
- **失败调用统计**：统计 `turn.ended` 失败回合（含错误码与错误信息），模型详情页可回溯历史失败记录
- **费用预估**：全局默认定价 + 按模型定价覆盖（元 / 百万 tokens），均可在设置页本地修改
- **历史统计**：按天聚合（自动保留 90 天），支持按小时/按天趋势切换
- **时间筛选**：今日 / 7 天 / 30 天 / 自定义时间范围（起止日期含首尾，最多 366 天），全部页面同步生效
- **数据导出**：设置页一键导出按日 / 按模型 CSV（带 BOM，Excel 直接打开不乱码）
- **告警通知**：当日费用 / 失败次数超阈值时浏览器通知 + 页面提示，同类 30 分钟冷却不重复提醒

## 界面预览

| 截图 | 说明 |
|---|---|
| ![概览页](docs/screenshots/overview.png) | 概览：今日用量、实时会话与费用总览 |
| ![模型分析页](docs/screenshots/models.png) | 模型分析：按模型的用量统计与失败调用 |
| ![费用分析页](docs/screenshots/cost.png) | 费用分析：费用趋势与按模型费用占比 |
| ![历史统计页](docs/screenshots/history.png) | 历史统计：按天 / 按小时的长期趋势 |

## 快速开始

1. **Windows**：双击 `启动.bat`（脚本自动切换到项目目录、打开浏览器并启动本地服务）；也可以在 cmd / PowerShell 中运行：

   ```bash
   python server.py
   ```

2. **macOS / Linux**：直接运行：

   ```bash
   python3 server.py
   ```

3. 浏览器访问 **http://127.0.0.1:8787**

**依赖**：仅需 **Python 3.10+** 标准库（`http.server` / `sqlite3` / `threading` 等），无需安装任何第三方包。

**演示模式**：没有 Kimi Code 数据也能先体验——生成合成演示数据并指向它启动：

```bash
python tests/gen_demo.py demo_sessions
python server.py --dir demo_sessions
```

## 页面使用指南

- **概览**：今日 / 所选时间范围的 KPI 总览（调用数、Token、费用、失败数）、Token 资源分配、使用趋势、模型分布与会话 TOP3。
- **实时事件**：每 2 秒自动刷新的事件流；点击事件行展开查看输入/输出文本；支持按主/子智能体、模型筛选与分页；顶部时间筛选同步生效。
- **模型分析**：按模型聚合的调用数、Token、费用与失败率；点击模型行进入详情，可回溯该模型的历史失败记录（错误码 + 错误信息）。
- **会话分析**：按会话维度聚合，展示各会话的 Token 与费用消耗，点击可看会话内明细。
- **历史统计**：按天聚合的长期趋势（自动保留 90 天），支持按小时 / 按天切换。
- **费用分析**：今日 / 昨日 / 7 日 / 30 日费用、费用趋势与按模型费用占比、费用明细表。
- **设置**：修改全局默认定价与按模型定价覆盖（元 / 百万 tokens）、配置费用 / 失败告警阈值、一键导出按日 / 按模型 CSV。

顶部时间筛选（今日 / 7 天 / 30 天 / 自定义范围）对所有页面统一生效。

## 架构

| 模块 | 说明 |
|---|---|
| `server.py` | 入口 + HTTP 服务（路由分发、`/api/usage` 响应组装、端口冲突检测） |
| `state.py` | 共享状态（`STATE` / `LOCK` / 去重集合 `SEEN_*`）与 SQLite 持久化 |
| `aggregate.py` | 聚合槽位与记录累加（`apply_record` / `apply_request` / `apply_turn_end`） |
| `collector.py` | 增量扫描解析与采集循环（2 秒轮询、启动回放、历史失败回补） |

前端为原生 JS 单页应用（无框架）：`index.html` + `js/`（`utils.js`、`data.js`、`render.js`、`main.js`、`charts.js`、`views.js`）+ `css/`（`base.css`、`layout.css`、`components.css`）。

采集流程：后台线程每 **2 秒**增量扫描 `~/.kimi-code/sessions/**/agents/*/wire.jsonl`（只读新追加行）→ 三层指纹去重（`is_fork_copy` 检查 → 含来源 `src` 的主指纹 → 不含 `src` 的全局兜底集合，用于超 10 分钟的历史回放）→ 累加进内存 `STATE` → 定时落库。

## 数据存储

- 数据存于项目根目录 `data.db`（SQLite，**WAL 模式**），运行期间自动出现 `data.db-wal` / `data.db-shm` 属正常现象，请勿删除
- 每 **30 秒**自动同步一次，`Ctrl+C` 退出时也会保存
- 首次启动若存在旧版 `data.json` 会自动一次性迁移（原文件改名为 `data.json.migrated-YYYYMMDD.bak`）
- 旧库升级到新版后，首次启动会**全量回补历史失败回合**（`turn.ended failed`），完成后置位跳过
- 表结构、数据流、生命周期与查询示例详见 **[docs/DATABASE.md](docs/DATABASE.md)**

## 命令行参数与 API

**命令行参数：**

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--port` | 监听端口 | `8787` |
| `--dir` | sessions 根目录 | `~/.kimi-code/sessions` |

**HTTP 端点：**

| 端点 | 说明 |
|---|---|
| `GET /` | 返回仪表盘页面 `index.html` |
| `GET /api/usage` | 聚合 JSON（days / week / month / recent / fails / rates / prices 等） |
| `GET /api/open` | 用系统资源管理器打开数据源目录 |
| `GET /js/*`、`GET /css/*` | 静态资源 |

## 常见问题

- **端口 8787 被占用 / 启动报「端口已被占用」**：说明已有一个监控实例在运行（端口冲突防护会直接退出，避免双进程同时写库）。如需重启，先在任务管理器/任务面板停止旧进程，再重新运行。
- **改了代码不生效**：服务是前台常驻进程，修改 `server.py` / 前端文件后需重启服务才生效。
- **想直接查看数据库**：服务运行期间可只读连接（WAL 支持并发读），推荐用 Navicat 或 `sqlite3` 命令行，查询示例见 **docs/DATABASE.md**。不要同时写入，避免污染数据。

## 注意事项 / 免责声明

- **采集依赖内部格式**：`wire.jsonl` 是 Kimi Code CLI 的内部存储格式，官方版本升级可能改变其结构或字段，导致采集失效或统计不准确，届时请升级本工具。
- **费用为本地估算**：费用分析基于公开定价在本地估算，仅供个人参考，不代表官方账单，实际扣费以官方账户为准。
- **纯本地、无上传**：项目只读取本地 `~/.kimi-code/sessions` 下的日志并写入本地 `data.db`，不联网、不上传任何数据；本工具为社区项目，与 Moonshot AI / Kimi 官方无任何关联。

## 开发与测试

- **端到端冒烟测试**（需 Node.js 与 playwright，项目内或全局 npm 安装均可）：

  ```bash
  python tests/gen_demo.py demo_sessions
  python server.py --port 8799 --dir demo_sessions   # 另开一个终端
  node tests/e2e.mjs http://127.0.0.1:8799
  ```

- **演示数据生成器**：`tests/gen_demo.py` 按 `collector.py` 实际读取的目录结构与事件 schema 生成合成数据，可用于开发调试与截图。
- 前端为无构建的原生 JS，改完刷新浏览器即可；后端改动需重启服务。

## 目录结构

```
kimi-token-watcher/
├── server.py            # 入口 + HTTP 服务
├── state.py             # 共享状态与 SQLite 持久化
├── aggregate.py         # 聚合槽位与记录累加
├── collector.py         # 增量扫描与采集循环
├── index.html           # 仪表盘页面
├── js/                  # 前端逻辑（6 个模块）
├── css/                 # 前端样式（3 个文件）
├── docs/DATABASE.md     # 数据库文档
├── docs/screenshots/    # README 界面预览截图
├── tests/e2e.mjs        # 端到端冒烟测试（playwright，见文件头用法）
├── tests/gen_demo.py    # 演示数据生成器（演示模式 / 开发调试）
├── 启动.bat             # Windows 一键启动脚本
├── LICENSE              # MIT
└── data.db              # 统计数据（运行时生成，不入库，见 .gitignore）
```

## License

[MIT](LICENSE) © 白泽
