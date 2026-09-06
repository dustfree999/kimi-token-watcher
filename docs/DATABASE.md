# 数据库说明文档（data.db）

Kimi Code Token 监控的持久化存储。本文档说明数据库结构、数据流、查询方法与注意事项。

## 1. 文件位置与文件族

数据库位于**项目根目录**：

| 文件 | 说明 |
|---|---|
| `data.db` | SQLite 主数据库（WAL 模式） |
| `data.db-wal` / `data.db-shm` | WAL 日志与共享内存文件，**服务运行时存在，属正常现象，勿删** |
| `data.json.migrated-*.bak` | 旧版 JSON 存储的迁移备份（可留可删） |

服务运行期间数据库每 **30 秒**自动同步一次，`Ctrl+C` 退出时也会保存。

## 2. 表总览

| 表名 | 用途 | 数据量级 |
|---|---|---|
| `meta` | 杂项配置与运行状态（键值对，值为 JSON） | 固定几行 |
| `days` | 每日聚合统计（嵌套 JSON） | ≤ 90 天（自动裁剪） |
| `recent` | 实时事件流 | ≤ 10000 条（自动裁剪） |
| `seen_usage` | usage 记录去重指纹（含来源） | ≤ 20k（30 天保留） |
| `seen_req` | request 记录去重指纹（含来源） | ≤ 20k（30 天保留） |
| `seen_turn` | turn.ended 失败回合去重指纹（含来源） | ≤ 20k（30 天保留） |
| `seen_usage_g` | usage 全局兜底指纹 | 同上 |
| `seen_req_g` | request 全局兜底指纹 | 同上 |
| `seen_turn_g` | turn.ended 失败回合全局兜底指纹 | 同上 |

> 所有表的建表 DDL 均带注释，可在 Navicat 中查看（右键表 → 对象信息 / DDL）。

## 3. 表结构详解

### 3.1 `meta` — 杂项状态

| 列 | 说明 |
|---|---|
| `key` | 键名，取值：`tracked_files`、`session_meta`、`last_text`、`last_model`、`fails`、`recent_seq`、`last_scan_time`、`scan_errors`、`ext_state`、`turn_backfill_done`、`recent_backfill_done`、`ext_text_backfill_done` |
| `value` | JSON 字符串值 |

- `tracked_files`：各 wire.jsonl 已读字节偏移（增量扫描断点）
- `session_meta`：会话元数据（标题、cwd、是否自定义等）
- `last_text`：各 wire 最近输入/输出文本
- `last_model`：各 wire 最近一次 `llm.request` 的模型名（`turn.ended` 失败回合归属用）
- `fails`：失败回合明细缓冲（最多 1000 条，含 time/date/hour/model/session/scope/err_code/err_msg），供模型详情等页面回溯历史失败
- `recent_seq`：实时事件流下一个可用 eventId
- `scan_errors`：最近采集告警（最多 10 条）
- `ext_state`：外部源水位（`zcode_last_rowid`、`dsh_files`）
- `turn_backfill_done` / `recent_backfill_done` / `ext_text_backfill_done`：一次性回补 / 回填完成标记（见下）

> **事件流历史回补**：`recent` 是滚动缓冲，旧事件会被新事件挤出，增量扫描不会重读历史。
> 升级后首次启动会在后台线程一次性重读最近 30 天的 wire.jsonl（外加 ZCode 全表 / DSH 全量文件），
> 把历史事件只补进 `recent` / `fails` 展示缓冲——不走 `apply_record` / `apply_turn_end`，
> 聚合统计与去重指纹完全不受影响；与现有事件按内容键去重，幂等。完成后置位 `recent_backfill_done`，后续启动跳过。

### 3.2 `days` — 每日聚合统计

| 列 | 说明 |
|---|---|
| `date` | 日期，格式 `YYYY-MM-DD`（主键） |
| `data` | 当日完整聚合 JSON，结构如下 |

`data` JSON 结构：

```jsonc
{
  "date": "2026-08-15",
  "inputOther": 12994934,      // 输入未命中 tokens
  "inputCacheRead": 267951360, // 缓存命中 tokens
  "inputCacheCreation": 0,     // 缓存写入 tokens
  "output": 1050489,           // 输出 tokens
  "calls": 444,                // turn 级调用次数
  "requests": 397,             // step 级请求次数
  "failed": 0,                 // 失败回合次数（turn.ended reason=failed，仅该层级有）
  "by_model": { "模型名": { "model": "...", "inputOther": ..., "output": ..., "failed": ... } },
  "by_session": { "会话id": { "session": "...", "has_main": true, "has_sub": false,
                              "by_model": {...}, "hourly": {"9": {...}} } },
  "by_scope": { "main": { "scope": "main", "by_model": {...} },
                "subagent": { "scope": "subagent", "by_model": {...} } },
  "hourly": { "9": { "input": ..., "cached": ..., "output": ..., "calls": ..., "requests": ...,
                     "cacheWrite": ... } },
  "by_source": { "zcode": { "source": "zcode", "inputOther": ..., "inputCacheRead": ...,
                            "inputCacheCreation": ..., "output": ..., "calls": ...,
                            "requests": 0, "failed": ...,
                            "by_model": {...},
                            "hourly": { "9": { "input": ..., "cached": ..., "output": ...,
                                               "calls": ..., "cacheWrite": ... } } } }
}
```

