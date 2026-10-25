#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const inputVersionExpression = "${{ inputs.version }}";
const packedTarballExpression = "${{ steps.package.outputs.tarball }}";
const exploitPayload = '0.13.0$(printf exploited > "$INJECTION_SENTINEL")';

const requiredRepairedSteps = [
  "Validate release version",
  "Set release version",
  "Check generated plugin manifests and launch config",
  "Pack the release tarball",
  "Check packed contents",
  "Summarize packed artifact",
];

const validVersions = [
  "0.13.0",
  "0.0.0",
  "1.2.3-rc.1",
  "1.2.3-alpha.01a+001.build-7",
  "1.2.3+001",
  "1.2.3--",
];

const validatorOnlyValidVersions = [
  {
    id: "validator-huge-core",
    version: "9007199254740992.0.0",
    reason: "A core numeric identifier larger than JavaScript's safe integer range remains valid SemVer.",
  },
  {
    id: "validator-long-version",
    version: `1.2.3-${"a".repeat(300)}`,
    reason: "A valid SemVer longer than 256 characters remains valid.",
  },
];

const rejectedVersions = [
  { id: "reject-missing", version: undefined },
  { id: "reject-empty", version: "" },
  { id: "reject-prefixed-v", version: "v1.2.3" },
  { id: "reject-leading-zero", version: "01.2.3" },
  { id: "reject-prerelease-leading-zero", version: "1.2.3-01" },
  { id: "reject-dangling-prerelease", version: "1.2.3-" },
  { id: "reject-dangling-build", version: "1.2.3+" },
  { id: "reject-empty-prerelease-identifier", version: "1.2.3-alpha..1" },
  { id: "reject-empty-build-identifier", version: "1.2.3+build..1" },
  { id: "reject-leading-whitespace", version: " 1.2.3" },
  { id: "reject-trailing-whitespace", version: "1.2.3 " },
  { id: "reject-trailing-lf", version: "1.2.3\n" },
  { id: "reject-trailing-crlf", version: "1.2.3\r\n" },
  { id: "reject-trailing-line-separator", version: "1.2.3\u2028" },
];

const plannedCaseIds = [
  ...validVersions.map((version) => `valid-${slug(version)}`),
  ...validatorOnlyValidVersions.map(({ id }) => id),
  ...rejectedVersions.map(({ id }) => id),
  "old-github-substitution-injection",
  "repaired-validator-rejects-injection",
  "payload-bypass-set-release-version",
  "payload-bypass-generated-manifest-check",
  "payload-bypass-packed-content-check",
  "payload-bypass-summary",
];

