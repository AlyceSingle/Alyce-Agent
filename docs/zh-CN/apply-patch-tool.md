<p align="center">
  <a href="../apply-patch-tool.md">English</a> | 简体中文
</p>

# apply_patch 工具

Alyce 现在内置 `apply_patch`，用于一次性处理多文件编辑。它把本地 opencode 的 patch 语言移植到了 Alyce 原生 TypeScript 工具链里，而不是依赖外部 shell patch 命令。

## 输入

工具接受一个 JSON 参数：

```json
{
  "patchText": "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch"
}
```

`patchText` 也可以包在 heredoc 里，例如 `cat <<'EOF' ... EOF` 或 `<<EOF ... EOF`。

## 不是 unified diff

这个 patch 语言不是标准 unified diff。不要写 `---`/`+++` 文件头，不要写行号范围头，也不要写 `@@ -1,4 +1,4 @@` 这种 hunk。

需要定位时，使用单独的 `@@`，或者用 `@@ <文件里的真实一行内容>` 作为搜索锚点。Alyce 会兼容误写的 unified range header，把它当作普通 `@@` 处理，但提示词会明确要求模型不要生成这种格式。

## Patch 格式

每个 patch 都使用这个外壳：

```text
*** Begin Patch
[一个或多个文件段]
*** End Patch
```

支持的文件段：

```text
*** Add File: <path>
+new file line

*** Delete File: <path>

*** Update File: <path>
*** Move to: <new-path>
@@ optional context anchor
 unchanged context
-old line
+new line
*** End of File
```

`*** Move to:` 是可选的，只能紧跟在 `*** Update File:` 后面。新增文件内容必须用 `+` 前缀。

## 匹配行为

写入任何文件之前，Alyce 会先验证所有 update hunk。匹配行为对齐 opencode：

- 精确行匹配
- 忽略尾部空白的匹配
- 首尾空白都忽略的匹配
- 对引号、破折号、省略号、不间断空格做 Unicode 标点归一化匹配
- `@@ context` 会先定位目标区域，再匹配 hunk 内容
- `*** End of File` 会优先从文件末尾尝试匹配
- 同一文件里的多个 hunk 按顺序应用

任意 hunk 验证失败时，整个 patch 都会被拒绝，不会留下部分写入。

## Alyce 额外安全层

相比 opencode 的实现，Alyce 保留现有文件工具的安全模型：

- Update、Delete、Move，以及覆盖已有文件的 Add，都要求先完整新鲜地 `Read`
- 路径必须位于工作区或已授权的附加目录内
- 所有受影响路径按确定顺序加锁
- 审批提示出现前先完成所有文件预检
- 审批通过后按原始字节再次确认文件未变
- 新目标文件使用排他创建，避免审批窗口中的竞态覆盖
- 写入前拍快照，让 `/rewind` 可以恢复已跟踪改动
- 如果审批后的写入、删除、移动或写后记录步骤抛错，Alyce 会尽力回滚本次 patch 已经改动过的路径
- 已有文本文件保留编码和行尾
- 写入成功后运行已配置的格式化程序，并返回 TypeScript/JavaScript 诊断

## 与 opencode 的剩余差异

明显的编辑能力差距已经补上：Alyce 支持 opencode patch 外壳、Add/Delete/Update/Move、多文件 patch、多 hunk 更新、纯插入 hunk、heredoc 包裹、EOF anchor、context anchor、空白容错匹配和 Unicode 标点匹配。

剩余差异是有意保留的安全和运行时差异：

- Alyce 把 `apply_patch` 暴露为普通模型工具，参数是 `{ "patchText": "..." }`；不会把 shell 文本隐式拦截成隐藏命令。
- Add 覆盖已有文件、Move 覆盖目标文件时，目标文件必须先被完整读取。
- 诊断使用 Alyce 当前的 TypeScript/JavaScript 诊断后端，而不是 opencode 的 LSP 服务。
