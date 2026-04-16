# Alyce Agent

一个基于 TypeScript 的终端 Agent，默认运行在交互式 React TTY UI 中，支持多步工具调用、工具审批、Prompt 组装、会话记忆和持久记忆。

## 核心特性

- UI：React + Ink 终端界面。
- 多步 Agent Turn：模型可在单轮内连续调用多个工具，再汇总输出最终回复。
- 工具权限控制：命令执行、文件写入、Web 访问都能按会话策略审批。
- Prompt 工程化：静态段、动态段、persona、附加 system prompt 都通过 builder 统一组装。
- 记忆系统：支持 session memory、persistent memory 和 auto summary，持久化到工作区 `.alyce/`。
- 中断恢复：文件写入前自动做快照，用户中断后可在可恢复场景下回滚本轮变更。

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 初始化环境变量

```bash
copy .env.example .env
```

至少配置：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

3. 启动开发模式

```bash
npm run dev
```

4. 构建并运行产物

```bash
npm run build
npm start
```

注意：

- 应用必须运行在交互式 TTY 终端中，否则 `startReactUiMode()` 会直接报错。
- 当前 `npm run dev` 实际执行的是先构建、再运行 `dist/index.js`，不是热更新式 dev server。

## 分层架构

整体可以拆成五层：

1. 入口与会话装配层：`src/index.ts`、`src/cli/`
   负责加载环境变量、读取运行时配置、初始化 `SessionRuntime`、创建 UI store 和 controller。
2. UI 层：`src/terminal-ui/`
   负责终端渲染、输入处理、快捷键、弹窗、状态展示，以及把运行时事件映射成可视消息。
3. Agent 核心层：`src/core/agent/`、`src/core/api/`
   负责一次 turn 的模型调用闭环，以及 OpenAI 请求封装、request patch 注入。
4. Prompt 与记忆层：`src/core/prompt/`、`src/core/memory/`
   负责生成 system prompt、聚合短期记忆、持久记忆和自动摘要。
5. 工具层：`src/tools/`
   负责工具定义、JSON schema 注册、参数校验、权限审批和具体工具执行。

## 详细目录结构

