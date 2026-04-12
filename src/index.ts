import "dotenv/config";
import process from "node:process";
import readline from "node:readline/promises";
import OpenAI from "openai";
import { runAgentTurn } from "./agent.js";
import { parseReplCommand } from "./cli/commandRouter.js";
import { printNextTurnContextPreview } from "./cli/contextPreview.js";
import { parseRuntimeConfig } from "./config/runtime.js";
import { buildEffectiveSystemPrompt } from "./core/prompt/builder.js";
import { PromptSectionResolver } from "./core/prompt/sectionResolver.js";
import { getRegisteredToolNames } from "./tools/registry.js";
import type { ToolExecutionContext } from "./tools/types.js";

function printHelp(currentModel: string) {
  console.log("\nCommands:");
  console.log("  /help              Show this help");
  console.log("  /clear             Clear chat history");
  console.log("  /context [text]    Show full next-turn AI context payload");
  console.log("  /model <name>      Switch model (current: " + currentModel + ")");
  console.log("  /exit              Quit");
}

function getCurrentDateLabel() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const config = parseRuntimeConfig(process.argv.slice(2), process.env);
  let currentModel = config.model;
  const promptResolver = new PromptSectionResolver();

  const buildSystemPrompt = async () =>
    buildEffectiveSystemPrompt(
      {
        model: currentModel,
        workspaceRoot: config.workspaceRoot,
        currentDate: getCurrentDateLabel(),
        platform: process.platform,
        availableTools: getRegisteredToolNames()
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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: await buildSystemPrompt()
    }
  ];

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
    const userInput = (await rl.question("\nyou> ")).trim();
    if (!userInput) {
      continue;
    }

    const parsedCommand = parseReplCommand(userInput);
    if (parsedCommand.type !== "none") {
      if (parsedCommand.type === "exit") {
        break;
      }

      if (parsedCommand.type === "help") {
        printHelp(currentModel);
        continue;
      }

      if (parsedCommand.type === "clear") {
        promptResolver.clearSessionCache();
        messages.splice(1);
        await resetSystemMessage();
        console.log("History cleared.");
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
      // 单轮中允许工具多步执行，直到得到最终自然语言输出。
      const reply = await runAgentTurn(client, messages, {
        model: currentModel,
        maxSteps: config.maxSteps,
        context: toolContext
      });

      console.log("assistant> " + reply);
    } catch (error) {
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
