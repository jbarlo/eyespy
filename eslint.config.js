// @ts-check
import { builtinModules } from "node:module";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import mustUseResult from "./tools/eslint/must-use-result.js";
import functional from "eslint-plugin-functional";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Node built-ins core must not import (hosts implement core/src/ports/ instead). */
const NODE_MODULES = ["node:*", ...builtinModules, ...builtinModules.map((m) => `${m}/*`)];
/** Host globals core may use: the ones declared in core/src/globals.d.ts (present in Node, browsers and workers). */
const CORE_GLOBALS = [
  "setTimeout",
  "setInterval",
  "clearInterval",
  "performance",
  "crypto",
  "TextEncoder",
  "TextDecoder",
];
/** Every other DOM or Node global. core gets only the ECMAScript standard library plus CORE_GLOBALS. */
const HOST_GLOBALS = [...new Set([...Object.keys(globals.browser), ...Object.keys(globals.node)])].filter(
  (g) => !(g in globals.es2023) && !CORE_GLOBALS.includes(g),
);

/** The strict rules apply to module folders only; host code and core/src/compose.ts keep the base rules. */
const CORE_MODULES = [
  "storage",
  "video",
  "perception",
  "detections",
  "labelling",
  "render",
  "session",
  "api",
  "pixels",
  "ports",
  "invariant",
  "railway",
];
/** The CLI's module folders; main.ts is its composition root and keeps the base rules. */
const CLI_MODULES = ["locate", "serverproc", "rpc", "commands", "format"];
const CLI_MODULE_FILES = `cli/src/{${CLI_MODULES.join(",")}}/**`;
/** The CLI folders' Node adapters, which are edges. */
const CLI_ADAPTERS = "cli/src/*/node.ts";
const MODULE_FILES = [`core/src/{${CORE_MODULES.join(",")}}/**`, "web/src/{state,ui}/**", CLI_MODULE_FILES];
/** oplog casts open-shaped ops.jsonl lines after its field checks. The npz reader wraps fflate in try. */
const STORAGE_EDGES = "core/src/storage/internal/{oplog,npz.kernel}.ts";
/**
 * Edges inside the module folders meet untyped or throwing code, so they may use casts, `throw` and `try`. api/ throws
 * TRPCError because tRPC requires it, and invariant/ throws on broken invariants.
 */
const EDGE_FILES = ["core/src/api/**", STORAGE_EDGES, "core/src/invariant/**", CLI_ADAPTERS];
/**
 * Numeric kernels, typed-array loops inside pure functions, may use `let`, in-place writes, writes into caller-provided
 * buffers and `a[i]!`, so a loop allocates nothing per element. Name such a file `*.kernel.ts` under a module's
 * internal/.
 */
