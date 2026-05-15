import assert from "node:assert/strict";
import { buildMarkdownRenderPlan } from "./MarkdownRenderer.js";
import { measureCharWidth } from "../utils/text.js";

function runTests() {
  testInlineMathWithAsteriskDoesNotBreakMarkdown();
  testCodespanMathIsLeftLiteral();
  testDisplayMathGetsOwnBlock();
  testDoubleEscapedHtmlEntityInMarkdownGetsDecoded();
  testDeepEscapedHtmlEntityInMarkdownGetsDecoded();
  testPlainTextAndCodeSpanEntityDecodingStayDistinct();
  testMixedCjkAndAsciiWrapsWithinWidth();
  testMarkdownTableRendersStructuredLines();
  testMarkdownTableDividerUsesDedicatedVariant();
  testNestedQuoteTracksDepth();
  testLinkSpanPreservesHrefAndUnderlineStyle();
  testLinkRenderingAppendsHrefForCopyWhenLabelDiffers();
  testLinkRenderingDoesNotDuplicateHrefWhenLabelIsUrl();
  testCjkStrongAndEmphasisKeepInheritedColors();
  testLiveCjkStrongWithEdgePunctuationRendersInsideSentence();
  testEnhancedMathSymbolsRenderAsUnicodeText();
  testDisplayMathRendersStructuredEnvironments();
  testMarkdownCacheKeyIncludesPolicyVersion();
  testBudgetGuardIgnoresFencedCodeNestingMarkers();
  testBudgetGuardRejectsOverNestedMarkdown();
  testLivePlanStabilizesTrailingOpenCodeFence();
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

  assert.match(renderedText, /A⁻¹ = 1\/\|A\| A\^\*/);
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

  assert.match(renderedText, /before\nA⁻¹ = 1\/\|A\| A\^\*\nafter/);
}

function testDoubleEscapedHtmlEntityInMarkdownGetsDecoded() {
  const plan = buildMarkdownRenderPlan("* *&amp;quot;Hello!&amp;quot;* —— 感叹号在引号内", 120);
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /"Hello!" —— 感叹号在引号内/);
  assert.doesNotMatch(renderedText, /&quot;/);
}

function testDeepEscapedHtmlEntityInMarkdownGetsDecoded() {
  const plan = buildMarkdownRenderPlan("* &amp;amp;amp;quot;Hello&amp;amp;amp;quot; *", 120);
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /"Hello"/);
  assert.doesNotMatch(renderedText, /&quot;/);
}

function testPlainTextAndCodeSpanEntityDecodingStayDistinct() {
  const plan = buildMarkdownRenderPlan(
    "plain &amp;quot;Hello&amp;quot; and code `&amp;quot;Hello&amp;quot;`",
    120
  );
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /plain "Hello" and code "Hello"/);
  assert.doesNotMatch(renderedText, /&amp;quot;/);
  assert.doesNotMatch(renderedText, /&quot;/);
}

function testMixedCjkAndAsciiWrapsWithinWidth() {
  const width = 18;
  const plan = buildMarkdownRenderPlan("中文English混排0123456789中文English混排0123456789", width);
  const lineTexts = flattenPlanLines(plan);

  assert.ok(lineTexts.length > 1);
  for (const line of lineTexts) {
    assert.ok(measureDisplayWidth(line) <= width, `line exceeds width ${width}: ${line}`);
  }
}

function testMarkdownTableRendersStructuredLines() {
  const plan = buildMarkdownRenderPlan(
    "| Name | Value |\n| --- | --- |\n| 中文A | B123 |\n| C | D |",
    80
  );
  const lineTexts = flattenPlanLines(plan);

  assert.ok(lineTexts.some((line) => line.includes("│")));
  assert.ok(lineTexts.some((line) => line.includes("─┼─")));
}

function testMarkdownTableDividerUsesDedicatedVariant() {
  const plan = buildMarkdownRenderPlan(
    "| Name | Value |\n| --- | --- |\n| A | B |",
    80
  );
  const hasTableDivider = plan.blocks
    .flatMap((block) => block.lines)
    .some((line) => line.variant === "table-divider");

  assert.equal(hasTableDivider, true);
}

function testNestedQuoteTracksDepth() {
  const plan = buildMarkdownRenderPlan(
    ["> level 1", ">> level 2", ">>> level 3"].join("\n"),
    80
  );
  const quoteLines = plan.blocks
    .flatMap((block) => block.lines)
    .filter((line) => line.variant === "quote");
  const depths = quoteLines
    .map((line) => line.quoteDepth ?? 0)
    .filter((depth) => depth > 0);

  assert.deepEqual(depths, [1, 2, 3]);
}

function testLinkSpanPreservesHrefAndUnderlineStyle() {
  const plan = buildMarkdownRenderPlan("Visit [Example](https://example.com) now.", 120);
  const exampleSpan = findSpan(plan, "Example");

  assert.equal(exampleSpan?.href, "https://example.com");
  assert.equal(exampleSpan?.underline, true);
}

function testLinkRenderingAppendsHrefForCopyWhenLabelDiffers() {
  const plan = buildMarkdownRenderPlan("Visit [Example](https://example.com) now.", 120);
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /Example <https:\/\/example\.com>/);
}

function testLinkRenderingDoesNotDuplicateHrefWhenLabelIsUrl() {
  const plan = buildMarkdownRenderPlan("Visit [https://example.com](https://example.com) now.", 120);
  const renderedText = flattenPlanText(plan);

  assert.doesNotMatch(renderedText, /<https:\/\/example\.com>/);
}

