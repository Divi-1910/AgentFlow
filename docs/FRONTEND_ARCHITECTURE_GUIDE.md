# AgentFlow Frontend Architecture Guide

## 1. Purpose of this document

This chapter explains the product UI as an engineering system: what it owns, how data enters it, how authentication works, why the first implementation slice is structured this way, and what remains to be built.

The frontend is not merely a set of screens. It is the user-facing coordinator between a person and the backend's product APIs. Its job is to present backend state accurately, collect user intent, submit valid commands, and explain progress or failure without inventing state that the backend has not confirmed.

## 2. Current scope

The first UI slice establishes the foundation and makes the dashboard truthful.

Implemented in this slice:

1. One shared JSON API client.
2. Configurable API addressing and a local Vite proxy.
3. Authentication through the shared client.
4. Session restoration with a visible retry path for temporary backend failures.
5. A workspace dashboard backed by real product APIs.
6. Loading, empty, error, expired-session, and retry states.
7. Baseline UI tests with Vitest and React Testing Library.
8. Reduced-motion handling and keyboard-accessible interactive controls.

Deliberately not implemented in this slice:

- agent create, edit, validation, publication, and deployment workflows;
- agent-team authoring and member configuration;
- the complete Studio conversation and run-event experience;
- deployment detail and revision-history screens;
- the HTTP SSE stream parser required by Studio execution;
- password reset, legal pages, or other controls without backend/product support.

This separation matters. A button that looks finished but has no valid workflow is misleading. The dashboard therefore links only to existing routes and reports only state returned by the backend.

## 3. High-level boundary

The runtime path is:

```text
Person
  -> React route and components
  -> page-specific data hook
  -> shared API client
  -> AgentFlow Go product API
  -> application/domain/persistence layers
  -> MongoDB or managed runtime infrastructure
```

The browser does not connect to MongoDB. It also does not need Kubernetes credentials and must not receive AgentFlow's provider API keys. Those are backend and deployment-layer responsibilities.

This boundary protects three important guarantees:

1. **Authorization remains server-owned.** Hiding a button in React is useful UX, but it is never an authorization control.
2. **Secrets remain outside the browser.** Anything sent to browser JavaScript can be inspected by the user.
3. **Backend contracts remain the source of truth.** The UI reflects resource, run, and deployment state; it does not independently manufacture those states.

## 4. The frontend layers

### 4.1 Routing and application shell

`src/app/AppRouter.jsx` maps URLs to pages and protects authenticated routes. The shared application shell provides persistent navigation and an outlet for the selected page.

`ProtectedRoute` has three meaningful states:

- **initializing:** a saved token exists and `/auth/me` has not finished;
- **temporary authentication check failure:** a non-`401` problem occurred, so the token is kept and the user can retry;
- **unauthenticated:** there is no usable token, so the user is sent to login.

These states must not be collapsed. Treating every network interruption as an expired login would unnecessarily sign people out whenever the backend briefly restarts.

### 4.2 Pages and presentational components

A page describes one user outcome, such as understanding the workspace or authoring an agent. It should coordinate page-level UI, but it should not repeat HTTP mechanics.

Presentational components receive data and callbacks. For example, the dashboard's metrics and status badges know how to display values, but do not know how bearer tokens work.

### 4.3 Page data hooks

`src/hooks/useDashboardData.js` owns the dashboard's remote-data lifecycle. It requests:

- `GET /api/workspace/overview`;
- `GET /api/platform/capabilities`;
- recent threads and runs;
- agents and agent teams used to turn resource IDs into human-readable names.

Those requests run concurrently with `Promise.all`. They are independent reads, so performing them concurrently reduces total waiting time from roughly the sum of all request latencies to approximately the slowest request latency.

The hook also creates an `AbortController`. When the page unmounts or the request set is superseded, cleanup aborts the old work. This prevents a stale response from updating a page that is no longer active.

The first version uses an all-or-nothing dashboard load: if any required request fails, the page presents one explicit error and retry action. A later version could use partial panels, but that adds more state and should be introduced only if independent panel availability becomes a product requirement.

### 4.4 Shared API client

`src/api/client.js` is the browser's ordinary JSON transport boundary. It centralizes behavior that every product request needs:

- base-URL construction;
- `Accept` and `Content-Type` headers;
- bearer authentication;
- JSON encoding and decoding;
- normalized `ApiError` objects;
- session invalidation after `401`;
- preservation of request cancellation.

