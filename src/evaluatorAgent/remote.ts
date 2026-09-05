// ABOUTME: Sends immutable Git handoff metadata to the authenticated evaluator service.
export interface RemoteEvaluatorRequest {
  endpoint: string;
  token: string;
  repositoryUrl: string;
  revision: string;
  workItem: string;
  intentPath: string;
  contractPath: string;
  evidencePath: string;
}

export interface RemoteEvaluatorResult {
  exitCode: number;
  evaluation: Record<string, unknown> | null;
  rawOutput: string;
}

export type FetchRequest = typeof fetch;

// ABOUTME: Preserves the evaluator result shape used by Trello workflow handling.
export async function runRemoteEvaluator(
  request: RemoteEvaluatorRequest,
  requestFn: FetchRequest = fetch,
): Promise<RemoteEvaluatorResult> {
  const response = await requestFn(new Request(request.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repositoryUrl: request.repositoryUrl,
      revision: request.revision,
      workItem: request.workItem,
      intentPath: request.intentPath,
      contractPath: request.contractPath,
      evidencePath: request.evidencePath,
    }),
  }));
  const body = await response.text();
  if (!response.ok) throw new Error(`Remote evaluator request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { exitCode: 1, evaluation: null, rawOutput: body };
  }
  const evaluation = typeof parsed === "string" ? JSON.parse(parsed) as Record<string, unknown> : parsed as Record<string, unknown>;
  return { exitCode: 0, evaluation, rawOutput: body };
}
