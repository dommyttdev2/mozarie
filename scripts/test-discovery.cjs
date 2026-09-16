"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const testDirectory = path.join(root, "tests");

function frontendTestFiles(directory = testDirectory, prefix = "tests") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...frontendTestFiles(path.join(directory, entry.name), relativePath));
    else if (entry.isFile() && /^test_.*\.cjs$/.test(entry.name)) files.push(relativePath);
  }
  return files
    .filter((file) => file !== "tests/test_gallery_performance_e2e.cjs")
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function frontendPerformanceTestFiles() {
  const file = "tests/test_gallery_performance_e2e.cjs";
  if (!fs.existsSync(path.join(root, file))) throw new Error(`missing frontend performance test: ${file}`);
  return [file];
}

function frontendTestArguments(files = frontendTestFiles()) {
  return ["--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", "--test-concurrency=4", ...files];
}

module.exports = { frontendPerformanceTestFiles, frontendTestArguments, frontendTestFiles };
