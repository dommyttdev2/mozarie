const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { frontendTestArguments, frontendTestFiles } = require("../scripts/test-discovery.cjs");
const frontend = require("../scripts/test-frontend.cjs");
const coverage = require("../scripts/coverage-js.cjs");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-discovery-"));
try {
  fs.mkdirSync(path.join(temporaryRoot, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, "test_root.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "test_second.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "deeper", "test_first.cjs"), "");
  fs.writeFileSync(path.join(temporaryRoot, "nested", "helper.cjs"), "");
  assert.deepEqual(frontendTestFiles(temporaryRoot), [
    "tests/nested/deeper/test_first.cjs",
    "tests/nested/test_second.cjs",
    "tests/test_root.cjs",
  ], "recursive discovery keeps every nested test in deterministic repository-relative order");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

assert.strictEqual(frontend.frontendTestFiles, frontendTestFiles, "the ordinary frontend runner uses the shared discovery policy");
assert.deepEqual(coverage.testFiles, frontend.frontendTestFiles(), "coverage runs exactly the frontend runner's deterministic test list");
assert.deepEqual(frontendTestArguments(["tests/nested/test_fixture.cjs"]), ["--test", "--test-reporter=./scripts/strict-tap-reporter.cjs", "--test-concurrency=4", "tests/nested/test_fixture.cjs"], "ordinary and coverage execution share the strict reporter and nested paths");
console.log("test_test_discovery: passed");
