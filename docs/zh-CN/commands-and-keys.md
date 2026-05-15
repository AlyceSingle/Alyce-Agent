<p align="center">
  <a href="../commands-and-keys.md">English</a> | 简体中文
</p>

# 命令与按键

我是 Alyce。本页列出了 Alyce 当前支持的所有 Slash 命令和全局快捷键。

## Slash 命令

在主输入框中输入，以 `/` 开头，按回车键执行。

### 基础命令

| 命令 | 说明 |
|---|---|
| `/help` | 列出所有可用命令。 |
| `/doctor` | 运行本地健康检查，包括 Node、TTY、工作区、连接配置、审批风险、MCP、技能、`rg`、`git`、`.alyce` 存储和请求 patch。 |
| `/settings` | 打开设置面板。 |
| `/setup` | 启动首次配置引导。 |
| `/clear` | 清空当前对话上下文。 |
| `/rewind` | 打开回退选择器，恢复到之前的输入状态。 |
| `/exit` | 退出 Alyce。 |

### Plan Mode

| 命令 | 说明 |
|---|---|
| `/plan` | 进入只读计划模式。Alyce 可以阅读、搜索、提问和写计划，但写文件、修改型命令、子代理、任意 MCP 工具和技能加载会被拦截。 |
| `/plan exit` | 退出 Plan Mode，恢复普通实现/编辑权限。 |
| `/build` | `/plan exit` 的别名。当前运行时里它只负责退出 Plan Mode，不会执行 `npm run build`。 |

Plan Mode 仍允许只读探索：`Read`、`Glob`、`Grep`、`LSP`、网页抓取/搜索、MCP 状态/资源列表/资源读取、`TaskList`、`TaskGet`，以及经过审批的只读 shell 或 PowerShell 检查命令。疑似会写文件、安装依赖、修改 git 状态或执行任意代码的命令会被阻止。

### Diff

| 命令 | 说明 |
|---|---|
| `/diff` | 显示组合概览：最近 Alyce turn 的摘要，以及当前 git working tree 摘要。 |
| `/diff last` | 显示最近 Alyce turn 的完整 diff，基于 Alyce 文件历史快照，不依赖 git。 |
| `/diff current` | 显示当前 git working tree diff；如果 git 不可用，会给出明确提示。 |
| `/diff <turn>` | 按 turn ID 显示指定 Alyce turn 的 diff。 |

当某一轮修改了文件后，Alyce 还会输出简短 diff summary，包括文件数量、added/modified/deleted 统计、每个文件的行数变化，并提示用 `/diff last` 查看完整 patch。

### Revert

| 命令 | 说明 |
|---|---|
| `/revert` | 对最近一个带文件改动的 Alyce turn 打开确认提示，可选择只恢复文件、恢复文件并回退对话、只回退对话或取消。 |
| `/revert --files-only` | 恢复最近 Alyce turn 的已跟踪文件改动，不改变当前对话。 |
| `/revert --conversation-only` | 将对话回退到最近 Alyce turn 对应的 rewind 点，不改变磁盘文件。 |

Revert 的边界会明确显示：文件恢复只覆盖 Alyce 在写工具执行前捕获到的文件；对话回退只修改 Alyce 的运行时/会话对话状态。Shell 副作用、包安装、外部服务变化，以及不在文件历史范围内的生成文件不会被自动恢复。

### 记忆管理

| 命令 | 说明 |
|---|---|
| `/remember <内容>` | 存入持久记忆（跨会话保留）。 |
| `/remember --session <内容>` | 存入会话记忆（仅在当前会话有效）。 |
| `/memory` | 查看当前已记录的记忆内容。 |
| `/memory clear` | 清空当前会话记忆。 |
| `/memory clear --all` | 清空所有记忆（包括持久记忆）。 |

### 上下文与模型

| 命令 | 说明 |
|---|---|
| `/context` | 预览模型在下一轮对话中实际接收到的完整 Payload。 |
| `/context <内容>` | 预览 Payload，并临时追加一段自定义上下文。 |
| `/model` 或 `/models` | 查看当前 provider/model、已配置 provider、已知模型和切换示例。 |
| `/model <名称>` | 在当前 provider 下切换模型（例如 `/model gpt-5.2`）。 |
| `/model <provider>/<model>` | 切换到带 provider 的模型引用（例如 `/model openrouter/openai/gpt-5.2`）。 |

