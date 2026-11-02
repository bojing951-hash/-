# 03 · 飞书通道

本页保留原个人部署的配置形式及访问控制说明，适用于当时版本，不是已完成的新 P1 安装/验收流程。截至 2026-11-03，手机九项完整独立验收为 0/9。已有 BOT 对话正常不证明新版通过。

接入前先明确机器人、插件精确版本、测试账号、状态目录和切换恢复窗口。原 BOT 保持原连接，不双连抢事件；以下安装、配置、发消息、probe 及 reload 均可能产生外部效果，不能整段自动执行。尚未核定可复现的飞书插件版本，不把滚动插件安装当作固定版本复现。

## 前置：飞书开放平台

在 <https://open.feishu.cn> 的企业自建应用里需要具备：

| 项 | 要求 |
|---|---|
| 应用类型 | 企业自建应用（自建应用才支持长连接） |
| 机器人 | 已启用 |
| 权限 | `im:message`、`im:message:send_as_bot` |
| 事件订阅 | `im.message.receive_v1`，**订阅方式选「使用长连接接收事件」** |
| 版本 | 已发布（改权限后必须重新发布版本才生效） |

不需要 `contact:*` 权限——它只影响「显示发送者姓名」，聊天本身不依赖它。

## 插件

```bash
openclaw plugins install @openclaw/feishu
```

## 配置（非交互式）

飞书的 `channels add` 没有 `--app-id/--app-secret` 参数，只能走配置键：

```bash
openclaw config set channels.feishu.enabled true --strict-json
openclaw config set channels.feishu.domain feishu
openclaw config set channels.feishu.connectionMode websocket
openclaw config set channels.feishu.accounts.default.appId "cli_xxxxxxxxxxxxxxxx"
openclaw config set channels.feishu.dmPolicy allowlist
openclaw config set channels.feishu.allowFrom '["ou_你的open_id"]' --strict-json
openclaw config set channels.feishu.groupPolicy disabled
openclaw config set channels.feishu.allowBots false --strict-json
openclaw config set commands.ownerAllowFrom '["feishu:ou_你的open_id"]' --strict-json
```

## 凭据存储边界与历史脚本

SecretRef 让配置保存引用名，**不等于凭据加密或从不落明文**。本次核对的 OpenClaw native store 为未静态加密的 SQLite，需要私密目录和文件权限保护。凭据、数据库及侧文件不可进入 Git、聊天、公开日志或归档。

仓库中的 `scripts/secure-credential-input.sh` 仅作历史参考：静默输入后，会把飞书 App ID / App Secret 写入权限 0600 的 `.private/feishu.env` **明文临时文件**；长度大于 40 且满足脚本条件时，会截为前 32 字符。这不是任意凭据的安全通用录入器，**不得用于 GLM 或其他 API key**。本页不推荐直接运行它录入新凭据，也不把静默输入、0600 或 SecretRef 称为加密。

历史流程曾从该临时文件导入 store 后删除文件。删除（包括 `rm -P`）不能保证 SSD、快照及备份上的安全擦除。新接入应另行核验官方隐藏输入流程、存储位置和清理范围，不把秘密放入命令参数或环境导出。

配置最终引用的历史示意为：

```json
"appSecret": { "source": "store", "provider": "default", "id": "FEISHU_APP_SECRET" }
```

## 拿到自己的 open_id

先临时把 `dmPolicy` 设为 `pairing`，用手机发一条消息，然后在日志里找：

```bash
grep "received message from" ~/Library/Logs/openclaw/gateway.log | tail -3
# feishu[default]: received message from ou_xxxx in oc_xxxx (p2p)
```

拿到后改回 `allowlist` 并写入 `allowFrom`。

> 原个人部署机器运行未指定通道的 `openclaw pairing list` 曾报 `No chat DM pairing channels are configured`，当时改用 allowlist。固定公开版本提供显式通道的 `pairing list feishu` / `pairing approve feishu <CODE>` 入口；该历史报错不代表整个版本不支持 CLI 配对，当前账号及手机配对流程仍待验证。

## 访问控制语义

| dmPolicy | 行为 |
|---|---|
| `pairing` | 陌生人收到配对码，需 CLI 审批（原机器配对流程未验证） |
| `allowlist` | **只有 allowFrom 里的人能私聊**（推荐） |
| `open` | 任何人可私聊，需 `allowFrom` 含 `"*"` |
| `disabled` | 关闭私聊 |

`groupPolicy: disabled` 高于一切：即使写了 `groups.<chat_id>` 也不放行群聊。

## 只保留聊天工具

飞书插件默认还带文档/云盘/权限/多维表格等工具，与 MVP 无关，全部关掉：

```bash
for t in doc wiki drive perm bitable scopes; do
  openclaw config set "channels.feishu.tools.$t" false --strict-json
done
```

`doc` 的风险点：`feishu_doc create` 会把文档权限授予发起人，属于意外提权面。

## 历史连接检查示例

需在约定的测试窗口执行；该输出示例不是当前新版手机验收结果。

```bash
openclaw channels status --probe
# - Feishu default (JARVIS): enabled, configured, running, connected, works
```

## 流式卡片

若日志出现 `Create card request failed with HTTP 400`，说明缺少卡片权限。关闭流式即可，回复不受影响：

```bash
openclaw config set channels.feishu.streaming.mode off
```

原部署结果见 [历史验收报告](06-acceptance-report.md)，当前交付边界见 [项目状态](../README.md)。外部干净安装、模型账号、原安全门禁及手机全流程仍待验。
