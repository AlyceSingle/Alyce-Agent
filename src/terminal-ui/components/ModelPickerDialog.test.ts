import assert from "node:assert/strict";
import {
  buildConnectionConfigState,
  getRuntimePaths
} from "../../config/runtime.js";
import {
  createModelPickerOptions,
  filterModelPickerOptions
} from "./ModelPickerDialog.js";

const settings = {
  modelContextWindowOverrides: {}
};

function runTests() {
  testOptionsIncludeConnectedCopilotModels();
  testOptionsIncludeCurrentModelWhenMissingFromProviderProfile();
  testOptionsCanBeSearched();
  testOptionsUseEnvironmentApiKeys();
  console.log("ModelPickerDialog tests passed");
}

function testOptionsIncludeConnectedCopilotModels() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      model: "github-copilot/gpt-5.2",
      providers: {
        "github-copilot": {
          apiKey: "copilot-token"
        }
      }
    }
  });
  const options = createModelPickerOptions({
    connectionState: state,
    settings,
    currentModel: state.effective.model
  });
  const copilotModels = options
    .filter((option) => option.providerId === "github-copilot")
    .map((option) => option.modelId);

  assert.deepEqual(copilotModels, ["gpt-5.2", "gpt-5.1-codex", "claude-sonnet-4.5"]);
  assert.equal(
    options.find((option) => option.modelRef === "github-copilot/gpt-5.2")?.current,
    true
  );
  assert.equal(
    options.find((option) => option.modelRef === "github-copilot/claude-sonnet-4.5")?.available,
    true
  );
}

function testOptionsIncludeCurrentModelWhenMissingFromProviderProfile() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      model: "openai/custom-live-model",
      providers: {
        openai: {
          apiKey: "openai-key"
        }
      }
    }
  });
  const options = createModelPickerOptions({
    connectionState: state,
    settings,
    currentModel: state.effective.model
  });

  assert.equal(options[0]?.modelRef, "openai/custom-live-model");
  assert.equal(options[0]?.current, true);
}

function testOptionsCanBeSearched() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {
    user: {
      providers: {
        "github-copilot": {
          apiKey: "copilot-token"
        }
      }
    }
  });
  const options = filterModelPickerOptions(
    createModelPickerOptions({
      connectionState: state,
      settings,
      currentModel: "github-copilot/gpt-5.2"
    }),
    "sonnet"
  );

  assert.deepEqual(
    options.map((option) => option.modelRef),
    ["github-copilot/claude-sonnet-4.5"]
  );
}

function testOptionsUseEnvironmentApiKeys() {
  const state = buildConnectionConfigState(getRuntimePaths("C:\\workspace"), {});
  const options = createModelPickerOptions({
    connectionState: state,
    settings,
    currentModel: "anthropic/claude-sonnet-4.6",
    env: {
      ANTHROPIC_API_KEY: "anthropic-key"
    }
  });

  assert.equal(
    options.find((option) => option.modelRef === "anthropic/claude-sonnet-4.6")?.available,
    true
  );
}

runTests();
