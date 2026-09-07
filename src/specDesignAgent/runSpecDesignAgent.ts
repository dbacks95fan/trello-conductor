// ABOUTME: Runs the Spec & Design Agent as a one-shot Docker container and captures its one JSON result.
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/** The bounded request the Spec & Design Agent consumes.
 *  Shape mirrors spec-design-agent/schemas/spec-request.schema.json. */
export interface SpecDesignRequest {
  runId: string;
  workItem: string;
  productId: string;
  intent: {
    repository: string;
    commit: string;
    path: string;
    frozenArtifactSha256: string;
    contentSha256: string;
  };
  target: {
    repository: string;
    baseCommit: string;
    branch: string;
    workspace: string;
  };
  approval: {
    readyForPlanning: boolean;
    approvedBy: string;
    approvedAt: string;
  };
}

export interface SpecDesignResult {
  exitCode: number | null;
  result: Record<string, unknown> | null;
  rawStdout: string;
  rawStderr: string;
  timedOut: boolean;
}

/** The mount point of the work-item workspace inside the container. The request's
 *  `target.workspace` must be this path, not the host path, because the agent
 *  resolves it from inside the container. */
export const CONTAINER_WORKSPACE = "/work";
const REQUEST_BASENAME = "spec-design-request.json";

export interface DockerRunSpec {
  docker: string[];
  image: string;
  hostWorkspace: string;
  provider: string;
  envFile?: string | null;
  containerName?: string;
  /** When set, git inside the container can authenticate to GitHub. */
  githubToken?: string;
}

/** Git refuses to operate on a bind-mounted repository whose owner differs from
 *  the container user ("detected dubious ownership"), which would stop the agent
 *  at its first workspace check. These env-only settings fix that without a
 *  writable HOME or rootfs, and supply a commit identity so the agent's artifact
 *  commit cannot fail for want of one. Any `-c` flag the agent passes wins over
 *  these, so they are a floor, not an override. */
const GIT_ENV: string[] = [
  "-e", "GIT_CONFIG_KEY_0=safe.directory",
  "-e", `GIT_CONFIG_VALUE_0=${CONTAINER_WORKSPACE}`,
  "-e", "GIT_CONFIG_KEY_1=user.email",
  "-e", "GIT_CONFIG_VALUE_1=agent@agentic-sdlc.local",
  "-e", "GIT_CONFIG_KEY_2=user.name",
  "-e", "GIT_CONFIG_VALUE_2=Spec and Design Agent",
];

/** Lets git in the container authenticate to GitHub. The helper resolves
 *  $GITHUB_TOKEN inside the container at call time, and the token itself is
 *  passed by environment pass-through (`-e GITHUB_TOKEN`, no `=value`) so it
 *  never appears in argv, in `docker inspect`, or in the process list. */
const GIT_CREDENTIAL_ENV: string[] = [
  "-e", "GIT_CONFIG_KEY_3=credential.helper",
  "-e", 'GIT_CONFIG_VALUE_3=!f(){ echo username=x-access-token; echo "password=$GITHUB_TOKEN"; };f',
  "-e", "GITHUB_TOKEN",
];

/** Builds the `docker run` argv up to and including the image. Mirrors the
 *  hardening in spec-design-agent/compose.yaml: read-only rootfs, tmpfs /tmp,
 *  dropped capabilities, no privilege escalation, workspace bind-mounted rw. */
export function buildDockerArgs(spec: DockerRunSpec): string[] {
  const args = [
    ...spec.docker.slice(1),
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${spec.hostWorkspace},target=${CONTAINER_WORKSPACE}`,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-e",
    "HOME=/tmp",
    "-e",
    `SPEC_AGENT_PROVIDER=${spec.provider}`,
    "-e",
    `GIT_CONFIG_COUNT=${spec.githubToken ? 4 : 3}`,
    ...GIT_ENV,
    ...(spec.githubToken ? GIT_CREDENTIAL_ENV : []),
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
  ];
  if (spec.envFile) args.push("--env-file", spec.envFile);
  if (spec.containerName) args.push("--name", spec.containerName);
  args.push(spec.image);
  return args;
}

/** Parses the single JSON result document the agent prints to stdout. Anything
 *  else (a crash, a stack trace) leaves `result` null with the raw streams kept. */
export function parseAgentResult(stdout: string, stderr: string, exitCode: number | null, timedOut = false): SpecDesignResult {
  let result: Record<string, unknown> | null = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // stdout was not the single JSON result document.
    }
  }
  return { exitCode, result, rawStdout: stdout, rawStderr: stderr, timedOut };
}

export interface RunSpecDesignAgentOptions {
  /** Absolute host path of the prepared workspace clone (bind-mounted at /work). */
  hostWorkspace: string;
  docker?: string[];
  image?: string;
  provider?: string;
  /** `null` omits `--env-file` entirely; omitted falls back to configuration. */
  envFile?: string | null;
  /** `null` withholds GitHub credentials; omitted falls back to configuration. */
  githubToken?: string | null;
  timeoutMs?: number;
}

export async function runSpecDesignAgent(
  request: SpecDesignRequest,
  options: RunSpecDesignAgentOptions,
): Promise<SpecDesignResult> {
  const docker = options.docker ?? [config.specDesignDockerBin];
  const image = options.image ?? config.specDesignImage;
  const provider = options.provider ?? config.specDesignProvider;
  const envFile = options.envFile === undefined ? config.specDesignRuntimeEnvFile : options.envFile;
  const githubToken = options.githubToken === undefined ? config.specDesignGithubToken : options.githubToken;
  const timeoutMs = options.timeoutMs ?? config.specDesignTimeoutMs;

  const requestHostPath = join(options.hostWorkspace, REQUEST_BASENAME);
  const requestContainerPath = `${CONTAINER_WORKSPACE}/${REQUEST_BASENAME}`;
  await writeFile(requestHostPath, JSON.stringify(request, null, 2), "utf8");

  const dockerArgs = buildDockerArgs({
    docker,
    image,
    hostWorkspace: options.hostWorkspace,
    provider,
    envFile,
    containerName: `spec-design-${request.runId}`,
    githubToken: githubToken || undefined,
  });
  const argv = [...dockerArgs, "spec", "--request", requestContainerPath];

  return new Promise((resolvePromise) => {
    // The token reaches the container by environment pass-through, never argv.
    const child = spawn(docker[0], argv, {
      env: githubToken ? { ...process.env, GITHUB_TOKEN: githubToken } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      spawn(docker[0], [...docker.slice(1), "kill", `spec-design-${request.runId}`], { stdio: "ignore" }).on("error", () => undefined);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    // A failed spawn emits both `error` and `close`; settle on whichever comes
    // first so the result cannot depend on which cleanup promise lands first.
    let settled = false;
    const settle = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrWithError = spawnError ? `${stderr}\n${String(spawnError)}` : stderr;
      // Remove the transient request before resolving so the workspace handed
      // to later stages carries only committed artifacts.
      void rm(requestHostPath, { force: true })
        .catch(() => undefined)
        .then(() => resolvePromise(parseAgentResult(stdout, stderrWithError, exitCode, timedOut)));
    };

    child.on("error", (err) => settle(null, err));
    child.on("close", (exitCode) => settle(exitCode));
  });
}
