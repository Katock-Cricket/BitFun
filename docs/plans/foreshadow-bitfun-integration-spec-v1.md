# Foreshadow × BitFun 集成 SPEC v1.0

> **权威副本位置：** Foreshadow 仓  
> `iseg-ide-sub1/foreshadow/docs/SPEC-bitfun-v1.md`  
> 本文件为 BitFun 仓内对照副本，便于 PR / 评审引用。若两处不一致，以 foreshadow 仓文件为准，并应同步更新。

| 项 | 值 |
|---|---|
| 文档类型 | 集成 SPEC（实现基线） |
| 状态 | **已锁定**，可作为双仓实现依据 |
| 日期 | 2026-04-08 |
| Foreshadow 权威 SPEC | 独立仓 `docs/SPEC-bitfun-v1.md` |
| 关联 | Foreshadow `SPEC-v0.2.md`（VS Code Host）；本文件覆盖 BitFun Host + MCP |
| 集成版本标记 | `1.0.0-bitfun` |

---

## 0. 已锁定决策总表

| ID | 主题 | 结论 |
|----|------|------|
| D1 | 交付边界 | **彻底分仓**。BitFun 以 **npm 包** `@foreshadow/core` 引入（semver + lockfile）。不并进 BitFun monorepo；禁止主线长期 `file:`。 |
| D2 | LanguageIntel | v1 **No-op**；`LastArtifactContext` 允许为空 |
| D3 | Prompt / Agent 工具 | **仅桩**；本轮不采集、不扩展 RawHostEvent |
| D4 | 终端 | 多会话；`phase:end` 完整输出；无 shell integration **降级跳过**；**≤64KB/命令** |
| D5 | textChanged | Monaco/TipTap **增量 changes 优先**；L2 允许全文可选；EditHistory 局部 diff+padding |
| D6 | MCP API | 单工具；主体 **`toJSONObject()`** |
| D7 | TaskRecognizer LLM | 复用 BitFun 模型；**fast → 无则 main** |
| D8 | UI | **仅设置页新 Tab**（无独立上下文面板） |
| D9 | Memory/PromptBuilder | **不自动注入**；仅 MCP 按需 |
| D10 | 远程工作区 | **自动降级不提供**（含 peer） |
| D11 | Runtime | **与 BitFun UI/采集同进程** |
| D12 | 数据目录 | 仅有工作区时工作；`{workspaceRoot}/.foreshadow/` |
| D13 | 实例 | **按 workspace 多实例** |
| D14 | 授权 | **默认需用户授权** |
| D15 | Markdown | **TipTap 进 v1** |
| D16 | 包引入 | 主线 npm `@foreshadow/core` semver；仅 core 作者可短时 `file:` 联调 |

---

## 1. 目标与非目标

### 1.1 Must

1. 本地工作区采集：Monaco、TipTap Markdown、选区/光标、活动文件、重命名、终端（有 shell integration 时）。
2. 经 L2 Ingress 维护七项上下文；LSP 字段 v1 可空。
3. MCP Tool：`foreshadow_get_context` → 以 `toJSONObject()` 为本体的快照。
4. 设置中心 Foreshadow Tab：启用/授权、任务识别、模型策略（复用 BitFun 模型下拉）。
5. 远程 / 无工作区 / 未授权 → 明确 unavailable。
6. L2/L3 平台无关；BitFun 只做 Host + 装配。

### 1.2 非目标（v1）

- 改 Agent Kernel / PromptBuilder 自动注入
- 直接跑 `host/vscode`
- 独立侧边栏上下文面板
- LanguageIntel / LastArtifact 完整填充
- Prompt / Agent 工具轨迹
- 远程 SSH 上下文
- CursorPredictor / 蒸馏 / 用户画像

---

## 2. 仓库与包边界

```text
foreshadow/  (独立 Git)
  packages/core           # L2+L3 → @foreshadow/core
  packages/mcp-server     # 可选薄查询入口
  docs/SPEC-bitfun-v1.md  # 权威 SPEC

BitFun/  (独立 Git)
  src/web-ui/.../foreshadow/   # Host、采集、RuntimeMap、设置
  package.json → @foreshadow/core
  docs/plans/foreshadow-bitfun-integration-spec-v1.md  # 本对照副本
```

