<p align="center">
  English | <a href="./docs/zh-CN/security.md">简体中文</a>
</p>

# Security

Alyce speaking. *This page feels a bit formal. But I'd rather be precise than breezy when the repository can read files, run commands, and persist memory on a real machine.*

If you find a security issue in Alyce, please treat it differently from an ordinary bug. The runtime has real access to a real filesystem, and that means the blast radius of a vulnerability isn't theoretical.

## Local Trust Model

Alyce is a local, interactive, tool-using agent. It is not a remote sandbox. When you approve a tool request, Alyce can act with the permissions of the user account that launched it.

The main safety boundary is explicit approval plus path and command checks:

- Workspace files can be read by default.
- External directories require approval or explicit configuration.
- Writes, edits, patches, shell commands, PowerShell commands, web access, MCP access, skill loading, and subagent launches go through approval and permission rules.
- Sensitive paths such as `.env`, `.alyce`, private keys, credential files, and common cloud config locations require explicit approval.
- Generated folders such as `dist`, `build`, `coverage`, `.next`, `.nuxt`, and `node_modules` are treated cautiously for writes.
- Plan Mode blocks file mutation, mutating shell commands, subagent spawning, arbitrary MCP tools, and skill loading while still allowing read-only inspection.

Approval rules are convenience controls, not a containment system. Do not enable auto approval or broad persistent allow rules in repositories you do not trust.

## Runtime Risk Areas

### Shell and PowerShell

Shell tools execute local commands. Alyce classifies commands into categories such as read-only inspection, build/test, package install, network, file mutation, destructive, arbitrary interpreter, and unknown.

Some commands are denied outright, including root filesystem deletion, disk formatting/overwrite commands, and download-pipe-execute patterns such as `curl ... | sh` or PowerShell `iwr ... | iex`. High-risk commands require explicit approval and broad session allow rules do not skip their prompt.

### Files and Directories

Read/search tools are scoped to the workspace and approved additional directories. Write tools request permission per target path. Sensitive and generated paths add warning details to the approval prompt.

Do not add a broad external directory unless you are comfortable with Alyce reading or searching it during the current session. Use `/add-dir --save` only for stable, trusted paths.

### MCP and Skills

MCP servers and skills are local extension points. A stdio MCP server can run a local process, and a skill can inject extra instructions into the model context. Treat project-provided `.alyce/mcp.json` and `.alyce/skills/**/SKILL.md` as executable or instruction-bearing trust boundaries.

Review these files before approving MCP tools, reading resources from an unknown server, or loading unknown skills.

### Web Access

Web fetch/search tools can send URLs, search terms, and request metadata to external services. Do not paste secrets into web queries, and avoid fetching private URLs unless you understand where the request will go.

## Local State and Secrets

Do not commit:

- `.env`
- `./.alyce/`
- `~/.alyce/`
- generated `dist/` output

`.alyce` can contain connection config, settings, permission rules, session history, memory, MCP output, and local task artifacts. Treat it as private runtime state.

## Operator Checklist

For a new or suspicious checkout:

1. Review `.alyce/mcp.json`, `.alyce/skills/**/SKILL.md`, and project settings if they exist.
2. Keep `approvalMode` set to `manual`.
3. Start in Plan Mode with `/plan` if you want analysis before edits.
4. Run `/doctor` to inspect environment, config, approval risk, MCP, skills, and storage.
5. Approve broad or persistent rules only after you understand the command, path, or server involved.

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

Good-faith research aimed at making Alyce safer is genuinely welcome. But please:

- Don't publish exploit chains publicly before a fix exists.
- Don't access third-party data you don't have permission to touch.
- Don't run destructive tests against systems you don't own or control.

---

*I know this page reads like a policy document. It kind of is. But when a piece of software can actually do things on your machine, I think a little formality is earned.*
