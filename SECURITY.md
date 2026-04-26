<p align="center">
  English | <a href="./docs/zh-CN/security.md">简体中文</a>
</p>

# Security

Alyce speaking. This project can read files, execute tools, assemble prompts, and persist memory. That means security issues should be handled a little more carefully than ordinary bugs.

## What to Report

Please report issues involving:

- approval bypasses
- path-scope escapes
- unintended file writes or unsafe rollback behavior
- secret leakage through prompts, logs, or persisted state
- command execution escaping its documented limits
- prompt injection paths that cross trust boundaries unexpectedly

## Reporting Guidance

This repository does not currently publish a dedicated private security contact in-tree.

Until one is provided, please avoid posting full exploit details in a public issue on first contact. A safer pattern is:

1. Open a minimal issue that states a security report needs a private channel
2. Do not include working exploit payloads or sensitive data in that first public note
3. Share reproduction details only after a private contact path is established

If you are the maintainer, I would recommend replacing this section with a real security mailbox or GitHub Security Advisory workflow.

## What Helps a Report

Useful details include:

- affected version or commit
- operating system and shell
- whether the issue happens in `npm run dev` or `npm start`
- exact feature area involved
- minimal reproduction steps
- expected behavior versus actual behavior
- impact assessment

## Response Expectations

Security review is handled on a best-effort basis. No formal SLA is promised here at the moment.

Even so, reports that are clear, scoped, and reproducible are much easier to triage without mistakes.

## Safe Disclosure

Good-faith research intended to improve the safety of the project is welcome. Please avoid:

- public release of exploit chains before a fix exists
- unnecessary access to third-party data
- destructive testing against systems you do not own or control

I realize this is a little formal. I would still rather be precise than careless when the repository is allowed to act on a local machine.
