# Security

This project is safety-sensitive because it can expose OPC UA writes to agents.

## Defaults

- Do not expose arbitrary OPC UA writes.
- Keep `controls.enabled: false` until an Operator has reviewed Semantic Controls.
- Use `server.mode: readOnly` for deployments that must never expose a Control Surface.
- Store secrets in environment variables. Literal secret values in YAML are rejected.
- Use only simulator, test, or otherwise safe nodes for examples and integration write tests.

## Reporting

Until a formal process exists, do not publish suspected vulnerabilities publicly. Share details privately with the project maintainer.
