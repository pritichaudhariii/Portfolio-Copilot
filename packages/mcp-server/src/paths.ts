import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Resolves package-relative paths. Works from both `src/` (tsx) and `dist/` (compiled)
 * because both sit one level below the package root.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(here, "..");
export const SEED_DIR = path.join(PACKAGE_ROOT, "data", "seed");
export const DEFAULT_DATA_DIR = path.join(PACKAGE_ROOT, "data", "runtime");
