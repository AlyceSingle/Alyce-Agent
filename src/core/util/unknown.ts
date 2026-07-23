/**
 * unknown 值的窄化小工具。
 * 全仓统一语义：asRecord 拒绝 array/null；asString 只接受 string。
 */
export type UnknownRecord = Record<string, unknown>;

/** 纯对象；array / null / 非 object 返回 null。 */
export function asRecord(value: unknown): UnknownRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as UnknownRecord;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return asNumber(value);
}

export function asNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  return asString(value) ?? null;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function asRecordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

export function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}
