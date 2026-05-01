<p align="center">
  <a href="../project-structure.md">English</a> | 简体中文
</p>

# 项目结构

我是 Alyce。*说实话，我自己在这堆代码里迷路的次数比愿意承认的多。所以我才写了这个——为了让你少走弯路。*

这一页只回答一个问题：**代码在哪、每层管什么、想改东西应该从哪开始。** 没有架构宣言、没有你看完就不会再看第二遍的 UML 图——就是一张我自己也希望能早点有的地图。

## 顶层一览

```text
.
├─ src/            ← 你会花大部分时间的地方
├─ docs/           ← 你正在读的这些
├─ dist/           ← TypeScript 编译输出（别碰）
├─ .alyce/         ← 运行时状态：配置、记忆、会话历史
├─ User_Info/      ← 用户自己的资料，不属于仓库
└─ README.md       ← 大门
```

*`.alyce/` 目录是程序运行时自动生成的。它不是源码——把它当数据库看，别手动编辑它。*

## `src/` 里各层拆解

### 入口与启动

```
src/index.ts
src/cli/startReactUiMode.ts
```

这俩文件就是上车道。它们做几件事：
- 从 `.env` 加载环境变量
- 验证你是不是真的在交互式 TTY 里
- 创建 runtime、UI 状态 store、会话 controller
- 把控制权交给 React UI

*如果程序完全起不来，先看这里。错误信息通常挺诚实的。*

### CLI 与会话装配

```
src/cli/sessionRuntime.ts
src/cli/commandRouter.ts
src/cli/contextPreview.ts
```

这一层把模型交互和用户界面粘在一起。它负责：
- 维护运行中的消息链（模型看过的和说过的东西）
- 把配置、记忆、压缩规则合并起来
- 解析 slash 命令——`/help`、`/remember`、`/resume`
- 当你用 `/context` 时生成请求预览

*`sessionRuntime.ts` 可能是这一层最重要的文件。它决定了模型到底会收到什么，这个决定会影响后面的一切。*

### 核心运行时

这才是真正干活的地方。每个子目录的职责单一、边界清晰。

#### `src/core/agent/`

```
runAgentTurn.ts
```

主循环：**调模型 → 解析工具调用 → 执行工具 → 把结果喂回去 → 重复 → 出最终回复**。你在终端里看到的每一"轮"，都经过这个文件。

#### `src/core/api/`

```
sendChatCompletion.ts
requestPatch.ts
```

管的是发给模型 API 的实际 HTTP 请求。整形消息 payload、注入时间戳（如果开启了的话）、应用可选 patch。*当你发现模型收到的东西跟你预期不一样时，来这儿查。*

#### `src/core/memory/`

```
memoryService.ts
autoSummary.ts
sessionMemoryStore.ts
persistentMemoryStore.ts
```

记忆相关的一切。收集 `/remember` 条目、跨会话持久化、生成近期工作自动摘要、决定往 prompt 里注入什么。*这一层我特别喜欢——它就是一个"重启后还记得"和"重启后全忘了"之间的区别。*

#### `src/core/conversation/`

```
conversationCompactor.ts
```

上下文膨胀的守门人。长对话达到阈值后，把旧轮次压缩成结构化摘要、保留最近几轮原始消息。*没它的话，长会话早晚溢出模型的上下文窗口。*

#### `src/core/session-history/`

```
sessionStorage.ts
sessionResume.ts
types.ts
```

管理 `./.alyce/sessions/` 下面的项目级 JSONL 记录。你用 `/resume` 时，这一层负责把旧对话重新加载回来——消息链和终端可见 transcript 都会恢复。

*会话历史不等于记忆。历史是重开旧对话；记忆是把事实注入到任何对话里去。*

#### `src/core/prompt/`

```
builder.ts
sections.ts
sectionResolver.ts
fragments/
```

把 system prompt 从各块拼出来——静态规则、动态环境信息、角色预设覆盖、记忆、用户自定义。如果你想改模型"对自己的认知"，这是你该待的地方。

*fragments 目录放着静态构建块。你听说过的角色预设？就在 `fragments/personaPresets.ts` 里。*

#### `src/core/file-history/`

```
fileHistoryManager.ts
```

每次写入文件前拍快照，支持 turn 级回滚。*这个功能是我经历过太多次"糟了不该覆盖那个文件"之后加的。救过我太多次了。*

#### `src/core/time/`

```
systemTime.ts
```

一个简单工具，格式化当前系统日期时间。`messageTimestampsEnabled` 开启时用它。*就是个小东西，但集中放一个地方，不会出现日期格式不一致的破事。*

### 工具层

```
src/tools/definitions.ts
src/tools/registry.ts
src/tools/executeToolCall.ts
```

助手能"做"的一切——读文件、搜代码、编辑、写入、跑命令、浏览网页、问你问题。每个工具是一个类，有自己的定义、执行逻辑和审批行为。

**内置工具清单：**
`AskUserQuestion` · `Read` · `Glob` · `Grep` · `TodoWrite` · `Edit` · `Write` · `Bash` · `PowerShell` · `WebFetch` · `WebSearch`

*想加新工具？定义它、注册它、然后给新增的审批规则接上线。模式是一致的——照抄一个现有工具就能看清骨架。*

### 终端 UI

Alyce 面向世界的脸。React + Ink，跑在真终端里。

#### `src/terminal-ui/adapters/`

```
sessionController.ts
messageMapper.ts
```

运行时事件和 UI 状态之间的桥梁。模型输出东西时，这些文件负责把它翻译成 UI 能渲染的样子。你敲命令时，再翻译回运行时操作。

#### `src/terminal-ui/components/`

输入框、弹窗、状态栏、消息查看器、设置面板——所有视觉零件。*哪个按钮不灵了、哪个弹窗显示歪了，组件基本都在这里。*

#### `src/terminal-ui/screens/`

```
AgentScreen.tsx
```

主会话界面。把所有东西拼在一起的顶层组件。

#### `src/terminal-ui/state/`

```
types.ts
actions.ts
store.tsx
```

UI 状态管理——什么被选中了、什么打开了、什么在加载。

#### `src/terminal-ui/keybindings/`

快捷键定义。`Ctrl+X`、`Ctrl+Q`，全在这儿。

#### `src/terminal-ui/runtime/ink-runtime/`

这是 vendored 的 Ink 渲染运行时。*除非你在修渲染 bug、滚屏问题或输入协议，否则大概率不需要碰它。放在这是因为我们不能让终端渲染依赖不可控的外部包。*

## 速查表：改什么看哪里

| 你想... | 从这里入手 |
|---|---|
| 改模型看到的东西 | `src/core/prompt/` → `sessionRuntime.ts` → `sendChatCompletion.ts` |
| 改用户看到的东西 | `adapters/sessionController.ts` → `components/` → `AgentScreen.tsx` |
| 新增或修改工具 | `tools/definitions.ts` → 工具自己的目录 → `tools/types.ts` |
| 处理记忆或上下文 | `core/memory/` → `conversationCompactor.ts` → `session-history/` → `sessionRuntime.ts` |
| 修启动崩溃 | `src/index.ts` → `startReactUiMode.ts` |
| 调整系统提示词 | `core/prompt/fragments/` → `builder.ts` |

---

*这就是整张地图了。盼它能让你比我当年少迷点路。*
