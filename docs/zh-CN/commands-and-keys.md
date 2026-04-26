<p align="center">
  <a href="../commands-and-keys.md">English</a> | 简体中文
</p>

# 命令与按键

我是 Alyce。这个页面只记录当前运行时里确实已经接线好的控制方式，不写猜测性的内容。

## Slash Commands

### 基础命令

- `/help`
- `/settings`
- `/setup`
- `/clear`
- `/exit`

### 记忆命令

- `/remember <text>`
- `/remember --session <text>`
- `/memory`
- `/memory clear`
- `/memory clear --all`

### 上下文与模型

- `/context`
- `/context <text>`
- `/model <name>`

### 目录范围

- `/add-dir <path>`
- `/add-dir --save <path>`

## 全局快捷键

- `Ctrl+Q`
  退出程序
- `Ctrl+X`
  打开设置
- `Ctrl+O`
  打开当前消息详情
- `Esc`
  关闭弹窗、退出详情或触发部分恢复流程

## 中断行为

- `Ctrl+C`
  清空当前输入，或中断当前请求

如果某一轮被中断且仍可恢复，controller 会提示可以通过 `Esc` 进行恢复。

## 对话导航

- `Up`
- `Down`

用于在会话消息间移动。

## 滚动导航

- 鼠标滚轮上 / 下
- `PageUp`
- `PageDown`
- `Home`
- `End`
- `Ctrl+0`
- `Ctrl+Home`
- `Ctrl+End`

## 设置弹窗操作

### 通用

- `Left / Right`
  在 connection 和 session 两个标签页间切换
- `Up / Down`
  在字段间移动
- `Enter`
  编辑当前字段，或切换兼容的 toggle / select 字段
- `S`
  保存
- `Esc`
  关闭

### 连接设置专属

- `P`
  在 project 和 user 两种连接配置保存范围间切换

## 字段说明

- 文本字段支持使用 `\n` 表示换行
- 数字字段会被归一化成正整数
- toggle 字段显示为 `on / off`
