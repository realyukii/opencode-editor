# AGENTS.md

This file describes how to work safely and consistently in the opencode-editor repository. It applies to the whole repository. More specific `AGENTS.md` files, if added later, override it within their directories.

This is working guidance, not a product specification. Derive feature behavior from the task and relevant tests. Verify current behavior in code before relying on documentation.

## Repository overview

## Toolchain and dependencies

## Build and run

## Required verification

Run the narrowest relevant test while iterating, then run the repository gate before reporting completion.

Do not claim a check passed unless it was run in the current worktree and its exit status was observed.

## Testing conventions

- Test externally observable behavior and regressions. Avoid tests that merely restate implementation details.

## Documentation roles

- `README.md` describes current user-visible behavior, commands, and deployment boundaries. Update it when those change.

Do not use this `AGENTS.md` as evidence that a proposed algorithm or feature is correct. Novel behavior still needs a clear task, relevant design or ADR context, tests, and review.

## Change discipline

- Inspect `git status` before editing and preserve unrelated user changes.
- Keep changes scoped to the task.
- Update code, tests, and user documentation together when a public contract changes.
- Do not commit unless requested. When asked to commit, follow the repository's focused Conventional Commit style and include `--signoff`.
- Before handoff, inspect `git diff --check`, review the complete diff, and report the exact verification commands that passed.
