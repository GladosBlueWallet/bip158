# GitHub Actions CI for PR / master checks

## Goal

Run the same quality gate used locally (`bun run check`) on every pull request and on every push to `master`, so regressions are caught before and after merge.

## Non-goals

- Multi-OS or multi-Bun version matrices
- Separate Node-only smoke job
- Deploy, publish, or release automation
- Coverage reporting or status badges (can be added later)

## Triggers

| Event | Branches |
|---|---|
| `pull_request` | all |
| `push` | `master` |

## Workflow

- Path: `.github/workflows/ci.yml`
- Name: `CI`
- Single job: `check`
- Runner: `ubuntu-latest`
- Permissions: GitHub defaults (read repository contents)

### Steps

1. Checkout with `actions/checkout@v4`
2. Install Bun with `oven-sh/setup-bun@v2` (`bun-version: latest`)
3. Install dependencies with `bun install --frozen-lockfile`
4. Run `bun run check`

`bun run check` already chains:

- `bun run typecheck` (`tsc --noEmit`)
- `bun test`
- `bun run test:package` (build + Node package smoke)

Any failing step fails the job.

## Rationale

- Matches local development and `prepublishOnly`
- One job keeps CI simple for a small TypeScript library
- Frozen lockfile fails the build if `bun.lock` is out of sync

## Out of scope for this change

- README badge
- Required status checks configuration in GitHub branch protection (manual repo setting)
