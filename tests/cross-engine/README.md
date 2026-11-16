# Cross-engine benchmark (tests/cross-engine)

Measures the AI-Workflow facade engine against the official track on the same
mission file (`cross-benchmark-mission.facade.ts`). Results land in `results/`.

## Reproducing the official track

The official track probes the **official ZCode dynamic-workflow package**, which
is not part of this repository. Point the harness at a local checkout via the
`OFFICIAL_DWF` environment variable (the directory must contain
`apps/zcode-cli/packages/dynamic-workflow`):

```shell
export OFFICIAL_DWF=/path/to/official-zcode-checkout/apps/zcode-cli/packages/dynamic-workflow
node run-cross-official.mjs            # writes results/official-cross-benchmark.json
node run-cross-ours.mjs                # writes results/ours-cross-benchmark.json
```

`results/*.json` carry environment fields as `$OFFICIAL_DWF` /
`$AI_WORKFLOW_WORKSPACE` placeholders (Issue #48: committed absolute machine
paths were scrubbed). The measured numbers — compile times, per-run wallMs —
are untouched by the scrub.
