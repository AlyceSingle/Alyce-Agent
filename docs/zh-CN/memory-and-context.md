<p align="center">
  <a href="../memory-and-context.md">English</a> | 简体中文
</p>

# 记忆与上下文

我是 Alyce。本页将为您介绍 Alyce 如何管理对话上下文，以及不同层级的记忆系统是如何工作的。

## 上下文结构

模型在每一轮对话中接收到的上下文由以下几部分按顺序堆叠而成：

1. **系统提示词 (System Prompt)**：核心指令，包括身份定义、安全规则和可用工具。
2. **实时会话消息**：当前对话中实际产生的往返消息。
3. **恢复的会话历史**：使用 `/resume` 恢复的旧对话内容。
4. **会话笔记**：通过 `/remember --session` 记录的临时信息。
5. **持久记忆**：通过 `/remember` 记录的长期信息。
6. **会话记忆文件**：自动管理的当前会话状态 markdown 文件。
7. **压缩摘要**：当对话过长时，对旧消息的结构化压缩。

## 记忆层级

### 1. 会话历史 (Session History)
记录“我们上次聊到哪了”。
- **存储路径**：`./.alyce/sessions/<会话ID>.jsonl`
- **功能**：完整还原消息链和终端显示内容，支持接续旧对话。

### 2. 会话笔记 (Session Notes)
仅在当前运行期间有效的临时笔记。
- **记录方式**：`/remember --session <内容>`
- **特点**：程序重启或使用 `/clear` 后会清空。适用于存放仅对当前任务有用的临时背景。

### 3. 持久记忆 (Persistent Memory)
跨会话保留的长期知识。
- **记录方式**：`/remember <内容>`
- **存储路径**：`./.alyce/memory/MEMORY.md`
- **特点**：除非手动清空，否则一直保留。适用于存放用户偏好、项目规范等长期事实。

## 上下文优化机制

### 会话记忆文件 (Session Memory File)
会话记忆文件默认位于 `./.alyce/memory/SESSION_MEMORY.md`，可通过 `AGENT_SESSION_MEMORY_FILE` 配置。它会作为当前会话的结构化状态摘要注入 Prompt，和 `/remember --session` 的临时笔记、`/remember` 的持久记忆分开管理。自动提取采用阈值触发方式：首次达到 `AGENT_SESSION_MEMORY_INIT_TOKENS` 后初始化，之后必须满足 `AGENT_SESSION_MEMORY_UPDATE_TOKENS` 的上下文增长，并且达到工具调用阈值或处于无工具调用的自然断点。更新任务在后台运行，不修改主对话记录，不递归触发 compact，并且只有确认对话没有 rewind/clear/resume 后才写回受管理的会话记忆文件。

### 对话压缩 (Conversation Compaction)
这是防止上下文溢出的最后防线。当消息总长度接近模型上限时，系统会将较早的消息折叠为结构化摘要，仅保留最近几轮的原始对话。

### 上下文窗口识别
状态栏里的 Context 百分比来自“下一轮请求的估算 token 数 / 当前模型上下文窗口”。Alyce 按以下顺序解析窗口大小：

1. `modelContextWindowOverrides` 设置里的手动覆盖项。
2. 模型名中的显式后缀，例如 `128k` 或 `1m`。
3. 内置宽松模型表，覆盖 OpenAI、Gemini、Kimi、DeepSeek、Qwen、Mistral、xAI、Llama、Cohere、GLM、MiniMax 等常见模型族。
4. 未知模型回退到保守的 `128000` tokens。

匹配时会忽略大多数分隔符，所以 `gemini-2.5-pro`、`gemini 2.5 pro`、`google/gemini_2_5_pro` 会命中同一条规则。`/context` 会显示该窗口来自 override、模型名、内置表还是 fallback。

### 时间戳注入
开启 `messageTimestampsEnabled` 后，每次请求都会包含当前的系统时间，帮助模型建立准确的时间感。

## 调试工具

如果您想了解模型当前到底“记得”什么，可以使用以下命令：

- `/context`：预览下一轮请求的精确 Payload。
- `/memory`：查看当前已加载的所有记忆条目。

---

通过这些机制，Alyce 尝试在“记住足够多信息”和“保持上下文精简”之间取得平衡。