Without this boundary, each page would eventually implement authentication, parsing, and errors slightly differently. That is not just duplicated syntax; it is duplicated policy. Policy duplication causes inconsistent user behavior and makes security fixes easy to miss.

The client remains intentionally small. It is not a general SDK, caching framework, or query language. Those abstractions are not yet required.

### 4.5 Client-side state

Jotai atoms currently own authentication state and application-shell state.

Authentication state includes:

- the bearer token;
- the authenticated user;
- whether startup authentication is still being checked;
- a recoverable authentication-check error.

Remote domain collections are not copied into global atoms by default. The dashboard keeps its fetched data in its page hook because only that page currently owns it. Moving all server data into global state would create synchronization responsibilities without a demonstrated need.

The decision rule is:

- use global client state when unrelated parts of the UI must coordinate the same browser-owned value;
- use page-local remote state when a route fetches and displays backend-owned data;
- introduce a server-state cache only when refetching, invalidation, deduplication, or cross-route reuse becomes materially difficult.

## 5. API address configuration

The default API base is the relative path `/api`. In development, Vite proxies that path to `http://localhost:9090`.

```text
Browser requests /api/workspace/overview
  -> Vite development server receives it
  -> Vite forwards it to http://localhost:9090/api/workspace/overview
  -> response returns through Vite to the browser
```

Why use the proxy?

Browsers apply cross-origin rules based on scheme, host, and port. A Vite UI on one port and an API on another are different origins. A same-origin relative path plus a development proxy avoids adding permissive CORS behavior merely for local convenience.

Two environment variables serve different purposes:

- `VITE_DEV_API_TARGET` changes where the Vite proxy forwards local `/api` requests.
- `VITE_API_BASE_URL` changes the URL used by browser code itself.

In a typical deployed setup, a reverse proxy or ingress should route the UI and `/api` under the same public origin, so no browser-visible backend host is necessary.

## 6. Authentication mechanics

### 6.1 Login

The login flow is:

```text
Submit email and password
  -> POST /api/auth/login
  -> receive bearer token
  -> store token in localStorage and Jotai
  -> GET /api/auth/me with that token
  -> store authenticated user
  -> navigate to /dashboard
```

The second request matters because the token alone does not contain the UI's complete user view. Loading `/auth/me` also proves that the newly stored credential can access an authenticated endpoint.

### 6.2 Startup restoration

On a later browser visit, the token atom is initialized from `localStorage`. The router calls `/auth/me` before showing protected content.

- `200`: restore the user and continue.
- `401`: clear the expired or invalid token and return to login.
- network failure or `5xx`: preserve the token and show retry because validity is unknown.

This distinction is a small state machine, not just error styling. It prevents a temporary infrastructure problem from being interpreted as a security decision.

### 6.3 Token storage limitation

The current project stores the bearer token in `localStorage`. This is simple for a local/resume project, but JavaScript can read it. Therefore, an injected script caused by an XSS vulnerability could steal it.

A production system would evaluate an `HttpOnly`, `Secure`, same-site cookie model together with CSRF protection and backend session semantics. That migration is not part of this UI slice and should not be performed as an isolated frontend change.

## 7. Dashboard data model

The dashboard is an operational summary, not an editor. It answers four questions:

1. What resources exist?
2. Is anything executing now?
3. What happened recently?
4. Which runtime and deployment capabilities are available?

`/workspace/overview` supplies bounded aggregate values:

- numbers of agents and teams;
- active top-level runs;
- managed deployment health counts;
- available model, tool, and MCP-server counts.

`/platform/capabilities` prevents the UI from assuming that every AgentFlow installation supports the same infrastructure. For example, managed deployments can be unavailable while Studio execution remains available.

Recent thread and run pages supply navigation context and execution history. Agent and team lists are joined in browser memory by resource ID only to display names. The backend still owns authorization and resource identity.

## 8. Failure and empty-state semantics

A mature UI distinguishes absence, waiting, and failure:

- **Loading:** the answer is not known yet.
- **Empty:** the request succeeded and there are no matching records.
- **Error:** the request did not produce a trustworthy answer.
- **Unauthorized:** the server explicitly rejected the credential.
- **Unavailable capability:** the installation does not support that operation.

Displaying “0” while a request is still loading would be false: zero means the backend confirmed an empty count. Similarly, displaying “no conversations” after a failed request would disguise an outage as legitimate empty data.

