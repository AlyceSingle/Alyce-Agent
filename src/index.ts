import "dotenv/config";
import process from "node:process";
import readline from "node:readline/promises";
import OpenAI from "openai";
import { runAgentTurn } from "./agent.js";
import { parseReplCommand } from "./cli/commandRouter.js";
import { printNextTurnContextPreview } from "./cli/contextPreview.js";
import { parseRuntimeConfig } from "./config/runtime.js";
import { MemoryService } from "./core/memory/memoryService.js";
import type { MemorySnapshot } from "./core/memory/types.js";
import { buildEffectiveSystemPrompt } from "./core/prompt/builder.js";
import { PromptSectionResolver } from "./core/prompt/sectionResolver.js";
import { getRegisteredToolNames } from "./tools/registry.js";
import type { ToolExecutionContext } from "./tools/types.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_THINKING = "\u001b[38;5;244m";
const ANSI_ANSWER = "\u001b[38;5;81m";

// 输出可用 REPL 命令清单。
function printHelp(currentModel: string) {
  console.log("\nCommands:");
  console.log("  /help              Show this help");
  console.log("  /clear             Clear chat history");
  console.log("  /remember <text>   Save note to session and persistent memory");
  console.log("  /remember --session <text>  Save note to session memory only");
  console.log("  /memory            Show memory snapshot");
  console.log("  /memory clear      Clear session memory");
  console.log("  /memory clear --all  Clear session and persistent memory");
  console.log("  /context [text]    Show full next-turn AI context payload");
  console.log("  /model <name>      Switch model (current: " + currentModel + ")");
  console.log("  /exit              Quit");
}

// 统一使用 YYYY-MM-DD 作为动态提示词日期格式。
function getCurrentDateLabel() {
  return new Date().toISOString().slice(0, 10);
}

// 非交互终端（例如日志重定向）默认关闭颜色，避免污染输出。
function supportsColorOutput() {
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== "1");
}

function colorizeThinking(text: string) {
  if (!supportsColorOutput()) {
    return text;
  }

  return `${ANSI_THINKING}${text}${ANSI_RESET}`;
}

function colorizeAnswer(text: string) {
  if (!supportsColorOutput()) {
    return text;
  }

  return `${ANSI_ANSWER}${text}${ANSI_RESET}`;
}

