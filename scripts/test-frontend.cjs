"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testDirectory = path.join(root, "tests");

function frontendTestFiles(directory = testDirectory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^test_.*\.cjs$/.test(entry.name))
    .map((entry) => path.join("tests", entry.name))
    .sort();
}

function run(files = frontendTestFiles()) {
  if (!files.length) throw new Error("no frontend CJS tests were found");
  const result = childProcess.spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...files], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
}

if (require.main === module) run();

module.exports = { frontendTestFiles, run };
