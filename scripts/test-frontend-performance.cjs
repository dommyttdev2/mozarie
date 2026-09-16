"use strict";

const { frontendPerformanceTestFiles } = require("./test-discovery.cjs");
const { run } = require("./test-frontend.cjs");

run(frontendPerformanceTestFiles());
