import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

if (process.platform !== "darwin") {
  console.log("Skipping the native Continuity Camera helper build: macOS is required.");
  process.exit(0);
}

const nativeDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(nativeDirectory, "build", "CodexRendererContinuity.app");
const contentsDirectory = join(appDirectory, "Contents");
const executableDirectory = join(contentsDirectory, "MacOS");
const executablePath = join(executableDirectory, "CodexRendererContinuity");
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";

await mkdir(executableDirectory, { recursive: true });
await rm(join(contentsDirectory, "_CodeSignature"), { recursive: true, force: true });
await copyFile(join(nativeDirectory, "Info.plist"), join(contentsDirectory, "Info.plist"));
await writeFile(join(contentsDirectory, "PkgInfo"), "APPL????");

const moduleCache = await mkdtemp(join(tmpdir(), "codex-renderer-continuity-cache-"));
try {
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-parse-as-library",
    "-swift-version", "5",
    "-module-cache-path", moduleCache,
    "-target", `${architecture}-apple-macosx13.0`,
    "-framework", "AppKit",
    "-framework", "PDFKit",
    "-framework", "UniformTypeIdentifiers",
    join(nativeDirectory, "CodexRendererContinuity.swift"),
    "-o", executablePath
  ], { stdio: "inherit" });
} finally {
  await rm(moduleCache, { recursive: true, force: true });
}

console.log(`Built ${executablePath}`);
