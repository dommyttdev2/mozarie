"use strict";

function unittestSkippedCount(output) {
  const summary = String(output || "").replace(/\r\n?/g, "\n").match(/^OK(?: \(skipped=(\d+)\))?$/m);
  if (!summary) throw new Error("backend unittest output has no successful summary");
  return Number(summary[1] || 0);
}

function assertNoSkippedUnittestTests(output, label = "backend tests") {
  const skipped = unittestSkippedCount(output);
  if (skipped) throw new Error(`${label} reported deferred tests (skipped=${skipped})`);
}

module.exports = { assertNoSkippedUnittestTests, unittestSkippedCount };
