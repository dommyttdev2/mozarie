const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function parseArguments(argv) {
  const [suite = "all", ...rest] = argv;
  let artifacts = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--artifacts" || !rest[index + 1]) throw new Error("usage: node scripts/test-quiet.cjs [backend|frontend|all] [--artifacts DIRECTORY]");
    artifacts = path.resolve(rest[index + 1]);
    index += 1;
  }
  if (!["backend", "frontend", "all"].includes(suite)) throw new Error("usage: node scripts/test-quiet.cjs [backend|frontend|all] [--artifacts DIRECTORY]");
  return { suite, artifacts };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, { cwd: root, env: options.env || process.env, shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ command, args, output, status: status ?? 1 }));
  });
}

function diagnostic(output) { return output.trim().split(/\r?\n/).slice(-60).join("\n"); }

async function requiredCommand(label, command, args, options) {
  const result = await runCommand(command, args, options);
  if (result.status === 0) return result.output;
  const error = new Error(`${label} failed (exit ${result.status})\n${diagnostic(result.output)}`);
  error.output = result.output;
  throw error;
}

function temporaryDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), "mozarie-test-")); }

function pythonExecutable() {
  if (process.env.MOZARIE_PYTHON) return process.env.MOZARIE_PYTHON;
  const virtualEnvironment = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
  return fs.existsSync(virtualEnvironment) ? virtualEnvironment : "python";
}

function backendEnvironment(temporaryRoot, coverageFile) {
  const env = { ...process.env, COVERAGE_FILE: coverageFile, PYTHONPYCACHEPREFIX: path.join(temporaryRoot, "pycache") };
  delete env.MOZARIE_PYTHON;
  delete env.MOZARIE_RUNTIME;
  return env;
}

function workspaceArtifacts(directory = root) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if ([".git", ".venv", "node_modules"].includes(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") found.push(path.relative(directory, child));
        else visit(child);
      } else if ([".coverage", "coverage.xml"].includes(entry.name) || /^\.http-coverage.*\.log$/.test(entry.name)) {
        found.push(path.relative(directory, child));
      }
    }
  };
  visit(directory);
  return found.sort();
}

function coverageRates(xml) {
  const coverage = xml.match(/<coverage\b[^>]*\bline-rate="([^"]+)"[^>]*\bbranch-rate="([^"]+)"/);
  if (!coverage) throw new Error("coverage XML is missing its summary");
  return { line: Number(coverage[1]) * 100, branch: Number(coverage[2]) * 100 };
}

function verifyBackendCoverage(xml) {
  const classes = new Map([...xml.matchAll(/<class\b([^>]*)>/g)].map((match) => {
    const attribute = (name) => match[1].match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
    return [attribute("filename")?.replaceAll("\\\\", "/"), [Number(attribute("line-rate")), Number(attribute("branch-rate"))]];
  }));
  const required = ["server.py", "updater.py", "setup_gpu_check.py"];
  const missing = required.filter((filename) => !classes.has(filename));
  const incomplete = [...classes].filter(([filename, rates]) => filename && (rates[0] !== 1 || rates[1] !== 1));
  if (missing.length || incomplete.length) throw new Error(`backend coverage below 100%: missing ${missing.join(", ") || "none"}; incomplete ${incomplete.map(([filename]) => filename).join(", ") || "none"}`);
}

function testCount(output) { return output.match(/Ran (\d+) tests? in/)?.[1] || output.match(/# tests (\d+)/)?.[1] || "?"; }

function artifactDirectory(temporaryRoot, artifacts, suite) {
  const directory = artifacts ? path.join(artifacts, suite) : path.join(temporaryRoot, suite);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

async function runBackend(temporaryRoot, artifacts) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "backend");
  const coverageFile = path.join(directory, ".coverage");
  const coverageXml = path.join(directory, "coverage.xml");
  const env = backendEnvironment(temporaryRoot, coverageFile);
  const python = pythonExecutable();
  const tests = await requiredCommand("backend tests", python, ["-m", "coverage", "run", "-m", "unittest", "discover", "-s", "tests", "-t", "."], { env });
  await requiredCommand("backend coverage", python, ["-m", "coverage", "report", "--fail-under=100"], { env });
  await requiredCommand("backend coverage XML", python, ["-m", "coverage", "xml", "-o", coverageXml], { env });
  const xml = fs.readFileSync(coverageXml, "utf8");
  const rates = coverageRates(xml);
  verifyBackendCoverage(xml);
  fs.rmSync(coverageFile, { force: true });
  return `backend: passed (${testCount(tests)} tests, line ${rates.line}%, branch ${rates.branch}%)`;
}

async function runFrontend(temporaryRoot, artifacts) {
  const directory = artifactDirectory(temporaryRoot, artifacts, "frontend");
  await requiredCommand("frontend syntax", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"], { env: process.env });
  const output = await requiredCommand("frontend coverage", process.execPath, [path.join("scripts", "coverage-js.cjs")], {
    env: { ...process.env, MOZARIE_JS_COVERAGE_DIR: directory },
  });
  if (!fs.existsSync(path.join(directory, "report", "coverage-final.json"))) throw new Error("frontend coverage JSON was not created");
  return `frontend: passed (${testCount(output)} tests, JavaScript 100%)`;
}

async function runSuites({ suite, artifacts }, dependencies = {}) {
  const makeTemporaryDirectory = dependencies.temporaryDirectory || temporaryDirectory;
  const removeDirectory = dependencies.removeDirectory || ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  const temporaryRoot = makeTemporaryDirectory();
  const beforeArtifacts = workspaceArtifacts(dependencies.workspaceDirectory || root);
  try {
    const summaries = [];
    if (suite === "backend" || suite === "all") summaries.push(await (dependencies.runBackend || runBackend)(temporaryRoot, artifacts));
    if (suite === "frontend" || suite === "all") summaries.push(await (dependencies.runFrontend || runFrontend)(temporaryRoot, artifacts));
    const afterArtifacts = workspaceArtifacts(dependencies.workspaceDirectory || root);
    const createdArtifacts = afterArtifacts.filter((artifact) => !beforeArtifacts.includes(artifact));
    if (createdArtifacts.length) throw new Error(`test runner created workspace artifacts: ${createdArtifacts.join(", ")}`);
    return summaries;
  } finally { removeDirectory(temporaryRoot); }
}

async function main(argv = process.argv.slice(2)) {
  const summaries = await runSuites(parseArguments(argv));
  for (const summary of summaries) console.log(summary);
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { artifactDirectory, backendEnvironment, coverageRates, diagnostic, parseArguments, requiredCommand, runCommand, runSuites, temporaryDirectory, testCount, verifyBackendCoverage, workspaceArtifacts };
