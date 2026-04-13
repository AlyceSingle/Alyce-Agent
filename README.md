# Alyce Agent

一个基于 TypeScript 的终端 Agent，用于和 AI 多轮对话，并在会话中执行工具调用。

默认显示策略：

- thinking 输出使用灰色 `assistant.thinking>` 前缀
- 正文输出使用青色 `assistant>` 前缀
- 在不支持颜色的终端会自动降级为纯文本输出

## 项目定位与核心能力

可持续执行任务的终端 Agent 运行时，目标是把以下能力放在同一条可控链路中：

- 多轮对话：保留完整消息历史，支持持续上下文。
- 工具编排：模型可在单轮内多次调用工具，再给出最终答案。
- 可控执行：工具审批、命令超时、路径沙箱、输出截断。
- 记忆增强：会话记忆 + 持久记忆 + 自动会话摘要，按阈值更新。
- 提示词工程化：静态段/动态段分离、会话级缓存、可覆盖/可追加。

概括：Alyce Agent = REPL 外层循环 + Agent 单轮多步循环 + 工具安全执行层 + Memory/Prompt 动态注入层。


## 当前目录骨架

```text
src/
	index.ts                     # CLI 启动与主循环
	agent.ts                     # 兼容导出（指向 core/agent）
	tools.ts                     # 兼容导出（指向 tools/*）

	cli/
		commandRouter.ts           # 命令解析
		contextPreview.ts          # 下一轮完整上下文预览

	config/
		runtime.ts                 # 环境变量与命令行参数解析

	core/
		api/
			requestPatch.ts          # JSON Patch 解析与请求改写
			sendChatCompletion.ts    # 模型请求标准化与发送封装
		agent/
			runAgentTurn.ts          # 单轮多步工具调用主循环
		memory/
			types.ts                 # Memory 类型定义
			sessionMemoryStore.ts    # 会话记忆存储
			persistentMemoryStore.ts # 持久记忆存储（文件）
			memoryService.ts         # Memory 统一服务入口
		prompt/
			types.ts                 # 提示词段落类型定义
			sections.ts              # 静态/动态段定义
			sectionResolver.ts       # 会话级段落缓存
			builder.ts               # 有效系统提示词组装

	tools/
		types.ts                   # ToolExecutionContext / JsonRecord
		definitions.ts             # 工具定义（zod schema + 执行函数）
		registry.ts                # Tool schema 注册
		executeToolCall.ts         # 工具调度入口
		BashTool/
			BashTool.ts              # Bash 工具执行实现
			prompt.ts                # Bash 工具描述模板
			toolName.ts              # Bash 工具名常量
		PowerShellTool/
			PowerShellTool.ts        # PowerShell 工具执行实现
			prompt.ts                # PowerShell 工具描述模板
			toolName.ts              # PowerShell 工具名常量
		FileReadTool/
			FileReadTool.ts          # Read 工具执行实现
			limits.ts                # Read 工具默认限制
			prompt.ts                # Read 工具描述模板
		FileEditTool/
			FileEditTool.ts          # Edit 工具执行实现
			constants.ts             # Edit 工具常量
			types.ts                 # Edit 工具输入输出 schema
			utils.ts                 # Edit 工具替换与补丁辅助
			prompt.ts                # Edit 工具描述模板
		FileWriteTool/
			FileWriteTool.ts         # Write 工具执行实现
			prompt.ts                # Write 工具描述模板
		WebFetchTool/
			WebFetchTool.ts          # WebFetch 工具执行实现
			prompt.ts                # WebFetch 工具描述模板
		WebSearchTool/
			WebSearchTool.ts         # WebSearch 工具执行实现
			prompt.ts                # WebSearch 工具描述模板
		internal/
			pathSandbox.ts           # 工作区路径沙箱
			values.ts                # 参数解析与输出截断
```

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 创建环境变量文件

```bash
copy .env.example .env
```

3. 在 .env 中设置 OPENAI_API_KEY

4. 启动

```bash
npm run dev
```

## 常用启动参数

```bash
npm run dev -- --model gpt-4.1-mini --cwd . --yolo
```