The dashboard therefore uses skeletons during loading, explanatory empty panels after successful empty responses, and a retryable error view when data cannot be loaded.

## 9. Accessibility and motion

The slice establishes several baseline rules:

- real actions use buttons or links, not clickable decorative containers;
- keyboard focus is visibly styled;
- password visibility can be operated from the keyboard and exposes an accessible name and pressed state;
- loading and error states have semantic labels;
- submit buttons become disabled while a request is in flight;
- the dashboard uses `prefers-reduced-motion`, and global CSS minimizes decorative transitions for people requesting reduced motion.

Animation is allowed to support orientation and hierarchy, but the interface must remain understandable when motion is removed.

## 10. Testing strategy

The frontend uses Vitest with a JSDOM environment and React Testing Library.

The first tests are organized by boundary:

### API client tests

They verify request URL construction, bearer headers, JSON encoding, backend error decoding, network errors, and unauthorized callbacks.

### Authentication hook tests

They verify the observable state transition from credentials to stored token/user and the cleanup performed for an expired session.

### Dashboard page tests

They verify what a person sees for loading, successful data, and failure/retry states. The dashboard hook is mocked because these are component behavior tests, not backend integration tests.

These tests do not prove that the Go API and browser are compatible end to end. A later frontend integration or end-to-end suite should start the real backend and exercise the complete HTTP contract. Unit/component tests and end-to-end tests provide different forms of confidence; one does not replace the other.

## 11. Recommended next vertical slices

### Slice 2: Agent library and editor

Build list, empty, create, inspect, edit, validation, publication, and deployment entry points around the agent product APIs. The form should obtain LLM, tool, and MCP choices from catalogs rather than hardcoding them.

### Slice 3: Agent-team library and editor

Build team CRUD and member/coordination configuration. Reuse shared catalog and resource-list primitives only where the behavior is genuinely identical to individual agents.

### Slice 4: Studio execution

Build thread selection, message history, send-message flow, durable run status, cancellation/resume actions, and HTTP SSE event processing.

Studio cannot use the browser's basic `EventSource` API for the send operation because AgentFlow requires an authenticated `POST` request with a JSON body and idempotency key. It needs `fetch`, a readable response stream, an SSE frame parser, cancellation, reconnect/recovery behavior, and reconciliation with durable run/message endpoints.

The backend stream is originator-task scoped rather than limited to one Agent
run. `stream_seq` is the aggregate reconnect order; `run_id` and `seq` identify
the concrete source run. The Chat state model must key per-Agent activity by
source identity and must close the task view only for a terminal event whose
`run_id` equals the root run. A child `run.completed` is timeline activity, not
root completion. `run.waiting` also leaves the stream live so coordinator-started
continuation events can arrive on the same delivery sequence.

Tool events provide structured `kind` and `operation` fields, plus safe target
Agent or MCP identity where relevant. Raw tool arguments are intentionally not
part of the product event JSON. The UI should render the supplied safe metadata
instead of reconstructing capability types from tool-name prefixes or expecting
memory, scratchpad, HTTP, or MCP payloads to be present.

`model.delta` carries display-safe assistant text for one concrete source run.
The Chat client should append it to an attempt-scoped transient buffer keyed by
source `run_id` (and attempt where needed), not immediately create a durable
message. `model.completed` proves that the provider response finished; the
later root completion and transcript reconciliation establish the canonical
persisted answer. Reasoning/thinking content and partial tool arguments are not
part of this event contract.

If a run fails with `provider.stream_interrupted`, the transient text may remain
visible as clearly marked partial output, but it must not be presented as a
saved assistant message. The backend deliberately does not retry after visible
text, because doing so could duplicate the beginning of the answer. Reconnect
must use `stream_seq` replay and then reconcile durable messages rather than
trying to reconstruct correctness from text fragments alone.

The root task stream ends when the root run reaches a terminal state. A
background callback can finish later and persist a follow-up message after that
stream has closed. Until AgentFlow adds a thread-scoped live channel, the Chat
client must reconcile thread messages and durable job/run state rather than
assuming the completed root stream will deliver that later callback.

### Slice 5: Deployment operations

Build publication/revision selection, deploy and delete commands, current deployment health, revision history, and safe status explanations. The UI should never call Kubernetes directly.

### Slice 6: Cross-cutting hardening

