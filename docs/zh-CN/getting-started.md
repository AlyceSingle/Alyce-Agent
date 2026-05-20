<p align="center">
  <a href="../getting-started.md">English</a> | 简体中文
</p>

# 快速开始

我是 Alyce。这一页的目标是让您快速完成环境配置并启动程序。

## 运行环境要求

- **Node.js 20.10.0** 或更新版本。
- 一个真正的**交互式 TTY 终端**（支持光标移动和标准快捷键）。
- 一个**兼容 OpenAI 协议的 API 端点**。
- 三者缺一不可，否则程序在启动时会提示相关错误。

## 全局安装（推荐）

最简单的使用方式是通过 npm 全局安装 Alyce：

```bash
npm install -g alyce@latest
```

然后您可以在任何目录下直接输入以下命令启动：

```bash
alyce
```

## 本地开发（安装依赖）

```bash
npm install
```

这就完成了 TypeScript、React、Ink 以及所有运行时依赖的安装。

## 配置 .env

仓库中提供了模板文件，您可以直接复制使用：

```bash
copy .env.example .env     # Windows
# 或者：cp .env.example .env  # Linux / macOS
```

打开 `.env`，如果您想从环境变量启动，可以填写旧版 OpenAI-compatible 默认项：

- `OPENAI_API_KEY` — 您的 API 密钥
- `OPENAI_BASE_URL` — 接口地址（例如 `https://api.openai.com/v1`）
- `OPENAI_MODEL` — 使用的模型名称（例如 `gpt-4o`）

也可以不手动编辑 `.env`，启动 Alyce 后直接运行 `/connect`。Provider 选择器支持 OpenAI、Anthropic、Google、OpenRouter、DeepSeek、Kimi、Qwen、SiliconFlow、豆包、Ollama、LM Studio 和自定义 OpenAI-compatible 端点。Secret 字段会遮罩，并保存到 `~/.alyce/auth.json`。

**安全提示：** 请勿将 `.env` 文件提交到 Git 仓库。项目已默认在 `.gitignore` 中忽略此文件。

## 启动

您可以根据开发习惯选择启动方式：

**一步到位（编译并启动）：**
```bash
npm run dev
```

**先编译再运行：**
```bash
npm run build
npm start
```

启动时程序会自动检测 TTY 环境。如果配置有误（如缺少 API Key 或非交互式终端），程序会给出明确的错误提示。

## VS Code 集成终端辅助入口

你可以从 VS Code 集成终端把当前编辑文件或选区文件传给 Alyce，不需要安装 marketplace 插件：

```bash
alyce --cwd "C:\path\to\workspace" --context-file "src/index.ts" --initial-prompt "Review this file"
```

本地开发时，把 Alyce 参数放在 `npm run dev --` 后面：

```bash
npm run dev -- --context-file "src/index.ts" --initial-prompt "Review this file"
```

当前文件的 `.vscode/tasks.json` 示例：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Alyce: Current File",
      "type": "shell",
      "command": "alyce",
      "args": [
        "--cwd",
        "${workspaceFolder}",
        "--context-file",
        "${file}",
        "--initial-prompt",
        "Use the provided editor file as context."
      ],
      "problemMatcher": []
    }
  ]
}
```

选区文本需要先写入一个显式文件，再把该文件传给 Alyce。`alyce-vscode-selection` 辅助命令支持 `--selection`、`ALYCE_VSCODE_SELECTION` 或 stdin：

```bash
alyce-vscode-selection --out ".alyce/vscode-selection.txt" --selection "selected text"
alyce --cwd . --selection-file ".alyce/vscode-selection.txt" --initial-prompt "Review this selection"
```

当前文件加选区的 `.vscode/tasks.json` 示例：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Alyce: Write Selection",
      "type": "shell",
      "command": "alyce-vscode-selection",
      "args": [
        "--out",
        "${workspaceFolder}/.alyce/vscode-selection.txt"
      ],
      "options": {
        "env": {
          "ALYCE_VSCODE_SELECTION": "${selectedText}"
        }
      },
      "problemMatcher": []
    },
    {
      "label": "Alyce: Current File and Selection",
      "type": "shell",
      "dependsOn": "Alyce: Write Selection",
      "dependsOrder": "sequence",
      "command": "alyce",
      "args": [
        "--cwd",
        "${workspaceFolder}",
        "--context-file",
        "${file}",
        "--selection-file",
        "${workspaceFolder}/.alyce/vscode-selection.txt",
        "--initial-prompt",
        "Use the provided file and selection as context."
      ],
      "problemMatcher": []
    }
  ]
}
```