- 各小时槽的键是**字符串**（`"9"`、`"23"`），不是数字
- `has_main` / `has_sub`：会话是否包含主/子智能体记录（旧数据可能缺失，前端兼容显示「主」）
- `failed` 计数器加在 6 个层级：日顶层、`by_model[m]`、`by_session[s]`、`by_session[s].by_model[m]`、`by_scope[sc]`、`by_scope[sc].by_model[m]`；**hourly 不加**。旧存档可能缺失该键，前端与代码需按缺省 0 处理
- `by_source`：外部数据源（ZCode / DSH）的独立槽位，**顶层计数严格等于 Kimi Code 自身**，外部源只写此槽（含 `failed`/`by_model`/`hourly`）；无外部源的日期该键缺失。前端「全部」视图 = 顶层 + Σ外部源槽，「Kimi Code」视图 = 顶层原样

### 3.3 `recent` — 实时事件流

| 列 | 说明 |
|---|---|
| `eventId` | 递增事件 id（主键，重启后续接） |
| `time` | 毫秒时间戳 |
| `date` / `hour` | 所属日期（字符串）/ 小时（INTEGER） |
| `model` | 模型名 |
| `session` | 会话 id |
| `scope` | `main` = 主智能体，`subagent` = 子智能体 |
| `input` / `cached` / `output` / `total` | 输入未命中 / 缓存命中 / 输出 / 合计 tokens（失败事件恒为 0） |
| `input_text` / `output_text` | 最近输入/输出文本（事件行展开查看用） |
| `kind` | 事件类型：`usage`（用量）/ `failed`（失败回合），缺省 `usage` |
| `err_code` / `err_msg` | 失败事件的错误码 / 错误信息（截断 300 字符），非失败事件为空串 |
| `source` | 事件来源：`kimi`（缺省）/ `zcode` / `dsh`，前端来源筛选据此过滤 |

> 早期版本建的库没有 `kind`/`err_code`/`err_msg`/`source` 四列，服务启动时自动 `ALTER TABLE` 补齐（默认 `kind='usage'`、错误列为空串、`source='kimi'`），无需手动处理。

### 3.4 去重指纹表（`seen_usage` / `seen_req` / `seen_turn` / `seen_usage_g` / `seen_req_g` / `seen_turn_g`）

防止 fork 会话、多会话同记录重复计数的三层防线，对应内存中的集合：

| 表 | 指纹组成 | 用途 |
|---|---|---|
| `seen_usage` | `(ts, src, model, i, o, c, cc)` | usage 主指纹（含来源路径，区分不同会话/Agent）；**外部源指纹首元素为字符串 `"ext"`**（无时间戳，以 zcode rowid / dsh 消息 id 为身份，整表/整文件重扫幂等） |
| `seen_req` | `(ts, src, model, turnStep)` | request 主指纹（`turnStep` 为字符串；外部源不产生 request） |
| `seen_turn` | `(ts, src, turnId)` | turn.ended 失败回合主指纹（`turnId` 为回合 id）；外部源为字符串形态 `("ext", source, "source:turnId")`（如 `("ext", "zcode", "zcode:turn-abc")`，该字符串整体直接落在 turnId 列） |
| `seen_usage_g` | `(ts, model, i, o, c, cc)` | usage 全局兜底（不含来源，仅用于 >10 分钟的历史回放；仅 kimi 记录进入） |
| `seen_req_g` | `(ts, model)` | request 全局兜底 |
| `seen_turn_g` | `(ts, turnId)` | turn.ended 失败回合全局兜底 |

## 4. 数据流

```
~/.kimi-code/sessions/**/agents/*/wire.jsonl
        │  collector 线程每 2 秒增量扫描（按 tracked_files 偏移）
        ▼
  解析 usage.record / llm.request / turn.ended(reason=failed) 事件
        │  去重指纹校验（SEEN 六表）→ 通过则计数
        ▼
  内存 STATE（days / recent / last_model / ...）
        ▲
        │  collector_zcode：~/.zcode 的 model_usage 表按 rowid 增量
        │    （表重建导致 rowid 回落后自动重置水位全量回放，指纹幂等不重复计数）
        │  collector_dsh：~/.dsh/sessions 的 *.jsonl.zstd 按 mtime/size 重扫
        │    （文件首次出现视为历史回放，不推实时事件流）
        │  （外部源只写 days[date].by_source.<source> + recent，顶层不变）
        │  save_state：每 30 秒 / Ctrl+C 时，单事务全量同步
        ▼
  data.db（WAL 模式，事务原子）
```

