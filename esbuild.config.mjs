import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
const test = process.argv[2] === "test";

const entryPoints = test ? ["session-logic.ts"] : ["main.ts"];
const outfile = test ? "tests/session-logic-bundle.cjs" : "main.js";

const context = await esbuild.context({
  entryPoints,
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    ...builtins.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2018",
  platform: "node",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile,
  minify: prod,
});

if (prod || test) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
