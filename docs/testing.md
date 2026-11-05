# Testing tiers — what runs, where, and who enforces that it runs

Filed as [#78](https://github.com/lalanikarim/engram/issues/78) after finding that **213 assertions across nine
test files were executing in no CI job** — and every one of them passing. Nothing was broken; collection was the
defect. This page exists so it stays collected.

## The tiers

| Script | Suites | Checks (measured 2026-11-05) | Needs | Who runs it |
|---|---|---|---|---|
| `npm run test:unit` | model-catalog, gates, gates-prose-args, approval-rules, config, sandbox-containment, root-agent-reapply, gates-docs-verification, classifier, **script-coverage** | 171 + 5 meta | nothing — no model, no network, no container runtime | **CI** (the required `unit-suite` check) and the pre-push habit |
| `npm run test:live:model` | core-instance, scheduler, classifier-live, api, telegram | 151 | live model endpoint (`poc/.env`) | locally; nightly candidate |
| `npm run test:live:sandbox` | sandbox, hardening | 29 | live model + **Podman** machine + sandbox image | locally |
| `npm run test:live:webui` | webui | 20 | live model + Chromium (from the headless-browser-checker skill path) | locally |
| `npm run test:all` | everything above, in order | ~235 | all of it | before cutting a release tag, on a host that has the endpoint |

**The whole live battery costs about four minutes on a machine with inference local** (api 2 min, hardening 78 s,
sandbox 60 s, webui 24 s, telegram 19 s, core-instance 4 s, scheduler 9 s, classifier-live 13 s). That number is
the reason "too slow" was never the excuse for not running them.

Live suites are manual for one reason only: **GitHub-hosted runners have no model endpoint, no Podman and no
Chromium.** Not because they matter less — `sandbox.test.ts` and `hardening.test.ts` cover exactly the containment
surface the factory's safety story rests on.

## Adding a test file (the rule that makes this page true)

Every `app/test/*.test.ts` must be either **collected by a CI-reachable script** or carry a marker naming why it
can't be:

```ts
// manual-only: needs Podman + the sandbox image and the live model endpoint; run with npm run test:live:sandbox
```

`app/test/script-coverage.test.ts` enforces this in CI, and **reachable is not the same as mentioned** — it parses
the commands `ci.yml` actually runs, expands the npm script graph from those entry points, and only then asks what
covers each file. Four rules, all demonstrated failing before they were trusted:

| the check fails when | why that shape |
|---|---|
| a file is collected by nothing CI runs | the plain regression: a test that looks maintained and executes nowhere (R10 in drydock; PR #77's `gates-docs-verification.test.ts` here) |
| a file is referenced **only** by a script CI never invokes — e.g. `app/package.json`'s old `test` | this was the actual state of #78: four live suites "wired" into an entry point no job or root script ever called |
| a marker names a script that doesn't exist, or a file is both collected and marked | markers rot; a stale marker hides a suite that stopped being manual |
| `ci.yml` stops running `npm run test:unit`, or the check's own non-vacuity floor trips | branch protection requires the `unit-suite` context; a required check no workflow produces sits "Expected — waiting" forever (#70). The non-vacuity assertions catch the nastier silent case: a parser that collects nothing and passes everything |

## If a suite fails

Fix it, or say why in the PR and leave it failing loudly. **Do not delete it, skip it, or add `|| true`** to get
green — a suite that cannot exit non-zero is not a gate, and this repository has already shipped one green "fix"
that consisted of a test nobody ran.

## Related

`docs/gates.md` (what the gate layers do — the thing containment suites protect) · README §Testing (the short
version) · drydock `research/work-queue.md` rank 1 for the discovery trail.
