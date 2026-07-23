/**
 * 统一把 unknown 错误转成可读字符串。
 * 避免各模块各自复制 `error instanceof Error ? ...`。
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