function slug(value) {
  return value
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function firstNonEmptyLine(script) {
  return script.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}

function serializableError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function escapeForDoubleQuotedShell(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")
    .replaceAll('"', '\\"');
}

function pathIsWithin(parent, candidate, { allowEqual = false } = {}) {
  const relative = path.relative(parent, candidate);
  return (
    (allowEqual && relative === "") ||
    (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function isRegularFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeText(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function writeJson(target, value) {
  await writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

function parseWorkflow(raw, sourceName) {
  const parsed = Bun.YAML.parse(raw);
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${sourceName} did not parse as a YAML object`);
  assert(parsed.jobs && typeof parsed.jobs === "object", `${sourceName} has no jobs object`);
  assert(parsed.jobs.pack && typeof parsed.jobs.pack === "object", `${sourceName} has no pack job`);
  assert(Array.isArray(parsed.jobs.pack.steps), `${sourceName} pack job has no steps array`);
  return parsed;
}

function findStep(workflow, name, sourceName) {
  const matches = workflow.jobs.pack.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step && typeof step === "object" && step.name === name);
  assert(matches.length === 1, `${sourceName} must contain exactly one ${name} step`);
  const { step, index } = matches[0];
  assert(typeof step.run === "string", `${sourceName} ${name} step must have a string run value`);
  if (step["working-directory"] !== undefined) {
    assert(typeof step["working-directory"] === "string", `${sourceName} ${name} working-directory must be a string`);
  }
  return {
    name,
    index,
    run: step.run,
    workingDirectory: step["working-directory"] ?? null,
  };
}

function collectRunValues(value, location = "workflow", found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectRunValues(entry, `${location}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    const nextLocation = `${location}.${key}`;
    if (key === "run" && typeof entry === "string") {
      found.push({ location: nextLocation, run: entry, hash: sha256(entry) });
    }
    collectRunValues(entry, nextLocation, found);
  }
  return found;
}

function workflowStructuralFailures(repaired, repairedSteps, allRunValues) {
  const failures = [];
  const pack = repaired.jobs.pack;
  if (pack.env?.RELEASE_VERSION !== inputVersionExpression) {
    failures.push("jobs.pack.env.RELEASE_VERSION must be the dispatch input expression exactly");
  }

  const setupNodeIndex = pack.steps.findIndex(
    (step) => step && typeof step === "object" && typeof step.uses === "string" && step.uses === "actions/setup-node@v4",
  );
  if (setupNodeIndex < 0) {
    failures.push("pack has no actions/setup-node@v4 step");
  } else if (pack.steps[setupNodeIndex + 1]?.name !== "Validate release version") {
    failures.push("Validate release version must immediately follow actions/setup-node@v4");
  }

  for (const stepName of [
    "Validate release version",
    "Set release version",
    "Check generated plugin manifests and launch config",
    "Check packed contents",
    "Summarize packed artifact",
  ]) {
    const step = repairedSteps.get(stepName);
    if (!step || firstNonEmptyLine(step.run) !== "set -euo pipefail") {
      failures.push(`${stepName} must start with set -euo pipefail`);
    }
  }

  const unsafeRunValues = allRunValues.filter(({ run }) => run.includes(inputVersionExpression));
  if (unsafeRunValues.length > 0) {
    failures.push(
      `dispatch input expression remains in run values: ${unsafeRunValues.map(({ location }) => location).join(", ")}`,
    );
  }
  return failures;
}

async function createEvidenceDirectory(argument) {
  const evidence = path.resolve(argument);
  assert(!(await pathExists(evidence)), `evidence directory already exists and will not be overwritten: ${evidence}`);
  const parent = path.dirname(evidence);
  const parentStats = await stat(parent);
  assert(parentStats.isDirectory(), `evidence parent is not a directory: ${parent}`);
  await mkdir(evidence);
  return evidence;
}

async function preserveSources(evidence, baseSource, repairedSource, baseText, repairedText, baseSteps, repairedSteps, allRunValues) {
  const baseWorkflowCopy = path.join(evidence, "sources", "base-workflow.yml");
  const repairedWorkflowCopy = path.join(evidence, "sources", "repaired-workflow.yml");
  await writeText(baseWorkflowCopy, baseText);
  await writeText(repairedWorkflowCopy, repairedText);

  const sourceEntries = { base: {}, repaired: {}, allRepairedRunValues: [] };
  for (const [name, step] of baseSteps.entries()) {
    const file = path.join(evidence, "sources", "base", `${slug(name)}.sh`);
    await writeText(file, step.run);
    sourceEntries.base[name] = {
      hash: sha256(step.run),
      file: path.relative(evidence, file),
      workingDirectory: step.workingDirectory,
    };
  }
  for (const [name, step] of repairedSteps.entries()) {
    const file = path.join(evidence, "sources", "repaired", `${slug(name)}.sh`);
    await writeText(file, step.run);
    sourceEntries.repaired[name] = {
      hash: sha256(step.run),
      file: path.relative(evidence, file),
      workingDirectory: step.workingDirectory,
    };
  }
  for (const item of allRunValues) {
    const file = path.join(evidence, "sources", "repaired-run-values", `${String(sourceEntries.allRepairedRunValues.length + 1).padStart(3, "0")}.sh`);
    await writeText(file, item.run);
    sourceEntries.allRepairedRunValues.push({
      location: item.location,
      hash: item.hash,
      file: path.relative(evidence, file),
    });
  }

  return {
    base: { argument: baseSource, sha256: sha256(baseText), bytes: Buffer.byteLength(baseText) },
    repaired: { argument: repairedSource, sha256: sha256(repairedText), bytes: Buffer.byteLength(repairedText) },
    scripts: sourceEntries,
  };
}

async function createRuntime(caseDirectory) {
  const runtime = path.join(caseDirectory, "runtime");
  const home = path.join(runtime, "home");
  const tmp = path.join(runtime, "tmp");
  const runnerTemp = path.join(runtime, "runner-temp");
  const npmCache = path.join(runtime, "npm-cache");
  const npmPrefix = path.join(runtime, "npm-prefix");
  const npmrc = path.join(runtime, "npmrc");
  const globalNpmrc = path.join(runtime, "global-npmrc");
  const summary = path.join(runtime, "github-step-summary.md");
  const output = path.join(runtime, "github-output.txt");
  await Promise.all([home, tmp, runnerTemp, npmCache, npmPrefix].map((target) => mkdir(target, { recursive: true })));
  await writeText(
    npmrc,
    [
      "offline=true",
      "ignore-scripts=true",
      "audit=false",
      "fund=false",
      "update-notifier=false",
      "registry=http://127.0.0.1:9/",
      "",
    ].join("\n"),
  );
  await writeText(summary, "");
  await writeText(globalNpmrc, "");
  await writeText(output, "");
  return { runtime, home, tmp, runnerTemp, npmCache, npmPrefix, npmrc, globalNpmrc, summary, output };
}

function isolatedEnvironment(runtime, { releaseVersion, injectionSentinel } = {}) {
  const inheritedPath = process.env.PATH;
  assert(typeof inheritedPath === "string" && inheritedPath.length > 0, "PATH is required to use the pinned mise toolchain");
  const env = {
    PATH: inheritedPath,
    HOME: runtime.home,
    TMPDIR: runtime.tmp,
    RUNNER_TEMP: runtime.runnerTemp,
    GITHUB_STEP_SUMMARY: runtime.summary,
    GITHUB_OUTPUT: runtime.output,
    npm_config_cache: runtime.npmCache,
    npm_config_userconfig: runtime.npmrc,
    npm_config_globalconfig: runtime.globalNpmrc,
    npm_config_prefix: runtime.npmPrefix,
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_registry: "http://127.0.0.1:9/",
    NO_PROXY: "*",
    no_proxy: "*",
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    TZ: "UTC",
  };
  if (releaseVersion !== undefined) env.RELEASE_VERSION = releaseVersion;
  if (injectionSentinel !== undefined) env.INJECTION_SENTINEL = injectionSentinel;
  return env;
}

async function createFixture(caseDirectory, { initialVersion = "0.0.0" } = {}) {
  const root = path.join(caseDirectory, "workspace");
  const packageDirectory = path.join(root, "packages", "relic-mcp");
  await mkdir(packageDirectory, { recursive: true });

  const packageJson = {
    name: "relic-mcp",
    version: initialVersion,
    description: "Credential-free fixture for release version proof",
    license: "MIT",
    type: "module",
    main: "dist/relic-mcp.js",
    bin: { "relic-mcp": "dist/relic-mcp.js" },
    files: ["dist", "native", "prebuilds", "scripts", "README.md", ".claude-plugin", "skills", "mcp-servers.json"],
  };
  await writeJson(path.join(packageDirectory, "package.json"), packageJson);
  await writeText(path.join(packageDirectory, "README.md"), "# relic-mcp fixture\n");
  await writeText(path.join(packageDirectory, "dist", "relic-mcp.js"), "export {};\n");
  await writeText(path.join(packageDirectory, "dist", "native-secure-open.js"), "export {};\n");
  await writeText(path.join(packageDirectory, "dist", "native-secure-open.d.ts"), "export declare const fixture: true;\n");
  await writeText(path.join(packageDirectory, "native", "secure-open.c"), "/* fixture placeholder; never executed */\n");
  await writeText(path.join(packageDirectory, "native", "build.mjs"), "export {};\n");
  await writeText(path.join(packageDirectory, "scripts", "prove-packed-native.mjs"), "export {};\n");
  await writeText(path.join(packageDirectory, "skills", "relic", "SKILL.md"), "# Fixture skill\n");
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu"]) {
    await writeText(path.join(packageDirectory, "prebuilds", target, "secure_open.node"), `fixture native placeholder for ${target}\n`);
    await writeJson(path.join(packageDirectory, "prebuilds", target, "build-info.json"), { fixture: true, target });
  }
  await writeJson(path.join(caseDirectory, "fixture-provenance.json"), {
    packageName: "relic-mcp",
    dependencies: [],
    lifecycleScripts: [],
    nativePlaceholders: "present for packed-file assertions and never executed",
    network: "npm offline with an isolated loopback registry setting",
  });
  return { root, packageDirectory, packageJson: path.join(packageDirectory, "package.json") };
}

async function packageState(packageJson) {
  const raw = await readFile(packageJson, "utf8");
  const parsed = JSON.parse(raw);
  return {
    sha256: sha256(raw),
    bytes: Buffer.byteLength(raw),
    version: parsed.version,
    hasDevDependencies: Object.hasOwn(parsed, "devDependencies"),
  };
}

async function seedMatchingManifests(packageDirectory, version) {
  await writeJson(path.join(packageDirectory, ".claude-plugin", "plugin.json"), {
    version,
    mcpServers: "./mcp-servers.json",
  });
  await writeJson(path.join(packageDirectory, ".claude-plugin", "marketplace.json"), {
    metadata: { version },
    plugins: [{ version }],
  });
  await writeJson(path.join(packageDirectory, "mcp-servers.json"), {
    relic: {
      type: "stdio",
      command: "npx",
      args: ["-y", `relic-mcp@${version}`],
      env: { RELIC_CLIENT_NAME: `relic-plugin/${version}` },
    },
  });
}

async function manifestState(packageDirectory) {
  const plugin = await readJson(path.join(packageDirectory, ".claude-plugin", "plugin.json"));
  const market = await readJson(path.join(packageDirectory, ".claude-plugin", "marketplace.json"));
  const mcp = await readJson(path.join(packageDirectory, "mcp-servers.json"));
  return {
    pluginVersion: plugin.version,
    marketplacePluginVersion: market.plugins?.[0]?.version,
    marketplaceMetadataVersion: market.metadata?.version,
    mcpPackageArgument: mcp.relic?.args?.[1],
    mcpClientName: mcp.relic?.env?.RELIC_CLIENT_NAME,
  };
}

async function runCommand({ evidence, caseDirectory, label, command, cwd, env }) {
  const rawDirectory = path.join(caseDirectory, "raw");
  await mkdir(rawDirectory, { recursive: true });
  const fileStem = slug(label);
  const stdoutPath = path.join(rawDirectory, `${fileStem}.stdout`);
  const stderrPath = path.join(rawDirectory, `${fileStem}.stderr`);
  let subprocess;
  try {
    subprocess = Bun.spawn({ cmd: command, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const stderr = new TextEncoder().encode(`spawn failed: ${serializableError(error).message}\n`);
    await writeFile(stdoutPath, new Uint8Array());
    await writeFile(stderrPath, stderr);
    return {
      label,
      command: [...command],
      exitCode: null,
      signalCode: null,
      spawnError: serializableError(error),
      stdout: { file: path.relative(evidence, stdoutPath), sha256: sha256(new Uint8Array()), bytes: 0 },
      stderr: { file: path.relative(evidence, stderrPath), sha256: sha256(stderr), bytes: stderr.byteLength },
      stdoutText: "",
      stderrText: new TextDecoder().decode(stderr),
    };
  }

  const [exitCode, stdoutBuffer, stderrBuffer] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).arrayBuffer(),
    new Response(subprocess.stderr).arrayBuffer(),
  ]);
  const stdout = new Uint8Array(stdoutBuffer);
  const stderr = new Uint8Array(stderrBuffer);
  await writeFile(stdoutPath, stdout);
  await writeFile(stderrPath, stderr);
  return {
    label,
    command: [...command],
    exitCode,
    signalCode: subprocess.signalCode ?? null,
    stdout: { file: path.relative(evidence, stdoutPath), sha256: sha256(stdout), bytes: stdout.byteLength },
    stderr: { file: path.relative(evidence, stderrPath), sha256: sha256(stderr), bytes: stderr.byteLength },
    stdoutText: new TextDecoder().decode(stdout),
    stderrText: new TextDecoder().decode(stderr),
  };
}

function stepWorkingDirectory(fixture, step) {
  const cwd = path.resolve(fixture.root, step.workingDirectory ?? ".");
  assert(pathIsWithin(fixture.root, cwd, { allowEqual: true }), `${step.name} working directory escapes the fixture`);
  return cwd;
}

async function runWorkflowStep({ evidence, record, fixture, step, env, label = step.name, patchedScript = null }) {
  let script = step.run;
  if (patchedScript !== null) {
    script = patchedScript;
    const scriptFile = path.join(record.directory, "executed-scripts", `${slug(label)}.sh`);
    await writeText(scriptFile, script);
    record.transforms ??= [];
    record.transforms.push({
      step: step.name,
      file: path.relative(evidence, scriptFile),
      originalHash: sha256(step.run),
      executedHash: sha256(script),
    });
  }
  const result = await runCommand({
    evidence,
    caseDirectory: record.directory,
    label,
    command: ["bash", "-c", script],
    cwd: stepWorkingDirectory(fixture, step),
    env,
  });
  record.steps.push({
    ...result,
    command: ["bash", "-c", patchedScript === null ? `<sources:${step.name}>` : `<executed:${label}>`],
  });
  return result;
}

function requireExit(result, expected, context) {
  assert(result.exitCode === expected, `${context}: expected exit ${expected}, received ${String(result.exitCode)}`);
}

async function requireNoSentinel(sentinel, context) {
  assert(!(await pathExists(sentinel)), `${context}: shell payload created ${sentinel}`);
}

async function trustedTarballFromOutput(runtime) {
  const output = await readFile(runtime.output, "utf8");
  const matches = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("tarball="))
    .map((line) => line.slice("tarball=".length));
  assert(matches.length === 1, `Pack the release tarball must write exactly one tarball output, found ${matches.length}`);
  const tarball = path.resolve(matches[0]);
  assert(pathIsWithin(runtime.runnerTemp, tarball), "tarball output escaped the owned RUNNER_TEMP directory");
  assert(await isRegularFile(tarball), `trusted tarball does not exist: ${tarball}`);
  return tarball;
}

function patchPackedTarballReference(script, trustedTarball) {
  const occurrences = countOccurrences(script, packedTarballExpression);
  assert(occurrences === 1, `Check packed contents must contain exactly one tarball output expression, found ${occurrences}`);
  return script.replace(packedTarballExpression, escapeForDoubleQuotedShell(trustedTarball));
}

async function readSummary(runtime) {
  return readFile(runtime.summary, "utf8");
}

async function collectToolchain(evidence) {
  const directory = path.join(evidence, "provenance", "toolchain");
  const runtime = await createRuntime(directory);
  const env = isolatedEnvironment(runtime);
  const commands = [
    ["node", "--version"],
    ["npm", "--version"],
    ["bash", "--version"],
  ];
  const results = [];
  for (const command of commands) {
    const result = await runCommand({
      evidence,
      caseDirectory: directory,
      label: command.join("-"),
      command,
      cwd: directory,
      env,
    });
    results.push({
      ...result,
      command,
      stdoutText: undefined,
      stderrText: undefined,
    });
  }
  return { bunVersion: Bun.version, bunPath: process.execPath, commands: results };
}

async function executeCase(evidence, cases, id, version, body) {
  const directory = path.join(evidence, "cases", id);
  await mkdir(directory, { recursive: true });
  const record = {
    id,
    directory,
    versionProvided: version !== undefined,
    version: version ?? null,
    state: "running",
    steps: [],
    assertions: [],
    errors: [],
  };
  try {
    await body(record);
    record.state = "passed";
  } catch (error) {
    record.state = "failed";
    record.errors.push(serializableError(error));
  }
  const receipt = { ...record, directory: path.relative(evidence, directory) };
  await writeJson(path.join(directory, "receipt.json"), receipt);
  cases.push(receipt);
  return receipt;
}

async function runValidVersion(evidence, cases, steps, version) {
  return executeCase(evidence, cases, `valid-${slug(version)}`, version, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const env = isolatedEnvironment(runtime, { releaseVersion: version });
    const before = await packageState(fixture.packageJson);

    const validator = await runWorkflowStep({ evidence, record, fixture, step: steps.get("Validate release version"), env });
    requireExit(validator, 0, "validator");
    record.assertions.push("actual validator accepted the exact version string");

    const setVersion = await runWorkflowStep({ evidence, record, fixture, step: steps.get("Set release version"), env });
    requireExit(setVersion, 0, "Set release version");
    const afterSet = await packageState(fixture.packageJson);
    assert(afterSet.version === version, "Set release version altered the requested version string");
    assert(afterSet.hasDevDependencies === false, "Set release version did not remove fixture devDependencies consistently");
    record.assertions.push("release-copy package.json retains the exact requested string");

    await seedMatchingManifests(fixture.packageDirectory, version);
    const seededManifests = await manifestState(fixture.packageDirectory);
    assert(
      seededManifests.pluginVersion === version &&
        seededManifests.marketplacePluginVersion === version &&
        seededManifests.marketplaceMetadataVersion === version,
      "fixture manifests did not retain the exact requested version string",
    );
    const generated = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: steps.get("Check generated plugin manifests and launch config"),
      env,
    });
    requireExit(generated, 0, "generated manifest check");
    record.assertions.push("actual generated manifest check accepted exact package and manifest versions");

    const pack = await runWorkflowStep({ evidence, record, fixture, step: steps.get("Pack the release tarball"), env });
    requireExit(pack, 0, "Pack the release tarball");
    const tarball = await trustedTarballFromOutput(runtime);
    record.tarball = { file: path.relative(evidence, tarball), sha256: sha256(await readFile(tarball)), bytes: (await stat(tarball)).size };

    await writeText(runtime.summary, "");
    const packedContentsStep = steps.get("Check packed contents");
    const patchedPackedContents = patchPackedTarballReference(packedContentsStep.run, tarball);
    record.transforms = [
      {
        step: packedContentsStep.name,
        replacement: "trusted local tarball path",
        expression: packedTarballExpression,
        count: 1,
      },
    ];
    const packedContents = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: packedContentsStep,
      env,
      label: "Check packed contents with trusted local tarball",
      patchedScript: patchedPackedContents,
    });
    requireExit(packedContents, 0, "packed content check");
    record.assertions.push("actual packed content check installed the local tarball offline and accepted exact versions");

    const summary = await runWorkflowStep({ evidence, record, fixture, step: steps.get("Summarize packed artifact"), env });
    requireExit(summary, 0, "summary");
    const summaryText = await readSummary(runtime);
    assert(summaryText.startsWith(`### relic-mcp ${version}\n`), "summary heading did not retain the exact requested version string");
    assert(summaryText.includes("files: "), "summary did not include npm pack --dry-run metadata");
    record.summary = { file: path.relative(evidence, runtime.summary), sha256: sha256(summaryText), heading: `### relic-mcp ${version}` };
    record.states = { before, afterSet, seededManifests, afterAll: await packageState(fixture.packageJson) };
    assert(record.states.afterAll.version === version, "release-copy package version changed after the checks");
  });
}

