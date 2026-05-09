import assert from "node:assert/strict";
import { AgentToolInputSchema, executeAgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "../types.js";

function createTestContext(
  patch: Partial<ToolExecutionContext> = {}
): ToolExecutionContext {
  const abortController = new AbortController();
  return {
    workspaceRoot: process.cwd(),
    allowedRoots: [process.cwd()],
    requestApproval: async () => true,
    askUserQuestions: async () => ({ answers: {} }),
    getTodos: () => [],
    setTodos: () => undefined,
    commandTimeoutMs: 30_000,
    turnId: "test-turn",
    abortSignal: abortController.signal,
    captureFileBeforeWrite: async () => undefined,
    recordFileRead: () => undefined,
    getFileReadState: () => undefined,
    ...patch
  };
}

async function runTests() {
  await testRequiresRuntimeHook();
  await testForegroundRequiresRuntimeHookBeforeApproval();
  await testBackgroundRequiresRuntimeHookBeforeApproval();
  await testUnknownSubagentType();
  await testRunsDefaultGeneralSubagent();
  await testPassesTaskIdForResume();
  await testBackgroundPassesTaskIdForResume();
  await testUnknownTaskIdReturnsStructuredError();
  await testMismatchedTaskIdReturnsStructuredError();
  await testBatchRunsReadOnlyTasks();
  await testBatchPartialFailure();
  await testBatchRejectsDuplicateTaskId();
  await testBatchRejectsGeneralAgent();
  await testBatchRejectsCustomWritableAgent();
  await testBatchRejectsCustomAnyShellAgent();
  await testBatchRejectsBackgroundFlag();
  await testRejectsUnknownTopLevelField();
  await testBackgroundLaunchesReadOnlySubagent();
  await testBackgroundRejectsGeneralAgent();
  await testBackgroundRejectsCustomWritableAgent();
  await testRejectedApprovalDoesNotRecordToolActivity();
  await testApprovedAgentRecordsToolActivity();
  await testApprovalDetailsHideOrchestrationTools();
  await testApprovalDetailsHideUnknownTools();
  console.log("AgentTool tests passed");
}

async function testRequiresRuntimeHook() {
  await assert.rejects(
    executeAgentTool({
      description: "Missing hook",
      prompt: "Do a task."
    }, createTestContext()),
    /AgentTool is not available/
  );
}

async function testForegroundRequiresRuntimeHookBeforeApproval() {
  let approved = false;
  await assert.rejects(
    executeAgentTool({
      description: "No foreground",
      prompt: "Do a task."
    }, createTestContext({
      launchSubagentTask: async () => {
        throw new Error("should not launch");
      },
      requestApproval: async () => {
        approved = true;
        return true;
      }
    })),
    /foreground mode is not available/
  );
  assert.equal(approved, false);
}

async function testBackgroundRequiresRuntimeHookBeforeApproval() {
  let approved = false;
  await assert.rejects(
    executeAgentTool({
      description: "No background",
      prompt: "Do a task.",
      subagent_type: "explore",
      run_in_background: true
    }, createTestContext({
      runSubagent: async () => {
        throw new Error("should not run");
      },
      requestApproval: async () => {
        approved = true;
        return true;
      }
    })),
    /background mode is not available/
  );
  assert.equal(approved, false);
}

async function testUnknownSubagentType() {
  const result = await executeAgentTool({
    description: "Unknown type",
    prompt: "Do a task.",
    subagent_type: "missing"
  }, createTestContext({
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "unknown_subagent_type");
  assert.deepEqual(
    (result as { available_subagent_types: string[] }).available_subagent_types,
    ["general", "explore", "review"]
  );
}

async function testRunsDefaultGeneralSubagent() {
  const result = await executeAgentTool({
    description: "Default agent",
    prompt: "Do a task."
  }, createTestContext({
    runSubagent: async (input) => ({
      taskId: "task-1",
      agentType: input.agentType,
      description: input.description,
      model: "test-model",
      maxSteps: 3,
      output: "done"
    })
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.task_id, "task-1");
  assert.equal((result as { agent_type: string }).agent_type, "general");
  assert.equal((result as { output: string }).output, "done");
}

async function testPassesTaskIdForResume() {
  let observedTaskId: string | undefined;
  const result = await executeAgentTool({
    description: "Resume agent",
    prompt: "Continue.",
    subagent_type: "explore",
    task_id: "existing-task"
  }, createTestContext({
    runSubagent: async (input) => {
      observedTaskId = input.taskId;
      return {
        taskId: input.taskId ?? "missing",
        agentType: input.agentType,
        description: input.description,
        model: "test-model",
        maxSteps: 2,
        output: "continued"
      };
    }
  }));

  assert.equal(observedTaskId, "existing-task");
  assert.equal(result.status, "completed");
  assert.equal(result.task_id, "existing-task");
  assert.equal((result as { agent_type: string }).agent_type, "explore");
}

async function testBackgroundPassesTaskIdForResume() {
  let observedTaskId: string | undefined;
  const result = await executeAgentTool({
    description: "Resume in background",
    prompt: "Continue later.",
    subagent_type: "explore",
    run_in_background: true,
    task_id: "background-existing-task"
  }, createTestContext({
    launchSubagentTask: async (input) => {
      observedTaskId = input.taskId;
      return {
        taskId: input.taskId ?? "missing",
        agentType: input.agentType,
        description: input.description,
        status: "running",
        model: "test-model",
        maxSteps: 4,
        startedAt: "2026-05-06T00:00:00.000Z"
      };
    }
  }));

  assert.equal(observedTaskId, "background-existing-task");
  assert.equal(result.status, "async_launched");
  assert.equal(result.task_id, "background-existing-task");
}

async function testUnknownTaskIdReturnsStructuredError() {
  const result = await executeAgentTool({
    description: "Missing task",
    prompt: "Continue.",
    task_id: "missing-task"
  }, createTestContext({
    runSubagent: async () => {
      throw new Error("Unknown subagent task_id: missing-task");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "unknown_task_id");
  assert.equal(result.task_id, "missing-task");
}

async function testMismatchedTaskIdReturnsStructuredError() {
  const result = await executeAgentTool({
    description: "Wrong type",
    prompt: "Continue.",
    subagent_type: "review",
    task_id: "task-2"
  }, createTestContext({
    runSubagent: async () => {
      throw new Error("Subagent task_id task-2 belongs to explore, not review.");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "mismatched_task_id");
  assert.equal(result.task_id, "task-2");
  assert.equal(result.actual_subagent_type, "explore");
  assert.equal(result.requested_subagent_type, "review");
}

async function testBatchRunsReadOnlyTasks() {
  const started: string[] = [];
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Explore auth",
        prompt: "Find auth entrypoints.",
        subagent_type: "explore"
      },
      {
        description: "Review risks",
        prompt: "Review risky areas.",
        subagent_type: "review"
      }
    ]
  }, createTestContext({
    runSubagent: async (input) => {
      started.push(input.agentType);
      return {
        taskId: `${input.agentType}-task`,
        agentType: input.agentType,
        description: input.description,
        model: "test-model",
        maxSteps: 2,
        output: `${input.agentType} done`
      };
    }
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(started.sort(), ["explore", "review"]);
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 2);
  assert.equal(results[0]?.status, "completed");
  assert.equal(results[1]?.status, "completed");
}

async function testBatchPartialFailure() {
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Explore ok",
        prompt: "Find files.",
        subagent_type: "explore"
      },
      {
        description: "Review missing",
        prompt: "Continue review.",
        subagent_type: "review",
        task_id: "missing-task"
      }
    ]
  }, createTestContext({
    runSubagent: async (input) => {
      if (input.taskId === "missing-task") {
        throw new Error("Unknown subagent task_id: missing-task");
      }

      return {
        taskId: "ok-task",
        agentType: input.agentType,
        description: input.description,
        model: "test-model",
        maxSteps: 2,
        output: "ok"
      };
    }
  }));

  assert.equal(result.status, "partial_failure");
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.status, "completed");
  assert.equal(results[1]?.status, "error");
  assert.equal(results[1]?.error, "unknown_task_id");
}

async function testBatchRejectsDuplicateTaskId() {
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Explore one",
        prompt: "Continue.",
        subagent_type: "explore",
        task_id: "same-task"
      },
      {
        description: "Explore two",
        prompt: "Continue again.",
        subagent_type: "explore",
        task_id: "same-task"
      }
    ]
  }, createTestContext({
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "invalid_batch");
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results.some((item) => item.error === "duplicate_task_id"), true);
}

async function testBatchRejectsGeneralAgent() {
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Implement thing",
        prompt: "Make a change.",
        subagent_type: "general"
      }
    ]
  }, createTestContext({
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "invalid_batch");
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.error, "non_read_only_agent_not_allowed_in_batch");
}