可选扩展参数：

- --lang zh-CN
- --persona "冷静、直接、偏工程实践"
- --system-prompt "自定义系统提示词"
- --system-prompt-file ./prompt.txt
- --append-system-prompt "额外规则"
- --append-system-prompt-file ./append.txt
- --request-patch "[{\"op\":\"replace\",\"path\":\"/temperature\",\"value\":0.1}]"
- --request-patch-file ./request-patch.json

## 环境变量

- OPENAI_API_KEY：必填
- OPENAI_BASE_URL：可选，兼容 OpenAI 协议的网关
- OPENAI_MODEL：可选，默认模型名
- AGENT_WORKSPACE：可选，工作区根目录
- AGENT_MAX_STEPS：可选，单轮最大工具调用步数
- AGENT_COMMAND_TIMEOUT_MS：可选，命令工具超时毫秒
- AGENT_OPENAI_REQUEST_PATCH：可选，JSON Patch 字符串，用于改写每次模型请求
- AGENT_OPENAI_REQUEST_PATCH_FILE：可选，JSON Patch 文件路径
- AGENT_LANGUAGE：可选，语言偏好（会写入系统提示词）
- AGENT_AI_PERSONALITY：可选，自定义 AI 性格提示词，会叠加在默认人格模板后
- AGENT_SYSTEM_PROMPT：可选，覆盖默认系统提示词
- AGENT_APPEND_SYSTEM_PROMPT：可选，在默认提示词后追加指令
- AGENT_MEMORY_DIR：可选，持久记忆目录，默认 .alyce/memory
- AGENT_MEMORY_FILE：可选，持久记忆文件名，默认 MEMORY.md
- AGENT_MEMORY_MAX_SESSION：可选，会话记忆条目上限
- AGENT_MEMORY_MAX_PERSISTENT：可选，持久记忆条目上限
- AGENT_MEMORY_MAX_PROMPT：可选，注入提示词的记忆条目上限
- AGENT_MEMORY_AUTO_SUMMARY：可选，是否启用自动会话摘要
- AGENT_MEMORY_SUMMARY_MIN_MESSAGES：可选，首次触发摘要所需最小消息数
- AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES：可选，两次摘要之间最小消息增量
- AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES：可选，摘要使用的最近消息窗口大小
- AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE：可选，单条消息进入摘要前的截断上限

## 对话命令

- /help：查看命令帮助
- /clear：清空历史并重建系统提示词
- /remember <text>：写入会话记忆 + 持久记忆
- /remember --session <text>：仅写入会话记忆
- /memory：查看当前记忆快照（含 AI 自动会话摘要）
- /memory clear：清空会话记忆
- /memory clear --all：清空会话记忆和持久记忆
- /context [text]：预览下一轮完整请求上下文（可选附带下一句用户输入）
- /model <name>：切换模型并刷新系统提示词
- /exit：退出

命令交互规则：

- 任何以 / 开头但不合法的命令都会直接报错。
- 以 / 开头的输入不会发送给 AI 模型。

## AI 运行逻辑（循环逻辑）

核心是“双层循环”：

- 外层循环：终端 REPL 循环（持续读取用户输入）。
- 内层循环：单轮 Agent 循环（一次用户输入内最多 N 步工具调用）。

### 1. 启动阶段（一次）

1. 解析运行时配置（环境变量 + CLI 参数）。
2. 初始化 MemoryService（会话记忆 + 持久记忆）。
3. 构建首条 system prompt 并写入消息历史 `messages[0]`。
4. 创建 OpenAI 客户端、readline 实例、工具执行上下文（审批/超时/工作区）。

### 2. 外层 REPL 循环（`src/index.ts`）

每次循环处理一个用户输入：

1. 读取输入并 trim；空输入直接继续下一轮。
2. 先走命令路由（`/help`、`/clear`、`/memory`、`/model` 等），命令只做本地控制，不进入模型。
3. 若是普通对话输入：
	 - 追加一条 `role=user` 消息。
	 - 调用 `runAgentTurn(...)` 进入内层循环。
	 - 输出 thinking 与最终答案。
