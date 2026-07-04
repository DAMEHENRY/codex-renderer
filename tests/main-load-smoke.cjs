/**
 * Smoke test: verify the built main.js can be loaded without a real Obsidian
 * runtime. Catches ESM->CJS bundling issues like createRequire(undefined)
 * caused by import.meta.url being stripped from the CJS bundle.
 */
const Module = require("module");
const oldLoad = Module._load;

const obsidianStub = {
  Plugin: class Plugin {},
  PluginSettingTab: class PluginSettingTab {},
  ItemView: class ItemView {},
  Modal: class Modal {},
  Setting: class Setting {},
  Notice: class Notice {},
  TFile: class TFile {},
  MarkdownRenderer: { render: async () => {} },
  WorkspaceLeaf: class WorkspaceLeaf {},
};

Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return oldLoad.apply(this, arguments);
};

try {
  const mod = require("../main.js");
  console.log("PASS: main.js loaded successfully with obsidian stub");
  const keys = Object.keys(mod);
  console.log("  exports:", keys);
  if (!keys.includes("default")) {
    console.error("WARN: expected 'default' export (the plugin class)");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("FAIL: main.js crashed on load");
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
