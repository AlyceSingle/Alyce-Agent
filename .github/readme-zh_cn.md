<h1 align="center">Alyce</h1>

<p align="center">
  一个认真、克制、终端优先的本地编码代理。
</p>

<p align="center">
  <a href="../README.md">English</a> | 简体中文
</p>

> [!IMPORTANT]
> **项目说明**：本项目是我在**学习 Agent 构建过程中的产物**。目前还处于比较早期的实验阶段，很多地方可能还不完善。虽然我会持续维护和优化，但代码结构和功能可能会有较大的变动，建议大家先抱着“尝鲜”的心态试用。非常欢迎各位大佬提 Issue 或 PR，您的每一个建议对我来说都非常宝贵！

我是 Alyce。这个仓库是我在学习 Agent 构建过程中开发的一个终端编码助手，基于 TypeScript、React 和 Ink 构建。我尝试让它的运行机制更加透明和易控：通过分层组装 Prompt、严格遵守工具调用审批边界、精细管理记忆和上下文长度，并坚持让它运行在真实的交互式 TTY 环境中，而不是套个浏览器的壳子。

## Alyce 能做什么

Alyce 是一套本地优先的编码助手框架，它的核心功能包括：

- **交互式终端 UI**：基于 React + Ink 打造，提供直观的命令行交互体验。
- **多步工具调用**：Agent 可以在一轮对话中连续使用多个工具来解决复杂问题。
- **灵活的 Prompt 组装**：支持根据不同的人格预设和动态环境片段实时生成系统提示词。
- **智能上下文管理**：具备会话恢复、持久记忆、自动摘要和对话压缩功能，让长对话依然保持高效。
- **安全可控的工具箱**：内置了带审批机制的命令执行、文件操作和网页抓取工具。
- **可靠的编辑回滚**：如果文件修改过程中断，支持自动或手动回滚，保护您的代码安全。

## 核心亮点

- **纯正的终端体验**：完全基于 React + Ink，连弹窗、消息详情和设置界面都是在终端里渲染的。
- **强大的 Read 工具**：不仅能读文本，还能列目录、总结 Notebook、提供路径建议，甚至支持图片和 PDF 的多模态分析（在支持的模型下）。
- **严密的安全性**：
  - **审批流**：所有敏感操作（写文件、运行命令、访问外部目录）都必须经过您的同意。
  - **写保护**：内置单文件写锁、写入前快照和“先读后改”校验，确保代码不会被意外覆盖。
  - **格式化与诊断**：写入代码后会自动运行格式化工具并进行 TypeScript/JavaScript 语法检查。
- **丝滑的开发流程**：支持 `/resume` 恢复旧对话，支持 `Esc` 或 `/rewind` 快速回退到之前的状态。

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
- [apply_patch 工具](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/apply-patch-tool.md)
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
- `User_Info/` 被视为用户资料目录，不属于项目说明文档

## 最低验证

提交前至少建议执行：

```bash
npm run build
```

如果您准备维护代码，我建议先看 [项目结构](https://github.com/AlyceSingle/Alyce-Agent/blob/master/docs/zh-CN/project-structure.md)。层次清楚一点的时候，我……会安心很多。
