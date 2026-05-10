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

## Pull Request Guidelines

- Keep PRs focused and small
- Include tests for new features
- Follow existing code patterns
- Write clear commit messages

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
