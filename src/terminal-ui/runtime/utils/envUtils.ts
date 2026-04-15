export function isEnvTruthy(value: string | boolean | undefined): boolean {
  if (!value) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.toLowerCase().trim();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isEnvDefinedFalsy(value: string | boolean | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return !value;
  }

  const normalized = value.toLowerCase().trim();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}
