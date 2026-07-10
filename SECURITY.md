# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/yusukebe/ax/security/advisories/new)
("Report a vulnerability"). Do not open a public issue for security problems.

You can expect an initial response within a few days. Fixes ship as a patch
release as soon as they are verified.

## Supported versions

Only the latest release receives security fixes. ax is pre-1.0; always
install or upgrade to the newest version:

```sh
curl -fsSL https://ax.yusuke.run/install | sh   # verifies SHA-256
brew upgrade ax
```

## Scope notes

- ax fetches untrusted web content by design. Guardrails (download caps,
  timeouts, terminal-escape stripping, cache permissions) are documented in
  the README and `--help`; bypasses of those guardrails are in scope.
- Prompt-injection resistance rules for agents are part of the shipped
  skill (`skills/ax/SKILL.md`) — gaps there are welcome reports too.
