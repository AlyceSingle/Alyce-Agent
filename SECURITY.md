<p align="center">
  English | <a href="./docs/zh-CN/security.md">简体中文</a>
</p>

# Security

Alyce speaking. *This page feels a bit formal. But I'd rather be precise than breezy when the repository can read files, run commands, and persist memory on a real machine.*

If you find a security issue in Alyce-Agent, please treat it differently from an ordinary bug. The runtime has real access to a real filesystem, and that means the blast radius of a vulnerability isn't theoretical.

## What Counts as a Security Issue

These kinds of problems should be reported as security concerns, not as general bugs:

- **Bypassing approval gates** — if a tool executes something the user should have approved but the approval got skipped.
- **Escaping file-scope restrictions** — if the agent reads or writes outside the allowed directories.
- **Unintended writes or unsafe rollback** — if file snapshots fail silently or rollback corrupts state.
- **Secret leakage** — if API keys, tokens, or sensitive content leak into prompts, logs, or persisted state.
- **Command execution escaping limits** — if a shell command does more than the documented boundaries allow.
- **Prompt injection crossing trust boundaries** — if untrusted content can rewrite the system prompt or override safety rules.

*If you're not sure whether something is "serious enough," err on the side of treating it as security. I'd rather get a report that turns out to be minor than miss one that isn't.*

## How to Report

This repository doesn't publish a private security contact in the repo itself yet. Until one exists, please follow this approach:

1. **Open a minimal public issue** stating that you have a security report and need a private channel.
2. **Don't include exploit details** in that first public note — no payloads, no reproduction steps, no sensitive data.
3. **Share details only after** a private contact path is confirmed by a maintainer.

*If you're the maintainer reading this: please replace this section with a real security mailbox or enable GitHub Security Advisories. This stopgap approach is better than nothing, but it's not ideal.*

## What Helps a Report

The more of these you can include, the faster a fix will happen:

- Affected version or commit hash
- Operating system and shell
- Whether it reproduces in `npm run dev` or `npm start`
- Which feature area is involved
- Minimal reproduction steps
- Expected behavior vs. actual behavior
- Your assessment of the impact

## Response Expectations

Security review is done on a best-effort basis. There's no formal SLA — this is an open-source project, not a managed service.

That said, reports that are clear, scoped, and reproducible get triaged much faster. Vague reports with no reproduction steps tend to sit in a queue while we try to guess what you're describing.

## Responsible Disclosure

Good-faith research aimed at making Alyce-Agent safer is genuinely welcome. But please:

- Don't publish exploit chains publicly before a fix exists.
- Don't access third-party data you don't have permission to touch.
- Don't run destructive tests against systems you don't own or control.

---

*I know this page reads like a policy document. It kind of is. But when a piece of software can actually do things on your machine, I think a little formality is earned.*
