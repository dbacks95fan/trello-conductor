// ABOUTME: Test stand-in for the docker CLI: runs the Spec & Design Agent contract against the bind-mount source.
// ABOUTME: Behaviour is selected with FAKE_DOCKER_MODE (spec_ready | needs_decision | garbage | hang).
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const argv = process.argv.slice(2);
if (argv[0] !== "run") {
  // `docker kill <name>` on the timeout path — nothing to do.
  process.exit(0);
}

// Record the argv so tests can assert on the flags the orchestrator passed.
if (process.env.FAKE_DOCKER_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_DOCKER_ARGV_LOG, JSON.stringify(argv), "utf8");
}

const mount = argv[argv.indexOf("--mount") + 1] || "";
const source = (mount.match(/source=([^,]+)/) || [])[1];
const target = (mount.match(/target=([^,]+)/) || [])[1] || "/work";
if (!source) {
  process.stderr.write("fake-docker: no bind mount source\n");
  process.exit(125);
}

const containerRequest = argv[argv.indexOf("--request") + 1];
const hostRequest = path.join(source, containerRequest.slice(target.length + 1));
const request = JSON.parse(fs.readFileSync(hostRequest, "utf8"));

const mode = process.env.FAKE_DOCKER_MODE || "spec_ready";

if (mode === "hang") {
  setTimeout(() => process.exit(0), 60_000);
  return;
}

if (mode === "garbage") {
  process.stderr.write("Traceback (most recent call last):\n  RuntimeError: provider exploded\n");
  process.stdout.write("not a json result document");
  process.exit(30);
}

// The real agent verifies the frozen intent bytes before doing anything.
const intent = fs.readFileSync(path.join(source, ".agent", "work", request.workItem, "intent.md"));
const sha = crypto.createHash("sha256").update(intent).digest("hex");
const base = {
  runId: request.runId,
  workItem: request.workItem,
  status: "blocked",
  summary: "",
  branch: request.target.branch,
  workspace: request.target.workspace,
  intentCommit: request.intent.commit,
  frozenArtifactSha256: request.intent.frozenArtifactSha256,
  intentContentSha256: request.intent.contentSha256,
  blockingConcerns: [],
  nonBlockingConcerns: [],
  humanDecisions: [],
};

if (sha !== request.intent.frozenArtifactSha256) {
  process.stdout.write(JSON.stringify({ ...base, summary: "INTENT_MUTATED", blockingConcerns: ["INTENT_MUTATED"] }));
  process.exit(20);
}

if (mode === "needs_decision") {
  process.stdout.write(
    JSON.stringify({
      ...base,
      status: "needs_decision",
      summary: "A storage boundary decision is required.",
      humanDecisions: [
        {
          question: "Which service owns meal-plan persistence?",
          impact: "Determines the affected bounded context.",
          options: ["Reuse the recipe service", "Introduce a planner service"],
          minimumAuthority: "Product engineering lead",
        },
      ],
    }),
  );
  process.exit(10);
}

const specRelPath = path.posix.join(".agent", "work", request.workItem, "spec.md");
fs.writeFileSync(
  path.join(source, specRelPath),
  "# Requirements and Design Specification\n\n## Traceability to frozen intent\n",
);
const git = (args) =>
  cp.execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=Spec Agent", ...args], { cwd: source }).toString().trim();
git(["add", "--force", "--", specRelPath]);
git(["commit", "-m", `spec: ${request.workItem}`]);
const specCommit = git(["rev-parse", "HEAD"]);

process.stdout.write(
  JSON.stringify({
    ...base,
    status: "spec_ready",
    summary: "Specification produced from the frozen intent.",
    specCommit,
    specPath: specRelPath,
    specVersion: 1,
  }),
);
