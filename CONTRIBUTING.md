# Contributing to Free2AITools

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Run tests: `npm test`
5. Submit a Pull Request

## Code Quality

All PRs must pass:

- **Unit Tests**: `npm test`
- **E2E Tests**: `npm run test:e2e` (requires `npm run build` first)
- **Compliance Check**: `npm run ces-check`
  - No files > 250 lines
  - Workflows must have `timeout-minutes` and `cache`

### One test file exits 71 locally, by design

`tests/unit/mesh-visualizer-no-metadata-read.test.ts` refuses to run outside
the isolation launcher. Run `npm test` on your own machine and that one file
terminates its worker before any test runs:

```
E_ISOLATION_BOUNDARY_ABSENT(71): F2AI_ISO_EVID is not set: no launcher ran
Error: process.exit unexpectedly called with "71"
```

That is the intended result, not a broken checkout, and it is the only file in
the suite that behaves this way. The file guards a real network-namespace
boundary, so running it without one would report green whether or not the
boundary exists — which is the vacuous guard it was written to replace. CI runs
the whole suite inside the launcher, so it passes there:

```
# .github/workflows/test-suite.yml
bash scripts/ci/isolation/netns-launch.sh -- npx vitest run --coverage
```

Do not "fix" a local 71 by adding a skip, relaxing the precondition, or
changing the exit code. The hard exit is the property under test, and it is the
only one: no other file exits this way, so any other local failure you run into
is unrelated to the launcher and needs its own diagnosis.

## Pull Request Guidelines

- Keep PRs focused and small
- Include tests for new features
- Follow existing code patterns
- Write clear commit messages

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
