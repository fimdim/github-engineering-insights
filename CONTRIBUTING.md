# Contributing

GitHub Engineering Insights is a TypeScript local-first dashboard. Contributions should improve the accuracy and explainability of evidence, not turn it into individual performance monitoring.

## Local setup

Install Node.js 24+ and npm, then run:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:4317`. Start in Demo mode; no GitHub credentials are required. For a production-style local run, use `npm run build` followed by `npm start`.

## Before proposing a change

Read [Architecture](docs/architecture.md) and the measurement definitions in the README and in-app catalog. Keep metric definitions, calculation logic, explanations, and tests consistent.

- Do not replace missing observations with zeros, or fabricate denominators.
- Preserve service-level DORA semantics and five-person privacy rules.
- Do not collect source code, prompts, free-text survey answers, or individual rankings.
- Keep subprocess arguments structured; never interpolate request data into shell commands.
- Keep runtime data under `.local`, and use synthetic fixtures in tests and screenshots.
- Document newly unsupported states and data-transfer changes visibly.

## Checks

```powershell
npm run check
```

This runs TypeScript checking, Vitest tests, and the Vite/server build. Tests use synthetic fixtures and in-memory SQLite, not real GitHub access. For smaller iterations, `npm test -- tests/metrics.test.ts` selects one suite.

Use `npm ci` with the committed lockfile. If changing dependencies, inspect the lockfile and run `npm audit`; explain advisories and compatibility changes rather than applying force upgrades blindly.

## Pull request content

Explain the user-visible change, metric/source implications, and checks performed. Include synthetic-only screenshots for UI changes. Never attach real enterprise data, signed download URLs, tokens, or logs containing them.

For vulnerability reports, follow [SECURITY.md](SECURITY.md) rather than posting exploit details or sensitive material publicly.

## License

Contributions are accepted under the project's [MIT License](LICENSE). Follow the [Code of conduct](CODE_OF_CONDUCT.md).

The committed lockfile resolves packages from the public npm registry.
