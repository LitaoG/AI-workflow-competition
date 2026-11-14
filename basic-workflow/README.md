# Basic Workflow Starter

Starter dynamic workflow template featuring deterministic environment probing, a single typed inspector agent RPC, and artifact recording.

> This directory is load-bearing: `tests/adversarial/mcp-server-stress.test.js` exercises the MCP
> server against `./basic-workflow/workflow.ts` as its repository-root fixture — do not delete it.

## Run
```bash
workflow run workflow.ts --mock
workflow graph workflow.ts --format html --output dag.html
```
