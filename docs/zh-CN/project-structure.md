<p align="center">
  <a href="../project-structure.md">English</a> | 简体中文
</p>

# 项目结构

我是 Alyce。这一页将为您介绍 Alyce 的代码组织方式、各层级职责以及开发建议。

## 顶层目录结构

```text
.
├─ src/            ← 源代码目录
├─ docs/           ← 项目文档
├─ dist/           ← TypeScript 编译输出目录
├─ .alyce/         ← 运行时状态：配置、记忆、会话历史
├─ User_Info/      ← 用户个人资料（不属于仓库）
└─ README.md       ← 项目入口说明
```

注意：`.alyce/` 目录由程序在运行时自动生成，请勿手动编辑其中的内容。

## `src/` 核心模块拆解

### 入口与启动

```
src/index.ts
src/cli/startReactUiMode.ts
```

负责环境初始化：
- 加载环境变量。
- 验证 TTY 环境。
- 初始化 Runtime、UI Store 和 Session Controller。
- 启动 React UI。

### CLI 与会话装配

```
src/cli/sessionRuntime.ts
src/cli/commandRouter.ts
src/cli/contextPreview.ts
```

连接模型与 UI 的中间层：
- 维护消息链。
- 合并配置、记忆与压缩规则。
- 解析 `/help`、`/remember`、`/resume` 等命令。
- 生成 `/context` 请求预览。

### 核心运行时 (Core)

#### `src/core/agent/`
包含 `runAgentTurn.ts`，负责 Agent 的主循环：调用模型、解析并执行工具、处理迭代。

#### `src/core/api/`
负责与模型 API 的实际通信，处理 Payload 封装与时间戳注入。

#### `src/core/memory/`
管理记忆服务，包括持久化存储、自动摘要生成以及 Prompt 注入逻辑。

#### `src/core/conversation/`
包含 `conversationCompactor.ts`，负责在对话过长时进行压缩，防止超出模型上下文限制。

#### `src/core/session-history/`
管理项目级的会话记录（JSONL 格式），支持通过 `/resume` 恢复对话。

#### `src/core/prompt/`
负责系统提示词（System Prompt）的动态构建，包括静态规则、环境信息和角色预设。

#### `src/core/file-history/`
在文件写入前记录快照，支持操作回滚。

### 工具层 (Tools)

```
src/tools/definitions.ts
src/tools/registry.ts
```

定义了助手可调用的所有工具，如 `Read`、`Edit`、`Bash`、`WebSearch` 等。每个工具都包含定义、执行逻辑和审批规则。

### 终端 UI (Terminal UI)

基于 React + Ink 构建的交互界面。
- `adapters/`: 运行时事件与 UI 状态的转换层。
- `components/`: 各种 UI 组件（输入框、弹窗、状态栏等）。
- `screens/`: 顶层页面组件。
- `state/`: UI 状态管理逻辑。

## 开发速查表

| 需求 | 入口文件/目录 |
|---|---|
| 修改模型接收的指令 | `src/core/prompt/` |
| 修改用户看到的界面 | `src/terminal-ui/components/` |
| 新增或修改工具功能 | `src/tools/` |
| 调整记忆或上下文逻辑 | `src/core/memory/` 或 `src/core/conversation/` |
| 修复启动相关问题 | `src/index.ts` 或 `src/cli/startReactUiMode.ts` |

---

希望这份地图能帮助您快速上手 Alyce 的开发。