async function runValidatorOnlyAcceptance(evidence, cases, validator, { id, version, reason }) {
  return executeCase(evidence, cases, id, version, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const before = await packageState(fixture.packageJson);
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: validator,
      env: isolatedEnvironment(runtime, { releaseVersion: version }),
    });
    requireExit(result, 0, reason);
    const after = await packageState(fixture.packageJson);
    assert(before.sha256 === after.sha256, "validator-only case changed the release-copy package");
    record.states = { before, after };
    record.assertions.push(reason);
  });
}

async function runRejectedVersion(evidence, cases, validator, { id, version }) {
  return executeCase(evidence, cases, id, version, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const before = await packageState(fixture.packageJson);
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: validator,
      env: isolatedEnvironment(runtime, { releaseVersion: version }),
    });
    assert(Number.isInteger(result.exitCode) && result.exitCode > 0, `${id}: validator did not reject with a real nonzero exit`);
    const after = await packageState(fixture.packageJson);
    assert(before.sha256 === after.sha256, `${id}: rejected input changed the release-copy package`);
    record.states = { before, after };
    record.consumerExecution = "not-run because the validator rejected this input";
    record.assertions.push("validator returned nonzero and package.json stayed byte-for-byte unchanged");
  });
}

async function runOldExploit(evidence, cases, baseSetReleaseVersion) {
  return executeCase(evidence, cases, "old-github-substitution-injection", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "old-injection-sentinel");
    const occurrences = countOccurrences(baseSetReleaseVersion.run, inputVersionExpression);
    assert(occurrences === 1, `base Set release version must contain exactly one dispatch input expression, found ${occurrences}`);
    const substituted = baseSetReleaseVersion.run.replace(inputVersionExpression, exploitPayload);
    const scriptFile = path.join(record.directory, "executed-scripts", "base-set-release-version-github-substituted.sh");
    await writeText(scriptFile, substituted);
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: baseSetReleaseVersion,
      env: isolatedEnvironment(runtime, { injectionSentinel: sentinel }),
      label: "base Set release version after GitHub substitution",
      patchedScript: substituted,
    });
    assert(await pathExists(sentinel), "base GitHub-style substitution did not create the required injection sentinel");
    record.states = {
      sentinel: { file: path.relative(evidence, sentinel), exists: true },
      releaseCopy: await packageState(fixture.packageJson),
    };
    record.assertions.push("literal payload was substituted into old shell source and created its owned sentinel");
    record.baseExitCodeMayBeZero = result.exitCode;
  });
}

