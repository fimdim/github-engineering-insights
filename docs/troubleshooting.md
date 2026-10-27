# Troubleshooting

## The app does not start

Check `node --version` (24+ required), run `npm ci`, then `npm run build` and `npm start`. `npm start` needs the built `dist` directory. If the port is occupied, use:

```powershell
$env:PORT = "4319"
npm start
```

Use the printed `http://127.0.0.1:PORT` URL. The app deliberately rejects other hosts and origins. Development reserves the next port for Vite HMR.

## A body-parser advisory appears in npm audit

The project temporarily pins Express's body-parser dependency to 2.3.0 using an npm override. Use the committed `package.json` and `package-lock.json` together, then run `npm ci`.

Version 2.3.0 has a known compressed-request denial-of-service vulnerability. The app mitigates it by rejecting compressed JSON with `inflate: false`; do not enable decompression. See [the dependency advisory](../SECURITY.md#review-snapshot) for the upgrade plan.

## GitHub authentication or access fails

Run `gh auth status --hostname github.com` and sign in with `gh auth login --hostname github.com` if needed. Authentication alone does not grant enterprise metrics access: verify enterprise role, read permissions, SSO authorization, Copilot metrics policy and rate limits.

Environment credentials can override saved CLI credentials. Inspect their presence locally without printing their values. Never paste tokens or raw command output into a public issue. The app cannot change account permissions or enterprise policy for you.

## A source is Ready but values are unavailable or suppressed

Ready indicates successful collection. A measure can still require a different report family, a mapped service, incident observation coverage, a matching survey period, a valid denominator, or at least five people.

Select one service for DORA. Clear the service filter for scope-wide Copilot IDE usage. Team and service filters cannot be combined. Inspect each metric's explanation for its specific reason.

For very small enterprises, the explicit local small-cohort opt-in can reveal enterprise-wide Copilot aggregates. This can expose individual activity; it is not anonymization, and it does not relax team or survey protections.

## Reports are missing or Unsupported

GitHub can omit daily reports, team cohorts, or optional schemas. Missing reports are not measured zeros. Sync retries unobserved days. Enterprise seat snapshots are unsupported in this version, so seat-based metrics may never populate even when usage data is available.

Historical windows are bounded by local retention and API availability. Avoid interpreting a partial reporting period as a complete trend.

## AI summary generation fails

Check `copilot --help` and `copilot login` in a terminal. `gh` and `copilot` are separate executables. A metrics API token is not automatically a valid Copilot inference credential; the app removes inherited token overrides for summary invocation and relies on the CLI's saved authentication.

Generation requires a compatible CLI with the flags used in `apps/server/copilot-summary.ts`, applicable enterprise policy, connectivity, and sufficient AI credits. The app bounds each request to 90 seconds and a 30-AI-credit session ceiling, and rejects empty/oversized output. Thirty credits is the CLI's minimum supported ceiling, not the expected summary cost. Older app versions passed an unsupported one-credit limit and failed before inference; restart the server after updating. No live model request is part of the automated test suite.

If `copilot` works in your terminal but `/api/analysis/copilot` still returns 503, check whether the server is stale:

1. Stop the existing server with **Ctrl+C** in its terminal.
2. For development, run `npm run dev` again. For production, run `npm run build`, then `npm start`.
3. Reload the dashboard and retry with Demo data first.

Vite hot reload does not restart the API process. A server restart also changes the local CSRF token; a browser using the previous token needs a reload. Do not solve this by disabling the Host/Origin or CSRF protections.

The panel distinguishes a missing CLI, authentication failure, and an account suspension when recognized. Resolve account restrictions with GitHub or sign in to an authorized account; the application cannot bypass them. Raw CLI diagnostics are not returned to the browser.

The deterministic summary remains available on failure. Generated prose is not a validated metric calculation; check it against the displayed evidence before sharing.

## An import is rejected

Download the matching template, preserve exact headers, and use valid UTC timestamps or `YYYY-MM-DD` dates. Keep within 2 MB and 10,000 rows. Incident references must link to known successful deployments in the same service. Survey intervals must fit the selected window and consistent scales. Correct every preview error before committing.

## The favicon returns 404

The HTML references `/favicon.svg`, provided by `apps/web/public/favicon.svg`. Vite serves it during development and copies it into `dist/web` during a build. Rebuild stale production assets and reload the browser if an older page is still requesting a missing icon.

## Reporting a bug safely

Include the app command used, Node/CLI versions, affected source family, status and sanitized error text. Reproduce with Demo or synthetic fixtures when possible. Do not include `.local`, exports, real-enterprise screenshots, credentials, stable user IDs, or signed report links.
