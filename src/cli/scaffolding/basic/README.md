# Basic Workflow Starter

Starter dynamic workflow template featuring deterministic environment probing, a single typed inspector agent RPC, and artifact recording.

> Do not confuse this scaffold with the repo-root [`basic-workflow/`](../../../../basic-workflow/README.md) directory:
> that one is load-bearing — `tests/adversarial/mcp-server-stress.test.js` exercises
> `./basic-workflow/workflow.ts`, so deleting `basic-workflow/` breaks that adversarial suite.

## Run
```bash
workflow run workflow.ts --mock
workflow graph workflow.ts --format html --output dag.html
```
