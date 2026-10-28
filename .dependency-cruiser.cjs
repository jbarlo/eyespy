// @ts-check
/**
 * Module boundaries and import direction (`pnpm deps:check`). The surface rules match the folder shape
 * `core/src/<module>/{index,pure,ports}.ts + internal/**`, so they cover any module; the direction rules name modules
 * through DOMAIN and LEAVES. tsPreCompilationDeps makes type-only edges visible, and value rules exclude them with
 * dependencyTypesNot.
 */
const DOMAIN = ["storage", "video", "perception", "detections", "labelling", "render", "session"];
/** Value-importable from anywhere. */
const LEAVES = ["pixels", "ports", "invariant", "railway"];
const any = (/** @type {string[]} */ xs) => `(${xs.join("|")})`;
const DOMAIN_DIR = `^core/src/${any(DOMAIN)}/`;
const LEAF_DIR = `^core/src/${any(LEAVES)}/`;
/** Any module folder (domain, leaves, api). A flat file in core/src is not one. */
const MODULE_DIR = "^core/src/[^/]+/";
const PURE = "^core/src/[^/]+/pure\\.ts$";
/** A module's public files, which other modules and hosts may name. */
const PUBLIC_FILE = "^core/src/[^/]+/(index|pure|ports)\\.ts$";
/** The storage values hosts need to locate or create a session. */
const STORAGE_MARKER = "^core/src/storage/marker\\.ts$";
const TYPE_ONLY = ["type-only", "type-import"];
const HOSTS = "^(server/src|cli/src|web/src/engine)/";
const TESTS = "^core/test/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "The module graph is acyclic, type-only edges included.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "module-public-surface-only",
      severity: "error",
      comment:
        "Code reaches another module only through its index.ts, pure.ts or ports.ts. internal/ and any other file is " +
        "private to its module, except storage/marker.ts, which hosts may name.",
      from: { path: "^core/src/([^/]+)/" },
      to: { path: MODULE_DIR, pathNot: ["^core/src/$1/", PUBLIC_FILE, STORAGE_MARKER] },
    },
    {
      name: "outside-public-surface-only",
      severity: "error",
      comment:
        "Code outside the module folders (hosts, scripts) also uses only a module's public files. core/test may " +
        "white-box internals.",
      from: { pathNot: [MODULE_DIR, TESTS] },
      to: { path: MODULE_DIR, pathNot: [PUBLIC_FILE, STORAGE_MARKER] },
    },
    {
      name: "domain-values-only-from-leaves-and-pure",
      severity: "error",
      comment:
        "No module imports another module's runtime. Domain modules and api value-import only the leaves and " +
        "*/pure.ts. They type-import everything else and get instances through ports.",
      from: { path: `^core/src/(${[...DOMAIN, "api"].join("|")})/` },
      to: { path: "^core/src/", pathNot: ["^core/src/$1/", LEAF_DIR, PURE], dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "leaves-are-leaves",
      severity: "error",
      comment: "pixels, invariant and railway import nothing in core; ports may type-import pixels.",
      from: { path: "^core/src/(pixels|invariant|railway)/" },
      to: { path: "^core/src/", pathNot: "^core/src/$1/" },
    },
    {
      name: "ports-only-pixel-types",
      severity: "error",
      from: { path: "^core/src/ports/" },
      to: { path: "^core/src/", pathNot: ["^core/src/ports/", "^core/src/pixels/"] },
    },
    {
      name: "ports-are-types",
      severity: "error",
      from: { path: "^core/src/ports/" },
      to: { path: "^core/src/pixels/", dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "detections-pure",
      severity: "error",
      comment:
        "detections is pure, with no ports and no IO. It may type-import video and perception shapes, never storage, " +
        "session, api, labelling or render.",
      from: { path: "^core/src/detections/" },
      to: {
        path: ["^core/src/(ports|storage|session|api|labelling|render)/", "^core/src/detections/ports\\.ts$"],
      },
    },
    {
      name: "labelling-no-detections-values",
      severity: "error",
      comment: "labelling reaches detections only through its DetectionLookup port (compose plugs it in).",
      from: { path: "^core/src/labelling/" },
      to: { path: "^core/src/detections/", dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "data-shapes-belong-to-the-domain",
      severity: "error",
      comment:
        "Domain modules own the shapes their ports speak. storage type-imports them and maps them to bytes, so edges " +
        "go from storage to domain types, never from a domain module to storage.",
      from: { path: `^core/src/${any(DOMAIN.filter((m) => m !== "storage"))}/` },
      to: { path: "^core/src/storage/" },
    },
    {
      name: "storage-types-only-from-domain",
      severity: "error",
      from: { path: "^core/src/storage/" },
      to: { path: DOMAIN_DIR, pathNot: ["^core/src/storage/", PURE], dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "session-receives-modules",
      severity: "error",
      comment: "session gets module instances in SessionDeps.modules; it type-imports their index.",
      from: { path: "^core/src/session/" },
      to: {
        path: `^core/src/${any(DOMAIN.filter((m) => m !== "session"))}/index\\.ts$`,
        dependencyTypesNot: TYPE_ONLY,
      },
    },
    {
      name: "no-flat-core-files",
      severity: "error",
      comment:
        "core/src holds module folders plus compose.ts (the inner composition root) and globals.d.ts. New code goes " +
        "into a module.",
      from: { path: "^core/src/[^/]+\\.ts$", pathNot: "^core/src/(compose\\.ts|globals\\.d\\.ts)$" },
      to: {},
    },
    {
      name: "no-construct-outside-compose",
      severity: "error",
      comment: "Only core/src/compose.ts (and core/test) value-import a module's index.ts (its createX factory).",
      from: { pathNot: ["^core/src/compose\\.ts$", TESTS, DOMAIN_DIR, "^core/src/api/"] },
      to: { path: `^core/src/${any(DOMAIN)}/index\\.ts$`, dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "api-thin",
      severity: "error",
      comment: "api is the wire layer over session. It names only session's public files, plus leaves and */pure.ts.",
      from: { path: "^core/src/api/" },
      to: {
        path: [`^core/src/${any(DOMAIN.filter((m) => m !== "session"))}/`, "^core/src/compose\\.ts$"],
        pathNot: PURE,
      },
    },
    {
      name: "hosts-no-domain-values",
      severity: "error",
      comment:
        "Hosts (server, cli, web engine) value-import domain modules only for storage's marker helpers and */pure.ts.",
      from: { path: HOSTS },
      to: { path: DOMAIN_DIR, pathNot: [STORAGE_MARKER, PURE], dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "cli-core-values-only-pure",
      severity: "error",
      comment:
        "The CLI value-imports only */pure.ts and storage's marker. It needs no router at runtime, so it only " +
        "type-imports api, session and the rest.",
      from: { path: "^cli/src/" },
      to: { path: "^core/src/", pathNot: [PURE, STORAGE_MARKER], dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "cli-adapters-only-from-main",
      severity: "error",
      comment:
        "Only the composition root main.ts and the validation scripts, which reuse the socket transport, import the " +
        "CLI folders' Node adapters (*/node.ts).",
      from: { pathNot: ["^cli/src/main\\.ts$", "^server/scripts/"] },
      to: { path: "^cli/src/[^/]+/node\\.ts$" },
    },
    {
      name: "cli-leaf-folders",
      severity: "error",
      comment: "locate, serverproc and rpc import no other CLI folder. Their instances meet in main.ts.",
      from: { path: "^cli/src/(locate|serverproc|rpc)/" },
      to: { path: "^cli/src/", pathNot: "^cli/src/$1/" },
    },
    {
      name: "cli-commands-receive-instances",
      severity: "error",
      comment: "commands get the locator, server process and rpc through SessionDeps, and only name their types.",
      from: { path: "^cli/src/commands/" },
      to: { path: "^cli/src/(locate|serverproc|rpc|main)", dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "cli-format-pure",
      severity: "error",
      comment: "format turns values into strings. It type-imports the error shapes it words, never commands or main.",
      from: { path: "^cli/src/format/" },
      to: {
        path: "^cli/src/",
        pathNot: ["^cli/src/format/", "^cli/src/(locate|serverproc|rpc)/index\\.ts$"],
      },
    },
    {
      name: "cli-format-types-only",
      severity: "error",
      from: { path: "^cli/src/format/" },
      to: { path: "^cli/src/(locate|serverproc|rpc)/", dependencyTypesNot: TYPE_ONLY },
    },
    {
      name: "core-is-host-independent",
      severity: "error",
      from: { path: "^core/src/" },
      to: { path: "^(server|cli|web)/" },
    },
    {
      name: "web-ui-only-state",
      severity: "error",
      comment:
        "web/src/ui imports only web/src/state, core's */pure.ts, pixels and invariant. state re-exports the types ui needs.",
      from: { path: "^web/src/ui/" },
      to: {
        path: "^(web|core|cli|server)/",
        pathNot: ["^web/src/(ui|state)/", PURE, "^core/src/(pixels|invariant)/"],
      },
    },
    {
      name: "web-state-no-react",
      severity: "error",
      comment:
        "zustand stores work without React (automation, Stage subscriptions, node tests), so they import " +
        "zustand/vanilla only, never zustand's React entry, and never ui.",
      from: { path: "^web/src/state/" },
      to: {
        path: ["node_modules/(react|react-dom)/", "node_modules/zustand/esm/(index|react)\\.", "^web/src/ui/"],
      },
    },
    {
      name: "web-page-not-worker",
      severity: "error",
      comment:
        "Page code (state, ui, automation, main.tsx, browser.ts, debug, the engine's page side) never imports the " +
        "worker's adapters, so onnxruntime-web and mp4box stay out of the page bundle. client.ts reaches the worker " +
        "only through its `?worker` entry.",
      from: { path: "^web/src/", pathNot: ["^web/src/engine/worker/", "^web/src/engine/client\\.ts$"] },
      to: { path: "^web/src/engine/worker/" },
    },
    {
      name: "web-client-worker-entry-only",
      severity: "error",
      from: { path: "^web/src/engine/client\\.ts$" },
      to: { path: "^web/src/engine/worker/", pathNot: "^web/src/engine/worker/worker\\.ts$" },
    },
    {
      name: "web-worker-standalone",
      severity: "error",
      comment:
        "The worker side (engine/worker/) knows the page only through the message types (protocol.ts) and the model " +
        "manifest. It imports no state, ui, port or client.",
      from: { path: "^web/src/engine/worker/" },
      to: {
        path: "^web/src/",
        pathNot: ["^web/src/engine/worker/", "^web/src/protocol\\.ts$", "^web/src/engine/manifest\\.ts$"],
      },
    },
    {
      name: "web-state-engine-types-only",
      severity: "error",
      comment: "web/src/state names the engine's types only; the engine instance comes in through its ports.",
      from: { path: "^web/src/state/" },
      to: { path: "^web/src/engine/", dependencyTypesNot: TYPE_ONLY },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // repo-local build and data dirs only. npm packages stay in the graph (doNotFollow) so web-state-no-react can see
    // them.
    exclude: { path: ["^(web/dist|models|scratch|\\.claude)/", "\\.eyespy/"] },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    preserveSymlinks: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: ["^core/src/[^/]+/", "node_modules/(@[^/]+/[^/]+|[^/]+)"],
      },
    },
  },
};