```text
.
├─ src/
│  ├─ index.ts                          # 程序入口，加载环境变量并进入 React UI 模式
│  ├─ agent.ts                          # 对外导出 runAgentTurn
│  ├─ tools.ts                          # 对外导出工具 schema、定义和执行入口
│  ├─ cli/
│  │  ├─ startReactUiMode.ts            # TTY 检查，创建 runtime/store/controller，启动 UI
│  │  ├─ sessionRuntime.ts              # 会话级 runtime，整合配置、消息、记忆、文件回滚
│  │  ├─ commandRouter.ts               # /help /memory /model 等命令解析
│  │  ├─ contextPreview.ts              # 预览下一轮发给模型的上下文
│  ├─ config/
│  │  └─ runtime.ts                     # 读取 .alyce / ~/.alyce / env / CLI，归一化运行时配置
│  ├─ core/
│  │  ├─ agent/
│  │  │  └─ runAgentTurn.ts             # 模型回复 -> 工具执行 -> 工具结果回填 的闭环
│  │  ├─ api/
│  │  │  ├─ sendChatCompletion.ts       # OpenAI Chat Completions 请求封装
│  │  │  └─ requestPatch.ts             # request patch 解析与注入
│  │  ├─ prompt/
│  │  │  ├─ builder.ts                  # 构建最终 system prompt
│  │  │  ├─ sectionResolver.ts          # 动态 section 解析与缓存
│  │  │  ├─ sectionFactory.ts           # section 工厂
│  │  │  ├─ sections.ts                 # prompt section 定义
│  │  │  ├─ types.ts                    # prompt 类型定义
│  │  │  └─ fragments/
│  │  │     ├─ staticSections.ts        # 静态提示段
│  │  │     ├─ dynamicSections.ts       # 动态提示段
│  │  │     ├─ personaPresets.ts        # 内置 persona preset
│  │  │     └─ formatting.ts            # prompt 文本格式化工具
│  │  ├─ memory/
│  │  │  ├─ memoryService.ts            # 统一记忆入口，聚合 session / persistent / summary
│  │  │  ├─ sessionMemoryStore.ts       # 进程内短期记忆
│  │  │  ├─ persistentMemoryStore.ts    # 持久记忆，写入 .alyce/memory/MEMORY.md
│  │  │  ├─ autoSummary.ts              # 长对话自动摘要生成
│  │  │  └─ types.ts                    # 记忆相关类型
│  │  ├─ file-history/
│  │  │  └─ fileHistoryManager.ts       # 文件写入前快照与 turn 级回滚
│  │  └─ abort.ts                       # 中断信号和错误归一化
│  ├─ tools/
│  │  ├─ definitions.ts                 # 内置工具定义集合
│  │  ├─ registry.ts                    # OpenAI tool schema 注册表
│  │  ├─ executeToolCall.ts             # 参数解析、Zod 校验和统一调度
│  │  ├─ types.ts                       # 工具上下文、审批请求、权限类型
│  │  ├─ internal/
│  │  │  ├─ pathSandbox.ts              # 工作区路径沙箱
│  │  │  └─ values.ts                   # 内部常量
│  │  ├─ BashTool/                      # 通用 shell 命令执行，Windows 下实际走 powershell.exe -Command
│  │  ├─ PowerShellTool/                # 显式 PowerShell 命令执行，适合 PowerShell 专属脚本或参数
│  │  ├─ FileReadTool/                  # 文本文件读取，支持 offset/limit 和行号输出
│  │  ├─ FileWriteTool/                 # 全量写文件，新建/覆盖前会审批并记录文件快照
│  │  ├─ FileEditTool/                  # 基于 old_string/new_string 的精确替换编辑，默认要求唯一命中
│  │  ├─ WebFetchTool/                  # 抓取单个网页内容，HTML 转纯文本后可按 prompt 做轻量提取
│  │  └─ WebSearchTool/                 # 基于 DuckDuckGo HTML 搜索结果页的网页搜索，支持域名过滤
│  └─ terminal-ui/
│     ├─ entrypoints/
│     │  └─ startReactUi.tsx            # 调用 Ink render，等待 UI 退出
│     ├─ app/
│     │  └─ App.tsx                     # 注入 store provider，挂载 AgentScreen
│     ├─ screens/
│     │  └─ AgentScreen.tsx             # 主屏幕，组合消息区、输入框、状态栏、弹窗
│     ├─ adapters/
│     │  ├─ sessionController.ts        # UI 事件和 runtime/agent 的桥接层
│     │  └─ messageMapper.ts            # 把运行时事件转换成 UI message
│     ├─ components/
│     │  ├─ Layout.tsx                  # 页面骨架
│     │  ├─ StatusBar.tsx               # 顶部状态栏
│     │  ├─ MessageList.tsx             # 会话消息列表
│     │  ├─ MessageReaderScreen.tsx     # 单条消息阅读页
│     │  ├─ PromptInput.tsx             # 输入框
│     │  ├─ ApprovalDialog.tsx          # 权限审批弹窗
│     │  └─ SettingsDialog.tsx          # 设置弹窗
│     ├─ state/
│     │  ├─ store.tsx                   # useSyncExternalStore 驱动的轻量 store
│     │  ├─ actions.ts                  # 纯函数状态变换
│     │  └─ types.ts                    # UI 状态、消息和弹窗类型
│     ├─ keybindings/
│     │  ├─ defaultBindings.ts          # 默认快捷键
│     │  ├─ resolver.ts                 # 快捷键解析
│     │  ├─ parser.ts
│     │  ├─ match.ts
│     │  ├─ shortcutDisplay.ts
│     │  ├─ useKeybindings.ts
│     │  └─ types.ts
│     ├─ context/
│     │  └─ overlayContext.tsx          # overlay 激活态共享
│     ├─ theme/
│     │  └─ theme.ts                    # UI 主题
│     ├─ runtime/
│     │  ├─ ink.ts                      # Ink 兼容导出
│     │  ├─ AlternateScreen.tsx         # 进入终端 alternate screen
│     │  ├─ input.ts                    # 原始终端输入订阅
│     │  ├─ parseKeypress.ts            # 键盘事件解析
│     │  ├─ ScrollBox.tsx               # 滚动容器
│     │  ├─ CursorDeclarationContext.ts # 光标声明上下文
│     │  ├─ useDeclaredCursor.ts        # 光标同步 hook
│     │  ├─ instances.ts                # Ink 实例管理
│     │  └─ vendor/ink/                 # vendored Ink runtime
│     └─ utils/
│        └─ text.ts                     # 文本处理辅助
├─ .alyce/                              # 工作区本地配置、状态和记忆
│  ├─ config.json                       # 项目级连接配置
│  ├─ settings.json                     # 项目级会话设置
│  └─ memory/
│     └─ MEMORY.md                      # 持久记忆文件
├─ dist/                                # TypeScript 构建产物
├─ .env.example                         # 启动时的环境变量模板
├─ package.json                         # 脚本与依赖声明
├─ tsconfig.json                        # TypeScript 编译配置
└─ README.md
```

