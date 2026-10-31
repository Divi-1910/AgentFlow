# AgentFlow

### Build the agent. Connect the team. Watch it work.

AgentFlow is a full-stack platform for designing, running, and deploying tool-using AI agents.

It brings the parts of an agent system that are usually scattered across scripts and services into one workflow:

- design an agent visually in **Agent Forge**;
- compose reusable agents into a directed team graph in **Team Forge**;
- run conversations with streamed model output and execution activity;
- give agents memory, scratchpad workspaces, built-in tools, and MCP servers;
- publish an immutable revision and deploy it to Kubernetes.

AgentFlow is a personal engineering project and a learning surface for agent-runtime architecture. It is actively evolving, so the repository documentation is the source of truth for the current implementation.

## Why AgentFlow?

Most agent prototypes stop at a prompt and a model call. AgentFlow treats an agent as an executable system with explicit state, capabilities, delegation, persistence, and deployment boundaries.

~~~text
                         AgentFlow Studio
       ┌───────────────────────────────────────────┐
       │ Agent Forge  ·  Team Forge  ·  Chat       │
       └──────────────────────┬────────────────────┘
                              │ authenticated API
                              v
       ┌───────────────────────────────────────────┐
       │ Go backend                                 │
       │ context · execution · delegation · events  │
       └───────────────┬───────────────┬───────────┘
                       │               │
                 MongoDB         LLM / tools / MCP
                       │               │
                       v               v
       ┌───────────────────────────────────────────┐
       │ Published immutable revision                │
       │ AgentFlow Runtime in one Kubernetes pod     │
       └───────────────────────────────────────────┘
~~~

## Product surface

### Agent Forge

Create and configure a standalone agent through a visual canvas and inspector. The agent core exposes the model it uses while tools and MCP servers appear as capabilities around it. Configuration is persisted as an editable resource and can later be published as a revision.

### Team Forge

Compose agents as a directed graph. A team is not restricted to a supervisor/worker hierarchy: an agent can delegate to another agent, and a delegated agent can have its own downstream agents. The graph editor preserves connection direction, visible ports, node positions, and the request path that the runtime will execute.

### Chat and execution activity

Start conversations with an agent or team and receive model output incrementally. The chat surface keeps the answer readable while a compact execution receipt and an expandable activity view explain what happened: model calls, tool inputs and outputs, delegation, memory, scratchpad, MCP calls, waiting, and safe failures.

### Memory and scratchpad

Agents can persist durable memory revisions and use a scoped scratchpad for working documents. These are runtime capabilities with explicit scopes and replay-aware mutation identities rather than hidden process-local variables.

### MCP connectivity

AgentFlow communicates with independently running MCP servers over Streamable HTTP. The platform stores the MCP catalog and freezes the selected deployment URLs into published configuration; it does not bundle or supervise MCP workloads.

The repository includes a local development harness for:

- Sequential Thinking;
- Fetch;
- Python Sandbox;
- Math & Utilities;
- Open-Meteo.

See [`mcp_server/README.md`](mcp_server/README.md) for local setup, ports, MongoDB catalog entries, and the safety limits of the unauthenticated development servers.

### Publishing and Kubernetes deployment

Publishing walks the reachable agent or team graph, validates the configuration, and creates an immutable revision. The managed deployment layer runs one AgentFlow Runtime pod per deployed agent or team, keeps the persistent volume stable across revisions, and exposes deployment status and runtime proxy APIs through the backend.

The Kubernetes manifests are a deployable baseline, not a ready-made public cluster. Images, secrets, TLS, storage, MCP service URLs, and cluster-specific ingress configuration must be supplied by the operator. Start with [`deploy/kubernetes/README.md`](deploy/kubernetes/README.md).

## Repository map

~~~text
backend/       Go Studio API, execution engine, persistence, publisher, and deployment controller
frontend/      React + Vite Studio application
mcp_server/    Local-only independent MCP server harness
deploy/        Kubernetes manifests and deployment contract
docs/          Detailed backend and frontend architecture guides
~~~

The most useful deep dives are:

- [`docs/BACKEND_ARCHITECTURE_GUIDE.md`](docs/BACKEND_ARCHITECTURE_GUIDE.md) — backend layers, control flow, state, failure boundaries, and deployment decisions;
- [`docs/FRONTEND_ARCHITECTURE_GUIDE.md`](docs/FRONTEND_ARCHITECTURE_GUIDE.md) — frontend boundaries, API client, authentication, routing, and state ownership;
- [`frontend/README.md`](frontend/README.md) — frontend-specific development commands and API configuration;
- [`mcp_server/README.md`](mcp_server/README.md) — local MCP process control and catalog configuration;
- [`deploy/kubernetes/README.md`](deploy/kubernetes/README.md) — managed deployment prerequisites and Kubernetes ownership boundaries.

## Local development

### Prerequisites

Install the tools used by the repository:

- Go compatible with [`backend/go.mod`](backend/go.mod) (currently Go 1.25);
- Node.js and npm for the Vite frontend;
- MongoDB, normally available at `mongodb://localhost:27017`;
- `rg` (ripgrep), required by the memory and scratchpad services;
- Redis is optional for local development. If it is unavailable, the backend disables the Redis-backed tool deduplication cache and continues;
- `mongosh` if you want to inspect or manually populate local catalog data.

