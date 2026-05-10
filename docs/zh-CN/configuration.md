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
- `AGENT_SESSION_MEMORY_FILE`：自动管理的会话记忆文件名，默认 `SESSION_MEMORY.md`。
- `AGENT_SESSION_MEMORY_ENABLED`：是否启用自动会话记忆提取，默认 `true`。
- `AGENT_SESSION_MEMORY_INIT_TOKENS`：首次初始化会话记忆所需的估算上下文 token 数，默认 `10000`。
- `AGENT_SESSION_MEMORY_UPDATE_TOKENS`：两次会话记忆更新之间需要增长的估算 token 数，默认 `5000`。
- `AGENT_SESSION_MEMORY_TOOL_CALLS`：最后一轮 assistant 仍有工具调用时，触发更新所需的工具调用数，默认 `3`。
- `AGENT_SESSION_MEMORY_TIMEOUT_MS`：后台会话记忆模型调用超时时间，默认 `180000` 毫秒。
- `AGENT_SESSION_MEMORY_MAX_FAILURES`：后台会话记忆连续失败多少次后本会话熔断，默认 `3`。
- `AGENT_SESSION_MEMORY_STALE_MS`：进行中的提取任务超过多久视为陈旧，默认 `60000` 毫秒。
- `AGENT_SESSION_MEMORY_WINDOW_MESSAGES`：每次提取最多带入的最近消息数，默认 `80`。
- `AGENT_SESSION_MEMORY_MAX_CHARS_PER_MESSAGE`：提取 prompt 中单条消息的截断字符数，默认 `1500`。
- `AGENT_MARKDOWN_TOOL_RENDERING_ENABLED`：是否为符合条件的工具结果启用 markdown 渲染，默认 `true`。
- `AGENT_MARKDOWN_RENDER_MAX_CHARS`：markdown 渲染字符预算，超过后回退到 plain/code section，默认 `32000`。
- `AGENT_SCROLL_SPEED`：转录区逐行滚动的基础行数，默认 `2`（会限制在 `1-8`）。
- `AGENT_SCROLL_ACCELERATION_ENABLED`：是否启用短时间连续滚动的加速，默认 `false`。
- `AGENT_MAX_MESSAGES_WITHOUT_VIRTUALIZATION`：禁用虚拟滚动时的安全消息上限，默认 `200`。
- `AGENT_HISTORY_PAGING_ENABLED`：实验功能，恢复超长会话时先加载最近窗口，滚到顶部附近再分块补载旧消息，默认 `false`。
- `ALYCE_WEB_SEARCH_PROVIDER`：搜索服务商（`auto`、`brave`、`exa`、`duckduckgo`）。
- `ALYCE_BRAVE_SEARCH_API_KEY`：Brave Search API 密钥。
- `ALYCE_WEB_FETCH_MAX_BYTES`：单次网页抓取的最大字节数。
- `AGENT_AUTO_COMPACT_TIMEOUT_MS`：自动压缩模型调用超时时间，默认 `180000` 毫秒。
- `AGENT_AUTO_COMPACT_MAX_FAILURES`：自动压缩连续失败多少次后本会话熔断，默认 `3`。
- `AGENT_MODEL_CONTEXT_WINDOW_OVERRIDES`：模型上下文窗口覆盖项，使用逗号分隔，例如 `custom fast=512000,my alias=1000000`。

兼容说明：`AGENT_MEMORY_AUTO_SUMMARY` 仍会作为 `AGENT_SESSION_MEMORY_ENABLED` 的旧别名读取，但旧的按消息数摘要变量已经废弃。

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
- **滚动速度**（`scrollSpeed`）：逐行滚动动作使用的基础行数（`1-8`）。
- **滚动加速**（`scrollAccelerationEnabled`）：开启后，短时间连续逐行滚动会逐级提速。
- **非虚拟消息上限**（`maxMessagesWithoutVirtualization`）：禁用虚拟滚动时的安全上限，避免回退路径无限增长。
- **历史分页**（`historyPagingEnabled`）：实验开关，恢复长会话时先挂载近期消息，滚到顶部再按块加载旧消息。

### 角色与语言
- **语言偏好**：助手回复时使用的语言。
- **角色预设**：选择内置的人格预设（如 `alyce`、`lilith`、`corin`）。
- **自定义人格提示词**：在预设基础上叠加的自定义指令。

### 记忆与上下文
- **会话记忆**：是否注入并自动维护会话记忆文件。旧设置文件里的 `autoSummaryEnabled` 会作为兼容别名读取。
- **系统时间注入**：是否让模型在每轮对话中感知当前的系统时间。
- **Markdown 消息渲染**（`markdownMessageRenderingEnabled`）：消息 markdown 渲染总开关。
- **工具结果 Markdown 渲染**（`markdownToolMessageRenderingEnabled`）：工具结果 markdown 渲染细粒度开关。
- **Markdown 渲染字符预算**（`markdownRenderMaxChars`）：超过预算时自动回退到 plain/code section 渲染。
- **对话压缩**：当请求接近模型上下文上限时，是否自动压缩旧消息。自动压缩带有超时和连续失败熔断，避免每轮重复卡住。
- **自动压缩超时**：自动压缩模型调用的最长等待时间，单位毫秒。
- **自动压缩失败阈值**：自动压缩连续失败达到该次数后，本会话停止自动重试。
- **会话记忆提取阈值**：自动会话记忆采用阈值触发方式：先达到初始化 token 阈值，之后必须满足 token 增量阈值，并且达到工具调用阈值或处于无工具调用的自然断点。更新任务在后台运行，带超时、陈旧任务取消和连续失败熔断。
- **上下文窗口覆盖**：为自定义模型别名或代理商模型名指定上下文窗口，写在 `modelContextWindowOverrides` 中。key 是宽松匹配模式，value 是 token 数，例如：

```json
{
  "modelContextWindowOverrides": {
    "company gemini pro": 1048576,
    "custom fast": 512000
  }
}
```

Alyce 会先使用这些覆盖项，再读取模型名里的 `128k`、`1m` 等显式后缀，然后匹配内置模型表。完全未知的模型会回退到 `128000` tokens。

### Markdown 渲染规则

- `assistant` / `thinking` 消息在开启 `markdownMessageRenderingEnabled` 时可走 markdown 渲染。
- `tool` 消息需要同时开启 `markdownMessageRenderingEnabled` 与 `markdownToolMessageRenderingEnabled`。
- `shell` / `write` / `edit` / `patch` 结果始终保持 code/diff-first，不走 markdown。
- markdown 化主要用于文本型工具结果（如 list/glob/grep/webfetch/websearch/codesearch 风格输出）；折叠预览仍保持 section 模式。
- 如果 markdown 解析触发安全预算（大小/行数/嵌套深度）或解析异常，会自动回退到 plain/code section，保证 UI 稳定。

### TTY 下的 Markdown 限制

- Alyce 使用终端原生渲染，不是浏览器 DOM 渲染。
- 不支持 DOM 级 HTML 能力（如浏览器布局/CSS/脚本执行等）。
- 表格、引用、链接等语义会按终端可读性做近似呈现。
- 复制行为以终端实际渲染文本为准；带标签链接会追加 `<URL>`，避免复制后丢失目标地址。

---

如果您在配置过程中遇到问题，建议使用 `/context` 命令查看模型实际接收到的 Payload，这有助于排查配置是否生效。