function formatWithPrefix(prefix: string, text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function isReadlineClosedError(error: unknown) {
  return error instanceof Error && /readline was closed/i.test(error.message);
}

// 打印 Memory 快照，方便用户检查记忆内容是否符合预期。
function printMemorySnapshot(snapshot: MemorySnapshot, persistentPath: string) {
  console.log("\n=== Memory Snapshot ===");
  console.log("Persistent file: " + persistentPath);

  if (snapshot.session.length === 0) {
    console.log("Session memory: (empty)");
  } else {
    console.log("Session memory:");
    for (const entry of snapshot.session) {
      console.log(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  if (snapshot.persistent.length === 0) {
    console.log("Persistent memory: (empty)");
  } else {
    console.log("Persistent memory:");
    for (const entry of snapshot.persistent) {
      console.log(`- [${entry.createdAt.slice(0, 10)}] (${entry.source}) ${entry.content}`);
    }
  }

  console.log("=== End Memory Snapshot ===\n");
}

// CLI 主流程：初始化配置、模型客户端、会话消息与交互循环。
async function main() {
  const config = parseRuntimeConfig(process.argv.slice(2), process.env);
  let currentModel = config.model;
  const promptResolver = new PromptSectionResolver();
  const memoryService = new MemoryService({
    workspaceRoot: config.workspaceRoot,
    ...config.memory
  });
  await memoryService.initialize();

  // 每次按当前上下文重建 system prompt，便于模型切换和缓存失效后刷新。
  const buildSystemPrompt = async () =>
    buildEffectiveSystemPrompt(
      {
        model: currentModel,
        workspaceRoot: config.workspaceRoot,
        currentDate: getCurrentDateLabel(),
        platform: process.platform,
        availableTools: getRegisteredToolNames(),
        memory: await memoryService.getPromptContext()
      },
      config.prompt,
      promptResolver
    );

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // 会话消息始终以 system 消息开头，后续追加 user/assistant/tool。
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: await buildSystemPrompt()
    }
  ];

  // 重建并替换首条 system 消息，避免污染历史 user/assistant 记录。
  const resetSystemMessage = async () => {
    const systemPrompt = await buildSystemPrompt();
    messages[0] = {
      role: "system",
      content: systemPrompt
    };
  };

  // 工具执行上下文：定义工作区、超时和审批策略。
  const toolContext: ToolExecutionContext = {
    workspaceRoot: config.workspaceRoot,
    commandTimeoutMs: config.commandTimeoutMs,
    requestApproval: async (action) => {
      if (config.autoApprove) {
        return true;
      }

      const answer = await rl.question(`\n[TOOL REQUEST] ${action}\nAllow? (y/N): `);
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    }
  };

  console.log("TS Code Agent started.");
  console.log("Workspace: " + config.workspaceRoot);
  console.log("Model: " + currentModel);
  console.log("Mode: " + (config.autoApprove ? "auto-approve" : "approval required"));
  printHelp(currentModel);

  // 终端 REPL 主循环。
  while (true) {
    let rawInput = "";
    try {
      rawInput = await rl.question("\nyou> ");
    } catch (error) {
      // 管道输入结束时，readline 会抛错，这里按正常退出处理。
      if (isReadlineClosedError(error)) {
        break;
      }

      throw error;
    }

    const userInput = rawInput.trim();
    if (!userInput) {
      continue;
    }

    const parsedCommand = parseReplCommand(userInput);
    if (parsedCommand.type !== "none") {
      // 命令分支只处理本地控制逻辑，不写入模型对话历史。
      if (parsedCommand.type === "exit") {
        break;
      }

      if (parsedCommand.type === "help") {
        printHelp(currentModel);
        continue;
      }

      if (parsedCommand.type === "clear") {
        // /clear 仅清空会话态信息，不清理持久记忆文件。
        memoryService.clearSession();
        promptResolver.clearSessionCache();
        messages.splice(1);
        await resetSystemMessage();
        console.log("History and session memory cleared.");
        continue;
      }

      if (parsedCommand.type === "remember") {
        await memoryService.remember(parsedCommand.note, {
          source: "user",
          persist: parsedCommand.persist
        });
        await resetSystemMessage();
        console.log(
          parsedCommand.persist
            ? "Saved to session and persistent memory."
            : "Saved to session memory only."
        );
        continue;
      }

      if (parsedCommand.type === "memory-view") {
        const snapshot = await memoryService.getSnapshot();
        printMemorySnapshot(snapshot, memoryService.getPersistentFilePath());
        continue;
      }

      if (parsedCommand.type === "memory-clear") {
        memoryService.clearSession();
        if (parsedCommand.clearPersistent) {
          await memoryService.clearPersistent();
        }

        await resetSystemMessage();
        console.log(
          parsedCommand.clearPersistent
            ? "Session and persistent memory cleared."
            : "Session memory cleared."
        );
        continue;
      }

      if (parsedCommand.type === "context-preview") {
        printNextTurnContextPreview({
          currentModel,
          messages,
          nextUserInput: parsedCommand.nextUserInput
        });
        continue;
      }

      if (parsedCommand.type === "switch-model") {
        currentModel = parsedCommand.model;
        await resetSystemMessage();
        console.log("Switched model to: " + currentModel);
        continue;
      }
    }

    messages.push({
      role: "user",
      content: userInput
    });

    console.log("assistant> thinking...");

    try {
      let hasThinkingOutput = false;

      // 单轮中允许工具多步执行，直到得到最终自然语言输出。
      const reply = await runAgentTurn(client, messages, {
        model: currentModel,
        maxSteps: config.maxSteps,
        context: toolContext,
        onThinking: (thinking) => {
          const normalized = thinking.trim();
          if (!normalized) {
            return;
          }

          hasThinkingOutput = true;
          console.log(colorizeThinking(formatWithPrefix("assistant.thinking> ", normalized)));
        }
      });

      if (!hasThinkingOutput) {
        console.log(colorizeThinking("assistant.thinking> (model did not expose thinking text)"));
      }

      console.log(colorizeAnswer("assistant> " + reply));
    } catch (error) {
      // 运行时错误统一收口为可读文本，避免未处理异常中断 REPL。
      const message = error instanceof Error ? error.message : String(error);
      console.error("assistant> error: " + message);
    }
  }

  rl.close();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
