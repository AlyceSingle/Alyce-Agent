<p align="center">
  <a href="../configuration.md">English</a> | 简体中文
</p>

# 配置说明

我是 Alyce。本页将为您详细说明 Alyce 的配置系统，包括配置来源、优先级以及各项参数的含义。

## 配置优先级

Alyce 的配置采用分层加载机制，优先级从高到低排列如下（高优先级将覆盖低优先级）：

### 连接配置（API Key、Base URL、Model、Provider）
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

## 启动上下文 CLI 参数

Alyce 可以在不安装 VS Code 插件的情况下接收显式编辑器上下文：

- `--cwd <path>`：在加载配置和检查路径前指定工作区根目录。
- `--context-file <path>`：读取一个文件，并作为下一轮模型请求的 generated context 注入。可重复传入。
- `--selection-file <path>`：读取包含编辑器选区文本的文件，并作为下一轮模型请求的 generated context 注入。可重复传入。
- `--initial-prompt <text>`：预填输入框；Alyce 不会自动发送。
- `--prompt-file <path>`：从文件读取预填输入；不能与 `--initial-prompt` 同时使用。

所有启动文件路径都会走和文件工具相同的 allowed roots 规则。工作区外文件会被拒绝，除非对应目录已配置在 `additionalDirectories` 中。文件不存在时会给出明确启动错误。启动上下文不是“读取整个 workspace”，不会隐式授权写入，并且会像其他 generated context 一样在首轮模型调用后从 live message list 中移除。

### 旧版 OpenAI-compatible 启动默认值
- `OPENAI_API_KEY`：您的 API 密钥。
- `OPENAI_BASE_URL`：API 接口地址。
- `OPENAI_MODEL`：使用的模型标识符。

保存到 `./.alyce/config.json` 或 `~/.alyce/config.json` 的连接配置会覆盖这些启动默认值。旧格式仍然有效：

```json
{
  "apiKey": "sk-...",
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-5.2"
}
```

也可以在同一配置文件的 `providers` 下声明 provider profile，并使用 `provider/model` 引用模型。裸 `/model gpt-5.2` 会沿用当前 provider。

```json
{
  "model": "openrouter/openai/gpt-5.2",
  "providers": {
    "openrouter": {
      "label": "OpenRouter",
      "kind": "openrouter",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "openai/gpt-5.2",
      "models": {
        "openai/gpt-5.2": { "contextWindow": 400000 },
        "anthropic/claude-sonnet-4.6": { "contextWindow": 1000000 }
      }
    },
    "local": {
      "label": "Local",
      "kind": "local",
      "baseURL": "http://127.0.0.1:11434/v1",
      "defaultModel": "qwen",
      "models": {
        "qwen": { "contextWindow": 256000 }
      }
    }
  }
}
```

在 Alyce 中运行 `/model` 或 `/models` 可以查看当前 provider/model、provider 可用性、已知模型和切换示例。目前所有已配置 provider 都通过 OpenAI-compatible adapter 发送请求；原生 Anthropic/Google adapter 还未加入，需配置兼容 `baseURL`。

模型可以在 `models` 里可选配置 `inputCostPerMillionTokens` 和 `outputCostPerMillionTokens`。`/usage` 只在两者都存在时估算成本；缺少价格元数据的模型只显示 tokens。

### 搜索与抓取（可选）
- `AGENT_ADDITIONAL_DIRECTORIES`：工作区外的额外允许目录，使用系统路径分隔符分隔；Windows 是 `;`，Linux/macOS 是 `:`。
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

`permissionRules` 通过 `./.alyce/settings.json` 或 `~/.alyce/settings.json` 配置，不走环境变量。这样持久授权规则可以在 JSON 里明确审查，而不是藏在 shell 启动环境里。

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

也不要提交 `.env`、`~/.alyce/` 或生成的 `dist/`。`.alyce` 里可能有连接配置、权限规则、会话记录、记忆、MCP 输出和本地任务产物。

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

### 权限规则

`permissionRules` 是会话设置中的可选数组，可以写在项目级或用户级 settings 里：

```json
{
  "approvalMode": "manual",
  "permissionRules": [
    {
      "permission": "shell",
      "pattern": "npm run build",
      "action": "allow",
      "scope": "persistent",
      "reason": "Known local validation command."
    },
    {
      "permission": "file.read",
      "pattern": "sensitive:*",
      "action": "ask",
      "reason": "Review secret-like files before reading."
    }
  ]
}
```

支持的 `permission`：

```text
*
shell
powershell
file.read
file.write
file.edit
file.patch
directory.external
web.fetch
web.search
mcp.tool
mcp.resource
skill.load
task.spawn
```

支持的 `action` 是 `allow`、`ask`、`deny`。`pattern` 不写时默认是 `*`。常见 pattern：

- `workspace:src/index.ts`：工作区内的相对文件路径。
- `workspace:*`：工作区内任意路径。
- `external:C:\Some\Path` 或外部绝对路径 pattern。
- `sensitive:*`：`.env`、`.alyce`、私钥、凭据文件等敏感路径。
- `npm run build` 这类精确 shell/PowerShell 命令文本。
- `https://docs.example.com/*` 或 `*` 这类 URL/MCP pattern。