function testCjkStrongAndEmphasisKeepInheritedColors() {
  const strongPlan = buildMarkdownRenderPlan("**中文（测试）。**", 120, { live: true });
  const emphasisPlan = buildMarkdownRenderPlan("*（中文）。*", 120, { live: true });
  const outsidePlan = buildMarkdownRenderPlan("**重点**。", 120, { live: true });

  const strongSpan = findSpan(strongPlan, "中文（测试）。");
  const emphasisSpan = findSpan(emphasisPlan, "（中文）。");
  const outsideSpans = flattenPlanSpans(outsidePlan);

  assert.equal(strongSpan?.bold, true);
  assert.equal(strongSpan?.color, undefined);
  assert.equal(emphasisSpan?.italic, true);
  assert.equal(emphasisSpan?.color, undefined);
  assert.equal(outsideSpans.find((span) => span.text === "重点")?.bold, true);
  assert.equal(outsideSpans.find((span) => span.text === "。")?.bold, undefined);
}

function testLiveCjkStrongWithEdgePunctuationRendersInsideSentence() {
  const cases: Array<{ source: string; highlighted: string }> = [
    {
      source: "一个**“事件驱动的系统”**。",
      highlighted: "事件驱动的系统"
    },
    {
      source: "还有**事件驱动（你好）**也不会",
      highlighted: "事件驱动（你好）"
    }
  ];

  for (const testCase of cases) {
    const plan = buildMarkdownRenderPlan(testCase.source, 120, { live: true });
    const renderedText = flattenPlanText(plan);

    assert.equal(findSpan(plan, testCase.highlighted)?.bold, true);
    assert.doesNotMatch(renderedText, /\*\*/);
  }
}

function testEnhancedMathSymbolsRenderAsUnicodeText() {
  const plan = buildMarkdownRenderPlan(
    "Inline $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ and $\\alpha \\leq \\beta \\to \\infty$.",
    120
  );
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /∑ᵢ₌₁ⁿ i = \(n\(n\+1\)\)\/2/);
  assert.match(renderedText, /α ≤ β → ∞/);
}

function testDisplayMathRendersStructuredEnvironments() {
  const plan = buildMarkdownRenderPlan(
    [
      "matrix:",
      "",
      "$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$",
      "",
      "cases:",
      "",
      "$$\\begin{cases} x^2 & \\text{if } x \\geq 0 \\\\ -x & otherwise \\end{cases}$$",
      "",
      "text cell:",
      "",
      "$$\\begin{pmatrix} a & \\text{b \\\\ c} \\\\ d & e \\end{pmatrix}$$"
    ].join("\n"),
    120
  );
  const renderedText = flattenPlanText(plan);

  assert.match(renderedText, /\( a  b \)\n\( c  d \)/);
  assert.match(renderedText, /\{ x², if x ≥ 0\n\{ -x, otherwise/);
  assert.match(renderedText, /\( a  b \\ c \)\n\( d  e \)/);
}

function testMarkdownCacheKeyIncludesPolicyVersion() {
  const source = "Policy key check";
  const planV1 = buildMarkdownRenderPlan(source, 80, { policyVersion: "v1" });
  const original = planV1.blocks[0]?.lines[0]?.spans[0];
  assert.ok(original);
  if (original) {
    original.text = "mutated-plan";
  }

  const sameVersionPlan = buildMarkdownRenderPlan(source, 80, { policyVersion: "v1" });
  const differentVersionPlan = buildMarkdownRenderPlan(source, 80, { policyVersion: "v2" });

  assert.equal(sameVersionPlan.blocks[0]?.lines[0]?.spans[0]?.text, "mutated-plan");
  assert.equal(differentVersionPlan.blocks[0]?.lines[0]?.spans[0]?.text, "Policy key check");
}

function testBudgetGuardIgnoresFencedCodeNestingMarkers() {
  const plan = buildMarkdownRenderPlan(
    [
      "```md",
      `${">".repeat(40)} fence content`,
      "```"
    ].join("\n"),
    80
  );
  const rendered = flattenPlanText(plan);

  assert.match(rendered, />{40} fence content/);
}

function testBudgetGuardRejectsOverNestedMarkdown() {
  const nested = `${">".repeat(40)} too deep`;
  assert.throws(
    () => buildMarkdownRenderPlan(nested, 80),
    /budget exceeded/i
  );
}

function testLivePlanStabilizesTrailingOpenCodeFence() {
  const plan = buildMarkdownRenderPlan(
    [
      "before",
      "",
      "```ts",
      "const value = 1;"
    ].join("\n"),
    120,
    { live: true }
  );
  const rendered = flattenPlanText(plan);

  assert.match(rendered, /before/);
  assert.match(rendered, /const value = 1;/);
}

function flattenPlanText(plan: ReturnType<typeof buildMarkdownRenderPlan>): string {
  return flattenPlanLines(plan).join("\n");
}

function flattenPlanLines(plan: ReturnType<typeof buildMarkdownRenderPlan>): string[] {
  return plan.blocks
    .flatMap((block) => block.lines.map((line) => line.spans.map((span) => span.text).join("")));
}

function flattenPlanSpans(plan: ReturnType<typeof buildMarkdownRenderPlan>) {
  return plan.blocks.flatMap((block) => block.lines.flatMap((line) => line.spans));
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

function measureDisplayWidth(value: string) {
  return Array.from(value).reduce((sum, character) => sum + measureCharWidth(character), 0);
}

runTests();