async function runRepairedExploitRejection(evidence, cases, validator) {
  return executeCase(evidence, cases, "repaired-validator-rejects-injection", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "repaired-injection-sentinel");
    const before = await packageState(fixture.packageJson);
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: validator,
      env: isolatedEnvironment(runtime, { releaseVersion: exploitPayload, injectionSentinel: sentinel }),
    });
    assert(Number.isInteger(result.exitCode) && result.exitCode > 0, "repaired validator did not reject with a real nonzero exit");
    await requireNoSentinel(sentinel, "repaired validator");
    const after = await packageState(fixture.packageJson);
    assert(before.sha256 === after.sha256, "repaired validator changed package.json after rejecting the payload");
    record.states = { before, after, sentinel: { exists: false } };
    record.consumerExecution = "not-run because the repaired validator rejected the payload";
    record.assertions.push("payload stayed environment data, did not create a sentinel, and did not mutate package.json");
  });
}

async function runPayloadBypassSetVersion(evidence, cases, step) {
  return executeCase(evidence, cases, "payload-bypass-set-release-version", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory);
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "set-release-version-sentinel");
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step,
      env: isolatedEnvironment(runtime, { releaseVersion: exploitPayload, injectionSentinel: sentinel }),
    });
    await requireNoSentinel(sentinel, "Set release version with validator bypassed");
    record.states = { releaseCopy: await packageState(fixture.packageJson), sentinel: { exists: false } };
    record.consumerExitMayBeNonzero = result.exitCode;
    record.assertions.push("Set release version received the payload as environment data and did not execute it");
  });
}

