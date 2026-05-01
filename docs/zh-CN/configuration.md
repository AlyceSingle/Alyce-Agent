<p align="center">
  <a href="../configuration.md">English</a> | 简体中文
</p>

# 配置说明

我是 Alyce。*配置系统这种事吧，表面看着简单，等你发现同一个设置可能从四个不同地方来、还搞不清谁说了算的时候，就开始头疼了。所以让我老老实实把它讲明白。*

Alyce 的配置是分层的。多个来源可以设同一个值，有一个明确的优先级来决定谁赢。知道了排序，就不难了。

## 设置从哪来

### 连接配置（API key、base URL、model）

按这个优先级加载——**排前面的赢后面的**：

1. **CLI 参数**（启动程序时传的）
2. **环境变量**（`.env` 文件中）
3. **项目级配置** — `./.alyce/config.json`
4. **用户级配置** — `~/.alyce/config.json`

*实际使用中环境变量通常是赢家，因为 `.env` 最先被加载，而且大多数人也不会传 CLI 参数。但如果你在设置弹窗里改了并保存到项目级，下次启动就会生效。*

### 会话设置（角色、记忆、审批等）

同样——**排前面的赢**：

1. **CLI 参数**
2. **环境变量**
3. **项目级设置** — `./.alyce/settings.json`
4. **用户级设置** — `~/.alyce/settings.json`

## 文件对应表

| 什么 | 在哪 |
|---|---|
| 项目连接配置 | `./.alyce/config.json` |
| 用户连接配置 | `~/.alyce/config.json` |
| 项目会话设置 | `./.alyce/settings.json` |
| 用户会话设置 | `~/.alyce/settings.json` |

*`./` 开头的是按项目来的——跟着仓库走（如果你交了 `.alyce/` 的话，但最好别）。`~/` 开头的是这台机器全局的。项目特有的事放项目级，个人习惯放用户级。*

## 环境变量

### 必填（缺了程序起不来）
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

### 可选（大多是内存调参）
- `AGENT_ADDITIONAL_DIRECTORIES` — 逗号分隔的额外路径
- `AGENT_MEMORY_DIR` — 覆盖记忆存储目录
- `AGENT_MEMORY_FILE` — 覆盖记忆文件名
- `AGENT_MEMORY_MAX_SESSION` — 会话记忆最大条数
- `AGENT_MEMORY_MAX_PERSISTENT` — 持久记忆最大条数
- `AGENT_MEMORY_MAX_PROMPT` — 注入 prompt 的记忆最大字符数
- `AGENT_MEMORY_AUTO_SUMMARY` — 开关自动摘要
- `AGENT_MEMORY_SUMMARY_MIN_MESSAGES` — 多少条消息后开始摘要
- `AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES` — 摘要更新间隔
- `AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES` — 每次摘要覆盖多少条
- `AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE` — 每条消息截断长度

*绝大多数人不会碰可选变量。它们是为了那些对记忆行为有强烈个人偏好、或者跑在非常规环境里的人准备的。*

## 连接字段

在设置的**连接**标签页里出现：

- `apiKey` — 兼容 OpenAI 的 API 密钥
- `baseURL` — 端点地址
- `model` — 模型标识字符串

可以保存为**用户级**（你这台机器全局）或**项目级**（跟这个项目走）。在连接标签页按 `P` 切换保存范围。

*API key 我建议存用户级——这样它完全不会出现在项目目录里。*

## 会话设置字段

在设置的**会话**标签页里出现。

### 执行与审批

- `approvalMode` — 工具审批严格程度。从"每次都问"到"智能默认"可调。
- `maxSteps` — 每轮最多调多少次工具，之后必须给出最终回复。
- `commandTimeoutMs` — shell 命令超时毫秒数。

### Prompt 与角色

- `languagePreference` — 助手用什么语言回复。
- `personaPreset` — 用哪个内置角色。可选：`None`、`alyce`、`lilith`、`corin`。*详见[角色预设](persona-presets.md)页。*
- `aiPersonalityPrompt` — 自定义角色指令，叠在（或替代）角色预设上面。
- `appendSystemPrompt` — 直接追加到 system prompt 末尾的文字。省着用。

### 记忆与上下文

- `autoSummaryEnabled` — 是否启用近期工作自动摘要。
- `messageTimestampsEnabled` — 模型是否在每轮看到当前系统时间。
- `conversationCompactionEnabled` — 长对话是否压缩以保持在上下文限制内。

### 路径

- `additionalDirectories` — 工作区之外，助手还能访问的额外目录。

## 两个值得理解的设置

### `messageTimestampsEnabled`

打开后，每次 API 请求会附加一个 `# Current System Time` 小段落，带着本地日期时间。这是请求时才注入的——不会出现在你可见的 transcript 里，也不会混进聊天历史。*我觉得挺实用的，因为模型就能说"截至今天早上"之类的话，而不是每次都对时间含糊其辞。*

### `conversationCompactionEnabled`

打开后，长对话超过阈值就会被压缩。最近几轮原始消息不动；更早的内容改写为结构化摘要。目标不是删东西——是把有用信息保留下来，同时不拖着整份 transcript 一直往前堆。*没这个的话，跑几个小时的会话最终会溢出上下文窗口，模型就会"忘记"对话开头发生了什么。*

---

*这就是配置层的全部了。如果某个设置表现得不对劲，用 `/context` 看看模型实际收到了什么——通常是排查配置问题最快的办法。*
