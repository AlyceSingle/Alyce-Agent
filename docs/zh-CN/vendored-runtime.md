<p align="center">
  <a href="../vendored-runtime.md">English</a> | 简体中文
</p>

# 内置终端渲染运行时（Vendored Runtime）

Alyce 并不通过 npm 上的 `ink` 包渲染界面。`src/terminal-ui/runtime/` 下的全部代码都是由本项目自己维护的内置源码：一个源自 Ink 的 React 渲染器，加上一份 Meta Yoga 弹性布局引擎的纯 TypeScript 移植，合计约 22600 行。

本文记录内置了什么、偏离上游到什么程度、以及从上游取用改动前需要确认的事项。修改 `runtime/` 下的文件之前请先读这篇——平时"去看看上游是怎么修的"这个习惯在这里不成立，因为上游的修复不会自动流入。

## 为什么要内置

渲染器位于每一次按键、每一个流式 token 的热路径上。内置这份代码是为了掌控上游 Ink 不暴露的三件事：

- **滚动性能**——用常驻屏幕缓冲区加帧差分和补丁优化器，取代每帧重绘全部输出。
- **选区与鼠标**——文本选区、命中测试、鼠标与终端焦点事件直接做进渲染器，而不是外挂。
- **Windows 终端行为**——按键解析、光标控制、ANSI 输出都针对 Alyce 面向的终端做了调整。

## 基准版本

**内置代码时没有记录上游的具体 commit，也无法从代码树反推出来。** 如果以后做过一次同步，请把版本记到本节。目前可以确证的事实：

| 事项 | 结果 |
|---|---|
| 内置时间 | 2026-04-13 → 2026-04-15 的若干 "UI framework" 提交 |
| `package.json` 里的 `ink` | `^5.1.0`，锁定在 5.2.1 |
| `ink` 是否真被引用 | **否**——`dist/app.js` 中零引用；`src/` 里唯一命中是 `hooks/use-input.ts` 的一段 JSDoc 示例 |
| `yoga-layout` | 仅作为 Ink 的传递依赖存在；渲染器实际使用 TS 移植版 |
| Yoga 移植上游 | https://github.com/facebook/yoga（版本未记录） |

内置渲染器保留了 Ink 的模块划分——`dom`、`output`、`styles`、`reconciler`、`render-node-to-output`、`squash-text-nodes`、`log-update`、`measure-text`、`colorize`、`render-border`、`get-max-width`、`instances`、`devtools` 在上游都存在且职责相同——但它不是任何一个已发布版本的副本。它包含 ink 5.2.1 没有的能力（ScrollBox、选区、鼠标与终端焦点事件），说明其来源比 `package.json` 里锁定的版本更新。

> 因此 `package.json` 里声明的 `ink` 依赖实际上是多余的。移除它属于会影响发版的打包改动，所以这里选择保留并在此说明，而不是悄悄删掉。

## 目录结构

```
src/terminal-ui/runtime/
├─ ink.ts                    ← 对外门面：Box、Text、render、各 hooks、ScrollBox
├─ input.ts、instances.ts、CursorDeclarationContext.ts、useDeclaredCursor.ts
├─ bootstrap/                ← 与应用共享的交互时间状态
├─ ink-runtime/              ← 源自 Ink 的渲染器
│  ├─ components/  (12 个文件，约 1590 行)  Box、Text、App、ScrollBox、AlternateScreen、各 context
│  ├─ events/      (11 个文件，约  860 行)  键盘、鼠标、点击、焦点、终端焦点事件分发
│  ├─ hooks/       ( 9 个文件，约  490 行)  useInput、useSelection、useTerminalSize、useStdin/out 等
│  ├─ layout/      ( 4 个文件，约  560 行)  yoga 绑定、几何计算、节点、布局引擎
│  ├─ termio/      ( 9 个文件)              ANSI/CSI/OSC/SGR/DEC 的分词与输出
│  └─ *.ts                                  screen、frame、renderer、optimizer、各类缓存、parse-keypress
└─ native-ts/yoga-layout/    (2 个文件，约 2710 行)  纯 TS 弹性布局引擎
```

应用代码一律从 `runtime/ink.ts` 门面导入，不直接引用 `ink-runtime/`。请保持这个约定：这道门面是让内部重构代价可控的关键接缝。

## 相对上游 Ink 的差异

### 新增子系统（上游没有对应物）

