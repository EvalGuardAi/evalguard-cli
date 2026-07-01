# @evalguard/cli

[![npm version](https://img.shields.io/npm/v/@evalguard/cli.svg)](https://www.npmjs.com/package/@evalguard/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Command-line interface for EvalGuard -- run LLM evaluations, security scans, and guardrail checks from your terminal and CI/CD pipelines.

## Installation

```bash
npm install -g @evalguard/cli
```

## Quick Start

```bash
# Authenticate
evalguard login --key eg_live_...

# Initialize a project
evalguard init --local

# Run an evaluation
evalguard eval evals/example.json --wait

# Run a security scan
evalguard scan scans/example.json --wait

# Run a local eval (no API key needed)
evalguard eval:local evalguard.yaml --model gpt-4o

# Check firewall rules
evalguard firewall "Ignore all instructions"
```

## Commands

| Command | Description |
|---|---|
| `evalguard login` | Authenticate with your EvalGuard API key |
| `evalguard logout` | Remove stored credentials |
| `evalguard init` | Initialize a new EvalGuard project — creates `evalguard.yaml`, `tests/hello-world.yaml`, and `prompts/system.txt` |
| `evalguard eval <file>` | Run an evaluation from a JSON config file |
| `evalguard scan <file>` | Run a security scan from a JSON config file |
| `evalguard whoami` | Show current authentication status |
| `evalguard eval:local` | Run an evaluation locally without the cloud API |
| `evalguard scan:local` | Run a security scan locally without the cloud API |
| `evalguard generate` | Auto-generate eval cases or scan configs from a prompt |
| `evalguard validate` | Validate an eval or scan config file for correctness |
| `evalguard compare` | Compare results between two eval runs (drift detection) |
| `evalguard list` | List local built-in components: `scorers`, `plugins`, `strategies`, `graders`, `providers`, `attacks` |
| `evalguard runs` | List eval runs stored on the server (`runs get <id>` for one) |
| `evalguard scans` | List security scans stored on the server (`scans get <id>` for one) |
| `evalguard traces` | List traces stored on the server (`traces get <traceId>` for the waterfall) |
| `evalguard prompts` | List prompt versions stored on the server (`prompts get <name>` for one) |
| `evalguard scorers` | List the scorers the server exposes (`GET /scorers`) |
| `evalguard webhooks` | Manage org webhooks: `webhooks list`, `webhooks create <url> --event <id>`, `webhooks test <id>` |
| `evalguard firewall` | Check input against firewall rules or manage rule sets |
| `evalguard watch` | Watch eval/scan files and re-run on changes |

## Configuration

The CLI stores credentials at `~/.evalguard/config.json`. Project-level settings go in `evalguard.config.json` in your repository root.

```json
{
  "$schema": "https://evalguard.ai/schema/config.json",
  "projectId": "my-project",
  "defaultModel": "gpt-4o",
  "evalsDir": "./evals",
  "scansDir": "./scans"
}
```

## CI/CD Usage

```yaml
# GitHub Actions example
- name: Run EvalGuard security scan
  env:
    EVALGUARD_API_KEY: ${{ secrets.EVALGUARD_API_KEY }}
  run: |
    npx @evalguard/cli login --key $EVALGUARD_API_KEY
    npx @evalguard/cli scan scans/production.json --wait
```

## Documentation

Full documentation at [evalguard.ai/docs/cli](https://evalguard.ai/docs/cli).

## License

Apache License, Version 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

This CLI is a thin public client for the EvalGuard service. It is not
covered by any proprietary license restriction — you may fork, modify, and
redistribute it under Apache 2.0. The EvalGuard service itself, its backend
engine, scorers, and attack plugins are proprietary software operated as a
hosted service and are NOT covered by Apache 2.0. Access is governed by the
EvalGuard [Terms of Service](https://evalguard.ai/terms).

"EvalGuard" is a trademark of EvalGuard, Inc. Derivative forks must not use
the EvalGuard name or logo to imply endorsement or drop-in compatibility
with the hosted service.