Add route-level error boundaries, notification conventions, end-to-end browser tests, responsive audits, and a deliberate production authentication/storage decision.

## 12. Current risks and honest limitations

1. Studio chat remains a shell. Agent and Team creation/configuration are implemented, but conversation execution is not yet connected to those library actions.
2. Dashboard reads currently fail as one group; partial availability is not represented.
3. `localStorage` token persistence carries the XSS exposure described above.
4. No server-state caching library is present. This is deliberate until its complexity is justified.
5. The newly installed frontend dependency tree reports npm audit findings. They have not been automatically rewritten with `npm audit fix`, because automatic dependency changes can introduce unrelated or breaking updates and require a separate investigation.
6. Source changes and tests are documented here, but validation results must only be recorded after the lint, test, and production-build commands are actually run.

## 13. Transferable mental model

For every future screen, ask:

```text
What outcome does the user need?
  -> Which backend state proves that outcome?
  -> Which command changes that state?
  -> Which layer owns each invariant?
  -> What does loading, emptiness, rejection, interruption, and recovery mean?
  -> How will the user know what happened?
```

That sequence keeps UI work connected to system truth. It prevents attractive screens from becoming a collection of optimistic assumptions and ensures each vertical slice is useful from interaction through persistence.

## 14. Agent Team workspace and DAG editor

The Team workspace is now a real product surface rather than an empty route. It shares AgentFlow's typography, motion, and full-page canvas language, but it deliberately does not copy Agent Forge's one-Agent composition layout. Team Forge is a topology workspace designed to remain legible with dozens of Agents.

That distinction matters:

- Agent Forge visualizes one Agent and its capabilities. Its surrounding items are tools and MCP servers.
- Team Forge edits an orchestration topology. Its nodes are existing standalone Agents and its edges are delegation contracts.
- A model is not a Team node. A tool is not a Team node. A prompt is not a Team node.
- Team Forge references an Agent; it never edits that Agent's model, prompt, tools, memory, or MCP selection.

This preserves a clean ownership boundary. An Agent owns its own intelligence configuration. A Team owns only the structure that determines which Agent can delegate to which other Agent and the contract used for that delegation.

### 14.1 User journey

The Team Library and Team Forge are nested routes under one persistent workspace:

```text
/teams
  -> Team Library
  -> selected Team DAG remains on the full-page canvas
  -> Team index floats on the right
  -> selected-Team actions float in the bottom dock

/teams/new
  -> full graph workspace remains primary
  -> Agent catalog opens only when requested
  -> Team settings, selection details, and execution review open as contextual drawers

/teams/:teamId
  -> same editor, initialized from the selected saved Team
```

The persistent parent route owns `TeamGraphCanvas`. Child routes publish a presentation to it. Moving between Library and Forge therefore changes panels and canvas data without replacing the canvas component itself. This is what makes the transition feel spatial instead of like a page reload.

Team Forge has no permanently open sidebars. Its compact toolbar exposes graph-native commands: find an Agent, fit the graph, add Agents, edit Team identity, and review execution. Context appears only when the user asks for it:

1. **Agent catalog** slides from the left while Agents are being added. It can remain open for batch additions and disappears when the user returns to topology work.
2. **Team settings** defines the Team's identity and explains which Agent receives every user request.
3. **Selection inspector** appears after selecting an Agent or delegation. It shows only that element's runtime meaning and relevant actions.
4. **Execution review** converts the draft into a plain-language explanation: where requests start, which optional routes exist, when each route may be used, and whether the graph is ready to save.

These contextual panels participate in the canvas rather than covering it. Each mounted panel reports its measured intrusion from the nearest canvas edge as a four-sided safe area (`top`, `right`, `bottom`, and `left`). React Flow then changes only its camera: it fits the existing nodes inside the unobstructed region and zooms out when the remaining space requires it. The toolbar, minimap, controls, and empty state use the same safe area, so canvas navigation remains reachable while a panel is open. Closing a panel restores the previous viewport when the graph has not changed; if Agents, routes, ports, or settled positions changed while the panel was open, the canvas fits the current graph instead of restoring a stale camera.

This separation is an important invariant. Panel motion never writes Agent coordinates, never restarts the magnetic simulation, and never marks the Team draft as modified. Saved positions continue to describe the Team layout in graph space; panel visibility describes only which part of the screen is currently usable. The safe-area contract is side-agnostic so future top or bottom surfaces can use the same camera behavior without adding panel-specific layout rules.

