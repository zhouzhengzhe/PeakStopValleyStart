# 实施报告（usage-info-bar）

> 本文件是**最新权威实施摘要**，指向最新一次 pass 报告。追加式报告见 `implementation-reports/`。

## 规格来源与权威标记

- `requirements.md`（需求研究结论）
- `plan.md`（实施方案）
- `test-plan.md`（测试方案）
- 权威标记：**本地 `.spec-workflow` 工件的正常优先级**，无 `Authority: external-tracker-only`。
- 无 `amendments/`、`repair-spec.md`、`repair-issues/`、`issues/` 目录 —— 本 spec 未生成 ticket 拆分，按单条 spec 整体实施。

## Goal Mode

**未启用。** 三份规格文件中均无 Goal Mode 元数据，故不自动进入 `do-review`，实施完成后按常规推荐下一阶段。

## Git 基线检查

| 项 | 值 |
|---|---|
| 仓库 | `D:/SoftDocument/DSHProject/PeakStopValleyStart` |
| 分支 | `main` |
| 实施不动点 | `eef6374` |
| 先前元数据来源 | `requirements.md` 的「Git 入口闸门」段 |
| 分支决定 | 继续在 `main`（用户拍板，与先前记录一致） |

**当前状态与记录比对**：分支一致、`HEAD` 一致。
**脏工作区基线**：仅三个未跟踪的规格文件本身（`plan.md` / `requirements.md` / `test-plan.md`），
即本工作流的产物，属**有意上下文**，非用户遗留改动。无其他脏文件。
**结论**：基线一致，可以实施。未执行任何切换分支、stash、reset、clean、commit 操作。

## 协调结构选择

**选择：本地串行实施（不启用子代理）。**

理由：三个施工层共享同一个数据模型契约（`usage-ledger` 的账目形状贯穿价格表 → 账本 → 采集 → 视图），
且装配点集中在同两个文件（`lib/index.js` 与 `lib/client.js`）。按本技能规则，
**同文件修改、契约未稳定、耦合紧密**三类情形应串行；并行只会制造协调开销与冲突风险，不会降低风险。

**子代理计划**：实施阶段不启用。仅在实施后的内建自检环节，按技能要求对
**Standards 轴与 Spec 轴做隔离审查**——若届时可安全并行，则用两个子代理分开跑；否则本地分序执行并如实记录为"本地隔离"。

## 实施提交闸门

- 问题已向用户提出，选项：不自动提交 / 验证通过后自动提交 / 实施完再决定。
- **回答：验证通过后自动提交。**
- **Auto-commit allowed: yes** —— 仅在实施、集成、约定验证全部完成后提交一次；验证失败则不提交。
- 提交范围：本次实施改动的文件 + 相关 `.spec-workflow/usage-info-bar/` 交接工件；不含无关脏文件。
- 自动推送：**不会执行**（本技能明令禁止）。

## 执行 DAG

| ID | 任务 | 依赖 | 写入范围 | 验收判据 | 需实现 | 子代理 | 并行 |
|---|---|---|---|---|---|---|---|
| T0 | 阶段 0 取证：`刷新失败` 归属 | — | `.spec-workflow/.../verification/` | 得出确定结论 | 否 | 否 | — |
| T1 | 价格表 + 账本内核（纯函数，零 IO） | T0 | `lib/price-table.js`、`lib/usage-ledger.js`、`test/usage-ledger.test.mjs` | 测试方案 T1–T3 全绿；无网络/文件/真实时钟 | 是 | 否 | 否 |
| T2 | Host 采集（`llm/stream` + 余额） | T1 | `lib/usage-collect.js`、`lib/index.js`、`test/usage-collect.test.mjs` | T4 四结局 + T5 降级 | 是 | 否 | 否 |
| T3 | 栏的数据模型（纯函数） | T1 | `lib/info-bar-view.js`、`test/info-bar-view.test.mjs` | 峰谷拆分之和 ≡ 总额 | 是 | 否 | 否 |
| T4 | Client 挂载 + API 端点 + 设置项 | T2,T3 | `lib/client.js`、`lib/badge-api.js`、`lib/badge-settings*.js` | T6：注册 id ≠ `'stats'` | 是 | 否 | 否 |
| T5 | 集成检查 + 全量回归 | T4 | — | 既有断言零回归 | 是 | 否 | — |
| T6 | 内建自检：Standards 轴 / Spec 轴 / Scope 轴 | T5 | — | 三轴隔离出具结论 | 否 | 视情况 | 可能 |

**串行说明**：T1→T2→T3 中 T2 与 T3 表面无依赖，但 T3 的视图模型要读账本聚合结果的形状，
契约在 T1 定型前不宜并行；且 T4 是唯一装配点，必然串行。故不拆并行。

## 阶段 0 结果（已完成）

见 `verification/phase0-refresh-failure.md`。

**一句话结论**：`刷新失败` 不是故障，是第三方插件**无条件探测六个端点**、其中订阅/账单三个对余额制账号
无意义而 reject 所造成的**永久性假警报**；余额、用量、凭据、定价目录四个数据源**全部健康**。

**产物**：三条降级行为清单 + 一条实施约束（只探测与当前计费模式相关的端点）。

## 状态

| 项 | 状态 |
|---|---|
| 阶段 0 取证 | ✅ 完成 |
| T1–T6 | ⏸ 等待提交闸门答复 |
| 子代理 | 未启动 |
| 变更文件 | 仅 `.spec-workflow/usage-info-bar/` 下工作流工件 |

## 剩余风险

- 第三方插件仍在演进（对方已 1.11.1），我们搬的是快照 → 只搬 DeepSeek 余额制一条链路以压缩表面积。
- `sessionController` 接口随版本变动 → 按能力读取 + try/catch + 不可用即降级为"只统计挂载后"。
- 价格表漂移 → 单点定义 + 一条断言钉住当前官方价。
- 上游 `刷新失败` 的精确归属未细化到单个端点（排除法已足够，见阶段 0 文档第六节）。
