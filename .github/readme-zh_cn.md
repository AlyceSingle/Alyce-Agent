<h1 align="center">Alyce</h1>

<p align="center">
  一个认真、克制、终端优先的本地编码代理。
</p>

<p align="center">
  <a href="https://github.com/AlyceSingle/Alyce-Agent/blob/master/README.md">English</a> | 简体中文
</p>

> [!IMPORTANT]
> **项目说明**：本项目是我在**学习 Agent 构建过程中的产物**。目前还处于比较早期的实验阶段，很多地方可能还不完善。虽然我会持续维护和优化，但代码结构和功能可能会有较大的变动，建议大家先抱着“尝鲜”的心态试用。非常欢迎各位大佬提 Issue 或 PR，您的每一个建议对我来说都非常宝贵！

我是 Alyce，一个专注于终端交互的编码助手，旨在成为您的工程合作伙伴。我基于 TypeScript、React 和 Ink 构建，致力于提供透明且可控的运行机制。我的核心设计包括分层 Prompt 组装、严格的工具调用审批边界以及精细的上下文管理，并始终运行在真实的交互式 TTY 环境中。

## Alyce 能做什么

Alyce 是一套本地优先的编码助手框架，它的核心功能包括：

- **交互式终端 UI**：基于 React + Ink 打造，提供直观的命令行交互体验。
- **多步工具调用**：Agent 可以在一轮对话中连续使用多个工具来解决复杂问题。
- **灵活的 Prompt 组装**：支持根据不同的人格预设和动态环境片段实时生成系统提示词。
- **智能上下文管理**：具备会话恢复、持久记忆、自动摘要和对话压缩功能，让长对话依然保持高效。
- **安全可控的工具箱**：内置了带审批机制的命令执行、文件操作和网页抓取工具。
- **本地技能加载**：可以从项目级或用户级 `SKILL.md` 加载技能指令。
- **MCP 扩展接入**：支持通过 `.alyce/mcp.json` 配置 stdio、streamable HTTP 和 SSE MCP server，暴露资源和动态工具。
- **可靠的编辑回滚**：如果文件修改过程中断，支持自动或手动回滚，保护您的代码安全。

## 快速开始

### 全局安装（推荐）

你可以通过 npm 全局安装 Alyce：

```bash
npm install -g alyce@latest
```

然后在任何地方启动它：

```bash
alyce
```

### 本地开发

1. 安装依赖

```bash
npm install
```

2. 用模板创建 `.env`

```bash
copy .env.example .env
# 或者：cp .env.example .env
```

3. 至少填写这些配置：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

4. 启动 Alyce

```bash
npm run dev
```

或者先构建再运行：

```bash
npm run build
npm start
```

## 文档索引

- [文档索引](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/README.md)
- [快速开始](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/getting-started.md)
- [项目结构](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/project-structure.md)
- [命令与按键](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/commands-and-keys.md)
- [配置说明](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/configuration.md)
- [记忆与上下文](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/memory-and-context.md)
- [角色预设](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/persona-presets.md)
- [贡献指南](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/contributing.md)
- [安全说明](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/security.md)

## 项目提示

- 程序必须运行在交互式 TTY 终端里
- `npm run dev` 实际是“先构建，再运行”，不是热更新式开发服务器
- 项目级运行时状态保存在 `./.alyce/`
- 用户级运行时状态保存在 `~/.alyce/`
- 本地技能放在 `.alyce/skills/**/SKILL.md`，MCP server 配置在 `.alyce/mcp.json`

## 最低验证

提交前至少建议执行：

```bash
npm run build
```

如果您计划维护或扩展代码库，建议先阅读 [项目结构](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/project-structure.md) 文档。清晰的架构层次将有助于您更高效地进行开发。
