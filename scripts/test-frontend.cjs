"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");
const { frontendPerformanceTestFiles, frontendTestArguments, frontendTestFiles } = require("./test-discovery.cjs");

const root = path.resolve(__dirname, "..");
function run(files = frontendTestFiles()) {
  if (!files.length) throw new Error("no frontend CJS tests were found");
  const result = childProcess.spawnSync(process.execPath, frontendTestArguments(files), { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exitCode = result.status || 0;
}

if (require.main === module) {
  run();
  if (!process.exitCode) run(frontendPerformanceTestFiles());
}

module.exports = { frontendTestFiles, run };