- **读取**：`boot_replay` 启动时从 data.db 恢复内存状态（含去重集合、偏移、事件流）
- **写入**：`save_state` 在锁内序列化并同步，事务提交保证原子性
- **前端**：通过 `GET /api/usage` 读取内存聚合结果，不直接访问数据库

## 5. 数据生命周期

| 数据 | 保留策略 |
|---|---|
| `days` | 最多 90 天，超出自动裁剪 |
| `recent` | 最多 10000 条，超出丢弃最旧 |
| `fails`（meta 键） | 最多 1000 条，超出丢弃最旧 |
| `seen_*` | kimi 指纹保留 30 天；外部源指纹按来源分桶各保留最近 5000 条；任一集合超 2 万条即触发裁剪 |
| `scan_errors` | 最多 10 条 |

## 6. 常用查询示例（命令行）

```bash
# 列出全部表
python -c "import sqlite3; c=sqlite3.connect('data.db'); print([r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")])"

# 某天总 tokens
python -c "import sqlite3,json; c=sqlite3.connect('data.db'); d=json.loads(c.execute(\"SELECT data FROM days WHERE date='2026-08-15'\").fetchone()[0]); print('输入:', d['inputOther'], '输出:', d['output'])"

# 最近 10 条实时事件（按时间倒序）
python -c "import sqlite3; c=sqlite3.connect('data.db'); print(c.execute('SELECT datetime(time/1000,\"unixepoch\",\"localtime\"), scope, model, total FROM recent ORDER BY time DESC LIMIT 10').fetchall())"

# 只看失败回合事件（含错误码）
python -c "import sqlite3; c=sqlite3.connect('data.db'); print(c.execute('SELECT count(*), kind, err_code FROM recent WHERE kind=\"failed\" GROUP BY err_code').fetchall())"

# 只看子智能体事件
python -c "import sqlite3; c=sqlite3.connect('data.db'); print(c.execute('SELECT count(*) FROM recent WHERE scope=\"subagent\"').fetchone())"

# 某模型近 7 天输出总量（按天聚合）
python -c "
import sqlite3, json
c = sqlite3.connect('data.db')
for date, data in c.execute('SELECT date, data FROM days ORDER BY date DESC LIMIT 7'):
    d = json.loads(data)
    m = d['by_model'].get('你的模型名', {})
    print(date, '输出:', m.get('output', 0))
"
```

## 7. Navicat 可视化

1. 打开 Navicat（Premium 或 Navicat for SQLite）→ **连接 → SQLite**
2. 数据库文件选择 `D:\coding\my-project\ppt\kimi-token-watcher\data.db`
3. 连接后展开可见 9 张表，双击查看数据
4. 查看表注释/DDL：右键表 → 对象信息（或「打开表」的 SQL 预览）
5. `days.data`、`meta.value` 是 JSON 列，可在 Navicat 中直接复制到编辑器格式化查看

## 8. 注意事项 / FAQ

- **服务运行时可连接查看**（WAL 支持并发读），但**不要同时写入**——服务每 30 秒同步一次，写入冲突可能污染数据。建议只读使用。
- **备份数据库**：先停止服务再复制 `data.db`（WAL 模式下直接复制可能不含未合并的日志）。更稳妥的方式：`python -c "import sqlite3; src=sqlite3.connect('data.db'); dst=sqlite3.connect('backup.db'); src.backup(dst)"`，或使用 SQLite 的 `VACUUM INTO`。
- **手动改数据**：聚合数据（`days`）由扫描自动生成，手动修改会在下次同步时被覆盖；`recent`、`seen_*` 同理。如需清空统计，删除对应行后重启服务即可（去重指纹若一并清除，重启后会重新统计历史记录）。
- **完全重置**：停止服务 → 删除 `data.db`（及 `-wal`/`-shm`）→ 重启。首次启动会重新全量扫描 wire.jsonl 重建统计（历史记录将按 10 分钟回放规则去重）。
- **旧版 JSON**：`data.json.migrated-*.bak` 是迁移备份，确认数据无误后可删除。

## 9. 相关代码

- `state.py`：数据库连接、建表、加载/保存、一次性迁移
- `aggregate.py`：记录聚合（写内存 STATE，间接落库）
- `collector.py`：扫描循环与启动恢复
- `collector_zcode.py` / `collector_dsh.py`：外部源采集（只写 `by_source` 槽）
- `server.py`：HTTP 服务与响应组装