| 阶段 | 依赖 |
|------|------|
| 开发 / CI / 发布（现行） | `"@foreshadow/core": "^0.2.0"`（npm registry；lockfile 钉死） |
| 仅 core 作者临时联调 | 可短时 `file:` sibling，**不得**合入主线 |
| 禁止 | foreshadow 源码并进 BitFun monorepo 作为唯一真相源；禁止提交本机绝对路径 / 长期 `file:` / 临时日志 |

**分层：** L0 BitFun 装配 → L1 BitFun Host → L2/L3 `@foreshadow/core` → MCP 读 `toJSONObject()`。  
L1 只 `runtime.publish`；L2/L3 禁止 BitFun/React/Tauri/Monaco 类型。

与 `SPEC-v0.2` 冲突时：**BitFun Host 以本 SPEC 为准**；分层「零平台依赖」取更严者。

---

## 3. 运行时拓扑（方案 A）

```text
[ BitFun WebUI 进程 ]
  Monaco / TipTap / Terminal correlator / FS rename
           → ActivityCollector (L1)
           → publish(RawHostEvent)
           → RuntimeMap[workspaceKey] (L2+L3)
                    │ toJSONObject()
[ Agent ] MCP ──► foreshadow_get_context
```

- Runtime **同进程**；不为采集单独维护主状态 Node 进程。
- MCP 可走 BitFun 现有 stdio 基础设施；v1 **推荐** 内建 tool 面直接读 Runtime。
- 可选薄 mcp-server **只查询转发**，主状态仍在 UI 进程。

### 3.1 多实例与门闩

- `Map<workspaceKey, Runtime>`，`dataDir = {root}/.foreshadow`。
- 无工作区 / 远程 / peer / 未授权 → 不采集；MCP 返回对应错误码。
- 远程：`isRemoteWorkspace` / `WorkspaceKind.Remote`（`workspaceManager`）。

---

## 4. MCP API

| 字段 | 值 |
|------|-----|
| Name | `foreshadow_get_context` |
| Args | 可选 `workspacePath`；默认当前工作区 |
| 成功 | `{ schemaVersion, workspacePath, generatedAt, context: toJSONObject() }` |
| 权限 | 设置启用 + BitFun 工具授权（默认 ask） |
| 禁止 | 自动注入 system prompt |

错误码：`NO_WORKSPACE` | `REMOTE_UNSUPPORTED` | `NOT_AUTHORIZED` | `NOT_READY` | `INTERNAL_ERROR`。

---

## 5. 事件覆盖与 L2 调整

### 5.1 RawHostEvent

- `textChanged`：`changes` 优先；`beforeText`/`afterText` 可选。
- `terminalCommand.processId` = BitFun `session_id`；`output` 在 end 有效且 ≤64KB。

### 5.2 覆盖矩阵

| 事件 | 源 | 适配 |
|------|-----|------|
| textChanged | Monaco `onDidChangeContent`；CodeEditor 现未外发 | 旁路 model listener |
| textChanged md | TipTap | Markdown 路径；可 after-only |
| selectionChanged | Monaco cursor/selection | 外发 |
| activeEditorChanged | tab / FileTabManager | 激活时发 |
| fileRenamed | FileSystemService rename | 订阅 |
| terminalCommand | Rust Started/Finished/Data；FE TerminalService **丢弃** 命令事件 | 旁路 `terminal_event` 聚合 |

### 5.3 终端

- 有 integration：start 缓冲 Data → end 发布；多 session 分桶。
- 无 integration：**不伪造**命令。
- 64KB：头 32KB + 尾 32KB + `\n...[truncated]...\n`（字符/字节口径实现时写死并单测）。

### 5.4 foreshadow L2

- changes 驱动 Edit + padding；缺全文不崩；VS Code 全文路径仍可用。
- 建议 debounce 300–800ms 合并击键。

---

## 6. Ports（BitFun v1）

| Port | 完整度 |
|------|--------|
| Document / Workspace / FS / Config / Scheduler | 必做 |
| WorkspaceSearch | 必做；失败则 Keyword 空 |
| LanguageIntel | **No-op** |
| LLM | BitFun 模型链；fast→main；失败不挡其它字段 |

---

## 7. 设置 UI

