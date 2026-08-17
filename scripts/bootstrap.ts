/**
 * Shared script bootstrap: load .env.local then .env (Next.js precedence), and
 * give scripts a small set of console helpers.
 */

import { loadEnvFiles } from "./env-files";

const ROOT = process.cwd();
loadEnvFiles(ROOT);

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (text: string) => (useColour ? `[${code}m${text}[0m` : text);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

export function heading(text: string): void {
  console.log(`\n${c.bold(c.cyan(text))}`);
  console.log(c.dim("─".repeat(Math.max(text.length, 24))));
}

export function ok(text: string): void {
  console.log(`  ${c.green("✔")} ${text}`);
}

export function warn(text: string): void {
  console.log(`  ${c.yellow("!")} ${text}`);
}

export function fail(text: string): void {
  console.log(`  ${c.red("✘")} ${text}`);
}

export function info(text: string): void {
  console.log(`  ${c.dim("·")} ${c.dim(text)}`);
}

export { ROOT };
