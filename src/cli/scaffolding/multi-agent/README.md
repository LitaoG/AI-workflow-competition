# Multi-Agent Night Shift Triage & Sweep Workflow

Advanced dynamic workflow inspired by ZCode architecture:
- Multi-phase timeline DAG
- Parallel fan-out agent pool (`Promise.all`)
- Paired Fixer + Reviewer agents with critique loop
- Deterministic shell gates (`test-gate.cmd`)
- Merge coordinator agent

## Run
```bash
workflow run workflow.ts --mock
workflow graph workflow.ts --format html --output dag.html
```
