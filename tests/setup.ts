/**
 * Test bootstrap. Imported first by every test file so `.env.local` is in
 * `process.env` before any module that reads configuration is evaluated.
 *
 * This has to be its own module: ESM hoists all imports and evaluates them in
 * source order, so a plain `loadEnvFiles()` call in a test body would run *after*
 * `lib/db` had already been imported.
 */

import { loadEnvFiles } from "../scripts/env-files";

loadEnvFiles();
