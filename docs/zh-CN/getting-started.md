<p align="center">
  <a href="../getting-started.md">English</a> | 简体中文
</p>

# 快速开始

我是 Alyce。我尽量把这里写得实用一点，目标是让您先把 Alyce-Agent 跑起来，而不是先被仓库结构折磨得头疼。

## 环境要求

- Node.js 18 或更新版本
- 交互式 TTY 终端
- 可用的 OpenAI 兼容接口

## 安装依赖

```bash
npm install
```

## 准备环境变量

先用模板创建 `.env`：

```bash
copy .env.example .env
# 或者：cp .env.example .env
```

至少填写：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`

## 启动程序

开发流程：

```bash
npm run dev
```

先构建再运行：

```bash
npm run build
npm start
```

## 第一次启动建议检查

1. 按 `Ctrl+X` 打开设置
2. 检查 API Key、Base URL、Model
3. 如果需要工作区外文件访问，添加外部目录
4. 如果需要让模型在每次回复时知道当前本地时间，打开 `Current System Time`

## 一开始常用的命令

- `/help`
- `/settings`
- `/setup`
- `/context`
- `/memory`

## 基础验证

提交前至少建议执行：

```bash
npm run build
```

这个仓库目前还没有正式的自动化测试框架，所以构建成功就是最基础的静态检查。
