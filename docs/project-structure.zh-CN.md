<p align="center">
  <a href="./project-structure.md">English</a> | 简体中文
</p>

# 项目结构

我是 Alyce。这个文件主要回答一个很实际的问题：代码放在哪里、每一层负责什么、改动行为时应该先从哪一层开始看。

## 顶层目录

```text
.
├─ src/            运行时代码
├─ docs/           项目文档
├─ dist/           TypeScript 编译产物
├─ .alyce/         项目级状态、配置和记忆
├─ User_Info/      用户自有数据
└─ README.md       仓库总览
```

## `src/` 分层

### 入口与启动

- `src/index.ts`
- `src/cli/startReactUiMode.ts`

职责：

- 加载环境变量
- 校验 TTY 运行环境
- 创建 runtime、store 和 controller
- 启动 React UI

### CLI 与会话装配

- `src/cli/sessionRuntime.ts`
- `src/cli/commandRouter.ts`
- `src/cli/contextPreview.ts`

职责：

- 持有会话消息链
- 合并配置、记忆、启动文档和压缩逻辑
- 解析 slash 命令
- 生成请求预览

### 核心运行时

#### `src/core/agent/`

- `runAgentTurn.ts`

负责模型 -> 工具 -> 工具结果 -> 最终回复的单轮闭环。

#### `src/core/api/`

- `sendChatCompletion.ts`
- `requestPatch.ts`

负责聊天请求整形、时间戳注入和可选 patch。

#### `src/core/memory/`

- `memoryService.ts`
- `autoSummary.ts`
- `sessionMemoryStore.ts`
- `persistentMemoryStore.ts`

负责记忆收集、持久化和摘要刷新。

#### `src/core/conversation/`

- `conversationCompactor.ts`
- `messageMetadata.ts`

负责长对话压缩和逐条消息时间元数据。

#### `src/core/prompt/`

- `builder.ts`
- `sections.ts`
- `sectionResolver.ts`
- `startupInstructions.ts`
- `fragments/`

负责 system prompt 构建和动态上下文注入。

#### `src/core/file-history/`

- `fileHistoryManager.ts`

负责写入前快照和 turn 级回滚。

#### `src/core/time/`

- `systemTime.ts`

负责统一的系统日期时间格式化。

### 工具层

主要文件：

- `src/tools/definitions.ts`
- `src/tools/registry.ts`
- `src/tools/executeToolCall.ts`

内置工具包括：

- `AskUserQuestion`
- `Read`
- `Glob`
- `Grep`
- `TodoWrite`
- `Edit`
- `Write`
- `Bash`
- `PowerShell`
- `WebFetch`
- `WebSearch`

### 终端 UI 层

#### `src/terminal-ui/adapters/`

- `sessionController.ts`
- `messageMapper.ts`

负责把运行时事件映射进 UI，把 UI 动作回传到 runtime。

#### `src/terminal-ui/components/`

这里放输入框、弹窗、状态栏、消息详情、设置界面等组件。

#### `src/terminal-ui/screens/`

- `AgentScreen.tsx`

主会话界面。

#### `src/terminal-ui/state/`

- `types.ts`
- `actions.ts`
- `store.tsx`

负责 UI 状态管理。

#### `src/terminal-ui/keybindings/`

负责快捷键定义和解析。

#### `src/terminal-ui/runtime/ink-runtime/`

这里是 vendored 的 Ink runtime 实现。除非您是在修渲染、鼠标、滚动或者输入协议，否则通常不建议先动这一层。

## 改什么该看哪里

### 如果您要改“模型看到什么”

先看：

- `src/core/prompt/`
- `src/cli/sessionRuntime.ts`
- `src/core/api/sendChatCompletion.ts`

### 如果您要改“用户看到什么”

先看：

- `src/terminal-ui/adapters/sessionController.ts`
- `src/terminal-ui/components/`
- `src/terminal-ui/screens/AgentScreen.tsx`

### 如果您要新增或修改工具

先看：

- `src/tools/definitions.ts`
- 目标工具目录
- `src/tools/types.ts`

### 如果您要处理记忆或上下文膨胀

先看：

- `src/core/memory/`
- `src/core/conversation/conversationCompactor.ts`
- `src/cli/sessionRuntime.ts`
