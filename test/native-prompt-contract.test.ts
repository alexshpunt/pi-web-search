import { describe, expect, it } from "vitest";

import { nativePromptContractViolations } from "./support/native-prompt-contract.js";

const query = "native semantic contract";

const approvedPrompt = (rules: string): string => `${rules}\n\nQuery: ${query}`;

const validPrompts = [
  approvedPrompt([
    "Answer immediately with the best self-contained response.",
    "You may include citations when useful.",
    "Do not ask follow-up questions or ask for more information.",
    "Do not describe what you are doing or add meta-commentary.",
    "Do not add conversational filler.",
  ].join("\n")),
  approvedPrompt([
    "Reply now with the most useful standalone response.",
    "Citations are permitted.",
    "Avoid asking follow-up questions and requesting additional details.",
    "No process commentary or progress updates.",
    "Write without chit-chat or pleasantries.",
  ].join("\n")),
  approvedPrompt([
    "Respond directly with a complete, most useful answer.",
    "Use citations when available.",
    "Never ask follow-up questions; never seek more context.",
    "Omit meta commentary about the search process.",
    "Exclude small talk.",
  ].join("\n")),
];

describe("native prompt semantic contract", () => {
  it.each(validPrompts)("accepts meaningful alternate approved wording", (prompt) => {
    expect(nativePromptContractViolations(prompt, query)).toEqual([]);
  });

  it.each([
    ["forbidden citations", "You may include citations when useful.", "Do not include citations.", "citations must be positively allowed and not forbidden"],
    ["double-negative follow-ups", "Do not ask follow-up questions or ask for more information.", "Do not avoid asking follow-up questions; do not ask for more information.", "followUp prohibition is missing"],
    ["double-negative information requests", "Do not ask follow-up questions or ask for more information.", "Do not ask follow-up questions; never refrain from requesting more information.", "information prohibition is missing"],
    ["double-negative process commentary", "Do not describe what you are doing or add meta-commentary.", "Do not omit describing what you are doing.", "commentary prohibition is missing"],
    ["double-negative filler", "Do not add conversational filler.", "Avoid not adding conversational filler.", "filler prohibition is missing"],
  ])("rejects misleading invalid wording: %s", (_name, approved, replacement, expectedViolation) => {
    const prompt = validPrompts[0]!.replace(approved, replacement);
    expect(nativePromptContractViolations(prompt, query)).toContain(expectedViolation);
  });

  it.each([
    ["ordinary not citation permission", "You may include citations when useful.", "Citations are not allowed.", "citations must be positively allowed and not forbidden"],
    ["contracted citation permission", "You may include citations when useful.", "Citations aren't permitted.", "citations must be positively allowed and not forbidden"],
    ["negated self-contained answer", "Answer immediately with the best self-contained response.", "Answer immediately with the best response, but it must not be self-contained.", "self-contained quality is missing"],
    ["negated standalone answer", "Answer immediately with the best self-contained response.", "Reply now with the most useful response, but it isn't standalone.", "self-contained quality is missing"],
    ["negated complete answer", "Answer immediately with the best self-contained response.", "Respond directly with the best answer, but it isn't complete.", "self-contained quality is missing"],
  ])("rejects ordinary negative polarity: %s", (_name, approved, replacement, expectedViolation) => {
    const prompt = validPrompts[0]!.replace(approved, replacement);
    expect(nativePromptContractViolations(prompt, query)).toContain(expectedViolation);
  });
});