The backend also needs a JWT signing secret and at least one configured model provider for live model calls. Provider credentials are read by the backend process, never by the browser:

~~~dotenv
MONGO_URL=mongodb://localhost:27017
JWT_SECRET=replace-with-a-long-local-development-secret
REDIS_URL=redis://localhost:6379

# Configure only the providers you intend to use.
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
NVIDIA_API_KEY=...
~~~

Do not commit a real `.env` file or provider credentials. The backend also supports `MEMORY_ROOT`, `SCRATCHPAD_ROOT`, `RG_PATH`, and `PORT`; unset values use the local defaults described in the source and architecture guide.

### Start the backend

From the repository root:

~~~bash
cd backend
go run .
~~~

The Studio API listens on `http://localhost:9090` by default. Check that it is alive:

~~~bash
curl http://localhost:9090/health
~~~

The backend loads `.env` from its current working directory, so place local development configuration in `backend/.env` when using the command above.

### Start the frontend

In a second terminal:

~~~bash
cd frontend
npm install
npm run dev
~~~

Open the Vite URL shown in the terminal. In development, requests to `/api` are proxied to `http://localhost:9090`, keeping the browser on one origin.

Useful frontend commands:

~~~bash
npm test          # Vitest suite
npm run lint      # ESLint
npm run build     # production bundle
npm run preview   # serve the production bundle locally
~~~

To use another backend address:

~~~bash
VITE_DEV_API_TARGET=http://localhost:8080 npm run dev
~~~

### Optional: start the local MCP servers

The MCP harness is intentionally separate from AgentFlow. It clones and prepares the upstream projects, then starts each server as its own local process:

~~~bash
./mcp_server/setup.sh
./mcp_server/start-all.sh
./mcp_server/status.sh
~~~

Stop only the processes started by the harness:

~~~bash
./mcp_server/stop-all.sh
~~~

The local MCP endpoints bind to loopback and have no authentication. Do not expose them through a public interface or tunnel. After starting them, populate the local MongoDB MCP catalog using the documented entries in [`mcp_server/README.md`](mcp_server/README.md).

## Backend architecture in one page

The Studio request path is deliberately split into responsibilities:

~~~text
HTTP request
  -> authentication and product handler
  -> run creation and execution preparation
  -> dispatcher and agent runtime loop
  -> LLM provider, built-in tools, MCP, or delegated agent
  -> checkpoints, streamed events, and persisted messages
~~~

The execution engine is action-driven. A model decision becomes an explicit action such as `tool`, `delegate`, `respond`, or `plan_update`. The runtime owns the loop; the selected strategy owns decision logic. This keeps ReAct, network-style multi-agent delegation, and supervisor-style coordination on the same execution contract.

The backend stores editable Studio resources and conversation state in MongoDB. A published revision is a validated, immutable snapshot with its own unique revision identity, delivered to the standalone runtime. The runtime uses local SQLite/filesystem state for its managed memory and scratchpad boundary.

## API surface

The authenticated product API currently covers:

- signup, login, session restoration, and local session logout;
- workspace overview, platform capabilities, LLM catalog, tools, and MCP catalog;
- agent and agent-team CRUD;
- agent/team publication, revision listing, bundle export, and forward restore;
- conversations, messages, runs, streamed run events, cancellation, and resume;
- managed deployment list, deploy, undeploy, status, and runtime proxy routes when managed Kubernetes mode is enabled.

The Go router is the authoritative API contract. The frontend uses the shared client in `frontend/src/api/client.js` so authentication, JSON handling, `401` session invalidation, and network failures remain consistent across product pages.

## Kubernetes deployment

The managed deployment path is designed around an immutable revision and a stable persistence boundary:

1. The Studio publishes a validated revision.
2. The deployment controller reconciles the desired state.
3. Kubernetes runs one runtime pod for the selected agent or team.
4. The runtime receives the frozen configuration and AgentFlow-owned credentials.
5. The persistent volume remains attached to the deployment across newer revisions.
6. The backend exposes deployment status and proxies authenticated runtime requests.

Before applying the manifests, read the complete deployment contract and provide immutable image digests, Kubernetes secrets, artifact TLS, a compatible StorageClass, and the independently deployed MCP service URLs:

~~~bash
kubectl apply -k deploy/kubernetes
~~~

This is an operator workflow, not required for ordinary local Studio development.

## Project status

AgentFlow is an active, evolving project. The core Studio workflow, agent/team execution model, chat activity experience, MCP integration, publication path, and managed Kubernetes deployment layer are implemented and documented. Interfaces and operational tooling may continue to change as the product is refined.

The repository currently does not declare a license. If you intend to accept external contributions or permit reuse, add an explicit license and contribution policy before presenting it as an open-source project.

## Engineering notes

AgentFlow favors explicit boundaries over a single opaque “agent” abstraction:

- the browser never connects directly to MongoDB or receives provider secrets;
- user-authored configuration is distinct from immutable published revisions;
- MCP servers are independent workloads, not hidden dependencies inside an agent pod;
- execution events are persisted and streamed so the UI can explain what the runtime did;
- retry and replay identities are designed around durable run and tool-call identifiers;
- deployment changes create forward revisions rather than mutating historical revisions.

Those decisions are explained with evidence, alternatives, and failure analysis in the architecture guides.

## License

No license has been declared yet. All rights remain with the repository owner unless a license is added.
