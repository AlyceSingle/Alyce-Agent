# Alyce Agent

一个基于 TypeScript 的终端 Agent，用于和 AI 多轮对话，并在会话中执行工具调用。

默认显示策略：

- thinking 输出使用灰色 `assistant.thinking>` 前缀
- 正文输出使用青色 `assistant>` 前缀
- 在不支持颜色的终端会自动降级为纯文本输出


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

## 自动摘要机制

- 参考 Claude Code 的 SessionMemory 思路：不每轮都摘要，而是达到阈值后自动更新。
- 自动摘要会在每轮回复后按阈值尝试更新，并注入 system prompt 的 Memory 动态段。
- 你可以用 /memory 查看当前自动摘要内容与更新时间。

## 工程化工具调用链

- 工具 schema 由 zod 声明，并自动导出为 OpenAI function tools JSON Schema（当前工具名：Read、Edit、Write、Bash、PowerShell、WebFetch、WebSearch）。
- 模型工具参数会先做 zod safeParse 校验，再执行具体工具逻辑。
- 工具执行返回统一结构：ok/result 或 ok=false/error，便于模型稳定处理。
- 模型发送链路集中在 core/api：先标准化消息，再应用 JSON Patch，最后发送请求。

## 人格模板

- 系统提示词内置 AI Personality 段，并支持通过 AGENT_AI_PERSONALITY 或 --persona 叠加自定义人格描述。

## 后续建议

- 增加 Planner 层（计划创建、更新、完成状态）
- 增加 Patch 编辑器工具（最小差异修改）
- 增加测试执行策略与失败自动归因