Delegation descriptions are the primary fields because they explain the runtime decision to the source model. The generated tool name is kept under advanced invocation settings rather than presented as the main product concept.

The canvas itself scales through progressive disclosure. Team Agents are small circular topology nodes rather than configuration cards. A node contains only the Agent name, entry status, and compact incoming/outgoing route counts; model, provider, description, and other configuration stay in the inspector. At distant zoom, route counts disappear while identity and topology remain. Selecting an Agent highlights its complete upstream and downstream execution path and dims unrelated branches. Edge labels appear only for the selected route or routes immediately connected to the selected Agent.

The graph uses a bounded magnetic field rather than unconstrained force-directed layout. DAG topology determines stable processing order, while each edge's selected source and target ports derive its preferred geometric direction. Opposite ports produce strong axial alignment, adjacent ports produce diagonal alignment, and equal-facing ports use a deterministic tangent so the nodes leave room for an outward curve. Siblings sharing one source port fan across that port's axis, multi-parent nodes average compatible placement proposals, and a bounded collision pass prevents the resulting anchors from overlapping. The live field then combines those anchors with connection-distance springs, weak lateral alignment, collision repulsion, damping, and bounded speed. Port constraints guide the layout rather than overriding readability when several edges compete.

Adding, connecting, removing, changing an attachment port, or dragging an Agent wakes the field; the graph reorganizes around the port-aware anchors, sleeps after settling, and writes the final coordinates to the draft once as a single batch. Reduced-motion users receive the same port-aware deterministic layout without the animated settle. A discrete silver pulse travels from each caller toward its callee, making callable direction visible even when no edge label is open. A minimap, graph search, and fit command complete navigation for larger Teams; a manual Arrange command is unnecessary because alignment is an invariant of the canvas itself. Arbitrary DAGs cannot always be drawn without crossings, so the editor guarantees stable spacing and direction while minimizing—not claiming to eliminate—edge crossings.

Direct manipulation temporarily owns node position state: while the user is dragging, the magnetic loop pauses its writes so it cannot overwrite React Flow's pointer coordinates. Releasing the node returns ownership to the topology field, which performs the settle and persists the final layout once. Delegation gestures are similarly directional by construction. Every circular node exposes four neutral connection ports—top, right, bottom, and left. The port where the drag begins is the caller and the port where it ends is the callee, so drawing from Agent A to Agent B always means that Agent A receives a delegation tool which calls Agent B. A port has no permanent incoming or outgoing role. Connection-time validation rejects self-links, duplicate routes, cycles, the edge limit, and paths beyond the runtime's five-level delegation limit; global reachability remains a final-draft invariant because disconnected nodes are expected while a Team is being assembled.

After creating a Team, the Team Library shows a compact runtime explanation rather than embedding the full review UI in its bottom dock. A one-Agent Team remains valid, but the UI clearly states that it has no delegation routes and currently behaves like that standalone Agent under a separate Team identity.

Saving remains explicit. Canvas positions are part of the saved Team graph; they are not autosaved.

After creating a Team, the UI returns to the Team Library and selects the newly created Team. The library snapshot is passed through route state so the new Team can appear immediately while the normal server refresh runs in the background.

### 14.2 Why a directed acyclic graph

A delegation edge points from the Agent that may delegate to the Agent that may receive the work:

```text
Research Lead --delegate_to_browser--> Web Researcher
Research Lead --delegate_to_analyst--> Data Analyst
Data Analyst  --delegate_to_writer---> Report Writer
```

The arrows give the graph direction. Cycles are forbidden, making it acyclic. Without this rule, a path such as `A -> B -> C -> A` could repeatedly return work to an earlier Agent and create uncontrolled recursive execution.

An arrow represents an available capability, not a deterministic workflow transition. At runtime the source Agent sees each outgoing edge as a callable tool. The Agent decides whether the user's request requires that tool, supplies a concrete subtask, waits for the target Agent's result, and then continues its own response. The Studio therefore uses language such as “may ask” and “delegation route” rather than implying that every arrow always executes.

The entry Agent is the only Agent that initially receives the user's request. Every other Agent must be reachable from it. A disconnected Agent would be visually present but impossible for the runtime to invoke, so the UI reports that as invalid rather than saving misleading configuration.

The browser mirrors the backend's important graph checks so the user gets immediate feedback:

