# copilot-viz

A live browser dashboard of [GitHub Copilot CLI](https://github.com/github/copilot-cli) sessions.
It shows what every agent and subagent is doing, the tool calls and background shells on a
timeline, and an activity feed, for the sessions on this machine and on SSH hosts.

copilot-viz is an unofficial tool. It is not affiliated with or endorsed by GitHub.

![Copilot Viz showing three parallel subagents, two background shells, a tool-call timeline, and sessions on local and remote hosts.](https://raw.githubusercontent.com/yosh-matsuda/copilot-viz/main/docs/demo.png)

*The real dashboard with synthetic demo data. All sessions, prompts, commands, results, and hosts
in these images are fictional; no real session logs are shown.*

<details>
<summary>Watch the 20-second demo</summary>

![Animated demo: parallel agents and shells finish, test output opens, and the view switches to a remote session.](https://raw.githubusercontent.com/yosh-matsuda/copilot-viz/main/docs/demo.gif)

</details>

## Features

- **Sessions**: the sessions whose log changed recently, running ones first. *Follow* keeps the
  busiest session in view.
- **Agents**: the main agent and its subagents as a map, with their state: running, waiting for an
  answer or an approval from you, idle, or done, and their background shells.
- **Timeline**: tool calls and background shells per agent, over the last 5 minutes to 6 hours.
- **Activity**: prompts, replies, and tool calls as they happen. Select a call to see its
  arguments and result.
- **Remote hosts**: sessions on SSH hosts appear next to the local ones, each with its own clock.

The dashboard reads the session logs in `~/.copilot/session-state` and never writes to them. It
needs no change to Copilot CLI, and it shows sessions that started before it did.

## Requirements

- Node.js 22 or later
- Linux, macOS, or WSL. Native Windows is not supported; run it in WSL.
- For remote hosts: OpenSSH, and Node.js 22 or later on each host

## Install

```sh
npm install --global copilot-viz
```

Or install the latest commit from GitHub:

```sh
npm install --global github:yosh-matsuda/copilot-viz
```

## Usage

```sh
copilot-viz            # start the server if needed and open a new link in the browser
copilot-viz status     # show the running server
copilot-viz stop       # stop it
copilot-viz --help     # all commands and options
```

The server runs in the background on `127.0.0.1` (port 7421, or a free port when it is taken). It
exits after 10 minutes without a viewer. `--since 7d` shows the sessions of the last 7 days
instead of 24 hours. Running sessions are always shown.

Over SSH, `copilot-viz --no-open` prints the link, and you forward the port from your machine:

```sh
ssh -L 7421:127.0.0.1:7421 host
```

The server starts again with the new code after an upgrade, on the next `copilot-viz`.

## Remote hosts

List the hosts in `~/.copilot/copilot-viz.json`:

```json
{
  "version": 1,
  "remotes": [
    { "host": "build-server" },
    { "host": "gpu-box", "node": "/opt/node22/bin/node" }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `host` | A host name or `Host` alias of your SSH configuration (required) |
| `node` | The Node.js 22+ command on the host (default `node`). Non-interactive SSH sessions often have a shorter `PATH`, so an absolute path is safer. |
| `copilotHome` | The Copilot home on the host (default `~/.copilot`) |
| `script` | A worker script to run instead of the installed copy, for development |

For each host, copilot-viz runs `ssh` in batch mode with strict host key checking, so the host key
must already be known and the key must work without a prompt, for example through `ssh-agent`. The connection runs a
read-only worker that sends the sessions back over SSH; nothing listens on the host.

The first connection to a host copies the worker (about 90 KB) to
`~/.cache/copilot-viz/worker/<digest>/` on that host, and each later connection verifies its
SHA-256 digest before starting it. A new version of copilot-viz copies its own worker. The path must be private:
copilot-viz refuses to start the worker when another user could change `~/.cache` or anything below it.
`~/.cache` itself may be a symlink and may be writable by your own primary group, as with `umask 002`;
the directories that copilot-viz creates below it may not be symlinks. To remove the worker, delete
`~/.cache/copilot-viz` on the host.

copilot-viz disconnects the hosts after 10 minutes without a page in view, and connects again when
one comes back.

## Security and privacy

Session logs hold your prompts, the replies, and the output of every tool call, which can include
secrets. copilot-viz shows them to whoever can open the dashboard, so it guards the page:

- The server listens on `127.0.0.1` only.
- A link works once: the command hands out a single-use pairing code through a socket in an
  owner-only runtime directory, and the page trades the code for a token that lives only in the
  server process.
- On Linux, the server checks which user owns the other end of each connection and refuses other
  users. In WSL, it also accepts connections that the WSL localhost relay makes as root and
  connections whose owner it cannot see, because Windows programs reach the server that way.
- macOS has no such check. Another user who is logged in to the same Mac can reach the port, but
  still needs a pairing code.

Please report a vulnerability privately; see the
[security policy](https://github.com/yosh-matsuda/copilot-viz/security/policy).

## Limitations

- Copilot CLI does not document its log format. A new version of Copilot CLI can change what the
  dashboard shows until copilot-viz follows the change.
- The first load reads every log within `--since`. With thousands of sessions, a long window takes
  a while, and new events wait until it finishes.
- On an SSH host without a display, the browser command still runs. Set `BROWSER` or use
  `--no-open` when that is not wanted.

## Development

The code has no dependencies.

```sh
npm test         # unit and integration tests
npm run smoke    # pack, install into a temporary prefix, and run the installed command
```

### Demo capture

From a repository checkout, run `npm run demo` and open the printed URL. This development-only
server listens on `127.0.0.1` and serves the real UI with authored events processed by the normal
session model. It never reads Copilot logs or SSH configuration, and never executes the sample
commands. It is not included in the npm package.

The scenario starts when the first browser connects. Select **5m** to show the recent timeline.
The three subagents and two background shells finish over the next 12 seconds; the remote
benchmark finishes at 19 seconds. Once the tests finish, open **read_bash shell tests** in the
activity feed to see their output, and select **Benchmark search** to show the remote session.
Stop with Ctrl+C and restart to record another take.

The README uses a dark-theme capture at 1680 x 1000. Keep the **DEMO** label
visible when recording or replacing the images. Media is linked from GitHub so that the npm
README can display it without adding the images to the installed package.

## Acknowledgements

The agent lifecycle follows [agenttop](https://github.com/daknoblo/agenttop) by Daniel Knobloch.
Its license is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

[MIT](LICENSE)
