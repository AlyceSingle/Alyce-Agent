import type {
  ElicitRequestParams,
  ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import { normalizeMcpServerName } from "./config.js";
import type {
  McpElicitationField,
  McpElicitationRequest,
  McpElicitationResponse,
  McpPromptSummary,
  McpResourceSummary,
  McpResourceTemplateSummary,
  McpServerConfig
} from "./types.js";
import type { McpToolMetadata } from "./runtimeTypes.js";
import { MCP_PROMPT_TEXT_MAX_CHARS } from "./runtimeTypes.js";
import { truncate } from "./timeouts.js";

// 工具/资源/prompt/elicitation 结果规范化与文件名辅助。

export function normalizeMcpToolResult(tool: McpToolMetadata, result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    status: record.isError === true ? "error" : "completed",
    server: tool.serverName,
    tool: tool.originalName,
    content: normalizeContent(record.content),
    structuredContent: record.structuredContent,
    isError: record.isError === true,
    raw: result
  };
}

export function normalizeContent(content: unknown) {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return {
        type: "text",
        text: record.text
      };
    }

    if (record.type === "resource") {
      return {
        type: "resource",
        resource: record.resource
      };
    }

    if (record.type === "image" || record.type === "audio" || record.type === "resource_link") {
      return record;
    }

    return record;
  });
}
export function formatEndpoint(config: McpServerConfig) {
  if (config.type !== "stdio") {
    return config.url;
  }

  return [config.command, ...(config.args ?? [])].join(" ");
}
export function normalizeRequestedServerName(serverName: string): string {
  const normalized = normalizeMcpServerName(serverName);
  return normalized || serverName.trim();
}
export function isServerEnabled(config: McpServerConfig) {
  return config.enabled !== false;
}

export function normalizeResourceSummary(
  serverName: string,
  resource: {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }
): McpResourceSummary {
  return {
    server: serverName,
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource.size !== undefined ? { size: resource.size } : {})
  };
}

export function normalizePromptSummary(
  serverName: string,
  prompt: {
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  }
): McpPromptSummary {
  return {
    server: serverName,
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    arguments: (prompt.arguments ?? []).map((argument) => ({
      name: argument.name,
      ...(argument.description ? { description: argument.description } : {}),
      required: argument.required === true
    }))
  };
}

export function normalizeResourceTemplateSummary(
  serverName: string,
  template: {
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
  }
): McpResourceTemplateSummary {
  return {
    server: serverName,
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(template.title ? { title: template.title } : {}),
    ...(template.description ? { description: template.description } : {}),
    ...(template.mimeType ? { mimeType: template.mimeType } : {})
  };
}

export function normalizeElicitationRequest(
  serverName: string,
  params: ElicitRequestParams
): McpElicitationRequest {
  if (params.mode === "url") {
    return {
      serverName,
      mode: "url",
      message: params.message,
      url: params.url,
      elicitationId: params.elicitationId
    };
  }

  return {
    serverName,
    mode: "form",
    message: params.message,
    fields: Object.entries(params.requestedSchema.properties).map(([key, field]) =>
      normalizeElicitationField(key, field, params.requestedSchema.required ?? [])
    )
  };
}

export function normalizeElicitationField(
  key: string,
  field: unknown,
  requiredKeys: string[]
): McpElicitationField {
  const isRequired = requiredKeys.includes(key);
  const record = field as Record<string, unknown>;
  const label = typeof record.title === "string" && record.title.trim().length > 0
    ? record.title
    : key;
  const description = typeof record.description === "string"
    ? record.description
    : undefined;

  if (record.type === "boolean") {
    return {
      key,
      label,
      ...(description ? { description } : {}),
      kind: "boolean",
      required: isRequired,
      ...(typeof record.default === "boolean" ? { defaultValue: record.default } : {})
    };
  }

  if (record.type === "number" || record.type === "integer") {
    return {
      key,
      label,
      ...(description ? { description } : {}),
      kind: record.type,
      required: isRequired,
      ...(typeof record.minimum === "number" ? { minimum: record.minimum } : {}),
      ...(typeof record.maximum === "number" ? { maximum: record.maximum } : {}),
      ...(typeof record.default === "number" ? { defaultValue: record.default } : {})
    };
  }

  if (record.type === "array" && record.items && typeof record.items === "object") {
    const items = record.items as Record<string, unknown>;
    const enumOptions = Array.isArray(items.enum)
      ? items.enum.filter((value): value is string => typeof value === "string")
        .map((value) => ({ value, label: value }))
      : Array.isArray(items.anyOf)
        ? (items.anyOf as unknown[])
          .map((option) => {
            if (!option || typeof option !== "object") {
              return null;
            }

            const optionRecord = option as Record<string, unknown>;
            if (typeof optionRecord.const !== "string") {
              return null;
            }

            return {
              value: optionRecord.const,
              label: typeof optionRecord.title === "string"
                ? optionRecord.title
                : optionRecord.const
            };
          })
          .filter((option): option is { value: string; label: string } => option !== null)
        : [];

    return {
      key,
      label,
      ...(description ? { description } : {}),
      kind: "multi_enum",
      required: isRequired,
      options: enumOptions,
      ...(typeof record.minItems === "number" ? { minItems: record.minItems } : {}),
      ...(typeof record.maxItems === "number" ? { maxItems: record.maxItems } : {}),
      ...(Array.isArray(record.default)
        ? {
            defaultValue: record.default.filter((value): value is string => typeof value === "string")
          }
        : {})
    };
  }

  const enumOptions = Array.isArray(record.enum)
    ? record.enum.filter((value): value is string => typeof value === "string")
      .map((value, index) => ({
        value,
        label: Array.isArray(record.enumNames) && typeof record.enumNames[index] === "string"
          ? record.enumNames[index] as string
          : value
      }))
    : Array.isArray(record.oneOf)
      ? (record.oneOf as unknown[])
        .map((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }

          const optionRecord = option as Record<string, unknown>;
          if (typeof optionRecord.const !== "string") {
            return null;
          }

          return {
            value: optionRecord.const,
            label: typeof optionRecord.title === "string"
              ? optionRecord.title
              : optionRecord.const
          };
        })
        .filter((option): option is { value: string; label: string } => option !== null)
      : [];

  if (enumOptions.length > 0) {
    return {
      key,
      label,
      ...(description ? { description } : {}),
      kind: "enum",
      required: isRequired,
      options: enumOptions,
      ...(typeof record.default === "string" ? { defaultValue: record.default } : {})
    };
  }

  return {
    key,
    label,
    ...(description ? { description } : {}),
    kind: "string",
    required: isRequired,
    ...(typeof record.format === "string" &&
      (record.format === "date" ||
      record.format === "uri" ||
      record.format === "email" ||
      record.format === "date-time")
      ? { format: record.format }
      : {}),
    ...(typeof record.minLength === "number" ? { minLength: record.minLength } : {}),
    ...(typeof record.maxLength === "number" ? { maxLength: record.maxLength } : {}),
    ...(typeof record.default === "string" ? { defaultValue: record.default } : {})
  };
}

export function normalizeElicitationResponse(response: McpElicitationResponse): ElicitResult {
  const content = response.content && Object.keys(response.content).length > 0
    ? response.content
    : undefined;
  return {
    action: response.action,
    ...(content ? { content } : {})
  };
}

export function sanitizeFileName(value: string) {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "resource";
}

export function extensionForMimeType(mimeType: string | undefined) {
  switch (mimeType) {
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}

