# Foreshadow × BitFun — 发布说明与 B1–B16 验收（P7）

| 项 | 值 |
|---|---|
| 文档类型 | 发布 / 验收（P7 交付物） |
| 状态 | v1 实现基线（P0–P6 已合入；依赖已切 npm `@foreshadow/core`） |
| 权威集成 SPEC | foreshadow 仓 `docs/SPEC-bitfun-v1.md` |
| BitFun 对照 SPEC | [foreshadow-bitfun-integration-spec-v1.md](./foreshadow-bitfun-integration-spec-v1.md) |
| foreshadow 发布说明 | foreshadow 仓 `docs/PUBLISH-npm-bitfun.md` |
| 集成版本标记 | `1.0.0-bitfun` |
| 当前消费依赖 | `"@foreshadow/core": "^0.2.0"`（npm registry） |

---

## 1. 目标

本文件覆盖 SPEC P7：

1. **双仓 npm 依赖**：BitFun 通过 registry 消费 `@foreshadow/core`（符合分仓 + semver 规范）。
2. **B1–B16 验收矩阵**：每条标准的验证方式、自动化/手工、当前代码落点。

不替代权威 SPEC；行为冲突以 foreshadow 仓 `SPEC-bitfun-v1.md` 为准。

---

## 2. 仓库与包边界

```text
foreshadow/                         # 独立 Git；L2/L3 真相源
  packages/core  →  发布 @foreshadow/core
  docs/SPEC-bitfun-v1.md
  docs/PUBLISH-npm-bitfun.md

BitFun/                             # 独立 Git；Host + 装配
  src/web-ui/  →  "@foreshadow/core": "^0.2.0"
  src/web-ui/src/tools/foreshadow/  # RuntimeMap、采集、Ports、MCP 桥
  src/crates/.../foreshadow_get_context_tool.rs
  docs/plans/foreshadow-bitfun-*.md
```

| 禁止 | 说明 |
|------|------|
| 把 foreshadow 源码并进 BitFun monorepo 作为唯一真相源 | 与 D1 冲突 |
| 提交本机绝对路径 / sibling `file:` 到 package.json 或 vite alias | CONTRIBUTING / 仓库卫生 |
| 静默依赖未钉版本的远端 main | CI 使用 lockfile |

---

## 3. 依赖策略（现行）

### 3.1 默认：npm registry

[`src/web-ui/package.json`](../../src/web-ui/package.json)：

```json
"@foreshadow/core": "^0.2.0"
```

- 安装：`pnpm install`（在仓库根或 web-ui 工作区）
- 解析：pnpm 从 `registry.npmjs.org` 拉取；**不要**再写本机 `file:` 路径
- Vite：`vite.config.ts` 仅从 `require.resolve("@foreshadow/core")` 放行 `node_modules` 包目录，无机器路径

### 3.2 仅 core 库作者本地调试（可选，不进主线）

若在改 foreshadow 源码、尚未发版，可在**未提交**的工作区短时用 pnpm link / 本地 path 覆盖做联调。验证完后**必须**恢复 registry 的 `^0.2.x` 并更新 lockfile 再提交。主线 PR **不接受** `file:` 依赖。

### 3.3 CI

| 方案 | 做法 |
|------|------|
| **默认（推荐）** | 只 checkout BitFun；`pnpm install` 装 lockfile 中的 `@foreshadow/core` |
| 发版前验证新 core | foreshadow 先 `npm publish`，再在 BitFun  bump 版本 + lockfile |

禁止：CI 用 `latest` 且无 lock；禁止 CI 依赖未文档化的本机 sibling 路径。

### 3.4 升级 core

1. foreshadow 发新版 `@foreshadow/core@x.y.z`（见上游 `PUBLISH-npm-bitfun.md`）。
2. BitFun：

```bash
pnpm --dir src/web-ui add @foreshadow/core@^x.y.z
pnpm run type-check:web
pnpm --dir src/web-ui run test:run src/tools/foreshadow
```

3. 提交 `package.json` + lockfile。

### 3.5 版本约定

| 项 | 约定 |
|----|------|
| 包名 | `@foreshadow/core` |
| 当前 | `^0.2.0`（已发布 `0.2.0`） |
| 破坏性变更 | core 升版本；BitFun MCP 外壳 `schemaVersion` 独立演进 |
| Host 变更 | 只动 BitFun `tools/foreshadow` |

### 3.6 `third_party/foreshadow-core`

历史 vendored 快照，**不再作为运行时依赖**。主线只认 npm。该目录可保留作对照或后续删除，但不得写回 `package.json`。

---

## 4. BitFun 侧已实现落点（索引）