async function testBatchRejectsCustomWritableAgent() {
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Implement thing",
        prompt: "Make a change.",
        subagent_type: "writer"
      }
    ]
  }, createTestContext({
    getSubagentDefinition: async () => ({
      type: "writer",
      label: "Writer",
      description: "Custom writer.",
      systemPrompt: "Write files.",
      allowedTools: ["Read", "Edit"],
      policy: {
        allowWrite: true,
        allowNetwork: false,
        shell: "none"
      },
      source: "custom"
    }),
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "invalid_batch");
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.error, "non_read_only_agent_not_allowed_in_batch");
  assert.equal(results[0]?.agent_type, "writer");
}

async function testBatchRejectsCustomAnyShellAgent() {
  const result = await executeAgentTool({
    tasks: [
      {
        description: "Run shell",
        prompt: "Inspect with shell.",
        subagent_type: "sheller"
      }
    ]
  }, createTestContext({
    getSubagentDefinition: async () => ({
      type: "sheller",
      label: "Sheller",
      description: "Custom shell agent.",
      systemPrompt: "Run shell.",
      allowedTools: ["Read", "PowerShell"],
      policy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "any"
      },
      source: "custom"
    }),
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "invalid_batch");
  const results = result.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.error, "non_read_only_agent_not_allowed_in_batch");
  assert.equal(results[0]?.agent_type, "sheller");
}

