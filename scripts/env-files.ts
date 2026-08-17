/**
 * Loads `.env.local` then `.env` with Next.js precedence (first file to define a
 * key wins, and a real environment variable beats both).
 *
 * Next.js does this itself for `next dev` / `next build`, but scripts and tests
 * run under bare Node where nothing has loaded the files yet. Both entry points
 * import this so there is one definition of "which env files count".
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

let loaded = false;

export function loadEnvFiles(root: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  for (const file of [".env.local", ".env"]) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) dotenv.config({ path: full, override: false });
  }
}
