# AGENTS 指南

本文档用于帮助 AI 代理快速理解并安全地参与本仓库开发。

## 项目目标

- 构建一个类 Claude Code 的 TypeScript 终端 Agent。
- 支持多轮对话与工具调用（文件系统与命令执行）。
- 在易用性的前提下，优先保障安全与可控。

## 技术栈

- 运行时：Node.js 20+
- 语言：TypeScript
- 模型 SDK：openai
- 启动方式：tsx（开发）+ tsc（构建）

## 目录结构

- src/index.ts：CLI 启动与主循环
- src/cli/：命令解析与上下文预览
- src/config/runtime.ts：环境变量与参数解析
- src/core/agent/runAgentTurn.ts：单轮多步工具调用执行器
- src/core/prompt/：系统提示词分段与组装
- src/tools/registry.ts：工具 schema 注册
- src/tools/executeToolCall.ts：工具调度入口
- src/tools/builtin/：内置工具实现
- src/tools/internal/：沙箱、shell、通用值处理
- src/agent.ts、src/tools.ts：兼容导出层
- README.md：项目使用说明

## 常用命令

- npm install：安装依赖
- npm run dev：开发模式运行
- npm run build：TypeScript 构建
- npm start：运行构建产物

## 开发约束

- 先小步改动，再验证构建通过。
- 不要无关重构，避免扩大变更面。
- 优先保持现有公共接口与行为稳定。
- 新增逻辑请补充简洁中文注释，说明关键意图与边界。
- 优先在对应分层落代码：CLI、Config、Core、Tools 各司其职。

## 工具与安全策略

- 涉及写文件或执行命令的行为默认应可审批。
- 路径操作必须限制在工作区根目录内。
- 命令执行要有超时控制，避免长时间阻塞。
- 大输出内容应截断，防止上下文被日志淹没。

## 系统提示词策略

- 使用“静态段 + 动态段 + 边界标记”结构组织提示词。
- 会话级稳定段落可缓存；按轮变化段落应按 turn 计算。
- 自定义系统提示词可整段覆盖，追加提示词用于策略扩展。

## 代码风格建议

- 函数职责单一，命名清晰。
- 统一错误处理并返回可读错误信息。
- 避免过度注释，重点说明复杂分支和安全逻辑。

## 变更流程建议

1. 阅读相关文件并确认上下文。
2. 先实现最小可行修改。
3. 运行 npm run build 做快速验证。
4. 更新 README（若行为或命令发生变化）。
