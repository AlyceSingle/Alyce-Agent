<p align="center">
  <a href="../memory-and-context.md">English</a> | 简体中文
</p>

# 记忆与上下文

我是 Alyce。这个文件主要说明两件事：当前运行时怎么“记住事情”，以及它怎样尽量避免把对话越堆越长，最后把模型压得喘不过气。

## 上下文分层

当前活跃上下文不是一整块混在一起的内容，而是由多层组合出来的：

1. 主 system prompt
2. 启动指令文档
3. 实时会话消息
4. session memory
5. persistent memory
6. auto summary
7. conversation compaction summary

## 启动指令文档

来源：

- `startupInstructionFiles`

行为：

- 会话启动时自动加载
- 设置变更后重新加载
- `/clear` 之后重新加载
- 作为独立 prompt section 注入
- 不写入普通 memory 存储

这层最适合承载稳定、长期、应始终存在的说明。

## Session Memory

来源：

- `/remember --session <text>`
- `/remember <text>`

行为：

- 只存在于当前会话
- 会进入 memory prompt section
- 被 `/clear` 或 `/memory clear` 清掉

## Persistent Memory

来源：

- `/remember <text>`

存储位置：

- 默认是 `./.alyce/memory/MEMORY.md`，除非运行时配置改写

行为：

- 跨会话保留
- 同样会注入到 memory prompt section

## Auto Summary

行为：

- 会话长度达到阈值后开始工作
- 不会每一轮都更新
- 把近期工作压缩成可复用摘要

它可以缓解上下文增长，但并不能替代 conversation compaction。

## Conversation Compaction

这一层负责防止完整消息历史无限增长。

压缩之后：

- 主 system message 保留
- 插入一条结构化 compaction summary
- 最近几轮原始消息继续保留
- 更早的消息被折叠成摘要

目标不是逐字保留所有内容，而是在不拖着整份 transcript 一直前行的前提下，把真正有用的信息留下来。

## 时间戳注入

如果打开 `messageTimestampsEnabled`：

- 用户消息会带提交时间
- 助手消息会带生成时间
- 当前回复还会额外拿到当前本地系统时间

这些信息是在 API 请求阶段注入的，所以终端里可见的 transcript 仍然保持整洁。

## 如何检查真实请求

如果您需要确认某段信息到底有没有真的进模型，可以使用：

```text
/context
```

它会展示经过运行时整形之后的下一轮 payload。

## 实际使用建议

### 启动指令文档适合放：

- 人设
- 项目规则
- 稳定的工作流要求
- 长期背景说明

### `/remember` 适合放：

- 可复用事实
- 用户偏好
- 需要跨会话保留的项目知识

### 原始会话历史适合承载：

- 附近的工具结果
- 短期讨论上下文
- 最近的工作状态

如果非要把它总结得更短一点，那就是：Alyce 会尽量把长期指令和临时对话分开，把摘要和 transcript 分开，这样上下文才不会同时变成一团让人紧张的东西。
