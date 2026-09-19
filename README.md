# RecFrost

RecFrost is a fork of RecFlare's server and a scalable implementation of RecNet — the Rec Room backend — built on
Cloudflare Workers. It implements the network services the Rec Room client talks
to — accounts, auth, rooms, matchmaking, economy, chat, notifications, and more —
each as an independent Node.js Worker on their own subdomains, just how RecNet was.

These game builds are supported:

| Build         | Manifest              | Support                                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `20230414`    | `7859140924515540835` | **Default**, official — the 2023 build the rest of the stack targets                    |
| `20250718.01` | `1151455856673601091` | **Beta**, official — use the [patch-2025](https://github.com/recflare/patch-2025) patch |
| `20250424.01` |                       | Alpha                                                                                   |
| `20231207`    |                       | Alpha                                                                                   |
| `20230616`    |                       | Alpha                                                                                   |
