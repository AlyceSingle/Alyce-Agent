<p align="center">
  <a href="../configuration.md">English</a> | 简体中文
</p>

# 配置说明

我是 Alyce。本页将为您详细说明 Alyce 的配置系统，包括配置来源、优先级以及各项参数的含义。

## 配置优先级

Alyce 的配置采用分层加载机制，优先级从高到低排列如下（高优先级将覆盖低优先级）：

### 连接配置（API Key、Base URL、Model）
1. **命令行参数**（启动时传入）。
2. **环境变量**（`.env` 文件）。
3. **项目级配置**（`./.alyce/config.json`）。
4. **用户级配置**（`~/.alyce/config.json`）。

### 会话设置（角色、记忆、审批等）
1. **命令行参数**。
2. **环境变量**。
3. **项目级设置**（`./.alyce/settings.json`）。
4. **用户级设置**（`~/.alyce/settings.json`）。

## 环境变量说明

### 核心配置（必填）
- `OPENAI_API_KEY`：您的 API 密钥。
- `OPENAI_BASE_URL`：API 接口地址。
- `OPENAI_MODEL`：使用的模型标识符。

### 搜索与抓取（可选）
- `ALYCE_WEB_SEARCH_PROVIDER`：搜索服务商（`auto`、`brave`、`exa`、`duckduckgo`）。
- `ALYCE_BRAVE_SEARCH_API_KEY`：Brave Search API 密钥。
- `ALYCE_WEB_FETCH_MAX_BYTES`：单次网页抓取的最大字节数。

## 文件位置速查

| 内容 | 路径 |
|---|---|
| 项目连接配置 | `./.alyce/config.json` |
| 用户连接配置 | `~/.alyce/config.json` |
| 项目会话设置 | `./.alyce/settings.json` |
| 用户会话设置 | `~/.alyce/settings.json` |
| 项目 MCP server | `./.alyce/mcp.json` |
| 项目技能 | `./.alyce/skills/**/SKILL.md` |
| 用户技能 | `~/.alyce/skills/**/SKILL.md` |
| MCP 二进制资源输出 | `./.alyce/mcp-output/` |

`./` 开头的是项目级配置，只影响当前仓库；`~/` 开头的是用户级配置，对本机所有项目生效。请不要把包含密钥或本地运行状态的 `.alyce/` 提交到仓库。

## 本地技能

Alyce 会发现以下位置的技能：

- 项目技能：`./.alyce/skills/**/SKILL.md`
- 用户技能：`~/.alyce/skills/**/SKILL.md`

使用 `SkillTool` 并传入技能名称即可加载技能。项目技能会覆盖同名用户技能。技能文件可以包含简单 frontmatter：

```markdown
---
name: example
description: 用于重复项目任务的流程。
---

# Example Skill

这里写技能指令。
```

技能加载后会作为生成上下文注入到下一次模型调用中。加载技能需要工具审批。

## MCP 服务器

项目 MCP server 配置在 `./.alyce/mcp.json`。Alyce 支持本地 stdio server，也支持远程 streamable HTTP 或 SSE server。MCP 工具调用、资源列表和资源读取都会走审批。

### 本地 stdio server

例如安装 Chrome DevTools MCP：

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "startup_timeout_ms": 20000
    }
  }
}
```

启动后可用：

- `McpStatus`：查看 server、transport、endpoint、capabilities 和错误。
- `ListMcpResources`：列出 MCP resources，可按 server 过滤。
- `ReadMcpResource`：读取 resource。文本直接返回，二进制 blob 写入 `./.alyce/mcp-output/`。
- 动态 MCP tools：如果 server 暴露 tools，会以 `mcp__server__tool` 形式出现在工具列表里。

### 远程 streamable HTTP server

```json
{
  "mcpServers": {
    "remote-example": {
      "type": "streamable_http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      },
      "startup_timeout_ms": 20000
    }
  }
}
```

### 远程 SSE server

```json
{
  "mcpServers": {
    "legacy-sse": {
      "type": "sse",
      "url": "https://example.com/sse",
      "startup_timeout_ms": 20000
    }
  }
}
```

单个 MCP server 失败不会禁用其他已配置 server。

## 会话设置项

在设置面板（`Ctrl+X`）的“会话”标签页中可以调整以下内容：

### 执行与审批
- **审批模式**：控制工具调用的审批严格程度。
- **最大步数**：单轮对话中允许 Agent 连续调用工具的最大次数。
- **命令超时**：Shell 命令执行的超时时间（毫秒）。

### 角色与语言
- **语言偏好**：助手回复时使用的语言。
- **角色预设**：选择内置的人格预设（如 `alyce`、`lilith`、`corin`）。
- **自定义人格提示词**：在预设基础上叠加的自定义指令。

### 记忆与上下文
- **自动摘要**：是否开启近期对话的自动摘要功能。
- **系统时间注入**：是否让模型在每轮对话中感知当前的系统时间。
- **对话压缩**：当对话接近上下文上限时，是否自动压缩旧消息。

---

如果您在配置过程中遇到问题，建议使用 `/context` 命令查看模型实际接收到的 Payload，这有助于排查配置是否生效。