async function testBatchRejectsBackgroundFlag() {
  const parsed = AgentToolInputSchema.safeParse({
    tasks: [
      {
        description: "Explore async",
        prompt: "Find files.",
        subagent_type: "explore",
        run_in_background: true
      }
    ]
  });

  assert.equal(parsed.success, false);
}

async function testRejectsUnknownTopLevelField() {
  const parsed = AgentToolInputSchema.safeParse({
    description: "Unknown field",
    prompt: "Do a task.",
    unexpected: true
  });

  assert.equal(parsed.success, false);
}

async function testBackgroundLaunchesReadOnlySubagent() {
  let observedTaskId: string | undefined;
  const result = await executeAgentTool({
    description: "Explore later",
    prompt: "Find relevant files.",
    subagent_type: "explore",
    run_in_background: true
  }, createTestContext({
    launchSubagentTask: async (input) => {
      observedTaskId = input.taskId;
      return {
        taskId: "background-task",
        agentType: input.agentType,
        description: input.description,
        status: "running",
        model: "test-model",
        maxSteps: 4,
        startedAt: "2026-05-06T00:00:00.000Z"
      };
    }
  }));

  assert.equal(observedTaskId, undefined);
  assert.equal(result.status, "async_launched");
  assert.equal(result.task_id, "background-task");
  assert.equal(result.agent_type, "explore");
  assert.equal(result.started_at, "2026-05-06T00:00:00.000Z");
}

