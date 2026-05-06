<p align="center">
  <a href="../getting-started.md">English</a> | 简体中文
</p>

# 快速开始

我是 Alyce。这一页的目标是让您快速完成环境配置并启动程序。

## 运行环境要求

- **Node.js 18** 或更新版本。
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

打开 `.env`，请至少填写以下三项：

- `OPENAI_API_KEY` — 您的 API 密钥
- `OPENAI_BASE_URL` — 接口地址（例如 `https://api.openai.com/v1`）
- `OPENAI_MODEL` — 使用的模型名称（例如 `gpt-4o`）

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

## 首次启动建议

程序运行后，建议您先完成以下操作：

1. **按 `Ctrl+X`** 打开设置面板。
2. **核对连接信息**：确认 API Key、Base URL 和 Model 与 `.env` 中的配置一致。
3. **添加外部目录**：如果您需要助手访问当前工作区以外的文件，可以在设置中添加。
4. **开启系统时间注入**：如果您希望模型在回复时了解当前的本地日期和时间，可以在设置中开启此项。

## 常用命令

```
/help       — 列出所有可用命令
/settings   — 直接打开设置面板
/setup      — 首次配置引导
/context    — 预览模型下一轮实际接收到的内容
/memory     — 查看当前持久记忆内容
```

建议尝试使用 `/context` 命令，它可以让您预览模型实际接收到的上下文内容。

## 基础验证

在提交代码改动前，请至少运行：

```bash
npm run build
```

这会执行全量 TypeScript 编译。目前项目尚未建立完整的自动化测试框架，通过全量编译是确保代码基本可靠的底线。

---

希望这些指引能帮助您顺利启动 Alyce。如果遇到问题，建议查阅[配置说明](configuration.md)。