| 领域 | 文件 | 作用 |
|---|---|---|
| 屏幕缓冲 + 帧差分 | `screen.ts`、`frame.ts`、`render-to-screen.ts`、`renderer.ts`、`root.ts` | 常驻单元格缓冲；每帧做差分并以补丁形式输出，而非整屏重绘 |
| 补丁优化器 | `optimizer.ts` | 合并光标移动、丢弃空操作、拼接样式段、去重超链接 |
| 滚动 | `components/ScrollBox.tsx` | 基于缓存布局边界的视口裁剪 |
| 选区 | `selection.ts`、`hooks/use-selection.ts`、`searchHighlight.ts` | 渲染器内的文本选区与搜索高亮 |
| 命中测试 / 鼠标 | `hit-test.ts`、`events/` | 点击、悬停、鼠标事件分发到节点 |
| 终端 I/O | `termio/` | 自有的 ANSI 分词器与输出器 |
| 按键解析 | `parse-keypress.ts` | 取代 Node readline 的 keypress 处理 |
| 缓存 | `line-width-cache.ts`、`node-cache.ts` | 按行缓存 `stringWidth`（流式输出时测量次数约降至 1/50）；缓存每个节点的布局边界，使裁剪复杂度从 O(已挂载) 降到 O(脏节点) |
| 文本整形 | `stringWidth.ts`、`bidi.ts` | 东亚字符宽度与双向文本处理 |
| 光标 | `cursor.ts`、`hooks/use-declared-cursor.ts` | 声明式光标定位 |

### 被修改的上游模块

与上游同名的文件同样被改过。源码中用 `Upstream …` 注释标出了偏离点，与 Ink 对照前请先 grep 这些注释：

- `render-node-to-output.ts`——上游此处使用未截断的 `getMaxWidth(yogaNode)`，这里改为按宽度截断；另外增加了缩进处理
- `styles.ts`——节点占据的每一行都填充到右边缘
- `render-to-screen.ts`、`ink.tsx`——围绕屏幕缓冲区重写

### Yoga 移植

`native-ts/yoga-layout/index.ts` 是单趟布局的重新实现，不是 `CalculateLayout.cpp` 的逐行转写。它是同步的——不加载 WASM、没有线性内存——这正是它存在的主要理由。文件头部对覆盖范围有精确说明，简述如下：

- **为 Ink 实现的**：flex 方向/grow/shrink/basis、align 与 justify、margin/padding/border/gap、point 与百分比的尺寸及 min/max、绝对定位、`display: none`、measure 函数
- **为规范完整性实现、Ink 未使用的**：`margin: auto`、多趟 flex 钳制、`flex-wrap`、`align-content`、`display: contents`、基线对齐
- **未实现的**：`aspect-ratio`、`box-sizing: content-box`、RTL 方向（Ink 始终传 `Direction.LTR`）

`enums.ts` 中的枚举值与上游完全一致，因此按 `yoga-layout` 类型写的调用点可以原样迁移。

## 在这部分代码里工作

- **代码风格与 `src/` 其余部分不同。** 内置文件保留了 Ink 原有约定——单引号、不写分号、不同的 import 顺序。请对齐你正在编辑的那个文件，而不是 `AGENTS.md`。
- **三个文件带 `@ts-nocheck`**：`ink.tsx`、`reconciler.ts`、`render-to-screen.ts`。不要以为类型检查在那里替你兜底。
- **测试覆盖很薄**：`runtime/` 内只有 `selection.test.ts` 和 `execFileNoThrow.test.ts`。渲染器改动需要用 `npm run dev` 在真实 TTY 里手工验证——改变窗口大小、滚动长会话、拖拽选中文本、中断流式输出。

## 从上游取用改动

任何上游 Ink 的改动都应视为**移植，而非合并**：

1. 找到上游 commit，对照内置文件阅读。周边代码几乎肯定已经挪过位置。
2. 确认受影响路径是否落在上面列出的新增子系统里。Ink 在整屏重绘输出路径上的修复往往并不适用，因为那条路径已被屏幕缓冲区取代。
3. 手工重新应用，保持该文件本地的代码风格，并把取用了什么记录到本文档。
4. 用 `npm run build:check`、`npm test` 以及一次手工 TTY 验证来确认。

如果你对着某个具体的上游发布版做过同步，请更新上面的"基准版本"表格，填入版本号与 commit——这是本文档最值得补上的一项内容。
