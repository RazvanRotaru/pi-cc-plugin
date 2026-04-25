// gitignore.mjs — ensure `.pi-cc-plugin/` is git-ignored if the workspace is
// a git repo. No-op outside a repo. Idempotent.

import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ENTRY = ".pi-cc-plugin/";
const HEADER = "# Added by pi-cc-plugin — local state, do not commit";

/**
 * @param {string} cwd
 * @returns {Promise<{updated: boolean, reason: string}>}
 */
export async function ensureGitignored(cwd) {
  try {
    await access(resolve(cwd, ".git"));
  } catch {
    return { updated: false, reason: "not a git repo" };
  }

  const gitignorePath = resolve(cwd, ".gitignore");
  let body = "";
  try {
    body = await readFile(gitignorePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const lines = body.split(/\r?\n/);
  const present = lines.some((line) => line.trim() === ENTRY || line.trim() === ".pi-cc-plugin");
  if (present) return { updated: false, reason: "already ignored" };

  const sep = body.length === 0 || body.endsWith("\n") ? "" : "\n";
  const addition = `${sep}${body.length === 0 ? "" : "\n"}${HEADER}\n${ENTRY}\n`;
  await writeFile(gitignorePath, body + addition, "utf8");
  return { updated: true, reason: "added .pi-cc-plugin/ to .gitignore" };
}