规则优先级从低到高是：内置默认、项目设置、用户设置、本会话审批、Plan Mode 覆盖层。多个规则同时命中时，更严格的动作优先，`deny` 高于 `allow`，`allow` 高于 `ask`。某些请求会强制再次询问，例如敏感/生成目录文件和高风险命令，宽泛的会话允许规则不会跳过这些提示。

审批弹窗也会创建临时会话规则：

- **Allow once**：只允许当前请求。
- **Allow this kind for session**：本次运行期间允许同类普通请求。
- **Allow directory for session**：本次运行期间允许该外部目录。
- **Auto approve this session**：本次运行期间普通请求自动批准；高风险强制审批请求仍可能弹窗。

### Plan Mode

`/plan` 进入 Plan Mode，`/plan exit` 或 `/build` 退出。它是运行时模式，不会持久化到配置文件。

启用后，Alyce 会加一层高优先级权限覆盖：

- 工作区读取允许，用于探索。
- 外部目录读取/搜索仍需审批。
- 文件写入、编辑、patch、任意 MCP 工具、技能加载、子代理启动会被拒绝。
- Web 抓取/搜索和 MCP 资源列表/读取允许。
- Shell/PowerShell 必须经过审批，并且命令要被判定为只读检查。

Plan Mode 会尽量从模型可见工具列表里移除修改型工具，同时工具执行层也会再次拦截，所以不应执行的工具会返回 Plan Mode violation。

### Doctor 检查

`/doctor` 会在对话里输出本地诊断报告，检查内容包括：

- Node 版本（需要 `>=20.10.0`）。
- stdin/stdout 是否为交互式 TTY。
- 工作区是否可读。
- 项目文件：`package.json`、`src/index.ts`、`dist/index.js`。
- API key、base URL、model 配置。
- 运行时设置和审批风险。
- MCP 配置是否能解析。
- 项目/用户技能发现。
- `rg` 和 `git` 是否可用。
- `.alyce` 存储是否可写。
- snapshot 引擎状态、snapshot 目录、保留期、git-tree 可用性，以及最近的 snapshot/cleanup 错误。
- 是否存在 request patch 覆盖。

当启动成功但工具、配置或本地环境表现不对时，优先跑 `/doctor`。

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

### Diff/Rewind 快照

`./.alyce/settings.json` 或 `~/.alyce/settings.json` 里的 `snapshot` 控制 `/diff`、`/revert` 和代码 rewind 使用的文件快照基础：

```json
{
  "snapshot": {
    "enabled": true,
    "engine": "hybrid",
    "maxTextDiffBytes": 524288,
    "maxFileBytes": 2097152,
    "retentionDays": 7,
    "includeIgnoredExplicitPaths": true,
    "manifestScan": true
  }
}
```

- `engine: "hybrid"` 同时使用 turn 级 git-tree 快照和显式 ignored/external 路径的 file-history overlay。
- `engine: "git-tree"` 只使用工作区级 git-tree 快照。
- `engine: "file-backup"` 只使用显式 file-history overlay。
- `manifestScan` 控制是否采集目录 manifest，用于恢复只创建空目录的 turn。
- `retentionDays` 会在启动时清理 `.alyce/snapshots/git/` 和 `.alyce/file-history/` 中过期的快照目录；当前工作区的 git-tree 存储不会在启动清理中被删除。
- `/doctor` 会报告当前引擎、git 可用性、snapshot 存储路径、保留期，以及最近的 snapshot/cleanup 错误。

### Markdown 渲染规则

- `assistant` / `thinking` 消息在开启 `markdownMessageRenderingEnabled` 时可走 markdown 渲染。
- `tool` 消息需要同时开启 `markdownMessageRenderingEnabled` 与 `markdownToolMessageRenderingEnabled`。
- `shell` / `write` / `edit` / `patch` 结果始终保持 code/diff-first，不走 markdown。
- markdown 化主要用于文本型工具结果（如 list/glob/grep/webfetch/websearch/codesearch 风格输出）；折叠预览仍保持 section 模式。
- 如果 markdown 解析触发安全预算（大小/行数/嵌套深度）或解析异常，会自动回退到 plain/code section，保证 UI 稳定。

### TTY 下的 Markdown 限制

- Alyce 使用终端原生渲染，不是浏览器 DOM 渲染。
- 强调、链接、表格、引用和数学公式使用终端原生样式/span 呈现；fenced code block 仍按普通代码块显示，不做语言语法高亮。
- 行内 `$...$` 和块级 `$$...$$` 数学公式会渲染为可读的 Unicode/纯文本，不是 KaTeX HTML。
- 不支持 DOM 级 HTML 能力（如浏览器布局/CSS/脚本执行等）。
- 表格、引用、链接等语义会按终端可读性做近似呈现。
- 复制行为以终端实际渲染文本为准；带标签链接会追加 `<URL>`，避免复制后丢失目标地址。

---

如果您在配置过程中遇到问题，建议使用 `/context` 命令查看模型实际接收到的 Payload，这有助于排查配置是否生效。
