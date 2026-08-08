# GitHub Actions CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that runs `bun run check` on every pull request and every push to `master`.

**Architecture:** One workflow file with a single `check` job on `ubuntu-latest`. Install Bun, install deps from the lockfile, then run the existing local quality gate. No app code changes.

**Tech Stack:** GitHub Actions, `actions/checkout@v4`, `oven-sh/setup-bun@v2`, Bun, existing `package.json` scripts.

**Spec:** `docs/superpowers/specs/2026-08-08-github-actions-ci-design.md`

## Global Constraints

- Workflow path must be `.github/workflows/ci.yml`
- Triggers: `pull_request` (all branches) and `push` to `master` only
- Single job named `check` on `ubuntu-latest`
- Steps must use frozen lockfile install and `bun run check`
- No matrix, no separate Node smoke job, no README badge in this change
- Do not modify `package.json` scripts or test code unless CI cannot run without a fix

## File Structure

| File | Responsibility |
|---|---|
| `.github/workflows/ci.yml` | Define CI triggers, job, and steps |
| `docs/superpowers/plans/2026-08-08-github-actions-ci.md` | This plan (already written) |

No other source files are required for the feature.

---

### Task 1: Add CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `package.json` scripts `check` (chains typecheck, `bun test`, `test:package`); `bun.lock`
- Produces: GitHub Actions workflow named `CI` with job `check`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - master

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Check
        run: bun run check
```

- [ ] **Step 2: Validate YAML locally (syntax)**

Run:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"
```

Expected: `ok`

If `yaml` is missing, run:

```bash
python3 -c "import json,re; p=open('.github/workflows/ci.yml').read(); assert 'bun run check' in p and 'pull_request' in p and 'master' in p; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Run the same gate locally**

Run:

```bash
bun run check
```

Expected: exit code 0 (typecheck, tests, and package smoke all pass). If this fails, fix only what is required for CI to be meaningful, then re-run until green.

- [ ] **Step 4: Commit workflow on a feature branch**

```bash
git checkout -b ci/github-actions-check
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
Add GitHub Actions CI workflow for PR and master checks.

EOF
)"
```

---

### Task 2: Open pull request

**Files:**
- No code changes (uses Task 1 commit)

**Interfaces:**
- Consumes: branch `ci/github-actions-check` with `.github/workflows/ci.yml`
- Produces: GitHub PR against `master`

- [ ] **Step 1: Push branch**

```bash
git push -u origin HEAD
```

Expected: remote tracking set for `ci/github-actions-check`.

- [ ] **Step 2: Create PR with gh**

```bash
gh pr create --title "Add GitHub Actions CI for checks" --body "$(cat <<'EOF'
## Summary
- Add `.github/workflows/ci.yml` to run `bun run check` on pull requests and pushes to `master`
- Matches the local quality gate (typecheck + unit tests + package smoke)

## Test plan
- [ ] Confirm workflow file is present and YAML parses
- [ ] Confirm `bun run check` passes locally
- [ ] After push, confirm the CI workflow run succeeds on the PR

EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 3: Verify CI started (best effort)**

```bash
gh pr checks
```

Expected: a `check` / `CI` run listed as pending or passing. If checks are not yet registered, wait briefly and re-run once.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| Path `.github/workflows/ci.yml` | Task 1 |
| Name / single job `check` / `ubuntu-latest` | Task 1 |
| Triggers: `pull_request` + `push` to `master` | Task 1 |
| checkout + setup-bun latest + frozen install + `bun run check` | Task 1 |
| No matrix / no Node-only job / no badge | Task 1 content omits them |
| Submit PR | Task 2 |