- 扩展 `settingsConfig.ts`：`ConfigTab` + `'foreshadow'`（建议 `smartCapabilities`）。
- 项：启用/授权、任务识别、模型下拉、只读数据目录、运行状态、MCP 工具名说明。
- i18n 按仓库规范；**无**独立面板。

---

## 8. 授权与隐私

默认关 → 设置启用并说明采集范围 → Agent 调工具走现有 Permission/ToolApproval。  
禁用即停 publish；日志英文无 emoji。

---

## 9. BitFun 落点（索引）

| 区域 | 预期路径 |
|------|----------|
| RuntimeMap / 门闩 / Bridge | `src/web-ui/src/tools/foreshadow/` 或 `features/foreshadow/` |
| Monaco / Markdown | 轻触 CodeEditor / MarkdownEditor 或旁路 service |
| 终端 | 旁路 `terminal_event` 或透传 TerminalService |
| 设置 | settingsConfig + ForeshadowConfig + SettingsScene |
| MCP | assembly/desktop 注册 tool |
| 依赖 | web-ui → `@foreshadow/core` |

原则：最小侵入，逻辑不进 Monaco 内核。

关键锚点文件：

- [`CodeEditor.tsx`](../../src/web-ui/src/tools/editor/components/CodeEditor.tsx)
- [`TerminalService.ts`](../../src/web-ui/src/tools/terminal/services/TerminalService.ts)
- [`FileSystemService.ts`](../../src/web-ui/src/tools/file-system/services/FileSystemService.ts)
- [`settingsConfig.ts`](../../src/web-ui/src/app/scenes/settings/settingsConfig.ts)
- [`workspaceManager.ts`](../../src/web-ui/src/infrastructure/services/business/workspaceManager.ts)
- [`process.rs`](../../src/crates/services/services-integrations/src/mcp/server/process.rs)（MCP 子进程模型参考）

---

## 10. 验收 B1–B16

| ID | 标准 |
|----|------|
| B1 | 本地+授权：Monaco 编辑进入 History Edit |
| B2 | 光标/选区更新 CursorContext（不崩） |
| B3 | 切换 tab 有 activeEditor 侧效果 |
| B4 | 重命名进入日志路径 |
| B5 | 有 shell integration：终端 end 进 History，output 守 64KB |
| B6 | 无 integration：不伪造终端 History |
| B7 | MCP 返回含七字段的 `context`（toJSONObject） |
| B8 | LastArtifact 可空；无 LSP 不报错 |
| B9 | 远程/peer 不可用且设置状态正确 |
| B10 | 未授权不采集、工具拒绝 |
| B11 | 多 ws 隔离；快照对应当前 ws |
| B12 | 数据在 `{ws}/.foreshadow/` |
| B13 | 不注入 PromptBuilder |
| B14 | TipTap 可采集 textChanged（或等价） |
| B15 | Task 在模型可用时可更新；失败不挡其它字段 |
| B16 | 经 npm 依赖 `@foreshadow/core` 可构建（`^x.y.z` + lockfile） |

---

## 11. 分期

| 阶段 | 内容 | 仓 |
|------|------|-----|
| P0 | core 库导出 + textChanged 兼容 + No-op LI | foreshadow |
| P1 | RuntimeMap、门闩、设置 Tab | BitFun |
| P2 | Monaco + tab + rename | BitFun |
| P3 | 终端 correlator | BitFun |
| P4 | TipTap | BitFun |
| P5 | Ports + TaskRecognizer | BitFun |
| P6 | MCP + 权限 | BitFun |
| P7 | npm 发布文档 + 验收 | 双仓；见 [foreshadow-bitfun-release-and-acceptance-v1.md](./foreshadow-bitfun-release-and-acceptance-v1.md) |

---

## 12. 风险

CodeEditor 未外发 / Terminal 丢事件 → 旁路采集；内存 → 64KB + log 上限；双仓漂移 → 锁版本；权限 → 复用现有体系。

v1.1 候选：面板、LSP、Prompt 事件、远程子集。

---

## 13. 完整正文

完整章节（进程科普级拓扑、RawHostEvent 类型全文、终端算法伪代码、Ports 表、设置项、错误码、风险表）以 Foreshadow 仓权威文件为准：

**`foreshadow/docs/SPEC-bitfun-v1.md`**