| 能力 | 路径 |
|------|------|
| RuntimeMap / 门闩 | `src/web-ui/src/tools/foreshadow/runtimeMap.ts` |
| 采集桥 | `src/web-ui/src/tools/foreshadow/capture/` |
| Ports | `src/web-ui/src/tools/foreshadow/ports/` |
| 工具载荷 / FE 桥 | `contextPayload.ts` / `contextBridge.ts` |
| 设置 Tab | `ForeshadowConfig.tsx` + settingsConfig |
| Agent 工具 | `foreshadow_get_context_tool.rs` + tool plan / registry |
| 权限 action | `foreshadow` + `get_context:<workspace>`（默认 Ask） |

---

## 5. B1–B16 验收矩阵

图例：

- **自动**：可用单测 / type-check / 契约测试无 UI 手工
- **半自动**：代码路径存在 + 单测覆盖部分；完整行为需一次手工冒烟
- **手工**：需本地工作区 + Desktop 运行

| ID | 标准 | 方式 | 状态 | 验证要点 / 落点 |
|----|------|------|------|-----------------|
| B1 | 本地+授权：Monaco 编辑进入 History Edit | 手工 | 待冒烟 | 设置启用；编辑代码；`foreshadow_get_context` 观察 History Edit |
| B2 | 光标/选区更新 CursorContext（不崩） | 手工 | 待冒烟 | 移动光标/选区；context 含 cursor 相关字段 |
| B3 | 切换 tab 有 activeEditor 侧效果 | 手工 | 待冒烟 | 切换编辑 tab；active editor 路径变化 |
| B4 | 重命名进入日志路径 | 手工 | 待冒烟 | 资源管理器重命名；日志/context 反映 rename |
| B5 | 有 shell integration：终端 end 进 History，output ≤64KB | 半自动 | 策略单测已过 | `truncateTerminalOutput` 单测 + 手工 end |
| B6 | 无 integration：不伪造终端 History | 半自动 | 代码路径已实现 | `TerminalCorrelator` 不伪造 |
| B7 | MCP 返回含七字段的 `context`（toJSONObject） | 半自动 | 工具+载荷已实现 | `foreshadow_get_context` 成功壳 |
| B8 | LastArtifact 可空；无 LSP 不报错 | 半自动 | No-op LI | LanguageIntel No-op |
| B9 | 远程/peer 不可用且设置状态正确 | 半自动 | 门闩已实现 | `REMOTE_UNSUPPORTED` |
| B10 | 未授权不采集、工具拒绝 | 半自动 | 门闩+权限已实现 | 默认 off + Ask |
| B11 | 多 ws 隔离；快照对应当前 ws | 半自动 | v1 仅 active runtime | 非 active → `NOT_READY` |
| B12 | 数据在 `{ws}/.foreshadow/` | 半自动 | 路径已实现 | `FORESHADOW_DATA_DIR_NAME` |
| B13 | 不注入 PromptBuilder | 自动 | **通过** | prompt_builder 无 foreshadow |
| B14 | TipTap 可采集 textChanged | 半自动 | 路径+单测 | `markdownTextChanged` |
| B15 | Task 在模型可用时可更新；失败不挡其它字段 | 半自动 | LLM Port 软失败 | TaskRecognizer |
| B16 | 经 npm `@foreshadow/core` 可构建 | 自动 | **通过** | `^0.2.0` + type-check + foreshadow vitest |

### 5.1 建议手工冒烟顺序（Desktop）

1. 打开**本地**工作区 → 设置 → Foreshadow → 启用。
2. 编辑代码、移动光标、切换 tab、重命名、（有 integration 时）终端命令。
3. Agent 加载 deferred 后调 `foreshadow_get_context` 并授权。
4. 确认 `context`；关闭开关后再调 → `NOT_AUTHORIZED`。
5. （可选）远程工作区确认不可用。

### 5.2 自动化最小命令

```bash
pnpm --dir src/web-ui run test:run src/tools/foreshadow
pnpm run type-check:web
cargo test -p bitfun-tool-packs product_provider_group_plan_preserves_builtin_tool_order
cargo test -p bitfun-core foreshadow_tool
cargo test -p bitfun-core registry_preserves_
```

---

## 6. 已知 v1 限制

| 限制 | 说明 |
|------|------|
| Runtime 仅保留 active workspace | B11 以当前 ws 为准 |
| LanguageIntel No-op | LastArtifact 可空 |
| Prompt / Agent 轨迹 | 仅桩 |
| 远程 / peer | 明确降级 |
| 无独立上下文面板 | 仅设置 Tab |
| LLM 无 tool_calls | 失败软降级 |

---

## 7. 合入 / 发版检查清单

- [x] `@foreshadow/core` 已发布到 npm（`0.2.0`）
- [x] web-ui 依赖为 semver（`^0.2.0`），非 `file:`
- [ ] lockfile 已随依赖更新提交
- [ ] §5.2 自动化命令通过
- [ ] §5.1 手工冒烟（至少 B1–B7、B10）
- [ ] PR 无绝对本地路径、无临时调试日志

---

## 8. 文档维护

- 依赖策略、MCP 契约、门闩、权限变更时同步本文件与权威 SPEC。
- 主线引入方式变更时，同步更新 integration SPEC 副本中的依赖表与 B16 表述。