4. 本轮完成后尝试自动摘要；若摘要更新成功，重建 system prompt（仅替换 `messages[0]`）。

### 3. 内层单轮多步循环（`src/core/agent/runAgentTurn.ts`）

`runAgentTurn` 是“单次用户输入”的核心执行器：

1. 从 `step = 0` 开始，最多执行到 `maxSteps - 1`。
2. 每一步请求模型：
	 - 传入完整消息历史。
	 - 传入 `TOOL_SCHEMAS`，`tool_choice=auto`。
	 - 经过 `sendChatCompletion` 的消息标准化 + 可选 JSON Patch 改写。
3. 解析模型返回：
	 - 抽取 thinking 文本块并回调输出。
	 - 先把 assistant 消息写回历史。
4. 分支判断：
	 - 无工具调用：本轮结束，返回最终自然语言答案。
	 - 有工具调用：逐个执行工具，把每个工具结果以 `role=tool` 追加到历史，再进入下一步。
5. 若步数用尽仍未结束，抛出 `Max tool steps reached`，避免无限循环。

### 4. 工具调用与错误兜底

`executeToolCall` 统一处理工具执行链：

1. 按名称查找工具定义，不存在则返回 `unknown_tool`。
2. 解析 JSON 参数，失败返回 `invalid_json_arguments`。
3. 通过 zod 做 schema 校验，失败返回 `invalid_tool_arguments`。
4. 执行工具，成功返回 `{ ok: true, result }`。
5. 捕获工具异常并返回 `{ ok: false, error: tool_execution_error }`。

这保证了“工具失败不会打断整轮推理”，模型仍可读取结构化错误并继续决策。

### 5. 自动摘要触发逻辑（阈值型）

自动摘要不是每轮都生成，而是按计数阈值触发：

- 首次触发：可见消息数 >= `minMessagesToInit`。
- 增量触发：相对上次摘要新增消息数 >= `messagesBetweenUpdates`。
- 摘要窗口：仅使用最近 `windowMessages` 条非 system 消息。

更新成功后，会把摘要注入 Memory 动态段，并刷新 system prompt，下一轮立即生效。

### 6. 运行安全边界与终止条件

- 命令执行超时：`AGENT_COMMAND_TIMEOUT_MS`。
- 单轮步数上限：`AGENT_MAX_STEPS`。
- 路径沙箱：拒绝访问工作区外路径。
- 输出截断：防止超长工具输出淹没上下文。
- 审批模式：默认审批，`--yolo` 可自动放行。

简化伪代码如下：

```text
bootstrap()
while (REPL alive):
	input = readUserInput()
	if command(input):
		handleLocally()
		continue

	messages.push(user)
	for step in [0..maxSteps):
		assistant = model(messages, tools)
		messages.push(assistant)
		if no tool_calls:
			print(final answer)
			break
		for call in tool_calls:
			toolResult = executeToolCall(call)
			messages.push(toolResult)

	maybeRefreshAutoSummary()
	if summaryUpdated:
		rebuildSystemPrompt(messages[0])
```

## 自动摘要机制

- 参考 Claude Code 的 SessionMemory 思路：不每轮都摘要，而是达到阈值后自动更新。
- 自动摘要会在每轮回复后按阈值尝试更新，并注入 system prompt 的 Memory 动态段。
- 你可以用 /memory 查看当前自动摘要内容与更新时间。

## 工程化工具调用链

- 工具 schema 由 zod 声明，并自动导出为 OpenAI function tools JSON Schema（当前工具名：Read、Edit、Write、Bash、PowerShell、WebFetch、WebSearch）。
- 模型工具参数会先做 zod safeParse 校验，再执行具体工具逻辑。
- 工具执行返回统一结构：ok/result 或 ok=false/error，便于模型稳定处理。
- 模型发送链路集中在 core/api：先标准化消息（例如 tool 空输出占位、assistant tool_calls content 归一化），再应用 JSON Patch，最后发送请求。

## 人格模板

- 系统提示词内置 AI Personality 段，并支持通过 AGENT_AI_PERSONALITY 或 --persona 叠加自定义人格描述。
