# Alyce Code Agent

一个基于 TypeScript 的终端 Agent，用于和 AI 多轮对话，并在会话中执行工具调用（列目录、读文件、写文件、执行命令）。

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
		registry.ts                # Tool schema 注册
		executeToolCall.ts         # 工具调度入口
		builtin/
			fsTools.ts               # list_files / read_file / write_file
			commandTool.ts           # run_command
		internal/
			pathSandbox.ts           # 工作区路径沙箱
			shell.ts                 # 子进程命令执行与超时
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
- --system-prompt "自定义系统提示词"
- --system-prompt-file ./prompt.txt
- --append-system-prompt "额外规则"
- --append-system-prompt-file ./append.txt

## 环境变量

- OPENAI_API_KEY：必填
- OPENAI_BASE_URL：可选，兼容 OpenAI 协议的网关
- OPENAI_MODEL：可选，默认模型名
- AGENT_WORKSPACE：可选，工作区根目录
- AGENT_MAX_STEPS：可选，单轮最大工具调用步数
- AGENT_COMMAND_TIMEOUT_MS：可选，命令工具超时毫秒
- AGENT_LANGUAGE：可选，语言偏好（会写入系统提示词）
- AGENT_SYSTEM_PROMPT：可选，覆盖默认系统提示词
- AGENT_APPEND_SYSTEM_PROMPT：可选，在默认提示词后追加指令
- AGENT_MEMORY_DIR：可选，持久记忆目录，默认 .alyce/memory
- AGENT_MEMORY_FILE：可选，持久记忆文件名，默认 MEMORY.md
- AGENT_MEMORY_MAX_SESSION：可选，会话记忆条目上限
- AGENT_MEMORY_MAX_PERSISTENT：可选，持久记忆条目上限
- AGENT_MEMORY_MAX_PROMPT：可选，注入提示词的记忆条目上限

## 对话命令

- /help：查看命令帮助
- /clear：清空历史并重建系统提示词
- /remember <text>：写入会话记忆 + 持久记忆
- /remember --session <text>：仅写入会话记忆
- /memory：查看当前记忆快照
- /memory clear：清空会话记忆
- /memory clear --all：清空会话记忆和持久记忆
- /context [text]：预览下一轮完整请求上下文（可选附带下一句用户输入）
- /model <name>：切换模型并刷新系统提示词
- /exit：退出

## 后续建议

- 增加 Planner 层（计划创建、更新、完成状态）
- 增加 Patch 编辑器工具（最小差异修改）
- 增加测试执行策略与失败自动归因
