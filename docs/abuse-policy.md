# Abuse Policy (template)

This is the source document. The host renders a live version at `/abuse` on the bare domain.

## Prohibited use

Pond hosts arbitrary user-submitted capsules anonymously. The following are prohibited and may result in immediate takedown:

- **Phishing** — credential harvesting, impersonation of any third party, fake login pages.
- **Malware distribution** — drive-by downloads, exploit kits, ransomware, info-stealers.
- **Resource abuse** — cryptocurrency mining, brute-force / credential stuffing, password sprays.
- **Spam, scams** — content that violates the host operator's local jurisdiction.
- **Harassment** — targeted threats, doxing, hate speech.
- **Unauthorized scraping** — high-volume requests to third-party services from anonymous deploys.

## Reporting abuse

Email the host's abuse contact (shown at `/abuse`) with:

- The deploy URL
- A short description of what you saw
- (Optional) timestamp / a screenshot

The host operator reviews reports within reasonable time (no SLA) and may take down any deploy at any time without prior notice.

## Service limits

| Tier          | Bundle | Disk   | Memory | TTL                           | Rate limit                              |
| ------------- | ------ | ------ | ------ | ----------------------------- | --------------------------------------- |
| Anonymous     | 16 MB  | 128 MB | 128 MB | 1 h grace + 7 d retention     | 5 deploys / IP / hour                   |
| Authenticated | 64 MB  | 512 MB | 256 MB | indefinite (owner can delete) | (none yet — abuse handled case-by-case) |

Anonymous deploys are sandboxed via Node's `--permission` filesystem isolation, a JS-level network shim (now also blocking `dns.lookup`/`dns.resolve`, not just sockets), and — when the host runs as root — **OS-level privilege separation**: each anonymous-unclaimed worker is dropped to a dedicated unprivileged uid/gid, so a sandbox escape lands as a powerless user rather than the control plane. **The JS network shim is still best-effort, not the boundary**; the real outbound boundary is the OS egress firewall, which operators concerned about lateral movement / DNS exfiltration should enable (see the operations guide). There is no per-tenant VM or network namespace yet — capsules share the host loopback.

## The anonymous trust boundary

"Anonymous" here means "no account required," **not** "arbitrary untrusted code with no recourse." Anonymous deploys are bounded by:

- **A human/bot challenge** — when the operator configures Cloudflare Turnstile, an anonymous deploy must pass a verified challenge before it is accepted.
- **Per-IP rate limits** — 5 deploys / IP / hour by default.
- **The sandbox + egress policy** described above.
- **An automatic time-to-live** — unclaimed deploys are terminated after the grace window and deleted after the retention window.
- **A manual operator kill switch** — the host operator can terminate any deploy immediately via `pond admin terminate <deployId>`.

These layers raise the cost of abuse and give the operator immediate recourse; they do not turn the JS-level sandbox into a hardened multi-tenant boundary. Treat the host as semi-trusted and review the [operations guide](./operations.md) before exposing it publicly.

## No warranty

Pond is provided as-is. The host operator makes no guarantees of availability, durability, performance, or fitness for any purpose. **Do not deploy production workloads here.**

Anonymous deploys may be removed:

- after the documented retention window (currently 7 days),
- when found to violate this policy,
- when the host operator needs to reclaim resources,
- on host restart if the worker fails to boot,
- at the host operator's sole discretion.

## Account termination

Authenticated accounts may be suspended for repeated violations. A first violation typically results in a warning email; a second results in account suspension and deletion of all associated deploys.

## Legal

The host operator complies with valid legal process from their jurisdiction. Notices should be sent to the abuse contact email. Pond's hosted control plane stores per-deploy: the bundle bytes, a SHA-256 hash, the deploy's environment variables, application data in SQLite, and an audit log of every mutation. Logs are retained at the host operator's discretion.

## Updates

This policy may be updated. Material changes will be announced via the `/abuse` page at least 7 days in advance when feasible.
