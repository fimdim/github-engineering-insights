# Security and public publication

## Intended deployment

GitHub Engineering Insights is supported as a **local, single-user app on a trusted machine**. Publishing its source on GitHub does not make it suitable for public hosting.

The server binds to `127.0.0.1`. Its API checks allowed Host/Origin values, rejects cross-site requests, and requires a local session CSRF token on mutations. These are browser-origin defenses, not user authentication. Any local process running with access to the loopback server can read the local API/session; there is no account login, role-based authorization, or per-user tenant isolation.

Do not expose the app using port forwarding, a public tunnel or reverse proxy. Adding a public deployment would require a separate threat model, authentication, authorization, isolation, transport security, request/rate limits and operational hardening.

## Sensitive data boundaries

The `.local` directory contains SQLite state and may include enterprise identifiers and stable user IDs used for unique counts and daily joins. It is ignored by Git, but not encrypted by the application. Protect it with operating-system permissions and backups appropriate for internal data.

Exports, imports, screenshots, logs, credentials and signed report URLs may also be sensitive even when they are not in SQLite. Privacy suppression is a disclosure-control rule, not a guarantee of anonymity. Small-enterprise opt-in can expose individual activity through aggregates.

Removing an enterprise deletes application records, not GitHub data, saved CLI authentication, database backups, or normal Copilot CLI session history. Logical database deletion is not secure disk erasure.

## Optional AI summaries

Generation is user-triggered. The app minimizes the payload to selected aggregate metrics, definitions and coverage, without names, raw rows, daily series or sample counts. Suppressed/unavailable numbers are omitted.

Copilot CLI executes with the local user's privileges and its installed configuration. The invocation requests an empty `--available-tools` allowlist, but this review did not establish its runtime enforcement with a live model request. A model allowlist is not an operating-system sandbox, and an empty working directory does not isolate global CLI configuration. Use a trusted installation and account; review organization policy, local CLI history, plugins/configuration and any custom provider settings before enabling inference on internal aggregates. There is no global request queue or account-wide spending cap; per-request limits do not bound multiple simultaneous requests.

The app does not validate the factual correctness of generated prose beyond bounded non-empty output. Treat it as an aid, not a source of new measurements.

## Public source-release checklist

- Keep `.local`, SQLite/WAL files, `.env` files, tokens, exports, real reports and private logs out of the repository. Never force-add ignored private state.
- Inspect the exact staged file list and diff before committing. Ignore rules do not protect files already tracked or force-added.
- Review Git history as well as the current tree. If a credential was ever published, revoke/rotate it; deleting the file is not enough.
- Use synthetic-only screenshots and fixtures. The README image was captured against an isolated in-memory Demo instance with no connected enterprise.
- Run `npm run check` and `npm audit`. Review production and development dependencies separately.
- The project is released under the MIT License (`LICENSE`). `private: true` in `package.json` prevents npm publishing, not a public GitHub repository.
- Keep `package-lock.json` pointed at the public npm registry; internal mirror URLs leak infrastructure names and break `npm ci` for others.
- Enable GitHub secret scanning/push protection where available after publication. These are additional safeguards, not a substitute for review.

Useful local commands:

```powershell
git status --short
git ls-files --cached
git diff --cached --stat
git diff --cached
git check-ignore .local/metrics.sqlite
npm audit
npm audit --omit=dev
```

Do not paste sensitive command output into public issues.

## Review snapshot

The publication review on 2026-10-26 found no credential-pattern matches in the publishable source and no confirmed exploitable application-code vulnerability in the reviewed local-use paths. `npm audit` dependency advisories were then addressed:

| Dependency | Advisory | Status |
| --- | --- | --- |
| Tinypool / Vitest mocker (through Vitest 3) | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8) | **Fixed** by upgrading to Vitest 5 (development only) |
| csv-parse 6 | [GHSA-8cw4-87c7-c6xx](https://github.com/advisories/GHSA-8cw4-87c7-c6xx) | **Fixed** by upgrading to csv-parse 7 |
| body-parser 2.x, through Express 5 | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (compressed-body DoS) | **Mitigated; dependency upgrade pending**: an npm override pins body-parser to 2.3.0. The JSON parser keeps `inflate: false` and rejects compressed request bodies (covered by a test). This is a workaround, not a dependency fix; `npm audit` will continue to report the advisory until the patched dependency is installed. |

Once the patched release is available to the project, remove the body-parser override, regenerate the lockfile, and upgrade without downgrading Express. Keep `inflate: false`; do not use `npm audit fix --force`.
This is a point-in-time review, not a security certification, exhaustive secret scan, or guarantee that future dependencies or commits are safe.

## Reporting vulnerabilities

Do not report exploit details or sensitive data in a public issue. If this repository's GitHub **Security** tab offers **Report a vulnerability**, use that private channel. Otherwise contact the repository owner privately; no dedicated reporting address or response-time commitment has been configured yet.

Include affected versions, sanitized reproduction steps, likely impact and deployment assumptions. Never include live credentials, user records or private report links.
