# Security policy

copilot-viz shows the contents of Copilot CLI session logs, which can include secrets. A way for
another user or a web page to read the dashboard, or for a remote host to run code on your
machine, is a vulnerability.

A paired viewer is trusted to administer the dashboard. Settings can write the server's
copilot-viz configuration and run configured programs through the server user's SSH access.
Do not share pairing links with read-only viewers or other people you would not trust with
that access. SSH checks are not a sandbox for a custom executable or worker.

## Reporting a vulnerability

Report it privately through
[GitHub private vulnerability reporting](https://github.com/yosh-matsuda/copilot-viz/security/advisories/new).
Please do not open a public issue, and do not attach real session logs or pairing links: they can
hold your prompts, tool output, and access codes.

Only the latest release receives fixes.
