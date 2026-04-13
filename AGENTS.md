# AGENTS 指南

本文档用于帮助 AI 代理快速理解并安全地参与本仓库开发。

## 项目目标

- 构建一个可持续多轮执行任务的 TypeScript 终端 Agent。
- 支持单轮内多步工具调用（读写文件、命令执行、Web 获取/搜索）。
- 在保证可用性的同时，优先保障安全、可审计与可控。

## 技术栈

- 运行时：Node.js 20+
- 语言：TypeScript
- 模型 SDK：openai
- 启动方式：tsx（开发）+ tsc（构建）

## AI 运行逻辑（双层循环）

1. 启动阶段（src/index.ts）
- 解析运行时配置（env + CLI 参数）。
- 初始化 MemoryService。
- 构建并写入首条 system prompt。
- 初始化 OpenAI 客户端、readline、工具执行上下文。

2. 外层循环：REPL 输入循环（src/index.ts）
- 持续读取用户输入。
- 先解析 /help /clear /memory /model /exit 等命令，本地处理后直接 continue。
- 普通文本追加为 user message，进入单轮执行。

3. 内层循环：单轮多步工具调用（src/core/agent/runAgentTurn.ts）
- 每轮最多执行 AGENT_MAX_STEPS 步。
- 每步请求模型（携带 tool schema）。
- 若返回 tool_calls：执行工具并追加 tool message，继续下一步。
- 若无 tool_calls：返回最终文本并结束当前轮。

4. 回合收尾：自动摘要与提示词刷新（src/core/memory/memoryService.ts）
- 每轮完成后按阈值尝试更新自动摘要。
- 摘要更新成功时，仅替换 messages[0] 的 system prompt。

5. 安全终止条件
- 超过 maxSteps 终止当前轮，防止无限调用。
- 工具异常统一封装为结构化错误，不直接崩溃主循环。

## 目录结构

- src/index.ts：CLI 启动、REPL 主循环、命令分发
- src/cli/：命令解析与上下文预览
- src/config/runtime.ts：环境变量与参数解析
- src/core/agent/runAgentTurn.ts：单轮多步工具调用执行器
- src/core/api/：模型请求标准化、JSON Patch 改写与发送
- src/core/memory/：会话记忆、持久记忆、自动摘要、服务编排
- src/core/prompt/：提示词段落定义、缓存解析、最终组装
- src/tools/definitions.ts：工具定义与 schema
- src/tools/registry.ts：工具 schema 注册导出
- src/tools/executeToolCall.ts：工具调度与统一错误封装
- src/tools/*Tool/：各工具实现（Read/Edit/Write/Bash/PowerShell/WebFetch/WebSearch）
- src/tools/internal/：路径沙箱、参数/输出通用处理
- src/agent.ts、src/tools.ts：兼容导出层
- README.md：项目使用说明

## 工具与安全策略

- 写文件、执行命令等行为默认应支持审批。
- 路径操作必须限制在工作区根目录内（path sandbox）。
- 命令执行必须有超时控制，避免长时间阻塞。
- 大输出应截断，防止上下文被日志淹没。
- 工具输入先 JSON 解析再 schema 校验，失败返回结构化错误。

## 系统提示词与 Memory 策略

- 使用“静态段 + 动态段 + 边界标记”组织系统提示词。
- 会话级稳定段落可缓存，按轮变化段落每 turn 计算。
- 支持默认提示词、整段覆盖、追加提示词三种模式。
- Memory 作为辅助线索注入动态段，必须与实时文件/工具结果交叉验证。

## 开发约束

- 先小步改动，再验证构建通过。
- 不做无关重构，避免扩大变更面。
- 优先保持现有公共接口与行为稳定。
- 新增逻辑请补充简洁中文注释，说明关键意图与边界。
- 改动应落在正确分层：CLI、Config、Core、Tools 各司其职。
- 若修改循环行为、命令语义或工具接口，需同步更新 README 与相关 docs。

## 常用命令

- npm install：安装依赖
- npm run dev：开发模式运行
- npm run build：TypeScript 构建
- npm start：运行构建产物

## 代码风格建议

- 函数职责单一，命名清晰。
- 错误处理统一，返回可读且可程序化消费的信息。
- 避免过度注释，重点解释复杂分支和安全逻辑。

## 变更流程建议

1. 阅读相关文件并确认上下文。
2. 先实现最小可行修改。
3. 运行 npm run build 做快速验证。
4. 若行为或命令发生变化，同步更新 README 与文档。