### Usage

| 命令 | 说明 |
|---|---|
| `/usage` | 查看当前 session 的模型用量：总 token、provider/model 分组、最近 turn、子代理用量、耗时、重试次数，以及在 provider/model 有价格元数据时的估算成本。 |

当价格未知时，Alyce 只显示 tokens，不会虚构成本。

### 目录授权

| 命令 | 说明 |
|---|---|
| `/add-dir <路径>` | 临时将指定目录加入文件访问白名单。 |
| `/add-dir --save <路径>` | 将指定目录永久加入白名单（跨会话保留）。 |

### 会话历史

| 命令 | 说明 |
|---|---|
| `/resume` | 打开历史会话选择器。 |
| `/resume <ID/关键词>` | 按 ID 或关键词恢复指定会话。 |
| `/sessions` | 列出最近保存的会话记录。 |

### 子代理存储

Alyce 面向模型的 `AgentTool` 内置 `general`、`explore`、`review` 和 `verify` 子代理。`verify` 是只读验证子代理，可以在审批后运行 build/test/lint/typecheck 命令，并在最后给出 `pass`、`fail` 或 `inconclusive` verdict。它不是顶层 `/verify` 模式。

| 命令 | 说明 |
|---|---|
| `/tasks` | 列出当前会话的后台子代理任务，包含状态、agent type 和简短描述。 |
| `/tasks get <id>` | 查看受限长度的任务详情：状态、路径、最近进度、结果预览、错误和 diff metadata。 |
| `/tasks log <id>` | `/tasks get <id>` 的别名。 |
| `/tasks stop <id>` | 请求停止正在运行的后台任务。 |
| `/tasks cleanup` | 扫描陈旧的子代理存储产物，不删除文件。 |
| `/tasks cleanup --apply` | 删除 cleanup 扫描到的陈旧子代理存储产物。使用前建议先看普通扫描输出。 |

StatusBar 也会显示紧凑的后台任务计数：running、未读取的 completed 任务和 failed 任务。后台任务完成后会在主会话里显示简短摘要；用 `/tasks get <id>` 查看详情。

## 全局快捷键

这些快捷键在程序的任何界面下均有效。

| 按键 | 功能 |
|---|---|
| `Ctrl+Q` | 立即退出程序。 |
| `Ctrl+X` | 打开/关闭设置面板。 |
| `Esc` | 中断当前运行的任务；在输入框为空时打开回退选择器。 |

## 交互操作

### 中断与回退

- **`Ctrl+C`**：清空当前输入内容；如果模型正在生成回复，则中断请求。
- **回退功能**：任务中断后，在空输入状态按 `Esc` 可选择回退点。如果开启了文件历史记录，还可以选择同步回滚受影响的文件。若快照已经恢复、被裁剪，或混有不可自动恢复的副作用，回退选择器会降级为仅回退对话。

### 视图导航

- **`Up` / `Down`**：在消息列表中上下移动焦点。
- **鼠标滚轮**：滚动查看对话历史。
- **`PageUp` / `PageDown`**：翻页滚动。
- **`Home` / `End`**：跳转至当前视图的顶部或底部。
- **`Ctrl+Home` / `Ctrl+End`**：跳转至整个对话的最开始或最末尾。

## 设置面板操作

按 `Ctrl+X` 进入设置界面后的操作方式：

- **`Left` / `Right`**：在“连接”和“会话”标签页间切换。
- **`Up` / `Down`**：在各配置项间移动。
- **`Enter`**：编辑字段、切换开关或循环选择选项。
- **`S`**：保存并应用所有更改。
- **`Esc`**：放弃更改并退出设置。
- **`P`**（仅限连接页）：切换保存范围（项目级 `./.alyce/` 或用户级 `~/.alyce/`）。

---

以上是当前版本支持的所有交互方式。