## UI 层逻辑

### 1. 启动链路

`src/index.ts` 加载环境变量后进入 `startReactUiMode()`，启动顺序是：

```text
load env
  -> createSessionRuntime()
  -> createInitialTerminalUiState()
  -> createTerminalUiStore()
  -> createSessionController()
  -> controller.initialize()
  -> startReactUi()
  -> render(<App />)
```

这里 `SessionRuntime` 负责真正的运行时能力，`TerminalUiStore` 负责 UI 状态，`SessionController` 负责把 UI 事件翻译成 runtime 调用。

### 2. UI 组件职责划分

- `App.tsx`：只做 provider 注入和根组件挂载。
- `AgentScreen.tsx`：主屏调度中心，组合 `StatusBar`、`MessageList`、`PromptInput`、`ApprovalDialog`、`SettingsDialog`。
- `Layout.tsx`：把 header / body / footer / overlay 统一拼装成终端布局。
- `MessageReaderScreen.tsx`：针对超长消息提供单独阅读模式。
- `PromptInput.tsx`：输入提交、禁用态和 Ctrl+C 捕获逻辑。

### 3. UI 状态流

UI 没有引入 Redux 一类外部状态库，而是自建了一个很轻量的 external store：

- `state/store.tsx` 提供 `getState()`、`subscribe()`、`updateState()`。
- `useTerminalUiSelector()` 基于 `useSyncExternalStore` 订阅局部状态。
- `state/actions.ts` 只保留纯函数状态变换，不在里面混入副作用。

这意味着副作用集中在 `sessionController.ts`，而 UI 组件本身主要负责渲染和转发事件。

### 4. UI 与运行时的桥接

`sessionController.ts` 是 UI 层的核心控制器，主要负责：

- 解析 `/help`、`/memory`、`/model` 等内置命令。
- 接收用户输入，创建 turn checkpoint 和 `AbortController`。
- 调用 `runAgentTurn()` 发起模型请求。
- 把 thinking、tool start、tool result、assistant reply 映射为 UI message。
- 在工具需要审批时打开 `ApprovalDialog`，并把决策回传给工具执行上下文。
- 在用户中断时决定是否允许恢复上一轮，并在可恢复场景下回滚消息和文件。

可以把它理解成：UI 不直接碰 OpenAI 和工具执行，所有“有副作用的动作”都从 controller 进入。

### 5. 快捷键与覆盖层

- `useKeybindings()` 负责默认快捷键匹配。
- `overlayContext.tsx` 用于在弹窗、阅读器等 overlay 激活时临时屏蔽部分全局快捷键。
- `AgentScreen.tsx` 还额外处理了 `Ctrl+C`、`Esc`、消息翻页、消息选择等终端交互细节。

## 记忆层逻辑

### 1. 记忆分层

