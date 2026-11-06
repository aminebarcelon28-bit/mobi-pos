# Vendored agent skills (dev-only)

Rule for anything listed here (from `AGENTS.md` and the e2e skill): a skill is
**documentation for the agent**, never part of the release bundle, never a
runtime dependency, never a gate. Pinned commit, permissive licence, zero
runtime dependencies. Repo rules override any advice inside a skill — in
particular nothing here may add retries, weaken an assertion, or touch the
money path.

## Installed

| Skill | Repo | Pinned commit | Licence | Runtime deps | Purpose |
|---|---|---|---|---|---|
| `wdio-vendor` (`webdriverio-skill`) | `lambdatest/agent-skills` | `a7cdbf033ede0442d393a3a816507166dc196896` (2026-02-23) | MIT (see `LICENSE-lambdatest`) | none (Markdown only) | WebdriverIO v9 patterns for selectors/waits/debugging, used while hardening `e2e-tests/lib/pos.ts` (B1/B2). |

Install shape: `.opencode/skills/wdio-vendor/{SKILL.md, LICENSE-lambdatest,
reference/*.md}` — plain Markdown, no scripts, no package manifests.
Verified dev-only: it lives under `.opencode/`, which is not part of the Tauri
bundle (`src-tauri/tauri.conf.json` ships `dist`), and it is excluded from the
release artifact by construction.

## Evaluated and rejected

| Candidate | Licence | Why not |
|---|---|---|
| `fugazi/test-automation-skills-agents@webapp-selenium-testing` (MIT, 262★) | MIT | Ships `setup-maven-project.ps1` + `pom-template.xml`: a Maven/Selenium toolchain, not this WDIO/WebView2 harness. Adds runtime deps and no reusable knowledge. |
| `anthropics/skills` (188k★) | licence file not declared by the API | Its webapp-testing skill is Playwright/Python-based; Playwright is a runtime dependency and a second browser driver, which this repo does not use. |
| `webdriverio/webdriverio@wdio-v10-migration` | MIT | Migration guidance for WDIO v10; this harness is pinned to v9. Could mislead edits, no pinned benefit. |
| `naodeng/awesome-qa-skills` | NOASSERTION | Non-standard licence — excluded by the licence rule. |
| `klamping/webdriverio-skills` | MIT | 5★, unmaintained; the Lambdatest skill covers the same ground with a maintained, reviewed repo. |

## Maintenance

- Update only by bumping the pinned commit in this table and re-downloading the
  same file set; never `npx skills add` (that installs a moving `main`).
- Re-run `node .opencode/skills/e2e-testing/scripts/selftest.mjs` after any
  change here; the harness contract must stay green.
