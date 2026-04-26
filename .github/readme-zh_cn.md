<h1 align="center">Alyce-Agent</h1>

<p align="center">
  一个认真、克制、终端优先的本地编码代理。
</p>

<p align="center">
  <a href="../README.md">English</a> | 简体中文
</p>

我是 Alyce。这个仓库是一个运行在终端里的 TypeScript 编码代理，底层主要用 React 和 Ink。我会尽量把运行时整理得更清楚一点：把 prompt 分层组装、让工具遵守审批边界、把记忆和上下文长度控制住，并且始终以真实的交互式 TTY 为主要运行环境，而不是浏览器壳子。

## Alyce-Agent 是什么

Alyce-Agent 目前是一套本地优先的编码助手框架，包含：

- 交互式终端 UI
- 支持多步工具调用的 Agent Turn
- 带人格和动态环境片段的 Prompt 组装
- 会话记忆、持久记忆、自动摘要和对话压缩
- 带审批边界的命令、文件和 Web 工具
- 中断文件编辑后的回滚能力

## 主要特点

- 终端原生 UI：基于 React + Ink，包含弹窗、消息详情和设置界面
- 工具闭环：模型可以在单轮里连续调用多个工具，再整理出最终回复
- Prompt 工程化：静态规则、动态环境、人格覆盖统一组装为 system prompt
- 上下文控制：消息时间戳、记忆注入、自动摘要、对话压缩一起工作，尽量避免 prompt 无限制膨胀
- 安全护栏：文件访问范围、审批流程、写入前快照都在运行时中处理

## 快速开始

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

4. 启动 Alyce-Agent

```bash
npm run dev
```

或者先构建再运行：

```bash
npm run build
npm start
```

## 文档索引

- [文档索引](../docs/zh-CN/README.md)
- [快速开始](../docs/zh-CN/getting-started.md)
- [项目结构](../docs/zh-CN/project-structure.md)
- [命令与按键](../docs/zh-CN/commands-and-keys.md)
- [配置说明](../docs/zh-CN/configuration.md)
- [记忆与上下文](../docs/zh-CN/memory-and-context.md)
- [贡献指南](../docs/zh-CN/contributing.md)
- [安全说明](../docs/zh-CN/security.md)

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

如果您准备维护代码，我建议先看 [项目结构](../docs/zh-CN/project-structure.md)。层次清楚一点的时候，我……会安心很多。
