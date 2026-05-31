# Security Policy

Pond is an agent-native CLI **and** a multi-tenant host that runs **untrusted user
code** (capsules) on shared infrastructure. Security reports are taken seriously —
both for the CLI/runtime and for the hosted control plane.

## Supported versions

Security fixes land on the latest published `pondsh` release and `main`. Older
versions are not patched; please upgrade before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/DevvGwardo/pond/security/advisories/new)
(Security → Report a vulnerability). Include:

- A description of the issue and its impact (e.g. capsule-to-capsule access,
  control-plane RCE, host-token disclosure, sandbox escape).
- Steps to reproduce or a proof-of-concept.
- The version / commit and how the host was configured
  (`--capsule-egress`, `--capsule-fs-isolation`, `--capsule-cgroup-root`).

We aim to acknowledge within a few days. Please give us reasonable time to ship a
fix before any public disclosure.

## Scope and threat model

The isolation boundaries and their failure modes are documented in
[`deploy/HARDENING.md`](deploy/HARDENING.md). The abuse-handling process for
hosted deploys is in [`docs/abuse-policy.md`](docs/abuse-policy.md). Particularly
in-scope:

- Capsule escaping its sandbox (Node `--permission`, bubblewrap, or cgroup).
- One tenant reading another tenant's data, `control.db`, or the host token.
- Bypassing the egress policy (`sealed`/`proxy`) to reach the network.
- Privilege escalation in the control plane (auth, claim tokens, admin routes).

When operating a public host, **set `--alert-webhook` and review the
[isolation posture banner](deploy/HARDENING.md) printed at boot** — several
boundaries are opt-in and fail loud rather than silently when misconfigured.
