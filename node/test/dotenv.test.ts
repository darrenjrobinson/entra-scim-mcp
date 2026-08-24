import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs dev-script helper, no type declarations
import { loadDotEnv } from "../scripts/lib/dotenv.mjs";

const dirs: string[] = [];

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));
  dirs.push(dir);
  const file = join(dir, ".env");
  writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadDotEnv", () => {
  it("parses simple assignments and reports the keys applied", () => {
    const env: Record<string, string | undefined> = {};
    const applied = loadDotEnv(envFile("ENTRA_TENANT_ID=abc\nENTRA_CLIENT_ID=def\n"), env);
    expect(env).toEqual({ ENTRA_TENANT_ID: "abc", ENTRA_CLIENT_ID: "def" });
    expect(applied).toEqual(["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID"]);
  });

  it("ignores blank lines, comments and inline comments", () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(
      envFile("\n# a comment\n\nA=1 # trailing\n   # indented comment\nB=2\n"),
      env,
    );
    expect(env).toEqual({ A: "1", B: "2" });
  });

  it("never overwrites a value already present in the environment", () => {
    const env: Record<string, string | undefined> = { A: "from-shell" };
    const applied = loadDotEnv(envFile("A=from-file\nB=from-file\n"), env);
    expect(env.A).toBe("from-shell");
    expect(env.B).toBe("from-file");
    expect(applied).toEqual(["B"]);
  });

  it("treats a blank value as absent rather than setting an empty string", () => {
    const env: Record<string, string | undefined> = {};
    const applied = loadDotEnv(envFile("ENTRA_CLIENT_SECRET=\nA=1\n"), env);
    expect(env.ENTRA_CLIENT_SECRET).toBeUndefined();
    expect(applied).toEqual(["A"]);
  });

  it("strips matching quotes and unescapes only inside double quotes", () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(
      envFile(['D="line1\\nline2"', "S='raw\\nvalue'", 'E="  padded  "'].join("\n")),
      env,
    );
    expect(env.D).toBe("line1\nline2");
    expect(env.S).toBe("raw\\nvalue");
    expect(env.E).toBe("  padded  ");
  });

  it("keeps a '#' that is part of an unquoted value", () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(envFile("SECRET=abc#def~ghi\n"), env);
    expect(env.SECRET).toBe("abc#def~ghi");
  });

  it("tolerates a leading 'export '", () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(envFile("export ENTRA_CLIENT_SECRET=shh\n"), env);
    expect(env.ENTRA_CLIENT_SECRET).toBe("shh");
  });

  it("skips malformed lines instead of throwing", () => {
    const env: Record<string, string | undefined> = {};
    loadDotEnv(envFile("no-equals-sign\n=novalue\n9BAD=x\nOK=y\n"), env);
    expect(env).toEqual({ OK: "y" });
  });

  it("returns an empty list when the file does not exist", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadDotEnv(join(tmpdir(), "definitely-not-here", ".env"), env)).toEqual([]);
    expect(env).toEqual({});
  });
});
