# Alyce Agent

一个基于 TypeScript 的终端 Agent

## 核心特性

- UI-only：入口统一走交互式 TTY 终端界面，不再维护旧的 text CLI 分支。
- 多步 Agent Turn：模型可在单轮内连续调用多个工具，再返回最终文本。
- 工具权限控制：命令执行、文件写入、Web 访问按会话策略审批。
- Prompt 工程化：静态段、动态段、persona、附加指令统一通过 Prompt Builder 组装。
- 记忆系统：支持会话记忆、持久记忆和自动摘要，持久化到工作区 `.alyce/`。

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

- `OPENAI_API_KEY`: API
- `OPENAI_BASE_URL`: URL
- `OPENAI_MODEL`: Modelname

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

- 应用必须运行在交互式 TTY 中，否则会直接报错。
- 如果未配置 API Key，应用不会崩溃，而是引导进入连接设置。

## 项目结构

```text
src/
  index.ts                     # 入口
  cli/                         # 启动流程、命令解析、上下文预览
  config/                      # .alyce 配置读写与运行时归一化
  core/
    agent/                     # 单轮多步推理循环
    api/                       # OpenAI 请求封装与 request patch
    memory/                    # 会话记忆、持久记忆、自动摘要
    prompt/                    # Prompt section、resolver、builder
  tools/                       # Read/Edit/Write/Bash/PowerShell/WebFetch/WebSearch
  terminal-ui/                 # Ink UI、状态管理、控制器、弹窗
dist/                          # tsc 构建输出
docs/                          # 补充文档
.alyce/                        # 工作区本地状态与记忆文件
```

## 运行框架

### 1. 启动链路

`src/index.ts` 加载环境变量后进入 `startReactUiMode()`。这里会先检查 `stdin/stdout` 是否是 TTY，再创建 `SessionRuntime`、初始化 UI Store、绑定 `SessionController`，最后通过 Ink 渲染 `App`。

### 2. 配置与运行时

`src/config/runtime.ts` 负责合并配置，优先级为：

1. 工作区 `.alyce/config.json` 与 `.alyce/settings.json`
2. 环境变量 `.env` / 进程环境变量覆盖
3. CLI 参数最终覆盖

运行时拆成两类配置：

- 连接配置：API Key、Base URL、Model
- 会话配置：审批模式、最大步数、命令超时、语言偏好、persona、附加系统提示等

### 3. Prompt 与 Memory

`createSessionRuntime()` 会初始化 `MemoryService`，然后调用 `buildEffectiveSystemPrompt()` 生成当前 system prompt。Prompt 由静态段和动态段拼接，可选叠加：

- 内建 persona preset，例如 `alyce-original`
- 自定义 system prompt
- append system prompt

记忆系统包含三层：

- Session Memory：本轮会话内的短期记忆
- Persistent Memory：持久化笔记
- Auto Summary：对长对话的自动摘要，减少 prompt 膨胀

### 4. 单轮交互逻辑

一次正常交互的链路如下：

```text
用户输入
  -> SessionController.submit()
  -> 解析 /help /memory /model 等内置命令，或进入模型回路
  -> runAgentTurn()
  -> 发送 messages + TOOL_SCHEMAS 给模型
  -> 模型请求工具
  -> executeToolCall() 校验参数并执行工具
  -> 工具结果回写到 messages
  -> 模型继续推理或输出最终回答
  -> UI 刷新消息列表 / 状态栏 / 审批弹窗
  -> MemoryService 视阈值刷新 auto summary
```

`runAgentTurn()` 是核心循环。它会在 `maxSteps` 限制内持续执行“模型响应 -> 工具调用 -> 工具结果回填”，直到模型不再请求工具。

### 5. 工具与审批模型

工具注册集中在 `src/tools/definitions.ts`。当前内置：

- `Read`
- `Edit`
- `Write`
- `Bash`
- `PowerShell`
- `WebFetch`
- `WebSearch`

工具执行统一走 `executeToolCall.ts`：

- 先解析模型传入的 JSON 参数
- 用 Zod 校验输入
- 调用具体工具实现
- 将结果或错误统一序列化回模型

审批分三类：`command`、`file-write`、`web`。在 manual 模式下，控制器会弹出审批框；在 auto 模式下直接放行。文件路径会经过 workspace sandbox，防止越界访问。

## 配置与持久化文件

工作区会生成 `.alyce/` 目录：

- `.alyce/config.json`：连接配置
- `.alyce/settings.json`：运行时设置
- `.alyce/memory/MEMORY.md`：持久记忆文件

## 内置命令与快捷键

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

快捷键：

- `Tab`：切换消息区 / 输入区焦点
- `Ctrl+X`：打开设置
- `Ctrl+C`：清空当前输入；输入为空时退出
- `Ctrl+Q`：退出
- `Esc`：关闭详情或拒绝审批

## 开发与验证

- `npm run build`：当前最基础的验证手段
- `npm run dev`：验证 UI、工具审批和完整交互流
