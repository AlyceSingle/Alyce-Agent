import assert from "node:assert/strict";
import {
  decodeHtmlEntities,
  MAX_HTML_ENTITY_DECODE_PASSES,
  normalizeMarkdownInput
} from "./htmlEntities.js";

function runTests() {
  testDecodeHtmlEntitiesKeepsInvalidEntitiesUntouched();
  testDecodeHtmlEntitiesHonorsMaxPasses();
  testNormalizeMarkdownInputNormalizesLineEndingsAndDecodesByDefault();
  testNormalizeMarkdownInputCanSkipEntityDecoding();
  console.log("htmlEntities tests passed");
}

function testDecodeHtmlEntitiesKeepsInvalidEntitiesUntouched() {
  const source = "valid: &quot;ok&quot; | invalid: &not_a_real_entity;";
  const decoded = decodeHtmlEntities(source);

  assert.equal(decoded, "valid: \"ok\" | invalid: &not_a_real_entity;");
}

function testDecodeHtmlEntitiesHonorsMaxPasses() {
  const deeplyEscapedQuote = encodeEntity("&quot;", MAX_HTML_ENTITY_DECODE_PASSES);
  const defaultDecoded = decodeHtmlEntities(deeplyEscapedQuote);
  const fullyDecoded = decodeHtmlEntities(deeplyEscapedQuote, MAX_HTML_ENTITY_DECODE_PASSES + 1);

  assert.equal(defaultDecoded, "&quot;");
  assert.equal(fullyDecoded, "\"");
}

function testNormalizeMarkdownInputNormalizesLineEndingsAndDecodesByDefault() {
  const normalized = normalizeMarkdownInput("a\r\nb\r\n&amp;quot;ok&amp;quot;");
  assert.equal(normalized, "a\nb\n\"ok\"");
}

function testNormalizeMarkdownInputCanSkipEntityDecoding() {
  const normalized = normalizeMarkdownInput("a\r\n&amp;quot;ok&amp;quot;", { decodeEntities: false });
  assert.equal(normalized, "a\n&amp;quot;ok&amp;quot;");
}

function encodeEntity(entity: string, layers: number) {
  let value = entity;
  for (let index = 0; index < layers; index += 1) {
    value = value.replace(/&/g, "&amp;");
  }
  return value;
}

runTests();