- a Team name is required;
- at least one Agent is required;
- the entry Agent must be one of the nodes;
- an Agent can appear only once;
- no self-delegation or duplicate source/target pair is allowed;
- delegation tool names must match `[A-Za-z0-9_-]{1,64}`;
- outgoing delegation names must be unique for their source Agent;
- delegation names cannot collide with a source Agent tool or a registered catalog tool;
- every node must be reachable from the entry Agent;
- the graph must not contain cycles;
- the longest delegation path may not exceed five edges;
- backend limits of 50 nodes and 100 edges are respected.

These checks improve the editing experience, but the backend remains authoritative. Browser state can be stale or bypassed, so the API validates the same invariants at the shared persistence boundary before accepting a create or update.

### 14.3 State ownership

Team draft state uses Jotai atoms within the application's single root provider. The atoms hold:

- the mutable Team draft;
- the last synchronized baseline;
- the current selection (`team`, `node`, or `edge`);
- a derived dirty flag comparing draft and baseline.

The Team workspace must not mount a nested Jotai provider. Jotai providers scope every atom read below them, including authentication atoms. A nested workspace provider would therefore create a second token state and could send a stale, empty, or different account token from Team API calls while the surrounding application displays the current user.

Team isolation is instead enforced through lifecycle initialization: the editor replaces the draft, baseline, and selection whenever the route's Team identity changes. The state survives Team Library/Forge child-route changes because their shared parent stays mounted, and a newly opened Team or create route is initialized from that route's own server or empty state. This provides the required draft behavior without splitting the authentication store.

The baseline is updated after every successful save. This is important for repeated editing: a second patch must be calculated against the most recently confirmed server state, not against the version that happened to be loaded when the editor first opened.

### 14.4 Data flow

Independent data is requested in parallel:

```text
Team Library:
  GET /agent-teams
  GET /agents
  GET /tools

Team Forge:
  GET /agents
  GET /tools
  GET /agent-teams/:id   (edit only)
```

The Agent catalog supplies the display data for Team nodes and prevents the Team editor from inventing embedded Agent copies. The tool catalog is needed for delegation-name collision feedback.

Creation sends the complete Team contract:

```json
{
  "name": "Research Collective",
  "description": "Researches and synthesizes a topic.",
  "entry_agent_id": "agent-lead",
  "nodes": [
    { "agent_id": "agent-lead", "position": { "x": 120, "y": 150 } },
    { "agent_id": "agent-writer", "position": { "x": 340, "y": 150 } }
  ],
  "edges": [
    {
      "source_agent_id": "agent-lead",
      "source_port": "right",
      "target_agent_id": "agent-writer",
      "target_port": "left",
      "tool_name": "delegate_to_writer",
      "description": "Delegate when the research is ready to become a report.",
      "instructions": "Preserve citations and explain uncertainty."
    }
  ]
}
```

Updates use a minimal patch for `name` and `description`. If any graph field changes, the UI sends `entry_agent_id`, `nodes`, and `edges` together as one coherent graph replacement. This avoids mixing part of the old topology with part of the new topology.

`source_agent_id` and `target_agent_id` define runtime direction. `source_port` and `target_port` only preserve the visual sides selected on the canvas. Older Teams without port fields use `right` and `left` respectively. Inspector-created routes use the same deterministic defaults because they have no pointer gesture from which to infer attachment sides.

### 14.5 Failure and recovery behavior

- Catalog and Team loads expose explicit loading, error, retry, and empty states.
- Unsaved browser-tab closure triggers the browser's unload warning.
- Leaving Team Forge through the back action asks before discarding a modified draft.
- A backend rejection is shown in the Forge without pretending the draft was synchronized.
- Deletion conflicts surface dependency information returned by the backend.
- Reduced-motion users receive the same state changes without relying on animation.
- Scene transitions have time-based fallbacks, so navigation does not become stuck if an animation-completion callback is missed.

### 14.6 Deliberate limits

This slice does not:

- edit standalone Agent configuration inside Team Forge;
- introduce another client state or server-cache dependency;
- autosave graph mutations;
- turn tools, MCP servers, prompts, or models into Team nodes;
- add production deployment controls to the Team editor;
- implement mobile-specific graph editing;
- redesign Studio chat or pass a selected Team into the currently empty chat page.

Those omissions keep the present boundary honest: this workspace is responsible for Team CRUD and DAG composition, while execution, deployment, and individual Agent configuration remain separate product responsibilities.
