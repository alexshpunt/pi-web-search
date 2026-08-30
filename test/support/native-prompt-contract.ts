import { expect } from "vitest";

const NEGATION_SOURCE = String.raw`(?:do\s+not|don't|must\s+not|mustn't|never|without|no|not|isn't|aren't|wasn't|weren't|can't|cannot|couldn't|shouldn't|wouldn't|won't)`;
const MISLEADING_NEGATION = /\b(?:(?:do not|don't|must not|never)\s+(?:avoid|omit|skip|exclude|refrain|fail)|(?:avoid|omit|skip|exclude|refrain)\b[^.;\n]{0,40}\bnot)\b/i;

const targets = {
  followUp: /\bfollow[- ]?up questions?\b/i,
  information: /\b(?:(?:ask(?:ing)?\s+for|request(?:ing)?|seek(?:ing)?)(?:\s+(?:any|more|additional))?\s+(?:information|details|input|context)|clarification|ask(?:ing)?\s+(?:the\s+)?(?:caller|user)\s+to\s+clarify)\b/i,
  commentary: /\b(?:meta[- ]?commentary|process commentary|progress updates?|(?:describe|describing|explain|explaining|mention|mentioning)\s+(?:what you are doing|the search(?: process)?|your process))\b/i,
  filler: /\b(?:conversational filler|filler|chit-?chat|pleasantries|small talk)\b/i,
} as const;

function clauses(text: string): string[] {
  return text.split(/[.!?;\n]+/).map((clause) => clause.trim()).filter(Boolean);
}

function negatesTarget(clause: string, target: RegExp, distance = 48): boolean {
  return new RegExp(String.raw`\b${NEGATION_SOURCE}\b[^.;\n]{0,${distance}}${target.source}`, "i").test(clause);
}

function hasPositiveClause(parts: readonly string[], subject: RegExp): boolean {
  return parts.some((clause) => subject.test(clause) && !negatesTarget(clause, subject));
}

function genuinelyForbids(clause: string, target: RegExp): boolean {
  if (!target.test(clause) || MISLEADING_NEGATION.test(clause)) return false;

  const explicitNo = new RegExp(String.raw`\b(?:no|without)\b[^.;\n]{0,100}${target.source}`, "i");
  const directNegation = new RegExp(String.raw`\b(?:do not|don't|must not|never)\b[^.;\n]{0,40}${target.source}`, "i");
  const negativeAction = new RegExp(
    String.raw`\b(?:do not|don't|must not|never)\s+(?:ask|include|add|provide|make|offer|request|seek|describe|explain|mention|give|write|use)\w*\b[^.;\n]{0,120}${target.source}`,
    "i",
  );
  const avoid = new RegExp(
    String.raw`\b(?:avoid|omit|skip|exclude)\s+(?:(?:asking|including|adding|providing|making|offering|requesting|seeking|describing|explaining|mentioning|giving|writing|using)\w*\s+)?[^.;\n]{0,100}${target.source}`,
    "i",
  );
  return explicitNo.test(clause) || directNegation.test(clause) || negativeAction.test(clause) || avoid.test(clause);
}

/** Returns each missing or contradictory part of the approved native-search prompt contract. */
export function nativePromptContractViolations(request: unknown, callerQuery: string): string[] {
  if (typeof request !== "string") return ["request must be a string"];

  const violations: string[] = [];
  if (!request.includes(callerQuery)) violations.push("caller query is missing");

  const instruction = request.replace(callerQuery, " ");
  const parts = clauses(instruction);
  if (!hasPositiveClause(parts, /\b(?:answer|respond|reply)\b/i)) violations.push("direct answer action is missing");
  if (!hasPositiveClause(parts, /\b(?:immediately|directly|now|right away)\b/i)) violations.push("immediacy is missing");
  if (!hasPositiveClause(parts, /\b(?:best|most useful)\b/i)) violations.push("best-answer quality is missing");
  if (!hasPositiveClause(parts, /\b(?:self[- ]contained|standalone|complete)\b/i)) violations.push("self-contained quality is missing");

  const citation = /\bcit(?:e|es|ed|ing|ation|ations)\b/i;
  const citationParts = parts.filter((clause) => citation.test(clause));
  const citationForbidden = citationParts.some((clause) => {
    const negatedCitation = negatesTarget(clause, citation, 100);
    const negatedPermission = new RegExp(
      String.raw`${citation.source}[^.;\n]{0,40}\b${NEGATION_SOURCE}\b[^.;\n]{0,40}\b(?:allowed|permitted|welcome|okay|ok|included|used|provided)\b`,
      "i",
    );
    return negatedCitation || negatedPermission.test(clause);
  });
  const citationAllowed = citationParts.some((clause) => {
    if (new RegExp(String.raw`${citation.source}[^.;\n]{0,40}\b${NEGATION_SOURCE}\b`, "i").test(clause)) return false;
    return /\b(?:cit(?:e|es|ed|ing|ation|ations)\b[^.;\n]{0,80}\b(?:allowed|permitted|welcome|okay|ok)|(?:may|can|include|use|provide)\b[^.;\n]{0,80}\bcit(?:e|es|ed|ing|ation|ations)\b)/i.test(clause);
  });
  if (citationForbidden || !citationAllowed) violations.push("citations must be positively allowed and not forbidden");

  for (const [name, target] of Object.entries(targets)) {
    if (!parts.some((clause) => genuinelyForbids(clause, target))) {
      violations.push(`${name} prohibition is missing`);
    }
  }
  return violations;
}

/** Asserts the approved semantic contract without requiring one exact prompt sentence. */
export function expectNativePromptContract(request: unknown, callerQuery: string, soft = false): void {
  const assertion = soft ? expect.soft(nativePromptContractViolations(request, callerQuery)) : expect(nativePromptContractViolations(request, callerQuery));
  assertion.toEqual([]);
}
