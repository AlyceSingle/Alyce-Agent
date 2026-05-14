const JS_PACKAGE_MANAGER_EXECUTABLE_PATTERN =
  String.raw`(?:(?:npm|npx|pnpm|yarn|corepack)(?:\.(?:cmd|exe))?|bun(?:\.exe)?)`;

const JS_PACKAGE_MANAGER_INVOCATION_PATTERN =
  String.raw`(?:(?:corepack(?:\.(?:cmd|exe))?\s+)?(?:npm|npx|pnpm|yarn)(?:\.(?:cmd|exe))?|corepack(?:\.(?:cmd|exe))?|bun(?:\.exe)?)`;

export const JS_PACKAGE_MANAGER_EXECUTABLE_REGEX = new RegExp(
  String.raw`^(?:${JS_PACKAGE_MANAGER_EXECUTABLE_PATTERN})$`,
  "i"
);

export const JS_PACKAGE_MANAGER_INSTALL_PATTERN = new RegExp(
  String.raw`\b(?:${JS_PACKAGE_MANAGER_INVOCATION_PATTERN})\s+(?:install|add|update|upgrade|ci|dlx|exec|create)\b`,
  "i"
);

export const JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN = new RegExp(
  String.raw`\b(?:${JS_PACKAGE_MANAGER_INVOCATION_PATTERN})\s+(?:run\s+)?(?:build|test|lint|typecheck)\b`,
  "i"
);

const JS_PACKAGE_MANAGER_INVOCATION_REGEX = new RegExp(
  String.raw`(?:^|[;&|({}\r\n]\s*)["']?(?:${JS_PACKAGE_MANAGER_INVOCATION_PATTERN})["']?(?=\s|$)`,
  "i"
);

export function containsJsPackageManagerInvocation(command: string): boolean {
  return JS_PACKAGE_MANAGER_INVOCATION_REGEX.test(command);
}
