# Security Policy

## Supported Scope

Security reports are especially valuable for:

- local process orchestration between Desktop, Driver, and Brain
- browser automation boundaries
- prompt or tool injection paths
- file system access and patch application flows
- configuration, secrets, and release packaging

## Reporting a Vulnerability

Please do not file public issues for suspected vulnerabilities.

Preferred process:

1. Contact the maintainers privately, or use GitHub security advisories if enabled.
2. Include a clear description, affected files or flows, reproduction steps, and impact.
3. If possible, include a minimal proof of concept and any suggested mitigation.

## What to Include

- affected version or commit
- attack preconditions
- exact trigger or payload
- expected impact
- any workaround already identified

## Response Expectations

The project aims to:

- acknowledge reports promptly
- reproduce and triage the issue
- communicate severity and next steps
- coordinate disclosure once a fix or mitigation exists

## Secrets and Local Testing

- Never commit real API keys or tokens.
- Use `config.yaml` or environment variables locally, and keep secrets out of issue bodies and PRs.
- If a report depends on private credentials, redact them before sharing artifacts.