async function testBackgroundRejectsGeneralAgent() {
  const result = await executeAgentTool({
    description: "Implement later",
    prompt: "Make code changes.",
    subagent_type: "general",
    run_in_background: true
  }, createTestContext({
    launchSubagentTask: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "non_read_only_agent_not_allowed_in_background");
}

async function testBackgroundRejectsCustomWritableAgent() {
  const result = await executeAgentTool({
    description: "Implement later",
    prompt: "Make code changes.",
    subagent_type: "writer",
    run_in_background: true
  }, createTestContext({
    getSubagentDefinition: async () => ({
      type: "writer",
      label: "Writer",
      description: "Custom writer.",
      systemPrompt: "Write files.",
      allowedTools: ["Read", "Edit"],
      policy: {
        allowWrite: true,
        allowNetwork: false,
        shell: "none"
      },
      source: "custom"
    }),
    launchSubagentTask: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "error");
  assert.equal(result.error, "non_read_only_agent_not_allowed_in_background");
  assert.equal(result.agent_type, "writer");
}

async function testRejectedApprovalDoesNotRecordToolActivity() {
  const recorded: string[] = [];
  const result = await executeAgentTool({
    description: "Rejected agent",
    prompt: "Do a task.",
    subagent_type: "explore"
  }, createTestContext({
    requestApproval: async () => false,
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    runSubagent: async () => {
      throw new Error("should not run");
    }
  }));

  assert.equal(result.status, "rejected");
  assert.deepEqual(recorded, []);
}

async function testApprovedAgentRecordsToolActivity() {
  const recorded: string[] = [];
  const result = await executeAgentTool({
    description: "Approved agent",
    prompt: "Do a task.",
    subagent_type: "explore"
  }, createTestContext({
    recordToolActivity: (toolName) => {
      recorded.push(toolName);
    },
    runSubagent: async (input) => ({
      taskId: "approved-task",
      agentType: input.agentType,
      description: input.description,
      model: "test-model",
      maxSteps: 3,
      output: "done"
    })
  }));

  assert.equal(result.status, "completed");
  assert.deepEqual(recorded, ["AgentTool"]);
}

async function testApprovalDetailsHideOrchestrationTools() {
  let details: string[] = [];
  const result = await executeAgentTool({
    description: "Custom reader",
    prompt: "Read files.",
    subagent_type: "custom-reader"
  }, createTestContext({
    getSubagentDefinition: async () => ({
      type: "custom-reader",
      label: "Custom Reader",
      description: "Custom reader.",
      systemPrompt: "Read only.",
      allowedTools: ["Read", "AgentTool", "TaskGet"],
      policy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "none"
      },
      source: "custom"
    }),
    requestApproval: async (request) => {
      details = request.details;
      return true;
    },
    runSubagent: async (input) => ({
      taskId: "custom-task",
      agentType: input.agentType,
      description: input.description,
      model: "test-model",
      maxSteps: 3,
      output: "done"
    })
  }));

  assert.equal(result.status, "completed");
  assert.equal(details.some((detail) => detail.includes("AgentTool")), false);
  assert.equal(details.some((detail) => detail.includes("TaskGet")), false);
}

async function testApprovalDetailsHideUnknownTools() {
  let details: string[] = [];
  const result = await executeAgentTool({
    description: "Custom reader",
    prompt: "Read files.",
    subagent_type: "custom-reader"
  }, createTestContext({
    getSubagentDefinition: async () => ({
      type: "custom-reader",
      label: "Custom Reader",
      description: "Custom reader.",
      systemPrompt: "Read only.",
      allowedTools: ["Read", "MissingTool"],
      policy: {
        allowWrite: false,
        allowNetwork: false,
        shell: "none"
      },
      source: "custom"
    }),
    requestApproval: async (request) => {
      details = request.details;
      return true;
    },
    runSubagent: async (input) => ({
      taskId: "custom-task",
      agentType: input.agentType,
      description: input.description,
      model: "test-model",
      maxSteps: 3,
      output: "done"
    })
  }));

  assert.equal(result.status, "completed");
  assert.equal(details.some((detail) => detail.includes("Read")), true);
  assert.equal(details.some((detail) => detail.includes("MissingTool")), false);
}

void runTests();
