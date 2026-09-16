# 诊断报告：会话历史无法加载（会话日志被本插件写成不可读）

- **Bug slug**：`session-log-unloadable`
- **症状**：GUI 报 `failed to observe session "session-6e0577de-…": session "…" contains event type "peak-valley-brake/change" (seq 9064) unknown to this harness and not marked ignorable; refusing to interpret the log`
- **影响**：该会话 **9244 条记录全部**无法加载（读路径是整份拒收，而非跳过一条）
- **状态**：已修复并验证（插件 + 已污染的历史日志）

## 1. 根因（已确证）

插件 `lib/hold-state.js` 的 `publishHoldState` 用

```js
session.append('peak-valley-brake/change', parsed.data);
```

把持有状态写进会话日志。而 harness 的持久化读路径会用 `KNOWN_SESSION_EVENT_TYPES`
校验整份日志：

```js
// @deepseek-ai/dsh-session-persistence/lib/index.js:184
if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
  throw unsupported(`session "…" contains event type "…" unknown to this harness and not marked ignorable; refusing to interpret the log …`);
```

而这个白名单是**构建期生成**的，其文件注释写明：

> Downstream (out-of-repo) plugin events are outside this list by construction.
> The persisted `SessionEvent.ignorable` marker is the compatibility mechanism;
> event-name registration was rejected because it does not classify omission safety.

即：**唯一**的兼容机制是事件信封上的 `ignorable: true`。但 `Session.append(type, data, ...opts)`
只接受 `surfaceOp` 与 `sourceEventSeqs`（`@deepseek-ai/dsh-session/lib/index.js:1170-1188`），
**插件没有任何通道可以设置 `ignorable`**。二者的组合是致命的：

> 插件一旦写入自定义事件类型，该会话日志就**永久**不可加载。

实测证据（受损会话）：9244 条记录中仅 **2 条**（seq 9064、9070）是该类型，信封键为
`["data","seq","time","type"]` —— 无 `ignorable`。

### 加重情节：这笔写入什么都没换来

注册的投影 `peakValleyBrake` **没有任何读取方**（README 已记录客户端半边没有投影注册表），
徽章实际走的是内存 `publishedStates` + `POST /api/peak-valley-brake.action` 轮询。
即：纯损失，零收益。

## 2. 复现回路（红灯 → 绿灯）

用 harness **自己的**校验函数与真实记录建立回路，而非复刻实现：

```powershell
node C:\Users\Aristotle\AppData\Local\Temp\pvb-repro\probe-validator.mjs
```

修复前输出：

```
AS WRITTEN      : REFUSED -> SessionFormatUnsupportedError
                  session "session-probe" contains event type "peak-valley-brake/change" (seq 9064) …
WITH ignorable  : LOADED
                  derived type kept: peak-valley-brake/change
                  ignorable flag    : true
                  data intact       : true
```

该输出同时证实了修复假设：补上 `ignorable` 后，事件**类型与数据都保留**，只是被读路径视为可忽略的外部记录。

## 3. 修复

### 3.1 插件侧（提交 `3e3e19b`）

状态不再进入会话日志，只留在内存里由宿主端点提供：

| 文件 | 改动 |
| --- | --- |
| `lib/hold-state.js` | `publishHoldState(session, next, previous)` → `nextPublishedState(next, previous)`：仍做「可观测变化 / schema 校验」判定，但**不接收 session、不写任何地方**；删除 `HOLD_EVENT_TYPE`、`HOLD_PROJECTION_KEY`、`HOLD_STATE_VERSION`、`applyHoldEvent`、`holdProjectionDefinition` |
| `lib/index.js` | 移除 `sessionProjections` inject、`probeSessionProjections`、`registerProjection`、`hasProjectionRegistry`；`publish` 改为内存推进 |
| `test/hold-state.test.mjs` | 新增回归守卫：断言模块**不再导出任何事件词汇**、写入器签名不再接收 session |
| `test/brake.test.mjs` | 假会话仍完整记录每次 `append`，6 个发布用例现在都断言其为空 |
| `test/verify-projection.mjs` | 删除（验证已下线的投影注册，属死代码） |
| `README.md` / `README.zh.md` | 记录「为何绝不能写会话日志」及其后果 |

