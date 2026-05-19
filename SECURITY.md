# Security Policy

## Supported Versions

MindSpring is currently pre-1.0. Security fixes are applied on `main`.

## Reporting a Vulnerability

Do not report vulnerabilities in public issues.

Use GitHub private advisories:
- https://github.com/Stackbilt-dev/mindspring/security/advisories/new

Include:
- affected endpoint/module
- reproduction steps
- impact and severity estimate
- sanitized logs only

## Public Repository Data Safety

This repository is public OSS. Never post the following in issues, PRs, comments, or commits:

- API keys, bearer tokens, secrets, credentials
- personal data (names, emails, phone numbers, addresses)
- customer/account identifiers tied to private systems
- private/internal URLs containing sensitive query parameters
- raw production payloads with identifying content

## Redaction Standard

When sharing evidence, replace sensitive values with placeholders:

- `<CLIENT_A>`
- `<USER_001>`
- `<ACCOUNT_X>`
- `<TOKEN_REDACTED>`

Prefer summaries and minimal snippets over full payload dumps.

## Incident Response for Accidental Disclosure

If sensitive data is posted publicly:

1. Remove or redact the content immediately.
2. Rotate any exposed secrets/tokens immediately.
3. Open a private security advisory with timeline and impact.
4. Link any follow-up public issue only to sanitized details.

## Scope Boundary: OSS vs Private Tracking

Use public GitHub issues for technical work items only.
Use a private tracker for customer-specific or PII-bearing context.
Cross-reference via neutral IDs only (for example, `INT-4821`).
