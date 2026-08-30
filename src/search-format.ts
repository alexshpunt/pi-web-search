import type { SearchDetails } from "./types.ts";

const namedHtmlEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  mdash: "—",
  nbsp: "\u00a0",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  trade: "™",
  gt: ">",
  lt: "<",
};

function isWhitespaceControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0b || codePoint === 0x0c || codePoint === 0x0d || codePoint === 0x85;
}

function isC0OrC1Control(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isUnsafeFormattingControl(codePoint: number): boolean {
  return codePoint === 0x061c || codePoint === 0x200e || codePoint === 0x200f || (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function sanitizePresentationControls(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (isC0OrC1Control(codePoint)) return isWhitespaceControl(codePoint) ? " " : "";
    return isUnsafeFormattingControl(codePoint) ? "" : character;
  }).join("");
}

/** Decodes safe scalar references and keeps invalid references as literal source text. */
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu, (entity, reference: string) => {
    if (reference.startsWith("#")) {
      const digits = reference.slice(1);
      const radix = digits.startsWith("x") || digits.startsWith("X") ? 16 : 10;
      const codePoint = Number.parseInt(radix === 16 ? digits.slice(1) : digits, radix);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity;
      if (codePoint >= 0xfdd0 && codePoint <= 0xfdef || (codePoint & 0xffff) >= 0xfffe) return entity;
      if (isC0OrC1Control(codePoint)) return isWhitespaceControl(codePoint) ? " " : "";
      if (isUnsafeFormattingControl(codePoint)) return "";
      return String.fromCodePoint(codePoint);
    }

    const name = reference.toLowerCase();
    return Object.hasOwn(namedHtmlEntities, name) ? namedHtmlEntities[name]! : entity;
  });
}

/** Converts provider markup and unsafe presentation controls into one plain-text excerpt. */
function plainSnippet(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/giu, (match) => match.slice(1, -1))
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+)/gmu, "")
    .replace(/^\s*(?:`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,}))\s*$/gmu, "")
    .replace(/[\\`*_~]/g, "")
    .replace(/[\[\]]/g, "")
    .replace(/\|/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, sanitizePresentationControls)
    .replace(/\s+/g, " ")
    .trim();
}

/** Renders the usable native answer and/or independently ranked external results. */
export function formatSearchText(details: SearchDetails): string {
  if (details.error) return details.error;

  const blocks: string[] = [];
  if (typeof details.answer === "string" && details.answer.trim().length > 0) blocks.push(details.answer);

  if (details.results.length > 0) {
    const lines: string[] = [];
    for (const [index, item] of details.results.entries()) {
      lines.push(
        `${index + 1}. ${sanitizePresentationControls(item.title)}`,
        `   ${sanitizePresentationControls(item.url)}`,
      );
      const snippet = typeof item.snippet === "string" ? plainSnippet(item.snippet) : "";
      if (snippet) lines.push(`   Excerpt: “${snippet}”`);
      if (item.sources?.length) {
        const sources = item.sources.map(sanitizePresentationControls).join(", ");
        lines.push(`   Sources: ${sources}`);
      }
    }
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
