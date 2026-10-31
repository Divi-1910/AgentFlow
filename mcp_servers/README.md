# Local MCP Servers for AgentFlow

This directory is a deliberately local development harness. The MCP servers run
as independent processes; AgentFlow does not own, deploy, or supervise them. It
only discovers their URLs from MongoDB and communicates with them over MCP
Streamable HTTP.

Nothing here is a production hosting design. The servers are unauthenticated,
bound to loopback, and intended for a single-developer machine.

## What runs where

| Catalog server ID | Purpose | Local URL | How HTTP is provided |
| --- | --- | --- | --- |
| `sequential-thinking` | Step-by-step problem decomposition | `http://127.0.0.1:8101/mcp` | Official stdio server behind `mcp-proxy` |
| `fetch` | Fetch and simplify web content | `http://127.0.0.1:8102/mcp` | Official stdio server behind `mcp-proxy` |
| `python-sandbox` | Execute Python through Pyodide/Deno | `http://127.0.0.1:8103/mcp` | Stdio server behind `mcp-proxy` |
| `math-utilities` | Symbolic math, units, statistics, and plots | `http://127.0.0.1:8104/mcp` | Native Streamable HTTP |
| `open-meteo` | Weather and geocoding data | `http://127.0.0.1:8105/mcp` | Native stateless Streamable HTTP |

The bridge is necessary because AgentFlow's MCP client expects Streamable HTTP,
while the official Sequential Thinking and Fetch servers expose only stdio. It
is also used for Python Sandbox so that the externally reachable listener can be
restricted to `127.0.0.1`.

## Local source checkouts

`setup.sh` clones the upstream repositories into `upstream/`. That directory,
virtual environments, `node_modules`, downloaded Deno, logs, PID files, and tool
output are all ignored by the parent Git repository.

The checkouts used while this harness was created were:

| Project | Repository | Commit |
| --- | --- | --- |
| MCP reference servers | `modelcontextprotocol/servers` | `bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c` |
| HTTP bridge | `sparfenyuk/mcp-proxy` | `701a0453487d1b28c8f9806ee4863674c70210dd` |
| Python Sandbox | `pydantic/mcp-run-python` | `4f93a9261d5e9905cb3e93b4817bda7c3470ac00` |
| Math & Utilities | `codeprimate/math-mcp` | `12a37cf77f636dc63f0689660d1a285334c79f20` |
| Open-Meteo | `cmer81/open-meteo-mcp` | `a2f416d00e321ac7a856f6ec1030bbf6a858c60f` |

The setup script does not pull or overwrite an existing checkout. This prevents
a later setup run from silently changing code that was already tested locally.

## Setup and process control

From the repository root:

```bash
./mcp_server/setup.sh
./mcp_server/start-all.sh
./mcp_server/status.sh
```

Stop only the processes started by this harness:

```bash
./mcp_server/stop-all.sh
```

Logs are written under `mcp_server/.runtime/logs/`. `start-all.sh` refuses to
reuse a port that is already occupied. Each server is placed in its own process
group so `stop-all.sh` can also terminate child processes created by a bridge.

## Manual MongoDB catalog entries

This is intentionally not a seeder or migration. With local MongoDB running on
`127.0.0.1:27017`, execute the following once with `mongosh`. Each operation is
an upsert: it creates the local entry when absent and updates only that entry
when present. It does not delete any other catalog document.

```javascript
const catalog = db.getSiblingDB("AgentFlow").mcp_servers;
const now = new Date();

const servers = [
  {
    server_id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Breaks complex problems into explicit, revisable reasoning steps.",
    alias: "sequential_thinking",
    studio_url: "http://127.0.0.1:8101/mcp",
    deployment_url: "http://127.0.0.1:8101/mcp",
    enabled: true,
  },
  {
    server_id: "fetch",
    name: "Fetch",
    description: "Fetches web pages and converts their content into an LLM-friendly form.",
    alias: "fetch",
    studio_url: "http://127.0.0.1:8102/mcp",
    deployment_url: "http://127.0.0.1:8102/mcp",
    enabled: true,
  },
  {
    server_id: "python-sandbox",
    name: "Python Sandbox",
    description: "Runs Python code through Pyodide inside a Deno-based local sandbox.",
    alias: "python_sandbox",
    studio_url: "http://127.0.0.1:8103/mcp",
    deployment_url: "http://127.0.0.1:8103/mcp",
    enabled: true,
  },
  {
    server_id: "math-utilities",
    name: "Math & Utilities",
    description: "Provides symbolic math, unit conversion, statistics, and plotting tools.",
    alias: "math_utilities",
    studio_url: "http://127.0.0.1:8104/mcp",
    deployment_url: "http://127.0.0.1:8104/mcp",
    enabled: true,
  },
  {
    server_id: "open-meteo",
    name: "Open-Meteo",
    description: "Provides weather forecasts, historical weather, air quality, and geocoding.",
    alias: "open_meteo",
    studio_url: "http://127.0.0.1:8105/mcp",
    deployment_url: "http://127.0.0.1:8105/mcp",
    enabled: true,
  },
];

for (const server of servers) {
  catalog.updateOne(
    { server_id: server.server_id },
    {
      $set: { ...server, updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );
}
```

Why both URL fields have the same value locally:

- Studio resolves `studio_url` when an agent is edited or tested.
- Publishing freezes `deployment_url` into a deployment revision.
- This local experiment runs both callers on the same machine, so both resolve
  to the same loopback endpoint.

## Important safety limits

- These endpoints have no authentication. Do not bind them to `0.0.0.0` or
  expose them through a public tunnel.
- Python Sandbox is not a hardened security boundary. Its upstream project
  explicitly warns that Pyodide/Deno cannot safely contain every hostile Python
  workload, including memory-exhaustion attacks. Use only trusted demo inputs.
- Fetch and Open-Meteo make outbound HTTP requests. Tool success therefore also
  depends on internet access and the upstream site/API being available.
- The official MCP reference-server checkout reported five high-severity npm
  audit findings when this harness was created. No automatic dependency rewrite
  was applied because that would change upstream code and may break its lockfile.
- The MongoDB URLs are correct only when AgentFlow itself runs on the host. A
  container or Kubernetes pod interprets `127.0.0.1` as itself, not this host.

