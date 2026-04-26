<p align="center">
  <a href="../configuration.md">English</a> | 简体中文
</p>

# 配置说明

我是 Alyce。配置系统本来就是分层设计的。我还是更愿意把它写清楚一点，而不是让您靠猜来判断到底哪个文件优先。

## 配置来源

### 连接配置

会从这些来源读取：

- 环境变量
- `~/.alyce/config.json`
- `./.alyce/config.json`
- CLI 参数

### 会话设置

会从这些来源读取：

- `./.alyce/settings.json`
- `~/.alyce/settings.json`
- 环境变量
- CLI 参数

## 文件位置

- 项目级连接配置：`./.alyce/config.json`
- 用户级连接配置：`~/.alyce/config.json`
- 项目级会话设置：`./.alyce/settings.json`
- 用户级会话设置：`~/.alyce/settings.json`

## 环境变量

### 必填

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

### 可选

- `AGENT_ADDITIONAL_DIRECTORIES`
- `AGENT_MEMORY_DIR`
- `AGENT_MEMORY_FILE`
- `AGENT_MEMORY_MAX_SESSION`
- `AGENT_MEMORY_MAX_PERSISTENT`
- `AGENT_MEMORY_MAX_PROMPT`
- `AGENT_MEMORY_AUTO_SUMMARY`
- `AGENT_MEMORY_SUMMARY_MIN_MESSAGES`
- `AGENT_MEMORY_SUMMARY_INTERVAL_MESSAGES`
- `AGENT_MEMORY_SUMMARY_WINDOW_MESSAGES`
- `AGENT_MEMORY_SUMMARY_MAX_CHARS_PER_MESSAGE`

## 连接字段

- `apiKey`
- `baseURL`
- `model`

连接配置可以保存到：

- 用户级
- 项目级

在设置界面中，可以用 `P` 切换保存目标。

## 会话设置字段

### 执行与审批

- `approvalMode`
- `maxSteps`
- `commandTimeoutMs`

### Prompt 与人格

- `languagePreference`
- `personaPreset`
- `aiPersonalityPrompt`
- `appendSystemPrompt`

### 记忆与上下文

- `autoSummaryEnabled`
- `messageTimestampsEnabled`
- `conversationCompactionEnabled`

### 路径

- `additionalDirectories`

## `messageTimestampsEnabled`

打开后：

- 请求里会额外注入一个独立的 `# Current System Time` system block
- 这个 block 只包含当前这次回复对应的本地系统日期和时间

这些信息是在 API 请求阶段临时注入的，不会直接显示在可见 transcript 里，也不会混进历史对话正文。

## `conversationCompactionEnabled`

打开后：

- 长对话会在达到阈值后触发压缩
- 最近几轮原始消息会继续保留
- 更早的内容会被改写成结构化摘要消息

这个选项主要是为了限制上下文增长。