### 3.2 历史修复（外科式，已执行）

保留原文件字节，只重编码承载那 2 条记录的帧：

- 第 5044 帧（含 seq 9064）、第 5046 帧（含 seq 9070）
- 逐帧扫描使用存储层**自己的** `scanZstdFrames` 算法；重压缩使用同样的
  `zstdCompress` + `ZSTD_c_checksumFlag`
- 先备份，再写临时文件并原子 `rename` 替换

结果：`7609026 → 7609051` 字节（**+25**），5140 帧不变。

## 4. 验证证据

### 独立复验（`verification/` 内脚本，读备份 vs 现文件）

```
[verify] records: backup=9244 repaired=9244
[verify] changed records: 2
  index 9065: seq 9064 … before: {…,"updatedAtMs":1789539037993}}
                         after : {…,"updatedAtMs":1789539037993},"ignorable":true}
  index 9071: seq 9070 … before: {…,"overrideUntilMs":1789552800000,…}}
                         after : {…,"overrideUntilMs":1789552800000,…},"ignorable":true}
[verify] events outside the vocabulary and not ignorable: 0 []
[verify] validateStoredEvents: LOADED (9243 events adopted)
```

即：**9244 条记录一条不少，只有目标 2 条变化，且变化仅是新增 `ignorable:true`**；两条记录的
`data` 载荷（`phase`、`heldCount`、`engaged`）完整保留。`validateStoredEvents` —— 当初拒载的那个
函数 —— 现在接受整份日志。

### 全库复查

```
LOADABLE   session-6e0577de-b3ee-4e21-884b-208bd56393b8  (9244 records, 2 ignorable foreign event(s))
[pvb-repro] loadable=10 unloadable=1
```

剩下 1 个 unloadable 是 **`session-ef16726c`（`--D-SoftDocument-DSHProject--`）**，其
`session.jsonl.zstd` 含 `reasoning-chunks` / `tool-call-chunks` / `text-chunks` / `assistant/chunk`
——已退役的 pre-release v0 格式块事件，**与本插件无关**，属另一个独立问题（同一会话的 v3 文件可正常加载）。

### 插件测试

```
npm test --silent   →  13 个测试块全绿，EXIT 0
（48/23/19/37/53/6/24/29/21/66/22/16/10 passed，0 failed）
```

## 5. 遗留物与清理

| 项目 | 位置 | 说明 |
| --- | --- | --- |
| 修复前备份 | `%APPDATA%\dsh-desktop\harness\pvb-repair-backups\session-6e0577de-….pre-repair` | 该备份**有意**不可加载（它就是修复前的原样）；确认无需回滚后可删 |
| 修复/校验脚本 | 本目录 `debug/` | 可复用；`repair.mjs` 会自行备份并自校验 |
| 临时探测脚本 | `%TEMP%\pvb-repro\` | 一次性探针，可整体删除 |
| 调试埋点 | 无 | 未向生产代码加入任何 `[DEBUG-*]` 埋点，已 grep 确认 |

## 6. 残余风险与建议

1. **本插件的风险已闭合**：写入路径连同导出词汇一并删除，测试断言其回归即失败。
2. **harness 侧的能力缺口（建议上游关注，不在本次范围）**：
   `SessionEvent.ignorable` 是官方指定的、仓库外插件事件唯一的兼容机制，却**没有任何写入通道**
   ——`Session.append` 不透出该字段，插件也无从注册事件名。任何按直觉使用 `session.append`
   写自有事件类型的插件，都会让用户丢历史，且症状出现在**下一次加载**时、与写入点相距甚远，
   极难归因。建议方向：为 `append` 增加显式 `ignorable` 选项（由写入方声明「缺我省略安全」），
   或在 append 处对未知类型**快速失败**，让错误在写入时而不是若干天后暴露。
3. **旧格式会话**：`session-ef16726c` 的 v0 日志仍不可加载，需要时另行处理（属退役格式迁移，非本 bug）。

## 7. 结论

- 原始复现**不再复现**：目标会话现可加载。
- 历史完整：9244 条记录逐条比对，除 2 条新增 `ignorable` 外零改动。
- 根因已从源头消除，并有回归测试锁定。
