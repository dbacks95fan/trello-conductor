# Project journal

## 2026-09-04

The evaluator handoff is being changed from a local filesystem dependency to an immutable Git-revision handoff. The work is constrained to the orchestrator and evaluator repositories; the Coding Agent and MealFlow repositories remain untouched.

The host Node 24 test runner cannot start `tsx` because `uv_os_get_passwd` returns an ENOMEM error. The same suites run successfully in the Dockerized Node 20 runtime used by the evaluator.