const KERNEL_FILES = ["core/src/pixels/**", "core/src/*/internal/**/*.kernel.ts"];
/** Encapsulated mutable state, such as caches (name them `*.cache.ts`) and the session's single-owner actor queue. */
const MUTABLE_FILES = [
  "core/src/*/internal/**/*.cache.ts",
  "core/src/session/actor.ts",
  "web/src/state/assets/**",
  "web/src/**/*.cache.ts",
  CLI_ADAPTERS,
];
/** The Stage's imperative canvas side, and its draw function, which writes 2D context properties. */
const CANVAS_FILES = ["web/src/ui/stage/draw.ts", "web/src/ui/stage/controller.ts"];
/** Nothing imports another module's internal/, whether as ../<mod>/internal/... or eyespy-core/<mod>/internal/... */
const INTERNAL_IMPORTS = {
  regex: "^(\\.\\./)+([^/]+/)*internal(/|$)|^eyespy-core/(.+/)?internal(/|$)",
  message: "internal/ is private to its module; import the module's index.ts or pure.ts.",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "models/**",
      "scratch/**",
      "result/**",
      ".claude/**",
      "**/.eyespy/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", ".dependency-cruiser.cjs", "server/scripts/*.mjs", "*/tsx.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // best-effort calls (localStorage, optional browser APIs) use `catch {}` on purpose
      "no-empty": ["error", { allowEmptyCatch: true }],
      // port implementations (Store, ClipSource, ...) are async by contract even when an adapter has nothing to await
      "@typescript-eslint/require-await": "off",
      // React ignores the promise an async JSX handler returns, and actions never reject (failures become notices)
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      // with verbatimModuleSyntax, `import { type X }` still emits `import {} from`, a runtime edge that depcruise
      // counts as type-only. Separate `import type` statements keep TypeScript and depcruise in agreement.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-restricted-imports": ["error", { patterns: [INTERNAL_IMPORTS] }],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] },
          ],
        },
      ],
    },
  },
  {
    files: ["server/**", "cli/**", "tools/**", "web/scripts/**", "core/test/**", "*.js", "web/vite.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node, ...globals.commonjs } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Validation scripts and e2e drivers compare loosely typed JSON (server replies, page.evaluate) field by field, so
  // they may use `any`.
  {
    files: ["server/scripts/**", "web/scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["web/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["web/src/ui/**", "web/src/main.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.flat["recommended-latest"].rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // core tests white-box module internals (kernel goldens)
  {
    files: ["core/test/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["core/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: NODE_MODULES, message: "core/ must not import Node modules; add a port in core/src/ports/." },
            INTERNAL_IMPORTS,
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...HOST_GLOBALS.map((name) => ({
          name,
          message: "core/ is host-independent: no DOM or Node globals; use a port.",
        })),
      ],
    },
  },
  {
    files: [CLI_MODULE_FILES],
    ignores: [CLI_ADAPTERS],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:fs", "node:fs/*", "node:child_process", "node:net", "node:os", "@trpc/*"],
              message: "Host access goes through the folder's ports.ts; the Node adapter is its node.ts.",
            },
            INTERNAL_IMPORTS,
          ],
        },
      ],
    },
  },
  {
    files: MODULE_FILES,
    plugins: { functional, eyespy: { rules: { "must-use-result": mustUseResult } } },
    rules: {
      "prefer-const": "error",
      "no-param-reassign": ["error", { props: true }],
      "functional/no-let": "error",
      "functional/immutable-data": ["error", { ignoreImmediateMutation: true, ignoreClasses: "fieldsOnly" }],
      "@typescript-eslint/prefer-readonly": "error",
      // zod parses unknown data at the edge, so a cast inside the domain hides a wrong type. `as const` stays allowed.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "eyespy/must-use-result": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement",
          message:
            "Return a Result (neverthrow) for expected failures; invariant()/at()/got() from core/src/invariant for bugs.",
        },
        {
          selector: "TryStatement",
          message:
            "No try/catch control flow in domain code: Result.fromThrowable / ResultAsync.fromPromise at the edge.",
        },
      ],
    },
  },
  {
    files: EDGE_FILES,
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "allow-as-parameter" },
      ],
      "no-restricted-syntax": "off",
    },
  },
  {
    files: KERNEL_FILES,
    rules: {
      "functional/no-let": "off",
      "functional/immutable-data": "off",
      "no-param-reassign": ["error", { props: false }],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: MUTABLE_FILES,
    rules: {
      "functional/no-let": "off",
      "functional/immutable-data": "off",
    },
  },
  // In components, React refs are the one allowed mutable value: `ref.current = x` and nothing else.
  {
    files: ["web/src/ui/**"],
    rules: {
      "functional/immutable-data": [
        "error",
        { ignoreImmediateMutation: true, ignoreClasses: "fieldsOnly", ignoreAccessorPattern: ["**.current"] },
      ],
    },
  },
  {
    files: CANVAS_FILES,
    rules: {
      "functional/no-let": "off",
      "functional/immutable-data": "off",
      "no-param-reassign": ["error", { props: false }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
