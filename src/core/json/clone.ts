export function cloneJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return value;
  }

  return JSON.parse(encoded) as T;
}
