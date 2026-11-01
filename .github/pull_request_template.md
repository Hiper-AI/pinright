## What and why

<!-- One change per pull request. Link the issue if there is one: Fixes #123 -->

## How it was tested

<!-- The test that fails without this change, and anything you ran by hand
     (a hook input, `pinright check ...`, `scripts/e2e.ts`). -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass
- [ ] Tests use recorded fixtures; none reaches the network
- [ ] Touched `src/clients/` or `package.json`: ran `npm run dist:artifacts`
- [ ] Touched code the Action bundles: ran `npm run bundle:action` and committed `action-dist/`
- [ ] New network host: added to the table in SECURITY.md
- [ ] User-facing change: a line under "Unreleased" in CHANGELOG.md
- [ ] Docs claim only what the code does
