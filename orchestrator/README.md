# jarvis-orchestrator

JARVIS P1 的调度层。**不重写聊天引擎**：会话、模型调用、Agent 全部复用 OpenClaw，
本层只补齐 OpenClaw 没有的「项目 / 任务 / 交接 / 工作流」状态与路由。

当前为开发预览，源码实现与完整交付分开计：P0 原正式门禁仍 WAITING，P1 手机飞书完整独立验收 0/9；当前 GLM 探测未获有效模型结果，真实认证与模型响应 UNKNOWN。原部署成功及固定基线 CI 不替代新版业务验收，见 [项目当前状态](../README.md)。

## 六类对象

| 对象 | 承载者 | 说明 |
|---|---|---|
| Project | 本层 SQLite + 目录 | 隔离边界：会话、资料、权限不跨项目 |
| Agent | OpenClaw agent | 模型 + 角色 + 工作区，模型与角色可独立替换 |
| Conversation | OpenClaw session | 独立上下文，互不污染 |
| Task | 本层 SQLite | 一次具体执行，含状态、重试、审批 |
| Workflow | 本层 SQLite | 阶段式 DAG：同阶段并行、阶段间串行 |
| Execution | 本层 SQLite | 每次调用的真实证据（模型、耗时、错误、git 版本） |

## 依赖

- 本层 `package.json` 声明 Node `>=24`；集成固定 OpenClaw `2026.10.9` 时须满足 `>=24.22.1 <25 || >=26.12.1`，本次实际私有 Node 为 `24.22.1`。
- OpenClaw CLI 在 `PATH` 中
- 零第三方依赖，SQLite 用 `node:sqlite`

## 状态位置

```text
~/.openclaw/jarvis/state.db      项目 / 任务 / 工作流 / 执行证据
~/.openclaw/projects/<slug>/     项目目录，每个 agent 一个子工作区
```

## 命令行

以下是配置完成后的操作示例，含真实状态修改和模型调用，不能整段当作安装自检执行。先在独立测试目录完成环境、账号及执行范围确认；`analyst` / `reviewer` 等须实际存在，任务 ID 与工作流文件须替换为自己的值。

示例假设仓库位于 `$HOME/JarvisCoding`，私有 Node 已安装于下列路径，且 OpenClaw CLI 已在当前进程 PATH 中。路径不同须先调整；shell 函数用于正确处理路径及参数。

```bash
jarvis_cli() {
  "$HOME/.openclaw/tools/node/bin/node" "$HOME/JarvisCoding/orchestrator/src/cli.mjs" "$@"
}

# 项目
jarvis_cli project create --name "研究项目" --slug research
jarvis_cli project show --project research
jarvis_cli project pause --project research

# Agent（模型与角色独立）
jarvis_cli agent create --project research --name analyst --model zai/glm-4.6 --role "你做事实核查"
jarvis_cli agent model --agent analyst --model zai/glm-5.3     # 换模型，保留角色与会话
jarvis_cli agent role --agent analyst --role "你做审计"

# 对话（同 --conversation 续接，不同则隔离）
jarvis_cli talk --agent analyst --message "帮我查一下 X"

# 交接（真实执行，不是模拟）
jarvis_cli handoff --project research --from analyst --to reviewer \
  --requirement "评估这份结论" --artifact "结论：…"

# 任务
jarvis_cli task create --project research --title "写初稿" --agent analyst --input "…" --needs-approval
jarvis_cli task run --task tsk_xxx
jarvis_cli task approve --task tsk_xxx

# 外部执行器（Claude Code + GLM）
jarvis_cli task create --project research --title "只读检查" --kind executor \
  --executor claude-code --cwd /path/to/repo --mode plan --input "说明这个仓库做什么"

# 工作流
jarvis_cli workflow create --project research --name "研究流" --spec-file spec.json
jarvis_cli workflow run --workflow "研究流"
```

所有命令加 `--json` 输出机器可读结果。

## 工作流 spec

```json
{
  "maxRounds": 5,
  "stages": [
    { "name": "并行研究", "parallel": true, "nodes": [
      { "agent": "researcher", "title": "研究A", "input": "…" },
      { "agent": "reviewer",   "title": "研究B", "input": "…" }
    ]},
    { "name": "人工确认", "approve": true, "nodes": [
      { "agent": "writer", "title": "定稿", "input": "…" }
    ]},
    { "name": "执行", "nodes": [
      { "executor": "claude-code", "title": "改代码", "input": "…",
        "executorConfig": { "cwd": "/repo", "mode": "plan" } }
    ]}
  ]
}
```

阶段间串行，阶段内按 `parallel` 决定并发；`approve: true` 会暂停并生成待审批任务；
`maxRounds` 防止无限循环。

## MCP 工具（飞书里的 JARVIS 使用）

以下为既有集成命令形式，需按实际安装版本核对支持情况、路径及注册工具；不是当前手机链路验收凭据。不要直接修改现役 BOT 或双连接管事件。

```bash
openclaw mcp add jarvis-control \
  --command ~/.openclaw/tools/node/bin/node \
  --arg ~/JarvisCoding/orchestrator/src/mcp.mjs \
  --cwd ~/JarvisCoding --timeout 600
```

源码注册工具包括：`project_*`、`agent_*`、`conversation_*`、`talk`、`handoff`、
`task_*`、`workflow_*`、`models_list`、`audit_create`。实际会话可见清单还取决于启动版本及工具策略。

在正确注册并授权 MCP 工具后，JARVIS 主 Agent 可通过工具调度，无需为此开放 Shell；这项设计不证明现有手机会话已切到新版。

## 测试

下列命令从仓库根运行，仅列出测试入口。完整套件中部分案例依赖 Linux/Docker 等前置，不应在用户 Mac 上盲跑危险或缺环境的专项。已知固定基线和未完成门禁见 [当前状态](../README.md)；本页未重新认证测试或发布。


```bash
~/.openclaw/tools/node/bin/node --test orchestrator/test/*.test.mjs
```
