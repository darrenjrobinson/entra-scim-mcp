// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "captures/**", "node_modules/**"],
  },

  js.configs.recommended,

  // Type-aware linting. The point of the exercise: strict mode catches type
  // errors, but only rules with a type checker behind them can see a promise
  // nobody awaited or a template literal quietly stringifying an object.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json is the wide one — it covers src, test, scripts and
        // the config files, so every linted file has a program behind it.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A floating promise in a request path is a dropped error, not a style
      // nit; the mock's router already carries a hand-written `void` guard
      // because there was nothing to enforce this.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // The SCIM layer reads untyped JSON by design. `unknown` is threaded
      // through deliberately and narrowed at each boundary, so the blanket
      // no-unsafe-* family reports the pattern rather than a defect.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // Non-null assertions are how this codebase reads regex capture groups,
      // which noUncheckedIndexedAccess otherwise types as possibly-undefined.
      "@typescript-eslint/no-non-null-assertion": "off",

      // Numbers in template literals are idiomatic and safe to stringify; the
      // rule's value is in catching an object or a nullable landing in one.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],

      // `async` with no `await` is a legitimate way to satisfy a
      // Promise-returning interface — TokenCredential.getToken, and every
      // fetch stub in the suite.
      "@typescript-eslint/require-await": "off",

      // `(resolve) => resolve()` is the standard Promise shorthand.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],

      // str.match() reads better than re.exec() and this codebase uses it
      // consistently; the difference is not a correctness one.
      "@typescript-eslint/prefer-regexp-exec": "off",

      // A deliberate no-op — an ignored rejection handler, a silenced writer.
      "@typescript-eslint/no-empty-function": "off",

      // `delete obj[path]` is what a SCIM PATCH remove operation *is*.
      "@typescript-eslint/no-dynamic-delete": "off",

      // `a?.trim() || fallback` is deliberate throughout the env-reading code:
      // an empty or whitespace-only variable must fall back, and `??` would
      // keep the empty string. `a || b` on two booleans is plain logical-or,
      // not a nullish fallback. The rule keeps its value for object operands.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, boolean: true } },
      ],

      // Leading-underscore names are the established convention for the
      // discarded half of a destructure (`const { password: _password, ...`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Boundary validators. Their parameters are typed for the caller's benefit,
  // but the values arrive as JSON — from an MCP client, an HTTP body, a seed
  // file — and are re-checked here on purpose. Rules that derive "this check
  // is redundant" from the declared type are therefore reading the wrong end
  // of the boundary: `op.op !== "add" && ...` is not dead code, it is the
  // check. Zod happens to cover the tool path today; these modules are
  // exported and must not depend on that staying true.
  {
    files: [
      "src/scim/patch.ts",
      "src/scim/filter.ts",
      "src/scim/client.ts",
      "src/mock/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
    },
  },

  // Tests reach for shapes the source never would.
  {
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Asserting on a method reference is how you check it was never called.
      "@typescript-eslint/unbound-method": "off",
      // A test simulating a transport that rejects with a non-Error.
      "@typescript-eslint/prefer-promise-reject-errors": "off",
    },
  },

  // Plain-JS helpers: no type information, so type-aware rules cannot run.
  {
    files: ["**/*.mjs", "**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },

  // Must stay last: turns off every rule Prettier owns.
  prettier,
);