记忆系统由 `MemoryService` 统一对外暴露，但内部拆成三层：

1. `SessionMemoryStore`
   只存在当前进程内，保存短期会话记忆；达到上限后裁剪旧记录。
2. `PersistentMemoryStore`
   把记忆持久化到 `.alyce/memory/MEMORY.md`，格式是人类可读的 Markdown 列表，便于手工审查和版本管理。
3. `autoSummary`
   当对话达到阈值时，用模型把最近一段会话压缩成摘要，降低后续 prompt 膨胀。

### 2. 写入路径

显式记忆写入主要来自 `/remember`：

```text
/remember <text>
  -> MemoryService.remember()
  -> SessionMemoryStore.add()
  -> PersistentMemoryStore.add()    # 默认开启，--session 时跳过
  -> resetSystemMessage()
```

也就是说，记忆不是“单独挂着不管”，而是写入后会立刻刷新 system prompt，让后续轮次可见。

### 3. Prompt 注入路径

`createSessionRuntime()` 初始化时会构造 `buildSystemPrompt()`，其中会调用：

```text
memoryService.getPromptContext()
  -> sessionNotes
  -> persistentNotes
  -> sessionSummary
  -> buildEffectiveSystemPrompt()
```

所以进入模型的记忆上下文不是原始全量历史，而是：

- 最近的 session notes
- 最近的 persistent notes
- 自动摘要后的 session summary

这样可以兼顾记忆保留和上下文长度控制。

### 4. 自动摘要更新

每次 turn 完成后，`sessionController.ts` 会调用：

```text
memoryService.maybeRefreshAutoSummary()
  -> getConversationMessageCount()
  -> 达到阈值才触发 buildAutoSessionSummary()
  -> 更新 autoSummary
  -> resetSystemMessage()
```

其中：

- 初次生成摘要要达到 `minMessagesToInit`
- 后续更新要满足 `messagesBetweenUpdates`
- 只取最近 `windowMessages` 条消息进入摘要窗口

摘要模板固定包含：

- `Current State`
- `User Goal`
- `Key Decisions`
- `Files and Commands`
- `Errors and Fixes`
- `Next Steps`

这样下一轮模型更容易拿到“工程上下文”而不是冗长对话全文。

### 5. 清理与查看

- `/memory`：展示 session memory、persistent memory 和 auto summary 快照。
- `/memory clear`：只清空 session memory 和自动摘要。
- `/memory clear --all`：同时清空持久记忆文件。
- `/clear`：清空会话消息、session memory、prompt cache 和文件回滚历史，但保留连接配置与设置。

## 一次 Agent Turn 的完整链路

```text
用户输入
  -> SessionController.submit()
  -> parseReplCommand() / 或进入模型回路
  -> runtime.messages 追加 user message
  -> runAgentTurn()
  -> sendChatCompletion()
  -> 模型返回 assistant content / tool_calls
  -> executeToolCall()
  -> 工具结果写回 messages
  -> 模型继续推理，直到不再请求工具
  -> UI 追加 assistant message
  -> maybeRefreshAutoSummary()
  -> resetSystemMessage()
  -> 状态回到 Idle
```

`runAgentTurn()` 本质上是一个受 `maxSteps` 限制的循环，用来防止模型无限调用工具。

## 配置加载与覆盖关系

### 连接配置 `ConnectionConfig`

实际覆盖顺序是：

```text
default
  <- env
  <- user ~/.alyce/config.json
  <- project ./.alyce/config.json
  <- CLI
```

也就是 CLI 优先级最高，项目级配置会覆盖用户级配置，环境变量优先级最低。

### 会话设置 `SessionSettings`

实际覆盖顺序是：

```text
default
  <- project ./.alyce/settings.json
  <- user ~/.alyce/settings.json
  <- env
  <- CLI
```

也就是 CLI 最高，其次是环境变量，再到用户级和项目级设置。

## 内置工具说明