async function runPayloadBypassGeneratedManifest(evidence, cases, step) {
  return executeCase(evidence, cases, "payload-bypass-generated-manifest-check", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory, { initialVersion: exploitPayload });
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "generated-manifest-sentinel");
    await seedMatchingManifests(fixture.packageDirectory, exploitPayload);
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step,
      env: isolatedEnvironment(runtime, { releaseVersion: exploitPayload, injectionSentinel: sentinel }),
    });
    await requireNoSentinel(sentinel, "generated manifest check with validator bypassed");
    record.states = { releaseCopy: await packageState(fixture.packageJson), manifests: await manifestState(fixture.packageDirectory), sentinel: { exists: false } };
    record.consumerExitMayBeNonzero = result.exitCode;
    record.assertions.push("generated manifest check received the payload as environment data and did not execute it");
  });
}

async function runPayloadBypassPackedContents(evidence, cases, packStep, packedContentsStep) {
  return executeCase(evidence, cases, "payload-bypass-packed-content-check", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory, { initialVersion: "0.13.0" });
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "packed-content-sentinel");
    const trustedVersion = "0.13.0";
    await seedMatchingManifests(fixture.packageDirectory, trustedVersion);
    const pack = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: packStep,
      env: isolatedEnvironment(runtime, { releaseVersion: trustedVersion }),
      label: "Pack local fixture tarball for payload bypass",
    });
    requireExit(pack, 0, "payload-bypass fixture pack");
    const tarball = await trustedTarballFromOutput(runtime);
    const patched = patchPackedTarballReference(packedContentsStep.run, tarball);
    record.transforms = [
      {
        step: packedContentsStep.name,
        replacement: "trusted local tarball path",
        expression: packedTarballExpression,
        count: 1,
      },
    ];
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step: packedContentsStep,
      env: isolatedEnvironment(runtime, { releaseVersion: exploitPayload, injectionSentinel: sentinel }),
      label: "Check packed contents with payload bypassed validator",
      patchedScript: patched,
    });
    await requireNoSentinel(sentinel, "packed content check with validator bypassed");
    record.states = { trustedTarball: path.relative(evidence, tarball), sentinel: { exists: false } };
    record.consumerExitMayBeNonzero = result.exitCode;
    record.assertions.push("packed content check received the payload as environment data and did not execute it");
  });
}

