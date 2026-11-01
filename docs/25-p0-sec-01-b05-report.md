# B05 本地开发与证据报告

状态：LOCAL_DELIVERED / CI_BLOCKED。开发自测不构成独立 PASS 或 READY。

固定旧 B04：`deb4f7ee4e5fe372441c1b3d8d54d466adbd7917`。
G0 归档冻结提交：`49c2559`；批准契约原字节 SHA-256 `a53a1c0c842ca7b4cdc209644be8e0f09e0c4d96efed80c0f1a539e048e1260a`。
最终本地交付完整 SHA 由工作区 `work/agent3-b05-evidence/delivery.json` 记录。

## 最小修复

1. 原始 JSONL 实际解析后逐条核对 Type、Action、Actor.ID、name、timeNano 与结构化数组；数量一致不再足以通过。
2. JSON.parse 验证语法后扫描完整词法 token，仅提取唯一根 timeNano。保留大整数原始十进制；拒绝指数、小数、负数、混合字符串、缺失、嵌套冒充及重复（含转义键）时间字段。不引入依赖。
3. 毫秒宿主边界转换为 BigInt 纳秒，与原始事件直接比较；不截断事件时间、不加容差。非安全整数宿主时间明确拒绝。

未修改生产取消状态机；不能从验证器缺陷推定生产存在相同取消错误。
B03/B04 既有测试与夹具未修改，断言未放宽。

## 缺陷来源与同测对比

真实独立证据：Agent2 会话 `01a19607-9d17-7d33-b6c1-34fbbab9165f` 的 command_execution；
工作区 `work/agent2-final-audit/codex.stdout.jsonl` 及 `work/ja-27xuypyk/b04-negative-v2.mjs`。
第一稿第三例 die > destroy 被拒绝，不能当作第三缺陷证明；本轮使用保持合法生命周期的 v2。

同一专项文件 SHA-256：`a71ef24a944c988dac6ce9064c466c1181b5c9b7d0fb2d8d9271a5c11aaeaa82`。
测试仅用 `B05_EVIDENCE_MODULE` 指定旧版绝对模块路径，输入和断言保持不变。

| 检查 | tests/pass/fail/skip | exit |
|---|---|---|
| 固定旧 B04 + 新专项 | 36/9/27/0 | 1 |
| 修复版 + 同一专项 | 36/36/0/0 | 0 |
| 原 B03/B04 专项 | 51/51/0/0 | 0 |
| 全套 | 218/215/0/3 | 0 |
| 原冻结契约校验 | 22 AC/10 E2E/15 EV | 0 |
| node --check 验证器 | 语法检查 | 0 |

全部测试在本地专用 Node24+git 镜像执行：Node v24.21.0 / git 2.39.5；
`--network none --read-only`，源码只读挂载，`/tmp` tmpfs，独立 HOME/JARVIS_HOME/JARVIS_DB，不挂 Docker socket或主机凭据。
代理测试只访问该容器 loopback，没有连接宿主机服务。
命令、完整 stdout/stderr、退出码及同测 SHA 保存在 `work/agent3-b05-evidence/`；
`old-special.*`、`new-special.*`、`old-51-regression.*`、`full-regression.*`、`contract-integrity.*`、`syntax.*`。

原五份契约/manifest 与固定 B04 逐字节相同，新契约与批准外部文件逐字节相同；完整摘要见 `contract-digests.json`。

## 缺口与后续

3 项跳过：Docker 验证容器实际执行、Docker 审计/验证只读挂载、FIX3-D 真实只读挂载；该隔离测试环境不提供 daemon/socket/执行器镜像。
未执行新 GitHub CI（没有 GitHub 写权限）、真实 Docker 竞态、真实设备/SE/Claude/GLM 和 live OpenClaw/MCP/Workflow。
既有 AC-02/08/20/22、E2E-01/08/10 缺证继续有效。
应先恢复必要 CI/真实环境补证，再由 Agent2 在固定新提交上复审，不将开发本地测试升级为正式通过。
未推送、发布或合并 main；原 B04 检出保持不变。
G0 提交使用明确的 JARVIS Agent3 localhost 合成作者；实现提交使用现有 Git 作者配置。
