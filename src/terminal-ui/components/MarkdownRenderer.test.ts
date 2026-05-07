import assert from "node:assert/strict";
import { buildMarkdownRenderPlan } from "./MarkdownRenderer.js";

function runTests() {
  testInlineMathWithAsteriskDoesNotBreakMarkdown();
  testCodespanMathIsLeftLiteral();
  testDisplayMathGetsOwnBlock();
  console.log("MarkdownRenderer tests passed");
}

function testInlineMathWithAsteriskDoesNotBreakMarkdown() {
  const plan = buildMarkdownRenderPlan(
    "公式： $A^{-1} = \\frac{1}{|A|} A^*$\n" +
      "(其中 **|A|** 是矩阵的行列式，$A^*$ 是伴随矩阵)*\n" +
      "口诀是 **“主对角线换位置，副对角线变符号”**，然后再除以行列式 |A|。",
    120
  );
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /A\^-1 = 1\/\|A\| A\^\*/);
  assert.match(renderedText, /其中 \|A\| 是矩阵的行列式，A\^\* 是伴随矩阵\)\*/);
  assert.match(renderedText, /口诀是 “主对角线换位置，副对角线变符号”，然后再除以行列式 \|A\|。/);
  assert.equal(findSpan(plan, "主对角线")?.bold, true);
  assert.doesNotMatch(renderedText, /\$A/);
  assert.doesNotMatch(renderedText, /\*\*/);
}

function testCodespanMathIsLeftLiteral() {
  const plan = buildMarkdownRenderPlan("Use `$A^*$` literally, render $A^*$ here.", 120);
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /Use \$A\^\*\$ literally, render A\^\* here\./);
}

function testDisplayMathGetsOwnBlock() {
  const plan = buildMarkdownRenderPlan("before\n\n$$A^{-1} = \\frac{1}{|A|} A^*$$\n\nafter", 120);
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /before\nA\^-1 = 1\/\|A\| A\^\*\nafter/);
}

function flattenPlanText(plan: ReturnType<typeof buildMarkdownRenderPlan>): string {
  return plan.blocks
    .flatMap((block) => block.lines.map((line) => line.spans.map((span) => span.text).join("")))
    .join("\n");
}

function findSpan(plan: ReturnType<typeof buildMarkdownRenderPlan>, text: string) {
  for (const block of plan.blocks) {
    for (const line of block.lines) {
      const span = line.spans.find((candidate) => candidate.text.includes(text));
      if (span) {
        return span;
      }
    }
  }

  return undefined;
}

runTests();