async function runPayloadBypassSummary(evidence, cases, step) {
  return executeCase(evidence, cases, "payload-bypass-summary", exploitPayload, async (record) => {
    const fixture = await createFixture(record.directory, { initialVersion: "0.13.0" });
    const runtime = await createRuntime(record.directory);
    const sentinel = path.join(record.directory, "summary-sentinel");
    const result = await runWorkflowStep({
      evidence,
      record,
      fixture,
      step,
      env: isolatedEnvironment(runtime, { releaseVersion: exploitPayload, injectionSentinel: sentinel }),
    });
    await requireNoSentinel(sentinel, "summary with validator bypassed");
    const summaryText = await readSummary(runtime);
    assert(summaryText.startsWith(`### relic-mcp ${exploitPayload}\n`), "summary did not preserve the literal payload as data");
    record.states = { summary: { file: path.relative(evidence, runtime.summary), sha256: sha256(summaryText) }, sentinel: { exists: false } };
    record.consumerExitMayBeNonzero = result.exitCode;
    record.assertions.push("summary printed the payload literally from environment data and did not execute it");
  });
}

function optionalGitSha(name) {
  const value = process.env[name];
  return typeof value === "string" && /^[0-9a-f]{7,64}$/iu.test(value) ? value : null;
}

async function main() {
  const args = process.argv.slice(2);
  assert(
    args.length === 3,
    "usage: mise exec node@24.15.0 -- bun runner.mjs <base-workflow.yml> <repaired-workflow.yml> <new-evidence-directory>",
  );
  const [baseArgument, repairedArgument, evidenceArgument] = args;
  const baseSource = path.resolve(baseArgument);
  const repairedSource = path.resolve(repairedArgument);
  assert(baseSource !== repairedSource, "base and repaired workflow arguments must be different files");
  assert(await isRegularFile(baseSource), `base workflow must be an existing file: ${baseSource}`);
  assert(await isRegularFile(repairedSource), `repaired workflow must be an existing file: ${repairedSource}`);

  const evidence = await createEvidenceDirectory(evidenceArgument);
  const cases = [];
  const globalFailures = [];
  let source = null;
  let structuralFailures = [];
  let toolchain = null;

  try {
    const [baseText, repairedText] = await Promise.all([readFile(baseSource, "utf8"), readFile(repairedSource, "utf8")]);
    const baseWorkflow = parseWorkflow(baseText, "base workflow");
    const repairedWorkflow = parseWorkflow(repairedText, "repaired workflow");

    const baseSteps = new Map([["Set release version", findStep(baseWorkflow, "Set release version", "base workflow")]]);
    const repairedSteps = new Map(
      requiredRepairedSteps.map((name) => [name, findStep(repairedWorkflow, name, "repaired workflow")]),
    );
    const allRunValues = collectRunValues(repairedWorkflow);
    source = await preserveSources(
      evidence,
      baseSource,
      repairedSource,
      baseText,
      repairedText,
      baseSteps,
      repairedSteps,
      allRunValues,
    );
    structuralFailures = workflowStructuralFailures(repairedWorkflow, repairedSteps, allRunValues);
    const packetManifest = {
      format: "otio-release-version-input-proof/v1",
      createdAt: new Date().toISOString(),
      source,
      suppliedGitShas: {
        base: optionalGitSha("BASE_GIT_SHA"),
        repaired: optionalGitSha("REPAIRED_GIT_SHA"),
      },
      plannedCaseIds,
      policy: {
        sourceReads: "only the two supplied workflow YAML files",
        fixture: "credential-free relic-mcp package with no dependencies or lifecycle scripts",
        npm: "offline with isolated HOME, cache, config, temp, and loopback registry setting",
        nativeContents: "placeholders are packed and checked but never executed",
      },
    };
    await writeJson(path.join(evidence, "packet-manifest.json"), packetManifest);

    if (structuralFailures.length > 0) {
      globalFailures.push(...structuralFailures);
    } else {
      toolchain = await collectToolchain(evidence);
      for (const version of validVersions) {
        await runValidVersion(evidence, cases, repairedSteps, version);
      }
      for (const validatorOnly of validatorOnlyValidVersions) {
        await runValidatorOnlyAcceptance(evidence, cases, repairedSteps.get("Validate release version"), validatorOnly);
      }
      for (const rejected of rejectedVersions) {
        await runRejectedVersion(evidence, cases, repairedSteps.get("Validate release version"), rejected);
      }
      await runOldExploit(evidence, cases, baseSteps.get("Set release version"));
      await runRepairedExploitRejection(evidence, cases, repairedSteps.get("Validate release version"));
      await runPayloadBypassSetVersion(evidence, cases, repairedSteps.get("Set release version"));
      await runPayloadBypassGeneratedManifest(evidence, cases, repairedSteps.get("Check generated plugin manifests and launch config"));
      await runPayloadBypassPackedContents(
        evidence,
        cases,
        repairedSteps.get("Pack the release tarball"),
        repairedSteps.get("Check packed contents"),
      );
      await runPayloadBypassSummary(evidence, cases, repairedSteps.get("Summarize packed artifact"));
    }
  } catch (error) {
    globalFailures.push(`fatal harness error: ${serializableError(error).message}`);
  }

  const observedCaseIds = new Set(cases.map(({ id }) => id));
  const missingCases = plannedCaseIds.filter((id) => !observedCaseIds.has(id));
  if (missingCases.length > 0) {
    globalFailures.push(`required cases were not run: ${missingCases.join(", ")}`);
  }
  const failedCases = cases.filter(({ state }) => state !== "passed").map(({ id }) => id);
  if (failedCases.length > 0) {
    globalFailures.push(`failed cases: ${failedCases.join(", ")}`);
  }

  const receipt = {
    format: "otio-release-version-input-proof/v1",
    finishedAt: new Date().toISOString(),
    success: globalFailures.length === 0,
    source,
    structuralFailures,
    toolchain,
    cases,
    missingCases,
    globalFailures,
  };
  await writeJson(path.join(evidence, "receipt.json"), receipt);
  console.log(JSON.stringify({ success: receipt.success, evidence, caseCount: cases.length, missingCases, globalFailures }, null, 2));
  if (!receipt.success) process.exitCode = 1;
}

await main();