安全边界保持不变：启动文件必须位于 allowed roots 内，Alyce 不会自动读取整个 workspace，传入上下文也不会授予写入权限。

## 首次检查

程序启动后，请运行：

```text
/doctor
```

根据诊断报告修复缺失的配置、TTY 问题、过时的构建输出、审批风险、MCP 配置问题、技能发现问题、缺失的 `rg`/`git` 或 `.alyce` 存储问题。

如果需要在修改前进行分析，请输入：

```text
/plan
```

Plan Mode（计划模式）保持探索过程为只读。准备好进入实现阶段时，使用 `/plan exit` 或 `/build` 退出。在 Alyce 中，`/build` 只是退出计划模式的别名，并不会执行 `npm run build`。

## 首次启动建议

程序运行后，建议您先完成以下操作：

1. **运行 `/connect`** 选择 AI provider，并输入 API key、Base URL 和 Model。
2. **运行 `/model list`** 核对当前 provider/model 和 auth 状态，或运行 `/model`/`/models` 刷新并切换当前 provider 的模型。
3. **按 `Ctrl+X`** 按需调整会话/运行时设置。
4. **添加外部目录**：如果您需要助手访问当前工作区以外的文件，可以在设置中添加。

## 常用命令

```
/help       — 列出所有可用命令
/doctor     — 运行本地健康检查
/settings   — 直接打开会话设置面板
/settings connection — 打开 provider 连接选择器
/permissions — 切换审批和访问模式
/connect    — 打开 provider 选择器
/plan       — 进入只读计划模式
/build      — 退出 Plan Mode，不会执行 npm run build
/context    — 预览模型下一轮实际接收到的内容
/memory     — 查看当前持久记忆内容
```

如果仍然输入 `/setup`，Alyce 现在会给出迁移提示，并引导您改用 `/connect`。

建议尝试使用 `/context` 命令，它可以让您预览模型实际接收到的上下文内容。

## 排错流程

如果 Alyce 能启动，但工具、配置或本地环境表现不对，建议按这个顺序处理：

1. 先跑 `npm run build`，确认 `dist/` 是最新编译结果。
2. 在真实交互式终端里用 `npm start` 或 `npm run dev` 启动。
3. 进入 Alyce 后运行 `/doctor`。
4. 先修复 fail 项，再看 approval mode、持久外部目录、MCP、技能、`rg`、`git`、`.alyce` 存储和 request patch 相关 warning。

如果你希望 Alyce 先分析再动手，输入 `/plan`。Plan Mode 中写文件和修改型命令会被阻止。准备进入实现阶段时，用 `/plan exit` 或 `/build` 退出。

## 基础验证

在提交代码改动前，请至少运行：

```bash
npm run build
npm test
```

`npm run build` 会执行全量 TypeScript 编译。`npm test` 会自动发现并运行 `src/**/*.test.ts` 和 `src/**/*.test.tsx`。

如需只跑部分测试，可以传入路径或名称片段：

```bash
npm test -- commandRouter
npm test -- tools/internal
```

---

希望这些指引能帮助您顺利启动 Alyce。如果遇到问题，建议查阅[配置说明](configuration.md)。
