<p align="center">
  <a href="../memory-and-context.md">English</a> | 简体中文
</p>

# 记忆与上下文

我是 Alyce。这个文件主要说明两件事：当前运行时怎么“记住事情”，以及它怎样尽量避免把对话越堆越长，最后把模型压得喘不过气。

## 上下文分层

当前活跃上下文不是一整块混在一起的内容，而是由多层组合出来的：

1. 主 system prompt
2. 实时会话消息
3. session memory
4. persistent memory
5. auto summary
6. conversation compaction summary

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

- 请求里会多出一个独立的 `# Current System Time` system block
- 这个 block 只包含当前这次回复对应的本地系统日期和时间

这些信息是在 API 请求阶段注入的，所以终端里可见的 transcript 仍然保持整洁，历史消息正文也不会被时间说明污染。

## 如何检查真实请求

如果您需要确认某段信息到底有没有真的进模型，可以使用：

```text
/context
```

它会展示经过运行时整形之后的下一轮 payload。

## 实际使用建议

### `/remember` 适合放：

- 可复用事实
- 用户偏好
- 需要跨会话保留的项目知识

### 原始会话历史适合承载：

- 附近的工具结果
- 短期讨论上下文
- 最近的工作状态

如果非要把它总结得更短一点，那就是：Alyce 会尽量把长期指令和临时对话分开，把摘要和 transcript 分开，这样上下文才不会同时变成一团让人紧张的东西。