- `Read`：读取工作区内文本文件，支持按起始行和行数做局部读取；返回结果会附带行号，便于后续精确编辑。
- `Edit`：对已有文件做字符串级替换；默认要求 `old_string` 只命中一处，避免误改多处内容。
- `Write`：直接写入完整文件内容；适合新建文件或整体重写文件，落盘前会走 `file-write` 审批。
- `Bash`：执行通用 shell 命令；会校验工作目录在 workspace 内，执行前走 `command` 审批，并受超时限制。
- `PowerShell`：执行 PowerShell 命令；与 `Bash` 类似，但用于更明确的 PowerShell 场景和脚本语法。
- `WebFetch`：抓取单个 URL；若是 HTML，会先转成纯文本，再按可选 `prompt` 做关键词聚焦。
- `WebSearch`：发起网页搜索并返回标题、URL、摘要；当前实现基于 DuckDuckGo HTML 搜索页，并支持 `allowed_domains` / `blocked_domains`。

## 内置命令与按键

命令：

- `/help`
- `/settings`
- `/setup`
- `/clear`
- `/remember <text>`
- `/remember --session <text>`
- `/memory`
- `/memory clear`
- `/memory clear --all`
- `/context [text]`
- `/model <name>`
- `/exit`

按键：

以下按键为当前实现中的实际行为，按所处界面生效。

主界面（无弹窗、非阅读器）：

- `Ctrl+X`：打开设置
- `Ctrl+Q`：退出
- `Ctrl+O`：打开当前消息详情阅读器
- `Esc`：中断当前请求；若当前输入为空，则尝试恢复上一轮被中断的对话
- `Ctrl+C`：当输入框为空时触发退出确认，再按一次退出
- `Up` / `Down`：上下浏览会话流
- `PgUp` / `PgDn`：按页滚动会话流
- `Home` / `End`：跳到顶部 / 底部
- `Ctrl+0` / `Ctrl+Home`：跳到顶部
- `Ctrl+End`：跳到底部

输入框：

- `Enter`：发送消息
- `Shift+Enter` / `Alt+Enter`：插入换行
- `Ctrl+J`：插入换行
- `Left` / `Right` / `Up` / `Down`：移动光标
- `Home` / `End`：跳到输入开头 / 末尾
- `Ctrl+A` / `Ctrl+E`：跳到输入开头 / 末尾
- `Backspace` / `Delete`：删除字符
- `Ctrl+W`：删除前一个单词
- `Ctrl+U`：清空整段输入
- `Ctrl+C`：输入非空时清空当前输入

消息阅读器：

- `Esc` / `q` / `Ctrl+C`：关闭阅读器
- `Up` / `Down`：逐行滚动
- `PgUp` / `PgDn`：按页滚动
- `Space`：向下翻页
- `Home` / `End`：跳到顶部 / 底部
- `Ctrl+0`：跳到顶部

设置面板：

- `←` / `→`：切换 `Connection` / `Session`
- `↑` / `↓`：切换字段
- `Enter`：进入编辑，或对开关 / 下拉字段执行切换
- `Space`：切换开关 / 下拉字段
- `P`：在连接配置页切换保存目标（project / user）
- `S`：保存设置
- `Esc`：关闭面板；编辑状态下取消本次编辑

设置面板编辑状态：

- `Enter`：确认当前字段
- `Esc`：取消编辑
- `Backspace`：删除一个字符
- `Delete`：清空当前字段
- `Ctrl+C`：清空当前字段内容

工具审批弹窗：

- `↑` / `↓`：切换审批选项
- `Enter`：确认当前选项
- `Esc`：拒绝本次请求
- `1` / `2` / `3` / `4`：直接选择对应审批选项

## 开发与验证

- `npm run build`：当前最基础的验证手段。
- `npm run dev`：在真实 TTY 中验证 UI、审批弹窗、工具执行和记忆行为。
- 修改工具、审批逻辑或记忆逻辑后，建议至少手动验证以下场景：
  - 正常对话
  - 工具审批
  - `/remember` 与 `/memory`
  - 用户中断与恢复
  - 设置修改后 system prompt 刷新
