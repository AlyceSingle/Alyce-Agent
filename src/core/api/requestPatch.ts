import jsonPatch from "fast-json-patch";
import { z } from "zod";

const { applyPatch } = jsonPatch;

const JsonPointerSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), {
    message: "JSON Pointer must start with '/'."
  });

const AddReplaceTestSchema = z
  .object({
    op: z.union([z.literal("add"), z.literal("replace"), z.literal("test")]),
    path: JsonPointerSchema,
    value: z.unknown()
  })
  .strict();

const RemoveSchema = z
  .object({
    op: z.literal("remove"),
    path: JsonPointerSchema
  })
  .strict();

const MoveCopySchema = z
  .object({
    op: z.union([z.literal("move"), z.literal("copy")]),
    from: JsonPointerSchema,
    path: JsonPointerSchema
  })
  .strict();

export const RequestPatchOperationSchema = z.union([AddReplaceTestSchema, RemoveSchema, MoveCopySchema]);

export const RequestPatchOperationsSchema = z.array(RequestPatchOperationSchema);

export type RequestPatchOperation = z.infer<typeof RequestPatchOperationSchema>;

// 统一解析并校验 JSON Patch 配置，确保启动阶段就暴露配置错误。
export function parseRequestPatchOperations(raw: string, source: string): RequestPatchOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse request patch JSON from ${source}: ${message}`);
  }

  const result = RequestPatchOperationsSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");

    throw new Error(`Invalid request patch operations from ${source}: ${details}`);
  }

  return result.data;
}

// 对请求体应用 JSON Patch，用于按环境动态覆盖模型参数与高级字段。
export function applyRequestPatchOperations<T extends object>(
  input: T,
  operations: readonly RequestPatchOperation[]
): T {
  if (operations.length === 0) {
    return input;
  }

  const cloned = structuredClone(input);
  const patchOperations = operations as Parameters<typeof applyPatch>[1];
  const patched = applyPatch(cloned as object, patchOperations, true, false).newDocument;

  if (!patched || typeof patched !== "object" || Array.isArray(patched)) {
    throw new Error("Patched request must remain an object.");
  }

  return patched as T;
}
