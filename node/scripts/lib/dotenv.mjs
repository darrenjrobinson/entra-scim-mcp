import { readFileSync } from "node:fs";

/**
 * Minimal .env loader for the dev scripts in this directory.
 *
 * Deliberately not wired into src/: the published server reads process.env
 * only, so it can never pick up a stray .env from whatever directory an MCP
 * client happens to launch it in.
 *
 * @param {string} filePath path to the .env file; a missing file is not an error
 * @param {NodeJS.ProcessEnv} [env] target to mutate (defaults to process.env)
 * @returns {string[]} keys applied, in file order. Keys already present in env
 *   are skipped, and a blank value is treated as absent rather than set to "".
 */
export function loadDotEnv(filePath, env = process.env) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const applied = [];
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (!entry) continue;
    // A real shell env, or an MCP client's "env" block, always wins.
    if (env[entry.key] !== undefined) continue;
    // A blank value should behave exactly like an absent line.
    if (entry.value === "") continue;
    env[entry.key] = entry.value;
    applied.push(entry.key);
  }
  return applied;
}

/** @returns {{ key: string, value: string } | null} */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf("=");
  if (eq <= 0) return null;

  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  return { key, value: parseValue(body.slice(eq + 1).trim()) };
}

const ESCAPES = { n: "\n", r: "\r", t: "\t", "\\": "\\" };

function parseValue(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    // Escapes are honored inside double quotes only, matching dotenv.
    return raw.slice(1, -1).replace(/\\([nrt\\])/g, (_, c) => ESCAPES[c]);
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  // Unquoted: an inline " #" ends the value. Entra secrets never contain spaces.
  const comment = raw.indexOf(" #");
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}
