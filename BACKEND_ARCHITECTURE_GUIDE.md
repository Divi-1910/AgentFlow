# AgentFlow Backend Architecture Guide

## Purpose

This document is a detailed learning guide to the AgentFlow backend. It is intended for someone returning to the codebase after time away and needing to rebuild a reliable mental model from first principles.

It is not a replacement for the source code. It explains why the backend exists in its current form, what each layer owns, how control and data move through the system, and what guarantees and trade-offs follow from the design.

The guide will be expanded one layer at a time as we study the backend together. A chapter is considered complete only after its claims have been checked against the repository and any open questions have been recorded explicitly.

## How to Read This Guide

The chapters are ordered by dependency rather than by folder name. Later layers depend on concepts introduced by earlier layers.

Each substantial claim uses one of these evidence labels when the distinction matters:

- **Confirmed:** Directly supported by current source code, tests, configuration, or command output.
- **Inferred:** Strongly suggested by the implementation, but the original design intent is not explicitly recorded.
- **Unknown:** Cannot be established from the available evidence and needs investigation or a product/design decision.

The guide follows these rules:

1. No important term is used as a black box.
2. Every layer answers **what**, **why**, **how**, **when**, and **where**.
3. Examples are included when they make runtime behavior easier to predict.
4. Control flow, data flow, ownership, lifecycle, concurrency, and failure behavior are explained separately.
5. Current behavior is distinguished from stale documentation and intended future behavior.
6. Alternatives and trade-offs are explained without treating conventions as unquestionable rules.
7. Tests are described in terms of the guarantees they provide, not merely listed.
8. Unknowns remain visible rather than being filled with assumptions.

## Current High-Level Understanding

AgentFlow is a platform for defining, running, coordinating, and publishing tool-using AI agents.

The repository contains two backend compositions built around the same execution core:

1. **AgentFlow Studio** is a multi-user authoring and execution service. It stores editable agents, conversations, runs, jobs, memories, and publication revisions primarily in MongoDB.
2. **AgentFlow Runtime** is a standalone service that loads an immutable published agent bundle and runs it using SQLite and local filesystem storage.

At the highest level, a normal Studio request follows this path:

```text
HTTP request
    |
    v
Authentication and API handler
    |
    v
Run creation and preparation
    |
    v
Dispatcher
    |
    v
Agent runtime loop
    |
    +----> LLM provider
    |
    +----> Built-in or MCP tool
    |
    +----> Delegated agent or asynchronous job
    |
    v
Checkpoint, streamed events, and persisted messages
```

Publication creates another path:

```text
Editable root agent
    |
    v
Reachable delegation graph
    |
    v
Stable, validated snapshot
    |
    v
Hash-verified deployment bundle
    |
    v
Standalone AgentFlow Runtime
```

These diagrams are orientation maps. Each arrow will be explained in the relevant chapter.

## Backend Layer Map

The word *layer* in this guide means a coherent responsibility and boundary. It does not imply that every dependency is strictly vertical or that each layer maps to exactly one Go package.

### Layer 1: Domain Model and Vocabulary

Defines the concepts the rest of the backend operates on:

- Agent
- Thread
- Message
- Run
- Checkpoint and snapshot
- Task and run budget
- Job and callback
- Delegation lineage
- Publication and deployment revision
- Memory scope and runtime context

Primary locations:

- `backend/agent`
- `backend/model`
- `backend/runtimectx`
- Domain-facing types in `backend/deployment`

This layer comes first because incorrect vocabulary causes incorrect reasoning in every later layer.

### Layer 2: Context Construction and Conversation Management

Builds the information presented to the model for each call. It combines platform policy, agent instructions, tool instructions, conversation history, summaries, memories, collaboration context, scratchpad availability, MCP availability, and current execution state.

Primary locations:

- `backend/agent/context_builder.go`
- `backend/agent/context.go`
- `backend/agent/summarizer.go`
- `backend/agent/platform_config.go`
- `backend/platform.xml`

### Layer 3: Agent Execution Engine

Owns the model-and-tool loop. It calls the model, validates requested tools, executes tool batches, records results, emits events, saves checkpoints, and determines whether a run completed, failed, was cancelled, is resumable, or is waiting for asynchronous work.

Primary locations:

- `backend/agent/runtime.go`
- `backend/agent/tool_batch.go`
- `backend/agent/checkpoint.go`
- `backend/agent/events.go`
- `backend/agent/records.go`

### Layer 4: Tools and External Capabilities

Defines the tool contract and constructs the effective set of capabilities visible to a specific agent run.

The effective tool set can contain:

- Embedded tools such as calculator and HTTP request.
- Optional web search.
- Memory tools.
- Scratchpad tools.
- Synthesized delegate tools.
- Asynchronous dispatch and await tools.
- Dynamically discovered MCP tools.

Primary locations:

- `backend/tools`
- `backend/mcp`
- `backend/agent/toolset.go`
- `backend/agent/delegate_tool.go`
- `backend/agent/async_tools.go`

### Layer 5: LLM Provider Abstraction

Provides a single internal chat-completion contract over provider-specific APIs. The runtime depends on the internal contract instead of depending directly on OpenAI, Anthropic, or NVIDIA wire formats.

Primary locations:

- `backend/llm/llm_interface.go`
- `backend/llm/llm_registry.go`
- `backend/llm/openai.go`
- `backend/llm/anthropic.go`

### Layer 6: Multi-Agent Dispatch and Coordination

Coordinates top-level runs, synchronous delegated runs, asynchronous jobs, callbacks, worker pools, run budgets, leases, cancellation, and resumption.

Primary locations:

- `backend/dispatcher`
- `backend/bus`
- `backend/agent/delegate_tool.go`
- `backend/agent/async_jobs.go`
- `backend/agent/async_tools.go`

### Layer 7: Memory and Shared Collaboration State

Provides two different forms of state:

- **Memory:** versioned, scoped knowledge intended to survive beyond one execution.
- **Scratchpad:** task-scoped artifacts shared by agents participating in one delegation tree.

Primary locations:

- `backend/memory`
- `backend/scratchpad`
- `backend/runtimectx`
- Memory and scratchpad definitions in `backend/tools`

### Layer 8: Persistence Contracts and Adapters

Stores users, agents, threads, messages, runs, checkpoints, jobs, tasks, deployment revisions, deployment state, memory metadata, and memory revisions.

The two main adapter families are:

- MongoDB repositories for Studio.
- SQLite repositories for the standalone runtime.

Primary locations:

- `backend/repo/mongorepo`
- `backend/repo/sqliterepo`
- `backend/repo/conformancetest`
- `backend/db`
- `backend/fsatomic`

### Layer 9: HTTP Application and Security Boundary

Receives external requests, authenticates callers, validates request data and ownership, creates runs, starts dispatch, streams server-sent events, and translates domain outcomes into HTTP responses.

Primary locations:

- `backend/handlers`
- `backend/middleware`
- `backend/auth`
- Route registration in `backend/main.go` and `backend/runtime/app.go`

### Layer 10: Publication and Deployment Artifacts

Converts an editable, user-owned agent graph into an immutable and verifiable deployment revision.

It is responsible for:

- Walking the reachable delegation graph.
- Enforcing ownership and graph validity.
- Detecting cycles and missing delegates.
- Capturing a stable snapshot while edits may occur concurrently.
- Freezing deployable configuration.
- Producing a deterministic canonical hash.
- Storing immutable publication revisions.

Primary locations:

- `backend/publisher`
- `backend/deployment/bundle.go`
- `backend/deployment/revision.go`
- Deployment repositories under `backend/repo`

### Layer 11: Standalone Deployment Runtime

Loads a published bundle and reconstructs the execution stack without depending on editable Studio state.

It is responsible for:

- Bundle, hash, environment, provider, and tool validation.
- Binding a deployment identity to its local data.
- SQLite-backed runtime persistence.
- Local memory and scratchpad storage.
- Health, readiness, authentication, and graceful shutdown.
- Serving the reduced deployment API.

Primary locations:

- `backend/runtime`
- `backend/deployment/reader.go`
- `backend/repo/sqliterepo`

### Layer 12: Composition, Configuration, and Process Lifecycle

Chooses concrete implementations and wires the system together. This is where interfaces become actual MongoDB repositories, SQLite repositories, LLM clients, tools, dispatchers, handlers, and HTTP servers.

Primary locations:

- `backend/main.go`
- `backend/runtime/main.go`
- `backend/runtime/app.go`
- `backend/db`
- Environment-variable readers throughout the backend

### Layer 13: Verification and Test Architecture

Provides confidence that the layers honor their contracts independently and when composed.

The repository contains:

- Unit tests.
- Repository conformance tests.
- Integration tests.
- End-to-end streaming tests.
- Concurrency and cancellation tests.
- Checkpoint and resume tests.
- Deployment bundle and publication tests.
- Runtime lifecycle and recovery tests.

Primary locations:

- `_test.go` files beside their packages
- `backend/integration`
- `backend/repo/conformancetest`

## Recommended Learning Sequence

We will study the backend in this order:

1. Domain model and vocabulary.
2. One complete request-to-result execution trace.
3. Context construction and conversation compaction.
4. Agent runtime and checkpoints.
5. Tool construction and execution.
6. LLM provider abstraction.
7. Delegation, asynchronous jobs, and cancellation.
8. Memory and scratchpads.
9. Persistence contracts and adapters.
10. HTTP handlers, authentication, and streaming.
11. Publication and deployment artifacts.
12. Standalone runtime composition.
13. Startup, shutdown, configuration, and operational behavior.
14. Test architecture and remaining risks.

This order deliberately postpones deployment until its inputs are understood. A deployment bundle freezes an agent graph, but understanding what it freezes requires understanding agents, tools, context, runtime state, delegation, and persistence first.

## Standard Chapter Structure

Each layer will be documented using the following structure. Sections that genuinely do not apply will say why instead of disappearing silently.

### 1. Layer Overview

A short description of the layer and its place in the whole system.

### 2. Problem Being Solved

- What underlying problem exists?
- Why can the neighboring layers not solve it alone?
- What would become unsafe, duplicated, or coupled without this layer?

### 3. First-Principles Mental Model

The simplest accurate model of the layer before package names and implementation details are introduced.

### 4. Terminology

Definitions of every term needed for the chapter, including distinctions between similar concepts.

### 5. Responsibilities and Non-Responsibilities

- What the layer owns.
- What it deliberately delegates elsewhere.
- Which invariants must be enforced here.

### 6. Important Types, Interfaces, and Functions

For each important construct:

- What it represents.
- Why it exists.
- Who creates it.
- Who consumes it.
- How long it lives.
- What state it owns.
- Important fields and methods.

### 7. Dependency and Component Relationships

Explains dependency direction and why the relationships are arranged that way.

### 8. Control Flow

Step-by-step execution paths for normal operation, including relevant branches.

### 9. Data Flow and State Transitions

Explains what data is created, transformed, persisted, streamed, or discarded at each step.

### 10. Concurrency and Lifecycle

Explains goroutines, channels, locks, ownership, cancellation, startup, cleanup, and possible races where applicable.

### 11. Failure and Recovery Behavior

Explains errors, partial failures, retries, idempotency, checkpoints, resumption, and which component owns terminal state.

### 12. Security and Trust Boundaries

Explains authentication, authorization, ownership checks, secrets, untrusted input, external calls, filesystem access, and isolation.

### 13. Concrete Examples

Includes realistic scenarios, simplified inputs and outputs, pseudocode, timelines, or state tables.

### 14. Alternatives and Trade-Offs

Explains plausible alternative designs, their costs, and why the current design is appropriate or questionable under present constraints.

### 15. Tests and Guarantees

Maps important tests to the behaviors they demonstrate and records what remains unverified.

### 16. Source Navigation Map

Provides an efficient reading path through the relevant files.

### 17. Summary and Learning Checkpoint

Ends with the transferable mental model, key invariants, and one focused question when active recall would be useful.

## Chapter 1: Domain Model and Vocabulary

### 1. Layer Overview

The domain-model layer gives precise names to the things AgentFlow creates, stores, executes, coordinates, and deploys. These names are not merely labels for database documents. Each one represents a different responsibility, lifecycle, and ownership boundary.

The shortest accurate mental model is:

> An **Agent** is reusable configuration. A **Thread** is an ongoing conversation. A **Message** is one durable part of that conversation. A **Run** is one execution of an agent. A **Checkpoint** is saved runtime state that can continue that run. A **Task** governs the whole tree of work started by one root run. A **Job** is one durable asynchronous delegation. A **Deployment Revision** freezes mutable agent configuration into an immutable artifact.

The domain concepts fall into six related groups:

| Group | Concepts | Question answered |
| --- | --- | --- |
| Agent definition | Agent, delegate configuration, tool, MCP server | What is this agent configured and allowed to do? |
| Conversation | Thread, subthread, message, summary | What conversation history exists? |
| Execution | Run, attempt, step, checkpoint, invocation kind | What execution is happening, and can it recover? |
| Work orchestration | Task, job, callback, originator, parent | How is delegated and asynchronous work controlled? |
| Deployment | Bundle, deployment, revision, deploy state | Which immutable configuration should a runtime execute? |
| Memory | Memory scope, memory document, memory revision | What durable knowledge can an execution access? |

These concepts interact during a request, but they must not be treated as interchangeable.

### 2. Why These Distinctions Exist

An AI-agent backend has several kinds of state with very different lifetimes:

- Agent configuration can be edited and reused for months.
- A conversation may contain many user turns.
- One execution may last seconds or may be resumed after a failure.
- Delegated work may continue after its parent stops actively running.
- A production deployment must remain stable even when Studio configuration changes.
- Long-lived memory must survive beyond one conversation or process.

Putting these concerns into one object would couple unrelated lifecycles. For example, storing live execution state on an `Agent` would cause simultaneous runs of that agent to interfere with one another. Treating a thread as a run would make it difficult to represent multiple turns and resume one failed turn. Treating mutable Studio configuration as a deployment would allow production behavior to change without a deliberate publication.

The model therefore separates:

```text
definition       Agent
conversation     Thread -> Messages
execution        Run -> Attempts -> Steps -> Checkpoints
task tree        Task -> Jobs -> Child Runs / Callbacks
deployment       Bundle -> Immutable Revision -> Mutable Selection
knowledge        Memory Lineage -> Memory Revisions
```

### 3. Agent

An `Agent` is reusable configuration describing how an LLM-powered worker behaves. Its central storage-neutral type is defined in `backend/agent/agent.go`.

It includes:

- Identity: ID, name, and description.
- Model selection: provider and model.
- Behavior: system prompt.
- Capabilities: built-in tools, delegates, and MCP servers.
- Context controls: recent-history window, keep ratio, and optional summarization model.
- Execution limits: maximum steps, tokens, temperature, and task-tree runs.
- Creation time.

An agent is not a running process, conversation, request, job, or deployment revision. One agent can participate concurrently in many threads and runs.

A useful analogy is:

```text
Agent = job description and operating manual
Run   = one shift performed using that manual
```

#### Agent defaults

The current domain defaults include:

- Maximum steps: 25.
- Recent context window: 6 turns.
- Context keep ratio: 0.5.
- Temperature: 0.7.
- Maximum output tokens: 4096.
- Maximum runs in one task tree: 50.
- Maximum delegation depth: 5.

Defaults are resolved during authoring and again when configuration is frozen for deployment. A bundle should contain effective values rather than acquire new behavior merely because application defaults change later.

#### Studio persistence

Studio stores authored agents in MongoDB. The repository adapter translates between:

- `model.AgentDocument`, which contains MongoDB/BSON persistence details.
- `agent.Agent`, which is consumed by storage-neutral runtime code.

The public agent ID is a hexadecimal rendering of MongoDB's `ObjectID`, but runtime packages treat it as an opaque string. This prevents MongoDB-specific types from spreading through the execution core.

#### Validation boundaries

The authoring HTTP handler checks required fields, registered tools, duplicates, positive limits, delegate ownership, delegate-name collisions, self-delegation, MCP aliases, and MCP URLs.

Publication validates the complete reachable graph again. This duplication is intentional boundary defense: the publisher cannot safely assume every stored document was written by the latest handler or was never corrupted or migrated.

### 4. Delegates and the Agent Graph

A delegate configuration exposes another agent to the current LLM as a callable tool. It contains:

- The target agent ID.
- A provider-safe tool name.
- A description shown to the model.
- Optional instructions.

For example:

```text
Agent: travel_planner
Delegate target: flight_researcher
Tool exposed to planner: find_flights
```

The planner does not change identity when it calls `find_flights`. The tool invocation creates or dispatches a separate execution of `flight_researcher`, and the result is delivered back to the planner.

Delegate relationships form a directed graph:

```text
travel_planner
├── flight_researcher
└── hotel_researcher
    └── location_researcher
```

An edge `A -> B` means that Agent A is configured to delegate to Agent B.

Publication walks the graph from a root agent and rejects missing, cross-owner, self-referential, or cyclic relationships. Runtime also protects execution with cycle and depth checks. Publication validation protects the artifact; runtime validation protects live execution.

### 5. Thread, Subthread, Message, and Summary

#### Thread

A `Thread` is the durable container for an ongoing conversation. It records the owning user, selected agent, title, summary, metadata, and timestamps.

A thread can contain many executions:

```text
Thread T
├── Run R1: first user turn
├── Run R2: follow-up
└── Run R3: another follow-up
```

This is why a thread is not a run. The thread supplies conversational continuity; each run supplies an independently observable and recoverable execution lifecycle.

User-facing thread reads are scoped by both thread ID and user ID. Possessing an identifier does not by itself grant access.

#### Subthread

A subthread is an internal conversation for a delegated agent. It uses `kind == "sub"` and is excluded from normal user-facing thread listings.

One subthread exists per:

```text
(user ID, originator run ID, target agent ID)
```

This lets repeated calls to the same delegated agent retain continuity during one overall task without mixing internal delegated exchanges into the root user-facing thread or leaking them into another root task.

MongoDB enforces this identity with a partial unique index. The find-or-create operation is atomic from the caller's perspective: if two requests race, one creates the record and the other reads the winner. A separate read followed by an insert would not provide that guarantee.

#### Message

A `Message` is one durable transcript item within a thread. It can represent user input, assistant output, an assistant tool request, or a tool result.

Messages preserve role, content, tool-call identity, tool name, structured tool calls, metadata, and timestamp. Repository conformance tests establish that messages are thread-scoped, chronologically returned, and retain tool metadata.

#### Thread summary

A thread summary is a compressed representation of older conversation history used when building model context.

It is not:

- A replacement for durable messages.
- A run checkpoint.
- A final answer.

The three concepts have different purposes:

| Concept | Purpose |
| --- | --- |
| Messages | Durable detailed transcript |
| Summary | Compact conversational context |
| Checkpoint | Resumable execution state |

### 6. Run, Attempt, Step, and Status

#### Run

A `Run` is one concrete execution of an agent. A new user message normally receives a UUID run ID before dispatch begins.

The durable run index records:

- Run, thread, agent, and user identity.
- Current status.
- Attempt number and steps completed.
- Last error.
- Originator and parent run identity.
- Invocation kind.
- Associated asynchronous job, if any.

MongoDB also gives the document an internal `_id`, but `run_id` is the unique domain identity shared by runtime, logs, events, checkpoints, jobs, and APIs.

#### Attempt

An attempt is one execution effort under the same run identity:

```text
fresh execution: run R1, attempt 1
first resume:    run R1, attempt 2
second resume:   run R1, attempt 3
```

The run ID remains stable because the same logical execution is continuing. The attempt increments monotonically so logs and events can distinguish separate execution efforts.

#### Step

A step is one model/tool-processing iteration. At a high level, the runtime prepares model input, receives a response, possibly executes tools, records results, and checkpoints progress.

`MaxSteps` protects one run from infinite tool loops and unbounded model cost. It is different from the task-wide run budget: one controls iterations inside a run; the other controls how many runs the whole delegation tree may create.

#### Run statuses

The durable statuses are:

```text
running
completed
failed
cancelled
resumable
interrupted
waiting_for_jobs
```

A simplified lifecycle is:

```text
created -> running -> completed
                   -> failed
                   -> interrupted -> running on resume
                   -> resumable   -> running on resume
                   -> waiting_for_jobs -> running when required jobs finish
                   -> cancelled
```

Important meanings:

- `running`: execution is actively owned or claimed.
- `completed`: a successful final result was produced.
- `failed`: execution cannot safely continue, or no usable checkpoint exists.
- `interrupted`: execution stopped after a checkpoint existed.
- `resumable`: a recoverable failure occurred and a checkpoint exists.
- `waiting_for_jobs`: the parent is durably waiting without occupying an active execution worker.
- `cancelled`: the run or wider task tree was cancelled.

Resume ownership uses atomic compare-and-set. A transition succeeds only if the stored status still equals the expected source status. This prevents two concurrent resume requests from both taking ownership.

**Architectural observation:** the intended state machine is distributed across runtime code, handlers, coordinators, repositories, and conformance tests. Important ownership transitions use compare-and-set, but the general `UpdateStatus` repository method accepts a status string rather than enforcing a centralized transition table.

### 7. Checkpoint and Snapshot

A checkpoint is a persisted `RunSnapshot`: enough runtime state to continue a run rather than restart it from the beginning.

It contains:

- Snapshot schema version and run ID.
- Conversation messages and raw summary.
- Steps completed and configured maximum.
- Accumulated token usage.
- Tool failure counters.
- Pending job awaits.
- Agent, thread, provider, and model identity.
- Effective tool-set identity.
- Attempt and runtime phase.
- Delegation lineage and invocation kind.
- Job ID and injected system context.

Snapshots are serialized as JSON and compressed with gzip.

#### Run index versus snapshot

The lightweight run document supports frequent lifecycle queries:

```text
R1: resumable, attempt 1, step 4, last error timeout
```

The larger snapshot supports reconstruction:

```text
messages, summary, usage, failures, pending awaits,
tool-set identity, phase, lineage, system context, ...
```

Keeping them separate avoids rewriting a large compressed payload for every status update, permits multiple checkpoints per run, and gives checkpoints an independent retention policy.

Checkpoints are append-only. Loading selects the highest completed step, breaking ties by newest creation time. Therefore, a delayed write of an older step cannot shadow later progress.

Recorded phases include `pre_model`, `post_model`, `step.completed`, and `waiting_for_jobs`. Step count alone is insufficient to know whether the runtime had already received a model response, executed tools, or started awaiting work.

#### Resume compatibility

The runtime validates a snapshot against the current effective tool set. Structural drift can block resume because the saved state may no longer be interpretable. Cosmetic drift produces a warning rather than necessarily failing.

Remote MCP discovery is deliberately excluded from strict resume identity. A temporarily unavailable MCP server degrades capabilities without automatically invalidating all saved runs.

MongoDB schedules checkpoint expiry after terminal outcomes. Completed-run checkpoints are retained for approximately seven days; failed, cancelled, or interrupted-run checkpoints are retained for approximately thirty days.

### 8. Invocation Kind and Delegation Lineage

A run records why it exists:

| Invocation kind | Meaning |
| --- | --- |
| `top_level` | Direct user-triggered execution |
| `sync_delegate` | Child execution called synchronously as a delegate tool |
| `async_job` | Child execution created by the durable job coordinator |
| `callback` | Follow-up execution after a background job finishes |

Delegated runs form a tree. For this tree:

```text
R0 root
└── R1 child
    └── R2 grandchild
```

`R2` has:

```text
originator_run_id = R0
parent_run_id     = R1
```

The parent identifies the immediate caller. The originator identifies the whole task tree and is used for cancellation, run budgets, concurrency controls, subthread identity, and operational correlation.

The delegation chain stores the ordered agent IDs already visited. Delegation depth stores how many levels have been traversed. The chain prevents revisiting an agent; the depth limit also bounds unusually deep but acyclic graphs.

### 9. Task and Run Budget

In this repository, `Task` does not mean a user todo item or a single queue job. It is the durable control ledger for the entire execution tree rooted at one originator run.

It stores:

- Originator run and user identity.
- Maximum runs and runs already consumed.
- Idempotency keys for budget consumption.
- Cancellation time and reason.
- Timestamps.

The task is uniquely keyed by `originator_run_id`.

#### Why a tree-wide budget is necessary

`MaxSteps` limits one run, but every child run receives its own step allowance. Without a tree-wide limit, an agent could repeatedly create delegates and callbacks even though no individual run exceeded its step limit.

Budget consumption is atomic: usage increments only while `runs_used < max_runs`. Shared conformance tests verify that when one slot remains, exactly one concurrent caller receives it.

Consumption is also idempotent by a budget key. Retrying the same logical dispatch does not charge the task twice. The first task creation owns `max_runs`; later retries do not silently reset its cap or usage.

Cancellation is task-scoped because stopping only the root run would not stop descendants already queued or running. Coordinators consult the originator task before launching jobs, resuming parents, or starting callbacks.

### 10. Synchronous Delegation, Job, and Callback

#### Synchronous delegation

A configured delegate is synthesized as a normal model-visible tool. When invoked, it starts a child run, waits for that run, and returns the child's final output as a tool result to the parent. This is appropriate when the parent immediately needs the result, but the parent remains logically blocked while the child works.

#### Asynchronous job

A `Job` is a durable asynchronous work request. It records the parent and originator runs, parent thread and agent, target agent, original tool-call ID, task text, mode, lineage, child run and thread, lease ownership, result, delivery state, and callback state.

The main lifecycle is:

```text
queued -> starting -> running -> succeeded | failed | cancelled
```

A job is idempotent by `(parent_run_id, tool_call_id)`. Its ID is deterministically derived from those values. Replaying the same tool call returns the existing job. The current established behavior is that a replay with a different payload but the same idempotency key still returns the original job; the new payload is ignored rather than treated as a conflict.

Jobs have two modes:

- `required`: the parent must obtain the result before its final answer. It checkpoints and may enter `waiting_for_jobs` until the coordinator resumes it.
- `background`: the parent may finish immediately. Completion later triggers a callback run in the original conversation.

#### Distributed ownership

Multiple coordinator instances may observe the same work. Claims, leases, and locks coordinate ownership:

- A claim atomically assigns a queued job attempt.
- A lease allows recovery after an owner crashes.
- Admission and target locks serialize concurrency-sensitive decisions.
- Callback-thread locks prevent overlapping callbacks in one parent thread.

Terminal writes are fenced by the legitimate child or callback run ID. Repository methods return both `error` and `applied`. `error == nil` with `applied == false` means a stale worker lost ownership and must not overwrite or double-report the outcome.

#### Callback

A callback is a new run of the original parent agent in the original parent thread, with system context describing the background result. Its invocation kind is `callback`.

Job and callback lifecycles are independent. A background job can succeed even if notifying the user later fails:

```text
job status      = succeeded
callback status = failed
```

The callback lifecycle is tracked separately as `none`, `queued`, `running`, `completed`, `failed`, or `cancelled`. Preserving both outcomes makes recovery and operational diagnosis possible.

### 11. Deployment Vocabulary

#### Deployment ID

The current publisher uses the root agent ID as the deployment ID. Conceptually, it identifies the publishable graph rooted at that agent.

#### Bundle

A bundle is the complete serialized deployment artifact. It contains the schema version, deployment and root-agent identity, platform XML, frozen reachable agents, and configuration hash.

The standalone runtime reconstructs read-only runtime agents from the bundle rather than consulting mutable Studio agent documents.

#### Revision

A deployment revision is one immutable stored version of a bundle. Revision numbers increase per `(user, deployment)`. The configuration hash identifies bundle content but is not revision identity: two different revision records may intentionally contain the same canonical configuration. Request idempotency is handled separately by an idempotency key.

#### Deploy state

Deploy state is the mutable control-plane aggregate for one owned deployment:

```text
Revision            = immutable configuration artifact
Desired generation  = what should run or be deleted
Observed state      = what a controller has verified
Reconcile state     = due work, attempts, claims, leases, and fencing
```

Separating immutable revisions from mutable desired/observed state preserves publication history while allowing deployment intent and infrastructure evidence to evolve safely.

#### Stable publication

Publication performs an optimistic two-pass snapshot:

1. Walk and freeze the reachable agent graph.
2. Reload every observed agent.
3. Compare its deployable representation.
4. Retry the whole snapshot if anything changed.
5. Validate, hash, serialize, round-trip parse, and append a revision only after convergence.

Without this process, one bundle could combine agents captured at different moments and represent a configuration that never existed consistently. Publication is not a database-wide lock; after a limited number of unstable attempts, it fails rather than publishing a torn snapshot.

### 12. Memory Vocabulary

Memory is long-lived knowledge, separate from thread messages and run checkpoints.

Every execution carries a `MemoryScope` containing user, agent, and thread IDs. Memory entries themselves may have `thread`, `agent`, or `user` scope.

Visibility expands as follows:

```text
thread search -> thread memories
agent search  -> agent + thread memories
user search   -> user + agent + thread memories
```

The scope is an addressing and visibility boundary. The value carried through Go's `context.Context` is transient propagation metadata; it is not the durable memory store.

A memory document contains identity, type, scope, importance, revision, expiry/retirement state, summary, body path, and body content. Types include fact, preference, procedure, and episode.

Memory mutations append revisions for operations such as create, patch, update, retire, and restore. Expected revision provides optimistic concurrency; run ID, tool-call ID, and mutation ID provide attribution and idempotency.

Deployment revision and memory revision use the same word but version different things:

- Deployment revision: a frozen agent graph.
- Memory revision: one change in a memory item's lineage.

### 13. Complete Example

Suppose the user says:

> Research flights and hotels for my trip. You can send hotel details later.

The resulting domain structure may be:

```text
User U
└── Thread T0, owned by root Agent A0
    └── Run R0, attempt 1, invocation=top_level
        ├── Task ledger keyed by originator R0
        ├── required Job J1 -> flight Agent A1
        │   ├── subthread ST1
        │   └── child Run R1, invocation=async_job
        └── background Job J2 -> hotel Agent A2
            ├── subthread ST2
            ├── child Run R2, invocation=async_job
            └── callback Run R3
                ├── original Agent A0
                ├── original Thread T0
                └── invocation=callback
```

The lifecycle is:

1. The API verifies ownership of `T0`.
2. It creates UUID run `R0` with attempt 1 and status `running`.
3. The task ledger establishes the tree-wide run budget.
4. Required job `J1` consumes an idempotent budget slot.
5. The coordinator creates subthread `ST1` and child run `R1`.
6. When `R0` awaits `J1`, it checkpoints and becomes `waiting_for_jobs`.
7. `R1` completes and `J1` becomes `succeeded`.
8. The coordinator atomically claims `R0`, changes it back to `running`, and increments its attempt.
9. `R0` resumes from its checkpoint rather than replaying from the beginning.
10. Background job `J2` can outlive `R0`'s immediate answer.
11. When `J2` finishes, callback run `R3` starts in `T0` and converts the result into a user-facing follow-up.
12. `J2` remains successful even if `R3` later fails.

### 14. Important Boundaries

| Do not confuse | Why |
| --- | --- |
| Agent and run | Reusable configuration versus one execution |
| Thread and run | Long-lived conversation versus one execution lifecycle |
| Message and checkpoint | Transcript item versus resumable runtime state |
| Summary and checkpoint | Compressed conversation context versus execution recovery |
| Step limit and run budget | Iterations inside one run versus runs across the whole tree |
| Task and job | Whole-tree control ledger versus one asynchronous work item |
| Parent and originator | Immediate caller versus root task identity |
| Job outcome and callback outcome | Work completion versus user-notification completion |
| Authored and bundled agent | Mutable Studio state versus frozen deployment state |
| Revision and deploy state | Immutable artifact versus mutable selection pointer |
| Memory scope and memory document | Execution visibility identity versus durable knowledge |

### 15. Concurrency, Failure, and Security Guarantees

**Confirmed concurrency guarantees:**

- Run status claims are atomic compare-and-set operations.
- Run attempt numbers increase atomically and monotonically.
- Subthread creation converges under concurrent calls.
- Task-budget consumption is atomic and idempotent.
- Async dispatch is idempotent by parent run and tool-call identity.
- Job and callback terminal writes are fenced against stale attempts.
- Only one competing callback/job claim is accepted where repository contracts require it.

**Failure boundaries:**

- A run may be recoverable only if an appropriate checkpoint exists.
- A required async job can suspend its parent without losing parent state.
- A worker crash is recovered through lease expiry and reclamation.
- A callback failure does not rewrite a successful job outcome.
- Publication refuses an unstable or invalid graph rather than producing a questionable artifact.

**Security and trust boundaries:**

- User-facing repository operations scope records to their owner.
- Delegate authoring requires same-user ownership.
- Memory visibility is constrained by execution scope.
- Mutable MCP configuration stores only an AgentFlow catalog `server_id`; runtime connections contain no MCP credential field.
- Published bundles validate graph structure, providers, tools, server references, and size before use.

### 16. Tests and Evidence

The shared repository conformance suites define observable behavior that both MongoDB and SQLite adapters are expected to honor. They cover, among other things:

- Run identity, lineage, atomic status transitions, monotonic attempts, and latest-checkpoint ordering.
- Concurrent resume claims with exactly one winner.
- Atomic task-budget caps and replay-safe budget keys.
- Idempotent async job dispatch.
- Required-job waiting and delivery behavior.
- Job/callback claim ownership, fencing, and independent outcomes.
- Concurrent subthread convergence.
- User-facing exclusion of delegated subthreads.
- Chronological, thread-scoped message persistence with tool metadata.

No tests were executed while writing this chapter. These guarantees were established by reading the implementation and existing tests, not by performing a fresh validation run.

### 17. Source Navigation Map

Read this layer in the following order:

1. `backend/agent/agent.go` — agent configuration and transient run context.
2. `backend/agent/records.go` — storage-neutral thread, message, and job records.
3. `backend/agent/checkpoint.go` — snapshots, phases, resume compatibility, and run-store contract.
4. `backend/agent/async_jobs.go` — job modes, statuses, callback statuses, and async contracts.
5. `backend/runtimectx/context.go` — memory and delegation propagation values.
6. `backend/model` — MongoDB persistence documents and status values.
7. `backend/repo/conformancetest/conformancetest.go` — cross-adapter behavioral guarantees.
8. `backend/repo/mongorepo/thread_repo.go` — atomic subthread identity.
9. `backend/repo/mongorepo/run_repo.go` — run/checkpoint persistence and status claims.
10. `backend/repo/mongorepo/task_repo.go` — task budget and cancellation.
11. `backend/repo/mongorepo/job_repo.go` — async idempotency, waiting, leasing, and fencing.
12. `backend/publisher/service.go` and `backend/deployment` — graph freezing and deployment vocabulary.
13. `backend/memory` — memory documents, scopes, and revision lineage.

### 18. Chapter Summary

The transferable lesson is to model state according to responsibility and lifecycle rather than convenience. AgentFlow separates editable definition, durable conversation, one execution, recoverable runtime state, tree-wide coordination, individual background work, immutable release artifacts, and durable knowledge because each changes for a different reason and requires a different consistency guarantee.

When analyzing later layers, always ask:

> Which identity owns this behavior: agent, thread, run, originator task, job, deployment revision, or memory lineage?

Choosing the wrong identity usually produces the wrong persistence, concurrency, or recovery behavior.

## Chapter 2: Context Construction and Conversation Management

### 1. Layer Overview

The context-construction layer decides what one model call can see. The backend knows more than can or should fit into an LLM request: platform policy, editable agent instructions, tool guidance, durable messages, summaries, several memory scopes, scratchpad artifacts, delegation state, callback context, runtime progress, and MCP availability. This layer selects, orders, escapes, bounds, and sometimes compresses those sources into one provider request.

The central mental model is:

```text
All durable and live backend state
              |
              | select, order, summarize, cap, escape
              v
The bounded view shown to this particular model call
```

Context is therefore a projection of backend state, not the backend's complete state and not merely a concatenated prompt string.

### 2. Why This Layer Exists

Neighboring components own different concerns:

- Repositories load threads, messages, and memory metadata.
- `RunPreparer` resolves ownership and prepares fresh or resumed execution input.
- Tool construction determines actual callable capabilities.
- The runtime decides when to call the model.
- Provider adapters translate the internal request into provider-specific HTTP.
- `ContextBuilder` owns what information is presented to the model and its canonical ordering.

Without one assembly policy, fresh and resumed runs could receive different instructions, providers could observe different memory rules, the prompt could describe unavailable tools, compaction could separate tool results from their calls, and prompt-prefix caching would be easily defeated.

### 3. End-to-End Context Flow

For a fresh run:

```text
Thread + Agent + newest persisted messages
                    |
                    v
              RunPreparer
                    |
                    +-- verify thread ownership and agent match
                    +-- group messages into user-led turns
                    +-- estimate the system-message cost
                    +-- decide whether to compact
                    +-- retain recent turns
                    +-- start best-effort summary maintenance
                    |
                    v
               RunContext
                    |
                    +-- retained history and current input
                    +-- stored thread summary
                    +-- memory scope
                    +-- delegation and callback state
                    |
                    v
               AgentRuntime
                    |
                    +-- build the effective tool set
                    +-- discover MCP tools
                    +-- record unavailable MCP aliases
                    |
                    v
              ContextBuilder
                    |
                    +-- assemble the system message
                    +-- append history and current input
                    |
                    v
          Canonical message sequence
                    |
                    +-- retained intact for checkpoints
                    |
                    v
        Display-only provider rendering
                    |
                    v
               LLM provider
```

### 4. Final Provider Request Shape

The internal `llm.ChatRequest` contains the model, messages, structured tool definitions, temperature, and maximum output tokens. The first message is one generated `system` message:

```text
SYSTEM MESSAGE
├── <platform>...</platform>
├── <agent>...</agent>
├── <tool_instructions>...</tool_instructions>
├── <user_preferences>...</user_preferences>
├── <context>
│   ├── <state>...</state>
│   ├── <system_context>...</system_context>
│   ├── <summary>...</summary>
│   └── <memories><index>...</index></memories>
│   </context>
├── <collaboration>...</collaboration>
├── <scratchpad>...</scratchpad>
└── <mcp_status>...</mcp_status>

CONVERSATION TAIL
├── retained user turn
├── its assistant and tool messages
├── later retained turns
└── current user input
```

Optional empty blocks are omitted. The XML-like tags are model-facing organization; the completed string is not parsed as XML by AgentFlow.

### 5. Static Prefix and Dynamic Suffix

The system message deliberately begins with a stable prefix:

```text
<platform>
<agent>
<tool_instructions>
```

Provided the platform, agent, and effective instructed tools have not changed, these bytes remain stable across model calls. This permits provider prompt-prefix caching, reducing repeated processing cost and latency.

Per-run values appear afterward in the dynamic suffix:

```text
<user_preferences>
<context>
<collaboration>
<scratchpad>
<mcp_status>
```

Tests verify that collaboration, scratchpad, and MCP status do not perturb the static prefix. Changing actual agent/tool configuration is expected to change the prefix.

### 6. Platform and Agent Instructions

`backend/platform.xml` is loaded once at process startup and emitted verbatim. It defines AgentFlow-wide capability descriptions, safety rules, secret handling, destructive-action confirmation, treatment of retrieved data as untrusted, and the meanings of memory, summary, and state blocks.

The agent's authored system prompt is then emitted inside `<agent>`. Its text is escaped for `&`, `<`, and `>` so an authored string cannot close the wrapper structurally. Platform policy is intended to outrank agent instructions.

### 7. Tool Definitions and Tool Instructions

Tool information travels through two paths:

1. Name, description, and JSON parameter schema are passed as structured `ChatRequest.Tools`.
2. Optional human-readable `Instructions` are excluded from that JSON and emitted inside `<tool_instructions>`.

The builder receives definitions from the run's effective tool set, not the global registry, so it describes only tools that the model can actually call. That effective set may contain registered tools, synthesized delegate tools, async tools, and discovered MCP tools. MCP tools currently contribute no instruction text, so discovery does not alter the cached prefix.

### 8. User Preferences

Active user-scoped memory bodies are inserted in full inside `<user_preferences>`. User scope deliberately crosses agent boundaries: a preference written while using one agent can guide another agent belonging to the same user.

Preferences are ordered by most recent explicit read, then creation time, then ID. Automatic injection does not stamp `LastReadAt`; otherwise appearing in context would reinforce the same entries forever.

The block is bounded by:

- 25 preferences.
- 1,000 runes per body.
- Approximately 4,000 rendered characters in total.
- An explicit notice when additional memories are elided.

Failure to query memory metadata fails context construction. Failure to read an individual preference body skips that preference so one corrupt file does not stop the run.

Because these bodies are inserted in a system-role message, they have strong prompt influence. Structural XML escaping prevents tag-breaking but cannot neutralize malicious natural-language instructions. The platform prompt explicitly says retrieved content is untrusted and must not override platform rules.

### 9. Runtime State and System Context

The always-present `<state>` block carries current/max step, phase, last action when known, current date, thread ID, and run ID. Before every model call, the runtime updates live step/phase/action values and rebuilds the system content. This helps the model avoid repeating completed or failed actions and reason about its remaining execution budget.

`RunContext.SystemContext` is a platform-supplied instruction for executions that may not have a fresh user message. A background-job callback uses it to explain the completed job and instruct the parent agent to continue the original conversation. Empty current input is omitted rather than converted into an empty user message.

### 10. Conversation Summary

`Thread.Summary` is a lossy, model-generated representation of older turns no longer kept in full. Fresh runs use the thread's current summary. Resumed runs use `snapshot.State.RawSummary`, preserving consistency with the checkpoint rather than silently adopting a later summary.

The summarizer combines the previous summary with newly dropped turns and asks the configured provider to preserve names, preferences, facts, decisions, and conclusions while discarding filler, raw tool output, and intermediate reasoning. It uses `SummarizationModel` when configured, otherwise the agent model; temperature is zero, output allowance is 2,048 tokens, and the prompt requests at most 300 words.

Assistant tool-call messages are reduced to tool names and tool-result excerpts are limited to about 200 runes before summarization. The durable messages remain the detailed record; the summary is a compact aid and may be incomplete or inaccurate.

### 11. Memory Index

Agent- and thread-scoped memories are not injected in full. Up to 15 entries are rendered as IDs, scopes, and short previews under `<memories><index>`. The model calls `memory_read` for full bodies.

This index/payload split bounds automatic context growth while preserving discoverability. Entries use the same recent-explicit-read ordering as preferences. User-scoped memories are excluded here because they are rendered separately as full preferences.

### 12. Collaboration, Scratchpad, and MCP Status

A delegated run receives `<collaboration>` when it has a parent run and the scratchpad service is configured. The block identifies parent and originator runs, states the delegated task, and explains the shared workspace. On resume, the task falls back to the first user message in the checkpoint.

Scratchpad contents are never injected automatically. A non-empty task workspace produces only a file-count pointer telling the model to browse through scratchpad tools. This prevents large or irrelevant artifacts from occupying every prompt. Scratchpad counting errors degrade silently to zero files, so empty and temporarily unreadable are indistinguishable to the model.

MCP tools are discovered at run start. An unavailable server does not fail the run; its tools are absent and a dynamic `<mcp_status>` note tells the model to proceed without them.

### 13. Fresh Versus Resumed Context

For a fresh run, `ContextBuilder.Build` produces:

```text
generated system message
+ retained persisted history
+ non-empty current user input
```

For resume, it produces:

```text
newly generated system message
+ checkpoint.State.Messages
```

The snapshot already contains original input, assistant messages, tool calls, and tool results, so fresh input/history must not be appended again.

The execution history is restored, but the environment is reconstructed. A resumed run can observe a new date, preferences, memory index, scratchpad count, MCP availability, agent prompt, or platform configuration. Tool-set structural compatibility is checked, but the entire original system prompt is not frozen. Resume therefore means continuation of canonical execution history under the currently reconstructed environment, not bit-for-bit prompt replay.

### 14. Canonical Versus Provider-Rendered History

The runtime keeps a canonical message slice containing complete tool results. That slice is mutated by the runtime and stored in checkpoints. Immediately before a provider call, `RenderForLLM` copies it and truncates only tool-role content beyond 4,000 runes, adding an explicit marker.

This separation is critical. If the checkpoint stored only the shortened display form, a later resume would permanently lose the full tool evidence. Prompt-size optimization therefore changes presentation, not recoverable state.

### 15. Turns and Structural Compaction

Persisted messages are grouped into user-led turns:

```text
Turn
├── one user message
└── all following assistant/tool messages until the next user message
```

Compaction moves whole turns. Dropping arbitrary messages could leave a tool result without the assistant tool call that created it or an answer without its question. Messages before the first user in the loaded window are discarded to restore structural validity.

The preparer loads the newest 500 messages in chronological order. Because this limit can begin in the middle of an old turn, leading assistant/tool messages may be discarded. This is structurally safer but can omit information if the stored summary does not already cover it.

### 16. Token Budget and Compaction Formula

Context sizing uses an approximate four-characters-per-token heuristic. The model limit comes from the resolved agent catalog value, a built-in model map, or a 16,000-token fallback.

Compaction triggers when:

```text
estimated system tokens + estimated persisted-history tokens
>= ceil(model context limit × 0.85)
```

When triggered, retained history targets:

```text
history budget = model limit × ContextKeepRatio - system tokens
```

The default keep ratio is 0.5. Triggering at 85% but reducing toward 50% creates hysteresis and leaves room for later turns, tool results, and output.

Example:

```text
model limit              100,000
trigger                    85,000
50% keep target            50,000
system estimate            10,000
retained-history budget    40,000
```

The algorithm walks backward from the newest turn until another turn would exceed the budget.

`ContextWindow` is misleadingly named: it is the minimum number of recent turns retained, not the model's token capacity. The default floor is six turns. Those turns remain even when they exceed the computed budget, and the current caller does not perform a later hard-fit pass.

### 17. Background Summarization Lifecycle

When compaction drops turns:

1. The current run immediately receives only the retained turns.
2. A process-local `sync.Map` suppresses another summarizer for that thread in the same process.
3. A goroutine uses a 30-second timeout derived from application background context, so it may outlive the HTTP request.
4. The summarizer retries provider failure up to three times with approximately one- and four-second backoffs, while honoring cancellation.
5. A successful summary is written to the thread.
6. Failures and persistence failures are logged; the active run continues.

### 18. Confirmed Asynchronous Handoff Gap

Current control flow assigns `turns = keep` before starting background summarization. The triggering run receives the previously stored summary plus recent retained turns. Newly dropped turns are absent until a later run reads the completed summary.

Example:

```text
existing summary covers turns 1-5
new compaction drops turns 6-14
active history keeps turns 15-20

triggering model call sees: summary(1-5) + turns(15-20)
temporarily missing:         turns(6-14)
```

Durable messages are not deleted, so this is not permanent storage loss. It is a context-completeness risk for the triggering answer. If summarization fails, the gap also remains in the stored summary. The active run never reloads a summary that finishes during that run.

Coordination is process-local. Multiple Studio replicas may concurrently summarize the same thread, and `UpdateSummary` has no version/CAS condition to prevent a stale completion from overwriting a newer summary. No current integration test covers this handoff.

**Confirmed behavior:** the gap and coordination properties follow directly from control flow.

**Inferred intent:** asynchronous work probably trades context completeness for lower user-facing latency, but that rationale is not recorded in the repository.

### 19. Other Budget and Correctness Limits

- The new user input is appended after compaction calculation and is not included in its trigger.
- `MaxTokens` is not explicitly subtracted as an output reserve.
- The minimum-turn floor may itself exceed the provider context limit.
- Approximate token accounting differs from provider tokenizers and is inconsistent about bytes versus runes for multibyte text.
- A system-prompt estimate failure returns zero and selects a conservative fallback heuristic.
- The preparer's estimate omits some later per-run dynamic data, especially delegated collaboration and callback system context.
- `ContextWindow` is configurable during creation but absent from the agent update request/domain patch contract.
- Studio authoring accepts some invalid runtime-limit values that publication later rejects, such as a keep ratio outside `(0,1]`.

### 20. Failure Policy

| Failure | Behavior |
| --- | --- |
| Platform configuration cannot load | Process startup fails |
| Memory metadata query fails | Context build/run fails |
| One user-memory body is unreadable | That preference is skipped |
| Scratchpad count fails | Model sees no scratchpad pointer |
| MCP discovery fails for one server | Run continues without those tools and receives a note |
| Summarization fails | Logged; active run continues |
| Summary persistence fails | Logged; active run continues |
| Live system-message refresh fails | Run fails |
| Provider rejects context size | Model call fails; recovery depends on checkpoint and error classification |

The layer treats core prompt construction as strict, external optional capabilities as degradable, and summary maintenance as best effort.

### 21. Security and Trust Boundary

The intended precedence is platform policy, agent instructions, user/runtime context, conversation, and finally retrieved/tool data. Technically, platform, agent prompt, preferences, summary, and runtime state are concatenated into one system-role message. Their hierarchy depends on ordering, labels, explicit guardrails, escaping, and model compliance rather than provider-enforced sub-roles.

Structural escaping does not neutralize semantic prompt injection. Model-generated summaries and memory bodies are reintroduced at system-message strength. Authorization and destructive-action enforcement must therefore remain in application/tool boundaries; they cannot safely rely only on the prompt.

### 22. Architectural Strengths and Concerns

Strong decisions include one builder for fresh/resumed runs, static/dynamic separation, whole-turn compaction, canonical checkpoint history, display-only truncation, bounded automatic memory injection, scratchpad discovery by pointer, and MCP graceful degradation.

Concerns worth revisiting include the asynchronous summary gap, process-local coordination, unversioned summary writes, missing hard-fit enforcement, exclusion of current input/output reserve from budgeting, approximate token accounting, misleading configuration naming, and inconsistent authoring validation.

If this layer is improved later, the simplest responsible direction would be to record which message/turn a summary covers, fence summary replacement with a version, make the triggering-run handoff explicit, and perform a final request-size check including tool schemas, current input, and output reserve.

### 23. Tests and Guarantees

Existing tests cover turn grouping, order preservation, compaction thresholds and arithmetic, minimum-turn retention, static-prefix stability, effective-tool filtering, memory ordering/caps, cross-agent user preferences, fresh/resume assembly parity for equal inputs, canonical tool-result preservation, rune-safe display truncation, collaboration context, scratchpad pointers, MCP status, and summarizer input/model selection.

They do not directly establish the asynchronous compaction handoff, cross-process summary exclusion, stale-writer protection, huge-input hard fitting, or real-provider tokenizer fit. No tests were run during this study; these conclusions come from reading source and existing tests.

### 24. Source Navigation Map

1. `backend/dispatcher/preparer.go` — fresh/resume preparation and compaction handoff.
2. `backend/agent/context.go` — turns, token estimates, trigger, and split algorithm.
3. `backend/agent/context_builder.go` — canonical prompt assembly and rendering.
4. `backend/agent/summarizer.go` — lossy summary construction and retry behavior.
5. `backend/agent/runtime.go` — live system refresh and provider call.
6. `backend/llm/llm_interface.go` — internal provider request/message/tool contracts.
7. `backend/platform.xml` — platform policy inserted into every run.
8. `backend/agent/context_test.go` — compaction guarantees.
9. `backend/agent/context_builder*_test.go` — prompt-layer guarantees.
10. `backend/agent/summarizer_test.go` — summary preprocessing and model selection.

### 25. Chapter Summary

Persistent state is everything AgentFlow knows; model context is the bounded, ordered view selected for one call. This layer balances instruction authority, relevance, finite token capacity, provider caching, and resumable canonical state. Its strongest invariant is that prompt-size presentation changes never destroy checkpoint evidence. Its most important current risk is that asynchronous summary generation temporarily removes newly compacted turns from the triggering run's view.

## Chapter 3: Agent Execution Engine

### 1. Purpose and Boundary

The execution engine turns one prepared agent invocation into a controlled sequence of model decisions, tool actions, recovery checkpoints, and observable events.

Its job is not merely to call an LLM. It must coordinate several systems whose failure and consistency models are different:

- An LLM call is remote, potentially slow, cancellable, and non-deterministic.
- A tool can read or mutate local or external state.
- Several tools requested by one model response may execute concurrently.
- A checkpoint must describe enough canonical state for a later process to continue.
- An asynchronous child job can outlive the current invocation.
- A live event stream may disappear while durable execution state remains.

The most useful mental model is therefore:

> The runtime is a resumable state machine whose transitions are driven by model responses, tool outcomes, cancellation, checkpoint durability, and asynchronous-job state.

**Confirmed:** The core implementation is `AgentRuntime.runInternal` in `backend/agent/runtime.go`. Supporting mechanics live in `tool_batch.go`, `checkpoint.go`, `events.go`, and `async_jobs.go`.

### 2. Runtime Dependencies

`AgentRuntime` is composed from the following dependencies:

- `LLMRegistry`: resolves the provider-specific client named by the agent.
- `ToolRegistry`: holds built-in tool implementations.
- `ContextBuilder`: constructs the canonical conversation and rendered system context explained in Chapter 2.
- `CheckpointStore`: optionally persists snapshots and durable run status.
- `DelegateInvoker`: executes synchronous delegated-agent tools.
- `AsyncJobStore`: dispatches, awaits, and records asynchronous delegated work.
- `MCPManager`: discovers remote MCP tools at run start.
- `ToolCapabilities`: controls which environment-dependent tool families may be exposed.

Some dependencies are installed through setters instead of the constructor because composition contains cycles: for example, the delegate invoker needs the pool manager, while the pool manager itself needs the runtime. This is a composition-time constraint rather than a domain rule.

`Run` executes with a no-op event sink. `RunStream` wraps the caller's channel in a `ChannelSink`. Both use the same internal state machine.

### 3. What a Step Means

A runtime step is counted when a model call returns successfully. Tool execution, checkpoint persistence, and event emission do not independently increment the step counter.

For example:

```text
model call 1 -> calculator request
calculator executes
model call 2 -> final answer
```

This run consumed two steps. The default maximum is 25 unless the agent overrides `MaxSteps`. Reaching the limit produces `ErrMaxStepsReached` instead of allowing an unbounded model/tool loop.

### 4. Fresh-Run Control Flow

Before the main loop, the runtime:

1. Emits `run.started`.
2. Resolves the LLM client.
3. Builds the effective tool set.
4. Performs soft-failing MCP discovery.
5. Initializes step, usage, tool-failure, and checkpoint-failure state.
6. Establishes default delegation lineage for a top-level run.
7. Asks the context builder for the initial canonical messages.

The normal loop is:

```text
save pre_model checkpoint
        |
        v
refresh dynamic system context
        |
        v
call model and increment step
        |
        +------------------------------+
        |                              |
        v                              v
 final response                   tool calls
        |                              |
check required jobs                    v
        |                    append assistant decision
        |                              |
        |                    save post_model checkpoint
        |                              |
        |                              v
        |                     validate and run tools
        |                              |
        |                              v
        |                     append ordered results
        |                              |
        |                         loop again
        v
save step.completed checkpoint
        |
        v
return completed result
```

Before every model call, the dynamic system state is rebuilt so phase, step count, and last action are current. `RenderForLLM` may further shorten presentation-only tool evidence, while canonical messages remain the recovery source.

The internal provider call is currently completion-based, not token-streaming. `model.delta` exists in the event vocabulary, but this runtime produces `model.completed` after receiving the whole response.

### 5. Final Answers Versus Tool Decisions

If a model response contains no tool calls, the runtime first checks for unfinished required asynchronous jobs. A model cannot bypass required child work by answering early. When required jobs exist, the runtime discards the premature final text and synthesizes deterministic `await_job` calls.

If no required jobs remain, the runtime:

1. Trims the response to ensure it is not empty.
2. Appends the original assistant content to canonical history.
3. Emits `step.completed`.
4. Saves a `step.completed` checkpoint.
5. Returns `RunResultCompleted` with output, new messages, steps, and token usage.

If the response contains tool calls, the assistant message containing those calls is appended before any tool runs. The runtime then saves a `post_model` checkpoint and proceeds to tool execution.

### 6. Why `post_model` Exists

Suppose a model decides to call a mutating tool:

```text
transfer_money(amount=100)
```

If the process crashes before recording this decision, recovery cannot know which action the model selected. Asking the model again is unsafe because model output is non-deterministic: it may choose different arguments or another action.

A `post_model` checkpoint records the model's exact assistant message and tool calls before their side effects begin. On resume, the runtime skips the initial model call and executes the recorded calls.

This preserves the decision, but it does not guarantee exactly-once side effects.

### 7. Checkpoint Phases and Resume Meaning

| Phase | Durable meaning | Resume behavior |
| --- | --- | --- |
| `pre_model` | Canonical state is ready for the next model decision. | Call the model normally. |
| `post_model` | The model decision is recorded, but requested side effects may not be durably reflected. | Skip the model and execute the stored tool calls. |
| `waiting_for_jobs` | Required asynchronous work remains unresolved. | Resolve awaits; wait again or append terminal job results. |
| `step.completed` | A final assistant response has been recorded by the runtime. | Normally belongs to an already completed run. |

A snapshot contains:

- Canonical non-system messages.
- Raw conversation summary.
- Completed and maximum step counts.
- Accumulated token usage.
- Per-tool execution-failure counts.
- Pending asynchronous awaits.
- Agent, thread, provider, model, attempt, and phase metadata.
- Delegation lineage and invocation kind.
- System context.
- Structural and cosmetic identities of the effective non-MCP tool set.

The generated system message is deliberately excluded. It is reconstructed by the context builder so resume receives current dynamic context rather than a stale rendered prompt.

### 8. Resume Ownership and Validation

The HTTP resume handler owns the external resume claim before execution enters the runtime:

1. Verify that the authenticated user owns the run.
2. Accept only `resumable`, `interrupted`, or `waiting_for_jobs` status.
3. Atomically compare-and-set that status to `running`.
4. Load the newest checkpoint.
5. Load the associated agent.
6. Rebuild the effective tool set.
7. Validate the snapshot.
8. Increment the attempt counter.
9. Dispatch the resumed invocation.

The compare-and-set is the concurrency guard: two resume requests may race, but only one can claim the expected prior status.

Snapshot validation rejects unsupported versions, missing run identity, empty history, invalid step counters, removed tools, and structurally changed tools. A tool schema or delegate target change blocks resume because replay could mean something different. Description or instruction changes only produce a warning. Legacy tool references without structural hashes fall back to presence-only validation.

MCP tools are deliberately excluded from strict identity. A remote server may be unavailable or drift independently; an unavailable restored `mcp__...` call becomes a synthetic error result that the model can observe and work around.

### 9. Tool-Batch Preflight

The runtime validates every requested tool name before executing ordinary tools. If any non-MCP tool is missing:

- Missing calls emit `tool.failed`.
- The run returns `ErrToolNotAvailable`.
- Valid sibling calls in that batch do not execute.

This preflight avoids discovering a malformed batch only after some siblings have already produced side effects.

A missing MCP call is the explicit exception. It becomes a soft, model-visible error so temporary remote-server unavailability does not necessarily destroy the entire run.

Argument sanitization at this stage only ensures event metadata contains valid JSON. Central runtime code does not prove each argument object satisfies the advertised schema; each tool remains responsible for decoding and validating its arguments.

### 10. Tool Concurrency and Ordering

Independent calls from one model response execute concurrently. The runtime creates one goroutine per execution group and waits for every group to finish.

Delegations have a special grouping rule:

- Calls to different target agents may run concurrently.
- Calls to the same target agent are serialized, even when exposed under different delegate tool names.

This protects a single delegate target from overlapping requests while preserving parallelism across independent targets.

Completion order never determines transcript order. Outcomes are stored by original call index and appended in the exact order the model requested them. This makes the transcript and derived `LastAction` deterministic even when a later call finishes first.

**Operational implication:** There is no runtime-level semaphore limiting the number of independent groups. A sufficiently large tool-call batch can create equally large instantaneous concurrency. Whether this needs a bound depends on provider limits and observed production workloads.

### 11. Tool Context, Timeouts, and Cooperative Cancellation

Each call receives:

- Its model-generated tool-call ID.
- The current run ID.
- Raw JSON arguments.
- Memory scope through `context.Context`.
- Delegation lineage through `context.Context`.
- Asynchronous-run identity through `context.Context`.

The default per-tool timeout is 30 seconds. A tool can implement `TimeoutTool`:

- A positive duration creates that custom deadline.
- Zero or a negative duration inherits the parent run context with no additional wall-clock cap.

Delegate tools inherit the parent bound because dispatcher and bus execution govern their lifecycle.

Cancellation is cooperative. The runtime checks the parent context at loop and batch boundaries, and tool contexts inherit cancellation. It nevertheless waits for all tool goroutines to return. A tool that observes `ctx.Done()` exits promptly; a tool that ignores context can delay cancellation until its own timeout, or indefinitely when it opted into an unbounded inherited context.

### 12. Execution Failure Versus Domain Error

There are two deliberately different error channels.

An **execution failure** occurs when:

- `Execute` returns a Go error.
- The tool panics.
- The tool returns a nil result.
- The tool context reaches its deadline.

The runtime recovers per-tool panics, emits `tool.failed`, creates an error-shaped tool message, and increments a counter for that tool name. Siblings already running are allowed to finish. Three execution failures for one tool name cause the run to fail after the batch outcomes are collected.

A **domain-level error result** is a valid `ToolResult` whose `IsError` flag is true. The tool protocol succeeded, but its requested operation could not be satisfied. It emits `tool.completed`, does not increment the execution-failure threshold, and gives the model a chance to adapt.

Examples of domain errors include an absent record, an invalid user-level operation, or a safely rejected request. Conflating these with infrastructure failures would make normal recoverable situations unnecessarily terminate the run.

### 13. At-Least-Once Side Effects and Idempotency

Consider this failure window:

```text
post_model checkpoint saved
        |
external tool side effect succeeds
        |
process crashes before a later checkpoint records the result
        |
resume loads post_model
        |
the same tool call executes again
```

The execution engine therefore provides at-least-once tool execution across crash recovery, not a universal exactly-once guarantee.

The stable pair `(run ID, tool-call ID)` is the idempotency identity available to tools. Confirmed defenses include:

- Memory mutations derive persistent mutation identity from run and tool-call IDs.
- Scratchpad mutations do the same.
- HTTP and web-search tools can deduplicate call IDs through Redis for seven days.

This remains capability-specific. An arbitrary MCP server or external API may ignore the identity. Durable orchestration cannot atomically commit a checkpoint and an unrelated remote side effect, so every mutating capability must define its own replay policy.

### 14. Required Asynchronous Jobs

Required jobs prevent parent completion until their results are available. If the model attempts a final answer first, the runtime creates deterministic calls of the form:

```text
auto-await:<run-id>:<job-id>
```

When an await remains pending:

1. The async store records which parent is awaiting which jobs.
2. The runtime saves a `waiting_for_jobs` snapshot.
3. It returns `RunResultWaiting` rather than a final answer.
4. Durable status becomes `waiting_for_jobs`.

On resume, unresolved jobs lead back to waiting. When all jobs are terminal, the store marks their results delivered, the runtime appends corresponding tool messages, and the model continues with the evidence. Delivery tracking prevents completed results from being injected repeatedly.

### 15. Event Semantics and Backpressure

`ChannelSink` assigns every emitted event a run ID, monotonically increasing sequence number, event ID, and timestamp. Its mutex serializes concurrent emissions, including those produced by parallel tool goroutines.

`status.updated` is explicitly expendable. It is silently dropped when the channel is full or the run context is done.

Other events block until the consumer accepts them, unless cancellation ends the run. This backpressure preserves meaningful lifecycle events during normal execution but means a stalled consumer can stall producers. Sequence gaps are valid because a status event receives a sequence before it is dropped.

The runtime's deferred cleanup emits one logical terminal event and closes the sink. In the HTTP path, `run.completed`, `run.failed`, and `run.cancelled` are temporarily withheld. The handler first attempts message persistence, emits `run.persisted` or `run.persist_failed`, and only then sends the terminal event.

Live events are not the authoritative durable state. Cancellation can prevent terminal delivery to the event consumer, especially after client disconnection.

### 16. Terminal State Mapping

The internal terminal categories are success, failure, cancellation, and waiting.

| Runtime outcome | Durable run status |
| --- | --- |
| Final answer | `completed` |
| Cancellation with an existing checkpoint | `interrupted` |
| Cancellation before any checkpoint | `failed` |
| Required jobs still pending | `waiting_for_jobs` |
| Resumable failure with a checkpoint | `resumable` |
| Other failure | `failed` |

`context.Canceled`, `context.DeadlineExceeded`, and `ErrCheckpointStoreUnavailable` are classified as resumable errors. A resumable error is not sufficient by itself: recovery must also have a real snapshot.

Unexpected panics escaping the normal loop are recovered by the top-level defer, logged with a stack trace, classified as runtime panic, and converted into a failed result rather than crashing the process.

### 17. Checkpoint Retry Policy

One logical save performs at most three store calls. Each call uses a detached background context with a 1.5-second timeout. Retries wait 75 milliseconds and then 150 milliseconds.

If any attempt succeeds, the consecutive checkpoint-failure count resets. If all three fail, one consecutive logical failure is recorded and the runtime emits a durability-degraded status. The run continues until three consecutive logical saves have failed, which may represent nine failed store calls.

Once the threshold is crossed:

- A run believed to have a prior snapshot returns an error wrapping `ErrCheckpointStoreUnavailable` and is eligible for `resumable` status.
- A run believed never to have persisted a snapshot returns a plain non-resumable error.

Detached save contexts improve the chance of preserving progress after request cancellation, but they can delay cancellation by the retry and timeout duration. The sleep backoffs themselves are not context-aware.

### 18. Confirmed `hasSnapshot` Defect

The runtime currently treats a tolerated checkpoint operation as proof that a snapshot exists:

```go
checkpointFailures, err = trySaveCheckpoint(...)
if err != nil {
    return err
}
hasSnapshot = true
```

But `trySaveCheckpoint` returns a nil fatal error when all three store attempts fail below the consecutive-failure threshold. Therefore `hasSnapshot` can become true without any successful persisted checkpoint.

A concrete failure sequence is:

1. The first logical checkpoint fails all three storage attempts.
2. The runtime tolerates the first durability failure.
3. `hasSnapshot` is incorrectly set to true.
4. The run is cancelled before a later successful save.
5. Durable status becomes `interrupted` instead of `failed`.
6. A resume request is allowed but `LoadLatest` finds no checkpoint.
7. The handler finally marks the run failed.

The direct retry tests verify behavior when `hasSnapshot` is supplied manually, but no runtime-level test proves that the flag only follows a confirmed successful save.

**Recommended future correction:** Make the save operation report whether persistence actually succeeded, independently of whether the runtime is allowed to continue. Set `hasSnapshot` only after confirmed success or when invocation began from a loaded checkpoint.

No source fix was made during this documentation study.

### 19. Other Durability and Operational Limits

#### 19.1 No global transaction

Tool side effects, checkpoints, run status, and conversation-message persistence cross different systems and are not one atomic transaction. Partial outcomes are possible:

- A tool succeeds but its result checkpoint is absent.
- A checkpoint succeeds but later message persistence fails.
- Execution completes but the terminal status update fails.
- A final response is streamed while later durable work encounters an error.

This is inherent at external-system boundaries; protection comes from explicit idempotency, status reconciliation, and careful event semantics rather than a fictional global transaction.

#### 19.2 Best-effort terminal status

Terminal status updates use `context.Background()` and discard returned errors. This makes them independent of a disconnected client, but a failed write can leave durable status stale. No timeout is attached at this call site, so a stuck store call can also delay cleanup.

#### 19.3 Separate message persistence

The runtime returns `NewMessages`; HTTP handlers or pool orchestration persist them afterward. Checkpoint durability and message-history durability are therefore related but distinct guarantees.

#### 19.4 Final checkpoint degradation

A completed run may tolerate a below-threshold final-checkpoint failure. That is reasonable when final messages persist successfully, but it means completion does not prove that every intended checkpoint exists.

### 20. Why the Boundary Is Reasonable

The runtime owns orchestration policy that must remain the same whether invocation comes from HTTP, a worker, a delegated agent, or the standalone runtime. It does not own:

- Authentication or user-facing HTTP errors.
- Database-specific checkpoint representation.
- Provider-specific wire formats.
- Tool-specific business rules and idempotency.
- Queue and worker placement.
- Final conversation-message storage.

Keeping these concerns outside the loop lets one execution engine work across Studio and standalone compositions. The cost is that end-to-end guarantees must be reasoned about across several layers instead of inferred from `runtime.go` alone.

### 21. Alternatives and Trade-Offs

#### Sequential tool execution

This would simplify ordering and reduce concurrency risk, but unnecessarily increases latency for independent calls. Current indexed outcomes already preserve deterministic transcript order.

#### Checkpoint only after each complete step

This would reduce storage writes but lose the exact model decision before side effects, making recovery less safe.

#### Checkpoint after every tool individually

This could narrow replay windows, but concurrent calls make the meaning of partially completed batches complex. It still cannot atomically include external side effects.

#### Fail immediately on any checkpoint error

This maximizes durability strictness but makes brief storage outages terminate otherwise healthy runs. The current threshold trades a bounded durability gap for availability.

#### Treat every tool error as fatal

This is simpler but removes the model's ability to recover from expected domain failures and partial capability outages.

### 22. Test Evidence

Existing tests cover:

- Single-step and multi-step model flow.
- Maximum-step and empty-output errors.
- Model errors and runtime panic recovery.
- Event ordering and concurrent sequence assignment.
- Independent tool parallelism.
- Same-target delegate serialization.
- Deterministic transcript ordering.
- Tool timeouts, cancellation, errors, and panics.
- Missing-tool preflight.
- Execution-failure thresholds.
- Checkpoint retry behavior and phase order.
- `pre_model` and `post_model` resume.
- Required-job suspension and waiting resume.
- Snapshot compression, validation, and tool drift.

These tests were inspected but not executed during this documentation pass. Their presence describes intended guarantees; it is not evidence that the current suite passed in this session.

### 23. Source Map

1. `backend/agent/runtime.go` — primary state machine, checkpoints, resume, waiting, and terminal status.
2. `backend/agent/tool_batch.go` — validation plans, grouping, concurrency, timeouts, and outcome application.
3. `backend/agent/checkpoint.go` — snapshot schema, validation, compatibility, compression, and resumable classification.
4. `backend/agent/events.go` — stream event contract, sequencing, dropping, and backpressure.
5. `backend/agent/agent.go` — agent configuration, run context, and result contract.
6. `backend/agent/async_jobs.go` — job, await, and invocation contracts.
7. `backend/handlers/run.go` — resume ownership claim and external validation.
8. `backend/handlers/stream.go` — HTTP stream draining and terminal-event ordering.
9. `backend/dispatcher/direct.go` — in-process execution and delegation-tree cancellation cascade.
10. `backend/dispatcher/agent_pool.go` — worker execution, leases, and post-run persistence handoff.
11. `backend/agent/*_test.go` — state-machine, batch, checkpoint, event, and async guarantees.

### 24. Chapter Summary

AgentFlow's execution engine is a resumable model/tool state machine. Checkpoint phases describe which decision or result is durable, tool batches combine parallel execution with deterministic transcript order, stable call identities enable capability-specific replay protection, and asynchronous jobs can suspend a run without losing its place. The engine deliberately favors continued availability through transient checkpoint failure and MCP loss, but this creates explicit durability trade-offs. Its most important correctness constraint is that tool replay is at-least-once unless the tool enforces idempotency. Its clearest current defect is that `hasSnapshot` can claim recoverability after no checkpoint write succeeded.

## Chapter 4: Tools and External Capabilities

### 1. Why This Layer Exists

The execution engine can decide that an action should happen, but it cannot perform every possible action itself. The tool layer is the boundary that turns a model-generated intention into a controlled backend operation.

Examples include:

- Evaluating a mathematical expression.
- Sending an HTTP request.
- Searching the web.
- Reading or changing durable agent memory.
- Reading or changing a run-family scratchpad.
- Invoking another configured agent.
- Dispatching an asynchronous child job.
- Calling a remotely discovered MCP tool.

This boundary is security-sensitive. Giving an agent a tool is not merely showing it another function name; it grants the model a capability. The model proposes a tool name and JSON arguments, while trusted backend code must decide which capabilities exist, validate the request, add trusted identity and scope, execute it, bound its resource use, and return evidence to the model.

A useful mental model is:

```text
model proposes an action
        |
        v
backend verifies the available capability and its scope
        |
        v
tool adapter performs local or external work
        |
        v
structured result becomes evidence for the next model step
```

The model is therefore a planner at this boundary, not the authority.

### 2. The Four-Stage Capability Construction Flow

The effective tool set for one run is assembled in stages:

```text
process composition
  ToolRegistry: all locally available implementations
        |
        v
agent configuration
  Agent.Tools: selected global tool names
        |
        v
per-run construction
  ToolSet: selected tools + delegate tools + async control tools
        |
        v
remote discovery
  MCP tools are discovered, namespaced, and merged
```

The distinction matters:

- Registration says a capability exists in this process.
- Agent selection says this agent is allowed to see a registered capability.
- Per-run synthesis adds capabilities implied by the agent's delegate configuration.
- MCP discovery adds remote capabilities that are available for this particular run.

A tool being registered does **not** automatically make it available to every agent.

### 3. The Core Tool Contract

Every executable tool implements a deliberately small interface:

```go
type Tool interface {
    Name() string
    Definition() llm.ToolDefinition
    Execute(context.Context, ToolCall) (*ToolResult, error)
}
```

Each method has a separate responsibility:

- `Name()` provides the backend's lookup key.
- `Definition()` gives the model a description and JSON parameter schema.
- `Execute(...)` performs the trusted operation.

`ToolCall` combines model-controlled and runtime-controlled data:

- The provider/model supplies the call ID, selected tool name, and raw JSON arguments.
- The runtime supplies `RunID`, which is important for tracing and replay protection.

`ToolResult` separates three kinds of output:

- `Content` is the text returned to the model.
- `IsError` represents a tool-level or domain-level failure that the model may be able to recover from.
- `Metadata` carries trusted internal control information, such as asynchronous job state.

This separation lets a failed web lookup or child-agent call become model-visible evidence without necessarily crashing the entire run.

#### Optional timeout behavior

A tool may also implement `TimeoutTool`. The runtime uses a default timeout of 30 seconds, replaces it with a positive tool-specific timeout when supplied, and interprets zero as inheriting the parent context without adding another deadline.

This is an optional-behavior interface: the main `Tool` contract remains small, while tools that need special timeout semantics can opt in.

### 4. JSON Schema Is Guidance, Not Enforcement

`Definition()` exposes a JSON Schema-like parameter description to the LLM provider. This improves the probability that the model emits correct arguments, but it is not a security boundary.

Why not?

- A model can still emit malformed JSON.
- A provider may only partially enforce schema restrictions.
- Stored or resumed calls may have been produced by a different provider version.
- A malicious or compromised caller may bypass normal model generation.

The generic runtime validates that a requested tool name exists. Each tool's `Execute` implementation must still decode and validate its own arguments. A schema declaration such as an HTTP-method enum does not protect the executor if the executor accepts arbitrary strings.

The general rule is:

> Provider schema improves generation quality; executor validation establishes trust.

### 5. Why There Are Several Registries

The code defines different registries for different phases of the system.

#### Executable registry

`NewToolRegistry` builds tools that can actually run:

- Calculator and HTTP are always registered.
- Web search is registered only when a Tavily API key is available.
- Memory and scratchpad tools are registered only when their backing services are supplied.

This means process composition determines the maximum local capability set.

#### Validation registry

`NewValidationRegistry` provides definitions used while validating agent configurations. It can describe memory and scratchpad capabilities without requiring live persistence services.

#### Catalog registry

`NewCatalogRegistry` exposes the complete built-in tool catalog for publication and inspection. Catalog entries describe capabilities but must not be treated as executable implementations.

Separating catalog construction from runtime execution avoids requiring a live database, Redis connection, or external API simply to validate or publish an agent definition.

#### Empty registry

`NewEmptyRegistry` supports tests and deliberately capability-free compositions.

#### Important registry limitation

`Register` overwrites a tool with the same name without reporting a collision, and the registry has no mutex or freeze operation. The architecture therefore relies on a convention: compose the registry during startup, then treat it as immutable. Dynamic concurrent registration would be unsafe and could silently replace a capability.

### 6. Building the Effective `ToolSet`

The per-agent `ToolSet` is the authoritative capability view used by the runtime. Construction rejects several ambiguous configurations:

- The same global tool selected more than once.
- A selected tool missing from the process registry.
- A delegate tool name colliding with a selected global tool.
- Two delegates producing the same tool name.
- A delegate colliding with reserved asynchronous control-tool names.
- An executable delegate configuration when no delegate invoker is available.

If the agent has delegates and its capabilities enable asynchronous jobs, the set also gains `dispatch_agent` and `await_job`. Both Studio execution and the standalone runtime currently enable these capabilities.

MCP tools are merged after local tools are built. A discovered MCP name that collides with an existing name is skipped rather than replacing a local capability.

The resulting set supplies:

- Name-based execution lookup.
- The ordered tool definitions sent to the provider.
- Stable identity material used by checkpoint/resume compatibility checks.

### 7. Tool Identity and Resume Safety

AgentFlow records two different hashes for a tool configuration:

- The **structural hash** includes the tool name and parameter schema. Delegate identity also includes its target.
- The **cosmetic hash** includes human-facing description and instructions.

On resume:

- Structural drift blocks resume because an already-decided call may now mean something different.
- Cosmetic drift generates a warning but does not block resume.

This is a sound distinction: changing prose is generally less dangerous than changing accepted arguments or delegate routing.

There is, however, a limit. If implementation behavior changes while its name and schema remain identical, the current identity check cannot detect that semantic drift. Remotely discovered MCP tools are also not part of the persisted local-tool identity comparison.

### 8. Calculator: A Pure Local Capability

The calculator is the simplest tool. It uses a handwritten parser supporting arithmetic operations, exponentiation, square root, and parentheses.

It does not use language evaluation, shell execution, or dynamically compiled code. That design sharply limits its attack surface.

Because it is pure and has no external side effect, repeating the same calculator call is naturally safe. This makes it a useful contrast with HTTP, memory writes, and delegation.

### 9. HTTP Tool: General Network Authority

The HTTP tool can send a caller-selected URL, method, headers, and body. Responses are truncated to 32 KiB before being returned to the model.

Its result semantics are intentionally model-friendly:

- HTTP statuses such as 404 or 500 are returned as ordinary results because the server did respond.
- Network failures and security-policy rejections become soft tool errors so the model can react.

#### Confirmation is currently policy text, not enforcement

The tool description tells the model to obtain user confirmation for mutating methods. The executor does not maintain a trusted confirmation state or verify one. A prompt instruction can influence cooperative model behavior, but it cannot enforce authorization against model error, prompt injection, or a crafted stored call.

#### Method validation is incomplete

The advertised schema enumerates expected HTTP methods, but execution uppercases the supplied string and does not independently enforce that allowlist. This illustrates why schema guidance and trusted validation must remain separate.

#### SSRF protection is partial

The implementation rejects unsupported schemes, localhost-like names, and initially resolved private or loopback addresses. That is valuable, but it does not revalidate every redirect destination and does not pin subsequent connections to the already-approved address.

Consequences include:

- A public URL may redirect to an internal address.
- DNS may resolve differently between validation and connection, creating a DNS-rebinding window.

The same class of issue matters wherever a user-controlled endpoint is accepted, including MCP servers.

### 10. Web Search Tool

The web-search tool calls a fixed Tavily endpoint and is registered only when its API key exists. It accepts a query and a result count, constraining the count to the supported range and falling back to five for invalid values. Its HTTP client has a 30-second timeout.

Two architectural implications matter:

- Search results are external, untrusted text. They may contain instructions crafted to manipulate the model, so tool output is evidence, not authority.
- Unlike the generic HTTP tool, the response body does not have an explicit application-level size limit in this adapter. A client timeout bounds time, not memory consumption.

### 11. Memory Tools: Durable Knowledge Capabilities

The memory family exposes eight operations covering write, read, search, patch, update, retire, restore, and history.

The model can choose the logical memory scope exposed by the tool contract, but it does not get to choose trusted ownership fields. The adapter supplies user, agent, thread, run, and call identity from runtime context and overwrites mutation identities using trusted values.

This preserves a critical boundary:

```text
model chooses the intended memory operation
backend injects who owns it and which run/call caused it
memory service enforces revisions, lifecycle, and idempotency
```

The tool adapter is therefore not the owner of all memory guarantees. Optimistic concurrency, revision history, and durable replay protection belong to the memory service and persistence layer, which will be covered in the memory chapter.

### 12. Scratchpad Tools: Run-Family Working State

Scratchpad tools support creating, appending, replacing, listing, getting, reading, and searching artifacts.

A scratchpad workspace is keyed by the trusted user and the originator run. That allows a parent and its delegated descendants to collaborate within one execution tree while retaining agent authorship.

Important guarantees include:

- Replacement is owner-restricted.
- Expected-content hashes provide optimistic concurrency protection.
- Run and call identities support replay-safe mutations.

The difference from durable memory is conceptual:

- Memory represents knowledge intended to survive and be reused.
- Scratchpad represents working material shared inside a run family.

### 13. Synchronous Delegate Tools

Every configured synchronous delegate becomes a synthesized tool. The generated definition asks the model only for the delegated task; the target agent is fixed by configuration and cannot be selected through model arguments.

The delegate invoker owns the hard parts:

- User and run-family identity.
- Cycle prevention.
- Maximum delegation depth.
- Child-run creation.
- Cancellation propagation.
- Per-target serialization enforced by the execution engine.

Delegate tools inherit the parent deadline rather than adding a fixed extra timeout. A child failure is returned as a soft tool error so the parent model can decide whether to retry, revise the task, or continue without that result.

### 14. Asynchronous Control Tools

When enabled, the runtime exposes two control tools:

- `dispatch_agent` creates a durable child job.
- `await_job` inspects or waits for a job result.

`dispatch_agent` resolves its target from configured delegates rather than accepting an arbitrary agent ID. It also applies cycle/depth checks and distinguishes required work from background work. Required work may suspend the parent run until the child result is available; background work can be delivered through a callback-style path.

The job store, worker leases, retries, and parent suspension mechanics belong to the multi-agent coordination layer. From the tool layer's perspective, the key point is that dispatch is a durable control operation, not an in-memory goroutine shortcut.

### 15. MCP: Runtime Discovery of Remote Capabilities

MCP servers are selected per agent by catalog `server_id`. The AgentFlow-owned catalog supplies the alias and environment-specific URL: Studio preparation uses `studio_url`, while publication freezes `deployment_url` into the immutable bundle. MCP connections contain no bearer or other application-authentication field. Discovered tool names are namespaced as:

```text
mcp__<server-alias>__<remote-tool-name>
```

Namespacing prevents ordinary remote names from accidentally replacing built-in tools and makes the capability's origin visible to the model.

#### Discovery

Servers are discovered concurrently with a five-second budget per server. Discovery performs protocol initialization, session handling, and paginated tool listing. One unavailable MCP server is non-fatal; the run can continue with the remaining capability set.

Definitions are normalized so parameter schemas have an object shape. Invalid or oversized names are skipped. Discovery is bounded to approximately one thousand tools, although the final page may make the realized count slightly larger.

Configuration order is used when merging results, which helps keep provider-visible tool order deterministic even though network discovery occurs concurrently.

#### Calls

MCP calls use a 30-second budget, support JSON and server-sent-event responses, validate response IDs, and cap response bodies at 5 MiB. Text content is concatenated for the model; unsupported non-text content is omitted. The runtime later applies its own smaller tool-result limit before adding content to the conversation.

Transport and remote RPC failures become soft tool errors. This preserves run availability but means the model must reason about partial capability loss.

### 16. Security and Trust-Boundary Findings

The following findings are directly supported by current code inspection.

#### Resolved critical finding: configurable MCP bearer environment

The earlier implementation allowed an authenticated Studio user to submit both an MCP URL and a `bearer_env` name, which could cause a process secret to be sent to a user-selected endpoint. Decision 8 removed that path atomically. The public API and agent document now accept only `server_id`; AgentFlow owns both URLs; the runtime performs no MCP environment lookup; and the MCP client has no Authorization-header branch.

#### High: SSRF defense does not cover the complete connection lifecycle

The arbitrary user-supplied MCP destination path has been removed. Catalog URLs are trusted platform configuration and may intentionally address localhost or private Kubernetes Services over HTTP. SSRF defense is still required inside capabilities such as the Fetch MCP server because the model can influence the URL fetched by that server.

#### High: HTTP/web replay cache is not tenant-scoped

**Confirmed:** Redis deduplication keys use the tool name and provider call ID, but omit user, run, agent, and argument identity. In a shared Studio Redis instance, a call-ID collision can return another invocation's cached result. The cache lifetime is seven days. Memory and scratchpad mutations use stronger run-plus-call identities.

**Confirmed:** The standalone composition supplies no Redis cache, so generic HTTP and web calls have no equivalent replay cache there.

#### Prompt instructions do not enforce authorization

**Confirmed:** The mutating-HTTP confirmation requirement exists in descriptive text, not trusted runtime state. Prompt policy is useful guidance but is not an authorization mechanism.

#### Tool arguments may become durable sensitive data

**Confirmed:** Tool-call arguments participate in assistant messages, streamed events, and checkpoints. If an HTTP header contains a credential, that credential can therefore enter durable or observable run records. Secrets should be referenced indirectly or redacted before persistence and streaming.

#### External tool output is untrusted input

**Confirmed:** HTTP, web, and MCP content is returned to the model. A remote response can contain prompt-injection text. The architecture limits capabilities and preserves trusted context, but it does not make external prose trustworthy.

### 17. Replay and Idempotency by Capability

Different tools have different replay behavior:

| Capability | Replay characteristic |
| --- | --- |
| Calculator | Pure; repeating it is naturally safe. |
| Memory mutations | Durable run/call idempotency in the memory service. |
| Scratchpad mutations | Durable run/call replay handling in the scratchpad service. |
| HTTP and web in Studio | Redis cache keyed only by tool name and call ID; useful but insufficiently scoped. |
| HTTP and web standalone | No Redis replay cache in the current composition. |
| Synchronous delegate | Child invocation is tied to the tool-call identity and delegation runtime. |
| Async dispatch/await | Durable job store owns repeated dispatch and state transitions. |
| MCP | No general durable idempotency guarantee supplied by this adapter. |

This is why checkpointing alone cannot guarantee exactly-once side effects. The capability that owns the external state must make repetition safe or expose an explicit idempotency key.

### 18. Architectural Strengths

The layer has several strong design choices:

- A small tool interface keeps adapters understandable and testable.
- Registration and per-agent selection are separate.
- Trusted identity and scope are injected outside model arguments.
- Catalog/validation definitions are separated from executable dependencies.
- Tool-set construction rejects important local collisions.
- Structural identity protects checkpoint resume from visible schema drift.
- Memory and scratchpad operations delegate durable invariants to their owning services.
- MCP failure is isolated, time-bounded, and non-fatal to the whole run.
- Provider-visible ordering is deliberately deterministic.

### 19. Architectural Weaknesses and Limits

The most important weaknesses are concentrated at external trust boundaries:

- The former user-selected MCP bearer-environment bridge has been removed by the managed catalog contract.
- SSRF checks do not cover redirects and DNS rebinding fully.
- HTTP/web deduplication is not scoped strongly enough for multi-tenant use.
- Confirmation for dangerous HTTP actions is advisory rather than enforced.
- Sensitive tool arguments can enter durable messages, checkpoints, and streams.
- Web response size is not explicitly bounded by the adapter.
- Remote descriptions and outputs can influence the model through prompt injection.
- Registry overwrite and mutability are safe only under startup-time composition convention.
- Tool identity hashes cannot detect implementation-only semantic changes.

### 20. Alternatives and Trade-Offs

#### One global capability set for all agents

This would simplify construction but remove least-privilege configuration. Every agent would receive every process capability.

#### Hard-fail when any MCP server is unavailable

This would make the tool set predictable but would let one optional remote dependency make the entire run unavailable. The current soft-failure approach favors graceful degradation.

#### Put all validation in generic middleware

Common checks can be centralized, but tool-specific semantics still belong with the executor. A universal validator cannot know all business rules without becoming coupled to every capability.

#### Trust provider-side schema enforcement

This reduces code but treats a probabilistic generation aid as a security control. Independent decoding and validation remain necessary.

#### Attempt exactly-once execution in the runtime alone

The runtime cannot atomically commit checkpoints together with arbitrary remote systems. Exactly-once behavior requires cooperation from the destination capability, normally through durable idempotency keys or transactions at the state-owning boundary.

### 21. Test Evidence and Gaps

Existing tests cover:

- Registry and catalog construction.
- Tool-set selection and collision detection.
- Structural and cosmetic hashes.
- Calculator behavior.
- Basic SSRF blocking.
- Scratchpad operations and concurrency checks.
- MCP discovery, protocol handling, pagination, schema normalization, and resume behavior.

Important gaps observed during inspection include:

- Redirect-based SSRF.
- DNS rebinding between validation and connection.
- Executor-side HTTP method allowlisting.
- Trusted confirmation enforcement for mutating HTTP calls.
- Cross-tenant Redis call-ID collision behavior.
- managed, no-auth MCP catalog resolution.
- Redaction of sensitive tool arguments.
- Explicit web-response size enforcement.

These tests were inspected but not executed during this documentation pass. Their presence describes intended behavior; it is not evidence that the current suite passed in this session.

### 22. Source Map

1. `backend/tools/tool_interface.go` — core tool, call, result, and timeout contracts.
2. `backend/tools/tool_registry.go` — executable, validation, catalog, and empty registries.
3. `backend/agent/toolset.go` — selected tools, collision checks, async additions, MCP merge, and identity hashes.
4. `backend/tools/calculator.go` — pure local expression evaluator.
5. `backend/tools/http.go` — general HTTP capability, response limit, deduplication, and SSRF checks.
6. `backend/tools/web.go` — Tavily search adapter.
7. `backend/tools/memory.go` — durable memory tool adapters and trusted scope injection.
8. `backend/tools/scratchpad.go` — run-family artifact tool adapters.
9. `backend/agent/delegate_tool.go` — synthesized synchronous delegate capability.
10. `backend/agent/async_tools.go` — asynchronous dispatch and await control tools.
11. `backend/tools/mcp_tool.go` — remote MCP tool adapter.
12. `backend/mcp/client.go` — discovery, protocol, authentication, transport limits, and response parsing.
13. `backend/handlers/agent.go` — Studio agent/MCP configuration validation boundary.
14. `backend/agent/runtime.go` and `backend/agent/tool_batch.go` — definitions sent to the model and controlled execution.
15. Adjacent `*_test.go` files — intended registry, tool-set, built-in, scratchpad, and MCP guarantees.

### 23. Chapter Summary

The tool layer turns a model's proposed action into a backend-controlled capability. The process registry defines what exists, agent configuration selects least-privilege local tools, the per-run `ToolSet` synthesizes delegate and asynchronous controls, and MCP discovery adds namespaced remote capabilities. Trusted runtime identity must override model-supplied scope, executor validation must remain independent of provider schema, and replay safety belongs primarily to the capability that owns the side effect. The layer's strongest design qualities are its small interface, explicit composition, deterministic capability view, and service-owned durable invariants. The former configurable MCP bearer-secret path has been removed; remaining high-priority risks include complete outbound-network protection, under-scoped HTTP/web deduplication, durable exposure of sensitive arguments, Fetch-MCP SSRF controls, and Python-sandbox isolation.

## Chapter 5: LLM Provider Abstraction

### 1. Why This Layer Exists

OpenAI-compatible APIs and Anthropic do not use the same wire protocol. Their request JSON, authentication headers, tool-call representation, system-prompt placement, usage fields, and error responses differ. If those differences leaked into the agent runtime, every model call would need provider-specific branches.

The LLM layer translates between AgentFlow's internal language and each provider's protocol:

```text
AgentFlow ChatRequest
        |
        v
provider adapter
        |
        v
OpenAI-compatible or Anthropic HTTP protocol
        |
        v
provider response
        |
        v
AgentFlow ChatResponse
```

The runtime therefore asks one provider-neutral question: given these messages, tools, generation settings, and model, return either text or requested tool calls.

### 2. The Internal Contract

The boundary is intentionally small:

```go
type LLMClient interface {
    ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
}
```

`ChatRequest` contains:

- The provider model identifier.
- Normalized chat messages.
- Available tool definitions.
- Temperature.
- Maximum output tokens.
- An escape-hatch map of provider-specific parameters.

`ChatResponse` contains:

- Model-produced text.
- Normalized tool calls.
- The model identifier reported by the provider.
- Basic prompt, completion, and total-token usage.

This small port has multiple real implementations and many test fakes, so it is a justified abstraction rather than a speculative interface.

### 3. The Internal Conversation Format

`ChatMessage` represents the roles used by the execution engine:

- `system` carries stable instructions and live runtime context.
- `user` carries user input.
- `assistant` carries model text and/or tool requests.
- `tool` carries the result of one tool call.

`ToolCallID` connects a result to its original request. `ToolCalls` preserves one or more actions requested by an assistant message. `Metadata` contains AgentFlow-only annotations and is deliberately not translated by provider adapters.

Tool arguments remain `json.RawMessage`. The provider adapter preserves the JSON but does not interpret each tool's business schema; the tool executor owns that validation later.

### 4. Provider Registry and Process Configuration

The static provider table defines three supported providers:

| Provider | Environment credential | Adapter | Per-attempt timeout |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OpenAIAdapter` | 30 seconds |
| NVIDIA | `NVIDIA_API_KEY` | `OpenAIAdapter` | 30 seconds |
| Anthropic | `ANTHROPIC_API_KEY` | `AnthropicAdapter` | 60 seconds |

NVIDIA reuses the OpenAI adapter because its endpoint exposes an OpenAI-compatible chat API.

`NewLLMRegistry` reads credentials once during composition:

- A nonempty key registers the corresponding client.
- A missing key skips that provider.
- Studio startup continues even if one or every provider is unavailable.

The registry is then shared by direct chat, agent execution, context summarization, publication/runtime validation, and standalone execution.

`Register` supports tests and custom composition, but it silently overwrites existing names, accepts nil clients, and has no synchronization. It is safe under the current startup-then-read convention; concurrent dynamic registration would not be safe.

### 5. Three Different Meanings of “Available Model”

The backend contains three independent views:

#### Supported provider

`SupportedProviders()` describes protocols implemented by the code: Anthropic, NVIDIA, and OpenAI.

#### Registered provider

The runtime registry contains only providers whose credentials were present at process startup.

#### Catalogued model

MongoDB's `llm_registry` collection holds UI-facing records with display name, provider, API model ID, and context-window size.

These views can disagree. A catalogued Anthropic model can appear in `/api/llms` while the Anthropic credential is missing, making it impossible to execute. Conversely, a configured provider key can work even when the UI catalog is empty, if a model identifier is supplied directly.

The catalog is therefore informational and assists context sizing; it is not an execution allowlist.

### 6. OpenAI-Compatible Request Translation

The OpenAI adapter:

1. Converts internal messages into OpenAI message objects.
2. Converts definitions into `type: "function"` tools.
3. Reconstructs prior assistant function calls.
4. Sends `POST <baseURL>/chat/completions` with bearer authentication.
5. Retries configured transient failures.
6. Parses the first returned choice.
7. Converts returned function calls into internal `ToolCall` values.
8. Normalizes usage counters.

Only the first choice is retained. Any additional choices are discarded because the internal response represents a single continuation.

#### Reasoning-model compatibility

For official OpenAI endpoints, model names beginning with `o1`, `o3`, `o4`, or `gpt-5` receive special handling:

- `max_completion_tokens` replaces `max_tokens`.
- Temperature is omitted.

The official-endpoint check prevents OpenAI-specific behavior from automatically being applied to NVIDIA or another compatible service.

### 7. Anthropic Request Translation

Anthropic's protocol requires more structural conversion.

#### System prompt

Internal system messages are removed from the ordinary message list and placed in the top-level `system` field. If several exist, the last one wins. Normal AgentFlow construction produces one system message.

#### Tool requests

An internal assistant tool call becomes an Anthropic `tool_use` content block.

#### Tool results

An internal `tool` message becomes a user-role message containing a `tool_result` content block. This is why a normalized internal role model is useful: the runtime can speak in its own concepts while the adapter performs protocol-specific encoding.

#### Responses

Text blocks are concatenated into `ChatResponse.Content`; `tool_use` blocks become normalized tool calls; unknown block types are ignored. Anthropic input/output token counts are mapped into AgentFlow's prompt/completion/total structure.

The Anthropic endpoint and API version are hardcoded. `AdapterConfig.BaseURL` does not affect this adapter, which limits proxy configuration and isolated HTTP testing.

### 8. Provider Differences

| Concern | OpenAI/NVIDIA | Anthropic |
| --- | --- | --- |
| Endpoint | Configurable compatible base URL | Hardcoded messages endpoint |
| Authentication | Bearer header | `x-api-key` header |
| System prompt | System-role message | Top-level field |
| Tool schema | Function parameters | Input schema |
| Tool request | Assistant function call | `tool_use` block |
| Tool result | Tool-role message | User `tool_result` block |
| Zero output limit | Provider default | Adapter default of 8,192 |
| Usage fields | Prompt/completion/total | Input/output, total calculated |
| Empty provider result | Empty choices rejected | Empty normalized response possible |

The agent runtime independently rejects an empty final output without tool calls. The direct chat handler does not add that runtime-level invariant.

### 9. Retry Mechanics

Both adapters implement the same basic retry loop:

- One initial attempt plus at most three retries in the default registry.
- Exponential waits of one, two, and four seconds.
- Retry HTTP 429 responses.
- Retry HTTP 5xx responses.
- Retry network and response-read failures.
- Do not retry other 4xx responses.
- Do not retry JSON response parsing failures.

The same request body is reused. Context cancellation interrupts HTTP work and retry backoff.

#### Per-attempt rather than whole-call timeout

The HTTP client timeout applies to each attempt. Unless the parent context has an earlier deadline, four 30-second OpenAI-compatible attempts plus backoff can last roughly 127 seconds. Four 60-second Anthropic attempts can last roughly 247 seconds.

#### Duplicate work and billing

A lost response does not prove the provider failed to generate an answer. Retrying after a network/read failure may create and bill another generation. The abstraction supplies no provider idempotency key, so these retries improve availability by accepting possible duplicate cost and nondeterministic repeated work.

#### Backoff limitations

The policy has no random jitter, ignores `Retry-After`, and classifies all network/read failures alike. Multiple processes under rate limiting can retry at the same synchronized intervals.

### 10. Cancellation and Runtime Interpretation

The caller's context is passed into every HTTP request. In a top-level Studio run it ultimately derives from the streaming request, so client disconnection cancels model work. Background summarization uses an explicit 30-second context.

There is no separate overall per-model-call deadline around normal agent execution. The adapter's per-attempt timeout is the main time bound unless a caller supplies an earlier deadline.

The runtime treats wrapped `context.Canceled` or `context.DeadlineExceeded` errors as cancellation. Because HTTP-client timeouts can unwrap to deadline-exceeded errors, provider timeout and caller cancellation are not represented as separate domain conditions. The declared `ErrLLMTimeOut` sentinel is not currently used.

### 11. Consumers of the Abstraction

#### Agent runtime

The runtime resolves `Agent.Provider`, sends the current context/messages/tool definitions to `Agent.Model`, accumulates usage, executes returned tools, and repeats.

#### Summarizer

Context compaction uses the same provider and either `SummarizationModel` or the primary model. The summarizer adds its own three-attempt loop around adapters that already retry, creating retry multiplication, although its background caller currently imposes a 30-second total deadline.

#### Direct chat endpoint

The authenticated `/api/llm/chat` endpoint acts as a thin provider gateway. It returns model text and requested tool calls but does not execute those tool calls.

#### Standalone runtime

Standalone composition validates that every bundled agent's provider is actually registered before its first filesystem mutation. This is stronger fail-fast behavior than Studio agent creation.

### 12. Publication and Studio Validation Differences

Publication checks whether an agent uses a provider protocol known to the code, not whether the publishing Studio process has a credential for it. This keeps bundles portable between environments.

Standalone startup then checks actual provider registration in the destination environment.

Studio agent creation, however, currently checks only that provider and model strings are nonempty. It does not prove that:

- The provider is supported.
- The credential is registered.
- The model appears in the catalog.
- The upstream provider accepts that model identifier.

As a result, some configuration errors are discovered only when a run begins.

### 13. Confirmed Contract Defects and Limitations

#### Temperature zero is not representable through typed configuration

Both adapters omit temperature when it is zero. Agent runtime also replaces an agent temperature of zero with the default `0.7`. The summarizer explicitly requests zero, but the adapters omit it and therefore use provider-default behavior.

The shared contract currently conflates “explicitly use zero” with “unspecified.”

#### Raw parameters can overwrite typed fields

Both adapters build their typed payload and apply `ChatRequest.Params` last. Direct-chat callers can therefore replace model, messages, tools, temperature, output limits, or other fields after typed validation.

This does not expose arbitrary endpoints or API keys, but it makes typed fields non-authoritative and couples callers to provider-specific payload details.

#### Finish reasons are discarded

OpenAI finish reasons are not decoded, and Anthropic `stop_reason` is decoded but not retained. The runtime cannot distinguish ordinary completion from token-limit truncation, filtering, or another provider-specific stop condition. Nonempty truncated text can therefore be treated as a completed answer.

#### Provider response identities are discarded

Response IDs are decoded but not retained in the normalized result or structured runtime logs. Provider-side support, billing, and incident correlation are harder as a result.

#### Outbound response bodies are unbounded

Both adapters use `io.ReadAll` without an application-level maximum. The inbound API has a 1 MiB body cap, but provider responses do not have a corresponding limit.

#### Error taxonomy is only partially used

Rate-limit, invalid-key, and bad-request sentinels are wrapped. The timeout and internal-error sentinels are unused. Direct chat maps every upstream error to HTTP 502 instead of translating those categories.

#### Upstream error details cross boundaries

Provider error text is logged and returned to authenticated direct-chat callers. API keys are not logged, and successful prompt bodies are not logged, but provider error bodies may still contain request-related or operational details.

### 14. Operational and Security Boundary

Provider keys are process-wide shared credentials rather than per-user credentials. The direct chat endpoint requires authentication, but signup is public and no application-level provider quota or rate limiter was found in the inspected backend.

If Studio is Internet-facing, an ordinary account can use shared provider credits through arbitrary chat calls. An external gateway or closed deployment may reduce this exposure, but the backend does not establish that protection itself.

The direct endpoint accepts arbitrary tool definitions but only returns the provider's requested calls; it does not execute them. This limits the immediate authority of that endpoint.

### 15. Observability

Adapters log:

- Endpoint and model.
- Message and tool counts.
- Request and response sizes.
- Status codes.
- Per-attempt and total duration.
- Basic usage.
- Tool-call IDs and names.

They use `log.Printf`, not the request/run-scoped structured logger, so adapter entries do not automatically inherit request ID, run ID, user ID, or thread ID. NVIDIA calls are also labeled as OpenAI because both share the same adapter implementation.

Normalized usage does not preserve cached-token, reasoning-token, price, or provider-specific accounting details.

### 16. What the Abstraction Does Not Represent

The current contract intentionally focuses on text plus tools. It does not directly model:

- Provider token streaming.
- Images, audio, or other multimodal content.
- Structured-output/response-format contracts.
- Finish reasons.
- Provider request IDs.
- Cached/reasoning token details.
- Tool-choice policy.
- Provider safety decisions.
- Multiple response candidates.

AgentFlow's SSE output is a stream of runtime lifecycle events, not provider-generated token deltas. Each provider completion is received as one complete HTTP response.

Adding these features would require extending the internal port, not merely editing one adapter.

### 17. Architectural Strengths

- A small shared interface isolates protocol differences.
- The abstraction has multiple real implementations and test fakes.
- NVIDIA reuses a compatible adapter instead of duplicating code.
- Context cancellation reaches outbound requests and backoff.
- Basic usage and tool-call structures are normalized.
- API credentials stay on the server.
- Publication remains portable while standalone startup validates environment capability.
- Connection clients are reused per adapter rather than created per call.

### 18. Architectural Weaknesses

- No adapter-level unit tests verify translation or retry behavior.
- Zero temperature has ambiguous/incorrect semantics.
- Raw parameters can bypass typed payload invariants.
- Retry policy can duplicate cost and lacks jitter and `Retry-After` handling.
- Provider responses have no size cap.
- Finish reasons and provider request IDs are lost.
- Catalog, runtime credentials, and stored agent configuration can drift.
- Direct chat consumes shared credentials without application-level quota enforcement.
- Adapter logs lack structured request/run correlation.
- Anthropic's hardcoded endpoint makes proxying and isolated testing difficult.
- Registry mutation and overwrite behavior are safe only by convention.

### 19. Alternatives and Trade-Offs

#### Expose each provider directly to the runtime

This avoids a lowest-common-denominator contract but spreads provider branching across orchestration, tests, tools, and summarization.

#### Create a very rich universal interface immediately

This could preserve every provider feature but would add many optional fields and unclear semantics before the runtime needs them. The better evolution path is to extend the port when a concrete cross-provider feature is required.

#### Remove raw `Params`

This restores strong typed invariants and portability, but makes experimental provider features require code changes. A safer compromise would prevent overrides of typed core fields and namespace provider-specific options.

#### Validate every model against the catalog

This catches typos early but turns an informational catalog into an allowlist that must be continuously maintained. Validation can instead distinguish warning-level unknown models from hard provider/credential failures.

#### Disable retries

This eliminates duplicate generation cost but reduces resilience to throttling and transient network failures. A more precise policy would honor provider guidance, add jitter, use a total deadline, and expose attempt information.

### 20. Test Evidence and Gaps

Existing tests cover:

- Provider-table construction.
- Registered and missing provider lookup.
- Registry overwrite behavior.
- Sorted defensive supported-provider results.
- Model-catalog listing and empty-list behavior.
- Direct handler validation and HTTP success/failure behavior.
- Execution and summarization through fake `LLMClient` implementations.

No adapter-level tests were found for:

- OpenAI payload construction.
- Anthropic message/tool-block translation.
- Provider response parsing.
- Retry status classification and backoff.
- Cancellation during real adapter work.
- Zero-temperature behavior.
- Raw-parameter override behavior.
- Response-size enforcement.
- Provider error mapping.
- Reasoning-model parameter selection.

These tests were inspected but not executed during this documentation pass. Current live provider specifications were also not consulted, so this chapter describes repository behavior rather than asserting compatibility with the providers' latest external APIs.

### 21. Source Map

1. `backend/llm/llm_interface.go` — normalized request, message, response, tool, usage, error, and adapter contracts.
2. `backend/llm/llm_registry.go` — supported-provider table, environment registration, lookup, and availability.
3. `backend/llm/openai.go` — OpenAI-compatible encoding, retry, parsing, errors, and reasoning-model rules.
4. `backend/llm/anthropic.go` — Anthropic content-block translation, retry, parsing, and error mapping.
5. `backend/agent/runtime.go` — primary model-call loop and usage accumulation.
6. `backend/agent/summarizer.go` — compaction model selection and outer retry loop.
7. `backend/handlers/llm.go` — model listing and authenticated direct chat gateway.
8. `backend/model/llm.go` — persisted model-catalog record.
9. `backend/repo/mongorepo/llm_model_repo.go` — model-catalog listing.
10. `backend/repo/mongorepo/agent_repo.go` — model context-limit lookup and fallback.
11. `backend/deployment/bundle.go` — supported-provider publication and registered-provider runtime validation.
12. `backend/main.go` and `backend/runtime/app.go` — Studio and standalone composition.
13. `backend/llm/registry_test.go`, handler tests, repository tests, and fake-client runtime tests — intended guarantees and current test gaps.

### 22. Chapter Summary

The LLM layer gives the rest of AgentFlow one small text-and-tools interface while two adapters translate OpenAI-compatible and Anthropic protocols. Provider support, credential registration, and UI model cataloguing are separate states; publication validates portability while standalone startup validates actual environment capability. Context cancellation and basic retries exist, but timeouts apply per attempt and repeated generation can duplicate cost. The most important current contract problems are the inability to express zero temperature, raw parameter overrides, lost finish reasons and provider IDs, unbounded response bodies, configuration drift, and shared provider spending without backend quotas.

## Chapter 6: Multi-Agent Coordination

### 1. Why This Layer Exists

AgentFlow allows one agent to delegate work to another agent. The phrase "call another agent" sounds simple, but a production implementation has to answer several separate questions:

1. Is the parent supposed to wait immediately, suspend until later, or finish without waiting?
2. How is the child conversation kept separate from the user's main conversation?
3. How are recursion, cycles, and unbounded fan-out prevented?
4. How does cancellation reach every descendant of the original request?
5. Who owns an asynchronous job if several coordinator processes see it?
6. What happens if a coordinator or worker dies halfway through?
7. How is a stale worker prevented from overwriting a newer result?
8. How does a suspended agent resume with the right job result in the right tool-call position?
9. How is a background result delivered after the original HTTP request has ended?

This layer answers those questions by combining:

- delegation-aware tools in the agent runtime;
- explicit run lineage;
- hidden delegate sub-threads;
- an in-process message bus;
- per-agent worker pools;
- durable jobs, task ledgers, runs, checkpoints, and locks;
- a polling job coordinator;
- leases and fenced state transitions;
- tree-wide cancellation;
- parent suspension/resume and background callback runs.

A compact mental model is:

```text
User request
    |
    v
Root agent run
    |
    +---- synchronous delegate ----> child agent ----> immediate tool result
    |
    +---- required async job ------> durable job ----> suspend parent
    |                                      |
    |                                      +--------> resume parent with result
    |
    +---- background async job ----> durable job ----> parent may finish
                                           |
                                           +--------> callback run later
```

The implementation is best understood as three cooperating planes:

```text
Execution plane
    In-process bus + pools + workers
    Runs work now and transports live events/replies.

Coordination plane
    Coordinator + admission rules + locks + leases
    Decides who may run and detects abandoned ownership.

Durability plane
    Tasks + jobs + runs + checkpoints + sub-threads + messages
    Preserves the state that must survive request or process loss.
```

The execution plane is fast but temporary. The durability plane is authoritative. The coordination plane safely moves work between them.

### 2. The Identifiers and Their Boundaries

Several identifiers coexist because they represent different ownership boundaries:

| Identifier | Meaning | Important uses |
| --- | --- | --- |
| `originator_run_id` | Root run of the complete delegation tree | Tree cancellation, total run budget, per-tree async concurrency, target serialization |
| `run_id` | One concrete agent execution | Checkpoints, status, event topic, stale-attempt fencing |
| `parent_run_id` | Run that created a child | Lineage, callback/job relationships, synchronous budget idempotency |
| `job_id` | One durable asynchronous request | Queue state, await, delivery, leases, callbacks |
| `thread_id` | Conversation loaded by a run | History, summary, message persistence |
| `child_thread_id` | Hidden delegate conversation | Repeated conversations with one target inside a task tree |
| `tool_call_id` | LLM-issued call identity | Job and run-budget idempotency, tool-result pairing |

For example:

```text
Originator run R1, agent A
├── child run R2, agent B
│   └── child run R3, agent C
└── child run R4, agent D
```

Every node has a different `run_id`, but all four have `originator_run_id = R1`. That is why cancellation and budgets can apply to the tree while checkpoints and terminal writes remain specific to one execution.

The run also carries a delegation chain and depth:

```text
chain = [A, B, C]
depth = 2
```

The chain is the cycle-detection input. Depth is the nesting limit. They are copied into checkpoints so the same guards continue to work after a resume.

### 3. Four Invocation Kinds

The domain declares four invocation kinds:

```text
top_level
sync_delegate
async_job
callback
```

They are not decorative labels. The worker uses them to decide what state it owns after the runtime returns.

#### Top-level

A user message or explicit resume starts the main agent. The top-level run is also the originator of a new task tree.

#### Synchronous delegate

The parent calls a configured delegate tool and waits for its answer. The result becomes an ordinary tool-result message in the parent loop.

#### Asynchronous job

The parent creates durable work through `dispatch_agent`. The child executes independently, and the parent either waits through a checkpoint or continues without the result.

#### Callback

A completed background job causes the parent agent to run again on the parent thread with system context explaining the completed or failed work.

This separation prevents job outcome, parent outcome, and callback-delivery outcome from being collapsed into one ambiguous status.

### 4. Top-Level Dispatch Paths

The `Dispatcher` port exposes two operations:

- dispatch a run and stream events;
- estimate the system-prompt size through the shared preparer/runtime path.

There are two concrete top-level dispatchers.

#### `DirectDispatcher`

Studio uses this by default. The HTTP-side goroutine prepares and runs the root agent directly. The bus and pools are still required because synchronous delegates, async jobs, automatic resumes, and callbacks use them.

#### `BusDispatcher`

Studio selects this when `MESSAGEBUS_DISPATCH=true`. The standalone runtime always uses it. It:

1. ensures the target agent pool exists;
2. subscribes to `task.<run-id>.events`;
3. sends a request to `agent.<agent-id>.dispatch`;
4. forwards worker events to the caller's event channel;
5. waits for a correlated reply;
6. waits for the terminal or waiting event to drain before returning.

Its configured request timeout is 30 minutes. A request-layer failure causes cancellation of the complete originator tree because the caller can no longer reliably own the result.

Despite its name, `BusDispatcher` does not make dispatch distributed. Both compositions currently use `InProcBus`, so the bus remains inside one Go process.

### 5. Run Preparation Is Shared

`RunPreparer` keeps direct and bus-dispatched runs consistent.

For a fresh run it:

1. verifies that the requested user owns the thread;
2. verifies that the requested agent matches the thread's agent;
3. loads the agent and recent message history;
4. applies the same context-compaction decision described in Chapter 2;
5. establishes lineage defaults;
6. creates the task-budget ledger for a top-level run;
7. builds the runtime context.

For a resumed run it:

1. loads the latest checkpoint;
2. loads the checkpoint's agent through the system lookup;
3. rebuilds the effective tool set;
4. validates structural tool compatibility;
5. restores lineage, invocation kind, job ID, system context, and attempt.

Centralizing these operations means a root run, child run, async run, and callback do not each invent their own ownership and checkpoint semantics.

### 6. The In-Process Message Bus

The current bus is a channel-backed exact-topic bus for one Go process.

Topic conventions include:

```text
agent.<agent-id>.dispatch
task.<run-id>.events
task.<originator-run-id>.cancel
reply.<correlation-id>
```

Publishing broadcasts a cloned message to every subscription on the topic. Copying the body and headers prevents one subscriber from mutating another subscriber's view.

Worker pools obtain queue semantics by sharing one subscription across their worker goroutines. The bus broadcasts to subscriptions, but the goroutines compete to receive from the one shared subscription channel, so one worker handles a dispatch.

The request/reply helper:

1. creates a correlation ID;
2. subscribes to `reply.<correlation-id>` before publishing;
3. adds `ReplyTo` and `CorrID` to the request;
4. waits for the reply, subscription close, context cancellation, or timeout.

The bus provides live transport, but it does not provide:

- durable messages;
- cross-process communication;
- broker acknowledgements;
- redelivery after a process crash;
- replayable event history;
- consumer offsets.

By default, `Publish` waits for each subscriber's channel to accept the message. Optional drop and per-subscriber timeout settings exist, but production dispatcher calls do not currently use them. A full or abandoned subscriber can therefore delay a publisher until its context is cancelled. Several maintenance publishes use `context.Background()`, so those paths do not have a caller deadline.

### 7. Per-Agent Worker Pools

`PoolManager` lazily creates one `AgentPool` per agent ID. Each pool currently has four workers and one shared dispatch subscription.

```text
Agent A pool: one subscription + four competing workers
Agent B pool: one subscription + four competing workers
Agent C pool: one subscription + four competing workers
```

`Ensure` holds a mutex around lookup and creation, so concurrent first use of the same agent converges on one pool.

A worker performs this sequence:

1. decode the dispatch payload;
2. default missing originator identity;
3. reject a task tree that is already cancelled;
4. create a run context owned by the pool lifecycle;
5. subscribe to tree cancellation and recheck durable cancellation;
6. prepare the run;
7. create a worker-event channel and event-forwarding goroutine;
8. start a job/callback lease heartbeat when applicable;
9. enter `AgentRuntime.RunStream`;
10. wait until worker events have been drained;
11. perform invocation-kind-specific bookkeeping;
12. publish a correlated reply when one was requested.

Pool shutdown cancels the pool context, unsubscribes, and waits for every worker goroutine. The standalone runtime explicitly waits for the coordinator before stopping pools, the bus, and SQLite.

Pools have no idle eviction. Every newly used agent remains in the manager until shutdown, consuming four goroutines and a subscription. High agent cardinality can therefore produce unbounded long-lived pool resources.

### 8. Synchronous Delegation

Each configured `Agent.Delegates` entry becomes a model-visible tool, for example:

```text
ask_researcher({"task":"Compare the two deployment strategies"})
```

The tool itself is deliberately small. It extracts trusted lineage from the runtime context, validates the task argument, and calls the injected `DelegateInvoker`.

The concrete `BusDelegateInvoker` owns the coordination flow:

```text
Parent model
   |
   v
delegate tool
   |
   +-- enforce depth
   +-- reject cycles
   +-- verify target ownership
   +-- consume task-tree run budget
   +-- find/create hidden sub-thread
   +-- create child run
   +-- ensure target pool
   +-- subscribe to reply topic
   +-- publish child dispatch
   +-- wait for child reply
   |
   v
Child output becomes the parent's tool result
```

#### Depth guard

The default maximum delegation depth is five. A root begins at depth zero. Children may therefore be admitted at depths one through five, but a run already at depth five cannot delegate again.

#### Cycle guard

The target is rejected if its agent ID already appears in the delegation chain. This catches direct and indirect cycles:

```text
A -> A
A -> B -> A
A -> B -> C -> A
```

It also means the same target cannot appear twice anywhere along one ancestry path, even if the second call would have had a different task.

#### Ownership guard

The target is loaded using target ID and parent user ID. A failure is returned as the generic `ErrDelegateNotOwned`, avoiding a distinction between a missing agent and another user's agent.

#### Hidden sub-thread

The storage layer atomically creates at most one sub-thread for:

```text
(user_id, originator_run_id, target_agent_id)
```

All calls to the same target during one originator task share this thread. The delegate can therefore build on its earlier work inside the task, while another root task receives an independent conversation. Sub-threads have kind `sub` and are excluded from normal user thread listings.

Both MongoDB and SQLite enforce convergence under concurrent creation. MongoDB uses a partial unique index; SQLite uses its unique constraint and transactional insert/read path.

#### Same-target serialization within a model batch

The runtime groups synchronous delegate calls by target:

- different targets run in parallel;
- calls to the same target execute sequentially, even when exposed through different tool names.

This protects the shared target sub-thread from concurrent updates inside one tool batch. It is not a system-wide lock: other parent runs can still invoke the same target agent concurrently.

#### Detached dispatch handoff

After the child run has been created, subscribe and publish use `context.WithoutCancel(ctx)`. The reason is ownership transfer. Publishing with an already-cancelled caller context could leave a durable child run that no worker ever receives and nobody finalizes.

Once publish succeeds, the worker owns the child status. The invoker may return promptly when the caller is cancelled, while tree cancellation stops the worker separately.

The trade-off is that the detached publish itself has no caller cancellation or explicit timeout. A blocked local subscription can delay that handoff indefinitely.

#### Result persistence

After a successful reply, the invoker writes the delegated user task and child's new messages to the hidden sub-thread. This write is best-effort. Failure does not invalidate the output already returned to the parent, so execution and durable conversation history can diverge.

If the caller is cancelled after dispatch and returns before receiving the reply, the invoker does not reach this persistence step. Synchronous payloads do not ask the worker to persist these messages independently.

### 9. Durable Asynchronous Delegation

When async-job capability is enabled and an agent has delegates, the runtime adds two general coordination tools:

```text
dispatch_agent
await_job
```

`dispatch_agent` accepts:

- a configured delegate tool name;
- a task;
- mode `required` or `background`;
- an optional callback instruction for background mode.

It resolves the delegate tool name through the effective `ToolSet`; the model cannot supply an arbitrary target agent ID. It then applies cycle and depth checks and writes a durable job.

Both async tools are rejected inside a synchronous delegate run. This prevents a synchronously blocked parent from depending on a child that suspends itself through the async-job protocol. Async jobs and callbacks are not subject to that particular invocation-kind restriction and may create further asynchronous work within normal depth and budget limits.

### 10. Async Dispatch Idempotency

Job creation is idempotent by:

```text
(parent_run_id, tool_call_id)
```

The job ID is derived deterministically from that pair, and both repositories enforce uniqueness. Replaying the same tool call returns the existing job and does not charge another run-budget unit.

The first payload wins. If a replay presents the same pair with a changed task, target, mode, or callback instruction, the repository returns the existing job unchanged instead of raising a conflict. This favors deterministic replay, but it can conceal a caller bug that reuses a tool-call ID for different work.

Budget consumption and job insertion are separate persistence operations in both implementations. The budget charge is idempotent, but there is no transaction spanning the task ledger and job record. If insertion fails after the budget is admitted, a run unit can remain consumed without a corresponding job.

### 11. Job and Callback Records

A job record contains four groups of information:

#### Request and ownership

- parent run, originator run, parent thread, parent agent, and user;
- tool-call ID, delegate tool, target agent, task, mode;
- delegation chain and depth;
- callback instruction.

#### Job execution

- job status;
- child run and child thread;
- output or error;
- start and finish timestamps.

#### Await delivery

- awaiting parent run;
- await tool-call ID;
- awaiting timestamp;
- delivered timestamp and delivered call ID.

#### Callback execution

- callback status;
- callback run ID;
- callback-specific error.

Job errors and callback errors are deliberately separate. A callback failure must not overwrite a successfully completed job result that `await_job` may return.

### 12. The Job Coordinator

The job coordinator starts with the application, performs one immediate pass, and then wakes on either:

- a one-second ticker; or
- the coalesced `JobHub` wake channel.

Each pass performs five phases in order:

1. fail abandoned running jobs;
2. fail abandoned running callbacks;
3. launch queued or reclaimable-starting jobs;
4. resume parent runs whose complete awaited set is terminal;
5. launch queued callbacks.

The in-memory hub reduces completion latency, but polling durable records is the correctness path. `JobHub.Wait` exists but has no current production caller; the hub is presently used only as a coalesced coordinator wake signal.

### 13. Async Admission Controls

Before claiming a queued job, the coordinator applies two policies.

#### Per-originator active cap

The default maximum is five active async jobs for one originator task. This is independent of the total task run budget.

#### Per-target serialization

Only one async job for the same `(originator_run_id, target_agent_id)` may be running at a time. Jobs targeting different agents can run concurrently.

#### Why admission itself needs a lock

Counting active jobs and claiming a job are separate operations. Without a per-originator admission lock, two coordinator instances could both observe four active jobs under a limit of five and both admit another job.

The short admission lock protects only count-plus-claim. It is released immediately after the durable `starting` claim because that new state is included in future active counts. Holding it through actual dispatch would unnecessarily serialize different targets.

### 14. Job State Machine

The normal job state machine is:

```text
queued
   |
   v
starting
   |
   v
running
   |
   +------> succeeded
   +------> failed
   +------> cancelled
```

#### `queued`

The durable request exists, but no coordinator owns its dispatch attempt.

#### `starting`

A coordinator has claimed the job with an owner ID and lease. It is resolving the hidden thread, creating the child run, ensuring the pool, and constructing the payload.

If the coordinator disappears in this phase, an expired `starting` job can be reclaimed by another coordinator.

#### `running`

`MarkJobDispatched` has atomically recorded the child run/thread and changed the job to running. Only after that compare-and-set succeeds does the coordinator publish to the bus.

#### Terminal

The worker marks success, failure, or cancellation only if its child run ID still matches the job. A terminal transition clears the active job lease and releases the target lock.

If bus publication fails after the job has been marked running, the coordinator marks the child run and job failed. If an abandoned running lease expires later, the coordinator also marks the job failed. Running work is not automatically requeued.

### 15. Locks, Leases, and Fences

These mechanisms solve related but different problems.

#### Lock: may this category run concurrently?

The system uses:

- an admission lock for one originator;
- a target lock for one originator and target agent;
- a callback-thread lock for one parent thread.

Locks have an owner and expiry. The same job may refresh or reacquire an unexpired lock only when the owner also matches; knowing the job ID alone is not enough to steal it.

#### Lease: who owns this work temporarily?

Job and callback leases default to 30 seconds. A worker refreshes the relevant record and lock immediately and then approximately every lease/3, normally every 10 seconds. Each refresh attempt has a five-second timeout.

Lease expiry answers "the previous owner is no longer demonstrating life." It does not prove whether an external side effect completed.

#### Fence: may this execution attempt write the outcome?

Consider:

```text
child run C1 starts
      |
C1 lease becomes stale
      |
a newer attempt owns the durable job
      |
C1 wakes and reports success late
```

A terminal write fenced only by `job_id` would allow C1 to overwrite the newer outcome. The repositories therefore require `child_run_id == C1` before accepting C1's terminal write. Callback terminal writes similarly require the expected `callback_run_id` and current callback state.

Repository methods return an `applied` boolean because a database update can succeed technically while matching zero rows. Callers publish completion notifications only when the fenced transition actually applied.

### 16. Required Jobs: Suspend Instead of Holding a Goroutine

A required job means the parent must receive its result before producing a final answer.

The model can call `await_job` explicitly. In addition, if it attempts to finish while required jobs remain undelivered, the runtime synthesizes deterministic `await_job` tool calls. This prevents a required job from being silently ignored by the final answer.

If every requested job is terminal, the result becomes a normal tool-result message and is marked delivered.

If at least one is pending:

1. the runtime records each job and its await tool-call ID;
2. the job records receive a reverse link to the awaiting parent run;
3. a checkpoint is saved with phase `waiting_for_jobs` and `PendingAwaits`;
4. the runtime returns `RunResultWaiting`;
5. its defer changes the run to `waiting_for_jobs`;
6. the event stream ends with `run.waiting`.

No goroutine remains blocked waiting for a long-running job. The durable checkpoint is the continuation.

### 17. Automatic Resume

The coordinator finds a waiting run ready only when every undelivered job linked to that run is terminal. The repositories scan the complete awaiting set before applying the final result limit; otherwise truncating a query could falsely declare a run ready after seeing only its terminal subset.

For each ready run, the coordinator:

1. reloads the durable run record;
2. verifies it is still `waiting_for_jobs`;
3. skips or cancels it if the originator is cancelled;
4. atomically transitions `waiting_for_jobs -> running`;
5. ensures the agent pool exists;
6. increments the attempt;
7. publishes an `IsResume` payload.

On resume the runtime:

1. loads and validates the waiting checkpoint;
2. resolves the saved pending awaits;
3. returns to waiting if any job somehow remains nonterminal;
4. marks all terminal results delivered;
5. appends tool messages using the original await call IDs;
6. continues the normal model loop.

Preserving the original await call ID is required for a valid LLM transcript: every assistant tool call must receive the corresponding tool result.

### 18. Nested Required Work

An async child run can itself dispatch and await async work. If that child returns `RunResultWaiting`, the worker deliberately leaves its outer job in `running` rather than treating the temporary runtime return as success.

Its heartbeat stops while suspended, so the lease may expire. The coordinator checks the child run status before failing an expired job. A child in `waiting_for_jobs` is skipped because it is legitimately suspended rather than abandoned.

When the nested jobs complete, the coordinator resumes the child run. The worker restarts the heartbeat using the same job and child-run identity. Only the child's eventual completion terminates the outer job.

### 19. Background Jobs and Callback Runs

A background job allows the parent to continue and potentially finish before the delegated work completes.

Its callback state is independent:

```text
job:
queued -> starting -> running -> succeeded/failed/cancelled

callback:
queued -> running -> completed/failed/cancelled
```

After the job becomes terminal, the coordinator selects background jobs whose callback is queued. It serializes callbacks by parent thread so two completed jobs do not concurrently append follow-ups to the same conversation.

It then:

1. acquires the callback-thread lock;
2. atomically claims the callback and assigns a callback run ID;
3. creates a child run on the parent agent and parent thread;
4. constructs system context containing the job ID, tool, status, callback instruction, and result or error;
5. dispatches that callback run through the parent's pool;
6. lets the worker persist the callback's new messages;
7. marks callback completion independently of job completion.

The callback is not streamed through the original HTTP connection, which may no longer exist. Its durable messages are the later follow-up visible in the parent conversation.

An expired running callback is marked failed rather than retried. Callback failure is stored in `callback_error` and does not change the job's own output or error.

### 20. Task-Tree Run Budget

Every top-level run ensures a durable task ledger keyed by `originator_run_id`. The first creation owns the maximum; later calls do not reset usage or silently replace the cap.

The root agent's `MaxRuns` supplies the configured cap. A non-positive value becomes `DefaultMaxTaskRuns`, currently 50.

Budget is consumed by:

- each newly admitted synchronous delegated run;
- each newly admitted async job.

Budget is not consumed by:

- the top-level run itself;
- resuming an existing run;
- replaying an already-admitted budget key;
- the callback run associated with an already-admitted background job.

The concepts must remain separate:

```text
MaxRuns          limits total delegated tree growth.
ConcurrentJobs   limits simultaneous async jobs per tree.
MaxDepth         limits ancestry depth.
Pool workers     limit simultaneous executions for one agent in one process.
```

Synchronous budget keys normally use `(parent_run_id, tool_call_id)`. Async budget keys use the same stable pair with a different namespace. Both stores guarantee that an admitted key remains an accepted replay even after the cap has subsequently been exhausted.

### 21. Cancellation as a Tree Operation

Cancellation is keyed by `originator_run_id`, not the current run ID.

When a top-level context ends, the dispatcher:

1. marks the originator in the shared in-memory `CancelRegistry`;
2. stores cancellation in the durable task record;
3. publishes to `task.<originator-run-id>.cancel`.

Workers subscribe to that topic and cancel their run contexts. They also check the registry and durable task before starting.

There is an important race:

```text
dispatch is published
      |
cancellation is published
      |
worker subscribes after the cancellation message
```

Because the bus does not replay, that worker would miss the event. The worker therefore rechecks in-memory and durable cancellation after subscribing. The registry keeps cancellation sticky for ten minutes, while the durable task record survives process restart.

The coordinator also checks durable cancellation before launching queued jobs, resuming parents, or launching callbacks.

Durable cancellation reads currently fail open: a storage error is interpreted as "not confirmed cancelled." Several cancellation writes use `context.Background()` and ignore errors, so a storage outage can weaken the durable part of the cascade even though local cancellation may still work.

### 22. Failure Ownership

The code carefully separates which component owns a terminal status.

#### Before `RunStream`

If payload decoding, pre-cancellation, or preparation fails, the worker owns run and job/callback failure because the runtime never started.

#### Inside `RunStream`

Once entered, the runtime defer owns the run status. The worker must not overwrite it.

#### Before async dispatch is durably recorded

The coordinator fences failure by its claim owner because no child run ID is yet stored.

#### After async dispatch is recorded

Failure and completion are fenced by child run ID.

#### Synchronous pre-dispatch failure

Once the invoker has created a child run but fails before successful bus publication, it marks that child failed because no worker can ever own it.

#### Worker panic

The pool recovers a panic, marks the run failed, and publishes an error reply. The panic recovery path does not directly perform async job/callback terminal bookkeeping. Such a job can remain running until lease-expiry recovery marks it failed, producing delayed rather than immediate job finalization.

### 23. Persistence and Crash Recovery

Durable state includes:

- task cancellation and run-budget ledger;
- job and callback state;
- job locks and leases;
- run records and checkpoints;
- hidden sub-threads;
- persisted messages.

In-memory-only state includes:

- bus messages and subscriptions;
- live stream events;
- request/reply waiters;
- worker goroutines;
- the fast cancellation registry;
- coordinator wake notifications.

Current crash behavior is:

| Crash point | Recovery behavior |
| --- | --- |
| Job is `queued` | A coordinator can launch it later. |
| Job is `starting` and its lease expires | Another coordinator can reclaim the claim and dispatch it. |
| Job is `running` and its lease expires | It is marked failed, unless the child run is legitimately waiting for nested jobs. It is not automatically rerun. |
| Parent is `waiting_for_jobs` with a checkpoint | It can be resumed after its complete awaited set becomes terminal. |
| Callback is running and its lease expires | Callback is marked failed; it is not requeued. |
| Bus message is only in flight | It is lost with the process. |
| Synchronous delegate is replayed from an earlier checkpoint | Budget admission is idempotent, but the delegate execution itself may run again under a new child run. |

The design therefore offers durable orchestration for async jobs and suspended parents, but it does not claim exactly-once execution. Running-work retry is conservative because an agent may already have produced non-transactional external side effects before disappearing.

### 24. Studio and Standalone Composition

#### Studio

- MongoDB stores runs, checkpoints, tasks, jobs, locks, threads, and messages.
- Top-level dispatch is direct by default and bus-based when explicitly enabled.
- Delegates, async jobs, callbacks, and coordinator resumes always use the local bus and pools.
- Multiple Studio replicas can coordinate async claims through shared MongoDB locks and compare-and-set updates.
- Their live buses, replies, event streams, cancellation topics, pools, and hubs remain process-local.

An async job claimed by one replica is dispatched to that same replica's local pool. Shared persistence enables claiming and recovery, but the bus is not a replica-to-replica transport.

#### Standalone runtime

- SQLite stores the same orchestration concepts.
- Top-level requests use `BusDispatcher`.
- The same local coordinator, pools, and in-process bus are constructed.
- Shutdown first stops HTTP intake, then cancels runtime work, waits for the coordinator, stops pools, closes the bus, and finally closes SQLite.

The MongoDB and SQLite repositories are intended to implement the same storage-neutral job and task contracts. Shared conformance suites pin the important compare-and-set, idempotency, budget, await, lock, lease, and fence behavior.

### 25. Event and Observability Behavior

The layer emits live events for:

- run lifecycle;
- job dispatch;
- job start;
- job completion or failure;
- tool execution;
- waiting and resumption.

Agent-pool event forwarding deliberately keeps draining the runtime event channel even if bus publication fails. Otherwise the runtime could block permanently after filling the 128-event worker buffer.

Events are not durable. A late or disconnected listener cannot replay them. Durable status must be obtained from runs, jobs, checkpoints, and messages instead.

Coordinator and worker warnings cover claim, lock, lease-refresh, queue, resume, and callback errors. There are no dedicated metrics for queue depth, lease expiry, pool count, blocked publication, job latency, callback latency, or cancellation propagation.

### 26. Architectural Strengths

1. **Lineage is explicit.** Root, parent, child, chain, depth, invocation kind, and job identity are carried through dispatch and checkpoints.
2. **Async intent is durable before execution.** A queued job survives request completion and process interruption.
3. **Long waits suspend instead of occupying goroutines.** Required jobs checkpoint the parent and resume it later.
4. **Idempotency is based on stable tool-call identity.** Checkpoint replay does not create duplicate async jobs or duplicate budget charges.
5. **Ownership transitions use compare-and-set behavior.** A technically successful zero-row update is not mistaken for ownership.
6. **Stale completions are fenced by execution ID.** Superseded workers cannot overwrite the legitimate attempt.
7. **Job and callback outcomes remain separate.** Notification failure does not corrupt delegated-work outcome.
8. **Cancellation combines fast and durable mechanisms.** The post-subscribe recheck closes the transient-bus race.
9. **Per-target sub-threads preserve useful delegate context.** They are hidden from the normal user thread list and isolated per root task.
10. **MongoDB and SQLite share behavioral contracts.** Coordination code is not tied to one persistence engine.

### 27. Limitations and Risks

#### The bus is not distributed or durable

`MESSAGEBUS_DISPATCH=true` changes the local execution route but does not introduce an external broker. Live delivery cannot cross replicas or survive process loss.

#### Running jobs are detected, not retried

Lease expiry after `running` produces failure. Only an expired pre-dispatch `starting` claim is reclaimable. The design avoids blind replay of potentially side-effecting work, but transient process loss becomes a user-visible job failure.

#### Pool cardinality is unbounded

Four workers per lazily seen agent accumulate until shutdown. There is no idle timeout or global worker budget.

#### Concurrency is bounded locally, not globally

The async cap is per originator. Many originators can each admit five jobs, and direct top-level runs do not consume pool workers. No process-wide LLM or tool concurrency limit is present here.

#### Blocking publication can wedge background paths

Default publish waits for subscribers. Background cancellation, job events, and some status-related publishes use contexts without deadlines. The optional bus timeout/drop policies are not applied by production callers.

#### Best-effort persistence can lose conversation evidence

Synchronous delegate history and worker-persisted async/callback messages ignore insertion errors. Job state may say succeeded while the associated conversational transcript is incomplete.

#### Some persistence calls have no bounded context

Job terminal writes, callback writes, durable cancellation, and some message writes use `context.Background()`. A stalled database operation can retain a worker or maintenance path longer than intended.

#### Panic-to-job propagation is delayed

Worker panic recovery finalizes the run and reply but not the async job directly. Lease expiry must later reconcile the job.

#### Budget admission and job creation are not one atomic unit

A storage error between those writes can leave the tree charged without a job. Idempotent keys prevent double charging but cannot roll back a charge whose job never materialized.

#### Synchronous execution remains at-least-once

The budget key is replay-safe, but the child run and external effects are not deduplicated by that key. Parent recovery from a pre-tool-result checkpoint may execute the delegate again.

#### Async and sync depth configuration can drift

The synchronous invoker accepts a configurable maximum depth. The async tool directly uses `DefaultMaxDelegationDepth`. The current composition uses defaults, but a future custom synchronous limit would not automatically apply to async dispatch.

#### Durable cancellation checks fail open on repository errors

The code avoids treating a database outage as proof of cancellation. The consequence is that a late worker may execute work whose durable cancellation could not be read.

#### Observability is mainly logs and ephemeral events

Operators lack first-class metrics and durable transition history for diagnosing queue pressure, lease churn, repeated recovery, callback backlog, and worker saturation.

### 28. Alternatives and Trade-Offs

#### Run every delegate synchronously

This is simpler but keeps parent goroutines and HTTP requests alive for long tasks, cannot naturally deliver background results, and makes process interruption harder to recover.

#### Put all delegation in durable jobs

This would unify execution, but short synchronous calls would pay database, coordinator, polling, and resume overhead. It would also make ordinary tool-call semantics more complicated.

#### Use an external broker

Kafka, NATS JetStream, RabbitMQ, SQS, or another durable transport could provide cross-process delivery, acknowledgements, and redelivery. It would also add deployment, ordering, duplicate-delivery, poison-message, schema-evolution, and operational complexity. The current database-plus-local-bus design fits a smaller deployment but creates a clear scaling boundary.

#### Automatically retry expired running jobs

This improves availability for pure computation but can duplicate emails, payments, writes, or other external effects. Safe retry would require capability-specific idempotency or a declared retry contract rather than a universal coordinator retry.

#### One global worker pool

A global pool would bound process resources, but it would need fairness and per-agent scheduling. The current per-agent pool is easy to understand and isolates local contention, at the cost of cardinality growth.

#### Persist every event

A durable event log would improve replay and incident analysis but increase write volume, retention responsibilities, and consistency questions. Durable state snapshots are currently treated as the authoritative record instead.

### 29. Test Evidence and Gaps

Inspected tests cover:

- in-process publish/subscribe, blocking behavior, cancellation, timeouts, copying, concurrent unsubscribe, and request/reply;
- bus-dispatch round trips and cancellation;
- pre-cancelled worker dispatch;
- idempotent pool creation;
- same-target synchronous tool-call serialization and different-target parallelism;
- depth, cycle, ownership, budget, replay, happy-path, and cancellation behavior for synchronous delegates;
- required-job auto-await suspension and waiting resume;
- coordinator active caps, admission locks, target serialization, durable cancellation, waiting-child lease handling, callback serialization, and automatic resume;
- task-budget first-writer ownership, idempotency, cap enforcement, replay, and concurrency;
- async dispatch/await/delivery contracts;
- claim, lock, lease, callback, and child-run fencing across repository implementations;
- concurrent sub-thread convergence.

Important end-to-end gaps include:

- process-crash injection at every job transition;
- real multi-replica Studio coordination;
- restart recovery of a nested waiting job tree;
- sustained high-cardinality pool creation;
- global load and fairness across many originators;
- blocked production event/cancel subscribers;
- persistence outages during best-effort message writes;
- budget-consumed/job-insert-failed recovery;
- worker panic propagation latency;
- durable event reconstruction;
- true side-effect idempotency across synchronous replay.

These tests were inspected but not executed during this documentation pass.

### 30. Source Map

1. `backend/dispatcher/dispatcher.go` — dispatch payloads, wire results, ports, lineage fields, and job-store boundaries.
2. `backend/dispatcher/direct.go` — direct top-level execution and cancellation cascade.
3. `backend/dispatcher/bus_dispatcher.go` — bus request/reply, event forwarding, stream termination, and request failure behavior.
4. `backend/dispatcher/preparer.go` — fresh/resume preparation, ownership checks, lineage defaults, and task-budget creation.
5. `backend/dispatcher/delegate_invoker.go` — synchronous preflight, budget admission, sub-thread creation, detached dispatch, reply wait, and persistence.
6. `backend/dispatcher/pool_manager.go` — lazy pool creation, shared cancellation registry, and shutdown.
7. `backend/dispatcher/agent_pool.go` — worker lifecycle, cancellation watchers, event forwarding, lease heartbeats, and post-run bookkeeping.
8. `backend/dispatcher/job_coordinator.go` — polling loop, admission, dispatch, expiry, resume, and callback orchestration.
9. `backend/dispatcher/cancel_registry.go` — sticky local tree cancellation.
10. `backend/dispatcher/job_hub.go` — coordinator wake signal and currently unused per-job waiter surface.
11. `backend/bus/bus.go`, `backend/bus/options.go`, and `backend/bus/inproc.go` — bus contract and local channel implementation.
12. `backend/agent/delegate_tool.go` — model-visible synchronous delegate tool.
13. `backend/agent/async_jobs.go` and `backend/agent/async_tools.go` — async domain contract and model-visible control tools.
14. `backend/agent/runtime.go`, `backend/agent/tool_batch.go`, and `backend/agent/checkpoint.go` — delegate scheduling, automatic await, waiting checkpoints, result restoration, and invocation metadata.
15. `backend/agent/task_budget.go` and `backend/agent/agent.go` — default limits and core run/delegate configuration.
16. `backend/runtimectx/context.go` — trusted delegation and memory scope propagated through tool contexts.
17. `backend/model/job.go` — Mongo job, lock, and task document shapes.
18. `backend/repo/mongorepo/job_repo.go` and `backend/repo/sqliterepo/job_repo.go` — durable state machines, locks, leases, awaits, callbacks, and fencing.
19. `backend/repo/mongorepo/task_repo.go` and `backend/repo/sqliterepo/task_repo.go` — cancellation and idempotent tree-budget ledgers.
20. `backend/repo/mongorepo/thread_repo.go` and `backend/repo/sqliterepo/thread_repo.go` — hidden sub-thread convergence and listing behavior.
21. `backend/main.go` and `backend/runtime/app.go` — Studio and standalone composition and lifecycle.
22. Dispatcher, bus, runtime, Mongo-specific, and shared repository conformance tests — intended guarantees and remaining test gaps.

### 31. Chapter Summary

AgentFlow supports three user-meaningful delegation modes on top of four run invocation kinds: synchronous child calls, required durable jobs that suspend and resume the parent, and background jobs that create later callback runs. The originator run identifies the whole tree; individual run IDs identify execution attempts. A local bus and lazy per-agent pools execute work, while durable tasks, jobs, locks, runs, checkpoints, sub-threads, and messages preserve authoritative state. Admission locks prevent cap races, leases expose abandoned ownership, and child/callback run fences reject stale completions. The design has strong durable async coordination and careful state ownership, but the bus and live events remain process-local, running jobs are failed rather than retried, synchronous work is at-least-once, pool growth is unbounded, and several background persistence/publish paths lack bounded contexts or guaranteed message durability.

## Chapter 7: Memory and Scratchpads

### 1. Why This Layer Exists

An LLM does not possess durable application memory merely because it can see the current prompt. Each model call receives a bounded message list assembled by the backend. Information disappears when it is no longer included, and a different run, thread, agent, or process does not automatically inherit it.

AgentFlow therefore separates three kinds of state:

| State | Purpose | Typical lifetime |
| --- | --- | --- |
| Run checkpoint and conversation history | Resume one execution and preserve the visible conversation | One run/thread lifecycle |
| Memory | Curated knowledge that should be available later | Across turns, runs, and possibly agents |
| Scratchpad | Shared working artifacts for agents collaborating on one task tree | One originator task workspace |

The simplest mental model is:

```text
Checkpoint = where execution stopped
Memory     = what should be remembered later
Scratchpad = what this temporary team is working on together
```

Memory and scratchpads both store Markdown bodies on disk, but they intentionally have different identity, ownership, revision, visibility, concurrency, and prompt-injection behavior. Treating them as one generic file store would erase those domain distinctions.

### 2. The Main Architectural Difference

| Concern | Memory | Scratchpad |
| --- | --- | --- |
| Primary purpose | Durable knowledge | Temporary collaboration |
| Identity | Scope-specific memory lineage | User plus originator run |
| Visibility | Thread, agent, or user | All agents in one task tree |
| Authoritative metadata | Append-only MongoDB/SQLite revision log | Per-section `meta.json` commit pointer |
| Current-state index | MongoDB/SQLite metadata projection | Filesystem metadata itself |
| Body storage | Immutable Markdown file per revision | Content-addressed Markdown blob per section version |
| Mutation model | Create, patch, update, retire, restore | Create file, append section, replace owned section |
| Conflict guard | `expected_revision` plus database uniqueness | `expected_hash` plus an in-process workspace lock |
| History API | Yes | No |
| Automatic prompt use | Full user bodies plus agent/thread index | File-count pointer only |
| Retention | Revisions deliberately retained | No cleanup or expiry mechanism |

Memory is a hybrid database-and-filesystem subsystem. Scratchpad v1 is entirely filesystem-backed.

### 3. Trusted Runtime Identity

The model never supplies the `user_id`, `agent_id`, `thread_id`, or originator-run identity used to authorize these stores.

Immediately before tool execution, `agent/tool_batch.go` places two trusted values in the Go context:

```text
MemoryScope
    user_id
    agent_id
    thread_id

DelegationInfo
    originator_run_id
    current run_id
    delegation chain and depth
    user_id
```

Memory tools retrieve `MemoryScope`. Scratchpad tools combine its user and agent with `DelegationInfo.OriginatorRunID`.

The model may choose a requested memory scope, such as `user` or `thread`, but it cannot claim another user's identifier through tool JSON. This makes the runtime context a trust boundary. The guarantee still depends on the HTTP, thread, preparer, and dispatch layers having constructed the run with the correct authenticated identity.

Both memory and scratchpad validate every path segment. Empty values, `.` and `..`, slash and backslash, control characters, and segments longer than 128 characters are rejected before path construction.

### 4. Tool Availability Has Two Gates

The global tool registry registers the eight memory tools only when a memory service exists and the seven scratchpad tools only when a scratchpad service exists.

Registration alone does not expose them to every agent. `BuildToolSet` includes only the registry tool names explicitly listed in that agent's published configuration. Therefore:

```text
service exists
    + tool registered globally
    + agent configuration names the tool
    = model can see and execute the tool
```

The runtime also injects `run_id` and `tool_call_id` after decoding model arguments. Those values are deliberately absent from the public JSON schemas, so the model cannot forge the idempotency identity.

## Part A: Durable Memory

### 5. A Memory Is a Lineage, Not Just a File

A memory consists of four related representations:

1. A stable logical lineage key.
2. An append-only sequence of revision records in MongoDB or SQLite.
3. One immutable Markdown body file per revision.
4. A latest-state metadata projection used for discovery and search.

The lineage key encodes the visibility boundary:

```text
user scope:
    [version, user, user_id, scope, memory_id]

agent scope:
    [version, agent, user_id, agent_id, scope, memory_id]

thread scope:
    [version, thread, user_id, agent_id, thread_id, scope, memory_id]
```

The key is JSON-encoded rather than assembled with an ambiguous delimiter. Consequently the same `memory_id` can coexist in different users, agents, threads, and scopes without referring to the same lineage.

A user-scoped lineage deliberately omits the creating agent. That is what permits another agent serving the same user to see the memory.

### 6. Scopes and Visibility Expansion

The three scopes answer different questions:

- `thread`: should this survive later turns in this exact user-agent conversation?
- `agent`: should this agent remember it across this user's threads?
- `user`: should every agent serving this user be able to use it?

Search scope is hierarchical rather than an exact equality filter:

```text
thread request -> current thread records
agent request  -> current agent records + current thread records
user request   -> user records + current agent records + current thread records
```

The hierarchy means a user-level search asks for everything visible from that level. Callers that need exactly one scope must filter the returned documents, as the context builder does before rendering user preferences.

The execution-scope validator currently requires user, agent, and thread identifiers even when the requested memory scope is only `user`. This keeps one uniform runtime contract, although the narrower lineage itself does not encode all three values.

### 7. Memory Types

Every memory declares one of four semantic types:

- `fact`: durable information believed to be true;
- `preference`: a user or workflow preference;
- `procedure`: reusable instructions or a method;
- `episode`: an event or experience worth retaining.

The type is searchable metadata, not a different storage strategy. All types use the same revision, conflict, TTL, history, and body rules.

Importance is also metadata. Input is clamped to the range zero through one and later affects search-result ordering. It does not override scope or expiry.

### 8. Creating a Memory

The create path is:

```text
Validate execution identity, scope, and type
        |
        v
Construct mutation_id = run_id + ":" + tool_call_id
        |
        v
Use the requested memory_id, or derive a deterministic one
        |
        v
Construct lineage key and replay-check the mutation
        |
        v
Reject an already-existing lineage
        |
        v
Create revision 1, including optional expiry
        |
        v
Commit revision metadata and body
        |
        v
Best-effort project the latest state for search/context
```

If `memory_id` is omitted, the ID is the first eight bytes of SHA-256 over the mutation ID, encoded as sixteen hexadecimal characters. A replay therefore derives the same memory ID.

Create never silently overwrites an existing lineage. An active collision directs the caller toward patch/update. A retired collision directs it toward restore or a new ID.

### 9. Idempotency and Why It Is Needed

Tool execution can be replayed after checkpoint recovery, caller timeout, process interruption, or ambiguous delivery. AgentFlow cannot assume that one logical tool call reaches storage exactly once.

Memory mutations use:

```text
mutation_id = run_id + ":" + tool_call_id
```

Before performing work, the service looks up that mutation. If found on the expected lineage, it returns the already committed revision and ensures its pending body has been finalized. If the mutation ID belongs to a different lineage, it returns a revision conflict.

MongoDB and SQLite both place a unique constraint on `mutation_id`. The check therefore remains safe when two processes race; it is not merely an application-level existence check.

### 10. The Hybrid Commit Protocol

The revision database and filesystem cannot participate in one ordinary ACID transaction. The service instead orders its operations so common partial failures can be repaired:

```text
1. Compute the final revision body path.
2. Write an immutable pending body identified by mutation hash.
3. Append the revision record to MongoDB/SQLite.
4. Rename the pending body to the final revision path.
5. Update the latest metadata projection best-effort.
```

The pending body is installed with a hard link from a temporary file. If two same-mutation writers race, an existing pending path is treated as the idempotent winner rather than overwritten.

Failure behavior is:

| Failure point | Result and recovery |
| --- | --- |
| Before database append | No revision exists; an abandoned pending file can remain after a process crash. |
| Database append returns an error | The service removes its pending body. |
| Database append succeeds, final rename fails | The operation reports failure, but replay/read can finalize the committed revision from the pending body. |
| Final body exists, projection update fails | Direct revision read/history survives; search and prompt discovery may omit the memory until projection repair. |
| Database revision exists and both pending/final body are missing | Metadata survives but the payload is unrecoverable through this subsystem. |

This is a recoverable commit protocol, not a distributed transaction. It favors never losing a committed history record, while accepting temporary projection inconsistency.

The atomic rename prevents readers from observing a partially written file. The helper does not explicitly `fsync` the file and parent directory, so its strongest guarantee is process-level atomicity rather than power-loss durability.

### 11. The Authoritative State and the Projection

The revision store is authoritative for:

- lineage history;
- latest revision number;
- operation and reason;
- mutation idempotency;
- retirement and restore ancestry;
- timestamps, type, importance, and expiry for each revision.

The immutable body file is authoritative for that revision's text. A database row without its body is not a reconstructable memory.

`memory_meta` is a derived latest-state projection. It supports efficient:

- visibility and type filtering;
- expiry and retirement filtering;
- prompt indexes;
- search candidate discovery;
- summaries and `last_read_at`.

Projection updates are monotonic. A stale revision cannot overwrite a newer row, while the same revision may repair derived fields. `last_read_at` is preserved because only explicit read stamping owns it.

Projection errors are logged rather than returned after the authoritative commit. Direct read and history call projection repair before serving the requested lineage. Search cannot repair an unknown missing projection because it discovers candidates through that projection in the first place.

### 12. Revision Concurrency

Patch, update, retire, and restore require `expected_revision` and a non-empty reason.

The caller follows an optimistic concurrency protocol:

```text
Read revision N
        |
        v
Prepare a mutation based on N
        |
        v
Submit expected_revision = N
        |
        +-- latest is still N -> attempt revision N+1
        |
        +-- latest changed   -> revision conflict; re-read and decide again
```

Both repositories enforce uniqueness on `(lineage_key, revision)`. If two writers read revision four and concurrently attempt revision five, one insert wins and the other returns a conflict. This database constraint is the final race-safe guard; the service does not rely on a process mutex.

### 13. Patch, Update, Retire, Restore, and History

`memory_patch` replaces exact blocks. Every `old_text` must occur exactly once, edit ranges may not overlap, and all validation completes before a revision is appended. Edits are then applied from the end of the body toward the start so earlier byte offsets remain valid.

`memory_update` replaces the entire body. It is appropriate when an exact patch is more confusing than stating the complete desired memory, but the caller must preserve any durable material that should remain.

`memory_retire` appends a revision with `retired_at`. It preserves the body and all earlier revisions. A latest read rejects it, and ordinary search/context construction hides it.

`memory_history` returns ordered revision metadata, including operations, reasons, body paths, restore ancestry, and lifecycle timestamps.

`memory_restore` appends a new active revision copied from an earlier body. It never rewrites or deletes history. When latest is retired, omitting `from_revision` selects the newest non-retired revision. When latest is active, the source must be explicit.

Historical `memory_read` deliberately allows retired and expired revisions. Lifecycle filtering applies only when reading the latest state.

### 14. TTL and Expiry

`ttl_days` is accepted only during creation. The computed absolute expiry timestamp is inherited by patch, update, retire, and normal restore operations.

The current public tools cannot:

- extend a TTL;
- remove a TTL;
- assign a different TTL during update;
- restore from an already expired source.

Expiry is enforced logically by latest read, search, and context discovery. It does not delete the revision row or body file. This preserves audit history but means expired storage accumulates.

The application still starts a weekly memory cleanup worker for compatibility, but the worker is intentionally a no-op for versioned memories. `FindExpired` and `SoftDelete` remain on the metadata port for legacy callers/tests rather than driving current lifecycle behavior.

Retirement is reversible through restore. Expiry is effectively non-restorable through the current tool contract.

### 15. Reading and Recency

Latest `memory_read`:

1. calculates the lineage from trusted execution identity;
2. repairs the projection best-effort;
3. loads the latest revision;
4. rejects retirement and expiry;
5. validates/reconstructs the expected body path;
6. reads the immutable file;
7. best-effort stamps `last_read_at`.

An explicit historical revision skips the retirement and expiry checks and does not stamp recency.

`last_read_at` influences automatic prompt ranking. Context injection deliberately does not stamp it; otherwise automatically selected memories would continually reinforce their own ranking without the agent consciously retrieving them.

`Config.ReadWindowDuration` defaults to five minutes and is documented as a read-stamp window, but no production code currently consults it. Every successful explicit latest read attempts a new stamp.

### 16. Memory Search

Memory search is lexical, not semantic or vector-based:

```text
Metadata query for visible candidates
        |
        v
At most 500 projected documents
        |
        v
Recompute and validate each body path
        |
        v
ripgrep fixed-string, case-insensitive search
        |
        v
One first-match location per body
        |
        v
Build snippets and sort results
```

The `rg` invocation uses `-F` and `--`, so model-supplied text is treated as a literal pattern and cannot become a regular expression or command-line flag. Arguments are passed directly to `exec.CommandContext`, not through a shell.

Search has a five-second internal timeout. Default output is five results and the maximum is twenty. Results sort by importance descending, update time descending, and memory ID.

MongoDB and SQLite limit the metadata query to 500 but do not specify an ordering before that limit. Once more than 500 memories are visible, the candidate subset can depend on storage/query behavior rather than importance or recency. Sorting happens only after textual matches are collected.

### 17. Prompt-Time Memory Injection

The context builder rebuilds the system message before each model call. A memory written during one step can therefore influence a later step in the same run.

User-scoped memory and narrower memory are rendered differently.

#### User-scoped bodies

Active user-scoped memories are sorted by `last_read_at`, falling back to creation time. Their bodies are inserted into `<user_preferences>` with three caps:

- at most 25 documents;
- at most 1,000 runes per body;
- roughly 4,000 total rendered characters.

Unreadable bodies are skipped instead of failing the whole model call. Extra records receive an elision note instructing the agent to use memory search.

The current query does not filter to `type=preference`. Every user-scoped fact, preference, procedure, or episode is rendered inside a `<preference>` element. This is a semantic mismatch worth retaining for later design review.

#### Agent and thread index

Agent and current-thread memories are represented only by ID, scope, and first-line summary in `<memories><index>`. The index is capped at fifteen. The model calls `memory_read` or `memory_search` when it needs the full content.

This split favors automatic availability for cross-agent user information while containing token growth for agent/thread histories.

### 18. Memory and Prompt Trust

The context builder XML-escapes memory IDs and content. Escaping prevents stored text from closing tags or structurally rewriting the XML-like prompt.

Escaping does not make prose trustworthy. A stored body can still say, for example, "ignore all previous instructions." User-scoped bodies are placed inside the system-role message, giving persisted content significant model authority.

The current model has no explicit provenance/trust classification separating:

- a user-confirmed preference;
- agent-generated inference;
- content copied from a web tool;
- content originating from another delegated agent.

This is a semantic prompt-injection and memory-poisoning boundary rather than an XML parsing problem. Scope isolation limits who can see a memory, but it does not establish that the content is safe to treat as instruction.

## Part B: Shared Scratchpads

### 19. Workspace Identity

A scratchpad workspace is identified by:

```text
(user_id, originator_run_id)
```

The originator run is the root of the complete delegation tree. Top-level runs, synchronous children, async jobs, nested agents, resumed parents, and callback runs therefore converge on one workspace while belonging to the same task.

A different top-level task gets a different originator ID even if it uses the same user and agents. Scratchpad state does not automatically become cross-task memory.

### 20. Files, Sections, and Attribution

Each workspace contains files. A file has immutable creation metadata and an ordered collection of sections:

```text
workspace
`-- file: deployment-research
    |-- section 0, owned by agent A
    |-- section 1, owned by agent B
    `-- section 2, correction by agent C
```

File metadata records title, creating agent/run, and creation time. Section metadata records heading, owner agent, ordinal, body hash/path, size, preview, mutation ID, creating/editing runs, and timestamps.

Any agent in the workspace may append its own section to an existing file. Only the owning `agent_id` may replace a section. Ownership is not tied to one run, so a later run of the same agent can maintain that agent's contribution.

The tool instructions explicitly tell agents to append a correction rather than edit another agent's section. The rule preserves attribution and makes disagreement visible.

There is no public operation to rename or delete a file or section.

### 21. Scratchpad Mutations and Deterministic IDs

Scratchpad supports three writes:

- create a file with its initial section;
- append a new section;
- replace the full body and heading of an owned section.

Mutation identity is again `run_id:tool_call_id`. Create derives both file and first-section IDs from its mutation. Append derives its new section ID. The resulting prefixes are `spfile_` and `spsec_` followed by a short SHA-256 encoding.

Deterministic IDs make a replay address the same artifact instead of creating another file or section.

Replace retains the existing section ID and requires `expected_hash`. The caller must have observed the current content hash. A stale caller receives a hash mismatch and must re-read before deciding whether its change is still valid.

### 22. Scratchpad Commit Pointer

Scratchpad bodies are named by full SHA-256 content hash beneath the section directory. The service writes immutable content first and `meta.json` last:

```text
Write content/<hash>.md
        |
        v
For create, atomically write file meta.json
        |
        v
Atomically write or replace section meta.json
        |
        v
Best-effort write mutation-log JSON
```

The section `meta.json` is the commit pointer. A section directory containing content but no metadata is incomplete and invisible to listing, reading, searching, prompt file counts, and logical capacity calculations.

During replace, readers continue following the old metadata until the new metadata rename completes. They therefore observe the old committed version or the new committed version rather than a partially written body.

Reads verify that the content hashes to the value recorded in metadata. Missing, oversized, or mismatched content is treated as corruption.

### 23. Scratchpad Idempotency

The workspace contains mutation-log files named by the SHA-256 of the mutation ID. They are a convenience index, not the sole source of truth.

On replay, the service checks:

1. whether the mutation log identifies the same operation and target;
2. whether the requested content hash matches the original mutation;
3. whether the committed section exists;
4. for create/append, whether the deterministic section already carries the requested body;
5. for replace, whether the section's last mutation ID already equals this mutation.

The mutation log is written after the section commit and failure is ignored because the authoritative section is already durable. A replay can fall back to section metadata.

Create replay can also repair a file whose metadata exists but whose initial section commit pointer was lost before becoming durable.

### 24. Writer Concurrency

All writes for one workspace directory acquire one `sync.Mutex`. The lock protects:

- file and section cap checks;
- workspace byte calculations;
- next-ordinal allocation;
- ownership and expected-hash validation;
- commit-pointer replacement.

Readers do not lock. Atomic metadata replacement and immutable bodies let them observe a consistent committed version.

The lock is process-local. The code explicitly assumes that every writer for one originator task uses the same backend process. With several processes writing a shared directory, two writers could both pass a cap or hash check, allocate the same ordinal, or overwrite each other's metadata pointer.

Supporting multi-process writers would require a filesystem lock with suitable distributed semantics, a transactional database, or a compare-and-swap storage service.

The lock map never evicts entries. Each distinct workspace leaves one small mutex in process memory until shutdown.

### 25. Scratchpad Storage and Output Limits

Defaults are:

| Limit | Default |
| --- | ---: |
| Files per workspace | 20 |
| Sections per file | 50 |
| Section body | 8 KiB |
| Current referenced workspace content | 1 MiB |
| Title | 256 bytes |
| Heading | 256 bytes |
| Default search results | 10 |
| Maximum search results | 50 |
| Metadata preview | 200 runes plus marker |

The workspace-byte limit is logical: it sums the files referenced by committed section metadata. Replace subtracts the old current size and adds the new current size.

Old content blobs from replacement and uncommitted crash leftovers remain physically present but do not count toward the logical limit. Without cleanup, physical disk usage can therefore grow beyond the nominal workspace cap.

### 26. Scratchpad Search and Discovery

`scratchpad_list` returns committed files with creator, section count, and logical size. `scratchpad_get_sections` returns attributed summaries and hashes. `scratchpad_read_section` reads and verifies a full committed body.

Search collects only currently referenced content files and invokes `rg` as fixed-string, case-insensitive search. It retains the first matching line per section, hash-verifies the body, sorts by path, and applies the requested output limit.

Search is bounded by the tool execution context rather than a scratchpad-specific timeout. It is lexical and deterministic, not relevance-ranked or semantic.

### 27. Prompt Integration

Scratchpad content is not automatically copied into every system prompt. When a non-empty workspace exists, the context builder adds only:

```xml
<scratchpad>
  files: 3 (use scratchpad_list to browse this task's shared workspace)
</scratchpad>
```

Subagent runs also receive a collaboration block containing parent/originator identity, the delegated task, and the append-correction ownership rule. Top-level runs do not receive that collaboration block, although they still receive the scratchpad pointer when files exist.

This is an intentional pull model. It avoids spending prompt tokens on every shared artifact and reduces automatic instruction authority compared with memory's user-body injection. Scratchpad content can still influence the model when read as a tool result, so attribution and content trust remain relevant.

### 28. Retention and Missing Lifecycle Operations

Scratchpad currently has no:

- TTL or expiry;
- cleanup worker;
- workspace deletion API;
- file or section deletion;
- public version-history operation;
- storage index outside directory traversal.

Replacement leaves earlier content-hash files on disk, but only the latest metadata pointer is discoverable through public tools. Old blobs are retained implementation artifacts, not a supported restore mechanism.

The workspace lifetime is therefore logical rather than physically enforced. Agents stop discovering the workspace when a different originator task begins, but the directory remains until an operator or external lifecycle mechanism removes it.

### 29. Filesystem Trust and Path Safety

Memory reconstructs each revision body path from validated database identity fields and requires the stored `body_path` to exactly match the reconstructed relative path. This prevents a tampered database path from redirecting a read to an arbitrary file.

Scratchpad validates workspace, file, and section identifiers before locating metadata. It then joins the `ContentFile` value read from section metadata beneath the section directory and verifies content hash. The code does not independently require `ContentFile` to equal `content/<recorded-hash>.md` during read.

Both systems use ordinary `os.Stat`, `os.ReadFile`, directory creation, and rename operations rather than an `os.Root`/no-follow boundary. They are designed around the application owning and trusting these storage roots. If another tenant or hostile local process can alter metadata or create symlinks inside the roots, the filesystem becomes a wider security boundary than the domain validation alone protects.

### 30. Studio and Standalone Composition

#### Studio/server mode

- MongoDB stores memory revision records and latest metadata projections.
- Memory bodies live under `MEMORY_ROOT`.
- Scratchpad workspaces live under `SCRATCHPAD_ROOT`.
- If unset, memory defaults to `/tmp/agentflow-memory` and scratchpad to `/tmp/agentflow-scratchpad` on a typical Linux host.

#### Standalone runtime

- SQLite stores memory revisions and projections.
- Memory bodies live under `<dataDir>/memory`.
- Scratchpads live under `<dataDir>/scratchpad`.

Standalone places database and filesystem state under one runtime-owned data directory. Studio persistence depends on its environment and volume configuration.

MongoDB durability alone is insufficient. A surviving revision record cannot reconstruct a lost Markdown body. A container replacement using default temporary storage can therefore leave durable metadata pointing to missing payloads.

Multiple Studio replicas also need body storage visible to the replica performing the read. Shared filesystem visibility would solve location, but not scratchpad's process-local write locking. A production multi-replica design would normally move bodies to a durable shared object/blob store and give scratchpad mutations a cross-process coordination mechanism.

The later publication/deployment chapter must verify actual mounts and environment overrides. This chapter can confirm the code defaults, not the deployed infrastructure.

### 31. Architectural Strengths

1. **Identity comes from trusted runtime context.** Models cannot choose arbitrary tenant identifiers.
2. **Memory scope is explicit.** Thread, agent, and user knowledge have different lineages.
3. **Memory history is append-only.** Update, retirement, and restoration preserve audit evidence.
4. **Database constraints enforce concurrent memory correctness.** Expected revisions are backed by unique keys.
5. **Mutations are replay-safe.** Stable run/tool-call identity handles ambiguous execution.
6. **Hybrid memory writes have a repair path.** A committed database revision can finalize its pending body.
7. **Latest metadata is treated as a projection.** Stale projection writes cannot replace newer state.
8. **Scratchpad sections preserve attribution.** Cross-agent correction is additive rather than destructive.
9. **Scratchpad commit pointers protect lock-free readers.** Orphan bodies remain invisible.
10. **Search avoids shell and regex interpretation.** Model patterns remain literal arguments.
11. **Automatic prompt growth is bounded.** User bodies, memory indexes, and scratchpad pointers have separate budgets.
12. **MongoDB and SQLite share memory ports and conformance expectations.** Core memory behavior is not coupled to one database.

### 32. Limitations and Risks

#### The body store is a deployment-critical dependency

Memory durability is the conjunction of revision storage and filesystem-body durability. Local temporary roots are unsuitable for replaceable production containers unless backed by persistent storage.

#### Projection consistency is eventual and opportunistic

A successful revision whose projection fails is temporarily invisible to search and prompt discovery until a direct lineage operation repairs it. No background reconciler scans revision heads against projections.

#### Cleanup does not reclaim immutable artifacts

Expired memory revisions, abandoned pending memory bodies, previous scratchpad blobs, incomplete scratchpad sections, and complete old workspaces can accumulate.

#### Scratchpad is single-process safe only

The per-workspace mutex cannot protect shared storage across replicas. The filesystem metadata has no distributed compare-and-swap.

#### Search quality and candidate selection are limited

Search is literal only, takes one hit per file, and searches at most 500 projected memories with no explicit pre-limit order.

#### User-memory prompt authority is broad

All user-scoped types are inserted as preferences in the system message. Escaping protects syntax, not semantic instruction trust or poisoned durable content.

#### TTL cannot evolve

The public mutation contract cannot extend, clear, or replace expiry. An expired source cannot be restored.

#### A configured read window is unused

`ReadWindowDuration` currently has no behavioral effect, creating a misleading configuration surface.

#### Physical durability is weaker than transactional durability

Atomic renames are used, but explicit file and directory `fsync` calls are absent. Database and filesystem state cannot commit atomically.

#### Filesystem tampering is outside the intended threat model

Path-segment validation protects normal application input, but the roots are not hardened against hostile local metadata or symlink manipulation.

### 33. Alternatives and Trade-Offs

#### Put memory bodies directly in MongoDB/SQLite

This would create a simpler atomic transaction for revision metadata and content and remove missing-volume failures. It would enlarge database rows, increase backup and replication load, and make filesystem/ripgrep search unavailable without a different search strategy. Given the current 8 KiB body cap, in-database bodies remain a realistic simplification worth comparing.

#### Use object/blob storage for bodies

Object storage gives shared, durable access across replicas and separates large payload retention from operational databases. It introduces network latency, credentials, consistency/error handling, lifecycle policies, and another service dependency. Revision commits would still need an ordered or reconciled cross-system protocol.

#### Use vector or full-text search

Semantic search would find conceptually related memories but adds embedding models, indexing, version synchronization, cost, and relevance evaluation. Database-native full-text search is simpler but differs between MongoDB and SQLite. Literal `rg` is transparent and cheap for the current scale.

#### Store scratchpads in the database

Database records with versions and compare-and-swap would support multiple processes, cleanup queries, and durable history. The trade-off is more repository/schema complexity for state intended to be temporary and bounded.

#### Inject no memory bodies automatically

An index-only model would sharply reduce prompt injection and token use but require an agent to consciously retrieve even basic user preferences. The current design chooses convenience for user-scoped bodies and on-demand retrieval for narrower scopes.

#### Automatically delete expired or completed state

Retention policies would control disk growth and privacy exposure. They must define audit requirements, recovery windows, legal deletion behavior, and coordination with database projections; blindly deleting files can create dangling revision records.

### 34. Test Evidence and Gaps

Inspected memory tests cover:

- scope-dependent body paths and path-traversal rejection;
- create/read/history and generated IDs;
- duplicate lineage rejection;
- idempotent replay and pending-file finalization;
- cross-thread slug isolation;
- historical reads;
- exact and all-or-nothing patches;
- update, retirement, restoration, and required expected revisions;
- retired search filtering and same-body independent memories;
- concurrent patch conflict with exactly one winner;
- the versioned cleanup worker remaining a no-op;
- MongoDB/SQLite projection monotonicity and revision-store conformance;
- prompt ordering, count/body/total budgets, user cross-agent visibility, and XML escaping.

Inspected scratchpad tests cover:

- deterministic IDs and mutation conflicts;
- create, append, replace replay;
- orphan content and incomplete section invisibility;
- repair of an interrupted create, including at the file cap;
- concurrent appends with unique ordinals;
- ownership and stale-hash enforcement;
- content-integrity failure;
- storage caps, previews, search limits, and ordering;
- task-tree continuity across root, async, and callback run IDs;
- runtime-context requirements and registry gating;
- prompt pointer and collaboration-block behavior.

Important remaining end-to-end gaps include:

- real process termination at every database/filesystem commit boundary;
- power-loss durability of atomic file helpers;
- multi-replica body access and scratchpad races;
- storage-root loss with surviving MongoDB revisions;
- long-term orphan/expired data growth;
- more than 500 visible memories;
- deliberate durable-memory prompt poisoning;
- projection reconciliation after sustained metadata-store failure;
- adversarial local symlink/metadata manipulation;
- restoration or migration from local disk to shared body storage.

These tests were inspected but not executed during this documentation pass.

### 35. Source Map

1. `backend/memory/types.go` — scopes, types, limits, arguments/results, metadata and revision ports.
2. `backend/memory/scope.go` and `backend/memory/lineage.go` — trusted identity validation, lineage encoding, mutation and generated IDs.
3. `backend/memory/service.go` — create/read/search, mutations, replay, commit ordering, projection, and restore behavior.
4. `backend/memory/store.go` — immutable revision paths, pending bodies, finalization, recovery reads, and path verification.
5. `backend/memory/searcher.go` — fixed-string ripgrep execution and snippet selection.
6. `backend/memory/revision_store.go` — in-memory revision adapter used by focused tests.
7. `backend/memory/cleaner.go` — compatibility cleanup worker and current no-op behavior.
8. `backend/scratchpad/types.go` — workspace/artifact metadata, limits, and tool contracts.
9. `backend/scratchpad/layout.go` — deterministic IDs and filesystem layout.
10. `backend/scratchpad/service.go` — mutation validation, idempotency, ownership, locks, caps, commit pointer, and reads.
11. `backend/scratchpad/store.go` — JSON/content persistence, integrity verification, listing, and logical-size calculation.
12. `backend/scratchpad/locks.go` — process-local workspace serialization and scaling assumption.
13. `backend/scratchpad/search.go` — attributed current-section search.
14. `backend/tools/memory_*_tool.go` and `backend/tools/scratchpad_tools.go` — model-visible schemas and trusted context adapters.
15. `backend/tools/tool_registry.go` and `backend/agent/toolset.go` — service registration and per-agent exposure.
16. `backend/runtimectx/context.go` and `backend/agent/tool_batch.go` — runtime-owned user/agent/thread/task identities.
17. `backend/agent/context_builder.go` — prompt-time user bodies, narrower-memory index, collaboration block, and scratchpad pointer.
18. `backend/repo/mongorepo/memory_meta_repo.go` and `memory_revision_repo.go` — MongoDB indexes, projection, visibility, revision constraints, and queries.
19. `backend/repo/sqliterepo/memory_meta_repo.go`, `memory_revision_repo.go`, and `db.go` — standalone equivalents and schema.
20. `backend/main.go` and `backend/runtime/app.go` — Studio and standalone storage roots and service composition.
21. Memory, scratchpad, context-builder, tool, MongoDB, SQLite, and conformance tests — intended behavior and coverage boundaries.

### 36. Chapter Summary

AgentFlow separates durable scoped knowledge from temporary task-tree collaboration. Memory uses an append-only MongoDB/SQLite revision log, immutable filesystem bodies, and a repairable latest-state projection. Scope-specific lineage controls visibility, mutation IDs make retries idempotent, and expected revisions plus database constraints make concurrent mutation safe. Scratchpads use one filesystem workspace per user and originator run, agent-owned sections, immutable content hashes, and atomically replaced metadata commit pointers. They are efficient for one-process collaboration but lack multi-process locks, retention, deletion, and supported history. Both systems depend on correctly persisted filesystem roots; memory records alone cannot reconstruct lost bodies. Prompt budgets constrain automatic context, but user-scoped bodies are injected into a system message without provenance-based trust, making durable prompt poisoning an important future concern.

## Chapter 8: Persistence

### 1. Why This Layer Exists

Persistence is the part of AgentFlow that makes important state survive beyond the current function call and process lifetime. Without it, a restart would erase threads, conversation history, resumable checkpoints, asynchronous jobs, task budgets, deployment revisions, and durable memory metadata.

Durability is only half of the responsibility. The persistence layer also provides the atomic operations that make application rules remain true when requests overlap.

For example, suppose only one additional delegated run is allowed. This sequence is unsafe:

```text
read runs_used
if runs_used < max_runs:
    increment runs_used
```

Two callers can read the same old value before either writes. Both may then believe they acquired the final slot. The database operation must combine the condition and the mutation so only one caller can succeed.

The central mental model is:

```text
Application code states the rule.
Persistence supplies the atomic primitive that makes the rule true under races and failures.
```

Indexes, transactions, compare-and-set updates, leases, fencing fields, idempotency keys, and append-only records are therefore part of the application architecture. They are not merely database tuning details.

### 2. Persistence Is a Family of Boundaries

AgentFlow does not define one universal repository interface. Persistence contracts live next to the components that consume them:

| Consumer | Persistence ports it owns or uses |
| --- | --- |
| Agent runtime | Checkpoints and asynchronous jobs |
| Dispatcher | Agents, threads, messages, runs, jobs, and durable cancellation |
| HTTP handlers | Users, agents, models, threads, messages, and runs |
| Memory service | Latest metadata projection and append-only revisions |
| Publisher | Agent graph reader and immutable deployment revisions |
| Deployment service | Selected deployment state and published revision reader |

The dependency direction is:

```text
domain/application component
        |
        | depends on a small capability interface
        v
consumer-owned persistence port
        ^
        | implemented implicitly by Go methods
        |
MongoDB or SQLite adapter
        |
        v
collection, table, or filesystem
```

The application asks for domain capabilities such as:

```text
TransitionStatus(run_id, expected_status, new_status)
TryConsumeRun(originator_run_id, budget_key)
FindOrCreateSubThread(user, originator_run, target_agent)
Append(memory_revision)
```

It does not ask for generic operations such as `Save(any)` or `Update(any)`. The domain-specific method name and parameters carry guarantees that generic CRUD would hide.

For example, `TransitionStatus` means compare-and-set, not an unconditional update. `FindOrCreateSubThread` promises convergence under concurrent callers, not merely “insert if convenient.”

### 3. Go Interface Mechanics

Go uses implicit interface implementation. A MongoDB repository and a SQLite repository satisfy the same port by exposing matching method sets. Neither adapter imports the consumer merely to declare an `implements` relationship.

Compile-time assertions in repository tests confirm important relationships. Shared conformance suites then test the runtime meaning of those methods.

These are separate forms of proof:

| Proof | What it establishes | What it does not establish |
| --- | --- | --- |
| Compile-time interface assertion | The adapter has the required methods and types | Correct behavior |
| Unit or adapter test | A concrete implementation handles selected cases | Cross-backend equivalence |
| Shared conformance suite | MongoDB and SQLite expose the same selected observable behavior | Identical internal transactions or failure modes |

This last limitation is important throughout this chapter. Two adapters can pass the same successful round-trip test while behaving differently if the process stops between two writes.

### 4. The Two Persistence Profiles

AgentFlow deliberately has two persistence compositions.

| Concern | Studio backend | Standalone runtime |
| --- | --- | --- |
| Primary database | MongoDB | SQLite |
| Users and login accounts | MongoDB | No user-account table; one synthetic deployment identity |
| Editable agent definitions | MongoDB | Immutable deployment bundle |
| LLM model catalog | MongoDB collection | Configured runtime providers and bundle references |
| Deployment publication and desired/observed control state | MongoDB | Bundle is already selected before runtime startup |
| Threads and messages | MongoDB | SQLite |
| Runs and checkpoints | MongoDB | SQLite |
| Jobs, locks, and task budgets | MongoDB | SQLite |
| Memory metadata and revisions | MongoDB | SQLite |
| Memory bodies | Filesystem | Filesystem |
| Scratchpads | Filesystem | Filesystem |
| Optional result cache | Redis | None |

SQLite is not intended to reproduce every Studio collection. It stores the mutable execution state required by one immutable deployed agent graph.

### 5. Studio Collections and Ownership

The Studio composition root creates adapters over these MongoDB collections:

| Collection | Responsibility |
| --- | --- |
| `users` | Login account, profile, and password hash |
| `llm_registry` | Model catalog records and context-window lookup |
| `agents` | Editable agent definitions |
| `deployment_revisions` | Immutable published bundles |
| `deployment_states` | Desired, observed, and reconciliation state per owner and deployment |
| `threads` | User conversations and internal delegation sub-threads |
| `messages` | Conversation and tool-call records |
| `runs` | Small current-state projection for an execution |
| `run_checkpoints` | Append-only resumable snapshots |
| `jobs` | Durable asynchronous delegation state machine |
| `job_locks` | Leased serialization and fencing records |
| `tasks` | Task-tree budget and cancellation ledger |
| `memory_meta` | Discoverable latest memory projection |
| `memory_revisions` | Append-only memory revision history |

Redis is optional and is used for tool-result deduplication. It is not the source of truth for any domain entity.

Memory and scratchpad Markdown bodies live outside MongoDB on the filesystem. Chapter 7 explains the resulting hybrid commit protocols and recovery limits.

### 6. MongoDB Connection Lifecycle

`db.ConnectMongoDB` uses a package-global client initialized through `sync.Once`.

Startup behavior is:

1. Read `MONGO_URL`.
2. Fall back to `mongodb://localhost:27017` when absent.
3. Construct the driver client.
4. Ping MongoDB with a 15-second context.
5. Terminate the process if connection or ping fails.

The code does not explicitly configure pool size, read concern, write concern, or transaction sessions. Effective values therefore come from MongoDB driver defaults, server topology, and URI options.

The Studio health endpoint reports process health but does not ping MongoDB for every request. This avoids making the health path itself expensive, but it also means a running process can report healthy after losing database connectivity.

No production shutdown path explicitly disconnects the MongoDB client. Process termination will release operating-system resources, but an explicit disconnect would make lifecycle ownership clearer and allow connection-shutdown errors to be observed.

### 7. MongoDB Index Ownership

The application explicitly creates indexes for:

- runs and checkpoints;
- jobs and job locks;
- task ledgers;
- delegation sub-threads;
- memory metadata and revisions;
- deployment revisions and generation-fenced deployment state.

Startup exits when these required indexes cannot be created. That is fail-fast behavior: the service refuses to run when the database cannot enforce an invariant on which the runtime depends.

The application does not create indexes for users, agents, messages, or LLM model catalog records.

This creates two distinct concerns:

1. Missing query indexes can cause collection scans and database-side sorting as data grows.
2. Missing unique indexes can leave correctness dependent on a race-prone application check.

The second concern is visible in signup and is discussed later in this chapter.

### 8. Standalone SQLite Lifecycle

The standalone runtime creates `<data-dir>/state.db` after validating the deployment bundle, configured providers, tools, and environment.

The ordering is deliberate:

```text
validate immutable inputs
        |
        v
create data directory
        |
        v
open and migrate SQLite
        |
        v
bind database to deployment identity
        |
        v
recover orphaned runs
        |
        v
start runtime workers and HTTP server
```

Invalid immutable configuration therefore fails before the first filesystem mutation.

On shutdown, the standalone runtime:

1. Marks readiness false.
2. Drains or closes the HTTP server.
3. Cancels the runtime context.
4. Waits for the coordinator within a bounded window.
5. Stops worker pools.
6. Closes the in-process bus.
7. Closes SQLite.

This composition has clearer resource ownership than the Studio MongoDB lifecycle.

### 9. SQLite Connection Settings

SQLite is opened with four important policies:

| Setting | Current value | Reason |
| --- | --- | --- |
| Journal mode | WAL | Crash recovery and improved reader/writer behavior |
| Busy timeout | Five seconds | Wait briefly for an external lock instead of failing immediately |
| Foreign keys | Enabled | Enforce declared relationships |
| Transaction lock | Immediate | Reserve write access when a transaction starts |

The connection pool is restricted to one open and one idle connection.

`database/sql` calls it a pool, but with `MaxOpenConns(1)` all in-process database work shares a single underlying SQLite connection. This reduces lock complexity and makes transaction behavior predictable. It also means one slow query or transaction delays unrelated database work.

WAL can allow database-level readers and a writer to coexist, but the one-connection process does not exploit much of that concurrency internally. WAL still helps crash behavior and external inspection or maintenance connections.

This design is suitable for one standalone deployment process. It is not a shared-database horizontal-scaling strategy.

### 10. SQLite Migrations

SQLite currently has three embedded schema migrations:

| Version | Adds |
| --- | --- |
| 1 | Runs, checkpoints, tasks, budget keys, memory, threads, and messages |
| 2 | Asynchronous jobs and job locks |
| 3 | Immutable deployment identity |

Migration control uses `PRAGMA user_version`.

For each missing version, the repository:

1. Begins a transaction.
2. Executes that version's schema statements.
3. Updates `user_version` inside the same transaction.
4. Commits only when both succeed.
5. Rolls back on failure.

If the database schema is newer than the binary supports, startup fails rather than attempting a potentially destructive downgrade.

There is no down-migration framework. Rollback therefore means restoring a compatible binary and database backup or using a deliberate forward repair migration.

The SQL is embedded in Go source. This keeps the standalone artifact self-contained, but it also means schema history, application release, and migration execution are tightly coupled.

### 11. Deployment Identity Binding

Migration 3 adds a singleton `deployment_identity` table. On first boot the runtime inserts:

- deployment ID;
- canonical configuration hash;
- synthetic user ID;
- binding timestamp.

Later boots read the existing row in the same immediate transaction and require an exact match. A mismatch returns an error without mutating the stored identity.

The invariant is:

```text
one state.db belongs to exactly one immutable deployment identity
```

This prevents a new bundle from silently inheriting another deployment's threads, jobs, runs, memory metadata, and scratchpads merely because it points at the same data directory.

### 12. Storage-Neutral Identifiers

MongoDB uses ObjectIDs for users, agents, threads, messages, and several stored documents. SQLite generates UUID strings for entities such as threads and messages.

Application ports expose both as strings. The representation is opaque outside the adapter.

The MongoDB adapter validates a hex ObjectID and converts it at the storage boundary. SQLite stores text directly.

This separation matters because the domain meaning is:

```text
the stable identity of a thread
```

not:

```text
a MongoDB ObjectID that every package may parse
```

Some Studio-facing handler and model types still import MongoDB ObjectID directly, most notably user authentication. The execution-facing ports are more storage-neutral than the complete Studio domain model.

### 13. Serialization Boundaries

Not all persisted state is stored as individually queryable fields.

| Value | Encoding |
| --- | --- |
| MongoDB domain records | BSON documents |
| SQLite timestamps | UTC Unix nanoseconds in integers |
| SQLite tool calls, metadata, and delegation chains | JSON text |
| Run checkpoint | Versioned JSON compressed with gzip |
| Deployment bundle | Canonical JSON with a SHA-256 configuration hash |
| Memory and scratchpad bodies | Markdown files |

Serialization creates a compatibility boundary. A process may be able to find a row but still fail to decode its payload.

Run snapshots explicitly contain a version and reject unsupported versions during resume validation. Deployment bundles similarly contain a schema version and verify their canonical hash. Message metadata and tool calls do not have a separate schema version; compatibility depends on their Go JSON shapes remaining decodable.

SQLite helper functions wrap JSON encode/decode failures with context. Null and literal JSON `null` values decode as absent optional data.

### 14. Run Record Versus Checkpoint

A durable run has two complementary representations.

The run record is a small current-state projection containing:

- identity and ownership;
- current status;
- attempt number;
- projected steps completed;
- last error;
- originator and parent lineage;
- invocation kind and optional job identity.

Checkpoints are append-only, compressed snapshots containing the information necessary to resume the agent loop:

- canonical message history;
- raw summary;
- step counters and usage;
- tool failures;
- pending awaits;
- provider and model information;
- effective tool identity;
- execution phase;
- delegation lineage and system context.

`LoadLatest` chooses the highest recorded step, not merely the last inserted row. A delayed save of step 3 therefore does not hide an already stored step 5.

### 15. Checkpoint Commit Atomicity

SQLite inserts a checkpoint and updates the run's `steps_completed` projection in one transaction:

```text
BEGIN IMMEDIATE
    INSERT checkpoint
    UPDATE run projection
COMMIT
```

Either both changes commit or neither becomes visible.

MongoDB performs two writes without a transaction:

```text
INSERT checkpoint
UPDATE run projection   // error discarded
```

The checkpoint insert is authoritative for resume. If the second write fails, `LoadLatest` can still recover the highest checkpoint, but the run's small projection may report an older `steps_completed` value.

This is a confirmed example of shared interface behavior with different failure atomicity.

### 16. Run Status Compare-and-Set

Resuming a run must have exactly one winner. The unsafe design would read the status and then update it in a second operation.

Both adapters instead perform one conditional mutation:

```text
UPDATE run
SET status = running
WHERE run_id = ? AND status = resumable
```

MongoDB places the expected status in the update filter. SQLite places it in the SQL `WHERE` clause. The affected-row count tells the caller whether it won.

The owner-scoped variant adds `user_id` to the same atomic predicate. It combines authorization state and concurrency state in one storage operation.

The conformance suite releases 50 goroutines against the same old status and requires exactly one successful transition.

### 17. Run Retention

Terminal run status controls checkpoint retention:

| Terminal status | Retention timestamp |
| --- | --- |
| Completed | Seven days |
| Failed | Thirty days |
| Cancelled | Thirty days |
| Interrupted | Thirty days |

MongoDB has a TTL index on `expires_at`. MongoDB eventually deletes eligible checkpoint documents after the timestamp.

SQLite records the same expiry timestamp and indexes it, but the current runtime contains no job that deletes expired rows. The timestamp is metadata only in SQLite, so standalone checkpoint storage grows indefinitely.

Status and retention changes are one SQLite transaction. MongoDB updates the run first and then performs a best-effort checkpoint update whose error is discarded. A terminal run can therefore keep checkpoints without expiry if the second MongoDB write fails.

### 18. Cold-Start Recovery

Before standalone workers start, SQLite recovers runs owned by the deployment's synthetic user that were left in `running` state:

```text
running + at least one checkpoint -> interrupted
running + no checkpoint           -> failed
```

The first state remains resumable. The second cannot safely resume because no durable execution state exists.

Both updates occur in one transaction.

Studio has no equivalent general cold-start pass for MongoDB run documents. Async jobs can recover through expired leases, but a top-level or synchronous run left `running` after a process crash can remain stale.

### 19. Message Batch Semantics

Both message adapters assign deterministic within-batch ordering by giving successive records timestamps one microsecond apart.

For a limited history window they:

1. Select the newest `N` messages by descending time and stable ID.
2. Return those messages in ascending chronological order.

This provides the model with the most recent window without reversing the conversation.

SQLite inserts the complete batch in one transaction. Any encoding or insert failure rolls back all messages in the batch.

MongoDB uses ordered `InsertMany`, but no multi-document transaction. Ordered means MongoDB stops at the first failed document; it does not mean earlier successful inserts roll back. A repository error may therefore accompany a partially stored batch.

The conformance suite proves successful ordering, thread scoping, newest-window behavior, and metadata round trips. It does not inject a middle-of-batch failure and therefore does not prove equal batch atomicity.

### 20. Caller-Level Message Durability Policy

The repository reports whether persistence succeeded, but its caller decides what that failure means.

For a connected top-level request:

- message persistence failure is logged;
- the SSE stream emits an `internal.persistence_error` event;
- the terminal execution event is still handled separately.

After a client disconnect, completed messages are persisted with a detached, ten-second context on a best-effort basis. The error is ignored because no client remains to receive it.

Delegated and background-run transcripts are also best-effort. A successful delegated result is not invalidated after the caller already received it merely because its internal conversation history could not be stored.

The important distinction is:

```text
execution result durability != conversation transcript durability
```

That policy is above the repository and must be included when describing the system's actual guarantee.

### 21. Threads and Delegation Sub-Threads

Normal threads are user-facing conversations. Delegation sub-threads are internal conversations connecting one originator task to one target agent.

The uniqueness key for a sub-thread is:

```text
user_id + originator_run_id + target_agent_id
```

MongoDB uses a partial unique index limited to documents whose `kind` is `sub`. Concurrent upserts can both initially miss; the unique index admits one and the loser reads the winner.

SQLite uses `INSERT ... ON CONFLICT DO NOTHING` followed by a select in one immediate transaction.

Repeated calls return the same thread without changing its original timestamps. User-facing thread listing explicitly excludes `kind = sub`.

### 22. Task Budgets

Each originator run owns a task ledger containing:

- configured maximum runs;
- number of runs consumed;
- idempotency keys already decided;
- optional cancellation time and reason.

The first creation owns `max_runs`. Later `EnsureTask` calls do not silently change an already established task-tree budget.

`TryConsumeRun` provides three important guarantees:

1. The cap check and increment are atomic.
2. Replaying an accepted key does not charge again.
3. Replaying a rejected key remains rejected.

MongoDB stores accepted keys in the task document and uses a conditional update expression. SQLite stores keys in `task_run_keys` and uses an immediate transaction across the key and counter changes.

The shared conformance suite races 50 distinct keys against a budget of one and requires exactly one grant.

### 23. Job Dispatch Idempotency

Async job identity is derived from the pair:

```text
parent_run_id + tool_call_id
```

The database also enforces that pair as unique.

When the same key is replayed, both adapters return the existing job. If the replay contains different task text, target configuration, or mode, the first payload remains authoritative. The later payload is ignored rather than treated as a conflict.

The rule is therefore:

```text
same dispatch key = same logical operation, not a new request
```

Callers must generate a new tool-call identity when they intend a genuinely different operation.

### 24. Budget and Job Creation Are Not One Transaction

Dispatch currently performs:

1. Lookup for an existing dispatch key.
2. Task-budget consumption.
3. Job upsert.

Budget consumption and job creation are separate persistence operations.

If step 2 commits and step 3 fails, the budget remains consumed without a corresponding job. This is true in MongoDB because it crosses documents and repositories without a session transaction. It is also true in SQLite even though both tables share one database, because the repository interface does not let `JobRepo` include the task mutation in the same SQL transaction.

This illustrates an architectural principle:

```text
Having transaction support is not enough.
The application transaction boundary must include every state change that must succeed together.
```

The idempotent budget key prevents double charging on a retry, but it cannot create the missing job. A complete solution would need one transaction, a compensating refund, or a recoverable outbox-style protocol.

### 25. Job Claims, Leases, and Fencing

Jobs move through queued, starting, running, and terminal states. Background callbacks have an additional callback lifecycle.

The repositories provide:

- deterministic job identity;
- atomic claim transitions;
- claim owner values;
- lease expiry times;
- child-run identity checks;
- callback-run identity checks;
- durable target-agent and callback-thread locks;
- delivery markers for awaited results.

A lease says an owner may perform the work until a timestamp. Fencing says a stale owner must also present the identity associated with the current claim before it can mutate terminal state.

This matters because time alone cannot revoke a process. An old worker can wake after its lease expires. The conditional update must reject it if a newer owner or child run has taken over.

The job conformance suites test stale owners, wrong child-run IDs, expired claims, callback leases, terminal transitions, cancellation, and lock ownership.

### 26. Multi-Job Operations

Methods such as `MarkAwaiting` and `MarkDelivered` loop over several jobs. Neither adapter wraps the complete batch in one transaction.

If an error occurs halfway through:

- earlier jobs may already be updated;
- later jobs remain unchanged;
- retry behavior depends on each individual update being safe to repeat.

The individual mutations are designed to be narrow and generally replayable, but the batch is not all-or-nothing.

This is acceptable only when the coordinator treats partial progress as recoverable. It would be incorrect to describe these methods as atomic batch transitions.

### 27. Memory Persistence

Memory uses two database stores plus the filesystem:

1. An append-only revision store is the durable history authority.
2. A metadata store projects the latest revision for discovery.
3. Immutable Markdown files contain revision bodies.

MongoDB and SQLite enforce unique lineage/revision pairs and mutation IDs. Metadata projections advance monotonically. The filesystem and database cannot participate in one native transaction, so the memory service uses pending files, final immutable paths, revision commits, and projection repair.

Chapter 7 explains the complete protocol. From the persistence layer's perspective, the important lesson is that database correctness cannot reconstruct a body file lost from the persistent volume.

### 28. Published Revisions and Deployment State

Publishing walks the reachable agent graph, builds an immutable bundle, computes its canonical hash, and appends a revision.

Deployment revisions use owner-qualified identity and replay constraints:

```text
unique:     user + deployment + revision
unique:     user + deployment + idempotency_key
non-unique: user + deployment + config_hash
```

Replaying the same idempotency key with the same content returns the original revision. Reusing that key for different content is a conflict. A new idempotency key represents a new publication intention and therefore creates a new revision even when its configuration hash matches an older revision. Concurrent publications may choose the same next number, but the revision index permits only one; losers reload and retry up to a bounded number of attempts.

Deployment state is a separate, mutable version-2 document keyed by owner and deployment. It records desired action, target, and generation separately from controller-observed infrastructure and reconciliation ownership. Application mutations use expected-generation compare-and-set. Controller writes require the current generation, claim token, lease owner, and an unexpired lease.

The deployment service reads and owner-validates the requested revision, rejects intentional selection of a historical revision, copies immutable revision identity into a validated desired target, and asks the repository to advance desired generation atomically.

Publication and deployment intention remain separate business actions, so a published revision that has not been requested for deployment is valid rather than an incomplete transaction.

### 29. Database-Enforced Invariants

The databases strongly enforce several important rules:

- unique run IDs;
- unique job IDs and dispatch keys;
- one task ledger per originator run;
- unique accepted budget keys in SQLite;
- unique memory mutations and lineage revisions;
- one delegation sub-thread per logical key;
- unique published revision numbers and publication idempotency keys;
- one generation-fenced deployment state per owner and deployment;
- one standalone deployment identity.

These constraints are stronger than handler-side checks because every process and concurrent request shares the same enforcement point.

### 30. Application-Enforced Relationships

Many other relationships are conventions rather than database foreign keys:

- a run's thread and agent must exist;
- a message's thread, agent, and user must agree;
- a job's parent and child runs must be meaningful;
- a memory's scope identifiers must correspond to the active execution;
- an agent's delegates must be valid and owned appropriately;
- status and mode strings must be members of known state machines.

SQLite enables foreign keys, but only a small number are declared. For example, task budget keys reference their task ledger. Jobs deliberately use opaque cross-repository IDs and have no foreign keys to agent, thread, or run tables.

MongoDB similarly has no database-level cross-collection references.

The benefit is looser storage coupling and the ability to preserve historical execution records after configuration changes. The cost is that application bugs and deletions can create orphaned or inconsistent references.

Deleting an editable Studio agent does not cascade to its threads, messages, runs, memory, or published revisions. Published bundles are intentionally immutable historical artifacts, but the lifecycle policy for other related data is not explicitly centralized.

### 31. Ownership Enforcement

Many user-facing repository operations include `user_id` in the database predicate:

- agent lookup and mutation;
- thread lookup and summary update;
- owner-scoped run access and resume claim;
- deployment revision and generation-controlled state access;
- job reads and transitions where user identity is part of the contract.

This is defense in depth: authentication produces the identity, the handler passes it, and persistence includes it in the lookup or mutation.

Not every internal repository method is owner-scoped. Message listing accepts only a thread ID. HTTP handlers first perform an owner-scoped thread lookup and then call the message repository. Trusted internal execution paths also read messages after the run and thread have already been constructed from trusted state.

That makes the complete security property dependent on call order:

```text
authenticate user
        |
        v
prove ownership of thread
        |
        v
read messages by thread id
```

The message repository must not be exposed directly to an untrusted transport without adding an owner predicate.

`AgentRepo.GetByIDSystem` deliberately bypasses user scope for trusted internal orchestration. Its safety depends on keeping it behind that internal boundary.

### 32. SQL Injection and Query Construction

Production SQLite operations use parameter placeholders for runtime values. User-controlled identifiers, content, status values, and metadata are passed separately from SQL text.

The few dynamically assembled query fragments are internal constant column lists or clauses selected by code, not arbitrary client strings.

This preserves the essential boundary:

```text
SQL syntax is code.
Request and domain values are data.
```

MongoDB queries use structured BSON values rather than decoding arbitrary client-provided query operators into filters.

No obvious SQL or Mongo query injection path was found in the inspected repository code.

### 33. Signup Uniqueness Gap

Studio signup performs:

1. `FindByEmail`.
2. Return conflict if a user exists.
3. Hash the password.
4. Insert the new user.

The users collection has no application-managed unique email index.

Two concurrent requests can both observe “not found” before either inserts, and both inserts can succeed. The pre-check improves the sequential user experience but does not enforce the invariant.

The responsible enforcement boundary is a unique database index. The handler should then translate a duplicate-key insert result into HTTP 409.

Email lookup is also exact-string based. There is no normalization or case-insensitive uniqueness policy. Whether `Divi@example.com` and `divi@example.com` should be the same account is a product decision, but it must be decided before choosing the index collation or canonicalization rule.

### 34. Query-Index Gaps

The MongoDB message path filters by `thread_id` and sorts by `created_at` plus `_id`, but no corresponding application-managed index is created.

Agent listing filters by `user_id`. Context-window resolution filters the model catalog by provider and API model ID. User login filters by email. These also have no code-managed query indexes.

The queries remain functionally correct. At larger cardinalities they can require collection scans or blocking sorts.

Index design should follow observed access patterns and expected scale. The email unique index is already justified by correctness. Performance indexes should be confirmed through query plans and production-like cardinality rather than added blindly.

### 35. Error Contracts

Repository errors are not fully standardized.

Some packages expose sentinel errors such as deployment revision not found or deploy-state conflict. Callers inspect these with `errors.Is`, which remains stable when errors are wrapped.

Other repositories return ad hoc text such as `"thread not found"`, and some handlers compare `err.Error()` with that exact string. Adding useful context to such an error can accidentally change an HTTP 404 into a 500.

Some older repositories also return raw driver errors without repository context, while newer ones consistently wrap the operation name.

A robust contract separates:

- stable expected conditions for programmatic inspection;
- wrapped internal causes for logging and diagnosis;
- generic client-facing messages that do not expose storage details.

### 36. Redis Is an Optional Cache

Redis supports deduplication for selected external tools. It does not own users, runs, jobs, messages, memory, or deployment state.

When Redis configuration is invalid or the initial ping fails:

- a warning is logged;
- the cache remains nil;
- tool execution continues without cached deduplication.

Because initialization uses `sync.Once`, that process does not retry Redis discovery later.

Correctness must therefore tolerate Redis absence. Availability loss can increase repeated external calls, latency, and provider cost, but it must not erase authoritative state.

### 37. Shared Conformance Suites

MongoDB and SQLite run the same behavioral suites for:

- runs and checkpoints;
- task budgets;
- memory metadata;
- memory revisions;
- threads;
- messages;
- async job dispatch and await behavior;
- coordinator job claims and locks;
- worker and callback transitions.

The suites test properties that method signatures cannot express, including:

- one winner in a concurrent compare-and-set race;
- one budget grant under concurrent contention;
- idempotent mutation and budget keys;
- highest-step checkpoint selection;
- monotonic memory projections;
- concurrent delegation sub-thread convergence;
- newest-window message ordering;
- stale owner and stale child-run rejection;
- lease and callback fencing.

The test file describes current MongoDB behavior as the initial operational contract. SQLite is expected either to reproduce it or to make a deliberate, documented divergence.

### 38. What Conformance Does Not Prove

The shared suites do not establish:

- identical internal transaction boundaries;
- all-or-nothing MongoDB message batches;
- checkpoint projection atomicity;
- physical retention cleanup;
- startup recovery equivalence;
- user-email uniqueness;
- agent deletion lifecycle;
- deployment identity equivalence;
- query performance or index coverage;
- MongoDB write-concern behavior;
- filesystem durability for memory and scratchpads.

Conformance is strongest when it targets an observable invariant, especially under concurrency. It should not be mistaken for proof that two storage engines fail in the same way.

### 39. Studio and Standalone Failure Comparison

| Failure | Studio MongoDB result | Standalone SQLite result |
| --- | --- | --- |
| Process stops after checkpoint insert but before run projection update | Checkpoint may exist with stale projection | One transaction prevents the split |
| Process restarts with a run still marked running | No general top-level recovery pass | Cold-start recovery marks interrupted or failed |
| Terminal retention timestamp expires | MongoDB TTL eventually deletes checkpoint | Row remains because no cleanup worker deletes it |
| Message batch fails midway | Earlier ordered inserts may remain | Transaction rolls back entire batch |
| Many in-process DB operations overlap | Mongo driver pool permits concurrency | One SQLite connection serializes operations |
| Database reused for another deployment | Studio is intentionally multi-tenant | Identity binding rejects mismatched bundle |
| Redis unavailable | Tool cache disabled; database remains authoritative | Redis not part of runtime composition |

This table is why “SQLite adapter behaves like MongoDB” must be read as a selected domain-contract statement, not a physical equivalence claim.

### 40. Architectural Strengths

The persistence design has several strong qualities:

1. Consumer-owned ports express domain operations rather than generic CRUD.
2. MongoDB and SQLite adapters are interchangeable at execution boundaries.
3. Shared conformance tests encode concurrency and idempotency semantics.
4. Critical claims use atomic conditional updates rather than read-then-write logic.
5. Unique indexes enforce job, revision, mutation, task, and sub-thread identity.
6. Checkpoints and memory revisions are append-oriented, preserving recoverable history.
7. Leases are combined with owner and run fencing rather than trusted by time alone.
8. SQLite migrations are transactional and reject unsupported future schemas.
9. Standalone state is cryptographically bound to one deployment configuration.
10. SQL values are parameterized.
11. Redis is correctly treated as optional rather than authoritative.

### 41. Limitations and Risks

The most important confirmed limitations are:

1. User email uniqueness is not database-enforced.
2. MongoDB checkpoint and run-projection writes are not atomic.
3. MongoDB terminal status and checkpoint-expiry writes are not atomic.
4. SQLite checkpoint expiry is recorded but never cleaned physically.
5. Studio has no general recovery for ordinary runs left `running` after a crash.
6. Budget consumption and job creation are separate commits.
7. MongoDB message batches can partially persist.
8. Multi-job awaiting and delivery operations can partially update a batch.
9. Several high-traffic MongoDB query shapes lack code-managed indexes.
10. Most cross-entity relationships and state-machine values are not database-constrained.
11. Some not-found behavior is coupled to exact error text.
12. The Studio MongoDB client has no explicit disconnect lifecycle.
13. Effective MongoDB durability depends on driver/server/URI defaults because write concern is not specified in code.
14. The one-connection SQLite design limits throughput and prevents horizontal sharing.

These risks are not all equally urgent. Correctness invariants such as unique login identity and lost budget require higher priority than performance indexes whose need depends on measured cardinality.

### 42. Alternatives and Trade-Offs

#### One central repository package

This could make discovery easier, but it would couple unrelated domains and encourage generic CRUD that hides concurrency semantics. The current consumer-owned ports are the better fit.

#### MongoDB transactions everywhere

Transactions could make checkpoint-plus-projection or budget-plus-job atomic. They add topology requirements, session plumbing, retry rules, and operational cost. They should be used only where partial state is unacceptable and cannot be repaired safely.

#### Store every execution field relationally

This would allow more querying and constraints, but snapshot evolution would require many migrations and joins. Versioned compressed checkpoint blobs are appropriate when the primary operation is “resume this exact execution state.”

#### Store all state as opaque blobs

This simplifies serialization but makes ownership filters, queue queries, status claims, indexes, and operational diagnosis difficult. AgentFlow correctly keeps coordination fields queryable and uses blobs only for cohesive snapshots.

#### Add foreign keys for every relationship

This would catch more orphan references but tightly couple lifecycle and deletion across runs, jobs, threads, agents, and immutable historical records. Selective foreign keys plus explicit lifecycle policy are more appropriate than automatic cascading everywhere.

#### Increase SQLite connection count

This could improve read concurrency, but it would expose more lock contention and require every transaction path to be reviewed under true connection concurrency. The current single connection is a reasonable safety-first standalone default until measurements justify complexity.

#### Make Redis mandatory

This would improve deduplication availability but introduce another correctness dependency and failure mode. It should remain optional unless a tool side effect requires a durable exactly-once protocol, in which case a cache alone would still be insufficient.

### 43. How to Review a Persistence Operation

For every operation, answer four questions:

1. What invariant is being protected?
2. Which storage primitive enforces it?
3. Which writes must change together?
4. What remains after a crash between those writes?

Then add four operational questions:

5. Is a retry safe and how is it identified?
6. Can a stale worker still mutate state?
7. How is expired or orphaned state recovered or deleted?
8. Which query and index make the read path bounded?

This framework distinguishes a durable design from code that merely happens to write records.

### 44. Test Evidence and Gaps

Persistence behavior is covered by:

- MongoDB repository unit and integration tests;
- SQLite migration and repository tests;
- shared conformance suites;
- concurrent CAS, budget, sub-thread, revision, lease, and lock tests;
- standalone reopen, recovery, and shutdown tests;
- deployment revision plus desired/observed state, CAS, claim, lease, fencing, and migration tests;
- end-to-end thread, message, run, and resume tests.

Important missing or incomplete scenarios include:

- concurrent exact-email signup;
- MongoDB message failure after a successful prefix of a batch;
- MongoDB checkpoint projection failure injection;
- MongoDB retention-update failure injection;
- SQLite expired-checkpoint cleanup, because no cleanup implementation exists;
- Studio restart recovery for top-level runs;
- budget success followed by job-insert failure and repair;
- multi-job batch failure halfway through;
- deletion and orphan lifecycle across agents, threads, runs, and messages;
- production-scale query-plan and index tests;
- explicit MongoDB write-concern and failover behavior.

### 45. Source Map

The primary implementation areas for this chapter are:

| Area | Source |
| --- | --- |
| Studio composition and collection wiring | `backend/main.go` |
| MongoDB connection | `backend/db/mongo.go` |
| Redis connection | `backend/db/redis.go` |
| SQLite connection policy | `backend/db/sqlite.go` |
| SQLite migrations | `backend/repo/sqliterepo/db.go` |
| MongoDB adapters | `backend/repo/mongorepo/` |
| SQLite adapters | `backend/repo/sqliterepo/` |
| Shared behavioral suites | `backend/repo/conformancetest/conformancetest.go` |
| Run snapshot encoding and port | `backend/agent/checkpoint.go` |
| Async job port | `backend/agent/async_jobs.go` |
| Dispatcher-owned ports | `backend/dispatcher/dispatcher.go` |
| Memory ports | `backend/memory/types.go` |
| Publisher revision port | `backend/publisher/service.go` |
| Deployment state ports | `backend/deployment/service.go` |
| Standalone composition and recovery | `backend/runtime/app.go` |
| Authentication persistence consumer | `backend/handlers/auth.go` |
| Message persistence policy | `backend/handlers/message.go`, `backend/handlers/run.go`, and `backend/dispatcher/` |

### 46. Chapter Summary

AgentFlow's persistence architecture is a collection of domain-specific ports backed by MongoDB in Studio and SQLite in the standalone runtime. The adapters share important observable contracts through conformance tests, while retaining different physical models and failure behavior. Atomic conditional mutations protect run claims, task budgets, job ownership, leases, and idempotent identities. Append-only checkpoints, memory revisions, and deployment revisions preserve recoverable history. SQLite adds transactional migrations, deployment binding, and cold-start run recovery; MongoDB provides multi-user shared storage, document-level atomic operations, and TTL cleanup. The principal weaknesses are uneven compound-write atomicity, missing user-email enforcement and query indexes, incomplete lifecycle cleanup and crash recovery, narrowly scoped transaction boundaries, and inconsistent error contracts. The right review question is never merely “was data written?” It is “which invariant remains true under concurrency, retry, partial failure, and restart?”

## Chapter 9: HTTP Application and Security Boundary

### 1. Why This Layer Exists

The HTTP layer is the boundary between code AgentFlow controls and callers it cannot automatically trust. It turns network input into application operations and turns application outcomes into network responses.

That sounds mechanical, but this boundary owns several security-sensitive decisions:

- which operations are externally reachable;
- which requests require an identity;
- how an identity is established;
- whether that identity owns the requested resource;
- how much input and work a caller may cause;
- which internal failures are safe to expose;
- how long a request may keep process resources occupied;
- and how cancellation propagates after a caller disconnects.

The basic request model is:

```text
untrusted HTTP request
        |
        v
transport and size checks
        |
        v
authentication: who is the caller?
        |
        v
authorization: may this caller access this resource?
        |
        v
syntax and semantic validation
        |
        v
application execution
        |
        v
JSON response or SSE event stream
```

These gates are independent. A correctly signed token does not make every resource accessible. Owning a resource does not make every proposed update valid. A syntactically valid request does not make unlimited LLM work safe or affordable.

The central security principle is:

```text
Treat every external identifier, header, JSON field, URL, and connection lifetime
as caller-controlled until a specific boundary has validated it.
```

### 2. Two HTTP Applications, Two Trust Models

AgentFlow has two separately composed HTTP servers.

| Concern | Studio backend | Standalone runtime |
| --- | --- | --- |
| Purpose | Multi-user authoring, execution, and publication | Execute one immutable published deployment |
| Identity | Individual Studio user | One synthetic deployment user |
| Authentication | Password login followed by signed JWT | Static bearer token, or explicitly disabled |
| Authorization | User ownership of agents, threads, runs, and revisions | All accepted callers share the deployment identity |
| Persistence | MongoDB plus configured filesystem state | SQLite plus local filesystem state |
| Route prefix | `/api/` | `/v1/` |
| Health surface | `/health` | `/healthz` and `/readyz` |
| CORS middleware | Fixed development origin | None in the Go application |

This is not merely one server with different storage. The Studio boundary protects tenant separation. The standalone boundary assumes that deployment-level network access and one bearer credential are sufficient.

### 3. Studio Route Surface

Studio registers routes explicitly in `backend/main.go` using Go's method-aware `http.ServeMux` patterns.

Public routes are:

- `GET /`;
- `GET /health`;
- `POST /api/auth/signup`;
- `POST /api/auth/login`.

JWT-protected routes are:

- `GET /api/auth/me`;
- `GET /api/llms`;
- `POST /api/llm/chat`;
- agent create, list, get, update, and delete;
- publication, revision listing, and bundle download;
- thread creation and listing;
- message sending and listing;
- run inspection and resumption.

The HTTP method is part of the route. `GET /api/agents` and `POST /api/agents` are separate contracts even though they share a path.

**Confirmed:** protected routes are visibly wrapped with `middleware.RequireAuth` one at a time. There is no global rule that automatically protects every `/api/` route.

This explicitness makes a route easy to audit, but it also creates a maintenance risk: a future sensitive route can accidentally be registered without the wrapper. A protected sub-router or route-registration test would make the default harder to misuse.

### 4. Studio Middleware Order

Studio composes middleware in this order:

```text
RequestID
  -> request logging
    -> CORS
      -> 1 MiB body reader limit
        -> ServeMux route selection
          -> route-specific JWT middleware
            -> handler
```

The outer wrapper executes first on the way into the application and last on the way out. For a protected request, the sequence is:

1. Obtain or create a request ID.
2. Write the request-start log.
3. Add CORS response headers.
4. Replace the request body with a size-limited reader.
5. Select the method-and-path handler.
6. Validate the bearer JWT and inject the user ID.
7. Parse input and enforce ownership in the handler/repository flow.
8. Execute the operation.
9. Return through the middleware and write a completion log.

Preflight `OPTIONS` requests stop in the CORS middleware. They do not reach routing, body decoding, or authentication.

### 5. Request Identity Is Not User Identity

The request-ID middleware reads `X-Request-ID`. If the caller did not send it, the middleware generates a UUID. It then:

- adds the value to the response header;
- stores it in the request context;
- and attaches it to request-aware structured logs.

This supports correlation across one request's handler, dispatcher, run, and persistence logs.

The request ID does not authenticate the caller. A caller may choose it, and two callers can reuse the same value.

**Confirmed gap:** a supplied request ID has no length or format limit. Structured logging reduces traditional line-oriented log injection, but an attacker can still create large or high-cardinality log attributes. A safer boundary would accept only a short, well-defined format or replace invalid values with a generated ID.

### 6. Current Request Logging

Studio request logging records:

- HTTP method;
- URL path, without the query string;
- elapsed duration;
- request ID.

Not logging the query string reduces accidental leakage of query parameters. The logger does not currently record:

- response status;
- response byte count;
- a normalized application error code;
- whether an SSE client disconnected;
- or a generic authenticated principal field.

Without a response-writer wrapper, the logger cannot reliably answer questions such as “which routes produced the most 5xx responses?” or “did a long request succeed or disconnect?”

### 7. Studio Signup and Password Storage

Signup performs the following flow:

```text
decode request
  -> require email and password length >= 8
  -> find existing user by exact email
  -> bcrypt password at cost 12
  -> insert user document
```

Bcrypt is deliberately expensive. The database stores an irreversible password hash rather than a recoverable password. The `model.User.Password` field uses `json:"-"`, preventing ordinary JSON encoding from exposing the hash through `/me`.

The current input policy is intentionally small and incomplete:

- email syntax is not validated;
- email is not trimmed or normalized;
- case variants can become separate identities;
- names are not meaningfully constrained;
- passwords have a minimum but no API-level maximum;
- an overlong password rejected by bcrypt becomes a 500 response rather than a validation error.

The handler first reads by email and then inserts. Because MongoDB does not enforce a unique email index, two concurrent requests can both observe “not found” and both insert. The sequential duplicate test proves only the non-concurrent path.

### 8. Login and Enumeration Resistance

Login looks up the supplied email and compares the supplied password with the stored bcrypt hash.

When the email does not exist, the handler performs a comparison against a precomputed dummy bcrypt hash. This makes the unknown-user path closer in cost to the wrong-password path:

```text
known email    -> bcrypt compare -> generic failure or token
unknown email  -> dummy compare  -> generic failure
```

Both failure cases return `401` with `invalid credentials`. This reduces timing and message-based enumeration through login.

It is not complete account-enumeration prevention because signup returns `409 user already exists` for an existing email. Whether that disclosure is acceptable is a product policy decision.

There is no login attempt rate limit, lockout, delay policy, or per-IP/per-account abuse control. Bcrypt protects stored passwords but also makes repeated login attempts CPU-expensive for the server.

### 9. JWT Creation

Successful login creates a JWT containing:

- `user_id` as the MongoDB object ID string;
- issuer `agentflow`;
- issued-at time;
- expiration approximately twelve hours later.

The token is signed with HS512 and `JWT_SECRET`:

```text
header + claims
      |
      v
HMAC-SHA-512 using JWT_SECRET
      |
      v
signed bearer token
```

The client sends it as:

```http
Authorization: Bearer <token>
```

Because this is a bearer credential, possession is sufficient. The server does not know whether the presenter is the original browser, an attacker who copied the token, or another service. TLS, safe client storage, log hygiene, and bounded token lifetime are therefore part of the security model.

### 10. JWT Validation

`middleware.RequireAuth` requires an `Authorization` header beginning with the exact prefix `Bearer `. It passes the remaining token to `auth.ValidateToken`.

On success, the middleware places `claims.UserID` in the Go request context. Handlers retrieve it through `getUserID` or direct context access.

The parser verifies the signature and the registered expiration through the JWT library's default claims validation. Several policy checks are missing:

1. Generation selects HS512, but validation accepts any `SigningMethodHMAC`. A token signed with HS256 or HS384 using the same secret can satisfy the method check.
2. Generation writes issuer `agentflow`, but validation does not explicitly require it.
3. No audience is written or required.
4. The middleware does not require `user_id` to be non-empty and syntactically valid as a MongoDB object ID before declaring authentication successful.

The algorithm issue is not a secret-less bypass: the attacker still needs the HMAC key. It is a policy downgrade and increases cross-service confusion risk when keys are reused.

### 11. JWT Configuration Lifecycle

`JWT_SECRET` is fetched inside token generation and validation. If it is empty, `log.Fatal` terminates the process.

This produces an unsafe lifecycle:

```text
process starts successfully
  -> public endpoints may work
  -> first login or protected request reaches JWT code
  -> missing JWT_SECRET calls os.Exit(1)
```

Configuration errors should normally be validated once during composition before the server begins listening:

```text
startup
  -> validate secret exists and meets policy
  -> construct JWT signer/verifier
  -> register handlers
  -> listen
```

Then a request cannot terminate the service merely by reaching a lazily validated dependency.

The current code also has no minimum secret length or entropy policy. HMAC security ultimately depends on an unpredictable signing secret.

### 12. Authentication Is Not Authorization

Authentication asks:

> Which principal signed or presented this request?

Authorization asks:

> May that principal perform this action on this exact resource?

A valid token for user B must not allow access to user A's agent, thread, message history, run, or publication.

AgentFlow usually enforces ownership by carrying the user ID into repository queries:

```text
resource.id == requested ID
AND
resource.user_id == authenticated user
```

When that compound lookup finds nothing, the API normally returns `404`. This avoids confirming that a resource exists for another owner.

### 13. Agent, Thread, and Delegate Ownership

Agent create/list/get/update/delete operations use owner-scoped repository methods.

Thread creation and listing first load the referenced agent with the authenticated user ID. A user cannot create a thread against another user's agent merely by guessing its ID.

Delegate validation also loads each target agent in the same user scope. It additionally prevents self-delegation on updates and rejects tool-name collisions. This is important because a delegate is not merely a reference: it becomes an executable model-visible capability.

The rule is:

```text
an agent graph published or executed for one user may contain only agents owned by that user
```

### 14. Message Authorization Depends on Call Order

Message listing and sending first perform an owner-scoped thread lookup. Only after that check do they call message repository methods that accept a thread ID without a user ID.

```text
GetByID(threadID, userID)
        |
        +-- denied: stop
        |
        +-- allowed: ListDocsByThread(threadID)
```

This is currently safe through handler composition. It is not an intrinsic guarantee of the message repository. A future caller that invokes `ListDocsByThread` directly must establish ownership first.

This is an example of a call-order security invariant. Such invariants are harder to preserve than APIs that require the authorization scope as an argument, but adding ownership to every lower-level method also has complexity and denormalization costs. The current contract must therefore remain explicit.

### 15. Run Authorization and the System Read

Run inspection uses `GetRunForUser`. Resume also uses an owner-scoped read and an owner-scoped compare-and-set transition before doing work.

Resume later loads `snapshot.Meta.AgentID` through `GetByIDSystem`, which deliberately ignores user ownership. The expected safety chain is:

```text
owned run
  -> checkpoint belonging to that run
  -> agent ID originally captured from an owned execution
```

This is not a direct external authorization bypass under intact persistence invariants. It is weaker defense-in-depth against corrupt, migrated, or unexpectedly associated persisted state. An owner-scoped agent lookup would re-establish the invariant at the final resource boundary if standalone/system semantics can still be supported cleanly.

### 16. Standalone Runtime Route Surface

The standalone runtime exposes public liveness and readiness endpoints:

- `GET /healthz`;
- `GET /readyz`.

Its protected API contains:

- `POST /v1/threads` for the bundle's root agent;
- `POST /v1/threads/{id}/messages`;
- `GET /v1/threads/{id}/messages`;
- `GET /v1/runs/{id}`;
- `POST /v1/runs/{id}/resume`.

It cannot edit agents or publish revisions. Agent configuration comes from the already loaded deployment bundle.

### 17. Standalone Bearer Authentication

The default standalone mode is `bearer`. Startup requires `RUNTIME_API_TOKEN`, rejects leading/trailing whitespace, hashes the token with SHA-256, and stores the hash in `authConfig`.

For each request:

```text
Authorization bearer value
        |
        v
SHA-256
        |
        v
constant-time comparison with configured hash
        |
        v
bundle-derived synthetic user identity
```

Constant-time comparison avoids revealing how many bytes matched through comparison duration. Retaining a hash instead of the raw configured token reduces long-lived raw-secret exposure inside the configuration object.

Hashing does not add entropy. A short or predictable bearer token remains guessable, and there is currently no minimum length or randomness check.

### 18. Standalone `none` Mode

`RUNTIME_AUTH_MODE=none` explicitly disables application authentication. Startup logs a warning that ingress must enforce access.

The default listen address is `:9090`, which binds all interfaces. Therefore:

```text
auth mode none + externally reachable port + no authenticating ingress
    = unauthenticated deployment API
```

Disabling authentication can be valid behind a mutually authenticated service mesh or a private local boundary. It is not safe merely because the service is called “internal.” Network placement must actually enforce the assumption.

### 19. One Token Means One Principal

Every accepted standalone request receives the same synthetic user ID derived from the bundle. The bearer token answers “may this caller invoke this deployment?” but not “which person or client is calling?”

Consequences include:

- no per-person ownership;
- no scopes or roles;
- no independent client revocation;
- no per-client quotas;
- no individual audit identity;
- token rotation requires a configuration change and restart.

This is a deployment credential, not a multi-user identity system. If future product requirements include multiple callers with different permissions, the authorization model must change rather than merely adding more copies of the same static token.

### 20. Body Size Protection

Both servers wrap request bodies with `http.MaxBytesReader` using a 1 MiB limit.

If a handler reads beyond that limit, the reader returns `*http.MaxBytesError`, and the shared decoder maps it to `413 Request Entity Too Large`.

This protects against unbounded body allocation but does not by itself provide:

- a deadline for slowly transmitted bodies;
- JSON structural or nesting complexity limits;
- per-field length limits;
- rate limiting;
- execution-cost limits.

It also limits bytes actually read by the handler. Because the JSON decoder stops after one value and does not require EOF, a valid first value followed by extra content can be accepted without proving the complete body conforms to the intended one-value contract.

### 21. JSON Decoding Semantics

The shared `decodeJSON` helper calls `json.Decoder.Decode` once.

Confirmed consequences are:

- unknown object fields are ignored;
- a second JSON value is not explicitly rejected;
- trailing content is not checked through a required EOF;
- `Content-Type: application/json` is not enforced;
- all non-size decoding failures collapse to the same `400 invalid request body` response.

A strict boundary would normally:

1. validate the media type;
2. call `DisallowUnknownFields` when forward-compatible loose fields are not intended;
3. decode the expected value;
4. perform a second decode and require `io.EOF`;
5. distinguish size, syntax, type, and semantic validation failures.

Unknown-field rejection has a compatibility trade-off: it catches typos early but makes older servers reject requests from newer clients that send additive fields. That choice should be explicit per API rather than accidental.

### 22. Semantic Validation Is Distributed

After decoding, individual handlers enforce domain-specific requirements.

Confirmed examples include:

- required agent name, provider, model, and system prompt;
- known and unique built-in tool names;
- provider-safe and non-colliding delegate names;
- same-owner delegate targets;
- MCP `server_id` shape, uniqueness, and enabled-catalog membership;
- positive `max_runs`;
- non-empty message text;
- positive publication revisions and bounded publication-list limits.

Other constraints are deferred or absent at Studio-edit time:

- `max_steps`, `max_tokens`, and context-window values have no upper bound;
- temperature and context retention receive stronger validation during publication;
- MCP URLs are not accepted by the agent handler; trusted catalog URLs are validated at Studio preparation and publication/runtime boundaries;
- the direct chat endpoint accepts arbitrary model names and provider parameters.

Deferring deployability checks can be reasonable for editable drafts. It becomes risky when the same draft can also execute in Studio. Constraints needed to keep execution safe and affordable belong before execution even if publication performs a second validation.

### 23. The Direct LLM Chat Endpoint

`POST /api/llm/chat` is authenticated but is not scoped to an owned agent. The caller supplies:

- provider;
- model;
- messages;
- tool definitions;
- temperature;
- maximum tokens;
- arbitrary provider parameters.

The provider must be registered, but the requested model is not checked against the stored model catalogue before the upstream call.

This may be an intentional development or playground endpoint. In a multi-user deployment it is also a shared-cost capability: any authenticated user can cause provider calls using server-held API keys. Authentication alone does not enforce spending policy.

Production exposure would normally require explicit model allow-lists, token/output ceilings, request concurrency limits, per-user quotas, and usage attribution.

### 24. CORS Is a Browser Policy

Studio sets:

```http
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Methods: POST, GET, OPTIONS, PUT, DELETE
Access-Control-Allow-Headers: ..., Authorization
```

This permits the local development frontend to send bearer-authenticated cross-origin requests.

CORS tells cooperating browsers whether page JavaScript may read a response. It does not block `curl`, Postman, server-side callers, or malware. Therefore:

```text
CORS is not authentication.
CORS is not authorization.
CORS is not a firewall.
```

The fixed localhost origin is a development policy, not a configurable production policy. The standalone runtime does not add CORS headers; browser access would need an ingress or a runtime policy.

Because authentication uses an `Authorization` header rather than an automatically attached cookie, the current design does not rely on cookie-CSRF defenses. If cookie-based authentication is introduced later, CORS and CSRF must be reconsidered together.

### 25. Starting an SSE Run

Message send and run resume use Server-Sent Events. Before establishing the stream, the handler:

1. obtains the authenticated user;
2. validates the request body or run state;
3. verifies resource ownership;
4. creates or claims the run;
5. checks that the response writer supports flushing.

It then sets:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

The runtime executes in a goroutine and writes typed events to a buffered channel. The handler's stream loop serializes each event as:

```text
data: {JSON event}

```

`X-Accel-Buffering: no` asks compatible reverse proxies not to buffer the live stream.

### 26. SSE Heartbeats, Cancellation, and Persistence

The stream writes an SSE comment every fifteen seconds:

```text
: ping
```

The heartbeat keeps some intermediaries from treating the connection as idle and gives the server a periodic opportunity to observe a write failure.

When a write fails:

1. the handler marks the client disconnected;
2. it cancels the stream context;
3. the dispatcher, agent runtime, LLM, and tools are expected to observe cancellation;
4. if a partial `RunResult` exists, message persistence is attempted with a fresh ten-second context.

Using a detached, bounded persistence context is deliberate. The request context is already cancelled, but preserving completed work may still be necessary for continuity and resume behavior.

The stream loop ultimately waits for the dispatcher result. If a downstream implementation ignores cancellation and never returns, the HTTP handler can remain blocked after the client disconnects. Correct context propagation is therefore part of the stream's resource-safety contract.

### 27. SSE Terminal Ordering

The stream loop withholds `run.completed`, `run.failed`, or `run.cancelled` events while execution finishes. The handler then attempts message persistence and emits a persistence outcome before the terminal event.

The intended order is:

```text
execution events
  -> persistence success or persistence failure event
  -> terminal run event
```

This prevents the client from interpreting “run completed” as “all resulting messages were safely stored.” It also lets the client distinguish execution success from persistence failure.

Once headers or stream bytes have been sent, the server cannot change the HTTP status to `500`. A stream may begin with HTTP `200` and later contain a failure event. SSE clients must inspect the event protocol rather than treating the initial status as the final result.

### 28. SSE Error Exposure

If the dispatcher returns an error without producing a terminal event, `streamLoop` creates an `engine.runtime_error` event whose message is `out.err.Error()`.

This can expose internal implementation details, provider response bodies, MCP errors, file paths, database information, or operational topology depending on the error chain.

The final event writer also ignores JSON-marshalling and write failures. At that point recovery options are limited, but observability should still record that the client may not have received the terminal state.

A safer boundary uses stable public codes/messages while logging the detailed cause with request and run identifiers.

### 29. JSON Error Translation

Most handlers follow a useful pattern:

```text
detailed cause -> structured server log
stable message -> HTTP response
```

Examples include `invalid credentials`, `failed to load thread`, and `run not found`.

Notable exceptions include:

- direct LLM chat returns provider error text in a 502 response;
- SSE fallback events return raw runtime error text;
- resume exposes toolset and checkpoint validation details;
- publication exposes graph and bundle validation details to the owner.

Detailed validation feedback to an authenticated owner can be useful. Infrastructure and third-party response details should normally remain server-side.

There is no application-wide error envelope containing a stable code and request ID. Error strings are therefore serving simultaneously as user messages, test expectations, and sometimes control-flow signals.

### 30. Security Headers and Download Isolation

General JSON responses do not receive a central security-header policy. This is lower risk than serving executable HTML, but a production ingress still commonly owns TLS/HSTS, MIME-sniffing policy, caching policy, and related headers.

Published bundle downloads are explicitly hardened with:

- JSON content type;
- attachment content disposition;
- `X-Content-Type-Options: nosniff`;
- a restrictive sandboxed Content Security Policy;
- same-origin Cross-Origin Resource Policy;
- `Cache-Control: private, no-store`.

This is appropriate because a bundle can contain sensitive agent instructions and integration configuration, even though it intentionally contains environment-variable names rather than secret values.

### 31. Application Server Timeouts

Both servers configure:

- five-second `ReadHeaderTimeout`;
- 120-second `IdleTimeout`.

They do not configure:

- a whole-request `ReadTimeout`;
- a global `WriteTimeout`;
- a custom `MaxHeaderBytes`;
- application-level TLS.

A short global write timeout would break legitimate long-running SSE streams. This does not mean all writes should be unlimited. JSON routes, request bodies, and stream routes need different policies, often divided between the application and an ingress.

Without a body-read deadline at either layer, a slow client can keep a request body open even though the total readable size is capped. The repository does not prove whether an external proxy supplies that protection.

### 32. Rate, Cost, and Concurrency Controls

Existing resource bounds include:

- request-body size;
- provider and MCP client timeouts;
- MCP response/schema limits;
- agent step and task-tree run budgets;
- bounded event channels;
- worker counts in coordination pools;
- a bus-dispatch timeout;
- cancellation on stream disconnect.

These are not substitutes for API abuse controls. The application currently has no:

- per-IP request limit;
- per-user request limit;
- login/signup throttle;
- provider-cost quota;
- maximum active streams per user;
- global HTTP execution admission controller;
- strong maximum values for agent execution settings.

The configured dispatcher workers govern part of execution scheduling, not the number of incoming HTTP requests. Top-level requests can also use the direct dispatcher, and each top-level task receives its own run budget.

### 33. Health and Readiness

Studio's `/health` returns a static success response. It proves that the HTTP handler is running, not that MongoDB, providers, Redis, memory storage, or execution are usable.

The standalone runtime separates:

- `/healthz`: process liveness;
- `/readyz`: readiness flag plus a one-second SQLite ping.

The operational distinction is:

```text
liveness: should the process be restarted?
readiness: should new traffic be sent to it?
```

An external LLM outage does not necessarily mean the process should be restarted. Dependency availability is often better represented through metrics or a diagnostic endpoint than by collapsing every dependency into liveness.

### 34. Secret Loading and Storage

Sensitive values are primarily read from the process environment:

- `JWT_SECRET`;
- `RUNTIME_API_TOKEN`;
- LLM provider API keys;
- Tavily API key;
- MongoDB and Redis URLs.

Studio loads a local `.env` file when available, and the root `.gitignore` excludes `.env`. No `.env` file was found in the inspected project tree.

LLM registries retain provider keys inside constructed clients. Missing provider keys cause that provider to be skipped rather than failing all startup. MongoDB falls back to localhost; Redis degrades to an unavailable optional cache.

These differing failure policies are intentional composition choices, but they make startup readiness dependent on which capabilities are considered required for a particular deployment.

### 35. MCP Trust Boundary

An agent stores only a catalog `server_id`. The ordinary agent API does not accept or expose an MCP URL, alias, environment-variable name, or credential.

At run preparation:

```text
persisted server_id
        |
        v
AgentFlow-owned catalog lookup
        |
        +--> Studio run: alias + studio_url
        |
        +--> publication: alias + deployment_url frozen in bundle
        |
        v
no-auth MCP HTTP client
```

The deployed runtime reads the frozen bundle and never queries MongoDB. The MCP client has no bearer-token input and does not set an Authorization header.

### 36. MCP Destination Validation and SSRF

MCP runtime validation requires:

- an absolute HTTP or HTTPS URL;
- a non-empty host;
- no embedded user information.

Users cannot submit this URL. Studio preparation resolves `studio_url` from the trusted catalog, publication resolves and freezes `deployment_url`, and standalone startup validates that frozen managed URL before connecting. HTTP, localhost, private addresses, and Kubernetes Service DNS are intentionally permitted because local MCP processes and cluster-internal Services are supported targets.

The old public-address SSRF validator was not weakened and reused. Its user-controlled external-URL path was removed. Managed catalog URL validation now expresses the different trust model directly.

Remaining network concerns belong at two different boundaries:

- catalog administration must remain trusted because a catalog entry determines where Studio and runtimes connect;
- NetworkPolicy should restrict which workloads a runtime and MCP server can reach;
- a Fetch MCP server needs its own SSRF controls because model input determines the downstream fetched URL; and
- the Python sandbox requires a substantially stronger isolation boundary than URL validation.

These concerns do not justify applying a public-address-only rule to legitimate internal MCP Service addresses.

### 37. Transport Encryption Boundary

Both Go servers use `ListenAndServe`, not `ListenAndServeTLS`. Bearer tokens, JWTs, prompts, messages, and bundle responses are therefore protected in transit only if TLS terminates at an ingress, load balancer, service mesh, or local trusted boundary.

This is a common deployment pattern, but the contract must be explicit:

```text
external caller -- HTTPS --> trusted ingress -- protected internal hop --> Go server
```

If the Go port is directly exposed over HTTP, bearer credentials and conversation content can be intercepted. The repository does not establish the actual production ingress configuration, so external TLS enforcement remains **Unknown** in this chapter.

### 38. Standard Library Panic Behavior

There is no custom top-level HTTP panic-recovery middleware. Go's `net/http` server recovers panics from handler goroutines, logs a stack, and closes or aborts the affected response. That prevents most handler panics from terminating the whole process, but it does not produce AgentFlow's normal JSON error contract or a request-correlated application event.

The run-dispatch goroutines add their own recovery and convert a panic into a run error. That prevents a panic from silently losing the stream goroutine, but the recovered panic text may later reach the SSE error message.

Recovery is a containment boundary, not a substitute for fixing panic-capable logic.

### 39. Confirmed Security Strengths

The current boundary has several sound properties:

1. Protected Studio routes are explicit and easy to locate.
2. Most resource queries include authenticated ownership.
3. Wrong-owner resources generally appear missing rather than revealing existence.
4. Passwords use bcrypt and are excluded from JSON.
5. Unknown-user login performs dummy bcrypt work.
6. Credential failures use a generic client message.
7. Standalone bearer authentication is the default and fails startup when its token is missing.
8. Standalone token comparison is constant-time.
9. MCP connections contain no credential field, environment lookup, or Authorization-header behavior.
10. Standalone validates static bundle, hash, managed MCP URLs, providers, and tool constraints before opening runtime storage.
11. Request bodies have a finite read limit.
12. Client disconnect cancellation propagates through a request context.
13. Post-run persistence uses a separate bounded context.
14. Bundle downloads receive strong content-isolation and caching headers.

### 40. Confirmed Gaps and Risks

The most material confirmed issues are:

1. No request, authentication, stream, or provider-cost rate limits.
2. Missing `JWT_SECRET` can terminate Studio from a request path.
3. JWT validation accepts the HMAC family rather than exactly HS512.
4. JWT issuer and audience are not enforced.
5. User-email uniqueness is not atomic.
6. Direct LLM chat is an authenticated but broadly unrestricted shared-cost endpoint.
7. Raw provider/runtime errors can reach API clients.
8. JSON decoding ignores unknown fields and does not require EOF.
9. Several execution settings lack safe upper bounds.
10. Application servers rely on an unconfirmed external TLS boundary.
11. Standalone `none` mode becomes open access when its port is exposed.
12. SSRF validation has dial-time DNS and redirect gaps.
13. There is no per-user active-stream or execution-concurrency limit.
14. Client-provided request IDs are not bounded.

These findings do not prove that a particular production deployment is exploitable. Some missing controls may exist at an uninspected ingress. They do prove that the Go application itself does not currently supply those guarantees.

### 41. Important Unknowns

The repository does not answer several deployment-policy questions:

- Is Studio intended to be reachable directly from the public internet?
- Which reverse proxy or platform terminates TLS?
- Does that boundary enforce body deadlines, connection limits, and rate limits?
- Is `/api/llm/chat` a development endpoint or a supported multi-user product API?
- What are the intended production CORS origins?
- Is standalone `none` mode used only behind authenticated infrastructure?
- What spending and concurrency limits should apply per user or organization?
- Are access and security audit logs collected outside the application?

These questions affect remediation priority. They do not erase application-level gaps such as request-triggered `log.Fatal`, non-atomic identity uniqueness, or overly broad JWT algorithm acceptance.

### 42. Architectural Improvement Direction

The simplest responsible evolution would preserve the current handler/repository structure while strengthening boundaries:

1. Construct and validate an authentication service at startup, including secret policy, exact algorithm, issuer, and identity-shape validation.
2. Add a strict shared JSON decoder with intentional compatibility rules.
3. Define bounded execution settings at the API and publication boundaries.
4. Add rate and concurrency admission around authentication and expensive provider/run endpoints.
5. Establish a documented ingress contract for TLS, body deadlines, header limits, stream timeouts, and maximum connections.
6. Return stable sanitized error codes while retaining detailed correlated logs.
7. Add middleware-composition tests rather than testing only the inner route mux.
8. Expand cross-user tests across agents, publications, threads, messages, and runs.
9. Add redirect and dial-time address enforcement for outbound tools when the threat model requires protection from tenant-controlled destinations.

This does not require a large generic “security framework.” The existing boundaries can be made safer through explicit construction, owner-aware contracts, narrow middleware, and database-enforced invariants.

### 43. Alternatives and Trade-Offs

#### Route-by-route authentication versus a protected sub-router

- Route-by-route wrapping is explicit but easy to omit.
- A protected sub-router makes authentication the default but requires careful placement of public routes.

#### JWT versus server-side sessions

- JWTs avoid a session lookup and work across replicas, but revocation and immediate role changes are difficult.
- Server-side sessions support revocation and rotation more naturally, but add state and a highly available session store.

The current twelve-hour JWT is simple, but future logout/revocation requirements may justify refresh-token or session state.

#### Strict JSON versus forward-compatible loose JSON

- Rejecting unknown fields catches typos and mistaken clients early.
- Ignoring unknown fields can ease rolling upgrades.

The correct choice depends on versioning and client rollout policy. Requiring exactly one JSON value and sensible size/field limits is useful in either design.

#### Application rate limiting versus ingress rate limiting

- Ingress limits are efficient for IP, connection, and broad route protection.
- Application limits understand authenticated user, organization, provider cost, and active run ownership.

A production system commonly needs both because they protect different resources.

#### Global timeout versus route-aware timeouts

- A global write timeout is simple but breaks long SSE runs.
- Route-aware and ingress-aware policies preserve streaming while bounding ordinary requests and total connection lifetime.

#### One standalone token versus per-client identity

- One token is operationally simple for a privately deployed service.
- Per-client credentials improve attribution, revocation, scopes, and quotas but introduce identity lifecycle management.

The simpler model should remain until the product actually requires differentiated callers, provided deployment isolation is real.

### 44. Test Evidence and Gaps

Existing tests provide evidence for:

- JWT generation and validation with the same key;
- rejection of garbage, malformed, unsigned, and wrongly signed tokens;
- middleware rejection and identity injection;
- standalone bearer default, disabled mode, and invalid configuration;
- handler rejection when identity is absent;
- owner-scoped agent, thread, and run repository behavior;
- one cross-user thread-message integration scenario;
- SSE completion and persistence event behavior;
- bundle-download headers;
- MCP secret non-exposure;
- MCP HTTPS/private-address validation.

Important missing or incomplete cases include:

- expired JWT behavior;
- exact HS512 enforcement;
- required issuer/audience;
- signed empty or malformed user IDs;
- weak or short secrets;
- concurrent duplicate signup;
- production middleware-chain behavior;
- oversized bodies and slow bodies;
- unknown and trailing JSON;
- CORS policy;
- request-ID validation;
- rate and concurrency limits;
- cross-user access for every resource type;
- SSE cancellation when downstream work ignores context;
- raw error redaction;
- redirect and DNS-rebinding SSRF cases.

The integration test server registers the handler routes and JWT middleware but does not wrap them with the production RequestID, logging, CORS, or BodyLimit chain. It therefore cannot prove the complete production request boundary.

These tests were inspected but not executed during this documentation pass.

### 45. Source Map

| Area | Source |
| --- | --- |
| Studio route and middleware composition | `backend/main.go` |
| Request identity and body limiting | `backend/middleware/request.go` |
| Studio JWT middleware | `backend/middleware/auth.go` |
| JWT claims, signing, and validation | `backend/auth/jwt.go` |
| Shared response and JSON decoding | `backend/handlers/helpers.go` |
| Password and profile handlers | `backend/handlers/auth.go` and `backend/model/user.go` |
| Agent validation and ownership | `backend/handlers/agent.go` |
| Thread authorization | `backend/handlers/thread.go` |
| Message authorization and streaming | `backend/handlers/message.go` |
| Run access and resume | `backend/handlers/run.go` |
| Shared SSE loop | `backend/handlers/stream.go` |
| Direct provider endpoint | `backend/handlers/llm.go` |
| Publication HTTP surface and bundle headers | `backend/handlers/publication.go` |
| Standalone composition and health | `backend/runtime/app.go` and `backend/runtime/main.go` |
| Standalone bearer authentication | `backend/runtime/auth.go` |
| MCP secret resolution | `backend/agent/runtime.go` |
| MCP URL and discovery policy | `backend/tools/mcp_tool.go` and `backend/tools/ssrf.go` |
| MCP outbound protocol | `backend/mcp/client.go` |
| JWT, middleware, handler, runtime, repository, and integration tests | corresponding `*_test.go` files under `backend/` |

### 46. Chapter Summary

AgentFlow's HTTP layer is the public trust boundary for two different applications. Studio authenticates individual users with bcrypt-backed login and JWTs, then normally enforces tenant isolation through owner-scoped resource queries. The standalone runtime accepts one deployment bearer credential and maps every accepted caller to a synthetic bundle identity. Both servers bound body reads and propagate request cancellation, while SSE handlers deliberately separate execution completion from message-persistence outcomes. Strong points include explicit protected routes, generic credential errors, constant-time standalone token comparison, owner-aware repository calls, indirect MCP secret references, and hardened bundle downloads. The main risks are incomplete JWT policy and startup validation, non-atomic signup identity, loose JSON decoding, raw error exposure, unrestricted expensive endpoints, missing rate/concurrency controls, application-level plain HTTP, and SSRF checks that do not bind validation to the actual dial. The core review question is: “Which identity and resource scope has been established before this operation can consume data, money, network access, or long-lived process capacity?”

## Chapter 10: Publication and Deployment Artifacts

### 1. Why This Layer Exists

The Studio database contains mutable agent definitions. That is correct for authoring: a user needs to change prompts, models, tools, delegates, MCP servers, and execution limits without creating a new database object for every keystroke.

Mutable authoring state is not, however, a safe deployment contract. A runtime needs an exact and repeatable answer to all of these questions:

1. Which version of the root agent is running?
2. Which versions of all reachable delegates are running?
3. Which platform prompt and runtime defaults apply?
4. Can the same configuration be reconstructed after Studio data changes?
5. Can operators detect that an artifact was accidentally altered?
6. Can an earlier configuration be restored while revision history continues moving forward?

If a runtime loaded agents directly from the mutable Studio collections, it could observe a mixture of states. For example, it might read the root before an edit and a delegate after the edit. Even if that mixed graph happened to run, there would be no durable artifact proving what was deployed.

Publication converts the editable graph into a logically immutable artifact. A deployment request then advances versioned desired state, and a future controller reconciles that intent into observed infrastructure. These are separate responsibilities:

```text
Mutable authoring graph
        |
        | publish
        v
Immutable revision history
        |
        | request run/delete (generation CAS)
        v
Versioned desired/observed deployment state
        |
        | provision and reconcile -- controller loop not implemented yet
        v
Standalone runtime instance
```

### 2. Five Objects That Must Not Be Confused

| Object | Mutability | Responsibility |
| --- | --- | --- |
| Studio agent graph | Mutable | The user's editable working copy. |
| Bundle | Content-immutable after publication | A self-contained runtime configuration. |
| Publication revision | Append-only through the repository API | Owner-scoped history and metadata for a stored bundle. |
| Deployment state | Mutable, generation-controlled | Desired target, observed infrastructure, retry schedule, and controller claim for one owner/deployment. |
| Runtime instance | Ephemeral process | Executes one bundle using isolated local state. |

A source-control analogy is useful but not exact:

- The Studio graph resembles a working directory.
- A bundle resembles a build artifact.
- A publication revision resembles a numbered release artifact.
- Desired deployment state resembles the declaration that production should run or delete a particular release; observed state records what actually happened.
- The standalone process is the running workload.

The distinction prevents a common architectural mistake: treating "save," "publish," "request deployment," "reconcile," and "run" as synonyms. They have different consistency, authorization, and failure requirements.

### 3. Confirmed Implementation Boundary

**Confirmed:** publication is implemented end to end and exposed through authenticated Studio routes.

**Confirmed:** an internal deployment service can validate the latest owned publication and advance generation-controlled desired run/delete state.

**Confirmed:** the standalone executable can load and run a bundle delivered to its filesystem.

**Confirmed:** no production HTTP route currently calls the deployment-state service, and no controller consumes due claims yet.

**Confirmed:** the repository now contains a runtime container build definition and a pure typed renderer for the initial Kubernetes Deployment and Service contract.

**Confirmed:** it still contains no Kubernetes client, live controller, reconciler, Helm chart, Terraform resource, desired-state API integration, or equivalent provisioner that turns selected state into a running workload.

Therefore, the current word "deployment" covers artifact selection and identity preparation, not a completed infrastructure rollout system.

### 4. Publication HTTP Surface

Studio registers three JWT-protected endpoints:

```text
POST /api/agents/{id}/publish
GET  /api/agents/{id}/publications
GET  /api/agents/{id}/publications/{revision}/bundle
```

The `id` is the root agent ID and also becomes the deployment ID in the current publisher.

`POST /publish` requires an `Idempotency-Key` header containing 1 through 128 visible ASCII bytes without whitespace. The key identifies one logical publication request; it is neither an authentication credential nor a configuration identity.

Publishing returns:

- `201 Created` when a new revision is appended.
- `200 OK` with `was_existing=true` when the same idempotency key safely replays the same publication.
- `404 Not Found` when the root agent is unavailable in the caller's ownership scope.
- `409 Conflict` when the graph keeps changing and no stable attempt is obtained.
- `409 Conflict` when an idempotency key is reused for different publication content.
- `400 Bad Request` when the idempotency key is absent or malformed.
- `422 Unprocessable Entity` when the graph or resulting artifact is undeployable.
- A generic `500 Internal Server Error` for errors that reach the handler as internal failures.

The `Location` header points to the revision's bundle-download URL. This makes the result discoverable without requiring the client to construct a second URL from undocumented knowledge.

### 5. End-to-End Publish Sequence

The successful path is:

```text
Authenticated request
    |
    v
Validate publication idempotency key
    |
    v
Resolve owner user ID and root agent ID
    |
    v
Walk the owner-scoped delegation graph
    |
    v
Freeze every reachable agent into deployable form
    |
    v
Reload and compare the observed agents
    |
    +-- changed --> discard candidate and retry
    |
    v
Construct and validate bundle
    |
    v
Compute canonical configuration hash
    |
    v
Serialize and enforce the size limit
    |
    v
Strictly parse and re-verify the produced bytes
    |
    v
Append a new revision or reuse the same-hash revision
    |
    v
Return revision metadata and bundle location
```

Re-parsing the serialized output may appear redundant, but it verifies the actual bytes crossing the persistence boundary rather than trusting only the in-memory object that produced them.

### 6. Ownership Covers the Whole Delegation Graph

Every graph node is loaded using both the agent ID and authenticated user ID. Ownership is not checked only on the root.

This prevents a user from publishing:

- Another user's root agent.
- Their own root with another user's direct delegate.
- A graph that reaches another user's agent through several delegation levels.

This is both an authorization rule and an information-boundary rule. A delegate can contain a private prompt, provider choice, tool grants, or MCP configuration. Allowing an owned root to absorb an unowned delegate would leak and execute another tenant's configuration.

The bundle itself does not contain the Studio user ID. Owner isolation is enforced while resolving and storing publications; the standalone artifact later uses a synthetic runtime identity.

### 7. Depth-First Graph Traversal

The publisher walks delegates with depth-first search and tracks three node states:

```text
0 = unseen
1 = visiting
2 = completed
```

The distinction between `visiting` and `completed` is essential.

Consider a cycle:

```text
A -> B -> C -> A
```

When `C` reaches `A`, `A` is still `visiting`. That means the traversal has returned to an ancestor on the active recursion path, so the graph is cyclic.

Now consider a shared delegate:

```text
       Root
       /  \
      A    B
       \  /
        C
```

When the second branch reaches `C`, `C` is already `completed`, not `visiting`. This is a valid directed acyclic graph, and `C` is frozen only once.

Cycles are rejected because delegation is executable control flow. A cycle could otherwise create recursive execution, unbounded model usage, or termination behavior that depends on incidental runtime limits.

### 8. Missing Delegates and Cancellation

If a referenced delegate cannot be loaded in the same owner scope, the publisher rejects the entire graph. It does not silently omit the missing node because that would produce an artifact whose behavior differs from the authored graph.

The walk checks the request context before processing nodes. Cancellation therefore stops publication instead of continuing expensive database reads after the HTTP caller has gone away.

The current error abstraction has an important weakness: the agent reader does not provide sufficiently precise typed errors to the publisher. A missing document, ownership mismatch, and storage outage can be difficult to distinguish. That issue is discussed later in this chapter.

### 9. Why a Multi-Document Snapshot Is Difficult

The graph is stored as multiple mutable MongoDB documents. Reading each document separately does not automatically produce one point-in-time snapshot.

Suppose the initial graph is:

```text
Root version 1 -> Worker version 1
```

During publication:

1. The publisher reads Root version 1.
2. A user changes both agents.
3. The publisher reads Worker version 2.

Without additional protection, the artifact would contain a combination that may never have been intentionally authored.

One solution would be a database transaction with appropriate snapshot semantics around every graph read. The project instead uses optimistic verification to avoid a long, graph-sized transaction and tight coupling between the publisher and MongoDB transaction APIs.

### 10. Two-Pass Optimistic Stabilization

One publication attempt has two passes.

**Pass one: construct a candidate**

1. Traverse the reachable graph.
2. Load every agent in the caller's ownership scope.
3. Convert each agent to its deployable projection.
4. Keep the observed projections in memory.

**Pass two: verify the candidate**

1. Sort the observed agent IDs for deterministic verification order.
2. Reload each observed agent.
3. Convert it to the deployable projection again.
4. Compare the new projection with the original projection.

If any projection differs, the whole candidate is discarded and publication starts again. The default maximum is three attempts.

This is optimistic concurrency control: it assumes edits are relatively infrequent, detects interference, and retries instead of locking authors out while the graph is read.

### 11. Why the Comparison Uses Deployable State

The comparison deliberately ignores authoring-only metadata such as editor layout and ordinary database timestamps.

If a user only moves a node on a canvas, that does not change runtime behavior and should not invalidate a candidate or produce a new deployment revision.

The comparison does include values that affect execution, including:

- Prompt and description.
- Model and provider.
- Context and summarization settings.
- Tool names.
- Delegate relationships and instructions.
- MCP server definitions.
- Runtime limits and temperature.

This boundary defines configuration identity: two Studio documents may differ while still representing the same deployable artifact.

### 12. Limits of the Stabilization Guarantee

The two-pass process is useful but is not a linearizable, atomic, multi-document snapshot.

One counterexample is:

1. Read A and B during the candidate pass.
2. Verify A during the second pass.
3. A changes immediately after its verification.
4. Verify B.
5. Accept the candidate.

An ABA change can also evade equality comparison:

```text
A = value 1
A changes to value 2
A changes back to value 1
```

Both reads see value 1 even though an intermediate edit occurred.

The exact guarantee is therefore:

> The publisher makes a bounded number of attempts to observe the same deployable value for every reachable agent twice; it does not prove that all values came from one database transaction timestamp.

This may be sufficient for a human-edited Studio, but it should not be presented as a serializable snapshot. Requirements involving automated high-frequency graph mutation would justify a stronger versioning or transaction model.

### 13. The Deployable Projection

Publication does not serialize MongoDB agent documents directly. It constructs a deployment-specific representation.

This protects two boundaries:

1. Persistence details do not become a public artifact format accidentally.
2. Only runtime-relevant data participates in deployment identity.

The conversion also copies slices rather than retaining mutable backing arrays. This prevents later in-process mutation of an agent value from silently changing the bundle being assembled.

### 14. Freezing Effective Defaults

Editable agents can use zero values to mean "use the current default." A standalone artifact should not defer that decision indefinitely because application defaults can change across releases.

The publisher freezes effective values such as:

- Model context limit.
- Working context window.
- Context-retention ratio.
- Summarization model.
- Maximum steps.
- Token and run limits.
- Temperature-related defaults.

The reasoning is reproducibility:

```text
If revision 4 was published with a 20-step effective limit,
revision 4 should not become a 30-step deployment merely because
a future Studio release changes the default.
```

Negative values are not converted into defaults. They remain invalid and are rejected by bundle validation. A zero value means "resolve default" only where that convention is explicitly defined.

### 15. Freezing the Platform Configuration

The full platform XML is embedded in the bundle. This makes the artifact self-contained with respect to the platform prompt and prevents a standalone runtime from depending on a matching file in the Studio installation.

The publisher service receives the platform XML during Studio composition. As a consequence, editing the source file on disk while Studio remains running does not necessarily change subsequent publications. The process generally needs to be restarted or recomposed so the publisher receives the new value.

Embedding the platform XML has two important consequences:

- A platform-policy change changes the configuration hash even when no agent document changes.
- Old revisions preserve the old platform behavior instead of inheriting a new global prompt silently.

### 16. Secret Boundary

The bundle does not contain provider keys or MCP credentials. Each MCP entry contains only the selected `server_id`, catalog-owned alias, and frozen deployment URL.

This separates three concerns:

```text
Bundle: declares the resolved MCP endpoint and provider/tool requirements.
Runtime environment: supplies only provider, embedded-tool, and runtime API secrets.
Runtime validator: proves required provider/tool values and managed MCP URL shape before serving.
```

Embedding the actual secret would expose it through revision storage, bundle downloads, backups, logs, and local artifact files. The current indirection avoids that failure mode.

### 17. Bundle Contents

The top-level bundle contains:

- `schema_version`.
- `deployment_id`.
- `config_hash`.
- `root_agent_id`.
- Platform XML.
- A list of frozen agents.

Each frozen agent contains the runtime configuration needed to reconstruct its behavior, including tools, delegates, MCP servers, model settings, context limits, and execution limits.

The current publisher uses the root agent ID as the deployment ID. Static bundle validation does not universally require those two fields to be equal, so the artifact model leaves room for a future deployment identity that is independent of a particular root-agent identifier.

### 18. Data Deliberately Excluded From the Bundle

The artifact excludes:

- Studio user ID.
- Agent creation and update timestamps.
- Visual-editor layout.
- Publication revision number.
- Publication creation time.
- Actual secret values.
- Standalone HTTP authentication configuration.

Excluding these values keeps the configuration hash about executable behavior rather than database history or deployment-environment policy.

There is a related observability trade-off: the runtime naturally knows its deployment ID and configuration hash, but not the Studio publication revision or original user. An external orchestrator would need to inject or record those metadata if operators require logs such as "deployment X is running publication revision 12."

### 19. Static Bundle Validation

Static validation proves facts that require no external network, secret, or machine-specific state. It checks:

- The exact supported schema version.
- Required deployment and root identifiers.
- Presence of platform configuration.
- A non-empty agent list.
- Unique agent IDs.
- Existence of the root agent.
- Existence of every delegate target.
- No self-delegation.
- No graph cycle.
- Reachability of every bundled agent from the root.
- Valid model-provider names.
- Valid agent, tool, delegate, and MCP names.
- No prohibited duplicates.
- Positive runtime limits where required.
- A keep ratio within `(0, 1]`.
- Non-negative temperature.
- Syntactically valid secret environment-variable names.
- Statically valid HTTPS MCP URLs without user information.

Rechecking graph structure at the bundle boundary is defence in depth. It protects callers other than the current publisher and protects future refactors from assuming the traversal always produced a valid artifact.

### 20. Publication-Time Capability Validation

Publication additionally constructs each declared tool set using an environment-independent catalogue.

The catalogue intentionally knows about conditional tools without requiring their runtime secrets. For example, a web-search tool can be recognized as a valid capability even when Studio does not hold the API key that the standalone workload will use.

If publication required every runtime credential, Studio would become coupled to every deployment environment and would need access to secrets it should not possess.

### 21. Runtime-Environment Validation

The standalone runtime performs facts that publication cannot safely prove:

- Required environment values exist.
- Provider credentials are available.
- Required tools can be constructed in this process.
- MCP destinations pass full runtime URL and SSRF checks.
- Runtime authentication configuration is valid.

This layered validation is intentional, not duplicate work:

| Layer | What it can know |
| --- | --- |
| Publication | Graph structure, schema, deterministic capability names, artifact size. |
| Artifact load | Strict JSON shape and configuration-hash integrity. |
| Runtime startup | Actual secrets, providers, DNS/network policy, local storage, and HTTP auth mode. |

### 22. Strict Parsing and Trailing Data

Bundle decoding rejects unknown JSON fields and requires the decoder to reach end-of-file after one value. This prevents accepting data such as:

```text
{valid bundle}{unexpected second object}
```

Unknown-field rejection makes schema mismatches fail visibly. Otherwise an older runtime could silently ignore a newer security- or behavior-related field and run the artifact with unintended semantics.

The trade-off is strict publisher/runtime version compatibility. When the artifact evolves incompatibly, the schema version and rollout plan need to evolve deliberately.

### 23. `Read`, `Load`, and `Parse`

The bundle package exposes three related boundaries:

- `Read(path)` opens and strictly decodes a file, normalizes slice representation, and performs static validation.
- `Load(path)` performs `Read` and then verifies the configuration hash.
- `Parse(bytes)` strictly decodes bytes, statically validates them, and verifies the hash.

Keeping `Read` separate is useful for the `hash-config` command: a bundle without a correct hash must be readable so the command can calculate the value that should be written by an artifact-producing workflow.

Execution paths must use `Load` or `Parse`, not plain `Read`, because a syntactically valid artifact can still have been changed after its hash was calculated.

### 24. Canonical Configuration Hash

The hash is conceptually:

```text
SHA-256(JSON({
    schema_version,
    deployment_id,
    root_agent_id,
    platform_xml,
    agents
}))
```

`config_hash` is excluded from the hash payload. Including it would create a circular definition in which the hash depends on itself.

The result is encoded as 64 lowercase hexadecimal characters.

Because input is decoded to typed data and then marshalled through a controlled payload, insignificant source-file whitespace does not affect the hash. The bundle normalizes nil slices to empty slices so equivalent absence representations do not create avoidable identity differences.

### 25. Deterministic Ordering

The publisher sorts agents lexicographically by ID before hashing and serializing the bundle. This prevents nondeterministic Go map iteration from creating a different hash for the same graph.

Authored order inside fields such as tools, delegates, and MCP servers is preserved and is therefore hash-significant. That is a defensible choice because order can carry human intent or future execution meaning.

An important precision is that `CanonicalHash` does not itself semantically sort arbitrary agent arrays. A manually authored equivalent bundle with a different agent order can produce a different hash. The complete deterministic guarantee relies on the publisher preparing canonical outer ordering before calling the hash function.

### 26. Integrity Is Not Authenticity

The SHA-256 value answers:

> Do these decoded contents match the configuration hash recorded in this bundle?

It does not answer:

> Did a trusted Studio publisher create this bundle?

An attacker who can replace both the content and `config_hash` can calculate a valid hash for the malicious content. Authenticity would require a separate trust mechanism, such as:

- Publisher-held signing key.
- Artifact signature over immutable bytes or canonical content.
- Runtime trust configuration containing an accepted public key.
- Key rotation and signature-version policy.

The current design provides corruption/tampering detection when the expected hash is trusted independently; it does not implement signed provenance.

### 27. Bundle Size Boundary

The publisher serializes the complete bundle and rejects it when it exceeds 12 MiB. The revision repository independently enforces the same maximum and accepts the exact boundary.

The repository check protects against callers that bypass the publisher. The publisher check avoids an unnecessary persistence call and returns a domain-relevant artifact error.

The limit is global rather than per prompt or per agent. A single huge prompt can consume most of it as long as the final artifact remains within the bound.

**Confirmed gap:** standalone `Read`, `Load`, and `Parse` do not apply the same byte limit before decoding arbitrary external input. A manually supplied oversized file can therefore consume more memory even though Studio-produced artifacts are bounded.

### 28. Revision Record

A stored publication revision contains:

- Owner user ID.
- Deployment ID.
- Root agent ID.
- Revision number.
- Idempotency key for replay-safe creation.
- Optional source revision for forward-restoration provenance.
- Schema version.
- Configuration hash.
- Creation timestamp.
- Exact bundle JSON bytes.

The repository API offers append and read operations; it does not expose revision update or deletion. Revisions are therefore logically immutable through the application contract.

MongoDB itself does not make the document physically impossible for a privileged administrator or separate program to update. "Immutable" here means the normal application path is append-only and treats old records as historical facts.

### 29. Revision Identity, Content Identity, and Request Identity

MongoDB enforces two owner-scoped unique keys and one non-unique lookup index:

```text
unique:     (user_id, deployment_id, revision)
unique:     (user_id, deployment_id, idempotency_key)
non-unique: (user_id, deployment_id, config_hash)
```

These fields solve different problems:

- Revision answers, "Which historical publication is this?"
- Configuration hash answers, "Which exact bundle content does it contain?"
- Idempotency key answers, "Is this the same client request being retried?"

The revision key prevents two artifacts from occupying one historical number. The idempotency key prevents a network retry from creating another revision. The hash is deliberately non-unique because a user may intentionally create a new forward revision from configuration that appeared earlier.

Owner ID participates in every index. Different users can independently use the same deployment ID, revision number, hash, or request key without violating tenant isolation.

### 30. Concurrent Publication and Replay Behavior

Suppose two concurrent requests carry the same idempotency key and produce the same configuration:

1. Both validate and freeze the graph.
2. Both may initially fail to find the key.
3. One insert succeeds.
4. The other encounters the unique idempotency-key constraint.
5. The losing request reloads that key, verifies all immutable input fields and exact bundle bytes, and returns the original revision as an idempotent replay.

If the same key resolves to different content, source provenance, schema, or root identity, the second request receives a conflict rather than silently reusing an unrelated revision.

If two requests have different idempotency keys but the same configuration hash, both are intentional publication events. They receive different revision numbers while retaining the same content fingerprint.

### 31. Different Concurrent Publications

Suppose revision 3 is latest and two different configurations publish at once:

```text
Request A reads latest 3 and proposes revision 4.
Request B reads latest 3 and proposes revision 4.
```

One insert wins. The other encounters the unique revision key, reloads the latest state, and retries with revision 5. The retry loop is bounded at ten insert attempts.

This design correctly uses the database as the final concurrency authority. The limitation is that unusually high contention can exhaust the bounded attempts and return an allocation failure. Ordinary human publication traffic is unlikely to hit that case, but automated bulk publishers could.

### 32. Repository Trust Boundary

The revision repository validates identifiers, hash syntax, schema positivity, body presence, and the 12 MiB size limit. It does not independently parse `BundleJSON` and prove that its content actually hashes to the supplied `ConfigHash`.

The current publisher establishes that invariant before calling the repository, and runtime input construction verifies it again before execution. A direct future caller of the repository could nevertheless store inconsistent fields if it bypassed that service contract.

This is an example of deciding where an invariant belongs:

- Keeping parse/hash verification in the service avoids repeated expensive work in the storage adapter.
- Enforcing it in the repository would make the persistence boundary safer against all callers.

The present design relies on disciplined use of the publisher service.

### 33. Listing and Exact-Byte Download

Publication listing returns metadata newest-first and deliberately omits bundle bytes. The handler defaults to 50 records and accepts an explicit limit from 1 through 200.

Bundle download returns the stored bytes rather than reconstructing JSON from current agent documents or revision metadata. This matters because an immutable artifact contract is about the exact published content, not merely data that appears equivalent today.

The download response uses no-store and security headers discussed in the HTTP chapter. The route remains owner-scoped through the authenticated publication service.

### 34. Publication Error-Classification Gap

The publisher currently interprets generic agent-read failures according to traversal position:

- Any root read error is mapped to root-not-found behavior.
- Any delegate read error is mapped to an invalid graph.
- A reload error during snapshot verification is treated as a changed snapshot and can eventually become an unstable-graph conflict.

This can misclassify an infrastructure outage:

```text
MongoDB temporarily unavailable
        |
        +-- root load --> may appear as 404
        +-- delegate load --> may appear as 422
        +-- verification load --> may appear as 409
```

The architecture needs typed or sentinel repository errors that preserve distinctions among:

- Not found.
- Not owned.
- Invalid persisted data.
- Temporary storage failure.
- Context cancellation or deadline.

The handler can only produce correct HTTP semantics if lower layers preserve those meanings.

### 35. Deployment State as a Mutable Control-Plane Aggregate

Publication history answers:

> Which immutable artifacts exist?

Desired deployment state answers:

> Which target and action should the platform reconcile at this generation?

Observed state answers:

> Which generation and resources has a controller actually verified?

Reconciliation state answers:

> Is work due, which attempt is active, and which fenced controller currently owns it?

There is one version-2 record per `(user_id, deployment_id)`. It stores desired, observed, and reconcile subdocuments so one MongoDB operation can advance intent or reject a stale controller without a cross-document transaction.

The forward-only policy does not request revision 6 after revision 8. Restoring revision 6's configuration first creates revision 9 with the same content and `source_revision=6`, then requests revision 9. History always advances while preserving the exact origin of the restored configuration.

### 36. Requesting a Run or Deletion

For a run, the internal deployment service:

1. loads the requested owner-scoped revision;
2. verifies owner, deployment, and revision identity;
3. confirms that revision is the newest publication when evaluated;
4. combines immutable revision metadata with the trusted namespace and digest-pinned runtime image;
5. validates the resulting target; and
6. asks the state repository to update only when `expected_generation` matches.

For deletion, the service requires a positive expected generation and advances desired action to `delete`. The desired target remains stored as the revision high-water mark and as a description of the resources being retired.

Exact run/delete replay does not inflate generation. Conflicting concurrent changes are rejected instead of becoming last-write-wins.

### 37. Kubernetes Resource Identity Is Split by Responsibility

The stable Deployment and Service name is derived from owner plus logical deployment. It does not change across revisions. This preserves one stable workload and network identity.

The state PVC is deployment-owned and stable across revisions under Deployment Architecture Decision 9. Delivery and runtime Secret names are separate resource references. Observed state therefore records structured resource fields instead of one overloaded `resource_name`.

The old revision-specific name is retained only as explicit migration metadata. It is not treated as proof that any Kubernetes object existed or was ready.

### 38. Reconciliation Input and Observation Verification

Desired target, immutable revision, rendered Kubernetes input, and ready observation must eventually agree:

```text
Desired target
      <->
Immutable revision record and bundle
      <->
Rendered Kubernetes objects
      <->
Observed generation annotations and readiness
```

The current phase implements the first durable boundary and requires a ready writer to report exactly the current desired target. Bundle loading, delivery URL/token creation, resource rendering, cluster apply, and readiness interpretation remain controller work.

### 39. Concurrent Mutations and Controllers Are Fenced

User mutations use generation compare-and-set. Two callers that both expect generation 8 cannot silently create generations 9 and 10 from the same stale view; one wins and the other receives a conflict.

Controller work uses an atomic claim containing desired generation, random token, owner, and lease expiry. Every observed-state mutation repeats those values in its MongoDB filter and requires an unexpired lease. A zero-row update means the attempt lost authority and must stop.

This protects MongoDB status from stale writers. The later Kubernetes adapter still needs cluster-side generation/resource-version protection because MongoDB cannot revoke an API request already sent to Kubernetes.

### 40. Standalone Runtime Handoff

The standalone executable accepts a bundle file and data directory. Its important commands are conceptually:

```text
agentflow-runtime hash-config --config bundle.json

agentflow-runtime serve \
    --config bundle.json \
    --data /runtime-data \
    --listen :8080
```

`hash-config` reads and statically validates the configuration, then prints the canonical hash. It does not mutate the file.

`serve` loads and hash-verifies the bundle, validates the runtime environment, composes the standalone application, opens isolated persistence, and serves the runtime HTTP API.

No code in the current Studio process invokes this command or delivers the bundle file automatically. That handoff is an operational step outside the implemented deployment service.

### 41. Synthetic Runtime Identity

The standalone application derives a synthetic user ID from the configuration hash:

```text
runtime_<hash-prefix>
```

This allows existing user-scoped runtime repositories and execution services to operate without a real Studio login session. Every authenticated standalone caller maps to the same deployment principal because the standalone server represents one bundle, not a multi-tenant Studio.

The bundle-backed `AgentReader` keeps agents in memory and returns defensive copies. Scoped reads accept only the synthetic user identity, while explicit system reads support trusted internal execution paths.

### 42. Persistent Data Identity Binding

The SQLite data directory is bound to:

- Deployment ID.
- Configuration hash.
- Synthetic user ID.

If a runtime attempts to open an existing directory with a different identity, startup fails.

Without this check, a new artifact could accidentally interpret conversations, runs, jobs, checkpoints, or memory created under different semantics. The binding makes such accidental reuse visible instead of silently corrupting behavior.

### 43. State-Isolation Consequence

A new configuration hash changes the synthetic user identity. The derived resource name also includes revision and hash.

Together, these choices strongly suggest isolated persistent state per immutable deployment artifact. That supports reproducible forward restoration and prevents cross-version data confusion, but it has a user-visible trade-off:

> A new revision does not automatically inherit runtime conversations, memory, jobs, or scratch state from the previous revision.

No state migration, cloning, or carry-forward workflow is currently implemented. A future deployment controller must decide whether new revisions receive fresh storage, cloned storage, a migration, or access to an explicitly shared external state service.

### 44. Missing Deployment Reconciler

The repository does not yet implement the component that turns selected state into observed infrastructure.

A complete controller would typically need to:

1. Observe that desired revision N is selected.
2. Fetch and verify runtime inputs.
3. Materialize the bundle safely for the workload.
4. Create or update a runtime workload.
5. Create networking and persistent storage.
6. Inject secrets without writing them into the bundle.
7. Wait for readiness.
8. Record observed revision, health, and rollout errors.
9. Shift traffic when the new runtime is ready.
10. Retain or retire old revision resources according to the forward-restoration and audit policy.

Current deployment state contains only the desired selection. It has no observed status, rollout phase, health information, provisioning error, generation, or cleanup state.

### 45. Failure Boundaries

| Failure | Current behavior |
| --- | --- |
| Root or delegate unavailable in owner scope | Publication is rejected. |
| Delegation cycle | Publication is rejected. |
| Graph changes between observations | Candidate is discarded and retried. |
| Graph never stabilizes within the attempt limit | Publication returns a conflict. |
| Bundle violates static rules | Publication/startup is rejected. |
| Bundle exceeds 12 MiB during publication | No revision is written. |
| Same content is published with a new idempotency key | A new forward revision is appended. |
| The same publication request is retried with the same key | The original revision is returned. |
| An idempotency key is reused for different content | Publication returns a conflict. |
| Concurrent distinct revisions collide | Repository retries with the next revision. |
| Stored/downloaded bytes are changed without matching hash | Runtime parsing rejects them. |
| Environment secret or provider key is missing | Standalone startup fails before serving. |
| Existing data directory belongs to another artifact | Standalone startup fails. |
| Desired generation is changed | Durable due work is recorded, but no workload is provisioned until a controller exists. |
| Process crashes after the request | Desired state and due time remain durable, but no current production controller consumes them. |

### 46. Architectural Strengths

1. Mutable authoring is separated from immutable execution artifacts.
2. Ownership is enforced across every reachable graph node.
3. Cycles, missing delegates, and unreachable bundled agents are rejected.
4. Authoring noise is excluded from deployment identity.
5. Effective defaults are frozen for reproducibility.
6. Platform behavior is included in the artifact hash.
7. Secret values remain outside bundles.
8. Strict parsing makes incompatible schemas fail visibly.
9. Deterministic publisher ordering avoids map-order hash drift.
10. Explicit publication idempotency keys make request retries converge without confusing content identity with event identity.
11. Database uniqueness protects concurrent revision allocation.
12. Exact stored bytes can be downloaded and re-verified.
13. Static and environment-dependent validation are separated.
14. Deployment mutations use expected-generation compare-and-set instead of last-write-wins.
15. Controller observations are fenced by generation, claim token, owner, and lease.
16. Runtime state directories are bound to immutable artifact identity.

### 47. Confirmed Limitations and Risks

1. Deployment mutation/status is not connected to an HTTP route or production controller composition.
2. No infrastructure provisioner or reconciler exists.
3. The two-pass graph check is not an atomic multi-document snapshot.
4. Publisher repository errors can be mapped to misleading client errors.
5. The hash is not a digital signature and proves no publisher identity.
6. External standalone loading does not enforce the 12 MiB bound before decoding.
7. Canonical outer ordering depends on the publisher rather than the hash function alone.
8. MongoDB fencing cannot by itself prevent a stale controller from sending a Kubernetes mutation.
9. Full deployment HTTP idempotency needs immutable operation history; current state provides CAS and narrow exact-state replay.
10. Runtime state has no cross-revision migration path.
11. There is no publication retention, deletion, or garbage-collection policy.
12. The platform XML is captured from the Studio process's loaded configuration.
13. Revision number and Studio owner are absent from runtime artifact metadata.
14. Publisher and runtime schema compatibility requires coordinated rollout.

### 48. Alternatives and Trade-Offs

#### Read mutable Studio state directly at runtime

This would remove bundle creation, but it would couple runtime availability to Studio and MongoDB, permit behavior to change without a deployment event, weaken forward restoration, and make exact reproduction difficult. The current artifact boundary is safer.

#### Use a MongoDB snapshot transaction for publication

This could provide a stronger point-in-time read than two-pass verification. It would increase database coupling, transaction duration, and operational requirements. It becomes more attractive if graph edits are automated or exact snapshot semantics become contractual.

#### Give every save a monotonic agent version

The publisher could record and verify per-agent version numbers. This would detect ABA changes more reliably than value equality, although it still would not automatically prove a single cross-document commit unless topology changes shared a transaction/version boundary.

#### Store only bundle metadata and regenerate bytes

This would reduce duplicate storage but destroy the exact-artifact guarantee. Regeneration can change with serializer, default, catalogue, or platform versions. Storing exact bytes is the more reproducible choice.

#### Sign bundles

Signing would add trusted provenance and is appropriate when artifacts cross a less-trusted delivery channel. It introduces key custody, rotation, algorithm/version, and incident-response responsibilities. It should be added for a clear authenticity threat model, not confused with ordinary hashing.

#### Mutate one workload in place for every revision

This uses fewer resources but makes state compatibility and forward restoration harder. Revision/hash-derived workload identities support controlled replacement patterns at the cost of more lifecycle and cleanup work.

#### Share one data directory across revisions

This preserves conversations and memory automatically but can let new code/configuration reinterpret old state unsafely. The current binding chooses isolation. Explicit, versioned migration would be safer than implicit reuse if continuity becomes required.

### 49. Test Evidence

Publisher tests cover:

- Sorted traversal and deterministic output.
- Shared delegates.
- Effective default freezing.
- Publication and bundle round-trip.
- One concurrent change followed by a stable retry.
- Continually changing graphs becoming unstable.
- Missing roots and delegates.
- Cycle rejection.
- Invalid and oversized bundles producing no write.
- Same-content replay.
- Cancellation.
- Studio-only timestamp changes not changing the hash.

Bundle tests cover:

- Strict decoding and unknown fields.
- Trailing JSON rejection.
- Hash verification after mutation.
- Formatting-independent hashing.
- Deployment identity participating in the hash.
- Studio timestamps being excluded.
- Defaults and defensive copying.
- Invalid graph structures.
- Bundle-backed agent-reader scope and copy behavior.
- Environment, provider, tool, and MCP validation.

MongoDB integration tests cover:

- Replay and revision increment.
- Concurrent identical publication converging on one new revision.
- Concurrent distinct publications receiving unique sequential revisions.
- Owner scoping.
- Unique index behavior.
- Exact maximum-size handling.
- Publisher-to-Mongo-to-filesystem-to-runtime round-trip.

Deployment-state tests cover target validation, expected-generation mutation, exact-state replay, forward-only revision guards, cross-owner isolation, concurrent writers, due claims, leases, stale-writer fencing, retry timing, terminal outcomes, ready/deleted observation, and explicit legacy conversion.

These tests were inspected during this study; they were not executed as part of the documentation-only work.

### 50. Important Missing Tests

The current test suite does not fully prove:

- A real multi-document MongoDB edit race during traversal and verification.
- ABA mutation behavior.
- Delegate-topology mutation at every verification timing boundary.
- Correct publisher classification of database outages.
- Behavior beyond ten allocation collisions under extreme contention.
- Bounded decoding of an oversized manually supplied runtime file.
- Bundle signature/provenance verification, because signing does not exist.
- Public deployment-operation idempotency across arbitrarily late retries, because an immutable operation history does not yet exist.
- End-to-end workload provisioning, readiness, traffic shift, and forward restoration, because the controller does not exist.
- Runtime state migration between revisions, because migration does not exist.

### 51. Source Map

| Concern | Primary source |
| --- | --- |
| Publish orchestration and stable graph attempts | `backend/publisher/service.go` |
| Bundle schema, validation, parsing, and hashing | `backend/deployment/bundle.go` |
| Bundle-backed agent reader | `backend/deployment/reader.go` |
| Publication revision model | `backend/deployment/revision.go` |
| Desired/observed/reconcile deployment domain | `backend/deployment/deploy_state.go` |
| Generation-controlled run/delete application service | `backend/deployment/service.go` |
| Publication HTTP API | `backend/handlers/publication.go` |
| MongoDB revision persistence and concurrency | `backend/repo/mongorepo/deployment_revision_repo.go` |
| MongoDB generation CAS, claims, leases, fencing, and migration | `backend/repo/mongorepo/deployment_state_repo.go` |
| Standalone command boundary | `backend/runtime/main.go` |
| Standalone application composition | `backend/runtime/app.go` |
| Runtime data-directory binding | `backend/repo/sqliterepo/deployment_identity_repo.go` |
| Production Studio wiring and route registration | `backend/main.go` |
| Publication, bundle, persistence, state, and runtime evidence | corresponding `*_test.go` files |

### 52. Chapter Summary

AgentFlow publication transforms a mutable, owner-scoped delegation graph into a strict, self-contained bundle. It rejects missing nodes and cycles, attempts to observe stable deployable values twice, freezes effective defaults and platform behavior, excludes authoring noise and secrets, calculates a SHA-256 content identity, and verifies the serialized bytes. Every new publication intention appends a forward-moving owner-scoped revision, even when its content matches an older revision; an explicit idempotency key makes retries converge on the original result. The deployment service separates immutable history from versioned desired intent, and MongoDB now separates desired, observed, and reconciliation ownership with generation CAS, leases, and fenced writes. The standalone runtime further binds local state to deployment identity and hash. The central limitation is equally important: deployment mutation is not wired into production routes, and no infrastructure controller exists to create, observe, update, or retire a Kubernetes workload. The layer is therefore a strong artifact-publication and durable control-state foundation, not yet a complete managed deployment system.

## Chapter 11: Standalone Runtime

### 1. Why a Separate Runtime Exists

The Studio backend is the authoring and control-plane application. It lets authenticated users create and modify agents, start runs, publish immutable deployment revisions, and inspect their state. A deployed artifact needs a different environment: it should execute one already-published graph without exposing the authoring operations that produced it.

That is the responsibility of `backend/runtime`.

The standalone runtime is a separate Go executable with a deliberately narrower contract:

1. receive one immutable deployment bundle;
2. verify that the bundle is internally valid and has the expected identity;
3. construct the execution engine from that bundle;
4. expose only thread and run operations for the bundle's root agent;
5. store its operational state in a local data directory;
6. recover interrupted work after process restart; and
7. stop accepting work and drain resources during shutdown.

This is best understood as a **single-deployment execution appliance**, not as a smaller copy of Studio. It does not provide agent CRUD, publication, deployment selection, or tenant administration.

### 2. The Control Plane and Data Plane Split

A useful mental model is:

```text
Studio / control plane
  mutable agents -> validation -> immutable deployment bundle
                                      |
                                      v
Standalone / data plane
  verified bundle -> one executable graph -> thread/run API
```

The split protects a useful boundary:

- Studio owns authoring-time mutability and deployment history.
- The bundle is the immutable handoff contract.
- The standalone runtime owns execution-time state for exactly that bundle.

Without this split, a running deployment could silently change whenever an author edited the source graph. With it, a runtime can say, "all of this state belongs to deployment `D` with configuration hash `H`."

The present repository implements the artifact and execution sides of this boundary. As Chapter 10 established, it does not yet contain the infrastructure reconciler that would turn a selected revision into a managed container, process, or cluster workload.

### 3. Executable Entry Point and Commands

The command boundary is in `backend/runtime/main.go`. It exposes two subcommands.

#### `hash-config`

Conceptually:

```text
runtime hash-config --config <bundle.json>
```

This command:

1. reads the bundle bytes;
2. parses and statically validates the bundle;
3. calculates the canonical configuration hash; and
4. prints the hash.

It does not start the runtime, connect to providers, construct tools, or mutate the data directory. Its main purpose is independent artifact inspection: an operator or packaging pipeline can determine the bundle identity before launching it.

#### `serve`

Conceptually:

```text
runtime serve \
  --config <bundle.json> \
  --data <runtime-data-directory> \
  --listen :9090
```

This command verifies the bundle, validates runtime inputs, constructs all services, and starts the HTTP server. The listen address defaults to `:9090`.

The CLI uses conventional process exit classes:

- `0`: successful command completion;
- `1`: application/startup/runtime failure; and
- `2`: command-line usage or flag-parsing failure.

The command surface is intentionally small. It currently has no version command, config-file layering, generated shell completion, or CLI flags for most runtime tunables. Extra positional arguments are also not explicitly rejected after flag parsing, which makes the CLI contract looser than its usage text suggests.

### 4. Configuration Is Split Across Three Sources

The runtime's effective behavior comes from three places.

| Source | Examples | Responsibility |
| --- | --- | --- |
| Immutable bundle | agents, root agent, effective prompts/models/settings, tool definitions, platform behavior | Defines what is deployed. |
| CLI flags | bundle path, data path, listen address | Defines where this instance reads, stores, and listens. |
| Environment variables | runtime bearer token, provider API keys, Tavily key, `RG_PATH` | Supplies secrets and environment-specific capabilities. |

This separation is architecturally sound: secrets do not belong in a content-addressed bundle, while behavior that defines the deployed artifact should not drift through arbitrary environment overrides.

The runtime recognizes authentication settings such as `RUNTIME_AUTH_MODE` and `RUNTIME_AUTH_TOKEN`, provider credentials such as OpenAI, NVIDIA, and Anthropic keys, the Tavily search credential, and `RG_PATH`. MCP definitions do not reference environment credentials.

Unlike Studio, the standalone executable does not call `godotenv.Load`. A local `.env` file is therefore not an implicit configuration source for this process. Values must already exist in its process environment. That difference is operationally important in local development and container packaging.

### 5. Important Tunables Are Currently Constants

Several capacity and timeout choices are fixed in code rather than exposed as configuration:

- four workers per agent pool;
- five concurrent async jobs per originator;
- a thirty-minute dispatcher timeout;
- a sixty-second MCP HTTP timeout;
- a one-mebibyte HTTP request-body limit;
- a five-second HTTP read-header timeout;
- a 120-second idle timeout;
- a thirty-second HTTP shutdown deadline;
- a five-second resource-cleanup deadline;
- SQLite WAL mode, a five-second busy timeout, and one open/idle connection.

Hard-coded values are not automatically wrong. They provide a deterministic first deployment contract. The trade-off is that an operator cannot adapt concurrency, queue pressure, upstream latency, or shutdown behavior without rebuilding the executable.

### 6. Startup Is a Dependency-Ordered Transaction, but Not a Database Transaction

The high-level startup sequence in `backend/runtime/app.go` is:

```text
parse command and flags
  -> read and verify bundle
  -> resolve authentication
  -> create root cancellation context
  -> validate bundle, environment, providers, and declared tools
  -> create data directory
  -> open and migrate SQLite
  -> bind data directory to deployment identity
  -> recover orphaned runs
  -> construct repositories
  -> initialize memory and scratchpad services
  -> construct providers, tools, and agent runtime
  -> construct bus, worker pools, coordinator, and dispatcher
  -> construct HTTP handlers and server
  -> mark ready and serve
```

Order matters because later objects depend on guarantees established by earlier steps. For example, repositories cannot exist before SQLite is migrated, and requests must not arrive before the circular runtime/delegation wiring is complete.

The phrase "startup transaction" is only a mental model. The entire sequence is not atomically rolled back. Each successfully opened resource must instead be closed explicitly if a later step fails.

### 7. Validation Before Mutation: The Exact Guarantee

The runtime makes a strong effort to reject invalid deployment inputs before creating runtime state. Static bundle validation, configuration-hash verification, required environment checks, provider registration checks, and declared-tool validation occur before the first intended filesystem mutation.

There is, however, an important boundary in the actual ordering. Memory and scratchpad startup validation occurs after the runtime has created the data directory and initialized SQLite. Those services create their subdirectories and resolve the `rg` executable during initialization.

Therefore the precise guarantee is:

- invalid bundle/provider/tool inputs are rejected before data-directory initialization;
- invalid memory/scratchpad runtime prerequisites can be discovered after the directory and database already exist;
- opened resources are closed on failure, but created files and directories are not rolled back.

For example, an invalid `RG_PATH` can leave behind an initialized `state.db`, `memory/`, or `scratchpad/` structure even though the process never becomes ready. This is safe from a data-integrity perspective, but it is not a perfectly side-effect-free failed startup.

### 8. Static Validation and Runtime Validation Solve Different Problems

Bundle validation can prove facts such as:

- required identifiers are present;
- the root agent exists;
- graph references are valid;
- declared provider and tool names have acceptable structure; and
- the serialized bundle matches its configuration hash.

Runtime validation can additionally prove facts such as:

- the required provider API-key environment variable is non-empty;
- the requested provider adapter can be registered;
- frozen managed MCP URLs have an accepted absolute HTTP/HTTPS shape;
- a Tavily key exists if web search is used; and
- the configured `rg` executable can be found.

Neither layer proves that an external credential is accepted, the upstream endpoint is reachable, the selected model exists, quota remains, or an MCP server is healthy. Those facts require external calls. The runtime deliberately does not make every upstream dependency part of readiness-time probing.

### 9. `rg` Is an Unconditional Runtime Dependency

The memory and scratchpad services use ripgrep for repository-local text search. Both services are always composed during runtime startup, even if the deployed graph never invokes their tools.

Consequently, `rg` is currently an unconditional executable dependency of the standalone process. This is an example of composition determining deployment requirements: optional behavior at the agent level does not become an optional binary dependency when the containing service is always initialized.

There are three possible future directions:

1. document and package `rg` as a mandatory dependency;
2. initialize memory/scratchpad only when the bundle needs them; or
3. replace the external process dependency with an in-process search implementation.

The current code follows option one implicitly; the packaging layer has not yet made that contract explicit.

### 10. SQLite Is the Standalone State Boundary

The runtime opens `<data-directory>/state.db` through `backend/repo/sqliterepo`. Its connection configuration enables:

- foreign-key enforcement;
- write-ahead logging (WAL);
- a five-second busy timeout; and
- one open and one idle database connection.

The single connection intentionally serializes access inside the process and avoids surprising interactions among connection-local SQLite settings. WAL improves reader/writer coexistence, but it does not turn SQLite into a shared distributed database.

This choice fits a single-process appliance: deployment is simple, state is durable across restarts, and no external database is required. Its costs are limited write concurrency, local-disk operational responsibility, and no supported multi-replica ownership model.

### 11. Schema Migrations Run Before Repositories Are Used

The SQLite migration runner uses `PRAGMA user_version` as the schema version. At startup it:

1. reads the current version;
2. rejects a database newer than the executable understands;
3. applies pending migrations in order; and
4. updates `user_version` transactionally with each migration.

The current migration history introduces core runtime state first, asynchronous jobs second, and deployment identity third.

Rejecting a newer database is essential. Silently operating on a future schema could corrupt state or misinterpret columns. The reverse case—an older database—is handled by forward migration.

The migration package is internal to the standalone repository implementation. That coupling is acceptable while SQLite is an implementation detail of this executable, but an external migration command would be needed if operators eventually require pre-deployment migration, rollback planning, or zero-downtime multi-version rollout.

### 12. Deployment Identity Prevents Cross-Bundle State Reuse

After migration, the runtime binds the data directory to a deployment identity containing:

- deployment identifier;
- configuration hash;
- synthetic runtime user identifier; and
- creation time.

The first successful startup inserts this identity. A later startup with the same values is accepted. A startup that points the directory at a different deployment or configuration hash is rejected.

This enforces a crucial invariant:

> Durable threads, runs, checkpoints, jobs, and memories created for one immutable deployment must not be silently interpreted as state for another deployment.

The binding operation is designed so concurrent attempts with the same identity converge safely, while a conflicting identity fails. It is stronger than naming a directory after a deployment because it verifies the association inside the durable store itself.

### 13. What the Data Directory Owns

The standalone data directory is not merely a cache. It owns durable runtime state:

- `state.db` and its SQLite auxiliary files;
- thread and message history;
- run records, status transitions, and checkpoint snapshots;
- task records;
- asynchronous jobs, callback state, leases, and lock/fencing data;
- deployment identity;
- scoped memory files and revision metadata; and
- scratchpad files.

Deleting this directory is therefore a destructive operational action. Restoring it from backup must restore the database and filesystem-backed memory/scratchpad state consistently enough for their revision contracts.

### 14. Orphan Recovery Happens Before Serving

A process can stop while a run is marked `running`. On restart, no goroutine is actually executing that run. Leaving the row untouched would create permanently misleading state.

Startup recovery scans for orphaned running runs:

- a run with a checkpoint becomes `interrupted`, meaning continuation is possible through the explicit resume workflow;
- a run without a checkpoint becomes `failed`, because the runtime lacks a safe continuation state.

The distinction avoids pretending that all crashes are resumable. A persisted status alone is not enough; a usable checkpoint is the evidence needed to continue the state machine.

### 15. Resume Is Explicit and Concurrency-Protected

The API exposes an explicit resume operation rather than automatically restarting every interrupted run. The resume path:

1. uses compare-and-swap semantics to claim the interrupted run;
2. loads the persisted checkpoint;
3. validates checkpoint compatibility, including toolset/snapshot expectations;
4. increments the attempt; and
5. re-enters execution.

Compare-and-swap matters because two clients or recovery paths could otherwise resume the same run concurrently. The database transition is the shared-state arbitration point.

The runtime is still at-least-once with respect to external side effects. A checkpoint proves where internal orchestration can resume; it cannot prove that an earlier remote mutation did or did not complete unless that integration provides an idempotency contract.

### 16. The Coordinator Repairs Durable Asynchronous Work

The asynchronous coordinator starts with an immediate reconciliation tick and continues on a timer and wake signal. It examines durable job state for work such as:

- queued jobs ready to execute;
- expired leases that may be reclaimed;
- callbacks waiting to be delivered; and
- work that must resume after a process interruption.

The in-memory wake signal improves latency while the process is alive. The database remains the recovery authority. If a wake is lost during a crash, the periodic reconciliation of durable rows is what restores progress.

### 17. The Bundle Becomes an In-Memory Agent Reader

`backend/deployment/reader.go` adapts the immutable bundle to the same agent-reading interface used by the execution engine.

Its behavior is intentionally restricted:

- agents are read from the verified in-memory bundle;
- lookup is scoped to the runtime's synthetic user;
- system-level reads are available where internal services require them;
- returned values are defensively cloned; and
- no update operation exists.

This adapter is valuable because the execution engine does not need a special "deployed mode." It depends on an agent-reading contract, and the composition root supplies a bundle-backed implementation rather than MongoDB.

Defensive copies protect immutability inside the process. Without them, a consumer could mutate a slice or nested value from the supposedly immutable deployment graph.

### 18. Manual Dependency Injection Is the Composition Strategy

The application is assembled explicitly in Go rather than through a reflection container or generated injector. The dependency chain is approximately:

```text
SQLite repositories
  -> application services
  -> provider registry and tool registry
  -> bundle-backed agent reader
  -> context builder
  -> agent runtime
  -> MCP clients and summarization support
  -> in-process event bus
  -> worker-pool hub and per-agent pools
  -> async preparer and coordinator
  -> dispatcher and delegation invoker
  -> HTTP handlers and server
```

Manual construction makes ownership visible in one place. A reviewer can see which concrete implementation satisfies every interface and in which order resources become live. The cost is a long composition function and some duplicated wiring relative to Studio.

### 19. The Runtime/Delegation Cycle Is Closed in Two Phases

There is a genuine runtime dependency cycle:

```text
agent runtime
  -> delegation invoker
  -> worker pools
  -> agent runtime
```

Constructors cannot create all three objects in a single acyclic chain. The code resolves this by:

1. constructing the runtime without its final invoker;
2. constructing the pools and delegation machinery that refer back to the runtime; and
3. installing the invoker through setter injection before the server begins accepting requests.

This is controlled two-phase initialization. It is safe only because no request can observe the partially wired runtime. Its architectural smell is not the setter itself; it is the underlying bidirectional knowledge. If this area changes frequently, an explicit orchestration interface or narrower callback contract may reduce the cycle.

### 20. Tool Construction Has Environment-Specific Behavior

The standalone tool registry is built from the bundle and process environment. Provider and MCP credentials are resolved at runtime rather than embedded in the artifact.

Unlike Studio, the standalone composition passes no Redis client into the tool registry. Any Redis-backed deduplication used by HTTP or web-search tooling is therefore unavailable here.

This does not mean every tool invocation is duplicated. It means the runtime itself cannot provide cross-attempt exactly-once protection for remote side effects through that mechanism. A call can be retried after an ambiguous network failure or resume boundary.

For mutating external APIs, robust correctness requires an idempotency key understood by the destination or a durable outbox/receipt design. Local checkpoints alone cannot create exactly-once behavior across a network boundary.

### 21. The Event Bus Is Process-Local

Runtime events flow through an in-process bus. This is efficient and simple for one executable:

- no broker deployment is required;
- delivery has low overhead; and
- handlers share the same cancellation domain.

The trade-off is a hard process boundary. Live events do not survive a crash and cannot coordinate independent replicas. Durable jobs recover from SQLite because their state is persisted; ephemeral bus delivery does not become distributed merely because the job record is durable.

### 22. Worker Pools Are Lazy and Per Agent

The pool manager creates worker pools on demand for agents and uses four workers per pool. Lazy creation avoids launching workers for every node in a bundle that may never be called.

The capacity consequence is subtle. Four workers per agent is not a four-worker process limit. If many agents become active, the process can create many pools and therefore many workers. There is no equivalent global worker ceiling in this composition.

At the same time, all durable repository traffic uses a one-connection SQLite pool. Application-level concurrency can therefore be much wider than database write concurrency. This is not necessarily incorrect—the LLM and network calls dominate much work—but it is an important throughput and contention characteristic.

### 23. The Standalone HTTP Surface Is Deliberately Narrow

The public health endpoints are:

- `GET /healthz`
- `GET /readyz`

The authenticated runtime API includes operations equivalent to:

- `POST /v1/threads`
- `POST /v1/threads/{threadID}/messages`
- `GET /v1/threads/{threadID}/messages`
- run inspection; and
- explicit run resume.

New threads are always associated with the bundle's root agent. A caller cannot select an arbitrary agent ID to turn an internal delegation node into a public entry point.

The executable does not expose Studio's agent CRUD, prompt editing, provider settings, publication, or selected-deployment APIs. That is the concrete enforcement of the control-plane/data-plane split.

### 24. Authentication Modes

Bearer authentication is the default mode. Startup requires a nonblank token, hashes it for comparison state, and middleware uses a constant-time comparison. Failed authentication returns a generic unauthorized response rather than revealing whether the header, scheme, or token content was wrong.

Constant-time comparison reduces timing leakage about the secret. Keeping only a digest in long-lived middleware state reduces accidental exposure relative to retaining the raw token everywhere, although the original environment value still exists in the process environment.

An explicit `none` mode disables authentication and emits a warning. This is appropriate only when a trusted ingress or local boundary provides the missing protection.

### 25. Authentication Is Instance-Level, Not User-Level

All accepted callers operate as the same synthetic runtime user. The bearer token proves permission to use the deployment; it does not identify an individual human, organization member, or API client.

Consequences include:

- repository ownership checks still work, but every caller shares one owner identity;
- per-client authorization cannot be expressed;
- audit logs cannot attribute an action to a distinct caller;
- token rotation and overlapping old/new tokens are not modeled; and
- no minimum token-strength policy is enforced beyond rejecting whitespace-only values.

This is sufficient for an appliance protected by a secret and an external gateway. It is not a complete public multi-tenant authentication system.

### 26. HTTP Safety Controls

The server applies several useful controls:

- request bodies are limited to one mebibyte;
- request IDs are generated or propagated;
- requests are logged;
- header reading has a five-second timeout; and
- idle connections time out after 120 seconds.

There is no built-in TLS termination, rate limiting, or explicit HTTP write timeout. TLS and abuse protection are therefore expected from an ingress or reverse proxy.

The missing write timeout is plausibly intentional because streaming responses can be long-lived. A global write deadline can terminate a healthy Server-Sent Events stream. The cost is that slow or stuck writes must be controlled through request cancellation, proxy policy, and handler behavior instead.

### 27. Health and Readiness Mean Different Things

`/healthz` reports process liveness. It answers whether the HTTP process is alive enough to serve the probe.

`/readyz` combines an application-ready flag with a bounded SQLite ping. It answers a narrower question: has startup completed, has shutdown not begun, and can the local database respond?

Readiness does not prove that:

- OpenAI, Anthropic, NVIDIA, Tavily, or MCP endpoints are reachable;
- credentials are currently accepted;
- quota remains;
- the filesystem is writable rather than merely readable;
- workers or the coordinator are making forward progress; or
- an individual model configured in the bundle still exists.

This is a deliberate availability trade-off. Making readiness depend on every upstream would remove a runtime from service during transient external failures even when some requests could still succeed. Richer dependency status belongs in metrics or an administrative diagnostic surface, not necessarily in a binary readiness gate.

### 28. Serving Begins Only After Wiring and Recovery

The ready flag is set only after validation, storage initialization, deployment binding, orphan recovery, service construction, background-loop startup, route construction, and listener preparation have succeeded.

That sequencing protects callers from observing a half-built dependency graph. In particular, it ensures that the runtime/delegation setter cycle is closed and old durable state has been classified before new work arrives.

### 29. Shutdown Has Two Trigger Paths

The process waits for either:

1. operating-system cancellation, such as `SIGINT` or `SIGTERM`; or
2. an unexpected HTTP server error.

On the normal signal path it:

1. gives HTTP shutdown up to thirty seconds to drain active connections;
2. marks the application unready;
3. force-closes the server if graceful shutdown fails;
4. creates a fresh five-second cleanup context;
5. cancels the runtime's root context;
6. waits for the coordinator, bounded by the cleanup context;
7. stops all worker pools;
8. closes the event bus; and
9. closes SQLite.

A fresh cleanup context is important. The signal-derived application context is already canceled and therefore cannot grant cleanup any time of its own.

### 30. Shutdown Ordering Protects Dependency Lifetimes

Shutdown should proceed from callers toward dependencies:

```text
stop accepting HTTP work
  -> cancel orchestration
  -> stop workers
  -> close event delivery
  -> close persistence
```

Closing the database first would let still-running workers fail while attempting their final state transitions. Stopping ingress first prevents the process from continuously creating new work while trying to drain.

The runtime follows this general ownership order. The same principle will be central in the next chapter when Studio's composition root is compared with this one.

### 31. Confirmed Shutdown Limitations

The shutdown path is not fully bounded:

- `StopAll` waits for worker pools without receiving the five-second cleanup context;
- resource cleanup on an HTTP-server error uses a background context and can wait indefinitely;
- a second termination signal does not implement an immediate force-exit path; and
- memory-service background cleanup is canceled but not explicitly joined.

Any dependency or worker that ignores cancellation can therefore prevent process exit. A process supervisor can eventually send `SIGKILL`, but that is an external last resort rather than an application guarantee.

This distinction matters operationally: "graceful shutdown has a deadline" is not true merely because `http.Server.Shutdown` has one. Every awaited lifecycle participant must honor a bounded contract.

### 32. Runtime Logging and Correlation

The standalone process logs important lifecycle events, including:

- authentication mode selection;
- provider and tool construction;
- deployment identifier and configuration hash;
- recovery outcomes;
- listener startup;
- HTTP requests; and
- shutdown stages.

Request-ID middleware attaches an ID to request context, but the request-logging middleware uses its base logger directly rather than clearly enriching each record with the contextual ID. The ID is therefore useful to handlers that read it, but it is not guaranteed to appear in the general access log.

Provider registration also uses older `log.Printf` style output in places, while the application otherwise uses structured `slog`. Without an explicit structured handler setup, operators receive less consistent fields and correlation than the architecture appears to intend.

### 33. Missing Operational Signals

The runtime currently has no first-class metrics, distributed traces, profiling endpoint, or detailed administrative status endpoint.

Important unmeasured conditions include:

- queue depths;
- active and waiting workers;
- per-provider latency/error/rate-limit counts;
- tool-call outcomes;
- coordinator reconciliation lag;
- lease expiry and reclaim counts;
- checkpoint/resume counts;
- database busy time;
- stream duration and disconnects; and
- graceful-shutdown duration.

Logs can diagnose individual events, but they are a weak substitute for aggregate health and saturation signals. This is a production-readiness gap rather than a functional correctness failure.

### 34. The Executable Is a Single-Process Appliance

Several choices align around the same deployment model:

- one immutable bundle;
- one synthetic owner;
- one local SQLite database;
- filesystem-backed memory and scratchpads;
- one in-process event bus; and
- one bearer-token boundary.

These choices make the runtime easy to package and reason about as one instance. They do not support horizontal scaling by simply starting multiple replicas against the same data directory or database file.

Multiple processes would introduce unresolved ownership questions for worker pools, live streams, filesystem revisions, event delivery, leases, and local SQLite access. Horizontal scale would require a different shared persistence/event architecture or an explicit partitioning rule that assigns each deployment or thread to exactly one process.

### 35. Failure Boundaries

The runtime has several distinct failure classes:

| Failure point | Result |
| --- | --- |
| CLI or bundle parse failure | Process exits before composition. |
| Static hash/graph/config failure | Process exits before runtime-state initialization. |
| Provider/tool environment failure | Process exits before the data directory is intentionally initialized. |
| Memory/scratchpad prerequisite failure | Process exits after some local artifacts may have been created. |
| Migration failure | Process exits; transaction boundaries protect the individual migration step. |
| Deployment-identity mismatch | Process refuses to use foreign durable state. |
| Listener bind failure | Composed resources must be unwound; the process never becomes a usable server. |
| External provider failure during a request | The individual run follows provider/runtime failure and retry semantics. |
| Process crash during a run | Startup recovery marks the run interrupted or failed based on checkpoint evidence. |
| Process crash during async work | Durable reconciliation can reclaim eligible work; in-memory events are lost. |

This table is useful because "the runtime failed" is too coarse. Each phase has different persistence, retry, and operator consequences.

### 36. Delivery Guarantees Across the Boundary

The runtime can make strong claims about its local database transitions: compare-and-swap status changes, leases, fencing, checkpoints, and transactional migrations. It cannot unilaterally make the same claim about an external side effect.

Consider this sequence:

```text
1. runtime sends a payment-like HTTP mutation
2. remote service commits it
3. response is lost
4. runtime crashes before recording success
5. resumed run retries the call
```

From local state alone, steps 2 and 3 are indistinguishable from "the remote service never committed." Exactly-once behavior therefore requires cooperation from the external boundary, normally through a stable idempotency key and durable response lookup.

This is why the absence of Redis deduplication is relevant but not the whole problem: even a cache-based local suppression mechanism is not a replacement for destination-enforced idempotency.

### 37. Packaging Is Still an Unimplemented Deployment Layer

The repository contains the executable source and runtime contract, but no complete deployment packaging around it. There is no confirmed standalone:

- Dockerfile;
- Kubernetes manifest or Helm chart;
- systemd unit;
- build/release pipeline;
- image metadata contract;
- volume/backup procedure;
- secret-injection recipe;
- ingress/TLS policy; or
- upgrade/rollback runbook.

A production image must at minimum include the compiled runtime and the `rg` dependency, run as a non-root user, expose its listen port, mount a writable persistent data directory, receive secrets without embedding them in the image, and connect liveness/readiness probes to the documented endpoints.

Those artifacts belong to the not-yet-complete infrastructure deployment layer, not to the executable's internal composition code.

### 38. Upgrade and Rollback Implications

The migration runner supports forward schema evolution and rejects unknown future schemas. That protects compatibility, but it does not automatically make rollback safe.

If a newer binary applies a migration that an older binary cannot understand, replacing it with the older binary will fail because the database version is now newer than that executable. A responsible release process therefore needs:

- migration compatibility notes;
- backup/restore policy;
- a decision about backward-compatible versus irreversible migrations;
- versioned images; and
- rollback instructions that account for durable state, not only executable replacement.

The immutable bundle hash helps identify application configuration. The bundle itself does not currently carry a complete executable/image revision, so runtime binary provenance must be supplied by packaging metadata and logs.

### 39. Security Boundary Summary

The standalone runtime has a smaller attack surface than Studio because it omits mutable administrative routes. Its main trust boundaries are:

- callers crossing the HTTP authentication boundary;
- bundle bytes crossing the deployment-artifact boundary;
- environment variables supplying secrets;
- tools making outbound HTTP/MCP/search calls;
- providers sending prompts and receiving model output;
- the local filesystem and SQLite database holding user/run state; and
- the reverse proxy or orchestrator supplying TLS, network isolation, and abuse controls.

The `none` authentication mode intentionally moves responsibility outward. If no trusted ingress exists, using it exposes every runtime thread and run operation to the reachable network.

### 40. What Is Well Designed

The strongest properties of the standalone layer are:

1. **Immutable input:** runtime behavior begins from a verified content-addressed bundle.
2. **Narrow API:** deployed execution is separated from mutable authoring operations.
3. **State binding:** a data directory cannot silently switch to a different deployment.
4. **Durable recovery:** orphaned synchronous and asynchronous work has explicit restart behavior.
5. **Explicit composition:** concrete dependencies and ownership are visible in one root.
6. **Startup gating:** requests arrive only after validation, recovery, and wiring finish.
7. **Graceful HTTP drain:** normal termination stops ingress before closing dependencies.
8. **Repository reuse through ports:** bundle and SQLite adapters satisfy the engine's existing interfaces instead of forking the execution engine.

### 41. Principal Gaps and Risks

The main concerns are:

1. **No packaging/reconciler:** source code exists, but a selected revision is not turned into a managed production workload.
2. **Partially unbounded shutdown:** some workers or cleanup paths can prevent exit.
3. **Weak observability:** no metrics, tracing, saturation reporting, or rich dependency status.
4. **No distributed scaling model:** SQLite, filesystem state, and the in-process bus assume one process.
5. **Limited authentication:** one shared token and synthetic identity provide no caller-level authorization or audit attribution.
6. **External side-effect replay:** retry/resume can repeat mutations without integration-level idempotency.
7. **Implicit binary dependency:** `rg` is required even when the deployed graph does not visibly use memory tools.
8. **Configuration rigidity:** important capacity and timeout values require recompilation to change.
9. **Partial failed-start artifacts:** later startup validation may leave an initialized data directory.
10. **Inconsistent correlation:** request IDs and structured logs are not fully connected.

### 42. Test Evidence

Repository tests cover important pieces of the runtime contract, including:

- bearer authentication behavior;
- reopening persisted conversation history;
- supervisor/researcher/MCP/scratchpad execution paths;
- validation before data-directory mutation for provider-related failures;
- waiting for workers and marking interrupted work during shutdown;
- SQLite migrations;
- deployment-identity binding, including concurrent binding;
- orphan-run recovery; and
- resuming asynchronous work after reopening state.

The tests were inspected as design evidence for this chapter; they were not executed during the documentation-only investigation.

Notable missing or underrepresented end-to-end tests include:

- CLI usage and exit-code behavior;
- real OS-signal handling;
- listener-bind failure cleanup;
- probes against a fully started real server;
- forced shutdown with a stuck dependency;
- second-signal behavior;
- invalid `RG_PATH` and partial initialization artifacts;
- oversized bundle or request limits at the executable boundary;
- multi-process misuse; and
- metrics/tracing, which do not yet exist to test.

### 43. Source Map

| Concern | Primary source |
| --- | --- |
| CLI commands and exit behavior | `backend/runtime/main.go` |
| Application startup, composition, serving, and shutdown | `backend/runtime/app.go` |
| Runtime middleware and routes | `backend/runtime/http.go` and runtime handler wiring |
| Bundle parsing, validation, and hashing | `backend/deployment/bundle.go` |
| Bundle-backed agent reader | `backend/deployment/reader.go` |
| SQLite opening and migrations | `backend/repo/sqliterepo` |
| Deployment/data-directory identity | `backend/repo/sqliterepo/deployment_identity_repo.go` |
| SQLite run/job/checkpoint persistence | corresponding repositories under `backend/repo/sqliterepo` |
| Agent execution and resume | `backend/runtime/agent_runtime.go` and related runtime services |
| Worker pools and async reconciliation | `backend/dispatcher` and async coordination packages |
| Memory and scratchpad startup | `backend/memory` and `backend/scratchpad` |
| Provider and tool construction | provider/tool registries used by `backend/runtime/app.go` |
| Behavioral evidence | runtime, deployment, and SQLite `*_test.go` files |

### 44. End-to-End Mental Model

The whole layer can be summarized as:

```text
immutable bundle + secrets + local data directory
                    |
                    v
       validate identity and prerequisites
                    |
                    v
         migrate and bind durable state
                    |
                    v
      recover interrupted durable workflows
                    |
                    v
       compose one in-process execution system
                    |
                    v
 expose a narrow authenticated root-agent API
                    |
                    v
 on shutdown: stop ingress -> cancel work -> close state
```

The bundle answers **what should run**. The environment answers **which external credentials and endpoints this instance may use**. The data directory answers **what this exact deployment has already done**. The composition root connects those three worlds.

### 45. Chapter Summary

The standalone runtime is AgentFlow's execution-plane executable for one immutable deployment bundle. It verifies the bundle and environment, binds a local SQLite/filesystem state directory to the deployment identity, recovers interrupted workflows, adapts the bundle to the engine's agent-reading interfaces, manually composes providers, tools, memory, worker pools, asynchronous coordination, and HTTP handlers, and exposes a narrow root-agent API. Its persistence and restart behavior are considerably stronger than a stateless demo server, and its control-plane separation is clean. Its current operating model is nevertheless intentionally limited: one process, one bundle, one synthetic user, one local database, one process-local bus, shared bearer authentication, and no infrastructure reconciler or packaging layer. The next architectural question is therefore not merely which constructors are called, but who owns each process resource, which startup and shutdown guarantees are actually shared with Studio, and where duplicated composition can drift.

## Chapter 12: Composition and Lifecycle

### 1. Composition and Lifecycle Are Related but Different

**Composition** answers:

- Which concrete implementation satisfies each interface?
- In what order are objects constructed?
- Which configuration values are passed into them?
- Where are architectural cycles resolved?

**Lifecycle** answers:

- Who opens each resource?
- When does it become usable?
- Which context owns its background work?
- Who asks it to stop?
- Who waits until it has stopped?
- Who closes the dependencies it uses?
- What happens if construction fails halfway through?

A composition root is therefore more than a collection of constructors. It is the process-level owner of the running application.

The repository has two composition roots:

- Studio in `backend/main.go`; and
- the standalone deployment runtime in `backend/runtime/app.go` and `backend/runtime/main.go`.

They assemble nearly the same execution subsystem but provide substantially different lifecycle guarantees.

### 2. A Useful Mental Model

Think of composition as building and wiring a machine:

```text
persistence
  -> repositories
  -> application services
  -> execution engine
  -> handlers
  -> HTTP server
```

Lifecycle is the operating procedure attached to that machine:

```text
validate
  -> construct
  -> initialize
  -> start
  -> become ready
  -> serve
  -> stop intake
  -> drain
  -> cancel remaining work
  -> join goroutines
  -> close dependencies
```

Construction without lifecycle ownership is incomplete. A component that can start a goroutine, open a connection, or accept work creates an obligation for somebody else to stop or close it.

### 3. Why the Composition Root Belongs at the Process Boundary

Inner packages should express domain or application behavior without deciding how the entire program exits. The outer process boundary knows:

- command-line arguments and environment;
- which database implementation is used;
- which authentication mode applies;
- which routes are exposed;
- which resources were successfully opened;
- which background loops were started; and
- whether termination is normal, startup failure, or runtime failure.

That makes the process root the natural owner of startup and shutdown policy.

When a database package calls `log.Fatal`, or an authentication helper calls `os.Exit`, that inner package bypasses the owner. It prevents the composition root from unwinding resources, classifying the failure, testing the behavior, or choosing a different policy.

### 4. Studio Startup Sequence

The Studio process currently starts in this order:

```text
load .env
  -> create signal-cancelled app context
  -> create router and public root/health handlers
  -> obtain MongoDB collection handles
  -> construct user and memory repositories
  -> ensure memory indexes
  -> initialize memory filesystem and rg dependency
  -> start memory cleanup worker
  -> initialize scratchpad filesystem and rg dependency
  -> obtain optional Redis client
  -> register tools and available LLM providers
  -> construct remaining MongoDB repositories
  -> ensure run/job/task/thread/deployment indexes
  -> load platform.xml
  -> construct context builder and publisher
  -> construct agent runtime and supporting services
  -> construct in-process bus, pools, delegation, and coordinator
  -> start coordinator
  -> select DirectDispatcher or BusDispatcher
  -> construct handlers and protected routes
  -> construct HTTP server
  -> start shutdown goroutine
  -> call ListenAndServe
```

This ordering is directly visible in `backend/main.go`.

### 5. Studio Performs Persistent Work Before All Configuration Is Valid

Studio loads `platform.xml` after it has already:

- connected to MongoDB;
- dropped or created some indexes;
- created memory and scratchpad directories;
- resolved the `rg` executable;
- attempted Redis connectivity; and
- registered providers and tools.

An invalid platform file can therefore terminate startup after persistent side effects have occurred.

The operations are mostly repeatable, so restart usually converges. Nevertheless, Studio startup is not an all-or-nothing transaction. A more deliberate order would validate deterministic local configuration before opening external resources or mutating database metadata.

### 6. The Standalone Startup Sequence

The standalone root follows a different order:

```text
parse command
  -> load and verify immutable bundle
  -> validate authentication
  -> validate bundle environment/providers/tools
  -> create data directory
  -> open and migrate SQLite
  -> bind state to deployment identity
  -> recover orphaned runs
  -> initialize memory and scratchpad
  -> construct execution subsystem
  -> start tracked coordinator
  -> construct routes and server
  -> set ready
  -> serve
```

Most deterministic deployment validation therefore occurs before the first intended filesystem mutation. Chapter 11 records the narrower exception: memory and scratchpad startup checks occur after SQLite and the data directory exist.

### 7. Manual Dependency Injection

Both roots use explicit constructor calls rather than a DI framework.

That is appropriate for this codebase because it provides:

- compile-time dependency checking;
- visible concrete implementations;
- explicit construction order;
- straightforward debugging; and
- no reflection-driven runtime failure mode.

The problem is not manual injection. The problem is that Studio's `main()` combines manual injection with environment parsing, index management, goroutine startup, route registration, signal handling, and fatal process exits in one function.

### 8. The Shared Execution Subsystem

Both roots construct essentially this graph:

```text
agent reader
thread/message/run repositories
job/task repositories
memory and scratchpad services
LLM and tool registries
           |
           v
ContextBuilder
           |
           v
AgentRuntime + Summarizer
           |
           v
InProcBus + JobHub + RunPreparer
           |
           v
PoolManager
           |
           v
BusDelegateInvoker
           |
           +---- installed back into AgentRuntime
           |
           v
JobCoordinator + Dispatcher
           |
           v
HTTP handlers
```

The persistence adapters and public transport differ, but the middle execution graph is duplicated almost line for line.

### 9. The Runtime/Delegation Construction Cycle

The execution graph contains a real circular dependency:

```text
AgentRuntime
  -> DelegateInvoker
  -> PoolManager
  -> AgentRuntime
```

The code resolves it through two-phase initialization:

1. construct `AgentRuntime` without a delegate invoker;
2. construct `PoolManager`, which references the runtime;
3. construct `BusDelegateInvoker`, which references the pools; and
4. call `agentRuntime.SetDelegateInvoker(invoker)` before serving.

This is safe while the partially initialized runtime cannot escape to concurrent callers. Both roots currently complete the setter before the HTTP server starts.

The setter order is nevertheless a maintenance hazard. A future composition root can compile while forgetting it, and delegated agents then fail only at runtime.

### 10. `WithCheckpointStore` Adds Another Ordering Constraint

`AgentRuntime.WithCheckpointStore` returns a new runtime value rather than modifying the receiver. It copies all fields that were already installed.

Studio therefore calls:

```text
NewAgentRuntime
  -> WithCheckpointStore
  -> SetMCPManager
  -> SetAsyncJobStore
  -> later SetDelegateInvoker
```

Installing the MCP manager before `WithCheckpointStore` used to risk copying a stale nil field; the current source includes an explicit warning about the order.

This illustrates why duplicated manual wiring needs parity tests or a shared execution-stack builder. The individual constructors are valid, but their sequencing forms an undocumented protocol unless the root makes it explicit.

### 11. Intentional Differences Between Roots

| Concern | Studio | Standalone |
| --- | --- | --- |
| Agent source | Mutable, owner-scoped MongoDB repository | Immutable bundle-backed reader |
| Durable state | MongoDB | Local SQLite |
| Memory roots | Environment or shared temporary defaults | Paths below deployment data directory |
| Platform prompt | External XML file | XML frozen into bundle |
| Redis | Optional deduplication client | Not used |
| Authentication | Per-user JWT | Shared deployment bearer or `none` |
| Public surface | Authoring, publication, and execution | Execution only |
| Top-level dispatcher | Direct by default; bus opt-in | Bus only |
| Orphan recovery | No Studio cold-start recovery | Runs before serving |
| Readiness | No distinct readiness state | Atomic flag plus SQLite ping |

These are product and deployment differences, not necessarily duplication problems. A shared abstraction should preserve them rather than hide them behind dozens of optional fields.

### 12. Configuration Sources in Studio

Studio configuration is distributed across packages:

| Setting | Read by |
| --- | --- |
| `.env` | `main` via `godotenv.Load` |
| `MONGO_URL` | MongoDB package |
| `REDIS_URL` | Redis package |
| `JWT_SECRET` | JWT package, lazily |
| provider API keys | LLM registry |
| `TAVILY_API_KEY` | tool registry |
| `MEMORY_ROOT`, `RG_PATH` | memory package |
| `SCRATCHPAD_ROOT`, `RG_PATH` | scratchpad package |
| `PLATFORM_XML_PATH` | `main` |
| `MESSAGEBUS_DISPATCH` | `main` |
| `PORT` | `main` |

There is no single validated `Config` describing the process's effective settings.

### 13. Why Scattered Environment Reads Matter

Environment reads deep inside constructors make it harder to answer:

- Which variables are required?
- Which values use defaults?
- Which values are secrets?
- Which failures occur at startup versus first use?
- What exact configuration should a test inject?
- Can two application instances with different settings exist in one process?

Explicit configuration does not mean putting secrets into logs. It means the outer boundary reads and validates them, then passes only the values each component requires.

### 14. The Current Working Directory Is an Implicit Input

Studio loads `.env` from the working directory and defaults the platform path to `platform.xml`.

The same binary can therefore behave differently depending on where it is launched. A service manager, container image, IDE, and shell may each choose a different working directory.

A production contract should supply an explicit platform path or package the file at a known absolute location. The presence of a local `.env` should remain a development convenience rather than an invisible production dependency.

### 15. Provider Availability Is Intentionally Optional in Studio

The LLM registry registers only providers whose API-key variables exist. Studio can start with zero providers.

This is reasonable for an authoring control plane because:

- agents can be created before every provider is configured;
- available models can vary by environment; and
- a missing provider should make the affected operation fail rather than necessarily make the whole UI unavailable.

The standalone runtime has a stricter rule: every provider required by its immutable bundle must be available before the instance becomes ready.

### 16. JWT Configuration Is Validated Too Late

`JWT_SECRET` is not checked during Studio construction. The JWT package reads it when generating or validating a token and calls `log.Fatal` if it is missing.

The resulting sequence can be:

```text
process starts
  -> /health returns 200
  -> first login or authenticated request reaches JWT code
  -> missing JWT_SECRET triggers log.Fatal
  -> entire process exits immediately
```

This is both a lifecycle and availability problem. Request handling should never discover a required process secret by terminating the process. Startup should validate the secret, and JWT operations should return ordinary errors.

### 17. MongoDB Connection Ownership

The MongoDB package stores a process-global client behind `sync.Once`. Every `GetCollection` call indirectly invokes the same connection function.

The first connection:

1. reads `MONGO_URL` or defaults to localhost;
2. creates a fifteen-second ping context;
3. calls `mongo.Connect`;
4. pings the server; and
5. stores the client globally.

Connection or ping failure calls `log.Fatalf` rather than returning an error.

Studio never calls `Disconnect`. The operating system closes sockets when the process terminates, but application-level ownership remains incomplete.

### 18. Redis Ownership and Failure Policy

Redis is also held behind `sync.Once`.

Its failure policy differs from MongoDB:

- an invalid URL logs a warning and returns nil;
- a failed ping logs a warning and returns nil;
- the tool registry then disables Redis-backed deduplication;
- the process continues serving.

This graceful degradation is reasonable because Redis is an optimization here, not the authoritative job database.

The lifecycle limitations are:

- the successfully connected client is never closed;
- the client created before a failed ping is not explicitly closed; and
- `sync.Once` means a transient startup failure cannot recover later in the same process.

### 19. Filesystem Service Ownership

Studio defaults memory and scratchpad roots to paths under the operating-system temporary directory when their environment variables are absent.

Their startup validation creates directories and resolves `rg`. Therefore they are stateful resources, even though they do not expose a `Close` method.

The defaults create an additional deployment assumption: separate Studio processes on the same host can point at the same roots. Scratchpad locking is process-local, and the memory filesystem/database projection also assumes coherent ownership. Multi-process sharing is not an explicitly supported composition.

### 20. MongoDB Index Initialization

Studio invokes repository-specific `EnsureIndexes` methods for:

- memory metadata;
- memory revisions;
- runs and checkpoints;
- jobs and job locks;
- task budgets;
- subthreads;
- deployment revisions; and
- versioned deployment state and its due-work index.

These are runtime correctness structures, not only performance indexes. Several enforce uniqueness or lease/query invariants.

### 21. Index Initialization Is Not a Versioned Migration

Each MongoDB repository independently ensures its current indexes. There is no central schema version or ordered migration history comparable to standalone SQLite.

Consequences include:

- earlier index changes remain when a later step fails;
- destructive legacy-index removal and replacement can be partially applied;
- multiple replicas may perform the same startup changes concurrently;
- data backfills have no central migration owner; and
- operators cannot inspect a single recorded schema version.

MongoDB index creation is generally idempotent, so the approach is practical for early development. It becomes riskier as deployments, replicas, and destructive migrations grow.

### 22. Startup Database Operations Have No Overall Deadline

The initial MongoDB ping has a fifteen-second context. Subsequent `EnsureIndexes` calls use `context.Background()`.

If the database accepts a connection but an index operation stalls, Studio startup can wait indefinitely. A supervisor can eventually kill the process, but the application provides no bounded startup contract for those operations.

Each startup phase that crosses a network boundary should receive an explicit deadline derived from a startup context.

### 23. Resource Ownership Comparison

| Resource | Studio | Standalone |
| --- | --- | --- |
| Database | Global MongoDB client; not disconnected | `runtimeApp.db`; explicitly closed |
| Redis | Global optional client; not closed | Not used |
| Bus | Local variable; deferred and explicitly closed | `runtimeApp.bus`; guarded by `sync.Once` cleanup |
| Pools | Local variable; stopped after `ListenAndServe` | `runtimeApp.pools`; stopped during cleanup |
| Runtime cancellation | Signal-derived `appCtx` | Explicit `cancelRuntime` owned by app |
| Coordinator | Fire-and-forget `Start` | Wrapped `Run` with completion channel |
| Memory cleanup | Context-cancelled, not joined | Context-cancelled, not joined |
| HTTP server | Local variable | `runtimeApp.server` |
| Ready state | None | Atomic flag |

The standalone root is not perfect, but it makes ownership inspectable in one object.

### 24. Process-Lifetime Goroutine: Memory Cleanup

`StartCleanupWorker` launches a ticker goroutine. It exits when its context is canceled.

The current cleanup body is a no-op because versioned memories deliberately retain immutable revision files. Nevertheless, the lifecycle contract matters:

- both roots cancel it through their root context;
- neither receives a completion channel;
- neither can prove it exited before dependent resources close.

Today the body does not access persistence, so the practical risk is low. If cleanup later performs database or filesystem operations, the missing join becomes significant.

### 25. Process-Lifetime Goroutine: Job Coordinator

`JobCoordinator.Start(ctx)` performs `go c.Run(ctx)` and returns no handle.

Studio uses `Start`, so it can cancel the coordinator but cannot join it.

Standalone starts `Run` itself:

```text
create coordinatorDone channel
  -> goroutine runs coordinator.Run
  -> defer close(coordinatorDone)
```

Cleanup can therefore wait until the coordinator has left its current tick or until the cleanup context expires.

### 26. Worker-Pool Ownership

Pools are created lazily per agent. Each pool:

- derives a cancelable context from the process runtime context;
- subscribes to the agent dispatch topic;
- starts a configured number of workers;
- tracks workers with a `WaitGroup`; and
- stops by canceling, unsubscribing, and waiting.

This is stronger lifecycle design than the fire-and-forget coordinator.

The limitation is that `PoolManager.StopAll` accepts no context. If a worker is blocked in a provider or tool that ignores cancellation, process shutdown can wait forever.

### 27. Per-Run Supporting Goroutines

Worker execution can create:

- stream-event forwarders;
- cancellation watchers; and
- async lease-heartbeat goroutines.

These are tied to a run or pool context and have local completion handling. The lease heartbeat cleanup waits no more than one second for its goroutine after cancellation.

HTTP message and resume handlers also start a dispatch goroutine, but their stream loop waits for the dispatch result before the handler returns. Those goroutines are request-owned rather than intentionally detached background work.

### 28. Background Summarization

Context compaction can start a background summarization goroutine.

It uses:

- the `RunPreparer` background context; and
- an additional thirty-second timeout.

Studio passes `appCtx`; standalone passes its runtime context. Cancellation therefore reaches summarization during process shutdown.

The goroutine is not tracked by a process-level wait group. The timeout bounds cooperative external work, but shutdown cannot formally join it before closing persistence.

### 29. Studio Context Tree

Studio's context ownership is approximately:

```text
signal.NotifyContext
  `-- appCtx
      |-- memory cleanup
      |-- job coordinator
      |-- RunPreparer background summarization
      `-- PoolManager
          `-- AgentPool workers and supporting goroutines

HTTP request context
  `-- top-level DirectDispatcher execution by default
```

The default top-level run is not rooted in `appCtx`; it is rooted in the HTTP request. Delegated children execute in pools that are rooted in `appCtx`.

### 30. Standalone Context Tree

Standalone creates a runtime context that is not canceled merely because a termination signal has arrived:

```text
runtime command context
  `-- application runtime context
      |-- memory cleanup
      |-- tracked coordinator
      |-- RunPreparer background summarization
      `-- PoolManager and workers

HTTP request context
  `-- BusDispatcher request
      `-- pool execution bounded by runtime context
```

The command first asks HTTP to drain. It cancels the runtime context during resource cleanup after the drain completes or is forced closed.

### 31. Direct and Bus Dispatchers Have Different Shutdown Behavior

Studio defaults to `DirectDispatcher` unless `MESSAGEBUS_DISPATCH` equals the exact string `true`.

#### Direct mode

The top-level runtime executes inside the request goroutine's context. Signal cancellation of `appCtx` does not directly cancel that top-level call. Delegated children do depend on pools rooted in `appCtx`, so they begin canceling.

#### Bus mode

The top-level dispatch is placed into an agent pool. Its worker context is rooted in `appCtx`. A process signal therefore cancels the top-level worker immediately.

The two modes consequently implement different shutdown policies even though they expose the same HTTP behavior.

### 32. Intended Studio Shutdown

The comment in `main.go` describes a thirty-second graceful-shutdown window intended to cover in-flight SSE streams.

The apparent intended sequence is:

```text
signal
  -> stop accepting new connections
  -> wait up to 30 seconds for active HTTP handlers
  -> stop pools
  -> close bus
  -> exit
```

The implemented control flow does not guarantee that sequence.

### 33. Actual Studio Shutdown Control Flow

When `SIGINT` or `SIGTERM` arrives:

1. `signal.NotifyContext` cancels `appCtx` immediately.
2. Coordinator, memory worker, background summarization, and pool-rooted work observe cancellation.
3. A shutdown goroutine calls `server.Shutdown` with a thirty-second context.
4. `Shutdown` closes the listener.
5. `ListenAndServe` returns `http.ErrServerClosed` as the listener closes.
6. The main goroutine calls `pools.StopAll`.
7. The main goroutine closes the bus.
8. `main` returns.

There is no completion channel or wait group connecting the shutdown goroutine back to `main`.

### 34. Why the Thirty-Second Studio Drain Is Not Guaranteed

`http.Server.Shutdown` waits for active handlers, but `ListenAndServe` returns as soon as shutdown closes the listener. These are separate goroutines.

The main goroutine can therefore proceed to pool cleanup and return while the shutdown goroutine is still waiting for active handlers.

Returning from `main` terminates the process regardless of other goroutines. The presence of a thirty-second context inside the shutdown goroutine does not force the main goroutine to wait for it.

This is the key distinction:

```text
starting a bounded wait != joining the goroutine that performs the wait
```

### 35. Consequences in Direct Mode

In default direct mode, a top-level SSE run is owned by the HTTP request context rather than the pool manager.

On a signal:

- `appCtx` cancellation does not directly stop the top-level run;
- `server.Shutdown` tries to wait for the handler;
- `ListenAndServe` returns immediately after listener closure;
- empty or quickly stopped pools allow `main` to return; and
- the process can terminate while the direct run still executes.

That can prevent final checkpoint, status, or message persistence. MongoDB has no corresponding cold-start orphan-run recovery in Studio, so a row can remain `running` after restart.

### 36. Consequences in Bus Mode

In bus mode, the top-level run belongs to a pool rooted in `appCtx`.

Signal cancellation reaches the worker, and `pools.StopAll` waits for worker loops. This is more deterministic, but it implements immediate cancellation rather than a true work-completion drain.

The HTTP server may still be draining the handler while the underlying worker is already being canceled. The thirty-second HTTP deadline therefore describes connection handling, not a uniform thirty-second business-work grace period.

### 37. Standalone Shutdown Control Flow

The standalone command waits for either a signal or server failure. On a signal it synchronously calls `app.Shutdown`:

```text
set ready=false
  -> server.Shutdown with caller's 30-second context
  -> server.Close if graceful drain fails
  -> create fresh 5-second cleanup context
  -> cancel runtime work
  -> wait for coordinator or cleanup deadline
  -> stop and join pools
  -> close bus
  -> close SQLite
```

The command does not return until `Shutdown` returns. This gives the HTTP drain an actual owner and preserves dependency ordering.

### 38. Why a Fresh Cleanup Context Is Required

The context used to detect termination is already canceled. Passing it to cleanup would make every cleanup operation fail immediately.

Standalone therefore creates a new context for resource shutdown. This is a general lifecycle rule:

> Cancellation announces that normal work must stop; cleanup needs its own bounded opportunity to finish.

Studio also creates a fresh HTTP shutdown context, but it loses the guarantee by not joining the goroutine that uses it.

### 39. Standalone Shutdown Gaps

Standalone's lifecycle is stronger, but not completely bounded:

- `PoolManager.StopAll` has no context;
- the memory worker is canceled but not joined;
- startup failure cleanup uses `context.Background`;
- server-error cleanup can therefore wait indefinitely;
- a second signal is not treated as an immediate force-exit request.

If a provider or tool ignores cancellation, the external process supervisor remains the final enforcement mechanism.

### 40. Startup Failure in Studio

Studio handles many startup failures with `os.Exit(1)` or `log.Fatal`.

Go does not run deferred functions when `os.Exit` is called. Consequently:

- deferred signal cleanup is skipped;
- a registered bus close defer is skipped on later fatal failures;
- no application-level MongoDB or Redis cleanup occurs;
- partially created directories and indexes remain; and
- listener-bind failure exits without orderly runtime cleanup.

The operating system reclaims memory and file descriptors, but it cannot perform application-specific final state transitions.

### 41. The Safer `run() error` or `run() int` Pattern

The standalone executable uses:

```text
main
  -> call run
  -> run owns resources and returns after cleanup
  -> main converts result to process exit code
```

Calling `os.Exit` at the final boundary is safe because inner scopes have already returned and executed their defers.

Studio would benefit from the same structure:

```go
func main() {
    if err := run(); err != nil {
        slog.Error("studio stopped", "error", err)
        os.Exit(1)
    }
}
```

All construction helpers would return errors instead of terminating the process themselves.

### 42. Listener Binding Happens After Background Work Starts

Both roots construct and start background coordination before `ListenAndServe` attempts to bind the network address.

If the port is already occupied:

- the coordinator has already started;
- the bus and pools already exist;
- persistence has already initialized; and
- Studio exits fatally while standalone unwinds resources.

A stronger sequence would call `net.Listen` before starting background loops, then pass the bound listener to `server.Serve`. Binding becomes an explicit startup phase that can fail before the application announces readiness.

### 43. Health and Readiness in Studio

Studio exposes `/health`, which returns `200` without checking dependencies or lifecycle state.

Because the server starts only after construction succeeds, a reachable health endpoint proves that startup reached the serving phase. It does not prove that:

- MongoDB still responds;
- filesystem storage is writable;
- the coordinator is progressing;
- provider calls can succeed; or
- the process is not beginning shutdown.

There is no readiness flag that can be set false before draining.

### 44. Health and Readiness in Standalone

Standalone separates:

- liveness: the process can answer HTTP; and
- readiness: startup completed, shutdown has not begun, and SQLite answers a one-second ping.

The readiness flag is cleared before HTTP shutdown. An orchestrator can therefore stop routing new traffic while existing connections drain.

External LLM and tool services are deliberately not hard readiness dependencies. Their status should be exposed through metrics or diagnostics rather than making every transient upstream outage remove the entire runtime from service.

### 45. Message-Bus Closure

The in-process bus uses an atomic closed flag and closes subscriber `done` channels. Closing it wakes subscriptions and prevents new publication.

Studio calls `Close` explicitly after `StopAll` and also has a deferred `Close`. The second call returns `ErrBusClosed`, which is ignored. This is harmless during normal return but shows that ownership is duplicated.

Standalone uses `sync.Once` around aggregate resource cleanup, giving the entire close sequence idempotent ownership.

### 46. Persistence Must Close Last

Workers and coordinators can perform final status, checkpoint, job, lease, and message writes while unwinding.

The safe dependency order is:

```text
stop ingress
  -> drain or cancel orchestration
  -> wait for workers
  -> close event delivery
  -> close persistence
```

Closing persistence before joining workers converts graceful cancellation into secondary database errors and can lose terminal state.

Standalone follows this general order. Studio never explicitly closes MongoDB, but process return can still terminate request-owned work before it has finished writing.

### 47. Orphan Recovery Is a Lifecycle Concern

Crash recovery is the other half of shutdown design. No shutdown implementation can handle `SIGKILL`, machine loss, out-of-memory termination, or power failure.

Standalone handles the next-start consequence by classifying `running` rows:

- checkpoint present -> `interrupted`;
- no checkpoint -> `failed`.

Studio does not run an equivalent MongoDB recovery pass. Async jobs have lease-based reconciliation, but ordinary top-level runs can remain stale after process loss.

Lifecycle correctness therefore requires both:

1. best-effort orderly shutdown; and
2. startup repair for cases where orderly shutdown never happened.

### 48. Multi-Replica Studio Implications

MongoDB job locks and leases contain mechanisms for more than one coordinator. Other parts of the process composition remain replica-local:

- the message bus is in-process;
- worker pools are in-process;
- direct top-level execution belongs to one HTTP connection;
- memory and scratchpad default to local temporary files;
- Redis initialization is process-local; and
- startup index management has no explicit distributed migration owner.

A load balancer can run multiple Studio HTTP replicas, but that does not make every live execution concern distributed. Sticky routing, shared filesystem strategy, external messaging, migration leadership, and orphan recovery require explicit decisions.

### 49. Duplicated Wiring and Drift Risk

The shared execution stack is manually assembled in both roots. This creates risks such as:

- adding a new repository to one root but not the other;
- different runtime setter order;
- different worker or timeout defaults;
- different capability flags;
- starting a new background service without adding it to both shutdown paths; and
- testing one composition while the other silently drifts.

The duplication is now large enough to justify a focused shared abstraction, but not a full application factory.

### 50. Recommended Shared Boundary

A useful extracted component would represent the shared execution subsystem:

```text
ExecutionStack inputs
  - agent reader
  - repository ports
  - provider registry
  - tool registry
  - context builder dependencies
  - root context
  - worker/coordinator configuration

ExecutionStack outputs
  - dispatcher
  - runtime-facing handler dependencies
  - pools
  - coordinator completion
  - Close/Shutdown contract
```

Studio would still own MongoDB, Redis, JWT, publication routes, and mutable agent access. Standalone would still own SQLite, bundle identity, bearer authentication, and deployment routes.

This removes duplicated knowledge without erasing genuine deployment differences.

### 51. Why a Full DI Framework Is Not Recommended

A reflection container or large lifecycle framework could automate construction and cleanup, but it would add:

- runtime graph errors instead of compile-time errors;
- more indirection when reading startup;
- framework-specific lifecycle semantics;
- another dependency; and
- pressure to force intentionally different applications into one module graph.

Explicit Go constructors plus one small application owner and one shared execution-stack builder are sufficient for the current scale.

### 52. Recommended Studio Lifecycle Shape

A future Studio owner could hold:

```text
HTTP server and readiness state
MongoDB and optional Redis clients
execution stack
root cancellation function
background completion handles
close-once guard
```

Its startup would be:

```text
parse and validate typed configuration
  -> validate platform file and local prerequisites
  -> connect required infrastructure with deadlines
  -> perform controlled schema/index initialization
  -> construct repositories and services
  -> bind listener
  -> start background loops
  -> mark ready
  -> serve
```

Its shutdown would be:

```text
mark unready
  -> stop HTTP intake and drain active requests
  -> cancel remaining runtime work
  -> join coordinator, pools, cleanup, and summarization
  -> close bus
  -> close Redis
  -> disconnect MongoDB
```

### 53. Second-Signal Behavior

Neither executable implements a deliberate "first signal drains, second signal exits immediately" policy.

During a stuck shutdown, an operator may expect a second `Ctrl+C` or `SIGTERM` to force progress. Registered signal notification can instead consume or buffer it without triggering the operating system's default termination behavior.

A production process should document and implement one of:

- second signal forces exit;
- supervisor sends `SIGKILL` after a fixed grace period; or
- every shutdown participant is provably bounded and no second-signal path is needed.

The current code relies on the external supervisor for the final bound.

### 54. Observability of Lifecycle

Both roots log selected lifecycle events, but neither exports lifecycle metrics or traces.

Useful missing signals include:

- startup phase and duration;
- index/migration duration;
- readiness transitions;
- active HTTP handlers during drain;
- active worker pools and workers;
- coordinator tick duration and lag;
- cancellation counts by cause;
- shutdown phase and total duration;
- forced-close count; and
- resources that exceeded their cleanup deadline.

Without these signals, an operator can know that a process restarted but not reliably determine which lifecycle phase delayed or lost work.

### 55. Test Evidence

Standalone application tests verify:

- durable history survives close and reopen;
- realistic supervisor/researcher/MCP/scratchpad composition;
- provider validation precedes data-directory mutation; and
- shutdown waits for a blocked top-level worker to clean up and leaves the run interrupted.

Dispatcher tests verify pool idempotence, cancellation propagation, event draining, and important coordination races.

There is no production Studio composition test that starts its real `main` lifecycle and verifies signals, readiness, resource closure, listener failure, or request draining. Integration tests manually reconstruct subsets of routing and close their test MongoDB clients, so they do not exercise Studio's production ownership gaps.

Tests were inspected as design evidence for this chapter; they were not executed during the documentation-only investigation.

### 56. Confirmed Findings

**Confirmed by source:**

- Studio and standalone duplicate the central execution wiring.
- Studio uses package-global MongoDB and Redis clients.
- Studio never explicitly disconnects MongoDB or closes Redis.
- Studio starts its coordinator without a completion handle.
- Studio does not join its HTTP shutdown goroutine.
- Studio has no separate readiness state.
- Studio has no MongoDB orphan-run recovery call.
- a missing JWT secret can terminate Studio during request handling.
- Studio index initialization uses contexts without deadlines.
- standalone owns SQLite, bus, pools, runtime cancellation, readiness, and coordinator completion in `runtimeApp`.
- standalone performs its HTTP drain synchronously before canceling runtime resources.

### 57. Inferences and Unknowns

**Inferred from the confirmed control flow:**

- a direct-dispatch Studio run can be terminated before completing the intended HTTP drain;
- this can leave a MongoDB run in stale `running` state after process restart;
- an external supervisor is the only hard bound when pool shutdown or other cleanup ignores cancellation; and
- duplicated composition is likely to drift as the engine gains dependencies.

**Unknown from the repository:**

- whether immediate cancellation on Studio termination is an intentional product policy;
- which production process supervisor or orchestrator is expected;
- the configured external termination grace period;
- whether multi-replica Studio is currently a requirement; and
- whether local memory/scratchpad roots are replaced by shared storage in the intended deployment.

### 58. Source Map

| Concern | Primary source |
| --- | --- |
| Studio composition and HTTP lifecycle | `backend/main.go` |
| Standalone application owner | `backend/runtime/app.go` |
| Standalone command/signal lifecycle | `backend/runtime/main.go` |
| MongoDB singleton | `backend/db/mongo.go` |
| Redis singleton and degradation | `backend/db/redis.go` |
| SQLite ownership and migration | `backend/db/sqlite.go`, `backend/repo/sqliterepo/db.go` |
| Runtime two-phase wiring | `backend/agent/runtime.go` |
| Pool ownership and worker joining | `backend/dispatcher/pool_manager.go`, `agent_pool.go` |
| Coordinator start/run contract | `backend/dispatcher/job_coordinator.go` |
| Direct versus bus dispatch contexts | `backend/dispatcher/direct.go`, `bus_dispatcher.go` |
| Memory cleanup lifecycle | `backend/memory/cleaner.go` |
| Background summarization | `backend/dispatcher/preparer.go` |
| Memory/scratchpad environment startup | `backend/memory/service.go`, `backend/scratchpad/service.go` |
| Lazy JWT secret loading | `backend/auth/jwt.go` |
| Lifecycle evidence | `backend/runtime/app_test.go` and dispatcher tests |

### 59. Chapter Summary

AgentFlow uses clear, manual constructor injection and shares well-defined repository and service interfaces across two application roots. The actual composition graph is understandable, but lifecycle ownership is uneven. The standalone executable groups its server, database, bus, pools, cancellation, coordinator completion, readiness, and close-once behavior into `runtimeApp`; Studio leaves those responsibilities spread across `main`, global database helpers, fire-and-forget goroutines, and fatal exits. The most important confirmed defect is that Studio's thirty-second HTTP shutdown runs in an unjoined goroutine, so process return can precede completion of active direct-dispatch handlers. Combined with immediate `appCtx` cancellation, dispatcher-mode-dependent behavior, missing MongoDB orphan recovery, lazy fatal JWT configuration, unbounded index startup, and unclosed clients, this makes Studio lifecycle behavior less reliable than its comments imply. The simplest responsible evolution is an explicit Studio application owner, centralized typed configuration, error-returning infrastructure constructors, synchronous dependency-ordered shutdown, bounded and joinable background services, and a narrowly shared execution-stack builder rather than a general DI framework.

## Chapter 13: Verification and Risks

### 1. Why Verification Is Its Own Architectural Layer

The previous chapters explain what the backend is intended to do and how its components are connected. Verification asks a different question:

> What evidence demonstrates that those behaviors and guarantees are actually true?

This question cannot be answered merely by counting tests. A test proves only the scenario it constructs and the assertions it makes. A repository unit test cannot prove that the production executable wires the repository correctly. A process test cannot efficiently explore every malformed checkpoint. A benchmark cannot prove ownership isolation. Production confidence therefore comes from several complementary forms of evidence.

Verification also affects architecture. If an invariant is difficult to test without starting the entire system, the responsible boundary may be unclear or too tightly coupled. If two persistence adapters share a conformance suite, their common contract becomes explicit and reviewable. If a composition root cannot be exercised without real infrastructure, configuration and ownership are probably not isolated enough.

### 2. Verification, Validation, and Risk

These terms answer different questions:

- **Verification:** Did the implementation satisfy its specified contract?
- **Validation:** Is that contract the behavior the product and operators actually need?
- **Risk analysis:** Where can the system still fail, how severe would the consequence be, how likely is it, and how quickly would the failure be detected and recovered?

For example, a test can verify that an asynchronous job lease expires exactly as implemented. Product validation must still decide whether that lease duration is acceptable for real provider latency. Risk analysis asks what happens if a slow but healthy worker exceeds the lease and another worker reclaims the job.

### 3. The Verification Ladder

| Evidence type | Question answered | AgentFlow example |
| --- | --- | --- |
| Compile-time assertion | Do concrete types implement the intended ports? | MongoDB and SQLite repositories are asserted against agent, dispatcher, memory, and conformance interfaces. |
| Unit test | Does a small unit enforce a local rule? | Checkpoint validation, context rendering, authentication, and tool parsing. |
| Conformance test | Do multiple adapters obey one behavioral contract? | The same run, task, job, memory, thread, and message suites execute against MongoDB and SQLite. |
| Integration test | Do real components cooperate across a boundary? | HTTP handlers operate with real MongoDB repositories. |
| Component test | Does a substantial subsystem work through its public surface? | The standalone application composes SQLite, runtime, delegation, MCP, scratchpad, and HTTP handlers. |
| Process test | Does the actual binary start, listen, signal, drain, persist, and exit correctly? | This level is presently weak or absent. |
| Static analysis | Can suspicious constructs be found without executing the program? | No committed lint or security-analysis gate was found. |
| Race detection | Are shared in-process memory accesses synchronized? | Logical concurrency tests exist, but race-detector enforcement was not found. |
| Fuzzing | Do parsers and state validators survive unexpected input combinations? | No Go fuzz targets were found. |
| Benchmark/load evidence | Does the system meet a stated performance objective? | Four SQLite benchmarks exist without committed baselines or thresholds. |
| Operational evidence | Can production reveal, contain, and recover from failure? | Logs and health endpoints exist, but lifecycle metrics, traces, and failure drills are limited. |

No row replaces another. A unit test cannot prove signal handling. A process test cannot exhaustively explore corrupted compressed checkpoints. A race detector identifies unsafe memory access, not incorrect database compare-and-swap logic.

### 4. Current Test Inventory

Static repository inspection found:

- 79 Go `_test.go` files;
- 606 declarations beginning with `func Test`, including two `TestMain` entry points;
- 365 calls to `t.Parallel()`;
- four benchmarks;
- zero Go fuzz targets;
- zero executable example tests;
- thirty test uses of `time.Sleep` or `time.After`; and
- zero Go build tags separating test classes.

These numbers describe the suite's shape. They do not establish that the tests currently pass, that they are free from flakes, or that they are run before changes are released. No tests, builds, race checks, linters, benchmarks, or security scanners were executed during this documentation investigation.

### 5. Where the Test Density Is Concentrated

The largest bodies of behavioral evidence cover:

- agent runtime, context, checkpoints, tools, and delegation;
- HTTP handler behavior;
- MongoDB repositories;
- SQLite repositories and restart behavior;
- dispatcher pools, cancellation, leases, and coordinator races;
- versioned memory and scratchpad mutation protocols;
- deployment bundle validation and publication; and
- standalone runtime composition.

Packages with notably thinner or indirect evidence include:

- the Studio `main` composition root;
- database client constructors in `backend/db`;
- request-ID, body-limit, CORS, and production middleware assembly;
- OpenAI and Anthropic adapters;
- runtime CLI and real process signal behavior;
- Redis-backed tool deduplication; and
- the infrastructure reconciler and rollout behavior, which do not yet exist in the repository.

The absence of a directly named package test does not always mean the code is unused by tests. For example, atomic filesystem behavior is exercised through memory and scratchpad tests. It does mean failures must be interpreted through a larger test surface and that isolated edge cases may be missing.

### 6. Agent Runtime Evidence

The agent package has broad tests for:

- context construction and token-budget decisions;
- checkpoint serialization, compression, validation, and compatibility;
- fresh and resumed execution;
- effective toolset construction and drift detection;
- model/tool loop termination;
- deterministic transcript ordering after parallel tool execution;
- panic recovery;
- cancellation;
- synchronous delegation;
- asynchronous suspension and resume;
- summarization;
- MCP degradation; and
- scratchpad and memory context.

This is strong evidence for the state machine under the dependency behaviors represented by its fakes. It does not prove that real provider protocols, real network timeouts, production composition, or process termination behave the same way.

One important regression gap is already confirmed: runtime-level tests do not prove that `hasSnapshot` changes to true only after a checkpoint has actually been persisted. Direct tests of `trySaveCheckpoint` supply `hasSnapshot` as an input, so they do not catch the caller setting it after a tolerated but completely unsuccessful save.

### 7. Repository Conformance Is a Major Strength

`backend/repo/conformancetest/conformancetest.go` defines reusable behavioral suites for:

1. run/checkpoint stores;
2. task budgets;
3. asynchronous job dispatch and await behavior;
4. coordinator-side job transitions and leases;
5. worker-side job transitions and fencing;
6. memory metadata;
7. memory revisions;
8. threads; and
9. messages.

Both MongoDB and SQLite adapters run these suites. Both adapter packages also contain compile-time interface assertions.

This is more valuable than writing unrelated tests for each database. The conformance suite says:

> Every adapter presented through this port must preserve the same observable rules for the scenarios defined here.

Examples include single-winner status transitions, budget caps under concurrent consumption, mutation replay, ownership-scoped reads, lease fencing, concurrent sub-thread convergence, chronological message windows, and metadata round trips.

The limit is equally important: conformance proves only the contract encoded in the suite. It does not prove optimal indexes, production connection configuration, equivalent performance, availability under a database outage, or correctness of larger workflows spanning several repositories and filesystem state.

### 8. SQLite Restart and Recovery Evidence

The SQLite test suite contains meaningful close-discard-reopen scenarios rather than merely opening a second repository object over an unchanged connection. It demonstrates:

- schema migration and rollback behavior;
- checkpoint persistence across database close and reopen;
- interrupted execution resuming from durable state;
- synchronous delegation after reconstruction;
- queued required jobs surviving a restart;
- background jobs producing callbacks;
- cancellation before claim;
- reclaiming an expired starting lease; and
- standalone history surviving application close and reopen.

These are strong component-level proofs for the single-process standalone design. They still use fake LLM implementations and in-process coordination after restart, so they do not prove behavior across multiple live replicas or real provider ambiguity.

### 9. Handler and HTTP Evidence

Handler unit tests cover authentication, validation, ownership, response codes, serialization, publication, resume, persistence errors, and SSE event behavior.

The `backend/integration` package uses real MongoDB repositories behind an `httptest.Server`. It verifies routes for users, agents, threads, messages, runs, resume, LLM registry responses, SSE ordering, persistence, and synchronous delegation.

The file named `e2e_test.go` is end-to-end relative to the HTTP-handler-repository slice. It is not a full deployed-system test because:

- routes are reconstructed manually rather than created by production `main`;
- the runtime is stubbed or scripted;
- production middleware composition is not used;
- a real TCP process is not started;
- operating-system signals are not involved; and
- real LLM providers are not called.

This distinction prevents false confidence. A useful subsystem end-to-end test is not automatically a process or deployment end-to-end test.

### 10. Standalone Runtime Evidence

`backend/runtime/app_test.go` verifies substantial application behavior:

- durable history survives close and reopen;
- a supervisor delegates to a researcher;
- MCP and scratchpad tools participate in the workflow;
- deterministic validation precedes data-directory mutation; and
- shutdown waits for a blocked worker to clean up and leaves its run interrupted.

These tests exercise the constructed application's handler directly. They do not bind a real TCP socket or run the CLI process, so they do not verify listener failure, signal delivery, exit status, second-signal behavior, or container termination semantics.

### 11. External Test Dependencies

Two packages define `TestMain` functions that connect to MongoDB:

- `backend/integration` uses `HandlerTestDB`;
- `backend/repo/mongorepo` uses `TestDB`.

Both use `MONGO_TEST_URI` when present and otherwise default to `mongodb://localhost:27017`. Both drop their fixed database at the beginning and end of the test run. Neither is protected by an integration build tag.

This creates two separate concerns.

#### Reliability

A default `go test ./...` depends on a reachable MongoDB instance. Clean developer and CI environments may fail before the deterministic suite has provided useful feedback.

Memory, scratchpad, and standalone startup also depend on the `rg` executable. Search-specific tests sometimes skip when it is absent, while application startup validation treats its absence as fatal.

#### Safety

If `MONGO_TEST_URI` is accidentally pointed at an inappropriate cluster, the test process attempts to drop the fixed test databases. Their names reduce accidental collision risk but do not provide a strong isolation guarantee.

A safer invariant would require explicit integration-test opt-in, an approved disposable endpoint, and a unique per-run database name. An ephemeral MongoDB container would make ownership and cleanup clearer.

### 12. Timing and Flakiness

The suite contains thirty `time.Sleep` or `time.After` calls. Some are legitimate test deadlines that prevent a deadlock from hanging forever. Others use elapsed time to infer that concurrent work did or did not occur.

Wall-clock assertions can become flaky under CPU starvation, slow CI hosts, debugger pauses, or race-detector overhead. Prefer observable synchronization when possible:

- a channel closed at the precise lifecycle point;
- a barrier that releases known goroutines;
- a fake clock for lease advancement;
- an eventually assertion around durable state with a bounded deadline; or
- a completion handle owned by the component.

A timeout should remain as a safety bound, not serve as the primary proof that the event ordering was correct.

### 13. Logical Concurrency Versus the Race Detector

The suite includes valuable logical concurrency tests for:

- compare-and-swap status transitions;
- task-budget winners;
- deployment revision allocation;
- memory revision conflicts;
- scratchpad writes;
- pool creation;
- job locks and leases;
- cancellation; and
- parallel tool execution.

These tests answer whether the algorithm and persistence primitives produce the intended outcome.

The Go race detector answers a different question: whether goroutines access shared in-process memory without correct synchronization. No committed workflow or command configuration demonstrates regular `go test -race` execution.

Given the use of buses, pools, registries, event channels, caches, coordinator loops, runtime mutation, and goroutine-owned lifecycle state, race detection should be a required verification tier rather than an occasional manual check.

### 14. Static Analysis, Coverage, and Dependency Security

Repository inspection found no committed configuration or workflow for:

- `go vet` enforcement;
- `golangci-lint` or an equivalent lint suite;
- `govulncheck`;
- `gosec` or another security-oriented static analyzer;
- coverage collection or reporting; or
- dependency update automation.

This does not prove that no external service performs these checks. It means the repository itself does not declare them as reproducible project policy.

Coverage should be used as a map of unexercised behavior, not as a target that rewards executing trivial lines. Ninety-percent line coverage can still miss a single shutdown race, ownership bypass, replay boundary, or transaction failure that determines production correctness.

### 15. Fuzzing Opportunities

No Go fuzz targets were found. Useful candidates include:

- deployment bundle JSON and canonical hashing;
- unknown fields and trailing JSON;
- compressed checkpoint decoding;
- checkpoint phase and version validation;
- OpenAI and Anthropic response decoding;
- MCP JSON-RPC responses and remote schemas;
- HTTP handler request JSON;
- memory and scratchpad path segments;
- calculator expressions; and
- tool-call arguments.

Fuzzing is most useful where attacker-controlled or provider-controlled bytes cross a parser boundary. It complements hand-written examples by exploring combinations a reviewer would not anticipate.

### 16. Performance Evidence

Four SQLite benchmarks exist:

- message-window reads;
- checkpoint writes;
- memory visibility queries; and
- concurrent task-budget consumption.

They are useful starting points, but no committed baseline, `benchstat` comparison, regression threshold, target hardware description, or capacity objective was found. There are also no load tests for concurrent SSE streams, worker-pool saturation, coordinator lag, large prompt construction, MongoDB query behavior, or provider backpressure.

A benchmark number becomes operational evidence only when connected to a requirement, environment, historical baseline, and decision threshold.

### 17. Production Composition Is the Largest Test Seam

There is no test that starts the real Studio composition root. Integration tests manually reconstruct a subset of routes and dependencies, so they cannot detect drift in `backend/main.go`.

Consequently, the suite does not directly protect several findings from Chapter 12:

- the unjoined Studio shutdown goroutine;
- immediate root-context cancellation while HTTP drain is intended;
- missing explicit MongoDB and Redis closure;
- absent MongoDB orphan-run recovery;
- lazy fatal JWT configuration;
- shallow health with no readiness transition; and
- production middleware order and CORS behavior.

This illustrates why composition tests matter. Every component can be correct in isolation while the application constructed from them owns resources or propagates cancellation incorrectly.

### 18. LLM Provider Contract Gap

The `llm` package tests registry behavior but has no direct `openai_test.go` or `anthropic_test.go` coverage. Important unprotected behavior includes:

- request translation;
- system-message handling;
- tool-call encoding and decoding;
- malformed successful responses;
- provider error mapping;
- retry counts;
- cancellation during backoff;
- `429` and `5xx` decisions;
- response body limits; and
- protocol drift.

These tests do not need live provider credentials. Local scripted HTTP transports or test servers can verify the exact outbound request and return representative provider responses deterministically.

### 19. HTTP Middleware and Process Gaps

Focused evidence is missing for:

- request-ID generation, reuse, and propagation;
- body-limit enforcement through the production middleware stack;
- CORS preflight behavior;
- Studio health semantics;
- standalone readiness transitions;
- panic containment at the HTTP boundary;
- security headers;
- login/signup rate limiting;
- listener binding failure;
- real signal delivery;
- HTTP drain under `SIGTERM`;
- shutdown deadline expiry;
- second-signal behavior; and
- executable exit codes.

A process-level test is the appropriate boundary for the final items. It should start the compiled binary, wait for readiness, send real traffic, deliver a signal, inspect durable state, and verify the exit result.

### 20. Security Verification: SSRF

The HTTP and MCP tools validate the initial URL by resolving its hostname and rejecting common private and internal CIDRs. MCP additionally requires HTTPS.

The validation is separated in time from the actual network connection. Therefore it does not bind the approved IP to the address that is dialed. Two important bypass classes remain:

- DNS returns a public address during validation and a private address during connection; and
- an approved public URL redirects to a private or internal URL, while the default client follows the redirect without rerunning the application guard.

The MCP source explicitly acknowledges the DNS-rebinding limitation. The same mechanism affects the general HTTP tool. Verification should cover redirects, rebinding-resistant dialing, IPv4 and IPv6 edge ranges, encoded host forms, userinfo, and proxy behavior.

This risk is conditional on trust: it becomes high impact when URLs can be influenced by untrusted users, retrieved content, or model reasoning inside a network with valuable internal endpoints.

### 21. Security Verification: Authentication

Existing JWT and middleware tests cover valid tokens, garbage input, malformed JWTs, missing bearer headers, and wrong signing keys.

Important policy gaps remain:

- validation accepts the HMAC family rather than pinning the exact intended algorithm;
- issuer enforcement is not explicitly configured;
- token revocation and rotation behavior are undefined;
- Studio login and signup have no rate limit;
- a missing Studio JWT secret can terminate the process during token use; and
- there is no security test proving secrets are absent from all logs and error paths.

Standalone bearer authentication is more lifecycle-safe: configuration is validated before serving, the token is stored as a hash, and comparison is constant-time.

### 22. Risk Prioritization Model

A useful risk score is not just likelihood multiplied by impact. Operational priority should also consider:

- **exposure:** how often the path is invoked and who can influence it;
- **detectability:** whether failure becomes visible quickly;
- **recoverability:** whether the system can repair or replay safely;
- **blast radius:** one run, one tenant, one process, or all deployments;
- **evidence strength:** whether a guarantee is tested at its real boundary; and
- **change velocity:** whether an external protocol or active development area is likely to drift.

This is why an uncommon checkpoint failure can still rank highly: its immediate likelihood may be modest, but false recoverability can turn a transient persistence problem into permanent run loss that the API misrepresents as resumable.

### 23. Highest-Priority Correctness and Security Risks

#### A. Studio shutdown and orphan recovery

The intended HTTP drain is not joined, runtime cancellation occurs immediately on signal, and Studio has no MongoDB orphan-run recovery. Impact includes prematurely terminated requests and indefinitely stale `running` records.

#### B. False checkpoint recoverability

`hasSnapshot` can become true after all save attempts failed below the fatal threshold. A later resumable error can therefore advertise recovery when no checkpoint exists.

#### C. External side-effect replay

Checkpointing and recovery provide at-least-once execution. Redis tool deduplication is best-effort, uses detached background contexts, and is absent from standalone. Mutating HTTP and MCP actions require an end-to-end idempotency contract with the external system.

#### D. Incomplete SSRF enforcement

DNS rebinding and redirects can separate the address validated from the address contacted.

#### E. Unenforced verification pipeline

Tests existing in the tree do not prove that formatting, tests, race detection, static analysis, vulnerability scanning, and builds gate a released revision.

#### F. Unsafe integration-test isolation

Untagged MongoDB tests automatically drop fixed database names at a configurable endpoint.

### 24. High-Priority Deployment and Evolution Risks

#### Deployment control plane remains incomplete

Publication freezes and selects immutable configuration, and standalone consumes a bundle. The repository does not yet contain the reconciler, build/image pipeline, rollout controller, health-gated promotion, rollback automation, or deployment-state observation that turns selected state into managed running infrastructure.

#### Studio composition is unverified as assembled

Manual integration-test wiring can remain green while production `main` drifts.

#### Provider boundary is weakly protected

Provider protocols can change independently of the repository. Registry tests do not protect translation and retry behavior.

#### Multi-replica behavior is not a current guarantee

The in-process bus, local filesystem roots, and in-process scratchpad locks do not coordinate separate processes. Tests currently reinforce a single-process model rather than proving horizontal scaling.

#### Authentication hardening is incomplete

Algorithm and issuer policy, rate limiting, revocation, rotation, and startup validation need explicit contracts.

### 25. Operational Risks

#### Limited observability

There are no committed metrics or traces for checkpoint failure, active runs, pool depth, coordinator lag, provider retries, tool latency, queue leases, readiness transition, shutdown phase, or orphan recovery.

#### Database and filesystem split state

Memory metadata and revision bodies cross MongoDB/SQLite and filesystem boundaries. They cannot participate in one atomic transaction, so crash repair and storage backup must preserve both sides coherently.

#### Unknown capacity

Benchmarks do not yet define how many simultaneous runs, SSE streams, jobs, memory searches, or database writes the intended deployment must sustain.

#### Shallow Studio health

`/health` reports process reachability, not dependency readiness or the ability to accept a new run safely.

### 26. Recommended Verification Pipeline

#### Tier 0: deterministic source gates

- formatting;
- compilation;
- `go vet`;
- deterministic unit and conformance tests that require no external service; and
- standalone and Studio builds.

#### Tier 1: concurrency and parser gates

- race-detector runs for agent, bus, dispatcher, memory, scratchpad, SQLite, and runtime packages;
- fuzzing for bundle, checkpoint, provider, MCP, HTTP JSON, and path parsers; and
- repeated execution of timing-sensitive tests to expose flakes.

#### Tier 2: isolated infrastructure integration

- disposable MongoDB;
- unique per-run databases;
- explicit integration opt-in;
- adapter-specific index and transaction tests; and
- failure cases for unavailable or interrupted dependencies.

#### Tier 3: component and executable acceptance

- start each real binary on a real local socket;
- wait for readiness;
- use real HTTP authentication and middleware;
- stream a run;
- terminate the process;
- verify drain and durable recovery state; and
- verify exit codes and restart behavior.

#### Tier 4: security and abuse cases

- dial-time and redirect-aware SSRF tests;
- authentication algorithm, issuer, expiry, rotation, and rate-limit tests;
- tenant-ownership tests across every resource route;
- secret-redaction tests; and
- adversarial tool, memory, MCP, and provider inputs.

#### Tier 5: failure injection

Inject failure after each important boundary:

```text
run created
  -> checkpoint attempted
  -> model returned
  -> tool side effect began
  -> tool result returned
  -> job claimed
  -> child dispatched
  -> callback started
  -> messages persisted
  -> memory metadata appended
  -> memory body finalized
```

For every cut point, verify what is definitely durable, what may repeat, how restart classifies the operation, and whether any invariant requires manual repair.

#### Tier 6: performance and deployment evidence

- recorded benchmark baselines and `benchstat` comparisons;
- workload tests for expected concurrent runs and streams;
- queue and database saturation behavior;
- artifact build from a published bundle;
- readiness-gated rollout;
- state-compatible rollback; and
- observable reconciliation between desired and actual deployment state.

### 27. The First Verification Improvements to Make

A responsible implementation order is:

1. make the existing suite safe and reproducible;
2. separate deterministic and infrastructure-dependent tests;
3. add an enforced CI pipeline;
4. add regressions for `hasSnapshot` and Studio lifecycle defects;
5. add real composition and process tests;
6. add provider contract tests;
7. harden and test authentication and SSRF boundaries;
8. introduce race, fuzz, dependency, and static-security gates;
9. add failure-injection scenarios; and
10. establish performance and deployment acceptance criteria.

This order improves the trustworthiness of later work. Adding hundreds of new tests before making test execution isolated and enforced would increase volume without establishing a dependable release gate.

### 28. What Is Confirmed, Inferred, and Unknown

**Confirmed by repository inspection:**

- the test inventory and distribution described above;
- both MongoDB and SQLite run the shared conformance suites;
- MongoDB integration tests use fixed databases and drop them;
- no Go build tags separate integration tests;
- no committed CI workflow, lint configuration, coverage configuration, or vulnerability-scan configuration was found;
- there are no fuzz targets;
- OpenAI and Anthropic adapters lack direct test files;
- Studio production composition is not started by an application-level test; and
- standalone has meaningful application and restart tests.

**Inferred from those facts:**

- a clean default test run is likely to fail or skip behavior without MongoDB and `rg`;
- timing-based tests carry elevated flake risk under slow or instrumented execution;
- production wiring can drift from manually reconstructed integration wiring; and
- test quantity currently exceeds release-process maturity.

**Unknown because validation was not executed or external state is absent:**

- whether the current suite passes;
- current line or branch coverage;
- whether any race is detected by `go test -race`;
- historical flake rate;
- whether an external CI service performs checks not stored here;
- compatibility with current live provider responses;
- intended production topology and load;
- external termination grace periods; and
- the final deployment platform and reconciliation model.

### 29. Source Map

| Concern | Primary source |
| --- | --- |
| Agent runtime tests | `backend/agent/*_test.go` |
| Shared persistence contracts | `backend/repo/conformancetest/conformancetest.go` |
| MongoDB adapter verification | `backend/repo/mongorepo/*_test.go` |
| SQLite adapter and recovery verification | `backend/repo/sqliterepo/*_test.go` |
| HTTP handler tests | `backend/handlers/*_test.go` |
| MongoDB-backed HTTP integration | `backend/integration/*_test.go` |
| Standalone application verification | `backend/runtime/app_test.go` |
| MCP client and adapter tests | `backend/mcp/client_test.go`, `backend/tools/mcp_tool_test.go` |
| SSRF implementation and tests | `backend/tools/ssrf.go`, `backend/tools/http_tool_test.go` |
| JWT and auth middleware tests | `backend/auth/jwt_test.go`, `backend/middleware/auth_test.go` |
| Provider adapter gap | `backend/llm/openai.go`, `backend/llm/anthropic.go`, `backend/llm/registry_test.go` |
| Production Studio composition gap | `backend/main.go` |
| SQLite benchmarks | `backend/repo/sqliterepo/benchmark_test.go` |

### 30. Chapter Summary

AgentFlow has substantial behavioral testing at the domain, runtime, handler, persistence, concurrency, and standalone-component levels. Its strongest verification design is the shared repository conformance suite, which applies the same atomicity, ownership, idempotency, lease, and ordering contracts to MongoDB and SQLite. Its SQLite restart scenarios and standalone composition tests also provide meaningful durability evidence.

The weak outer ring is production composition and delivery: real provider adapters, Studio startup and shutdown, actual process signals, middleware assembly, SSRF edge cases, race enforcement, fuzzing, dependency scanning, capacity targets, deployment reconciliation, and committed CI gates. The current suite also mixes deterministic tests with destructive external MongoDB tests and relies partly on wall-clock timing. The highest-priority risks are Studio shutdown/orphan behavior, false checkpoint recoverability, replay of external side effects, incomplete SSRF enforcement, unsafe integration isolation, and the lack of an enforced verification pipeline. The next step is not indiscriminately adding more tests; it is making verification safe, layered, reproducible, boundary-accurate, and mandatory for the artifact that will actually be deployed.

## Chapter 14: Request-to-Result Execution Trace

The preceding chapters studied the backend one responsibility at a time. This chapter reconnects those responsibilities by following one message through the whole system. Its purpose is to answer a more practical question: when a user presses **Send**, what runs, what becomes durable, what can be cancelled, and what remains recoverable at every boundary?

The running example is deliberately simple: an authenticated user sends **“What is 6 × 7?”** to an existing thread whose selected agent can use the calculator tool. The arithmetic is unimportant. What matters is that the example can take either the short path—one model call returning `42`—or the tool path—model request, calculator execution, and another model request—without changing the surrounding lifecycle.

### 1. The Three Timelines Behind One Request

A message request looks like one operation to the user, but the backend maintains three related timelines:

```text
Execution timeline:    run -> model/tool steps -> terminal result
Recovery timeline:     checkpoints -> phases -> attempts -> resume
Conversation timeline: durable messages -> thread summary -> future context
```

They overlap, but they are not one database transaction.

- The **execution timeline** records what the agent is doing now.
- The **recovery timeline** records enough internal state to continue after interruption.
- The **conversation timeline** is the user-visible history that future turns normally load.

This distinction explains several otherwise surprising states. A run can be marked completed while its final conversation messages are still being saved. A checkpoint can contain the user's input while the message repository does not. A tool can have changed an external system even though no later checkpoint proves that the tool finished.

The key mental model is therefore not “the request was saved” but “which timeline crossed which durability boundary?”

### 2. The Full Happy-Path Shape

At the highest level, a fresh message follows this control flow:

```text
HTTP request
  -> middleware and authentication
  -> thread and agent ownership checks
  -> durable run creation
  -> SSE response establishment
  -> dispatch
  -> run preparation
  -> context construction
  -> pre-model checkpoint
  -> LLM call
  -> optional tool execution and further LLM calls
  -> final checkpoint
  -> durable run-status update
  -> conversation-message persistence
  -> final SSE event
```

That diagram is an ordering model, not a claim that one component performs every step. The handler owns the HTTP lifecycle, the dispatcher owns admission to an execution worker, the preparer reconstructs durable inputs, the runtime owns the agent loop, repositories own durable state transitions, and the stream loop translates internal events into an SSE response.

### 3. Two Entry Points, One Runtime Model

The Studio backend and the standalone bundle expose similar message endpoints, but their identity, persistence, and dispatch environments differ.

| Concern | Studio backend | Standalone runtime |
| --- | --- | --- |
| Endpoint | `POST /api/threads/{id}/messages` | `POST /v1/threads/{id}/messages` |
| Caller identity | JWT-authenticated MongoDB user | Deployment bearer token, or deployment-configured unauthenticated access |
| User representation | Mutable persisted user | Synthetic user derived from the deployment bundle/runtime |
| Agent representation | Mutable MongoDB agent | Immutable agent definition frozen into the publication bundle |
| Conversation persistence | MongoDB repositories | SQLite repositories |
| Normal dispatch | Direct dispatcher by default; bus mode is optional | Bus dispatcher and worker pool |

Both entry points converge on the same broad abstractions: a user-scoped thread, an agent, a durable run, a prepared `RunContext`, the agent runtime, checkpoint storage, message persistence, and a stream of runtime events. This reuse is valuable because execution semantics are not reimplemented for deployment. The differences are in composition and operational guarantees around that shared core.

### 4. Middleware: Establishing the Request Boundary

Before the message handler runs, middleware establishes transport-level constraints and identity.

The relevant responsibilities include:

1. limiting the request body to approximately 1 MiB;
2. applying Studio CORS policy where the browser-facing Studio API requires it;
3. authenticating the bearer credential appropriate to the current runtime;
4. storing the resolved user identity in the request context;
5. assigning or propagating a request ID; and
6. recording request-level logs and timing.

Authentication answers **“Who is making this request?”** It does not by itself answer **“May this user operate on this thread?”** That second question is authorization and is enforced through user-scoped repository lookups in the handler and again in run preparation.

The request context is also the first cancellation root. If the client disconnects or the server cancels the request, downstream contexts derived from it can observe cancellation. Detached persistence work is a deliberate exception discussed later.

### 5. Handler Validation and Ownership

The message handler in `backend/handlers/message.go` performs the first application-level checks:

1. read the authenticated user ID from the request context;
2. parse the thread ID from the route;
3. decode the JSON request body;
4. reject blank message content;
5. load the thread through a user-scoped repository method;
6. load the thread's agent through a user-scoped repository method; and
7. preflight-load conversation history.

User-scoped lookup is important. Looking up a thread by ID and then trusting the caller would create an insecure direct-object-reference risk. The repository query instead includes ownership as part of the lookup contract, so a caller cannot obtain another user's object merely by knowing its ID.

The handler's history read is currently a preflight check rather than the authoritative execution input. The loaded history is discarded, and the preparer later reads history again. This creates a time-of-check/time-of-use window: history may change between handler validation and preparation. The second read is the one the runtime actually receives.

### 6. Creating the Durable Run Before Streaming

After validation, the handler generates a run UUID and creates a durable run record before it starts the SSE response. A fresh top-level run begins with values conceptually equivalent to:

| Field | Initial meaning |
| --- | --- |
| Status | `running` |
| Attempt | `1` |
| Originator | The run itself, because this is a top-level invocation |
| Invocation | Top-level/user initiated |
| Thread and agent | The already authorized execution target |

This ordering gives the system a durable execution identity before asynchronous work begins. Events, checkpoints, child runs, cancellation, and later status changes can all refer to the same run ID.

However, two things do **not** exist yet:

- the new user message has not been inserted into the conversation-message collection; and
- no checkpoint has captured the runtime transcript.

Therefore, a process failure immediately after run creation can leave a `running` run with neither a checkpoint nor a persisted conversation input. The standalone startup recovery path can classify orphaned work. Studio currently has a weaker startup/shutdown recovery story, so the same state can remain stale there.

### 7. Establishing the SSE Response

The handler prepares an event-stream response with headers equivalent to:

- `Content-Type: text/event-stream`;
- cache disabled;
- keep-alive enabled; and
- proxy buffering disabled through `X-Accel-Buffering: no`.

It creates a derived cancellation context, a buffered event channel with capacity 128, and a completion channel. Dispatch runs asynchronously while the handler's stream loop writes events to the client.

This changes error semantics. Before response streaming begins, validation failures can use ordinary HTTP status codes. After the SSE response is established, the status line is already committed; later failures must be represented as stream events. A client must therefore inspect the event protocol, not merely the HTTP status.

### 8. Dispatch: Direct and Bus Paths

#### 8.1 Direct Studio Dispatch

Studio uses the direct dispatcher by default. The dispatch goroutine calls the preparer and then the runtime without routing the parent request through a message bus. This is the shortest path and removes an unnecessary queue boundary for the common Studio request.

“Direct” does not mean “the bus is absent from the process.” Synchronous delegation and other child work can still require agent pools and bus topics. The direct dispatcher also connects cancellation of the originator run to its child-run tree, so cancelling the top-level request can propagate through delegated work.

#### 8.2 Bus Dispatch

The standalone runtime always uses bus dispatch, and Studio can be configured to use it. The dispatcher:

1. ensures a worker pool exists for the target agent;
2. subscribes to the run's event topic;
3. publishes a run request;
4. allows a worker to prepare and execute the run;
5. forwards worker events through the bus; and
6. forwards subscribed events from the bus into the handler's channel.

The bus path adds queueing, topic subscription, worker lifecycle, and an additional event-forwarding boundary. It is useful when execution must be decoupled from the initiating handler, but every extra boundary also creates a shutdown and failure-ordering responsibility.

### 9. Run Preparation Reconstructs Authoritative Inputs

`backend/dispatcher/preparer.go` converts durable application state into the `RunContext` consumed by the runtime. It does more than copy request fields.

For a fresh run, preparation:

1. reloads the thread and agent under the user's ownership boundary;
2. loads up to 500 persisted messages;
3. groups messages into conversational turns;
4. loads the thread summary;
5. estimates tokens consumed by the system/context prefix;
6. divides history into retained and compactable portions;
7. may start asynchronous summarization of older history;
8. establishes run lineage and delegation metadata;
9. establishes task/token budget metadata; and
10. constructs the complete runtime input.

Ownership is checked again because dispatch may occur after the original handler check and, in bus mode, in a different execution component. A handler check should not be treated as a permanent authorization grant to future asynchronous work.

History compaction deserves careful timing semantics. When older turns should be summarized, the update can happen asynchronously. The current run uses the summary and retained tail available during preparation; a newly produced summary primarily benefits future runs. A per-thread in-process single-flight mechanism prevents duplicate summarization work inside one process, but it is not a distributed lock across replicas.

### 10. Runtime Initialization

`backend/agent/runtime.go` takes the prepared context and initializes the agent loop:

1. emits `run.started`;
2. resolves the configured LLM provider;
3. builds the effective tool set, including built-in tools, delegation tools, async tools, and MCP tools;
4. degrades unavailable MCP capabilities rather than necessarily aborting the whole run;
5. initializes step, usage, failure, pending-job, and lineage state; and
6. asks the context builder for the canonical transcript.

For a fresh request, the transcript begins conceptually as:

```text
system context
+ persisted conversation history
+ current user input
```

For a resumed request, the checkpointed transcript tail replaces reconstruction from the normal message-history path. That difference is essential: recovery state may be newer than the conversation projection.

### 11. Context Construction: Static Prefix, Dynamic State, Canonical Transcript

`backend/agent/context_builder.go` combines several kinds of information.

The relatively static prefix includes the platform instructions, the agent's configured prompt, and tool-use instructions. Dynamic context can include user preferences, current state, system context, the thread summary, a memory index, collaboration state, scratchpad information, and notices about unavailable MCP servers.

Dynamic system context is refreshed before each LLM call. This allows state created by a preceding tool or delegation step to influence the next inference without rebuilding the entire run from persistence.

The runtime keeps a canonical transcript containing complete internal messages and tool results. `RenderForLLM` creates the provider-facing copy and can truncate large tool results to fit model constraints. This separation protects recovery and internal reasoning from destructive prompt-size adaptation: truncating what the provider sees does not erase the canonical result stored in runtime/checkpoint state.

### 12. The Pre-Model Checkpoint

Immediately before a provider call, the runtime writes a checkpoint in the `pre_model` phase. Its snapshot can contain:

- the canonical transcript;
- the current summary;
- completed step count;
- accumulated token usage;
- tool failure counts;
- tool identities needed for compatibility checks;
- attempt and lineage information;
- asynchronous-job state; and
- current system context.

The guarantee is: **if this checkpoint is durable, recovery can reconstruct the state immediately before asking the model what to do next.** It does not guarantee that no external request was already sent; process failure can always occur between adjacent instructions.

Checkpoint writes are retried three times with roughly 1.5 seconds per attempt. A limited number of consecutive checkpoint failures is tolerated, with a threshold of three. This lets transient persistence problems avoid immediately killing every run, but it weakens the certainty of recovery.

There is a confirmed correctness defect in the current runtime: the caller can mark `hasSnapshot` as true after a checkpoint failure that the tolerance logic allowed execution to survive. Later interruption handling may therefore classify the run as resumable even though the expected snapshot was not actually written.

### 13. First LLM Call

The runtime emits step/status events indicating that it is calling the model and sends the rendered transcript plus the currently available tool definitions to the resolved provider.

The provider can return one of two meaningful shapes:

1. a final assistant answer, such as `42`; or
2. one or more tool calls, such as a request to evaluate `6 * 7`.

A provider error exits the normal loop and enters terminal error handling. A successful response updates usage accounting and the canonical transcript. The next durability action depends on whether the response is final or requests tools.

### 14. Final-Answer Branch

When the provider returns a final answer, the runtime:

1. increments the completed-step state and usage totals;
2. appends the final assistant message to the canonical transcript;
3. emits model- and step-completion events;
4. writes a `step_completed` checkpoint; and
5. returns a `RunResult` containing the newly created messages.

The runtime's deferred terminal logic then emits `run.completed`, updates the durable run status to `completed`, and closes its event sink. The handler does not immediately expose that terminal event to the client; it buffers the event until conversation-message persistence has been attempted.

This produces two different meanings of “complete”:

- **runtime complete** means the agent loop produced a terminal result; and
- **conversation complete** means the result was projected into the thread's durable message history.

The present implementation records the durable run status before the handler completes the second meaning.

### 15. Tool-Call Branch

If the provider requests tools, the runtime appends the assistant tool-call message and writes a `post_model` checkpoint before executing the requested calls.

This phase placement is deliberate. A resumed `post_model` run already knows exactly which tool calls the model selected, so it can execute those saved calls without paying for or potentially receiving a different answer from another model invocation.

The remaining hazard is the classic external-side-effect gap:

```text
post_model checkpoint
  -> invoke external tool
  -> external side effect succeeds
  -> process crashes
  -> tool-result checkpoint never becomes durable
```

On resume, the saved tool call may execute again. This is an **at-least-once** execution model unless the target tool uses an idempotency key or independently detects duplicates. A checkpoint can record known completion, but it cannot atomically commit a change made in an unrelated external system.

### 16. Tool Batch Execution

`backend/agent/tool_batch.go` validates and executes the model's requested tool calls.

- An unknown ordinary tool is a fatal protocol/configuration error.
- An unavailable MCP tool is converted into a softer tool error so the model may recover or explain the limitation.
- Independent tool calls can execute concurrently.
- Calls that synchronously delegate to the same target agent are serialized to avoid colliding child interactions.
- Results are restored to the model's original call order even when execution finishes out of order.

Each invocation receives a derived context carrying cancellation/timeout, memory access, user and run identity, originator and delegation-chain metadata, and asynchronous-job information where applicable. Tool lifecycle events make progress visible to the stream.

Ordinary execution errors are converted into tool-result messages so the model can reason about the failure. Repeated execution failure of the same tool becomes fatal after three occurrences, preventing an unbounded model/tool retry loop.

In the running example, the calculator validates the expression, computes `42`, and returns a structured result. The runtime appends that result to the canonical transcript, checkpoints the advanced state, refreshes dynamic context, and calls the model again. The model can now turn the machine result into the user-facing answer.

### 17. Synchronous Delegation

When the selected tool delegates to another agent, `backend/dispatcher/delegate_invoker.go` introduces a child execution tree:

1. validate maximum depth, cycle prevention, and target ownership;
2. reserve or validate budget for the child task;
3. create or select a child thread;
4. create a durable child run linked to the originator;
5. ensure the target agent's worker pool exists;
6. publish the child request;
7. wait for the child terminal result;
8. best-effort persist the child conversation messages; and
9. return the child output to the parent as a tool result.

The parent does not receive the child's internal runtime object. It receives a tool result that becomes part of the parent's canonical transcript. Cancellation is organized by originator so a top-level cancellation can propagate to descendants instead of abandoning a hidden subtree.

### 18. Asynchronous Tools and Suspension

An async tool can create background work whose result will arrive later. The runtime distinguishes work that may continue independently from work required before the parent can finish.

For a required pending job, the runtime:

1. marks the relevant await state;
2. writes a `waiting_for_jobs` checkpoint;
3. updates the durable run status to `waiting_for_jobs`;
4. emits `run.waiting`; and
5. exits the active execution loop without falsely declaring a final answer.

The job coordinator later observes completion and initiates resume. Recovery rechecks the job rather than assuming that an earlier notification proves its current durable state. This turns a long wait into two bounded execution attempts separated by persisted suspension.

### 19. Runtime Events and Backpressure

The channel-backed event sink assigns each event a run ID, monotonically increasing sequence number, event ID, and timestamp. That metadata lets clients order events and associate them with a specific execution.

Status-only updates may be dropped when the event buffer is full. They are advisory progress information. Other events apply backpressure and wait for the consumer unless the context is cancelled, because silently dropping structural events would make the protocol misleading.

The handler's stream loop writes nonterminal events as they arrive, buffers the terminal runtime event, waits for dispatch completion, drains remaining events, and can synthesize a failure event when execution terminates without a proper terminal event. This is why event order at the browser can differ from emission order inside the runtime.

The intended visible ending is:

```text
runtime progress and result events
  -> run.persisted or run.persist_failed
  -> buffered run.completed or run.failed
```

### 20. Conversation-Message Persistence

For a fresh run, the handler's persistence batch contains the original user input plus `RunResult.NewMessages`. The write uses a bounded context of roughly ten seconds derived from a background context rather than from the already-ending HTTP request.

Detaching is intentional: if the client closes the stream immediately after receiving an answer, cancellation of the socket should not automatically discard the conversation history. The timeout is equally important because detached work without a bound could outlive the request indefinitely.

On success, the handler emits `run.persisted` and then releases the buffered terminal event. On failure, it emits `run.persist_failed` and still releases the runtime terminal event. The caller can therefore learn that execution succeeded but its conversation projection did not.

This design favors delivering the computed result even when message persistence is degraded. It does not make the run-status update and message insert atomic.

### 21. Durability Timeline

The following table shows what is known after each important boundary in a fresh run:

| Boundary reached | Durable run | Durable checkpoint | Durable conversation messages | What a client may know |
| --- | --- | --- | --- | --- |
| Before `CreateRun` | No | No | Old history only | Ordinary HTTP failure is possible |
| After `CreateRun` | `running` | No | Old history only | Usually nothing yet |
| After `pre_model` | `running` | Input and pre-call runtime state | Old history only | Progress may be streaming |
| After `post_model` | `running` | Exact selected tool calls | Old history only | Model requested work |
| After tool side effect, before next checkpoint | `running` | Does not prove tool completion | Old history only | Tool may appear in progress |
| After final `step_completed` checkpoint | `running` or transitioning | Final runtime transcript | Old history only | Final model events may exist internally |
| After runtime defer/status update | `completed` | Final checkpoint | Old history only | Terminal event is buffered by handler |
| After message insertion | `completed` | Final checkpoint | Input and new output exist | `run.persisted` can be emitted |
| After terminal SSE write | `completed` | Final checkpoint | Input and new output exist | Client has observed the terminal outcome |

No row should be mentally collapsed into another. In particular, `completed` in the run repository does not prove that the conversation-message row was inserted or that the browser received the terminal event.

### 22. Resume Entry Point

The resume handler in `backend/handlers/run.go` does not simply rerun the original HTTP request. It performs a controlled state transition:

1. authenticate the caller and load the owned run;
2. allow only resumable statuses such as interrupted or waiting-for-jobs states;
3. use an atomic compare-and-swap transition back to `running`, ensuring only one contender wins;
4. load the latest checkpoint;
5. load the system agent definition needed for reconstruction;
6. validate that the saved tool identities remain compatible;
7. increment the attempt number; and
8. establish SSE and dispatch with `IsResume` set.

The preparer validates ownership and inputs again. The runtime restores transcript, summary, step and usage counters, failure counts, pending awaits, lineage, system context, and other saved state rather than starting a blank loop.

Resume behavior depends on the checkpoint phase:

| Phase | Resume action |
| --- | --- |
| `pre_model` | Call the model again from the saved pre-call transcript |
| `post_model` | Execute the already selected pending tool calls |
| `waiting_for_jobs` | Recheck awaited durable job state and continue when satisfied |
| `step_completed` | Continue from the completed step if the run status is legitimately resumable |

The compare-and-swap protects one run from two simultaneous resume owners. It does not serialize two entirely separate fresh runs on the same thread.

### 23. Confirmed Resume-to-History Projection Gap

The fresh-message handler persists the original input plus all new runtime messages. The resume handler persists only `RunResult.NewMessages` produced during the resumed attempt.

Consider this sequence:

1. a fresh request receives “What is 6 × 7?”;
2. `pre_model` or a later checkpoint stores that input in the runtime transcript;
3. the process fails before the fresh handler inserts its conversation batch;
4. resume restores the checkpoint and reaches a final answer; and
5. the resume handler saves only the newly produced resumed messages.

The run can now complete while the original user input—and possibly earlier intermediate messages—remains absent from the thread message store. The existing resume persistence test verifies the new assistant message, but it does not prove that a lost fresh input is repaired.

A related case is even harder: if runtime status already became `completed` and message insertion then failed, the normal resume endpoint rejects the run because execution itself is complete. There is no separate reconciliation path that projects the final checkpoint transcript into conversation history.

Possible remedies include:

- persisting the user input before execution and incrementally appending output;
- assigning stable message IDs and a run association so projection can be retried idempotently;
- using an outbox/projection-status record to distinguish execution completion from history completion; or
- running a reconciler that repairs missing conversation projections from an authoritative source.

Blindly retrying a batch insert is insufficient without stable identity or uniqueness rules because an uncertain previous write could create duplicates.

### 24. Client Disconnect and Cancellation

If the HTTP request is cancelled or an SSE write fails, the handler cancels the derived run context. The dispatcher propagates cancellation, and an originator-aware dispatcher also cancels child runs. The runtime exits at cancellation-aware boundaries.

Terminal classification depends partly on whether the runtime believes a usable snapshot exists: interruption with a snapshot can be marked resumable, while execution without one may be marked failed. The previously described `hasSnapshot` defect can make that distinction unreliable.

If a non-nil result already exists, the handler can still attempt bounded best-effort persistence. During a typical mid-run cancellation, no final result exists; the input may therefore survive only inside a checkpoint, not in conversation history.

Detached cleanup must always be bounded. Message persistence has a local timeout. Some background status updates use a background context without the same local deadline, which increases shutdown uncertainty if their storage dependency hangs.

### 25. Concurrent Fresh Requests on One Thread

The current flow does not claim, sequence, lease, or otherwise serialize fresh requests per thread. Two requests can therefore:

1. both pass ownership validation;
2. create different run IDs;
3. load the same prior history;
4. execute independently; and
5. persist results in completion order rather than submission order.

Neither model invocation necessarily sees the other new user turn. The resulting stored conversation can look linear even though its causal histories forked.

If parallel branches are an intentional product feature, they need explicit branch identity so the UI and context builder do not mistake them for one linear chat. If a thread is intended to be linear, the invariant belongs at shared persistence—not in an in-process mutex that fails as soon as two replicas serve requests. Suitable designs include a thread revision compare-and-swap, an active-run lease, or a durable per-thread sequence/admission mechanism.

### 26. Failure-Boundary Matrix

| Failure point | Resulting risk or recovery behavior |
| --- | --- |
| Before run creation | Ordinary HTTP failure; no new durable run |
| After run creation, before first checkpoint | Stale `running` run; input absent from conversation history |
| After `pre_model` | Runtime may resume, but input may exist only in snapshot state |
| After provider request, before durable response phase | Provider may be called again; cost or nondeterminism can repeat |
| After `post_model`, before tool execution | Resume can execute the saved pending tool calls |
| After external tool effect, before result checkpoint | Tool effect may be repeated on resume |
| After final checkpoint/status, before message insert | Run can be completed while chat history is incomplete |
| After message insert, before terminal SSE reaches client | Server may be fully complete while client remains uncertain and retries |

This table shows why “retry the request” is not a universal recovery policy. Safe retry depends on which durable boundary was crossed and whether every intervening operation is idempotent.

### 27. What Is Confirmed, Inferred, and Still Unknown

**Confirmed by current source and tests:**

- a run record is created before SSE execution and before fresh input-message persistence;
- the handler buffers the terminal SSE event until after message persistence is attempted;
- durable run completion can precede conversation-message insertion;
- resume persists only messages newly returned by the resumed attempt;
- there is no per-thread serialization of separate fresh runs;
- Studio defaults to direct dispatch while standalone uses bus dispatch;
- recovery phases include `pre_model`, `post_model`, `waiting_for_jobs`, and `step_completed`; and
- external tool effects are not atomically committed with checkpoints.

**Inferred from those mechanics:**

- simultaneous requests can create causally forked histories that are later displayed as one sequence;
- a completed run whose message projection failed requires manual repair or a future reconciliation mechanism; and
- a client that misses the terminal event can retry despite the server already completing the operation.

**Unknown because product or deployment policy is not encoded:**

- whether same-thread concurrency is intended to create branches or should be rejected/queued;
- whether the accepted user message must be durable before model execution begins;
- whether checkpoint state or the message store should be authoritative during reconciliation; and
- whether every consuming UI treats `run.persist_failed` as distinct from agent-execution failure.

These unknowns are not implementation trivia. Their answers determine the correct transaction, idempotency, and user-experience design.

### 28. Responsibility Map

| Boundary | Owning component | Primary source |
| --- | --- | --- |
| Routes and application composition | Studio/standalone composition roots | `backend/main.go`, `backend/runtime/app.go` |
| HTTP message validation and SSE lifecycle | Message handler and stream loop | `backend/handlers/message.go`, `backend/handlers/stream.go` |
| Direct/bus execution admission | Dispatchers and worker pools | `backend/dispatcher/direct.go`, `backend/dispatcher/bus_dispatcher.go`, `backend/dispatcher/agent_pool.go` |
| Durable-input reconstruction | Run preparer | `backend/dispatcher/preparer.go` |
| Model/tool loop and checkpoint phases | Agent runtime | `backend/agent/runtime.go`, `backend/agent/checkpoint.go` |
| Prompt/transcript construction | Context builder | `backend/agent/context_builder.go` |
| Tool batching and capabilities | Runtime and tool packages | `backend/agent/tool_batch.go`, `backend/tools/*` |
| Synchronous child execution | Delegate invoker | `backend/dispatcher/delegate_invoker.go` |
| Async suspension/resume | Async runtime and job coordinator | `backend/agent/async_tools.go`, `backend/dispatcher/job_coordinator.go` |
| Resume HTTP flow | Run handler | `backend/handlers/run.go` |
| Durable run/message/checkpoint state | Repository adapters | `backend/repo/mongorepo/*`, `backend/repo/sqliterepo/*` |
| Behavioral evidence | Runtime and integration tests | `backend/agent/*_test.go`, `backend/integration/*_test.go`, `backend/runtime/app_test.go` |

### 29. How to Debug a Real Run

When investigating a failed or apparently missing response, reconstruct the three timelines separately:

1. **Execution:** find the run status, attempt, emitted event sequence, provider/tool errors, child runs, and final result.
2. **Recovery:** find the latest checkpoint, its phase, saved transcript, saved tool identities, pending jobs, and whether a resume claim occurred.
3. **Conversation:** find the input and output message records, their ordering, and the summary/revision future runs will load.

Then compare their boundaries. For example:

- `completed` run + final checkpoint + missing messages indicates projection failure, not model failure;
- `running` run + no checkpoint suggests failure before the first durable recovery point;
- `post_model` checkpoint + observed external change suggests a replay/idempotency investigation; and
- complete persistence + missing terminal client event suggests delivery uncertainty rather than execution uncertainty.

This method avoids treating every symptom as “the LLM failed.” Most production failures in this flow arise at boundaries between execution, durability, delivery, and external side effects.

### 30. Chapter Summary

A message request is an orchestrated workflow, not a single database transaction. The handler authenticates and authorizes the request, creates a durable run, establishes SSE, and dispatches execution. The preparer reconstructs current durable inputs. The runtime builds canonical context, checkpoints before model and tool boundaries, executes model/tool/delegation loops, and produces a result. The handler then separately projects that result into conversation history before releasing the terminal event.

The design has strong building blocks: durable run identity, phase-aware checkpoints, compare-and-swap resume claims, originator cancellation, ordered events, bounded message persistence, shared runtime semantics across Studio and standalone, and deliberate recovery from long-running async jobs.

Its most important unresolved boundaries are equally clear: checkpoint success can be overstated, external tool effects are at least once, run completion is not atomic with conversation persistence, resume does not fully repair missing fresh history, Studio recovery is incomplete, and concurrent requests can fork a supposedly linear thread. These are the issues to carry into deployment design because multiple processes, crashes, retries, and rolling releases make boundary ambiguities more visible rather than less.

## Cross-Cutting Questions

These questions will be revisited in every layer:

1. Who owns this state?
2. Where is its invariant enforced?
3. What changes together, and what should remain independent?
4. What happens if the process stops halfway through?
5. What happens when two operations race?
6. What happens when an external dependency is unavailable?
7. How does cancellation propagate?
8. How is repeated execution made safe?
9. How is the behavior observed and debugged?
10. Which parts differ between Studio and the standalone runtime?
11. What is guaranteed by code, by persistence, by tests, or only by convention?
12. What would need to change at higher scale or in a multi-process deployment?

## Documentation Progress

| Chapter | Status | Notes |
| --- | --- | --- |
| Backend orientation and layer map | Initial draft | Established from repository inspection; individual layers still require detailed study. |
| Domain model and vocabulary | Complete initial study | Source-backed chapter added; later chapters may add cross-references without redefining its terms. |
| Request-to-result execution trace | Complete initial study | Source-backed end-to-end trace added; execution, recovery, conversation projection, SSE delivery, resume phases, concurrency, and confirmed durability gaps recorded explicitly. |
| Context construction | Complete initial study | Source-backed chapter added; asynchronous compaction handoff and hard-fit gaps recorded explicitly. |
| Agent execution engine | Complete initial study | Source-backed chapter added; at-least-once side effects, checkpoint boundaries, event semantics, and the `hasSnapshot` defect recorded explicitly. |
| Tools and external capabilities | Complete initial study | Source-backed chapter added; capability construction, replay behavior, MCP, SSRF, secret exposure, and tool-data durability risks recorded explicitly. |
| LLM providers | Complete initial study | Source-backed chapter added; provider translation, registry/catalog distinctions, retry semantics, typed-contract gaps, and operational risks recorded explicitly. |
| Multi-agent coordination | Complete initial study | Source-backed chapter added; synchronous and async flows, suspension/resume, callbacks, locks, leases, fencing, budgets, cancellation, crash behavior, and scaling limits recorded explicitly. |
| Memory and scratchpads | Complete initial study | Source-backed chapter added; revision authority, filesystem commit protocols, scope visibility, prompt injection, scratchpad ownership, cleanup gaps, and deployment constraints recorded explicitly. |
| Persistence | Complete initial study | Source-backed chapter added; ports, MongoDB/SQLite composition, schemas, indexes, migrations, transactions, CAS, idempotency, leases, recovery, conformance limits, and confirmed consistency gaps recorded explicitly. |
| HTTP and security boundary | Complete initial study | Source-backed chapter added; Studio and standalone routes, middleware, JWT and bearer authentication, ownership, validation, CORS, SSE, secrets, SSRF, error exposure, operational controls, and confirmed gaps recorded explicitly. |
| Publication and deployment | Complete initial study | Source-backed chapter added; graph stabilization, bundle freezing, validation boundaries, canonical hashing, append-only revisions, concurrency, selected state, runtime handoff, and the missing infrastructure reconciler recorded explicitly. |
| Standalone runtime | Complete initial study | Source-backed chapter added; CLI and configuration, validation ordering, SQLite identity and recovery, manual composition, API/authentication, lifecycle, observability, replay risk, packaging gaps, and single-process constraints recorded explicitly. |
| Composition and lifecycle | Complete initial study | Source-backed chapter added; both composition roots, configuration ownership, dependency graph, index/migration startup, context trees, goroutine ownership, dispatcher-mode shutdown behavior, failure unwinding, readiness, resource closure, drift risks, and recommended boundaries recorded explicitly. |
| Verification and risks | Complete initial study | Source-backed chapter added; test inventory, conformance strengths, dependency and isolation problems, unverified boundaries, security gaps, prioritized risks, and a staged verification strategy recorded explicitly. |

## Known Documentation Caveat

The root `README.md` describes an earlier V1 design centered on an in-memory, action-driven execution model. The current backend contains substantially more functionality, including persistent runs, LLM tool calling, checkpoint/resume, synchronous delegation, asynchronous jobs, scoped versioned memory, MCP tools, immutable publication bundles, and a SQLite-backed standalone runtime.

Until the discrepancy is addressed separately, this guide treats current source code and tests as authoritative for current behavior and records historical README claims only when they help explain the system's evolution.

## Post-Study Roadmap

The initial backend layer study is now complete. The next work should use this guide as a decision aid rather than add another descriptive layer chapter. A responsible sequence is:

1. **Create an architectural risk roadmap.** Convert the confirmed gaps into explicit decisions, owners, severity, and dependencies instead of treating every observation as equally urgent.
2. **Define the deployment target.** Record the intended platform, process topology, network boundaries, persistence services, secret sources, health checks, termination grace period, scaling model, and rollback mechanism.
3. **Establish a safe verification baseline.** Separate deterministic checks from external integration suites, make destructive test prerequisites explicit, and add enforced CI gates for the artifact that will actually ship.
4. **Fix release-blocking correctness and security gaps.** Prioritize checkpoint truthfulness, message-projection recovery, tool idempotency policy, same-thread concurrency semantics, SSRF enforcement, graceful shutdown, and production provider coverage according to the chosen deployment model.
5. **Design the deployment control plane.** Define how immutable publication bundles become desired runtime deployments, how reconciliation creates or updates infrastructure, how revisions roll out, and how status flows back to Studio.
6. **Implement and validate in approved stages.** Keep architecture, public contracts, migrations, runtime changes, infrastructure changes, and production validation as separate reviewable checkpoints.

Before implementation begins, the first concrete discussion should be the deployment target and its guarantees. Deployment architecture cannot be chosen responsibly until “where it runs,” “what must survive,” “how many replicas exist,” and “who owns reconciliation” are explicit.

## Deployment Architecture Decision 1: Cross-Revision Runtime State Ownership

### 1. Decision Status

**Status:** Accepted and refined by Deployment Architecture Decision 9. Managed hosting will use one deployment-owned PVC whose identity remains stable across revisions. The logical state split and migration mechanics inside that PVC still require implementation.

The decision is:

> Every managed revision of one logical deployment mounts the same PVC. Ordinary agent-revision updates preserve user conversations, durable memory, and existing scratchpad files. Execution state created under one revision remains owned by that revision and must not be resumed or silently reinterpreted by another revision.

This is a product and architecture decision, not a description of current behavior. The current standalone runtime isolates its entire data directory by configuration hash. Implementing the decision will therefore require an intentional storage-boundary change.

### 2. Why This Decision Is Necessary

The standalone runtime currently receives two broad inputs:

```text
Immutable deployment input
  -> published bundle supplied through --config

Mutable runtime state
  -> SQLite and filesystem state under --data
```

The published bundle defines the agent's behavior: prompts, models, tools, delegates, MCP configuration, limits, platform instructions, and the canonical configuration hash.

Runtime state is produced while the deployed agent is used: threads, messages, runs, checkpoints, jobs, memory, and scratchpad files. The current implementation places these different lifetimes beneath one data-directory identity. A configuration-hash change changes the synthetic runtime user and causes the SQLite identity binding to reject reuse of the previous directory.

That whole-directory isolation is safe because it prevents a new artifact from accidentally interpreting old state. It is also too coarse for the desired user experience. Changing an agent prompt should not, by itself, make all established conversations and intentionally accumulated memory disappear from the new revision.

The actual problem is therefore not simply “reuse the old volume.” It is:

> Which state represents durable user/product history, and which state is meaningful only inside the execution semantics that created it?

### 3. Terminology

#### Deployment-scoped state

State whose identity belongs to the logical deployed agent across compatible revisions. It may remain available when revision 1 is replaced by revision 2.

Examples include a user's conversation history and deliberately retained agent memory.

#### Revision-scoped state

State whose correctness depends on the exact bundle, tool set, runtime behavior, or execution attempt that created it.

Examples include an in-progress checkpoint containing tool identities from revision 1 and a pending job created by revision 1's delegation graph.

#### Durable does not mean cross-revision

A revision-scoped run may be retained durably for audit, debugging, billing, or incident analysis. “Revision-scoped” means revision 2 must not adopt or continue it; it does not necessarily mean the record should be immediately deleted.

#### Derived state

State that can be recreated from a more authoritative source. Thread summaries are derived from messages, for example. Derived state may be retained as a cache when compatible or invalidated and rebuilt when its producer changes.

### 4. Current Behavior

The current standalone directory is conceptually:

```text
runtime-data/
├── state.db
├── memory/
└── scratchpad/
```

The SQLite database is bound to:

- deployment ID;
- configuration hash; and
- synthetic user ID.

The synthetic user ID is derived from the configuration hash. The current data identity therefore changes even though the Kubernetes Deployment and Service names are now stable. Consequently:

```text
revision 1 + hash A -> identity A -> data directory A
revision 2 + hash B -> identity B -> data directory B
```

Trying to open directory A with hash B fails during startup. This prevents accidental cross-artifact state reuse but also means revision 2 does not automatically see revision 1's conversations, memory, runs, or scratchpads.

### 5. Target State Classification

| State | Target ownership | Preserve across revision? | Reason and conditions |
| --- | --- | --- | --- |
| Thread identity and user-visible metadata | Deployment scoped | Yes | A thread represents an ongoing user interaction with the logical deployed agent. |
| User and assistant messages | Deployment scoped | Yes | Messages are the authoritative conversation history and should survive ordinary behavior updates. |
| Thread summaries | Derived deployment state | Conditionally | They may be reused only when their format and semantic contract remain compatible; otherwise regenerate them from messages. |
| Intentionally retained long-term memory | Deployment scoped | Yes | Deliberately remembered knowledge is part of the continuing agent experience, subject to scope, retention, privacy, and format compatibility. |
| Memory revisions and provenance | Deployment scoped with producer metadata | Yes | Historical provenance should remain inspectable; new readers must understand or migrate the stored format. |
| Completed run records | Revision scoped, durably retained | No adoption; retain for audit | A run records execution under a particular bundle and attempt. A newer revision may display it but must not continue it. |
| Active or interrupted runs | Revision scoped | No | Their transcript, limits, tool identities, and recovery semantics belong to the creating revision. |
| Checkpoints | Revision scoped | No | Resuming a checkpoint under a changed prompt, tool set, delegate graph, or runtime may perform a different operation from the one originally approved. |
| Pending async jobs | Revision scoped | No automatic carry-forward | The target agent, callback, budget, and tool contract may have changed. They require completion under the old revision, explicit cancellation, or a designed migration protocol. |
| Task/run budgets | Revision or invocation scoped | No | Carrying partially consumed budgets into a changed graph has ambiguous accounting and control semantics. |
| Scratchpad files | Physically deployment-retained, logically run scoped | Preserve the files; do not adopt old ownership | Existing scratchpad bytes remain on the stable PVC. Their workspace key includes the originating run, so a new revision must not resume or mutate them as if it owned that run. Export, inspection, retention, and any later promotion feature are separate concerns. |
| Deployment identity and configuration hash | Revision scoped | No | They prove which immutable bundle owns the execution state. |
| Runtime logs and metrics | Deployment and revision labelled | Retain by operations policy | They should carry deployment, revision, hash, run, and request correlation rather than being treated as application state. |
| External tool side effects | Owned by the external system | Not migrated locally | Their safety depends on external idempotency and reconciliation, not on copying runtime files. |

### 6. Desired Logical Storage Boundary

The target mental model is:

```text
Logical deployment
├── deployment-scoped durable state
│   ├── threads
│   ├── messages
│   ├── durable memory
│   └── promoted user-visible artifacts
│
├── revision 1 execution state
│   ├── runs
│   ├── checkpoints
│   ├── jobs and budgets
│   └── temporary workspaces
│
└── revision 2 execution state
    ├── runs
    ├── checkpoints
    ├── jobs and budgets
    └── new revision-owned workspaces
```

All of these areas will initially live on one deployment-owned PVC. A common physical volume does not make their ownership identical: shared product state must use stable deployment identity, while execution records and workspaces must carry immutable creating-revision identity.

### 7. Required Invariants

#### A. One active writer revision

At most one revision may accept new user work for a logical deployment at a time.

Without this rule, revision 1 and revision 2 could both append messages, mutate memory, or derive summaries concurrently. Ordering would become ambiguous, and each model could make decisions from a different view of the shared conversation.

A stable Service or route switching traffic is not, by itself, a sufficient correctness guarantee. Connections may remain open, retries may reach an old instance, and a stale worker may continue background work. The control plane needs a durable generation, lease, or fencing token that makes stale writers fail at the persistence boundary.

#### B. Revision-bound recovery

A checkpoint may be resumed only by a runtime whose deployment ID, revision, configuration hash, and compatible runtime/schema identity match the checkpoint owner.

#### C. Conversation continuity

After a successful compatible rollout, the new active revision must load the previously committed thread and message history before accepting new work.

#### D. No hidden state reinterpretation

When a persisted format or semantic contract changes, startup or migration must recognize that change explicitly. A new binary must not silently decode old state into a different meaning.

#### E. Idempotent migration and projection

Any copy, migration, or projection used during rollout must be safe to retry after an uncertain failure. Stable identifiers and recorded migration progress are required to avoid duplicates or partial ownership.

#### F. Forward-only restoration must respect data compatibility

AgentFlow never moves desired state backward to an old revision. Selecting older configuration publishes it as a new revision with a new unique revision ID. That new revision sees the deployment's current shared conversations, memory, and retained files; it does not receive a historical data snapshot. Persistent migrations must therefore be forward-only, idempotent, and readable by the runtime version being deployed.

### 8. Rollout Implications

A state-preserving rollout cannot be only “mount the old directory and remove the hash check.” Under the accepted one-pod `Recreate` topology, a safe high-level sequence is:

1. Record revision 2 as the desired revision with a new deployment generation.
2. Validate the exact bundle, environment requirements, provider availability, PVC identity, and storage compatibility.
3. Stop admitting work to revision 1 and allow only the bounded shutdown/drain policy.
4. Terminate the old pod so it can no longer write the PVC.
5. Mount the same deployment-owned PVC into the replacement pod.
6. Run only forward, idempotent persistent-format migrations.
7. Bind shared state to stable deployment identity and new execution state to revision 2.
8. Mark unfinished revision-1 execution state non-adoptable by revision 2.
9. Start revision 2 and verify application readiness.
10. Route the stable Service to the new ready pod and record observed state.

The ownership transfer must remain explicit and observable even though Kubernetes `Recreate` prevents intentional pod overlap.

### 9. Forward Restoration Is Not Data Rollback

Immutable bundles make it possible to republish the content of an older revision, but the result is still a new forward revision with a new unique revision ID. It mounts the same PVC and therefore sees the latest committed shared state.

For example:

```text
revision 7 writes conversation C and memory M
revision 8 adds newer messages and updates M
the user republishes revision 7's configuration as revision 9

revision 9 configuration = copied from revision 7
revision 9 shared data    = current data after revision 8
revision 9 execution      = fresh revision-9 execution ownership
```

AgentFlow does not automatically rewind conversations, memory, or scratchpads to their revision-7 contents. Snapshot restore, if added later, would be an explicit data-recovery operation with separate authorization and observability.

### 10. In-Flight Work During Rollout

The accepted boundary is: stop admitting new work, allow a bounded graceful shutdown, and then replace the pod. Work that does not finish before termination remains historical revision-1 execution state. Revision 2 must not reclaim its jobs or resume its checkpoints, even when revision 2 happens to contain configuration identical to revision 1.

The exact user-visible status for interrupted work and the final drain duration still require implementation-level design. Those details affect checkpoint status, message ordering, tool idempotency, and error reporting, but they do not change the non-adoption rule.

### 11. Scratchpad Preservation Versus Ownership

The stable PVC preserves existing scratchpad files across revisions. Preservation means the replacement revision does not delete or overwrite those files merely because configuration changed.

The current path is keyed by synthetic user ID and originator run ID. That makes a scratchpad a workspace of a particular task tree, not automatically a shared document that a later revision should place into current model context. The required behavior is therefore:

```text
old scratchpad bytes remain on the PVC
  -> old revision/run ownership remains recorded
  -> new revision does not resume or mutate the old workspace as its own
  -> future export, inspection, retention, or promotion APIs may expose it deliberately
```

This distinction prevents accidental execution-state adoption while honoring the product requirement that a deployment update must not erase prior scratchpad work. Retention limits and a user-facing artifact/promotion contract remain future product work.

### 12. Summary Compatibility

Thread summaries are caches of conversation meaning, not the authoritative conversation itself. A summary can depend on:

- the summarization prompt;
- the summarization model;
- token limits and compaction policy;
- message-selection rules; and
- the schema used to store summary metadata.

Revision 2 may reuse an existing summary when the summary contract is compatible. Otherwise, it should invalidate or regenerate the summary from preserved messages. Preserving messages is therefore the critical guarantee; preserving every derived summary is not.

### 13. Accepted Physical Storage Boundary

Managed hosting will initially use one PVC per logical deployment. The PVC is stable across revision, generation, and configuration-hash changes. It may physically contain one or several SQLite databases and multiple directories; that internal layout is an implementation choice, provided shared and revision-owned records cannot be confused.

This chooses physical reuse without choosing unsafe semantic reuse. Merely opening today's unchanged `state.db` from a different hash remains invalid because today's singleton binding, hash-derived user identity, unlabelled execution tables, and filesystem paths do not express the required ownership model.

### 14. Recommendation

Do not begin by deleting or weakening the existing deployment-identity guard. The guard is exposing a real semantic boundary.

Proceed in this order:

1. Preserve the immutable bundle and revision identity model.
2. Add explicit deployment ID, revision, configuration hash, and generation ownership to persisted state that participates in rollout.
3. Separate repository contracts for deployment-scoped durable state from revision-scoped execution state.
4. Define fencing and one-active-writer semantics at shared persistence.
5. Keep those stores on the one stable deployment-owned PVC and choose the simplest safe internal layout.
6. Design an idempotent migration/projection path for existing standalone state.
7. Only then add PVC creation and change runtime composition and live reconciliation.

This keeps the safe part of the current model—explicit artifact identity—while allowing selected user data to outlive routine agent revisions.

### 15. Consequences

#### Benefits

- Users retain conversation continuity during ordinary agent updates.
- Deliberately accumulated memory remains valuable across compatible revisions.
- Old checkpoints and jobs cannot silently execute under changed behavior.
- Rollout and rollback responsibilities become explicit.
- Storage lifetime follows domain meaning instead of directory layout.
- A future reconciler can report which revision owns each execution record.

#### Costs

- Storage and repository composition become more complex.
- A durable writer-fencing mechanism is required.
- Schema and semantic compatibility need versioning and tests.
- Deployment updates require a defined in-flight-work policy.
- Rollback needs data compatibility analysis, not just workload replacement.
- Existing local state will eventually need a migration path.

### 16. Confirmed, Decided, and Still Open

**Confirmed by the current repository:**

- one standalone process consumes one immutable bundle;
- the entire SQLite data directory is bound to deployment ID, configuration hash, and synthetic user identity;
- a new configuration hash produces a new synthetic user identity;
- SQLite, filesystem memory, scratchpads, and the in-process bus support a single-process runtime model;
- no cross-revision migration or shared-state controller currently exists; and
- no deployment reconciler currently enforces an active revision or writer generation.

**Decided as the working product direction:**

- conversations should survive compatible revision updates;
- intentionally retained long-term memory should survive compatible revision updates;
- execution state must remain owned by its creating revision; and
- existing scratchpad files must remain physically preserved, while their old run ownership prevents automatic adoption.

**Still open:**

- the Kubernetes namespace and tenant-isolation model;
- the internal one-PVC database/directory layout;
- the exact bounded drain duration and user-visible terminal status for interrupted work;
- the export, retention, and optional promotion contract for preserved scratchpad artifacts;
- summary compatibility and invalidation metadata;
- backup, retention, deletion, and privacy policy;
- the migration path for existing standalone directories;
- the concrete fencing mechanism that prevents stale revisions from writing.

### 17. Transition to the Runtime-Topology Decision

The orchestration target and runtime unit are resolved by Deployment Architecture Decision 2 below: managed hosting will run only on Kubernetes, and one complete single-agent or multi-agent deployment graph will run in exactly one pod. Deployment Architecture Decision 9 later fixes the stable-PVC product contract and records the repository changes required to implement it.

Only after those remaining guarantees are explicit should the deployment-state schema, API, reconciler interface, or Kubernetes resource implementation be changed.

## Deployment Architecture Decision 2: Kubernetes-Only, One Pod per Agent Graph

### 1. Decision Status

**Status:** Accepted as the managed-hosting topology.

The decision has three parts:

1. AgentFlow-managed hosting will target Kubernetes only.
2. The deployment unit is one complete published agent graph, not one pod per internal agent.
3. Each deployed graph has exactly one runtime pod; horizontal pod replication is not part of the current architecture.

Bundle download remains an export capability. A user may operate the standalone runtime elsewhere, but AgentFlow's own managed control plane will not implement generic orchestration drivers for non-Kubernetes platforms.

### 2. Product Boundary: Publish, Export, and Deploy

The three operations have different responsibilities:

```text
Publish
  -> freeze mutable Studio configuration into an immutable revision

Export
  -> download the exact published bundle for inspection or self-hosting

Deploy
  -> ask AgentFlow's Kubernetes control plane to run one published revision
```

Publishing must not silently modify a live workload. A user can publish several revisions, inspect them, export them, and deliberately select one for managed deployment. Restoring older content creates a new forward revision with provenance pointing to the historical source; desired deployment state never moves backward to an older revision number.

This preserves the existing artifact boundary while adding managed operation around it.

### 3. What “One Pod per Agent or Multi-Agent System” Means

The Kubernetes unit follows the published root-agent graph:

```text
Single-agent publication
└── runtime pod
    └── root agent

Multi-agent publication
└── runtime pod
    ├── root agent
    ├── delegate agent A
    ├── delegate agent B
    └── any other reachable delegates frozen into the bundle
```

The word **agent** can otherwise be ambiguous. In authoring, each root or delegate is an agent record. In deployment, the logical product is the root plus every reachable delegate required to execute it. Decision 2 calls that complete unit an **agent graph** or **logical deployment**.

If three unrelated root graphs are deployed, Kubernetes runs three runtime pods. If one root graph contains ten collaborating agents, all ten execute inside one runtime pod.

### 4. Why Internal Agents Do Not Become Separate Pods

The existing standalone runtime composes the entire bundle into one process:

- the bundle-backed agent reader holds every frozen agent definition;
- the in-process message bus routes dispatch and cancellation;
- worker pools execute root and delegated runs;
- synchronous delegation waits through in-process coordination;
- the asynchronous job coordinator shares the same process context;
- SQLite stores the graph's threads, runs, checkpoints, tasks, and jobs; and
- filesystem memory and scratchpads are mounted into that process.

Putting each delegate in a separate pod would not be a packaging change. It would require a distributed message bus, distributed cancellation, durable cross-pod dispatch, network authentication between agents, remote event ordering, distributed task-budget enforcement, and independent state ownership. None of those contracts exists today.

Keeping the graph inside one pod therefore preserves the execution model already proven by the standalone composition instead of disguising a distributed-systems redesign as deployment work.

### 5. Why the Replica Count Is Exactly One

The runtime currently relies on process-local and node-local coordination:

- an in-process bus;
- in-process worker-pool ownership;
- in-process scratchpad locks;
- local SQLite state;
- local filesystem memory and scratchpads; and
- process-scoped cancellation registries and coordinator loops.

Two replicas receiving traffic for the same logical deployment could load different local state, admit competing thread operations, run separate coordinators, and write incompatible filesystem views. A Kubernetes Service balancing traffic across them would create the appearance of scale without a shared consistency model.

The required workload contract is therefore:

```yaml
spec:
  replicas: 1
  strategy:
    type: Recreate
```

The controller must enforce this value rather than treating it as a user-adjustable setting. A HorizontalPodAutoscaler must not target runtime workloads under this architecture.

Concurrency still exists inside the pod. The runtime can process several operations through its worker pools and concurrent tool execution, subject to CPU, memory, provider, storage, and configured execution limits. Kubernetes replica count and application concurrency are different controls.

### 6. Kubernetes Resource Shape

The initial managed deployment should have these logical resources:

```text
Logical AgentFlow deployment
├── Deployment with replicas = 1 and strategy = Recreate
├── stable ClusterIP Service
├── persistent storage selected by the state design
├── Secret references for runtime and provider credentials
├── Config/metadata identifying revision, hash, and generation
├── NetworkPolicy
└── optional ingress or Gateway API route
```

The workload should be a Kubernetes `Deployment`, not initially a `StatefulSet`:

- the stable network identity belongs to the Service;
- the controller and persistent data store own durable deployment identity;
- the runtime does not require a stable pod hostname or ordinal;
- exactly one pod is needed; and
- `Recreate` expresses the non-overlapping update requirement directly.

A StatefulSet would become justified only if stable pod identity, ordered replicas, or StatefulSet-owned volume claims solve a concrete future requirement. None of those is currently required.

### 7. Stable Service, Replaceable Pod

Clients should address a logical deployment through a stable endpoint. They must not need to know the current revision, pod name, or configuration hash.

```text
Client
  -> stable deployment hostname/route
  -> stable Kubernetes Service
  -> the one ready runtime pod
```

The Service selector should identify the logical deployment and active generation. Revision and hash remain labels/annotations for traceability and controller decisions.

During a `Recreate` update, the old pod terminates before the new pod becomes ready. The Service temporarily has no ready endpoint. This is expected downtime, not evidence that Kubernetes failed to perform a rolling update.

### 8. Revision-Update Lifecycle

The intended high-level sequence is:

1. The user selects a published revision for deployment.
2. The control plane records a new desired generation.
3. The controller validates the exact revision and builds verified runtime inputs.
4. The controller resolves required secrets and storage prerequisites.
5. The active runtime stops accepting new work.
6. Existing work follows the separately chosen drain/interruption policy.
7. Kubernetes terminates the old pod.
8. Persistent storage becomes available to the replacement pod.
9. The pod obtains the exact selected bundle and verifies its hash.
10. Runtime startup validates environment, providers, tools, and storage compatibility.
11. The runtime recovers only execution state owned by that revision under Decision 1.
12. `/readyz` succeeds.
13. The stable Service gains the new ready endpoint.
14. The controller records observed revision, hash, generation, and health.

There is no period in which old and new runtime pods are both active writers. This is the central reason `Recreate` fits the accepted topology.

### 9. Pod Failure and Restart

Exactly one desired replica does not mean the deployment disappears permanently after a crash. The Kubernetes Deployment controller creates a replacement pod when the process exits or the node is lost.

Recovery then depends on storage:

- a replacement pod with the correct durable state can recover orphaned runs according to runtime rules;
- a pod using only ephemeral storage loses SQLite, memory, and scratchpad state;
- a volume that cannot attach on the replacement node delays recovery; and
- corrupted or incompatible state should fail startup and readiness rather than silently starting empty.

Kubernetes restores the process. It does not by itself guarantee application-state correctness. Persistent storage, identity checks, migrations, backups, and runtime recovery remain AgentFlow responsibilities.

### 10. Persistence Implications

The one-pod rule simplifies the active-writer problem but does not eliminate the state split defined in Decision 1.

The physical design must still distinguish:

```text
deployment-scoped durable state
  -> conversations, durable memory, promoted artifacts

revision-scoped execution state
  -> runs, checkpoints, jobs, temporary workspaces
```

A single Kubernetes PVC could physically contain both areas for an initial design, provided their identities and repository contracts remain logically separated. The replacement pod would mount the volume only after the old pod terminates.

Simply mounting the current undivided data directory into a new-hash pod will not work: the existing deployment-identity binding intentionally rejects it. Removing that validation without separating ownership would allow a new revision to adopt incompatible checkpoints and jobs.

### 11. Resource and Capacity Model

CPU and memory requests/limits apply to the complete graph. A delegate that performs heavy work competes with its parent and sibling delegates inside the same cgroup.

The controller will eventually need either:

- a fixed runtime resource profile;
- a small catalogue of approved sizes; or
- validated per-deployment resource settings.

Arbitrary user-supplied Kubernetes resource specifications should not be the first contract. They would expose scheduling, denial-of-service, cost, and cluster-policy concerns directly through the product API.

Because replicas remain one, increasing capacity means vertical scaling, internal concurrency tuning, provider/tool backpressure, or splitting an agent graph into separately deployed products by an explicit architectural change. Kubernetes autoscaling cannot repair an application-level bottleneck hidden inside one local SQLite database.

### 12. Failure Boundary

One pod makes the whole graph one failure domain:

- a process crash interrupts root and delegated work;
- out-of-memory termination affects every internal agent;
- a blocked shared dependency can degrade the complete graph;
- startup validation failure keeps the entire deployment unready; and
- node/volume problems make the whole deployment unavailable until replacement succeeds.

This is an accepted simplicity trade-off. The benefit is that delegation, cancellation, budgets, checkpoints, and message ordering remain within the execution model the code already implements.

Independent scaling or fault isolation for one internal delegate would require a later distributed-runtime architecture decision, not an adjustment to the pod count.

### 13. Security Boundary

Each logical deployment receives a distinct pod-level workload boundary. The pod should:

- run as a non-root user;
- use a read-only root filesystem where practical;
- mount only its own storage and required secrets;
- disable Kubernetes service-account token automount unless a concrete need appears;
- have no permission to create, list, or modify Kubernetes resources;
- use resource limits;
- receive only the provider and MCP credentials required by its bundle;
- follow an explicit outbound NetworkPolicy; and
- expose traffic only through the managed Service/ingress path.

The deployment controller, not the runtime pod, owns Kubernetes API privileges. This separates infrastructure authority from agent/tool execution. A compromised runtime should not be able to deploy new workloads or read other deployments' secrets.

Namespace strategy remains open. A shared runtime namespace is operationally simpler; per-tenant or per-deployment namespaces offer additional policy and quota boundaries but create more resources and lifecycle work. Kubernetes namespaces alone are not a complete hostile-multitenancy security boundary.

### 14. Control Plane and Data Plane

Managed hosting introduces two operational roles:

| Control plane | Runtime/data plane |
| --- | --- |
| Studio API and authentication | One standalone runtime pod |
| Published revisions | One immutable selected bundle |
| Desired deployment generation | Agent/tool execution |
| Kubernetes reconciliation | Runtime HTTP API and SSE |
| Secret/storage/network provisioning | SQLite/filesystem or future runtime persistence |
| Rollout and rollback decisions | Health, readiness, and graceful shutdown |
| Observed deployment status | No Kubernetes provisioning privileges |

The controller should run separately from request handlers. An HTTP request records desired state and returns an accepted operation/status resource; it should not hold the user connection open while Kubernetes schedules a pod, attaches a volume, downloads a bundle, and waits for readiness.

MongoDB is the product-level source of truth: it stores owner-scoped publication revisions plus version-2 desired, observed, and reconciliation state. Kubernetes resources will represent infrastructure derived from that durable intent. The design must avoid making MongoDB and a Kubernetes custom resource two independent desired-state authorities.

### 15. Controller Requirements

The Kubernetes controller/reconciler must eventually:

1. atomically claim due generation work using the implemented token and lease contract;
2. load the owner-scoped desired target and immutable revision;
3. build and verify exact runtime inputs;
4. calculate deterministic Kubernetes resource identity;
5. materialize or make the bundle fetchable;
6. reference only the required Secrets;
7. create/update the Deployment, Service, storage, and policy resources;
8. enforce `replicas: 1` and `Recreate` even after configuration drift;
9. observe pod scheduling, startup, readiness, termination, and failure;
10. preserve the implemented separation between desired, observed, and processed generation;
11. use durable retry scheduling and fenced writes after process restarts or API timeouts;
12. avoid deleting a working old deployment before prerequisites for the desired revision are validated where possible;
13. expose meaningful rollout status to Studio; and
14. clean up retired resources only after the retention/rollback policy allows it.

Kubernetes API success does not mean deployment success. Creating a Deployment object only proves that the API server accepted desired infrastructure. The controller must continue until the expected revision is observed and ready or a durable failure condition is recorded.

### 16. Desired and Observed Status

The version-2 deployment state now distinguishes:

```text
desired revision/hash/generation

observed revision/hash/generation

phase
  -> pending
  -> provisioning
  -> starting
  -> ready
  -> degraded
  -> failed
  -> deleting
  -> deleted

conditions/error information
last transition and reconciliation timestamps
runtime endpoint identity
```

The desired fields express user intent. Observed fields express what a controller has actually verified. Reconcile fields hold due time, attempts, processed generation, and the current claim. The data model and atomic MongoDB transitions now exist; the controller that produces real Kubernetes observations does not.

### 17. Alternatives Rejected for the Initial Architecture

#### One pod per internal delegate

Rejected because it requires distributed dispatch, cancellation, budgets, state, authentication, and event ordering that do not exist.

#### Multiple replicas behind one Service

Rejected because local SQLite, filesystems, the in-process bus, and process-local coordination do not provide shared multi-replica semantics.

#### HorizontalPodAutoscaler

Rejected because changing pod count would violate the single-writer and local-state model.

#### StatefulSet by default

Rejected because stable pod ordinal/network identity is not a present requirement. Durable storage can be managed explicitly while a stable Service owns network identity.

#### Generic orchestrator abstraction

Rejected because managed hosting is Kubernetes-only. An interface designed for hypothetical ECS, Nomad, or VM implementations would add indirection without protecting a required boundary.

#### Blue-green active pods

Rejected for the first version because the decision permits only one runtime pod per logical deployment and shared durable state has no distributed fencing implementation.

### 18. Consequences

#### Benefits

- The managed topology matches the existing standalone execution model.
- Multi-agent delegation stays local and avoids premature distributed coordination.
- One active writer makes conversation and memory continuity easier to reason about.
- Kubernetes can restart a failed process without creating multiple active replicas.
- Stable Services hide pod and revision replacement from API clients.
- Runtime pods remain isolated from Kubernetes infrastructure authority.
- Reconciliation has one concrete platform contract instead of a generic provisioner abstraction.

#### Costs

- Revision updates have an availability gap.
- One pod is a single runtime failure and capacity boundary.
- Internal delegates cannot scale or fail independently.
- Vertical resource limits must cover the complete graph.
- Persistent-volume attachment affects restart time and node mobility.
- Cross-revision state still requires repository and migration redesign.
- A future multi-replica architecture would require a substantial persistence and coordination change.

### 19. Confirmed, Decided, and Still Open

**Confirmed by the current repository:**

- one standalone process loads the complete published graph;
- root and delegate execution use process-local coordination;
- persistence uses local SQLite plus filesystem state;
- health, readiness, signal handling, and graceful shutdown already exist;
- deployment resource naming anticipates Kubernetes-compatible identities; and
- a runtime image definition, bundle materializer, and pure Kubernetes Deployment/Service renderer now exist; and
- no Kubernetes client, live controller, desired-state schema, cluster apply path, or reconciler currently exists.

**Decided:**

- AgentFlow-managed hosting is Kubernetes-only;
- bundle download remains available for export/self-hosting;
- one complete root/delegate graph maps to one pod;
- the runtime replica count is exactly one;
- internal delegates do not become Kubernetes workloads;
- runtime workloads do not use horizontal pod autoscaling;
- initial revision updates use non-overlapping `Recreate` behavior; and
- a stable Service represents the logical deployment endpoint.

**Still open:**

- Kubernetes namespace and tenant-isolation policy;
- PVC, Secret, and external-route naming and ownership rules beyond the now-defined stable Deployment/Service name;
- runtime image publication, provenance/signing, release compatibility, and registry policy beyond the existing image build definition;
- implementation of the internal bundle endpoint and scoped delivery-token issuer for the now-decided bundle-delivery mechanism;
- physical storage split and migration from the current single SQLite directory;
- volume class, access mode, snapshots, backup, and restore;
- in-flight-run behavior during `Recreate` updates;
- secret ownership, encryption, injection, and rotation;
- ingress/Gateway API, TLS, hostname, and external authentication;
- production resource-size profiles, quotas, and capacity evidence beyond the renderer's initial fixed profile;
- controller leader election, work claiming, and retry timing;
- desired/observed status schema;
- retired revision and volume retention; and
- operational metrics, alerts, and support procedures.

### 20. Next Architecture and Implementation Boundary

The next design should define the smallest end-to-end Kubernetes deployment slice without pretending that all remaining production concerns are solved. It must decide:

1. where the controller runs and how it claims reconciliation work;
2. which existing MongoDB record is desired-state authority and how generation changes are represented;
3. how the exact bundle reaches the pod despite Kubernetes object-size limits;
4. how the runtime image is built and versioned;
5. which Kubernetes objects the controller owns;
6. how readiness becomes observed deployment status; and
7. what can be implemented safely before cross-revision state continuity is complete.

Implementation should begin only after that vertical slice and its deliberately deferred concerns are reviewed and approved.

## Deployment Architecture Decision 3: Verified Bundle Handoff and Initial Kubernetes Workload Contract

### 1. Decision Status

**Accepted and foundation implemented.**

This decision defines how one exact published bundle reaches one AgentFlow-managed Kubernetes pod and what the first renderable Deployment and Service must contain.

The foundation implementation includes:

- a `materialize-bundle` command in the standalone runtime binary;
- a pure Go renderer for a Kubernetes Deployment and Service;
- a deterministic stable name for those two logical resources;
- an init-container-to-runtime bundle handoff through an `emptyDir` volume;
- references to caller-provided delivery-token, runtime-secret, and deployment-state resources; and
- focused tests describing the intended security and topology contract.

It does **not** yet include a live bundle HTTP endpoint, token issuer, Kubernetes client, reconciliation loop, PVC or Secret creation, public deployment API, MongoDB desired/observed status schema, routing, or cluster-side execution. The renderer produces typed objects in memory; no code in this phase sends them to a Kubernetes API server.

### 2. The Problem This Decision Solves

A published AgentFlow deployment bundle can be as large as 12 MiB. A runtime pod must receive the exact selected bytes before it starts, but those bytes must not be confused with normal environment configuration.

There are four different concerns:

1. **Identity:** which published revision and hash did the user select?
2. **Delivery:** how do the bytes reach a newly scheduled pod?
3. **Integrity:** how does the pod know it received the intended bundle rather than merely valid JSON?
4. **Secret separation:** how do delivery credentials and runtime provider credentials avoid leaking into components that do not need them?

Without an explicit boundary, it would be easy to mount mutable configuration, place a large artifact into a Kubernetes object, expose a broad database credential to the runtime, or start the server before the bundle is verified.

### 3. Artifact, Credential, and Runtime State Are Different Things

The workload has three categories of input:

| Input | Purpose | Lifetime | Consumer |
| --- | --- | --- | --- |
| Published bundle | Immutable agent-graph definition | One selected revision | Init container, then runtime as a read-only file |
| Delivery token | Authorizes one bundle download scope | Short-lived and replaceable | Init container only |
| Runtime secrets | Provider, MCP, and runtime API credentials | Runtime lifecycle, independently rotatable | Main runtime container only |
| Runtime state | SQLite, memory, scratchpads, and other writable execution data | Revision-owned in the first implementation | Main runtime container only |

Keeping these separate matters. A bundle is not a secret store. A delivery token is not a provider credential. A provider credential must not authorize bundle retrieval. Writable runtime state must not be mixed into the immutable configuration handoff.

### 4. Accepted Delivery Shape

The accepted startup flow is:

```text
Kubernetes schedules one pod
  -> init container starts using the runtime image
  -> init reads a mounted delivery token
  -> init performs one authenticated HTTPS GET to the internal artifact endpoint
  -> init enforces the 12 MiB response limit
  -> init parses and statically validates the bundle
  -> bundle verifies its own canonical config_hash
  -> init compares that hash with the controller-supplied expected hash
  -> init atomically writes bundle.json with mode 0600 into an emptyDir
  -> init exits successfully
  -> main runtime container starts
  -> runtime mounts the same emptyDir read-only
  -> runtime loads and verifies bundle.json again
  -> runtime opens the deployment-owned PVC through revision-aware storage boundaries
  -> /readyz becomes successful only after startup completes
```

Kubernetes does not start ordinary containers until every init container succeeds. The init container is therefore a startup gate: an unavailable endpoint, rejected token, oversized body, malformed bundle, or hash mismatch prevents the runtime from starting with an uncertain configuration.

### 5. Why the Bundle Is Not a ConfigMap or Secret

ConfigMaps and Secrets are API-server objects intended for relatively small configuration and credential material. A 12 MiB bundle is too large for the normal Kubernetes object-size path and would also create undesirable pressure on API-server and etcd storage.

A Secret would additionally give the wrong semantic signal. The published bundle may describe model choices, prompts, tool definitions, and graph structure, but it should not contain provider keys. Marking the complete artifact as a Secret would not fix credential design and would still retain the size problem.

The internal artifact endpoint keeps large immutable bytes out of Kubernetes object storage while allowing Kubernetes objects to carry only identity, URL, hash, and Secret references.

### 6. Why the Bundle Is Not Baked Into the Runtime Image

The runtime image and deployment bundle have different release lifecycles:

- the image contains executable runtime code and operating-system dependencies;
- the bundle contains one user's published agent graph;
- many deployments should be able to use the same verified image digest; and
- selecting or rolling back a published revision should not require building a new image.

Baking each bundle into an image would multiply image builds, couple content publication to the container supply chain, increase registry churn, and obscure whether a behavior change came from runtime code or configuration.

The accepted design therefore pins the runtime executable by image digest and the agent graph by canonical bundle hash independently.

### 7. Why the Runtime Does Not Read MongoDB Directly

MongoDB currently stores publication data, but giving every runtime pod database credentials would cross an unnecessary trust boundary. A compromised runtime could potentially query data beyond its own selected artifact unless a new narrow database authorization model were built.

The internal artifact endpoint can enforce product ownership and revision selection centrally, issue a much narrower delivery capability, record an audit event, and return only the exact bytes needed by one deployment startup. The runtime pod receives no MongoDB credential for this purpose.

### 8. Delivery Authentication Contract

The renderer expects a Kubernetes Secret whose `token` key is mounted only into the init container. The materializer sends it as:

```http
Authorization: Bearer <delivery-token>
Accept: application/json
```

The token is read from an absolute file path, is bounded to 8 KiB, must be non-empty visible ASCII, and cannot contain whitespace or control characters. It is never accepted as a command-line argument or URL query parameter because those locations are more likely to appear in process listings, manifests, access logs, and diagnostic output.

The final token issuer is not implemented yet. Its future contract should make a token:

- scoped to one owner, logical deployment, selected revision, and expected hash;
- short-lived;
- unusable for listing or downloading other artifacts;
- revocable or naturally expiring;
- safe to validate without logging its raw value; and
- observable through token-identifier or request metadata that does not reveal the credential.

The bundle URL is a trusted controller-produced input, not user-supplied arbitrary egress. The final controller and artifact-endpoint configuration must constrain it to the internal artifact origin; HTTPS validation alone is not a complete SSRF or credential-exfiltration defense.

### 9. Integrity Has Two Checks

The materializer does not treat successful HTTP as proof of correctness.

First, `deployment.Parse` recalculates the canonical hash represented by the bundle and compares it with the `config_hash` declared inside the JSON. This detects corruption or a bundle that lies about its own contents.

Second, the materializer compares that verified bundle hash with the expected hash placed in the pod specification by the controller. This detects a valid but wrong bundle—for example, if the endpoint returns revision 6 while the pod is intended to start revision 7.

These checks answer different questions:

```text
Internal bundle hash check
  -> Do these bytes truthfully describe their own canonical content?

Expected hash check
  -> Are these the exact bytes the controller intended this pod to run?
```

Both are necessary. A cryptographically consistent artifact can still be the wrong artifact.

### 10. Download and Filesystem Safety

The materializer enforces the following boundary rules:

- only an absolute HTTPS URL is accepted;
- URL user information, query parameters, and fragments are rejected;
- HTTP redirects are not followed, preventing the bearer token from being forwarded to a different destination;
- the complete HTTP operation has a 30-second timeout and is cancelled when the container receives termination signals;
- declared and streamed response sizes are both limited to 12 MiB;
- only HTTP `200 OK` is accepted;
- the output and token paths must be absolute;
- the response is fully parsed and verified before the destination changes;
- a temporary file is created in the destination directory;
- the temporary file is restricted to mode `0600`;
- bytes and directory metadata are synchronized before completion; and
- rename replaces the destination atomically on the same filesystem.

Writing in the destination directory is important because an atomic rename is only reliably available within one filesystem. If verification or writing fails, an existing verified destination is preserved rather than being partially overwritten.

The runtime verifies the file again during its normal `serve` startup. That second verification is intentional defense in depth: it keeps the runtime's local file contract safe even when the file arrived through another supported path such as bundle export and self-hosting.

### 11. Pod Volume and Credential Boundaries

The rendered pod uses four mounts:

```text
bundle emptyDir
  init:    read-write at /var/run/agentflow/bundle
  runtime: read-only  at /var/run/agentflow/bundle

delivery-token Secret
  init:    read-only at /var/run/secrets/agentflow-delivery
  runtime: not mounted

deployment state PVC
  init:    not mounted
  runtime: read-write at /var/lib/agentflow

temporary emptyDir
  init:    not mounted
  runtime: read-write at /tmp
```

The bundle `emptyDir` belongs to the pod and survives the transition from init to main container, but disappears when that pod is removed. This is acceptable because MongoDB/artifact storage—not the pod—is the source of truth for the immutable published bundle. A replacement pod repeats verified materialization.

The delivery token is deliberately absent from the runtime container. After materialization, the main process has no reason to download arbitrary revisions. Reducing credential lifetime and reach limits the result of a runtime compromise.

The Secret file uses mode `0440`, not `0400`. Kubernetes applies the pod filesystem group to the mounted volume, so group-read permission is required for the non-root init process while write and world access remain disabled.

### 12. Runtime Secret Injection

The main runtime receives:

- `RUNTIME_AUTH_MODE=bearer` as a controller-owned literal;
- `RUNTIME_API_TOKEN` from a named runtime Secret; and
- only the additional provider or MCP environment-variable names explicitly supplied by trusted control-plane logic.

The renderer never imports every key from a Secret through `envFrom`. Explicit `secretKeyRef` entries make the manifest reviewable and prevent an unrelated key added to a shared Secret from silently becoming available inside the runtime.

Names are syntax-validated, deduplicated, sorted for deterministic output, and rejected when they could override controller or process behavior. Reserved names include runtime authentication, Go runtime tuning, proxy/TLS behavior, `PATH`, Kubernetes-injected variables, and the `AGENTFLOW_` namespace.

The renderer assumes the referenced Secret and keys already exist. Secret creation, encryption policy, rotation, ownership, and missing-key status reporting belong to the future reconciler and secret-management design.

### 13. Stable and Revision-Specific Identity

The Deployment and Service share one stable DNS-label name:

```text
af-<sanitized-deployment-id>-<20-hex-owner-and-deployment-hash>
```

The readable middle helps operators. The 80-bit hash suffix includes both owner and deployment identity, which makes accidental cross-owner collisions negligible while leaving up to 40 characters for the readable deployment portion. The full name is bounded to Kubernetes' 63-character DNS-label limit.

The stable Service selects only stable logical-deployment labels. Revision and config hash are pod metadata, not Service selectors. Therefore changing revision does not require changing the client-visible Service identity.

The pod template carries the full hash, revision, generation, and schema version as annotations. A short hash and revision are also labels for operational discovery. A changed pod template causes Kubernetes to replace the pod while preserving the logical Deployment and Service names.

### 14. One-Pod Deployment Contract

The rendered Deployment fixes the following policy:

```yaml
replicas: 1
strategy:
  type: Recreate
```

This is controller policy, not user customization. `Recreate` prevents an intentional rollout from running old and new runtime pods concurrently. It matches the local SQLite, local filesystem, process-local bus, and single-active-writer constraints described in Decision 2.

The Service is a stable `ClusterIP` resource exposing port 80 and forwarding to the runtime's named HTTP port 8080. External ingress, hostname, TLS termination, and end-user authentication remain separate future boundaries.

### 15. Runtime Hardening in the Rendered Pod

The pod and both containers use an initial restricted profile:

- non-root UID and GID `10001`;
- filesystem group `10001` for mounted storage;
- runtime-default seccomp;
- no privilege escalation;
- read-only container root filesystems;
- all Linux capabilities dropped;
- Kubernetes service-account token automount disabled;
- Kubernetes service-link environment injection disabled;
- bounded CPU and memory requests/limits; and
- bounded `emptyDir` volumes for the bundle and `/tmp`.

The runtime receives writable locations only for revision state and `/tmp`. These controls reduce accidental writes and container-escape surface, but they are not a complete sandbox. The later deployment layer still needs NetworkPolicy, namespace/tenant policy, admission controls, image verification, node isolation decisions, and an explicit tool-execution threat model.

### 16. Health and Startup Behavior

The main container uses:

- a startup probe on `/readyz`, allowing slow initialization without premature liveness restarts;
- a readiness probe on `/readyz`, controlling whether the Service sends traffic; and
- a liveness probe on `/healthz`, restarting a process that is no longer alive.

Readiness and liveness answer different questions. Liveness asks whether restarting may help. Readiness asks whether this instance should currently receive requests. A runtime that is alive but has not validated configuration or opened its state must remain unready.

The probes are part of the pod contract, but the future controller must still interpret rollout status. “Deployment object accepted by Kubernetes” is not equivalent to “selected revision is serving traffic.”

### 17. State and Revision Policy

The renderer accepts a PVC name rather than creating or deriving a PVC. Deployment Architecture Decision 9 now requires that reference to identify the one deployment-owned PVC, whose identity does not include revision, generation, or configuration hash.

The current runtime invariant still binds the undivided SQLite store to an exact configuration hash. Therefore the stable PVC cannot be enabled safely by only changing the name supplied to this renderer. Runtime identity, persistent schemas, execution fencing, and filesystem layout must first implement the logical ownership split.

AgentFlow does not move desired state backward to an older revision. Restoring older configuration creates a new forward revision with provenance pointing at the source revision. It mounts the current deployment PVC and sees current shared data, not a historical snapshot. It must not adopt another revision's checkpoints, jobs, runs, budgets, or workspace ownership, even when the configuration hashes match.

### 18. Pure Rendering Boundary

The Kubernetes package returns typed `apps/v1.Deployment` and `core/v1.Service` objects without reading global configuration or contacting a cluster.

That separation is deliberate:

```text
Future application/reconciler policy
  -> resolves owner, revision, generation, URLs, Secret names, PVC name, and image digest
  -> calls the pure renderer

Pure renderer
  -> validates the concrete workload contract
  -> produces deterministic Kubernetes objects

Future Kubernetes adapter
  -> compares desired and observed objects
  -> applies changes through client-go
  -> observes status and reports conditions
```

The renderer owns the shape and safety invariants of a runtime workload. It does not own database reads, token issuance, Secret contents, PVC lifecycle, retries, leader election, or API-server communication. This keeps policy testable without a cluster while avoiding a fake generic “orchestrator” abstraction.

The implementation uses official `k8s.io/api` and `k8s.io/apimachinery` types at version `v0.35.9`. That is the latest patch selected from the Go-1.25-compatible Kubernetes 0.35 line; the newer 0.37 line requires Go 1.26 and therefore does not fit this module's current `go 1.25.0` contract.

### 19. Determinism and Idempotency

Given the same validated input, the renderer produces the same logical names, selectors, environment ordering, container arguments, mounts, resources, and metadata. Determinism matters because a reconciler repeatedly computes desired state after restarts and transient failures.

The future reconciliation operation should be idempotent:

```text
render desired objects
  -> apply them
  -> process crashes
  -> render the same objects again
  -> apply again without creating a second logical deployment
```

The current code establishes the deterministic input-to-object part. It does not yet establish server-side apply field ownership, conflict policy, work claiming, retry backoff, or desired/observed generation advancement.

### 20. Failure Semantics

Failures occur at distinct boundaries:

| Failure | Immediate result | Future observed-status responsibility |
| --- | --- | --- |
| Delivery Secret or key missing | Pod cannot start init | Report prerequisite/configuration failure |
| Artifact endpoint unavailable | Init retries through pod restart behavior | Report materialization/startup failure with bounded retry policy |
| Token rejected | Init exits non-zero | Report authorization failure without logging token |
| Redirect returned | Init rejects response | Report invalid artifact-endpoint behavior |
| Body over 12 MiB | Init rejects before runtime starts | Report artifact contract violation |
| Bundle parse/hash mismatch | Init rejects before runtime starts | Report integrity/revision mismatch |
| PVC unavailable | Pod remains pending or mount fails | Report storage provisioning/attachment failure |
| Runtime startup validation fails | Main container exits/unready | Report runtime configuration failure |
| Runtime alive but not ready | Service has no ready endpoint | Report starting or degraded, not ready |

Repeated Kubernetes restarts are not themselves a retry policy. The reconciler must eventually classify terminal configuration failures separately from transient network, scheduling, or storage failures so that a bad revision does not loop forever without a useful product-level condition.

### 21. Alternatives Rejected for This Phase

#### Put the bundle in a ConfigMap or Secret

Rejected because the accepted artifact limit is 12 MiB and Kubernetes object storage is the wrong size and lifecycle boundary.

#### Bake a separate image per publication

Rejected because it couples runtime releases to user content, slows publication, and makes rollback/provenance harder to reason about.

#### Give the runtime direct MongoDB access

Rejected because it expands the runtime trust boundary and exposes a broad product database when only one immutable artifact is needed.

#### Mount the delivery token into the main container

Rejected because the token has no runtime purpose after startup and would needlessly remain available to tools or compromised code.

#### Stream the bundle directly into the main process

Rejected for the initial design because startup, retry, file inspection, and the existing `serve --config` contract are clearer when materialization is a separate gated step.

#### Let each workload choose replicas, rollout strategy, arbitrary environment, or arbitrary Kubernetes fields

Rejected because those values encode platform safety and state-consistency policy. Exposing them as user configuration would permit manifests the current runtime cannot safely support.

### 22. What Is Implemented, Decided, and Deferred

**Implemented foundation:**

- runtime `materialize-bundle` command;
- bounded authenticated HTTPS retrieval without redirects;
- independent bundle and expected-hash verification;
- atomic mode-`0600` materialization;
- stable owner-scoped Deployment/Service naming;
- pure typed Deployment and Service rendering;
- one replica with `Recreate`;
- init-only delivery token;
- explicit runtime Secret references;
- stable deployment PVC reference;
- probes, resource limits, and initial security context; and
- focused tests for the materializer and renderer contracts.

**Architecturally decided:**

- internal artifact delivery is the managed-hosting mechanism;
- bundle export remains a separate capability;
- the same immutable runtime image performs init materialization and serving;
- the bundle handoff is an ephemeral pod-local file;
- runtime code receives no delivery credential;
- the runtime image must be digest-pinned; and
- one stable deployment-owned PVC is the accepted target, while state inside it remains logically split between deployment-shared and revision-owned records.

**Deferred:**

- artifact route and authorization implementation;
- delivery-token creation, expiry, revocation, and audit schema;
- desired/observed MongoDB schema and deployment HTTP API;
- Secret and PVC creation/rotation/retention;
- Kubernetes client, server-side apply, reconciliation, and status observation;
- NetworkPolicy and ingress/Gateway resources;
- final namespace and hostile-multitenancy boundary;
- image build publication, signing, SBOM, and admission verification;
- cross-revision data projection/migration;
- drain, interruption, and forward-restoration orchestration;
- production resource sizing and quota policy; and
- real-cluster integration and failure-injection evidence.

### 23. Next Implementation Boundary

The next vertical slice should connect this pure workload contract to durable desired state without immediately giving HTTP handlers Kubernetes responsibility.

The next architecture discussion should decide:

1. the deployment desired/observed MongoDB model and generation rules;
2. the internal bundle route and narrow token contract;
3. who creates and owns runtime Secrets and the stable deployment PVC;
4. the reconciler's work-claiming and retry model;
5. server-side apply field ownership and deletion/retention behavior; and
6. how pod readiness and failure conditions become user-visible deployment status.

Only after those boundaries are explicit should the project add `client-go` or cluster mutations. The present renderer gives that future adapter a concrete, testable desired object rather than mixing policy discovery, database access, and Kubernetes calls into one handler.

## Deployment Architecture Decision 4: Forward-Only Revisions and Explicit Publication Idempotency

### 1. Decision Summary

AgentFlow revision history always moves forward.

If revision 8 is current and a user wants the configuration formerly stored in revision 6, the system must not point deployment state backward to revision 6. It creates revision 9 containing revision 6's configuration, records revision 6 as its source, and deploys revision 9.

```text
revision 6 = configuration A
revision 7 = configuration B
revision 8 = configuration C       currently desired

user restores configuration A

revision 9 = configuration A       source_revision = 6
deployment desires revision 9
```

The resulting history describes what the user asked the platform to do in chronological order. Revision numbers never decrease and an older record is never repurposed as a new event.

### 2. Three Identities That Must Remain Separate

The design has three superficially similar values with different jobs:

| Value | Question answered | Unique? |
| --- | --- | --- |
| Revision number | Which historical publication event is this? | Yes within owner and deployment. |
| Configuration hash | Which exact deployable content does this revision contain? | No. Several revisions may contain identical content. |
| Idempotency key | Is this the same client publication request being retried? | Yes within owner and deployment. |

Confusing these identities causes incorrect behavior.

If configuration hash is treated as revision identity, the system cannot represent an intentional return to earlier content as a new event. If every HTTP attempt is treated as a new event, a lost response followed by a retry can create accidental revisions. Revision and idempotency key solve those two different problems.

### 3. Exact Database Invariants

The revision collection uses these indexes:

```text
UNIQUE     (user_id, deployment_id, revision)
UNIQUE     (user_id, deployment_id, idempotency_key)
NON-UNIQUE (user_id, deployment_id, config_hash)
```

The revision uniqueness constraint is owner-scoped. Revision `1` can exist for many different deployments and owners. It only needs to be unambiguous inside one owner's logical deployment history.

The hash index remains useful even though it is non-unique. Operators and future application logic may still ask which revisions contain a particular artifact. Removing uniqueness does not remove integrity checking: every bundle still carries and verifies its canonical SHA-256 hash.

### 4. What Counts as a New Revision

A new idempotency key means a new publication intention. Therefore:

```text
same content + same idempotency key
    = retry of one intention
    = return original revision

same content + different idempotency key
    = two intentional publication events
    = create two revisions

different content + same idempotency key
    = contradictory replay
    = reject with conflict

different content + different idempotency key
    = two publication events
    = create two revisions
```

This makes the client's intention explicit instead of trying to infer intention from content.

### 5. Publication HTTP Contract

`POST /api/agents/{id}/publish` requires:

```http
Idempotency-Key: <opaque client-generated value>
```

Exactly one header value is required. The accepted value is 1 through 128 visible ASCII bytes with no whitespace or control characters. The bound prevents an attacker or broken client from placing unbounded values in database indexes. Rejecting multiple values, whitespace, and control bytes prevents ambiguous header parsing and log formatting.

The key is not a bearer credential. Possessing it grants no authority. Authentication and owner scoping still come from the normal user JWT boundary.

The response behavior is:

| Situation | HTTP result |
| --- | --- |
| First successful use of key | `201 Created`, new revision. |
| Safe replay of same key and same immutable input | `200 OK`, original revision, `was_existing=true`. |
| Same key reused for different immutable input | `409 Conflict`. |
| Missing or malformed key | `400 Bad Request`. |

The existing `was_existing` response field now means "this idempotency key already completed this publication." It no longer means "some revision somewhere already has this hash."

### 6. Why `X-Request-ID` Is Not Reused

AgentFlow already has an `X-Request-ID` middleware value for tracing. Tracing identity and operation identity should remain different:

- Infrastructure may create or replace a request ID.
- A request ID normally identifies one HTTP attempt.
- An idempotency key must survive a client retry as the same logical operation.
- Logging systems commonly expose request IDs; idempotency keys should not silently inherit tracing semantics.

Using a dedicated header makes retry behavior an intentional API contract.

### 7. Repository Replay Verification

Finding an existing idempotency key is not sufficient on its own. The repository compares the stored immutable input with the replayed input:

- root agent identity;
- optional source revision;
- configuration hash;
- bundle schema version; and
- exact bundle JSON bytes.

Only a complete match is a safe replay. A mismatch returns `ErrRevisionIdempotencyConflict`.

This protects against a client accidentally reusing a key after editing the graph. It also prevents a key collision from silently returning a revision containing different code or configuration.

### 8. Concurrent Append Mechanics

Revision allocation remains optimistic and database-enforced.

Suppose revision 8 is latest and two different requests both propose revision 9:

```text
request A reads latest = 8
request B reads latest = 8

request A inserts revision 9
request B hits unique revision constraint

request B checks whether its idempotency key now exists
    |
    +-- yes and content matches -> idempotent replay
    |
    +-- yes and content differs -> conflict
    |
    +-- no -> revision-number collision; reread latest and try revision 10
```

A MongoDB duplicate-key error does not reveal which logical invariant collided at the repository abstraction level. Looking up the idempotency key distinguishes a same-request race from a revision-number race. The retry loop remains bounded so pathological contention cannot consume resources forever.

### 9. Forward Restoration Provenance

Revision records now have an optional `source_revision` field. Its meaning is:

> This new historical publication was intentionally created from the immutable artifact stored in the referenced earlier revision.

It does not mean the new revision is an alias. Revision 9 remains a complete immutable revision with its own number, timestamp, idempotency key, and stored bundle bytes.

The currently implemented live-graph publication path leaves `source_revision` empty. A future "restore configuration" application operation must:

1. load the requested source revision in the caller's owner scope;
2. copy and verify its exact bundle;
3. append a new revision using a new idempotency key;
4. set `source_revision` to the older revision number; and
5. request deployment of the newly created revision.

The persistence field is present now so the historical model does not need another incompatible shape when that operation is added. The user-facing restore route itself is deliberately deferred.

### 10. Forward Revisions Do Not Eliminate Deployment Generations

Revision and deployment generation still solve different problems.

```text
revision   = immutable configuration history
generation = version of desired deployment intent being reconciled
```

One deployment generation may be retried many times because Kubernetes, storage, or networking is temporarily unavailable. Those retries must not create new revisions. A controller restart or drift repair also reuses the same revision and generation.

Generation fencing is still needed when an old controller attempt finishes after a newer user request. Forward-only revision numbers make history easier to understand, but they do not prove that an asynchronous writer still owns the current reconciliation attempt.

Deletion is another example: deleting a deployment advances desired generation but does not create a configuration revision.

### 11. Legacy Index Migration

Earlier versions used a unique owner-qualified configuration-hash index. Startup index reconciliation removes that named legacy definition and creates:

- a non-unique owner/deployment/hash lookup index; and
- a unique owner/deployment/idempotency-key index.

Historical documents predate `idempotency_key`. The new unique index is therefore partial: it only includes documents whose key is a string. Without that filter, every legacy document's missing value could be treated like the same indexed `null` value and index creation could fail.

Existing revisions remain readable. New appends require a valid idempotency key. The migration changes index metadata and new-write rules; it does not rewrite immutable historical bundle records.

This is also a breaking publication-API change. A safe rollout must first update every caller to send stable idempotency keys; an older backend harmlessly ignores the extra header. Publication traffic must then be drained or the backend replaced in a coordinated maintenance window. A mixed fleet is unsafe for replay guarantees because an old process does not persist the key: an initial request handled by the old version and a retry handled by the new version could create two revisions. A future zero-downtime production rollout would require a two-release compatibility migration rather than deploying this contract change in one mixed-version step.

### 12. Security and Abuse Boundaries

The handler validates the header at the HTTP trust boundary, and the repository validates it again because future non-HTTP callers may bypass the handler.

The key is owner- and deployment-scoped, so one tenant cannot reserve or collide with another tenant's keys. It is bounded before persistence and is not interpolated into commands, paths, or Kubernetes names.

The API must not treat an idempotency key as proof of ownership. Every replay still runs through authentication and owner-scoped repository filters.

### 13. Alternatives Rejected

#### Keep configuration hash unique

Rejected because it makes content fingerprint double as historical identity. Intentional forward restoration would return the old revision rather than recording a new event.

#### Create a revision on every HTTP attempt

Rejected because clients and proxies retry requests after timeouts. The server may have committed the first attempt even when the caller did not receive its response.

#### Use revision number alone as the retry key

Rejected because clients do not safely know the next number under concurrency. Allocation belongs at the shared database boundary.

#### Reuse `X-Request-ID`

Rejected because tracing attempts and identifying logical mutations have different lifecycles and infrastructure behavior.

#### Store only one artifact and make later revisions lightweight aliases

Deferred rather than permanently rejected. Content-addressed blob storage could avoid duplicate bundle bytes at larger scale, but it introduces another lifecycle, reference-counting, and garbage-collection boundary. The current bounded bundle and MongoDB model do not yet justify that complexity.

### 14. Implemented and Deferred Boundaries

Implemented in this slice:

- explicit publication idempotency-key validation;
- idempotency key and optional source revision in the revision model;
- idempotent replay and conflicting-reuse behavior;
- repeated configuration hashes across distinct revisions;
- revised MongoDB indexes with legacy compatibility;
- owner-scoped concurrency tests; and
- publication API status behavior.

Still deferred:

- the application operation and HTTP route that creates a new revision from an older revision;
- desired/observed deployment-state redesign;
- generation compare-and-swap and controller claim fencing;
- Kubernetes reconciliation;
- state-volume cloning or compatibility policy for forward restoration; and
- audit-event history beyond immutable revision records.

The next implementation boundary is the desired/observed deployment state. It should assume revisions are forward-only, but it must retain a separate monotonically increasing generation for safe asynchronous reconciliation.

## Deployment Architecture Decision 5: Durable Desired/Observed State, Generations, and Reconciliation Fencing

### 1. Decision Summary

AgentFlow now models a managed deployment as one versioned MongoDB aggregate with three deliberately separate sections:

```text
deployment state
├── desired       what the platform has been asked to make true
├── observed      what a controller has actually verified
└── reconcile     who may currently work, when retry is due, and what has finished
```

The document remains unique within `(user_id, deployment_id)`. Keeping the three sections in one document allows MongoDB to atomically change user intent, invalidate an old controller claim, claim due work, and fence an observed-state write without a distributed transaction.

This phase creates the durable control-plane foundation. It does not yet run a controller or contact Kubernetes.

### 2. Why the Old Selected-Revision Record Was Insufficient

The earlier record contained only:

```text
revision
config_hash
resource_name
```

That record answered, "Which publication was selected last?" It could not answer:

- whether Kubernetes had seen the request;
- whether a pod was pending, starting, ready, degraded, failed, or deleted;
- whether an error was retryable;
- when another attempt should run;
- which controller replica owned the current attempt;
- whether a late controller result was stale;
- which Deployment, Service, PVC, and Secrets were actually observed; or
- whether a deletion request had completed.

Its update was unconditional last-write-wins. Two application instances could both read the old state and silently overwrite each other. That behavior is acceptable for a cache but not for deployment intent.

The old `resource_name` also combined identities that the Kubernetes renderer has since separated. Deployment, Service, and state PVC identities are stable and owner-scoped, while delivery/runtime Secrets may follow different lifecycle rules. One overloaded string cannot correctly represent all of these resources.

### 3. The Three Independent Counters and Identities

Revision, generation, and reconciliation attempt must not be treated as synonyms.

| Identity | Meaning | When it changes |
| --- | --- | --- |
| Revision | Immutable configuration publication event | A graph is published or restored into a new forward revision. |
| Generation | Version of desired deployment intent | Run, delete, redeploy, runtime-image change, or placement change is accepted. |
| Attempt | Controller effort for one generation | Due work is claimed or reclaimed after a retry/expired lease. |

Example:

```text
revision 9
    immutable configuration

generation 14
    run revision 9 with runtime image digest X in namespace Y

attempt 3
    third controller attempt to realize generation 14
```

A temporary Kubernetes outage creates another attempt. It does not create another revision or generation. A delete creates another generation but no configuration revision.

### 4. Version 2 State Shape

The durable shape is conceptually:

```text
record_version: 2
user_id
deployment_id

desired:
  generation
  action: run | delete
  target:
    revision
    config_hash
    schema_version
    namespace
    runtime_image
  requested_at

observed:
  generation
  phase
  target
  ready
  endpoint
  resources:
    namespace
    deployment_name
    service_name
    state_pvc_name
    delivery_secret_name
    runtime_secret_name
  last_error:
    code
    message
    retryable
    generation
    occurred_at
  last_transition_at

reconcile:
  due_at
  attempt
  processed_generation
  claim:
    generation
    token
    owner
    lease_expires_at

migration:
  legacy_resource_name
  migrated_at

created_at
updated_at
```

The state does not contain bundle bytes, bearer tokens, runtime API tokens, provider credentials, or Secret values. It stores only non-secret resource references.

### 5. Desired State

Desired state expresses application intent. `action=run` means the target should exist and become ready. `action=delete` means the managed resources should be absent.

The target is copied from trusted sources:

- revision, hash, and schema version come from the immutable owned publication;
- namespace comes from platform placement policy; and
- runtime image is a digest-pinned platform release.

Namespace and runtime image appear in desired state because reconciliation must remain repeatable after process restarts and controller upgrades. If a controller merely read its current environment on every retry, the same generation could silently change meaning after a new image release or namespace-policy change.

These values are internal application inputs. A future HTTP handler must not let a caller choose arbitrary namespaces or runtime images by passing them through request JSON.

### 6. Observed State

Observed state is evidence, not intention. The controller owns it.

The phase vocabulary is:

| Phase | Meaning |
| --- | --- |
| `pending` | The target has not yet been processed. |
| `provisioning` | Prerequisite resources are being created or updated. |
| `starting` | The runtime workload exists but is not yet verified ready. |
| `ready` | The target generation and expected runtime are verified ready. |
| `degraded` | A reconciliation failed, but an older observed deployment remains ready. |
| `failed` | Reconciliation failed and no ready deployment is available. |
| `deleting` | Resource deletion is in progress. |
| `deleted` | The target generation's absence has been verified. |

Observed generation advances only on a verified result such as ready or deleted. A failed rollout must not set observed revision/generation to the desired target because that would claim infrastructure exists when it does not.

The error object separately records which generation failed. Retryable failures leave `processed_generation` behind and schedule another due time. Terminal failures advance `processed_generation` without advancing the successfully observed runtime generation.

### 7. Generation Compare-and-Set

Every user-intent mutation carries `expected_generation`.

Suppose two callers both read generation 6:

```text
caller A requests generation change with expected_generation=6
caller B requests generation change with expected_generation=6

MongoDB applies A and stores generation 7
MongoDB rejects B because desired.generation is no longer 6
```

The losing request receives `ErrDeployStateConflict`. It must read the current state and decide whether its intention is already satisfied or whether the user must review the newer change.

The first run request uses expected generation zero and inserts generation one. The unique `(user_id, deployment_id)` index resolves concurrent first creation: one insert wins, while another exact request can observe that the same target already exists.

An exact run/delete replay is state-idempotent across the single expected generation increment. It does not manufacture another generation. This is deliberately narrower than durable HTTP idempotency history.

### 8. Why Deployment HTTP Idempotency Is Not Pretended Here

Publication stores an immutable idempotency key per revision, so old publication retries remain recognizable forever. Deployment state stores only the current aggregate.

Saving only the latest deployment request key in this document would be misleading:

```text
request A writes key A
request B writes key B
late retry of A arrives

key A is no longer present
```

A robust future deployment API should use an immutable deployment-operation record, or an equivalent durable operation history, if it promises retry-by-key semantics. This phase uses explicit generation compare-and-set and exact-state replay because no public deployment mutation route exists yet.

### 9. Forward-Only Revision Rules

The application service loads the owned revision and checks that it is the latest publication when the request is evaluated. The repository also maintains a per-deployment high-water mark by rejecting any target revision lower than the revision already present in desired state.

For the same revision number, configuration hash and schema version must remain identical. Runtime image or namespace may change because those values belong to platform rollout/placement rather than configuration publication.

Therefore:

```text
desired revision 9 -> request revision 8
    rejected as rollback

desired revision 9 -> request revision 9 with new runtime image digest
    allowed as a new deployment generation

desired delete of revision 9 -> run revision 9 again
    allowed as a new generation

desired revision 9 -> restore content from revision 6
    create revision 10 from revision 6, then request revision 10
```

If a new publication commits after a run request has already validated the then-current latest revision, it is a later publication event; the platform does not automatically deploy every publication. Automatic deploy-on-publish would be a different product rule.

### 10. Per-Deployment Claim and Lease

Controller replicas do not need a global single leader for all work. They claim individual due deployment records.

A record is claimable when:

```text
record_version = 2
reconcile.due_at <= now
and
claim is absent OR claim.lease_expires_at <= now
```

`ClaimDue` is a single atomic `FindOneAndUpdate`. It:

1. selects the oldest due record;
2. copies the current desired generation into the claim;
3. records controller owner and a fresh token;
4. records lease expiry;
5. increments the attempt counter; and
6. returns the claimed post-update document.

Claim tokens are 256 random bits produced by `crypto/rand` and encoded as 64 hexadecimal characters. The controller owner and token are bounded visible ASCII values. The token is not a user credential, but it is still internal authority and must not be exposed by a future public status projection.

### 11. Fenced Writes

Every progress, ready, failure, lease-refresh, and deleted write must match:

```text
user_id
deployment_id
record_version = 2
desired.generation = claimed generation
reconcile.claim.generation = claimed generation
reconcile.claim.token = caller token
reconcile.claim.owner = caller owner
reconcile.claim.lease_expires_at > now
```

A MongoDB update that matches zero documents returns `applied=false`, not a false success. This is important because zero matched rows are not a driver error.

When a new desired generation is accepted, its atomic update removes the old claim and schedules the new generation immediately. Any late writer holding the old generation/token then fails its fence.

### 12. What the Fence Can and Cannot Guarantee

The MongoDB fence prevents a stale controller from corrupting product-level observed state.

It cannot retract a Kubernetes API call that was already sent. A stale controller might still reach the cluster after losing its MongoDB lease. The future Kubernetes adapter must therefore add a second boundary:

- generation annotations on all owned objects;
- stable field ownership;
- conditional update/resource-version checks or another monotonic mutation guard; and
- drift reconciliation that restores the newest desired generation.

MongoDB and Kubernetes participate in one workflow but do not provide one cross-system transaction.

### 13. Progress, Success, Failure, and Deletion Mechanics

Progress writes accept only intermediate phases: provisioning, starting, or deleting. Ready and deleted use dedicated methods because they change stronger invariants.

A ready write:

- verifies the reported target exactly matches current desired target;
- advances observed generation;
- records endpoint and resource references;
- sets phase ready and `ready=true`;
- advances processed generation; and
- clears due time, claim, and last error.

A retryable failure:

- records a bounded low-cardinality error code;
- records a bounded control-character-free message;
- records the failed generation;
- clears the claim;
- schedules a caller-selected future retry time; and
- leaves processed generation behind.

A terminal failure clears due time and advances processed generation. If an older observation remains ready, the phase becomes degraded; otherwise it becomes failed.

A verified delete:

- advances observed and processed generation;
- sets phase deleted and `ready=false`;
- removes endpoint and observed resource/target fields; and
- clears due time, claim, and last error.

The desired target remains present after delete. It supplies the revision high-water mark and describes what was deleted.

### 14. Retry Scheduling Is Durable

`due_at` is stored in MongoDB rather than an in-memory timer. A controller restart therefore does not lose pending work.

The repository does not choose exponential-backoff policy. It validates that a retry time follows the failure time and persists it. The future controller owns classification and backoff calculation because it has the Kubernetes error context.

This separation permits policies such as:

```text
authorization or invalid bundle -> terminal
temporary API timeout           -> retry
unschedulable capacity          -> bounded retry plus user-visible condition
PVC attachment in progress      -> retry/observe
```

### 15. Indexes

The collection uses:

```text
UNIQUE (user_id, deployment_id)

(record_version,
 reconcile.due_at,
 reconcile.claim.lease_expires_at,
 created_at)
```

The due-work index is partial. Only version-2 documents with a date-valued due time participate. Completed deployments and untouched legacy records therefore do not occupy the active work queue index.

### 16. Explicit Legacy Migration

Legacy flat records are not silently rewritten by `Get`. Reading one returns `ErrDeployStateMigrationRequired`.

The explicit migration operation verifies:

- owner and deployment;
- old revision;
- old configuration hash; and
- old resource name when supplied.

It then writes:

- record version 2;
- desired generation 1 with action run;
- pending, not-ready observed state at generation zero;
- immediate due time; and
- migration metadata containing the old resource name.

The old flat revision/hash/resource fields are removed.

Observed generation starts at zero because the former code only selected a revision; it never had a controller that proved Kubernetes resources were ready. Migration must not invent operational history.

The old resource name is preserved as metadata only. It is not reused as the stable Deployment or Service identity and must not silently become the PVC name without an explicit storage-ownership decision.

### 17. Ownership and Security Boundaries

Every mutation and fenced write includes owner and deployment identity. A tenant cannot read, update, claim by identity, or complete another tenant's deployment through an owner-scoped method.

The global due-work claim intentionally searches across tenants because it is an internal controller operation. The returned record includes the owner needed for subsequent fenced calls. That controller capability must never be exposed as a public handler operation.

Error and claim fields are bounded to prevent uncontrolled indexed/logged data growth. Claim identities reject whitespace and control bytes. Failure messages reject control bytes to reduce log-injection risk. Secrets and artifact bodies remain outside this document.

### 18. Application and Repository Boundaries

The application service depends on a focused intent store:

```text
RequestRun
RequestDelete
Get
```

The concrete MongoDB repository additionally exposes controller operations such as claim, refresh, progress, ready, failure, and deleted writes. Those methods are not placed into the application service's interface because the user-intent service does not consume them.

This keeps the dependency direction clear:

```text
future HTTP handler
  -> deployment application service
      -> desired-state store + immutable revision reader

future controller
  -> reconciliation store
  -> Kubernetes adapter
```

The handler will not directly call Kubernetes, and the controller will not reinterpret an HTTP request.

### 19. Tests Added as Executable Contracts

The implementation includes tests for:

- target, claim, error, and phase validation;
- service resolution of the latest owned publication;
- rejection of intentional historical revision selection;
- generation compare-and-set;
- exact-state replay without generation inflation;
- forward revision movement;
- same-revision runtime-image rollout;
- delete and redeploy generations;
- owner-scoped reads;
- concurrent mutations with one winner;
- single-winner due claims;
- lease expiry and reclaim;
- stale-generation and stale-token rejection;
- ready and deleted observations;
- retryable and terminal failures;
- durable retry timing; and
- explicit legacy migration without hidden write-on-read.

At the time this decision was written, those tests had been added but not yet executed. Passing validation must be recorded only after the separately approved test phase runs.

### 20. Implemented and Deferred Boundaries

Implemented in this slice:

- version-2 desired/observed/reconcile domain model;
- validated run/delete targets;
- generation compare-and-set mutations;
- forward-revision repository guard;
- stable desired runtime image and namespace;
- atomic due-work claim and attempt increment;
- cryptographically random claim-token helper;
- lease refresh and expiry;
- fenced progress, ready, failure, and deleted writes;
- retry scheduling and terminal processing;
- owner scoping and resource references;
- partial due-work index; and
- explicit legacy conversion.

Still deferred:

- public deployment mutation/status routes and their response projections;
- immutable deployment-operation history for full HTTP idempotency;
- controller process, polling loop, lifecycle, and graceful shutdown;
- bundle-delivery endpoint and token issuance;
- Secret and PVC creation/retention;
- Kubernetes client and server-side apply;
- cluster-side monotonic generation guard;
- readiness/error classification from real Kubernetes conditions;
- retry/backoff policy values;
- endpoint/ingress and NetworkPolicy;
- runtime Secret population;
- production namespace-placement policy beyond storing a resolved namespace; and
- real-cluster integration and failure injection.

The next implementation boundary should be the reconciler application loop and its narrow Kubernetes adapter contract. Before adding `client-go`, that discussion must define polling/wakeup behavior, controller identity and shutdown, retry classification, resource prerequisite order, cluster-side fencing, and how Kubernetes conditions map into the phases defined here.

## Deployment Architecture Decision 6: Reconciliation Controller Application Loop

### 1. Decision Summary

AgentFlow's deployment controller is a continuously running convergence process. It does not treat one Kubernetes API request as a deployment.

Its application-level responsibility is:

```text
poll durable due work
  -> atomically claim one desired generation
  -> verify the immutable publication
  -> ask the Kubernetes runtime boundary to realize or delete it
  -> refresh the claim while work remains in progress
  -> persist verified success or a classified failure
```

The controller engine lives in `backend/deployment/reconciler`. It owns polling, bounded concurrency, claim creation, lease heartbeat, claim-loss cancellation, publication verification, progress writes, durable retry scheduling, and graceful cancellation.

The package defines a narrow `Runtime` interface for the later Kubernetes implementation. This is not a generic interface for ECS, Nomad, VMs, or arbitrary orchestrators. Its purpose is to isolate Kubernetes API mechanics and credentials from the application-level reconciliation state machine.

This slice still performs no live cluster operation and adds no Kubernetes client dependency.

### 2. Why a Controller Is Necessary

Creating a Kubernetes Deployment object proves only that the API server accepted an object. It does not prove that:

- a node could schedule the pod;
- the PVC attached;
- the Secrets existed;
- the image was pulled;
- the init container obtained the correct bundle;
- bundle hash verification passed;
- the runtime opened its state successfully;
- the runtime passed `/readyz`; or
- the Service has a ready endpoint for the intended generation.

These events happen asynchronously and may take seconds or minutes. The process that records user intent must therefore be separate from the process that keeps observing reality until intent and reality agree.

### 3. Process Boundary

The intended production topology is a separate controller executable and Kubernetes workload rather than a background goroutine inside the Studio HTTP API.

That separation protects several boundaries:

- API replicas do not accidentally multiply infrastructure work merely because HTTP traffic increases.
- request handlers do not receive Kubernetes RBAC permissions;
- controller failure does not remove the authoring API;
- the controller can have independent resource limits, rollout policy, and alerts; and
- HTTP requests record desired state and return without waiting for scheduling and startup.

The application engine is implemented before that executable because live composition also requires the artifact endpoint, credential source, PVC policy, and Kubernetes adapter.

### 4. Per-Record Claims Instead of Global Leader Election

AgentFlow does not initially require one global elected leader. MongoDB already allows controller replicas to claim independent deployment records atomically.

For example:

```text
controller A -> deployment X, generation 4
controller B -> deployment Y, generation 9
controller C -> no due work, waits
```

Only one live claim can own a particular deployment generation. Different deployments can reconcile concurrently. This provides horizontal controller capacity without making one process a global availability dependency.

### 5. Polling and Bounded Workers

The controller begins with a small bounded worker set. The default is four workers. Each worker:

1. asks MongoDB for the oldest due record;
2. processes the returned claim when one exists;
3. immediately asks for more work after finishing; and
4. waits for the polling interval when no work is due or claiming failed.

The default idle polling interval is one second. `due_at` remains the durable scheduling authority; an in-memory timer is only a wake-up mechanism. If the process restarts, pending work is still present in MongoDB.

MongoDB change streams are deliberately deferred. They may reduce idle polling later, but they also require resume-token persistence and recovery behavior. A one-second indexed poll is simpler and already satisfies the initial scheduling requirement.

### 6. Controller Identity and Claim Tokens

The engine requires a bounded visible-ASCII controller owner. The future executable should derive a diagnostic identity from its pod identity plus a process-unique suffix.

Every claim uses a fresh cryptographically random token. The owner helps operators identify the process; the token is the unguessable fencing credential. Neither value is an end-user credential, and the token must never appear in public status or logs.

### 7. Lease Heartbeat and Claim-Loss Cancellation

The initial defaults are:

```text
lease duration       30 seconds
heartbeat interval   10 seconds
attempt timeout      12 minutes
```

The attempt timeout is longer than the renderer's ten-minute Kubernetes progress deadline, leaving a small completion window.

The heartbeat runs independently from the infrastructure operation. A refresh that returns `applied=false` means the worker no longer owns the generation. A refresh error means ownership cannot be proven. In either case, the controller cancels the attempt immediately.

This rule is intentionally conservative:

```text
cannot prove ownership
  -> stop producing side effects
```

The later Kubernetes adapter must make every network call context-cancellable and must check generation fences before each mutation. Cancellation cannot retract an API request already accepted by Kubernetes, so the cluster needs its own protection as described below.

### 8. Graceful Shutdown

When the root context is cancelled, workers stop claiming new work and active attempts receive cancellation. Controller shutdown is not written as a deployment failure.

If a process exits before finishing, its MongoDB lease expires and another instance may reclaim the generation. This is safer than persisting `failed` merely because an operator rolled out a new controller version.

The future executable should give active workers a bounded shutdown window. Kubernetes client calls must have their own deadlines so a broken network connection cannot make process termination unbounded.

### 9. Run Attempt Flow

For `desired.action=run`, the engine performs these application checks before Kubernetes receives control:

1. Load the exact owner-scoped revision number.
2. Compare owner, deployment, revision, hash, and schema with desired state.
3. Parse the stored bytes using the normal deployment bundle parser.
4. Recalculate and verify the canonical bundle hash.
5. Compare the verified bundle identity with desired state again.
6. Record `provisioning` through the current claim fence.
7. Call the Kubernetes runtime boundary with the verified state and revision.
8. Permit that boundary to report intermediate progress such as `starting`.
9. Record `ready` only from the returned verified endpoint and resource references.

Repeated verification is deliberate defense in depth. Publication validates bytes before storage, but a controller should not execute mutable or corrupted storage merely because another layer was expected to validate it earlier.

### 10. Delete Attempt Flow

For `desired.action=delete`, the engine:

1. records `deleting` through the active claim;
2. gives the Kubernetes runtime boundary the claimed state and last observed resource references;
3. waits for that boundary to verify the required absence or tombstoned state; and
4. records `deleted` through the same claim.

The live adapter must not claim deletion success merely because it sent delete requests. It must observe the agreed terminal condition.

PVC removal is not part of this decision. Runtime removal and durable-state destruction have different recovery consequences and require a separate retention policy.

### 11. Progress Reporting Is Also Fenced

The runtime boundary receives a progress callback instead of writing MongoDB itself. The callback accepts only domain progress phases and uses the same generation, owner, token, and lease fence as terminal writes.

If a progress write matches no document, the callback returns `ErrClaimLost`. The Kubernetes operation must stop. This keeps database ownership rules in the controller engine rather than duplicating repository knowledge inside the adapter.

### 12. Failure Classification

Infrastructure code returns a typed reconciliation error containing:

- a low-cardinality status code;
- a bounded safe message;
- whether the condition is retryable; and
- an internal wrapped cause for `errors.Is`, `errors.As`, and private logs.

Only the code, safe message, and retryable flag enter deployment state. The wrapped cause is not persisted because driver and network errors may contain internal addresses or other sensitive operational details.

Examples of retryable conditions include:

- Kubernetes API timeout or unavailability;
- throttling;
- resource-version conflicts;
- temporary image-pull, scheduling, or volume-attachment conditions; and
- temporary artifact-endpoint unavailability.

Examples of terminal conditions include:

- the selected immutable revision does not exist;
- revision metadata no longer matches desired state;
- bundle integrity verification fails;
- the schema is unsupported; and
- workload input is structurally invalid.

Unknown infrastructure errors default to retryable. This avoids permanently abandoning a generation merely because a new transient error type was not yet classified. The adapter should still classify known permanent configuration errors explicitly.

### 13. Retry Backoff

Retry time is persisted through the existing `RecordFailure` operation. The controller uses exponential backoff bounded by a maximum delay:

```text
attempt 1 -> roughly 0.5 to 1 times the base window
attempt 2 -> roughly 1 to 2 times the base window
attempt 3 -> roughly 2 to 4 times the base window
...
maximum   -> never exceeds five minutes by default
```

Jitter is derived deterministically from the claim token. Independent attempts therefore spread out rather than retrying in lockstep, while tests do not depend on global random state.

Claim loss, shutdown cancellation, and stale progress are not deployment failures and do not create a retry record. The current lease/due state already determines who continues.

### 14. MongoDB and Kubernetes Need Separate Fences

MongoDB fencing protects product status. It cannot make MongoDB and Kubernetes one transaction.

Every Kubernetes object controlled by AgentFlow must therefore carry the AgentFlow desired generation. Before updating an existing object, the future adapter must:

1. read it;
2. reject an object whose AgentFlow generation is newer than the claim;
3. preserve its Kubernetes `resourceVersion`;
4. submit a conditional update; and
5. repeat the generation comparison after an update conflict.

Server-side apply may still be useful for field ownership and drift correction, but field ownership alone does not enforce monotonic AgentFlow generations.

Stable Deployment and Service names reduce the stale-controller risk: competing generations address the same logical objects rather than creating separate active Deployments. Deletion remains special because removing the object also removes its generation marker. The initial live design should retain a zero-replica Deployment tombstone until stale claims and in-flight requests cannot recreate an older runtime, or add an equivalent durable guard plus periodic drift repair.

### 15. Kubernetes Prerequisite Order

The intended run order is:

```text
verify revision and target
  -> verify the platform-selected namespace already exists
  -> ensure the deployment-owned stable PVC
  -> ensure scoped delivery-token Secret
  -> ensure runtime/provider Secret
  -> ensure NetworkPolicy when defined
  -> apply stable Service
  -> apply Deployment last
  -> observe expected pod and endpoint readiness
```

Applying the Deployment last prevents a pod from starting before its storage, credentials, and network policy are ready.

The controller should not initially create arbitrary namespaces. Requiring platform-provisioned namespaces avoids broad cluster-scoped RBAC while namespace placement and tenant isolation remain undecided.

### 16. Readiness Mapping

The later adapter must not equate `Deployment Available=True` with product readiness. A ready result should verify at least:

- the stable Deployment has the claimed AgentFlow generation, revision, hash, and schema metadata;
- exactly one desired replica is configured;
- the expected pod template has been observed;
- one pod for that expected generation is ready;
- the runtime `/readyz` probe is succeeding through Kubernetes readiness; and
- the stable Service has a ready endpoint for that pod.

Kubernetes `status.observedGeneration` refers to the Kubernetes object's own metadata generation, not AgentFlow's desired generation. Both identities are useful and must not be confused.

### 17. Secret and Artifact Boundary Still Missing

The renderer requires values that durable desired state does not contain:

- an internal HTTPS bundle URL;
- a delivery-token Secret name;
- a runtime Secret name and its environment-variable keys; and
- the stable deployment-owned PVC name.

These values should not all be copied into desired state:

- the bundle URL can be derived from a trusted platform artifact origin plus owner, deployment, and revision, while the expected hash protects content identity;
- resource names can be derived deterministically;
- the PVC name must be derived from owner plus logical deployment only, so every forward revision reuses the same physical state while revision ownership is enforced inside that state; and
- Secret values must never enter deployment state.

The source of runtime/provider credential values remains unresolved. The current standalone runtime reads provider and embedded-tool values from process environment variables; MCP connections no longer use runtime credentials. Managed hosting needs an explicit credential source and tenant-ownership policy before the controller may copy provider/tool values into Kubernetes Secrets.

### 18. Alternatives Considered

#### Run the controller inside the HTTP API

Rejected for production because it couples API replica count, Kubernetes RBAC, failure handling, and long-running infrastructure work. The reusable engine may be composed in tests without implying that production boundary.

#### Use one global elected controller leader

Rejected initially because per-record MongoDB claims already serialize each deployment while allowing unrelated deployments to progress concurrently.

#### Use MongoDB change streams immediately

Deferred because indexed polling is durable and simple. Change streams add resume-token and outage-recovery behavior without being necessary for correctness.

#### Treat server-side apply as the generation fence

Rejected because field ownership does not reject an older AgentFlow generation. Resource-version-aware monotonic checks are still required.

#### Persist every raw infrastructure error

Rejected because raw errors are unstable, high-cardinality, potentially sensitive, and unsuitable as an API contract. Stable codes and bounded safe messages are persisted instead.

### 19. Implemented in This Slice

- controller-facing reconciliation store interface;
- owner-scoped immutable revision reader interface;
- Kubernetes-only runtime boundary;
- bounded worker polling loop;
- fresh token generation for each claim;
- lease heartbeat and immediate cancellation on uncertain ownership;
- context-bounded reconciliation attempts;
- revision metadata and bundle-integrity verification before infrastructure work;
- fenced provisioning, starting, deleting, ready, failed, and deleted transitions;
- typed safe retryable and terminal errors;
- bounded exponential retry backoff with deterministic jitter;
- cancellation-aware graceful worker shutdown; and
- focused unit contracts for success, deletion, lease loss, retry, invalid revision, shutdown, and backoff.

The tests are source-level contracts at this point. They must not be described as passing until the separately approved validation phase runs them.

### 20. Deliberately Deferred

- controller executable and Kubernetes Deployment;
- `client-go` dependency and live client construction;
- Kubernetes RBAC;
- cluster-side generation annotations and conditional mutation implementation;
- artifact-delivery route and token issuer;
- Secret creation and credential source;
- PVC `StorageClass`, size, access mode, backup, retention, and deletion;
- NetworkPolicy rendering;
- pod/Deployment/EndpointSlice status interpretation;
- external ingress, TLS, hostname, and public endpoint identity;
- public deployment mutation/status routes; and
- real-cluster integration and failure-injection testing.

### 21. Next Boundary

After validating this engine, the next architecture slice should implement the prerequisites needed by a real adapter in this order:

1. internal immutable bundle endpoint and scoped delivery-token contract;
2. managed runtime credential source and exact Secret-key derivation from the bundle;
3. stable deployment-owned PVC rendering, retention, and migration policy;
4. Kubernetes object ownership metadata and monotonic update/delete fencing; and
5. a narrow `client-go` adapter with fake-client tests before any real-cluster exercise.

Only then can the separate controller executable be composed without hiding unfinished security and state-ownership decisions behind a superficially successful Deployment creation.

---

## Deployment Architecture Decision 7: Scoped Internal Artifact Delivery

### 1. Purpose of This Layer

The Kubernetes workload renderer and runtime materializer already agree on how a pod receives a bundle: an init container reads a delivery credential from a Secret, downloads one bundle over HTTPS, verifies it, and places it in a pod-local `emptyDir`. Until this decision, the server side of that exchange did not exist.

This layer implements the control-plane half of the handoff:

```text
future Kubernetes controller
  -> asks the delivery service for one narrow credential
  -> writes the raw credential into a Kubernetes Secret

runtime init container
  -> reads that Secret
  -> calls the dedicated internal artifact listener
  -> receives only the exact immutable revision authorized by the credential
```

The public bundle-download endpoint remains available for an authenticated user exporting a publication. It is not used for managed runtime startup.

### 2. Three Credentials, Three Different Authorities

AgentFlow now has three conceptually different bearer credentials:

| Credential | Subject | What it authorizes | Consumer |
| --- | --- | --- | --- |
| Studio JWT | An authenticated user | User-facing AgentFlow operations for owned resources | Browser or API client |
| Runtime API token | A caller of one running runtime | Invoking that runtime's narrow execution API | Runtime client |
| Delivery capability | One deployment generation | Fetching one exact immutable bundle | Init container only |

These credentials are not interchangeable.

A Studio JWT is too broad. It identifies a user and is accepted by many public routes. Mounting it in a pod would give the pod the user's authority rather than one artifact capability.

`RUNTIME_API_TOKEN` protects the opposite direction. It answers whether a caller may enter the runtime API; it must not authorize the runtime to retrieve control-plane artifacts.

The delivery token instead answers one bounded question:

> Is this credential currently allowed to fetch revision R for deployment D under desired generation G?

### 3. Why the Token Is Opaque

The accepted token is 32 cryptographically random bytes encoded with unpadded URL-safe Base64 and prefixed with `afdt_`:

```text
afdt_<43 URL-safe Base64 characters>
```

The prefix helps operators and secret scanners recognize the credential type. It does not provide security. Security comes from 256 bits of randomness.

The token is opaque: its scope cannot be learned by decoding it. MongoDB stores a SHA-256 hash of the complete token and the associated scope. The raw value is returned once to the issuing controller and is intended to exist afterward only in the Kubernetes delivery Secret.

Hashing a random token is different from hashing a password. Human passwords have low entropy and require a deliberately expensive password-hashing function. A uniformly random 256-bit token cannot be feasibly guessed, so a direct SHA-256 lookup gives both adequate preimage resistance and efficient indexed authorization.

### 4. Grant Data Model

The `deployment_delivery_tokens` collection stores:

```text
_id
token_hash
user_id
deployment_id
generation
revision
config_hash
schema_version
created_at
expires_at
revoked_at                 optional
last_authorized_at         optional
authorization_count
```

The collection deliberately does not store the raw token.

Its indexes provide three different guarantees:

1. a unique `token_hash` index makes one credential resolve to at most one grant;
2. an owner/deployment/generation index supports scoped revocation and later rotation work; and
3. an `expires_at` TTL index eventually removes expired records.

MongoDB TTL cleanup is asynchronous. An expired document can remain physically present after its expiration time, so authorization always compares `expires_at` explicitly. The TTL index is storage cleanup, not the security check.

### 5. Issuance Does Not Trust Artifact Metadata From the Caller

The delivery service accepts only:

```text
user_id
deployment_id
desired generation
```

It then reloads durable desired state and derives revision, config hash, and schema version from that state. It also reloads the immutable publication and verifies that its metadata matches the desired target before minting a token.

This avoids an unsafe interface such as:

```text
IssueToken(owner, deployment, revision, hash, schema)
```

where a buggy caller could accidentally combine a legitimate owner with the wrong revision or hash. The durable deployment aggregate remains the authority for what the generation means.

The default credential lifetime is 24 hours. The service rejects configuration above seven days. The current slice exposes issuance as an application service for the future controller; it does not expose a public or internal HTTP route that lets arbitrary callers mint tokens.

### 6. Exact Internal HTTP Contract

Artifact delivery uses a generation-bearing path:

```http
GET /internal/v1/deployments/{deployment}/generations/{generation}/revisions/{revision}/bundle
Authorization: Bearer <delivery-token>
Accept: application/json
```

Generation is present even though revision is immutable because deployment intent can change independently of artifact history. It gives the request an explicit deployment-state identity rather than merely naming stored bytes.

The handler requires exactly one bounded `Authorization` header. The scheme is `Bearer`; the credential cannot contain whitespace. Duplicate, empty, malformed, and oversized authorization headers are rejected before reaching the application service.

Unknown, malformed, expired, revoked, stale-generation, and wrong-scope credentials all produce the same external result:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="agentflow-artifacts"
Cache-Control: no-store

{"error":"unauthorized"}
```

This prevents the endpoint from becoming an oracle that reveals whether a token exists or which part of its scope was correct.

### 7. Authorization Is More Than a Token Lookup

For a request containing deployment D, generation G, and revision R, authorization performs:

```text
validate token syntax
  -> SHA-256 hash the supplied value
  -> load the grant by token_hash
  -> reject expiration or revocation
  -> compare request D/G/R with grant D/G/R
  -> reload deployment state using the grant's owner
  -> require desired action = run
  -> require desired generation = G
  -> require desired revision/hash/schema = grant scope
  -> load immutable revision through the owner-scoped repository
  -> require revision/hash/schema = desired target
  -> atomically record authorization only if the grant is still unrevoked and unexpired
  -> return an isolated copy of the exact stored bundle bytes
```

The durable-state check is essential. A database record saying that a token was once valid does not mean it remains valid. If generation 5 supersedes generation 4, a still-unexpired generation-4 credential fails because current desired state no longer matches it. A delete intention invalidates the credential for the same reason.

Explicit `RevokeGeneration` support also exists for rotation and incident response.

### 8. Integrity and Authorization Remain Separate

The endpoint authorization answers:

> May this caller retrieve these stored bytes for the current generation?

The materializer's hash checks answer:

> Are these bytes internally valid, and are they the exact configuration the pod was instructed to start?

Neither replaces the other. A correctly authorized server could still have a storage or implementation fault, and a cryptographically consistent bundle could still be the wrong revision. The init container therefore retains both bundle self-verification and expected-hash verification after HTTP authorization succeeds.

### 9. Response Contract

The endpoint returns the exact `bundle_json` bytes stored in the immutable revision. It does not re-marshal the bundle or regenerate it from mutable agent documents.

Successful responses include:

```text
Content-Type: application/json
Content-Length: <exact byte count>
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Cross-Origin-Resource-Policy: same-origin
```

Unlike the user export route, it does not include `Content-Disposition: attachment`; this is a machine-to-machine endpoint, not a browser download.

The authorization counter is updated before bytes are written. It therefore means “authorization was granted,” not “the client certainly received every byte.” A network disconnect after authorization may prevent delivery while leaving an authorization record. This distinction avoids claiming an end-to-end guarantee that ordinary HTTP cannot provide.

Logs may contain the safe MongoDB grant identifier, deployment, generation, revision, request ID, and byte count. They must never contain the raw token or `Authorization` header.

### 10. Separate Internal Listener

The internal route is not registered on the public API mux. It is served by a separate listener enabled only when:

```text
ARTIFACT_LISTEN_ADDR=<host:port>
```

For example, a managed control-plane pod may use `:9091` while the public API remains on `:9090`.

The internal listener has request IDs, request logging, a header-read timeout, a 30-second write timeout, a 32 KiB aggregate header limit, and an idle timeout. It deliberately does not receive the browser CORS middleware. A cluster-internal Service or TLS proxy should expose only this listener to runtime namespaces, while the public ingress should expose only the public listener.

The Go listener itself is plain HTTP, as is common behind a trusted TLS-terminating proxy or service mesh. The controller-produced bundle URL must nevertheless be HTTPS because the materializer rejects plaintext URLs. Network placement is defense in depth; the scoped capability remains mandatory even on the internal network.

If `ARTIFACT_LISTEN_ADDR` is absent, the public backend continues to run and logs that managed artifact delivery is disabled. This preserves local authoring workflows while making internal exposure an explicit deployment decision.

### 11. Expiry, Rotation, and Kubernetes Pod Replacement

The delivery Secret persists independently of any individual pod. If Kubernetes replaces a pod, the new init container reads the current Secret and repeats materialization.

A very short or one-use token would break this recovery model. The token might expire after the first pod starts, leaving a later node eviction unable to recreate the runtime. The initial policy therefore uses:

```text
default token lifetime: 24 hours
maximum token lifetime: 7 days
recommended future refresh interval: approximately 6 hours
```

The future Kubernetes adapter must rotate with overlap:

```text
issue new grant
  -> write new raw token into the Kubernetes Secret
  -> wait until the Secret update is accepted
  -> leave the previous token valid during a bounded overlap
  -> revoke it or allow its short expiry
```

Rotating the Secret does not require restarting an already-running runtime because the runtime container cannot see the delivery Secret and no longer needs it. A replacement pod sees the newest projected Secret value.

Periodic rotation is not implemented in this slice because no live Kubernetes adapter exists yet. Therefore a production managed-hosting claim would still be premature: after the token expires, autonomous replacement requires the future controller to have refreshed it.

### 12. Concurrency and Remaining Race Boundary

Authorization reads the grant, desired state, and immutable revision from separate MongoDB documents. A desired-generation update can occur immediately after the state check. MongoDB and the subsequent HTTP response are not one transaction with Kubernetes.

This does not allow the token to fetch another revision: its D/G/R/hash/schema scope remains fixed. It can permit a narrowly timed final response for a generation that is being superseded concurrently. Correctness therefore still depends on the controller's Kubernetes-side generation fence described in Decision 6. The new generation must replace or remove any stale pod rather than allowing it to become the lasting observed workload.

Trying to make the HTTP response, MongoDB state, and Kubernetes object update one global transaction would add substantial complexity without eliminating distributed failure. Narrow credentials, current-state checks, expected-hash verification, and Kubernetes generation fencing form the intended layered defense.

### 13. Failure Behavior

| Failure | External result | Security/operational meaning |
| --- | --- | --- |
| Missing or malformed path scope | `400` | Request does not name a valid deployment generation/revision |
| Missing, malformed, duplicated, or oversized bearer header | generic `401` | No valid capability was presented |
| Unknown, expired, revoked, or wrong-scope token | generic `401` | Reason is intentionally hidden |
| Desired generation changed or deletion requested | generic `401` | Previously issued capability is no longer current |
| Grant/state/revision MongoDB operation fails | generic `500` | Control-plane storage is unavailable or inconsistent |
| Successful authorization | exact immutable bytes | Init container still performs independent verification |
| Client disconnects during response | server logs write failure | Authorization may be recorded even if delivery was incomplete |

The materializer treats every non-`200` status as startup failure. Kubernetes therefore does not start the main runtime container with missing or uncertain configuration.

### 14. Alternatives Rejected or Deferred

#### Reuse the Studio JWT

Rejected because it grants user authority rather than one deployment capability and would place a broad user session inside Kubernetes.

#### Reuse `RUNTIME_API_TOKEN`

Rejected because it protects callers entering the runtime and has no owner/revision/generation semantics.

#### Signed delivery JWT

Deferred because it would require a separate signing-key lifecycle, algorithm enforcement, key rotation, and revocation design. Avoiding a MongoDB lookup has little value because authorization already needs current desired state and immutable revision data.

#### Kubernetes projected ServiceAccount identity

This is a credible future design. Short-lived projected tokens plus Kubernetes TokenReview can handle pod identity and renewal without a stored bearer Secret. It would require ServiceAccount ownership, TokenReview RBAC, audience design, pod/namespace binding, Kubernetes API availability at the artifact boundary, and a revision of the already accepted Secret-based renderer contract. The opaque capability is the smaller responsible design for the current architecture.

#### Put the token in the URL

Rejected because URLs commonly appear in access logs, proxy telemetry, browser history, manifests, and error messages. The materializer also explicitly rejects query parameters.

#### Store the raw token in MongoDB

Rejected because indexed authorization needs only a deterministic hash. Retaining the raw credential would turn a read of the grant collection into immediately usable bearer credentials.

### 15. Implemented in This Slice

- opaque 256-bit delivery credentials with a recognizable prefix;
- configurable bounded lifetime with 24-hour default and seven-day maximum;
- issuance derived from current durable desired state and immutable publication metadata;
- SHA-256-only-at-rest grant storage;
- unique hash, scope, and TTL indexes;
- explicit expiration and revocation checks;
- current desired-generation validation on every fetch;
- owner-scoped immutable revision loading;
- safe authorization counters and timestamps;
- generic external authorization failures;
- exact-byte internal bundle response;
- separate opt-in internal listener without CORS; and
- focused service, handler, and MongoDB repository test contracts.

These contracts were included in the complete backend suite that passed against the local MongoDB service on October 15, 2026. The current validation evidence is recorded in Deployment Architecture Decision 8, section 19.

### 16. Still Missing

This layer supplies the secure artifact server and token issuer, but it does not yet make a live Kubernetes deployment possible. Remaining work includes:

1. controller-side token issuance, safe overlap rotation, and Kubernetes Secret application;
2. managed runtime/provider credential sourcing and runtime Secret creation;
3. stable deployment-owned PVC creation plus internal state migration, retention, backup, and deletion policy;
4. NetworkPolicy and internal Service/TLS configuration;
5. Kubernetes object ownership metadata and monotonic generation fencing;
6. the `client-go` adapter and fake-client contracts;
7. public deployment mutation and status endpoints; and
8. real-cluster recovery and failure-injection evidence.

The next architectural layer should address managed runtime/provider credentials. A pod cannot start successfully merely because it can download its bundle; the runtime also needs a deliberately owned source for provider and embedded-tool keys plus its inbound `RUNTIME_API_TOKEN`. MCP bearer values are no longer part of the target architecture: AgentFlow-managed MCP servers are selected from a trusted catalog and called without application-level authentication.

---

## Deployment Architecture Decision 8: AgentFlow-Owned Runtime Credentials and Managed MCP Catalog

### 1. Decision Status

This decision establishes the product contract for runtime credentials and MCP servers before the live Kubernetes adapter is implemented.

The accepted direction is:

- AgentFlow owns all provider and embedded-tool API credentials used by hosted runtimes;
- users cannot bring, name, or reference their own credentials;
- every deployed agent graph receives a dedicated Kubernetes Secret containing only the credentials required by that graph;
- MCP selection is configured separately for each agent;
- users select MCP servers only by a stable `server_id` from an AgentFlow-owned MongoDB catalog;
- the Studio resolves local execution URLs from that catalog;
- publication resolves and freezes Kubernetes deployment URLs into the immutable bundle;
- deployed runtimes do not query MongoDB or the MCP catalog;
- MCP calls use plain HTTP without an application-level API key, login, signup, bearer token, or user credential;
- MCP bearer support is removed rather than retained as an unused product path;
- an unavailable MCP server degrades only that capability and does not fail the whole agent run; and
- bundle `schema_version` remains `1` as an explicit pre-production compatibility reset rather than being incremented.

Several production-hardening concerns are deliberately deferred by product decision. They are recorded later in this chapter so that deferral is not mistaken for accidental omission.

### 2. Why the Current MCP Shape Must Change

The current data flow allows a user to submit:

```json
{
  "alias": "jira",
  "url": "https://user-controlled.example/mcp",
  "bearer_env": "OPENAI_API_KEY"
}
```

That data currently travels through:

```text
Agent HTTP request
  -> agent.MCPServerConfig
  -> MongoDB AgentDocument
  -> deployment.BundleMCPServer
  -> runtime toMCPServerSpecs
  -> os.Getenv(bearer_env)
  -> Authorization: Bearer <resolved value>
  -> configured MCP URL
```

The API does not return the resolved secret, but that is not sufficient protection. A caller can choose both the environment-variable name and the destination URL. If the runtime contains the named variable, it will send that value to the selected server. This is a credential-exfiltration path.

The target design removes both user-controlled inputs:

```text
user chooses server_id
  -> trusted MongoDB catalog owns both URLs
  -> publication freezes the trusted deployment URL
  -> runtime calls that URL without a bearer token
```

The important invariant is not merely "the token is hidden from JSON." It is:

> No user-controlled value can cause the runtime to read an environment secret or choose where a secret is sent.

### 3. Provider Credentials and MCP Credentials Are Different Concerns

An agent runtime may require provider credentials:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
NVIDIA_API_KEY
TAVILY_API_KEY
```

Those credentials allow the runtime itself to call an external model or embedded-tool provider. AgentFlow owns them and injects only the ones required by the published graph.

An MCP server may independently call another external system:

```text
agent runtime
  -> HTTP call with no MCP authentication
  -> Weather MCP server
  -> external weather provider
```

If that external provider requires a key, the key belongs in the Weather MCP server's own workload Secret. It does not belong in the agent runtime Secret and is never sent by the runtime to the MCP server.

Therefore the credential boundary is:

| Workload | Credentials it may receive |
| --- | --- |
| Agent runtime pod | Required model-provider keys, required embedded-tool keys, and `RUNTIME_API_TOKEN` |
| MCP server pod | Only credentials required by that MCP server's own downstream integrations |
| User | No provider or MCP credential |

An MCP server that does not call a credentialed downstream service receives no integration Secret.

### 4. Mutable Agent Configuration

MCP selection remains per agent. A supervisor, researcher, and calculation agent may therefore receive different tool sets even though they run inside one graph pod.

The accepted public shape is:

```json
{
  "name": "Documentation Researcher",
  "provider": "openai",
  "model": "example-model",
  "mcp_servers": [
    {
      "server_id": "sequential-thinking"
    },
    {
      "server_id": "fetch"
    }
  ]
}
```

Each entry is an object rather than a bare string so that future safe selection metadata could be added without replacing the containing API field. The only accepted field in the current scope is `server_id`.

The mutable agent record deliberately does not contain:

- an MCP URL;
- a user-selected alias;
- `bearer_env`;
- a bearer token;
- a Kubernetes Service or namespace; or
- a provider credential reference.

The catalog owns the alias. This keeps generated names such as `mcp__fetch__fetch` deterministic and prevents user-created aliases from colliding or violating model-provider tool-name restrictions.

### 5. MongoDB MCP Catalog

The Studio MCP catalog is stored in MongoDB and controlled by AgentFlow. All authenticated users see the same enabled catalog. There are no plans, organization entitlements, or user-specific visibility rules in this scope.

The proposed first document shape is:

```json
{
  "_id": "<mongodb object id>",
  "server_id": "sequential-thinking",
  "name": "Sequential Thinking",
  "description": "Structured step-by-step reasoning tools",
  "alias": "sequential_thinking",
  "studio_url": "http://localhost:8101/mcp",
  "deployment_url": "http://sequential-thinking.mcp-system.svc.cluster.local/mcp",
  "enabled": true,
  "created_at": "<timestamp>",
  "updated_at": "<timestamp>"
}
```

`server_id` is the stable product identifier stored by agents. It must be unique, bounded, and safe to use in logs and API paths.

`alias` is the catalog-owned segment used when MCP tools are namespaced for the model.

`studio_url` is used when the ordinary Studio backend executes an agent locally. It may point at a locally running server.

`deployment_url` is frozen into a publication and must be reachable from the Kubernetes runtime pod. In Kubernetes this normally names a ClusterIP Service by cluster DNS.

`enabled` controls whether the entry appears in the read-only user catalog and whether it can be selected for new configuration. Cross-deployment revocation behavior is outside the current scope.

No catalog-version field is introduced in this phase. Updating a catalog record affects later Studio resolutions and later publications. It does not rewrite already published bundle bytes.

### 6. Why Studio and Deployment URLs Must Be Separate

`localhost` names the network namespace of the process making the request.

During local Studio development:

```text
Studio backend -> http://localhost:8101/mcp
```

Inside a Kubernetes runtime pod:

```text
localhost -> the runtime pod itself
```

It does not mean the developer machine and it does not mean a different MCP pod. A Kubernetes deployment therefore needs an address such as:

```text
http://sequential-thinking.mcp-system.svc.cluster.local/mcp
```

Trying to use one URL for both environments would either break Kubernetes deployments or force local development to reproduce cluster DNS. Two explicit fields keep environment resolution visible and deterministic.

### 7. Read-Only MCP Catalog API

The public API adds:

```http
GET /api/mcp-servers
Authorization: Bearer <studio-user-token>
```

This authentication protects the normal Studio API boundary. It is unrelated to MCP runtime authentication. The selected MCP servers themselves still accept calls from the runtime without an application bearer token.

The response exposes only selection metadata:

```json
[
  {
    "server_id": "sequential-thinking",
    "name": "Sequential Thinking",
    "description": "Structured step-by-step reasoning tools",
    "alias": "sequential_thinking"
  }
]
```

The response does not need to expose `studio_url`, `deployment_url`, MongoDB `_id`, Kubernetes namespaces, Service names, or Secret information. Those values are platform implementation details rather than user choices.

There is no public catalog create, update, or delete API in this scope. Initial entries are inserted through project-owned MongoDB seed or bootstrap tooling. Administrative catalog APIs may be added later if operational need justifies them.

### 8. Initial MCP Catalog

The intended initial catalog contains:

| Proposed `server_id` | User-facing name | Upstream/project name supplied for evaluation | Intended category |
| --- | --- | --- | --- |
| `sequential-thinking` | Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning utility |
| `fetch` | Fetch | `mcp-server-fetch` | Remote content retrieval |
| `python-sandbox` | Python Sandbox | Python Sandbox | Sandboxed computation and code execution |
| `math-utilities` | Math & Utilities | Math & Utilities | Deterministic calculations and utility operations |
| `open-meteo` | Open-Meteo | Open-Meteo | Weather information |

These names are the accepted product candidates, not yet verified runtime manifests. Before any entry is declared runnable, implementation investigation must confirm:

- the exact upstream repository/package and license;
- the supported MCP protocol version;
- whether it exposes Streamable HTTP directly;
- its command, arguments, image, port, and MCP path;
- whether it is truly stateless;
- whether it needs downstream credentials;
- its CPU, memory, temporary storage, and shutdown behavior; and
- whether its tool names remain valid after AgentFlow namespacing.

AgentFlow's current MCP client uses Streamable HTTP and accepts JSON or server-sent-event responses. An upstream server that exposes only MCP over standard input/output cannot be called through a Kubernetes Service directly. Such a server would need one of:

1. an upstream-supported Streamable HTTP mode;
2. a small AgentFlow-owned HTTP transport adapter; or
3. a different server implementation that already supports the required transport.

This transport check is a prerequisite, not a reason to guess image or port settings.

### 9. Server-Specific Safety Boundaries

The initial servers are stateless and require no inbound MCP authentication, but stateless does not mean harmless.

#### Fetch

A generic fetch tool accepts a URL chosen indirectly by the model. If its server can reach cluster-internal or cloud metadata addresses, it can become an SSRF proxy even though the agent runtime's built-in HTTP tool has its own SSRF checks.

Before a Fetch MCP is exposed beyond controlled local development, the server or its network boundary must prevent access to loopback, link-local, private infrastructure, cloud metadata, and other prohibited destinations. Otherwise moving fetch into an MCP server would bypass rather than preserve the existing HTTP-tool security boundary.

#### Python Sandbox

A Python tool executes model-generated code. It must never run inside the agent runtime process or share the runtime's filesystem and credentials. A separate pod or properly isolated local process is required.

At minimum, its eventual workload needs no Kubernetes service-account token, no host mounts, a non-root identity, a read-only root filesystem, bounded temporary storage, resource limits, syscall/capability restrictions, execution timeouts, and controlled network access. Detailed sandbox engineering is outside this implementation slice, but unsafe code execution cannot be treated as an ordinary catalog configuration detail.

#### Sequential Thinking and Math & Utilities

These are expected to be local computational utilities. Exact packages and transport still require verification. If they are deterministic and have no external dependencies, they should require no integration Secret.

#### Open-Meteo

This server is expected to call an external weather service. Whether it requires a downstream key must be confirmed from the selected implementation. If it does, that credential belongs to the Open-Meteo MCP workload rather than the agent runtime.

### 10. Local Studio Resolution

The Studio agent document contains only `server_id`, so it is not directly executable by the existing runtime.

Before a local Studio run begins:

```text
load agent
  -> resolve each server_id through MCP catalog
  -> require enabled catalog entry
  -> build an execution-only MCP config using alias + studio_url
  -> start the run
```

This resolved object is runtime input, not persisted agent configuration. The bearer token field does not exist.

The lookup should fail before model execution if the agent refers to a missing catalog entry. A network failure after successful resolution follows the soft-degradation behavior described below.

### 11. Publication Resolution and Immutable Bundle

Publication is the authoritative freeze boundary for managed hosting.

For the complete reachable graph, the publisher performs:

```text
load stable two-pass agent graph snapshot
  -> collect every per-agent MCP server_id
  -> resolve every ID from MongoDB catalog
  -> require each entry to exist and be enabled
  -> copy server_id + alias + deployment_url into BundleAgent
  -> validate the resolved HTTP endpoint shape
  -> compute canonical configuration hash
  -> store exact immutable bundle bytes in the new revision
```

The bundle representation is:

```json
{
  "server_id": "sequential-thinking",
  "alias": "sequential_thinking",
  "url": "http://sequential-thinking.mcp-system.svc.cluster.local/mcp"
}
```

It contains no `bearer_env` and no credential.

Because the resolved URL is part of `BundleAgent`, it participates in the canonical configuration hash. Updating a MongoDB catalog URL later does not mutate an existing publication. A new publication resolves the current catalog and may produce a different hash. As already decided, equal hashes are allowed across distinct revision IDs.

The runtime reads only the bundle. It never calls the Studio MCP catalog or MongoDB.

### 12. No-Authentication MCP Runtime Path

The managed runtime connection becomes:

```text
BundleMCPServer{server_id, alias, url}
  -> MCPServerSpec{alias, url}
  -> HTTP MCP initialize
  -> tools/list
  -> tools/call
```

There is no environment lookup and no `Authorization` header.

HTTP is accepted for the local and initial internal Kubernetes MCP connections by product decision. The URL remains trusted platform configuration: it comes from the catalog and not from the user. Basic syntax validation still requires an absolute HTTP URL with a host and no embedded user information.

The generic HTTPS-plus-public-address SSRF validator used for arbitrary external MCP URLs cannot simply be weakened globally. The user-controlled external-URL path is being removed. A separate managed-MCP validation rule should validate trusted Studio and deployment URL roles explicitly.

### 13. Safe MCP Failure Semantics

MCP unavailability is a capability failure, not an agent-process failure.

At run start, discovery remains parallel and time-bounded. If one server is unavailable:

```text
mark that alias unavailable
  -> omit its tools from the effective tool set
  -> add an MCP status explanation to agent context
  -> continue the run with all remaining tools
```

The agent should receive a clear message equivalent to:

```text
MCP server "fetch" is currently unavailable. Its tools cannot be used in this
run. Continue with the remaining capabilities, or explain the limitation when
the request depends on that server.
```

If a resumed checkpoint contains a pending call for a now-unavailable MCP tool, the runtime synthesizes a soft tool result rather than returning a fatal Go error:

```json
{
  "is_error": true,
  "content": "The fetch MCP server is currently unavailable. Continue without this tool."
}
```

The model may then continue or tell the user that the requested capability is temporarily unavailable. The runtime process, thread, and run infrastructure remain healthy.

### 14. Managed Runtime Secret Planning

The trusted credential source is an AgentFlow-owned Kubernetes Secret available to the deployment controller. Users cannot name Secret objects or keys.

For one immutable bundle, trusted control-plane logic calculates:

```text
all agents in bundle
  -> unique provider set
  -> unique embedded-tool set
  -> exact required credential names
```

For example:

```text
root agent:       provider=openai
research agent:   provider=anthropic, tools=[web_search]

required platform keys:
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  TAVILY_API_KEY
```

The controller creates one per-deployment runtime Secret containing only those keys plus a generated `RUNTIME_API_TOKEN`. It must not use `envFrom` to import every platform credential. Extra keys present in the AgentFlow-owned source Secret are deliberately not copied.

The workload renderer already supports explicit `secretKeyRef` entries through `RuntimeSecretEnvNames`. The pure planning and Secret-rendering parts of that responsibility are now implemented:

- `llm.CredentialEnvName` exposes provider credential names from the same provider table used to construct runtime clients;
- `tools.CredentialEnvNames` owns embedded-tool credential metadata, currently `web_search -> TAVILY_API_KEY`;
- `deployment.PlanRuntimeCredentials` scans the complete immutable bundle and returns a sorted, deduplicated names-only plan;
- `deployment.NewRuntimeAPIToken` creates a prefixed token from 32 bytes of operating-system cryptographic randomness; and
- `kubernetes.RenderRuntimeSecret` validates the AgentFlow source Secret data and constructs a per-deployment opaque Secret containing only the planned keys plus `RUNTIME_API_TOKEN`.

The renderer performs no Kubernetes API call. Reading the configured platform Secret, deciding whether to preserve or rotate the existing runtime token, applying the rendered Secret, and fencing that mutation by deployment generation still belong to the future live adapter.

If a required platform key is absent, the controller should report a safe deployment prerequisite failure before creating a pod that can never become ready. Agent creation and publication validate supported configuration rather than disclosing whether a particular secret value exists.

### 15. Runtime API Token Lifetime

`RUNTIME_API_TOKEN` is distinct from provider keys, MCP access, Studio JWTs, and artifact-delivery tokens.

The accepted current lifecycle is:

```text
create token A
  -> token A remains valid without a time-based expiry
  -> create replacement token B
  -> token B becomes the current token
  -> token A is no longer accepted
```

Token creation is an explicit operation rather than a side effect of credential planning or Secret rendering. This distinction prevents an ordinary reconciliation retry from silently rotating the runtime credential. The future adapter should create one token for a new desired generation, reuse it while retrying that generation, and create a replacement only for a later generation or an explicit rotation operation.

Kubernetes injects Secret-backed environment variables when a container starts; it does not update the process environment of an already-running container. Explicit token rotation therefore also requires a pod restart or rollout so the runtime starts with the replacement value. Rotation orchestration and overlap are outside the present scope. The value remains controller-generated deployment authority rather than a user value or bundle field.

### 16. Bundle Schema Version 1 Compatibility Reset

The accepted decision is not to increment `deployment.SchemaVersion` from `1` to `2` even though the MCP object changes.

This must be described accurately: schema version 1 is being redefined during pre-production development.

Old shape:

```json
{
  "alias": "fetch",
  "url": "https://example.invalid/mcp",
  "bearer_env": "FETCH_TOKEN"
}
```

New shape:

```json
{
  "server_id": "fetch",
  "alias": "fetch",
  "url": "http://fetch.mcp-system.svc.cluster.local/mcp"
}
```

Consequences accepted for this personal pre-production project:

- backward compatibility with existing bundle bytes is not promised;
- an old schema-version-1 bundle may fail strict decoding in the new runtime;
- existing publications are development artifacts rather than deployable contracts;
- existing MongoDB agent documents may be reset or rewritten instead of migrated; and
- only newly created agent data and newly published bundles are expected to satisfy the new contract.

Keeping the numeric version avoids migration work but does not make the formats compatible. This is a development-time compatibility reset, not a generally safe production schema-evolution pattern.

### 17. Deliberately Deferred

The following are explicitly outside this implementation scope:

- provider and embedded-tool credential rotation;
- shared-provider-key quota, abuse, and blast-radius controls;
- MCP catalog versioning;
- disabling or revoking catalog entries across already published deployments;
- advanced MCP resource and concurrency policy;
- complete production NetworkPolicy design;
- a credential-independent redesign of every embedded-tool validation path;
- production migration of existing agent documents;
- backward-compatible public API transition;
- backward compatibility for existing publication bundles; and
- a public or administrative MCP catalog mutation API.

Deferral does not permit secret values in logs, bundles, MongoDB agent documents, HTTP responses, or deployment status. It also does not remove ordinary correctness requirements such as bounded HTTP clients, cancellation, response-size limits, and safe error messages.

### 18. File-by-File Implementation Plan and Current Status

The MCP configuration path described in Phases A through F has now been implemented and validated as one atomic pre-production contract replacement. The validation evidence is recorded in Section 19.

Implemented behavior now includes:

- the `mcp_servers` MongoDB catalog, its unique `server_id` index, deterministic enabled listing, and enabled-ID batch lookup;
- authenticated `GET /api/mcp-servers`, exposing only `server_id`, name, description, and alias;
- mutable agent API and persistence entries containing only `server_id`;
- catalog membership validation during agent create and update;
- Studio run preparation that resolves `server_id` to catalog-owned `alias + studio_url` without mutating the persisted agent;
- publication-time batch resolution of the stable graph to `alias + deployment_url`;
- immutable bundle entries containing `server_id + alias + url` under unchanged schema version `1`;
- deployed runtime reconstruction of execution-only MCP connections from bundle data without MongoDB;
- managed HTTP/HTTPS endpoint validation without the old arbitrary-external-URL SSRF policy;
- complete removal of MCP `bearer_env`, bearer-token resolution, and MCP Authorization-header behavior; and
- focused test code for catalog persistence/API safety, agent selection persistence and validation, Studio resolution, publication freezing, bundle behavior, no-auth transport, and soft discovery failure.

The initial five catalog records have deliberately not been auto-seeded. Their exact upstream implementation, Streamable HTTP support, local address, image, port, path, and Kubernetes Service address remain unverified, so inserting guessed runnable URLs would create false configuration. Phase H must establish those facts before seed/bootstrap data or manifests are added.

The original implementation sequence is retained below as a responsibility map.

#### Phase A: MCP catalog domain and MongoDB adapter

Expected additions:

- a small MCP catalog package defining `CatalogEntry` and a read-oriented `Catalog` interface;
- a MongoDB catalog document model;
- a MongoDB repository with unique `server_id` indexing and enabled-entry lookup/list methods;
- project-owned seed/bootstrap data for the five initial entries; and
- repository tests for uniqueness, deterministic listing, missing IDs, and disabled entries.

The catalog abstraction protects a real boundary: Studio configuration refers to stable IDs, while infrastructure URLs remain catalog-owned values.

#### Phase B: Read-only MCP catalog HTTP API

Expected changes:

- add a catalog handler exposing `GET /api/mcp-servers`;
- return only safe selection metadata;
- register the authenticated route in `backend/main.go`; and
- add handler tests for successful listing, empty listing, storage failure, and non-exposure of internal URLs.

No create, update, or delete route is added.

#### Phase C: Agent API, domain, and MongoDB selection model

Expected changes:

- replace `agent.MCPServerConfig{Alias, URL, BearerEnv}` with a selection type containing `ServerID`;
- change agent request/response JSON entries to `{ "server_id": "..." }`;
- validate nonempty, bounded, unique IDs and catalog membership;
- change `MCPServerConfigDoc` to persist only `server_id`;
- update repository conversion helpers and round-trip tests; and
- remove every `bearer_env` field and mapping from this path.

Because backward compatibility is explicitly not required, legacy agent documents do not receive an automatic URL-to-ID migration in this phase.

#### Phase D: Studio execution resolution

Expected changes:

- inject an MCP catalog resolver into the Studio execution-preparation boundary;
- resolve selected IDs to `alias + studio_url` before an agent run;
- keep resolved connection data out of MongoDB agent documents;
- fail preparation clearly for missing/disabled catalog entries; and
- preserve soft degradation for network discovery failures.

The exact responsible component should be selected after tracing all Studio run entry points so resolution happens once and applies equally to direct, bus-dispatched, delegated, fresh, and resumed runs.

#### Phase E: Publication and bundle contract

Expected changes:

- inject the MCP catalog into `publisher.Service`;
- resolve the complete stable graph's selections using `deployment_url`;
- replace `BundleMCPServer.BearerEnv` with `ServerID`;
- permit trusted absolute HTTP deployment URLs;
- retain resolved alias and URL in canonical hash input;
- update bundle validation, conversion, publication, hashing, and MongoDB round-trip tests; and
- keep `SchemaVersion = 1` under the accepted development reset policy.

Publication must perform resolution after obtaining the stable graph snapshot and before final validation/hash persistence. A catalog lookup failure must not append a revision.

#### Phase F: Runtime no-auth MCP client

Expected changes:

- remove `BearerEnv` environment lookup from `agent/runtime.go`;
- remove `BearerToken` from `tools.MCPServerSpec`;
- remove the bearer argument and `Authorization` header behavior from `mcp.Client`;
- introduce managed HTTP URL validation suitable for catalog-produced endpoints;
- preserve discovery and call timeouts, response bounds, and soft tool errors; and
- update MCP client, manager, runtime composition, resume, and bundle environment tests.

The runtime must not gain a MongoDB or catalog dependency.

#### Phase G: Runtime credential planner

Implemented additions and changes:

- define the supported provider-to-environment-key mapping as trusted platform metadata;
- define embedded-tool credential requirements such as `web_search -> TAVILY_API_KEY`;
- scan all agents in a bundle and return a sorted, deduplicated required-key plan;
- validate that the supplied AgentFlow-owned source Secret data contains every required, nonempty key;
- generate `RUNTIME_API_TOKEN` using cryptographically secure randomness; and
- render the exact least-privilege Secret data needed by the per-deployment runtime and existing workload renderer.

The implementation is deliberately split between a pure names-only plan and a Kubernetes Secret renderer. Token generation is also explicit so the future adapter, rather than a retrying pure function, owns rotation timing. Actual source-Secret lookup and Kubernetes Secret application belong to the later live adapter. No secret value enters deployment state or the immutable bundle.

#### Phase H: Initial MCP server deployment investigation

Before writing manifests, inspect each accepted upstream server and record:

- exact source and license;
- trusted container build or the need for an AgentFlow-owned image;
- Streamable HTTP versus stdio transport;
- local and Kubernetes start commands;
- health behavior;
- port/path;
- downstream credentials;
- statelessness; and
- special security constraints.

This investigation may reveal that a small HTTP transport wrapper is required for some entries. That would materially affect image ownership and operational scope, so it requires a separate implementation approval rather than being hidden inside catalog work.

### 19. Validation Evidence

The implemented MCP contract was validated on October 14, 2026. The checks were run with a temporary writable Go build cache because the sandboxed home cache is read-only.

The following commands completed successfully from `backend/`:

```text
go test ./mcp ./tools ./handlers ./agent ./dispatcher ./deployment ./publisher ./runtime
go test ./repo/mongorepo
go test ./...
go build ./...
```

The focused packages confirmed the MCP catalog, HTTP handler, agent validation, Studio resolution, publication freezing, bundle reconstruction, no-auth MCP transport, runtime composition, and safe capability degradation. The MongoDB repository tests passed against the local MongoDB service and isolated `TestDB` database. The complete backend test suite then passed, including integration tests and both MongoDB and SQLite adapters. Finally, every backend package compiled successfully.

Together, these checks provide evidence for:

1. catalog repository integration tests against local MongoDB;
2. catalog handler tests proving URLs are not exposed;
3. agent handler and repository round-trip tests for `server_id` selections;
4. publisher tests proving catalog resolution happens before revision insertion;
5. bundle hash tests proving resolved URL changes affect configuration hash;
6. runtime tests proving no environment value becomes an MCP Authorization header;
7. MCP failure tests proving one unavailable server does not fail the run;
8. the full backend test suite with the local MongoDB service running; and
9. successful compilation of every backend package.

Phase G was validated on October 15, 2026. The following additional commands completed successfully from `backend/`:

```text
go test ./llm ./tools ./deployment ./deployment/kubernetes
go test ./...
go build ./...
```

The focused Phase G test gate passed for provider/tool credential metadata, complete-graph planning, deterministic deduplication, secure token structure and entropy failure, missing or empty source credentials, exact-key copying, defensive byte copies, and invalid Secret inputs. The subsequent complete backend suite passed against the local MongoDB service, including integration tests and both persistence adapters. The final build compiled every backend package successfully. The sandbox printed three non-fatal stream-descriptor warnings during the build, but `go build ./...` exited successfully.

### 20. Next Approval Boundary

The MCP contract and Phase G credential work are both implemented and validated. The pure control-plane boundary can now determine the exact provider/tool keys required by an immutable graph, generate and validate runtime API tokens, and render a least-privilege per-deployment Secret without reading or mutating a Kubernetes cluster.

The next architecture decision is between:

- continuing the managed deployment prerequisite sequence with the accepted stable-PVC policy, Kubernetes ownership metadata, generation fencing, and eventually the live `client-go` adapter; or
- the upstream MCP server investigation from Phase H, which is required before the initial five catalog entries can receive truthful seed data and Kubernetes manifests.

Kubernetes Secret lookup/application, the controller executable, catalog seed data, and MCP server workloads remain unimplemented.

## Deployment Architecture Decision 9: One Stable PVC per Logical Deployment

### 1. Decision Status

**Status:** Product contract accepted. A read-only repository investigation was completed before implementation. No runtime, persistence, or Kubernetes code was changed by this decision record.

The decision is:

> One logical AgentFlow deployment owns one Kubernetes PVC. Every forward revision of that deployment mounts the same PVC. Revision, generation, configuration hash, and runtime-image updates must not create a replacement PVC.

The volume is durable deployment state, not revision packaging. A revision is an immutable description of behavior; it is not the owner of the user's continuing data.

### 2. Plain Mental Model

Treat the logical deployment as a person using one long-lived workspace:

```text
logical deployment
├── stable address       -> one Kubernetes Service
├── replaceable worker -> one active runtime pod
├── changing behavior  -> forward-only immutable revisions
└── durable workspace  -> one stable PVC
```

Changing the worker's instructions should not replace its filing cabinet. It may change which work it is allowed to continue, but it must not make conversations, memories, or prior scratchpad files disappear.

That analogy has an important limit: an old half-completed action is not automatically safe to continue under new instructions. Therefore the filing cabinet is physically shared, while execution ownership remains revision-specific.

### 3. Stable PVC Identity

The PVC identity is derived from:

- the authenticated AgentFlow owner; and
- the logical deployment ID.

It must not include:

- revision ID;
- deployment generation;
- configuration hash;
- runtime image digest; or
- the source revision used to create a forward restoration.

This gives the required invariant:

```text
PVC(owner, deployment, revision 1, hash A) = P
PVC(owner, deployment, revision 2, hash B) = P
PVC(owner, deployment, revision 3, hash A) = P
```

The exact DNS-safe spelling is an implementation detail, but it must be deterministic, owner-scoped, and collision-resistant. The existing stable owner-plus-deployment resource-name function is the natural source of identity; suffixing or truncation must still respect Kubernetes name limits.

### 4. Initial Kubernetes Storage Contract

The accepted initial PVC settings are:

| Property | Decision | Why |
| --- | --- | --- |
| Claims per logical deployment | Exactly one | A deployment update must not replace its durable workspace. |
| Access mode | `ReadWriteOnce` | The accepted topology has exactly one active runtime pod and does not require multi-node writers. |
| Volume mode | `Filesystem` | SQLite, memory bodies, and scratchpads use normal filesystem paths and operations. |
| StorageClass | Cluster default | Keeps the first version platform-neutral; cluster compatibility must still be verified. |
| Initial requested size | 5 GiB | A practical starting allocation for the current bounded memory/scratchpad files and growing SQLite history. |
| Automatic backup | Not included initially | This is an explicitly accepted recovery limitation, not an implicit guarantee. |
| Automatic deletion on undeploy | No | Stopping the workload must not destroy durable agent data. |
| MCP access | Never mounted into MCP pods | MCP servers are separate stateless capabilities and do not own agent data. |

`ReadWriteOnce` is an attachment/access contract, not a complete concurrency lock. The workload and persistence layers must still enforce one active writer.

### 5. Lifecycle Contract

#### Deploy or update

Ensure the deployment-owned PVC exists, then mount that same claim into the one runtime pod.

#### Undeploy

Delete or stop the runtime-facing resources, but retain the PVC and its contents. A later redeploy of the same logical deployment reattaches the same claim.

#### Purge

Permanent deletion of the retained PVC is a separate destructive product action. Its API, confirmation, authorization, audit, and recovery behavior are not in the current implementation scope.

#### Namespace or StorageClass change

A PVC cannot simply be renamed or moved across namespaces, and its storage class is not a normal in-place deployment setting. Changing either requires an explicit copy/snapshot/restore migration with verification and cutover. An ordinary revision update must not attempt it.

### 6. What Survives a Revision Change

| Data | Physical retention on PVC | May the new revision actively adopt it? |
| --- | --- | --- |
| Root conversation threads | Yes | Yes, as current deployment history. |
| User and assistant messages | Yes | Yes, as current deployment history. |
| Durable memory metadata and bodies | Yes | Yes, through a stable deployment/runtime principal and compatible schema. |
| Existing scratchpad files | Yes | Not as a new revision's own workspace; preserve under the creating run/revision identity. |
| Completed run records | Yes according to retention policy | No continuation; historical inspection only. |
| Active/interrupted runs | Yes according to retention policy | No cross-revision resume. |
| Checkpoints | Yes according to retention policy | Only the exact creating revision may resume; the replacement revision may not. |
| Pending/running async jobs and callbacks | Yes according to retention policy | No cross-revision reclaim or dispatch. |
| Task budgets and job locks | Yes according to retention policy | No cross-revision reuse. |
| Temporary files outside the PVC | No guarantee | No. |

Physical retention and active ownership are deliberately different. “The file still exists” does not mean “the new code may continue the old operation.”

### 7. Forward-Only Revision Example

Suppose the deployment progresses as follows:

```text
revision 1 / hash A
  -> creates thread T
  -> stores memory M
  -> creates scratchpad S for run R1

revision 2 / hash B
  -> mounts the same PVC
  -> reads T and M
  -> leaves S intact but does not treat R1 as revision-2 work
  -> writes newer messages and updates M

user selects the old revision-1 configuration
  -> AgentFlow publishes revision 3 / hash A
  -> revision 3 mounts the same PVC
  -> reads the current T and current M, including revision-2 changes
  -> receives fresh revision-3 execution ownership
  -> does not resume R1 merely because hash A matches
```

This is configuration restoration, not data rollback. Revision ID is always unique. Configuration hash is content identity and may repeat.

### 8. Why a PVC Name Change Alone Would Break the Runtime

The current runtime opens:

```text
/var/lib/agentflow/state.db
/var/lib/agentflow/memory/
/var/lib/agentflow/scratchpad/
```

Startup then computes:

```text
synthetic user ID = "runtime_" + first 32 characters of config_hash
```

The `deployment_identity` singleton in `state.db` stores deployment ID, configuration hash, and that synthetic user ID. `Bind` accepts the first boot and rejects every later boot whose hash or synthetic user differs.

Therefore the second distinct revision on a stable PVC currently fails before becoming ready:

```text
revision 1 binds state.db to hash A
revision 2 mounts the same PVC with hash B
revision 2 Bind(...) reads hash A
revision 2 receives "deployment identity mismatch"
revision 2 startup fails
```

This is a confirmed breaking change. The identity check must be redesigned, not merely deleted.

### 9. Why Removing the Identity Check Would Also Be Wrong

Deleting `DeploymentIdentityRepo.Bind` would avoid the immediate startup error but create less visible corruption and orphaning risks:

1. Threads, messages, runs, tasks, jobs, and memory rows contain the hash-derived `user_id`.
2. A new hash produces a different `user_id`.
3. Repository ownership queries then stop finding the old rows, even though they are still in the same database.
4. Memory paths also contain the old user ID, and memory metadata verifies that the stored path exactly matches revision metadata.
5. Scratchpad paths contain both user ID and originator run ID.
6. Recovery and job-coordinator queries do not carry publication revision identity.

The result would range from apparently empty history to a new coordinator reclaiming old work. The guard currently prevents that unsafe state. Implementation must replace its too-coarse identity model with a more expressive one.

### 10. Confirmed Breaking-Change Findings

| Area | Repository evidence | Consequence for the stable-PVC design |
| --- | --- | --- |
| Startup identity | `deployment_identity` immutably includes `config_hash` and hash-derived user ID | A different-hash revision cannot open the same current database. |
| Runtime principal | `Bundle.SyntheticUserID()` derives identity from configuration content | Shared rows and filesystem paths lose visibility when configuration changes. |
| Database layout | Threads, messages, runs, checkpoints, tasks, jobs, job locks, memory metadata, and memory revisions share one `state.db` | Physical reuse alone cannot distinguish product history from executable recovery state. |
| Run ownership | `runs` has user and agent IDs but no deployment revision/config/generation | A run cannot prove which publication revision owns it. |
| Checkpoint ownership | Snapshot metadata records agent/model/tool identity but no deployment revision or config hash | Tool validation does not enforce the accepted no-cross-revision-resume rule. |
| Runtime revision context | Revision and generation exist in `WorkloadInput` and pod annotations, but the bundle and runtime process configuration contain neither | The runtime cannot label or select revision-owned execution storage until trusted platform revision context is delivered to the process. |
| Orphan recovery | Cold start recovers every `running` row for the current user ID | A stable user identity would make old-revision runs eligible unless recovery gains revision fencing. |
| Async jobs | Queue, expiry, callback, and ready-run queries have no deployment revision predicate | A replacement runtime could claim, fail, callback, or resume old-revision work. |
| Task budgets and locks | Keys are based on originator runs/jobs, without publication revision identity | Old execution coordination remains globally visible in the shared DB. |
| Memory files | Body and pending paths start with `UserID`; metadata validates the exact derived path | Changing to a stable principal requires retaining the legacy principal or migrating rows and files together. |
| Scratchpads | Workspace path is `<user>/scratchpads/<originator-run>` | Bytes can remain safely, but cross-revision resume must be blocked and retention must be deliberate. |
| Conversation access | Root threads are looked up by stable thread ID and user ID; sending also loads the thread's agent ID from the current bundle | Stable user identity preserves history, but removed/renamed agent IDs can leave old agent-scoped threads or memory unavailable without deleting them. |
| Deployment status | `RecordDeleted` clears `observed.resources`, including `StatePVCName` | Retained storage identity cannot rely only on the current observed-resource field. |
| Kubernetes support | The renderer consumes a PVC name but renders no PVC; no live Kubernetes adapter exists | Claim creation, ownership metadata, retention, and observation remain unimplemented. |
| Filesystem assumptions | SQLite uses WAL; memory uses hard links and atomic rename; scratchpads use atomic rename | The selected default StorageClass must provide compatible locking and filesystem semantics. |
| Capacity and cleanup | SQLite history grows; expired checkpoints are labelled but no SQLite purge worker was found; scratchpad cleanup is not implemented | A fixed 5 GiB claim needs usage metrics and an explicit future expansion/retention policy. |
| Shutdown timing | Pod termination grace and HTTP shutdown are both 30 seconds, followed by additional resource cleanup | Kubernetes may reach its kill deadline before all cleanup finishes; update drain timing needs a safety margin. |

### 11. Persistent Identity Recommendation

Configuration hash must stop serving as the runtime's user/storage identity. It answers “what exact behavior is this bundle?” and is excellent for artifact verification. It does not answer “whose continuing data is this?”

The recommended model is:

```text
deployment storage identity
  -> stable for owner + logical deployment
  -> owns conversations, memory, and the PVC

revision execution identity
  -> unique revision ID + config hash + generation/provenance
  -> owns runs, checkpoints, jobs, budgets, locks, and workspace activity
```

For an existing database, preserving its already-bound synthetic user ID as the deployment's stable runtime principal is safer than rewriting every row and path merely for cosmetic naming. New databases may create a stable principal from deployment identity. In both cases, later configuration hashes must reuse the bound principal.

The deployment binding should prove only stable storage ownership. Current/creating revision identity belongs on execution records or in a physically revision-specific execution store.

#### Trusted revision context must reach the runtime

The controller already knows revision and generation, and the workload renderer places them on pod metadata. The runtime currently receives only the bundle, data path, listen address, and secrets; the bundle deliberately contains deployment ID and config hash but not publication revision.

The runtime therefore needs a trusted platform-supplied revision identity, for example validated runtime flags or Downward-API-backed platform environment variables. It must not accept this value from user-controlled Secret keys. This can be added without changing bundle schema version 1 because revision is deployment orchestration context, not canonical bundle content.

### 12. Internal Layout Alternatives

#### Option A: One SQLite database with explicit revision columns

Keep `state.db`, make the deployment principal stable, and add creating revision/config/generation fields to execution tables. Every run, checkpoint, job, task, lock, recovery, and coordinator query must carry a revision scope.

Benefits:

- fewer files and smaller composition change;
- simpler migration of existing shared rows; and
- historical queries can join shared and execution data directly.

Costs:

- one missing predicate can violate the no-adoption invariant;
- repository interfaces become scope-sensitive throughout; and
- shared and revision-owned schema evolution remain coupled.

#### Option B: Shared database plus revision execution databases

Use one shared database for deployment history/memory metadata and a distinct execution database or directory for each unique revision ID, all on the same PVC. Put revision-owned scratchpad activity under the same revision directory.

Benefits:

- non-adoption becomes a structural filesystem/database boundary;
- starting revision 9 cannot accidentally query revision 7's job queue; and
- execution cleanup can operate per revision.

Costs:

- the current one-database composition must be split;
- legacy rows must be projected into the appropriate stores; and
- workflows already spanning repositories still need explicit failure handling.

#### Recommendation

Prefer Option B unless a focused implementation design proves its migration cost disproportionate. It encodes the most important safety rule in topology rather than relying on every future SQL statement to remember a revision predicate.

A possible shape is:

```text
/var/lib/agentflow/
├── deployment-meta/
│   └── stable identity and migration markers
├── shared/
│   ├── shared.db          # root threads/messages, durable memory metadata
│   └── memory/            # durable memory bodies
└── revisions/
    ├── <revision-7>/
    │   ├── execution.db   # runs/checkpoints/tasks/jobs/locks
    │   └── scratchpad/    # run-owned workspace files
    └── <revision-8>/
        ├── execution.db
        └── scratchpad/
```

This is an implementation recommendation, not permission to change code. The exact classification of delegate sub-threads and their messages must be resolved in the implementation design because the current `threads` table contains both user-facing root threads and run-scoped delegation sub-threads.

### 13. Migration Rules

Persistent migrations must be:

- **forward-only:** deployment never expects an older schema migration to undo a newer one;
- **idempotent:** restart after an uncertain failure safely reaches the same completed state;
- **crash-observable:** durable markers distinguish not-started, in-progress, and completed phases;
- **fail-closed:** incompatible or partially migrated state keeps readiness false instead of starting with an empty store;
- **content-preserving:** no conversation, memory body, or scratchpad file is discarded merely because a revision changed; and
- **ownership-preserving:** legacy execution state is labelled or isolated as belonging to its creating legacy revision and is not made current.

If database rows and filesystem paths must move together, SQLite cannot make the filesystem rename part of the SQL transaction. The migration therefore needs a replayable protocol such as prepare marker, idempotent copy/rename, transactional metadata update, verification, and completion marker.

### 14. Public Compatibility

The stable-PVC change does not inherently require:

- a new public HTTP API version;
- a new immutable bundle schema version;
- a change to configuration hashing; or
- a different forward-revision rule.

`schema_version = 1` may remain the bundle contract because PVC ownership is control-plane/runtime persistence behavior, not a new bundle field.

Revision fencing still requires the controller to pass trusted revision/generation context to the runtime outside the bundle. Keeping the bundle schema unchanged must not be mistaken for saying the runtime needs no new startup input.

It does require a new internal persistent-storage schema/migration. That is a breaking change for current `--data` directories unless the runtime performs the approved forward migration. Code and tests that assert immutable config-hash database binding will also need intentional replacement.

### 15. Retention, Backup, and Capacity Consequences

Retaining one PVC through every revision means data accumulates instead of being abandoned in separate claims. That is the desired continuity, but it creates operational obligations:

- report requested, capacity, and used bytes;
- alert before filesystem exhaustion;
- define online volume expansion behavior for StorageClasses that support it;
- eventually purge expired checkpoints, terminal execution state, job locks, and obsolete scratchpad artifacts under explicit policy;
- expose migration failures without creating a fresh empty database; and
- make the lack of automatic backup clear to the operator.

Initially, node/volume loss or accidental PVC deletion can cause permanent data loss. Kubernetes restart behavior is not a backup.

### 16. One-Writer and Storage Safety

The existing `replicas: 1` plus `Recreate` strategy is necessary and remains correct. It prevents the normal rollout from intentionally running old and new pods together.

It is not sufficient by itself because stale processes, manual pods, delayed termination, or controller mistakes can still exist. The final design should combine:

1. workload-level one replica and `Recreate`;
2. deterministic ownership labels and references;
3. deployment generation/revision fencing at the storage boundary;
4. readiness remaining false until identity and migrations are verified; and
5. a termination grace period longer than the application's complete drain-and-close budget.

The PVC's default StorageClass must also be tested for SQLite WAL locking, atomic rename, hard-link support, ownership through `fsGroup`, node reattachment, and expansion behavior. “Filesystem volume mounted successfully” is not enough evidence that application persistence is safe.

### 17. Deployment-State Consequence

Today `RecordDeleted` clears `observed.resources`, including `StatePVCName`. That matched a model in which deleted runtime resources disappeared together. It conflicts with the new lifecycle because undeploy intentionally leaves the PVC behind.

Implementation needs one of these durable representations:

- a separate deployment storage reference that survives runtime deletion; or
- purely deterministic PVC identity plus explicit retained-storage status.

The second is simpler for lookup, but status and a future purge action still need to distinguish “no PVC has ever been provisioned” from “PVC retained after undeploy.” Therefore retained storage should be an explicit product state, not inferred only from the absence of running resources.

### 18. MCP Isolation

MCP servers run in separate pods or local processes and receive URLs through the published deployment configuration. They must not mount the agent deployment's PVC.

This protects three boundaries:

- an MCP implementation cannot read agent conversations or memory directly;
- an unavailable/replaced MCP server cannot corrupt runtime storage; and
- MCP lifecycle remains independent from retained deployment data.

The runtime calls MCP over HTTP. Safe MCP failure remains a tool-level denial/error message to the agent rather than a reason to replace or detach the PVC.

### 19. What Is Complete and What Is Not

**Product decisions complete:**

- one stable PVC per logical deployment;
- same claim across every forward revision, generation, and repeated config hash;
- one active runtime pod and one active writer;
- RWO filesystem volume, default StorageClass, initial 5 GiB request;
- conversations, memory, and prior scratchpad files retained;
- no cross-revision adoption of runs, checkpoints, jobs, budgets, or workspace ownership;
- undeploy retains data;
- purge is a separate future destructive action;
- no initial automatic backup, with the limitation made explicit;
- namespace/StorageClass moves require explicit migration; and
- MCP workloads never mount the claim.

**Confirmed implementation missing:**

- PVC object rendering and live Kubernetes creation/observation;
- stable storage reference lifecycle in deployment state;
- stable runtime principal resolution;
- shared-versus-execution persistence separation;
- revision-bound recovery and async-job fencing;
- legacy `state.db`, memory-path, and scratchpad migration;
- storage compatibility checks and capacity observability;
- retention/purge workers and volume expansion policy; and
- real-cluster failure, reattachment, and migration tests.

### 20. Next Approval Boundary

The next engineering task should not begin with a PVC renderer. Doing that first would create a claim that the second revision cannot safely use.

The next architecture-and-implementation briefing should define the internal storage boundary and migration in this order:

1. choose the shared-database plus revision-execution-directory layout, or justify the one-database scoped alternative;
2. define the stable runtime principal and legacy identity adoption rule;
3. classify every current SQLite table and filesystem path as shared, revision-owned, derived, or historical;
4. define the forward, idempotent migration state machine;
5. define revision fencing for resume, orphan recovery, async jobs, callbacks, budgets, and locks;
6. define retained storage state in MongoDB; and
7. only then render/apply the PVC and wire it into the live Kubernetes adapter.

No code, database, test, build, dependency, or Kubernetes change is authorized by this documentation decision alone.

## Deployment Architecture Decision 10: Stable Persistence Boundary, Revision Fencing, and Forward Migration

### 1. Decision Status and Scope

This decision turns the stable-PVC product contract from Decision 9 into an implementable internal design.

It decides:

- which data belongs to the logical deployment and which data belongs to one immutable publication revision;
- how the runtime proves that it mounted the correct deployment's volume;
- how a stable runtime principal replaces the configuration-hash-derived principal;
- how old runs, jobs, checkpoints, budgets, locks, and scratchpads are prevented from becoming current work;
- how one runtime writer is enforced across pod replacement;
- how the existing combined `state.db` layout is migrated without guessing lost revision identity; and
- how MongoDB remembers a retained PVC independently from the currently running Kubernetes resources.

This is an internal persistence and controller design. It does not change the public bundle schema, configuration hash, forward-only publication rule, or MCP contract.

### 2. The Invariants the Implementation Must Protect

An invariant is a statement that must remain true through normal operation, retries, crashes, and partial failure. The storage implementation is correct only if all of the following remain true:

1. One owner plus one logical deployment has exactly one storage identity and one retained PVC.
2. A configuration hash identifies bundle content; it never identifies the owner of durable data.
3. A publication revision ID identifies an execution generation of the product, even when another revision has the same configuration hash.
4. Conversations and durable memory survive revision changes.
5. A revision can read and write only its own runs, checkpoints, tasks, jobs, locks, and scratchpad area.
6. Restarting the exact same revision may resume that revision's interrupted state.
7. Publishing the same configuration again creates a new revision and therefore a new execution area. The repeated hash does not reopen the old execution area.
8. At most one runtime process may write the deployment volume at a time.
9. A pod carrying an older deployment generation must not become the writer after a newer generation has already used the volume.
10. Undeploy removes runtime resources but leaves the PVC and its storage identity intact.
11. Missing, mismatched, newer, corrupt, or partially migrated storage fails closed. The runtime must never hide the problem by initializing an empty replacement database on the same claim.
12. A PVC that was previously bound and later disappears is data loss, not a first deployment. It must not be silently recreated as an empty claim.

These invariants explain why a single `state.db` plus a stable PVC name is insufficient. The hard problem is not mounting storage; it is preserving the correct ownership and recovery boundaries after the mount.

### 3. Identity Vocabulary

The design uses six identities because they answer six different questions:

| Identity | Meaning | Lifetime | May repeat? | Used for |
| --- | --- | --- | --- | --- |
| Deployment ID | Which logical agent or multi-agent deployment is this? | Life of the logical deployment | Not within one owner's namespace | Product lookup and bundle identity |
| Storage ID | Which owner's retained deployment storage is this? | Life of the logical deployment/PVC | No; derived from owner plus deployment | PVC naming and volume binding |
| Revision ID | Which immutable publication created this executable state? | One published revision | No, even if content repeats | Execution directory and resume fence |
| Config hash | What exact canonical bundle content is this? | Content-addressed | Yes, across different revisions | Integrity verification and diagnostics |
| Generation | Which desired-state mutation is currently being reconciled? | One control-plane mutation | Monotonically increases | Stale-pod and stale-controller fencing |
| Runtime principal ID | Which internal user owns shared rows and paths? | Life of the storage identity | No | Repository ownership inside the runtime |

The storage ID should be an opaque, deterministic digest of the control-plane owner ID and deployment ID, for example:

```text
storage_id = hex(SHA-256(owner_id + NUL + deployment_id))
```

The NUL separator prevents ambiguous concatenation. The storage ID is not a credential. It is a collision-resistant namespace key. The controller computes it from trusted MongoDB ownership data and supplies it to the workload. A different owner using the same deployment ID receives a different storage ID.

The runtime principal is different. It should be an opaque value generated and persisted when the storage is initialized. Existing storage adopts its already-bound synthetic user ID so rows and filesystem paths do not need a risky identity rewrite. New configuration hashes reuse this persisted principal.

### 4. Final Managed-Storage Layout

The managed Kubernetes runtime should resolve its data root into this layout:

```text
/var/lib/agentflow/
├── deployment-meta/
│   ├── writer.lock
│   ├── layout.json
│   └── migrations/
│       └── <migration-id>.json
├── shared/
│   ├── shared.db
│   └── memory/
│       └── <runtime-principal>/memories/...
├── revisions/
│   ├── r-0000000007/
│   │   ├── execution.db
│   │   └── scratchpad/
│   │       └── <runtime-principal>/scratchpads/...
│   ├── r-0000000008/
│   │   ├── execution.db
│   │   └── scratchpad/
│   └── legacy-v3-<hash-prefix>/
│       ├── execution.db
│       └── scratchpad/
└── legacy/
    └── combined-v3-state.db
```

Important details:

- A revision directory is keyed by the unique publication revision, not by config hash.
- Fixed-width numeric revision names sort naturally and are constructed internally; user text never becomes a path component.
- `legacy-v3-*` is deliberately not a valid current revision directory. Normal runtime composition cannot open it as the active execution store.
- `layout.json` records the internal layout version and completed migration identity. It is written atomically only after the new layout verifies successfully.
- `shared.db` is the authority for storage binding and shared application data. The JSON file helps format detection; it does not replace database identity checks.
- The retained legacy database is migration recovery material on the same PVC, not a backup. It does not protect against PVC deletion, volume failure, or cluster loss.

### 5. Exact Table and Filesystem Classification

| Current item | New owner | Reason | Later revision behavior |
| --- | --- | --- | --- |
| `threads` | Shared database | Conversation identity is product history, not an executing attempt. | Root threads remain usable when their agent ID still exists; all rows remain preserved. |
| `messages` | Shared database | Messages are durable conversation history. | Visible through their thread; never copied into a new revision database. |
| `memory_meta` | Shared database | It is the current projection of durable memory. | Read and updated through the stable runtime principal. |
| `memory_revisions` | Shared database | It is append-only durable memory history. Its `run_id` is provenance, not ownership. | Old producing run IDs remain opaque historical references. |
| `memory/` files | Shared filesystem | Bodies implement durable memory records. | Same paths remain valid because the legacy principal is adopted. |
| `runs` | Revision execution database | Status and recovery belong to the code/configuration that created the run. | Only the exact revision directory can see or resume them. |
| `run_checkpoints` | Revision execution database | A checkpoint captures executable runtime/tool state. | Never loaded from another revision. |
| `tasks` | Revision execution database | Run budgets and cancellation govern one execution tree. | Old budgets remain dormant with their creating revision. |
| `task_run_keys` | Revision execution database | Its foreign key and idempotency key belong with `tasks`. | Cannot consume a newer revision's budget. |
| `jobs` | Revision execution database | Queue, callback, lease, and child-run state are executable work. | New coordinator scans only its current database. |
| `job_locks` | Revision execution database | Locks serialize jobs/runs inside one execution world. | Old leases cannot block or be stolen by a new revision. |
| `scratchpad/` files | Revision filesystem | The workspace belongs to an originator run. | Preserved under the creating/quarantined revision, never adopted. |
| current `deployment_identity` | Replaced by two bindings | It incorrectly combines stable deployment identity with config identity. | Shared identity and execution identity validate separate concerns. |
| desired/observed/reconcile state | MongoDB control plane | It coordinates Kubernetes, not agent runtime data. | Survives pod/PVC attachment independently. |

This split places related data together. In particular, the existing `task_run_keys -> tasks` foreign key remains entirely inside `execution.db`. There are no new cross-database foreign keys.

### 6. Why Delegate Subthreads Remain Shared

The current `threads` table contains both normal user-facing threads and delegate subthreads. Delegate subthreads have `kind = 'sub'` and an `originator_run_id`, which makes them look execution-owned. Moving them into `execution.db`, however, would also require moving their messages and would make historical delegated conversations disappear whenever the active revision changed.

The correct distinction is:

- the subthread and its messages are historical conversation records; and
- the run/job/checkpoint that could continue producing messages is executable state.

Therefore all thread kinds stay in `shared.db`. The `originator_run_id` remains provenance. It is not a resume permission. Because the corresponding runs and jobs remain in the old revision's `execution.db`, the new revision cannot continue that work.

An orphan subthread can exist if shared-thread creation succeeds and subsequent run creation fails. That is already a possible multi-step failure shape. It is safe because subthreads are excluded from normal root-thread lists, and retry uses the existing uniqueness rule for `(user_id, originator_run_id, agent_id)`.

### 7. Two Independent Internal SQLite Schemas

The current combined SQLite schema is version 3. The split design should not pretend that `shared.db` and `execution.db` are later editions of the same schema. They are two different stores with different responsibilities and should have independent migration sequences.

The first split layout can use:

```text
layout format version:       1
shared.db PRAGMA user_version:    1
execution.db PRAGMA user_version: 1
```

`shared.db` contains:

- `deployment_storage_identity`, a singleton storage binding;
- `runtime_writer_fence`, a singleton monotonic writer record;
- `threads`;
- `messages`;
- `memory_meta`; and
- `memory_revisions`.

`execution.db` contains:

- `revision_execution_identity`, a singleton immutable revision binding;
- `runs`;
- `run_checkpoints`;
- `tasks`;
- `task_run_keys`;
- `jobs`; and
- `job_locks`.

Each database continues to enable foreign keys, busy timeout, one application connection, and the tested journal/synchronous settings. A database whose `user_version` is newer than the runtime supports is rejected.

This versioning is internal. It does not change bundle `schema_version = 1`.

### 8. Trusted Managed Runtime Context

The runtime cannot derive storage ownership or publication revision from bundle bytes alone. The bundle contains deployment ID and config hash, but not owner ID, publication revision, or desired-state generation.

The managed workload must therefore provide trusted platform context separately from user/runtime secrets:

```text
storage ID
deployment ID
publication revision
deployment generation
expected config hash
```

This may be delivered through controller-owned command arguments or protected environment variables. It must not be taken from the user-editable runtime Secret. The runtime then verifies:

1. the downloaded bundle's deployment ID equals the platform deployment ID;
2. the bundle's canonical hash equals the expected config hash;
3. the shared database is bound to the supplied storage and deployment IDs;
4. the current execution database is bound to the supplied storage ID, deployment ID, revision, and config hash; and
5. the generation is not older than the durable writer fence.

Pod labels and annotations are useful for observation but are not sufficient runtime input by themselves. Unless explicitly projected, a process cannot read its own Kubernetes metadata, and metadata does not validate the mounted files.

### 9. Stable Runtime Principal Binding

The shared identity singleton should conceptually contain:

```text
storage_id
deployment_id
runtime_principal_id
created_at
```

On a new empty managed volume:

1. the runtime acquires the writer lock;
2. it creates `shared.db`;
3. it generates a cryptographically random opaque runtime principal; and
4. it inserts the identity singleton in the same initialization transaction.

On a migrated volume, `runtime_principal_id` is copied from legacy `deployment_identity.synthetic_user_id`. This keeps all `user_id` values and `<user>/memories/...` paths valid.

On every later boot, insertion becomes verification. Any storage ID or deployment ID mismatch is a terminal startup error. The runtime must not overwrite the binding and must not create another principal.

The config hash is intentionally absent from this shared binding. Config identity belongs to `revision_execution_identity`.

### 10. One Writer Requires Two Complementary Fences

Kubernetes `replicas: 1`, `Recreate`, and an RWO claim reduce overlap but do not prove that two processes cannot write. RWO may still allow two pods on the same node, and a stale/manual pod can outlive controller intent.

The runtime should use both of these mechanisms:

#### Process-lifetime volume lock

Open `deployment-meta/writer.lock` and take a non-blocking exclusive operating-system file lock before opening writable databases or running migration. Hold the file descriptor for the entire process lifetime.

- If another process holds the lock, startup and readiness fail.
- A crash releases the kernel lock automatically.
- A leftover lock file is harmless; ownership is attached to the open descriptor, not file existence.
- A StorageClass whose mounted filesystem does not provide reliable advisory locking is unsupported and must fail compatibility testing.

#### Monotonic generation fence

After taking the file lock, update a singleton in `shared.db` transactionally:

```text
maximum_generation_seen
active_generation
active_revision
active_config_hash
runtime_instance_id
started_at
```

Rules:

- supplied generation lower than `maximum_generation_seen` is rejected;
- equal generation is accepted only for the same revision and config hash, allowing an exact pod restart;
- higher generation advances the durable maximum and records the new active identity; and
- graceful shutdown may clear the active instance conditionally, but it never lowers the maximum generation.

The file lock prevents simultaneous writers. The monotonic record prevents an older pod from becoming the writer later, after a newer pod has exited. Neither mechanism provides both guarantees alone.

### 11. Revision Execution Binding

Every numeric revision directory has an immutable singleton containing:

```text
storage_id
deployment_id
revision
config_hash
bundle_schema_version
created_at
```

The first boot of a revision creates it. Later boots verify exact equality. Generation is not part of the immutable key because the same revision may restart or be reconciled under a later control-plane generation. Generation monotonicity belongs to the writer fence.

This makes the following cases unambiguous:

| Event | Directory opened | Result |
| --- | --- | --- |
| Pod restart for revision 7 | `r-0000000007` | May recover revision 7 runs/jobs. |
| Revision 8 has a new hash | `r-0000000008` | Starts with empty execution state; shared history remains. |
| Revision 9 republishes revision 7's content/hash | `r-0000000009` | Starts with empty execution state despite the repeated hash. |
| Stale revision 7 pod after generation advanced | none | Rejected by generation fence. |
| Directory was copied or renamed incorrectly | attempted directory | Rejected by immutable execution binding. |

Physical separation means orphan recovery, resume endpoints, job queue scans, callbacks, task budgets, and job locks automatically operate only on current-revision rows. A forgotten SQL revision predicate cannot cross the boundary because those rows are not in the opened database.

### 12. Runtime Startup and Shutdown Order

Managed startup should happen in this order:

1. Validate all platform context syntax before touching storage.
2. Download and verify the immutable bundle.
3. Create only the fixed metadata directory needed for locking.
4. Acquire the lifetime writer lock.
5. Detect empty, current, legacy, partial, or future storage layout.
6. Run or resume the forward migration when required.
7. Open `shared.db` and verify the stable storage binding.
8. claim the supplied generation in the durable writer fence.
9. Open/create the numeric revision's `execution.db` and verify its immutable binding.
10. Construct shared repositories from `shared.db` and execution repositories from `execution.db`.
11. Recover orphaned runs and start the job coordinator only from the current execution database.
12. Start HTTP serving and become ready.

Readiness must remain false through steps 1–11.

Shutdown should reverse ownership deliberately:

1. become unready and stop accepting new requests;
2. drain HTTP requests;
3. stop coordinator polling and worker pools;
4. wait for or cancel current execution within the shutdown budget;
5. close the execution database;
6. conditionally clear the active writer instance while `shared.db` is still open;
7. close the shared database; and
8. release the writer lock by closing its descriptor.

The pod termination grace period must exceed the complete application budget. With the current 30-second HTTP shutdown plus a later cleanup allowance, a 30-second Kubernetes grace period is too short. The exact numbers should be chosen during implementation, but Kubernetes needs a real safety margin rather than an equal deadline.

### 13. The Legacy Revision-Identity Information Loss

The existing `deployment_identity` stores deployment ID, config hash, and synthetic user ID. It does not store publication revision.

That omission cannot always be repaired by querying revision history because config hash is intentionally not unique. For example:

```text
revision 4 -> config hash A
revision 5 -> config hash B
revision 6 -> config hash A
legacy state.db -> config hash A, no revision
```

There is no evidence inside the volume proving whether the legacy runs belong to revision 4 or revision 6. Assigning them to either one would be a guess, and could make the wrong executable state resumable.

The forward migration therefore uses this rule:

- shared history and memory are migrated normally;
- all legacy execution tables are copied to `revisions/legacy-v3-<hash-prefix>/execution.db`;
- legacy scratchpad files move under the same quarantine directory; and
- normal revision resolution accepts only numeric `r-...` directories, so quarantined work cannot be resumed or claimed.

The data remains available for future inspection/export, but the one-time migration intentionally sacrifices automatic resume of legacy in-flight work. This is a compatibility cost, not data deletion. It is the only fail-closed answer when the creating revision cannot be proven.

### 14. Forward, Replayable Layout Migration

Migration runs only while the runtime owns the lifetime writer lock. Its durable manifest contains a unique migration ID, source layout/version, target layout version, storage/deployment identity, source config hash, adopted runtime principal, current phase, timestamps, and the last verified error.

Recommended phases are:

1. **Detected**
   - Recognize exactly one supported source shape: empty managed storage, completed layout v1, or legacy combined SQLite v3.
   - Reject unknown files that conflict with managed directories, a future layout version, a newer SQLite version, or an unrecognized partial layout.

2. **Source verified**
   - Open legacy `state.db` without running the old automatic migrator.
   - Verify `PRAGMA integrity_check`, `user_version = 3`, and the legacy identity singleton.
   - Confirm deployment ID and current bundle/config expectations where proof is possible.
   - Record table row counts and validate all stored file paths remain inside the expected roots.

3. **Databases staged**
   - Create new databases under a migration staging directory on the same PVC.
   - Create their schemas explicitly.
   - Copy shared tables without changing IDs, timestamps, principals, memory revisions, or relative body paths.
   - Copy execution tables into the non-current legacy quarantine database.
   - Insert the new shared and quarantined execution identity records.

4. **Files relocated**
   - Move the complete legacy memory tree to `shared/memory` and the complete scratchpad tree to the quarantine revision.
   - Use same-filesystem atomic renames where possible. Each rename is replayable: on restart, exactly one of source or destination must exist.
   - Do not follow symlinks outside the data root. Unexpected file types or escaping paths fail migration.

5. **Target verified**
   - Run integrity and foreign-key checks on both new databases.
   - Compare every copied table count with the recorded source count.
   - Verify each live memory metadata path resolves to a regular file within `shared/memory`.
   - Verify the adopted principal and both identity singletons.

6. **Installed**
   - Atomically move staged databases/directories into their final locations.
   - Move the old combined database to `legacy/combined-v3-state.db` rather than treating it as active storage.
   - Fsync files and parent directories required for durable rename semantics.

7. **Complete**
   - Atomically write `layout.json` last.
   - Mark the migration manifest complete.
   - Reopen stores from final paths before readiness.

The migration never attempts to reconstruct the old combined layout. Forward-only means failures are repaired by continuing the same migration, not by booting old code against partially moved state.

### 15. Crash Behavior During Migration

| Crash point | State on restart | Required behavior |
| --- | --- | --- |
| Before manifest | Source is untouched | Detect and start a new migration. |
| While copying a database | Source plus incomplete staging DB | Delete/recreate only the identified staging artifact, then recopy. Never alter source rows. |
| After moving memory but before manifest phase update | Source path missing, destination present | Verify destination and advance the same phase. Do not report data missing. |
| After staging verification | Verified staging plus source | Repeat verification, then install. |
| After some final renames but before `layout.json` | Partial installation plus in-progress manifest | Complete idempotent renames and verification. Do not initialize empty directories. |
| After `layout.json` | Current layout is authoritative | Verify its referenced identity and ignore legacy source for normal operation. |

An in-progress manifest with neither the expected source nor destination is corruption. Startup fails and reports the exact phase; it does not guess.

### 16. Cross-Database Consistency After the Split

SQLite cannot provide one transaction across the independently opened long-lived shared and execution databases. The runtime should not add a distributed-transaction abstraction for this project. Instead it should preserve the existing workflow ordering and make partial states harmless and retryable.

Examples:

- Creating a user run reads a shared thread, then creates the run in `execution.db`. If run creation fails, no executable work starts.
- Delegation consumes an execution budget, creates/finds a shared hidden subthread, then creates the child run in `execution.db`. A failure can leave a hidden historical subthread, but cannot create runnable work without a run row.
- Persisting delegate messages is already best-effort after execution. That remains conversation-history behavior, not a transaction boundary.
- `memory_revisions.run_id` remains an opaque provenance string. Shared memory does not need a foreign key into an execution database.

The important database foreign key, `task_run_keys.originator_run_id -> tasks.originator_run_id`, remains local to `execution.db`. The current schema does not rely on cross-table foreign keys from messages to threads or checkpoints to runs, so the split does not break such constraints.

If future product behavior requires an atomic user-visible fact across the two stores, it should use an explicit idempotent operation/outbox design. That complexity is not justified for the present flows.

### 17. Retained Storage State in MongoDB

PVC identity must no longer live only in `ObservedState.Resources`. That field is written only when the whole runtime becomes ready and is removed by `RecordDeleted`. It cannot represent a claim that was successfully created before a later reconcile step failed, and it cannot represent retained storage after undeploy.

Add a top-level storage state to the deployment document, conceptually:

```text
storage:
  storage_id
  phase                  # planned | ready | retained | migration_required
  namespace
  pvc_name
  pvc_uid
  requested_bytes        # initially 5 GiB
  access_mode            # ReadWriteOnce
  volume_mode            # Filesystem
  storage_class_policy   # cluster-default
  bound_storage_class_name
  bound_volume_name
  created_at
  last_verified_at
```

Why each non-obvious field exists:

- `storage_id` binds Mongo state to the runtime volume identity.
- `pvc_uid` distinguishes the original claim from a later empty claim recreated under the same name.
- `storage_class_policy` records that AgentFlow requested the cluster default without confusing an empty requested class with an unknown value.
- `bound_storage_class_name` records what Kubernetes actually selected.
- `phase` distinguishes “never provisioned,” “planned but not yet verified,” “available to a deployment,” “retained after undeploy,” and “requires explicit migration.”
- requested capacity is recorded separately from observed/bound capacity because expansion can make them differ later.

Runtime Deployment, Service, and Secret names remain observed generation resources. The PVC reference moves to stable storage state; `ResourceRefs.StatePVCName` can then be removed or treated only as a temporary compatibility projection during migration, not as authority.

### 18. Claim-Fenced Storage Transitions

The controller store needs claim-fenced operations in addition to progress/ready/failure writes:

1. **Plan storage**
   - deterministically compute storage ID and PVC name;
   - atomically record the immutable namespace/spec before Kubernetes mutation; and
   - reject any attempt to change those fields on an already planned/bound deployment.

2. **Record storage ready**
   - after apply/get, verify owner labels, requested spec, PVC UID, binding, and observed StorageClass;
   - persist UID and observed binding information immediately, before applying later runtime resources; and
   - on retry, require the same UID once one has been recorded.

3. **Record runtime ready**
   - preserve storage state;
   - write only generation-owned runtime resources and endpoint; and
   - verify that the ready result references the already-recorded PVC.

4. **Record deployment deleted**
   - remove Deployment, Service, delivery Secret, and runtime Secret observations;
   - keep the storage identity/reference; and
   - set storage phase to `retained` in the same MongoDB update that records deployment phase `deleted`.

All of these writes must use the existing owner, deployment, desired generation, claim token, claim owner, and unexpired lease filter. A controller that has lost its claim cannot install a PVC reference or overwrite retained storage state.

### 19. Kubernetes Reconciliation Order

For a run request, the future Kubernetes adapter should execute:

```text
verify current Mongo claim/generation
  -> calculate immutable storage plan
  -> persist planned storage
  -> apply or inspect PVC
  -> wait for/verify binding as required
  -> persist PVC UID and bound storage facts
  -> issue artifact delivery credential
  -> create/update delivery Secret
  -> create/update AgentFlow-owned runtime Secret
  -> render/apply Deployment and Service using the stable PVC
  -> wait for runtime readiness
  -> persist runtime-ready observation
```

For undeploy:

```text
verify current Mongo claim/generation
  -> remove/verify absence of Deployment and Service
  -> remove generation-scoped delivery/runtime Secrets
  -> do not delete PVC
  -> atomically record deployment=deleted and storage=retained
```

The PVC must not have an owner reference to the runtime Deployment or another revision-scoped object, because Kubernetes garbage collection could then delete retained data. Namespace deletion still destroys namespaced claims, which is why namespace changes/deletion require an explicit future storage-migration or destructive operation.

If a previously UID-bound PVC is absent, reconciliation returns a terminal safe error such as `storage_missing`. It does not recreate the claim automatically. If phase is only `planned` and no UID was ever observed, creation/retry is safe and idempotent.

### 20. Namespace and Storage-Class Immutability

Once storage is planned, ordinary `RequestRun` must require the requested namespace to equal `storage.namespace`. The current service accepts namespace as a new target field and does not yet enforce this stable-storage rule.

The initial StorageClass policy is also immutable for ordinary deployment operations:

- request the cluster default;
- record the class Kubernetes bound;
- validate filesystem/RWO compatibility; and
- keep using the same claim.

Changing namespace or StorageClass is not a rollout. It is a data migration involving a new PVC and copy/cutover procedure, which is explicitly outside the present scope. Rejecting the request is safer than silently provisioning an empty volume.

### 21. Mongo Record Version Versus Bundle Version

Adding authoritative retained storage state changes the durable Mongo deployment-state contract. The current repository rejects records whose `record_version` is not exactly 2, so the responsible implementation is to advance the internal deploy-state record version to 3 and provide an explicit v2-to-v3 migration.

This does **not** violate the decision to keep bundle schema version 1:

| Version | Contract | Decision |
| --- | --- | --- |
| Bundle `schema_version` | Immutable exported agent configuration | Remains 1. |
| Mongo deploy-state `record_version` | Internal controller persistence shape/invariants | Advances from 2 to 3. |
| Managed layout version | Files/directories and split-store format | Starts at 1. |
| Shared/execution SQLite `user_version` | Internal schema of each new database | Starts independently at 1. |

For Mongo v2 records:

- no recorded PVC means v3 storage begins unprovisioned;
- a recorded PVC whose name/namespace exactly match the new deterministic plan still requires live Kubernetes UID/spec verification before adoption; and
- a revision-shaped or otherwise different PVC must become `migration_required`, not be silently reclassified as the stable claim.

The current repository already treats migration as an explicit operator-visible write rather than silently mutating during `Get`. The v2-to-v3 migration should preserve that property.

### 22. Managed Hosting Versus Bundle Export

The stable storage contract applies to AgentFlow-managed Kubernetes hosting. The controller can provide owner-derived storage ID, publication revision, generation, PVC, and one-writer guarantees.

A downloaded bundle alone cannot provide those facts. Therefore:

- bundle export remains schema-compatible and useful as an immutable configuration artifact;
- a standalone/local runtime started with only `--config` and `--data` must not claim managed revision-fencing guarantees; and
- managed mode should require the complete trusted platform context rather than silently deriving revision identity from config hash.

During implementation, the safest compatibility boundary is an explicit managed-storage startup mode used by Kubernetes. The current standalone layout can remain available for development/export compatibility until a separate product decision defines its identity and migration rules. Managed and standalone data directories must not be mixed implicitly.

### 23. Failure and Recovery Semantics

| Condition | Classification | Runtime/controller behavior |
| --- | --- | --- |
| Wrong storage or deployment binding | Terminal identity mismatch | Stay unready; do not alter binding. |
| Config hash does not match bundle | Terminal integrity mismatch | Stay unready; do not open execution. |
| Revision directory identity mismatch | Terminal execution mismatch | Stay unready; do not recover rows. |
| Generation older than durable maximum | Terminal stale writer | Exit without writes. |
| Another process holds writer lock | Retryable/operational conflict | Stay unready; controller replaces or waits for old pod termination. |
| Unsupported/future layout or DB version | Migration required | Stay unready; never downgrade. |
| Replayable in-progress migration | Recoverable startup work | Continue recorded phase under lock. |
| Corrupt/ambiguous migration state | Terminal storage error | Preserve evidence; require operator action. |
| Previously bound PVC missing or UID changed | Terminal data-loss signal | Do not create/adopt empty replacement. |
| PVC pending due to capacity/scheduler/storage | Retryable infrastructure state | Keep planned reference and retry safely. |
| Volume full | Storage failure | Stop accepting writes/become unhealthy; never delete history automatically. |

Safe failure is more important than availability here. Starting with empty history after an identity or PVC problem would look healthy while silently losing user state.

### 24. Security and Trust Boundaries

- Only the controller derives the storage ID and selects the PVC.
- User configuration, bundle content, and runtime Secret keys cannot choose storage ID, revision, generation, database paths, or PVC names.
- Owner ID participates in the storage digest so two users cannot collide merely by choosing the same deployment ID.
- Runtime path construction accepts parsed positive revision integers, never raw user strings.
- Migration verifies path confinement and does not follow unexpected links outside the mounted root.
- The runtime service account should receive only the Kubernetes permissions needed by the controller architecture; the runtime pod itself does not need Kubernetes PVC mutation permission.
- MCP workloads remain separate and never mount the deployment PVC.
- PVC name and storage ID are identifiers, not authentication. Kubernetes RBAC, namespace isolation, service accounts, and Mongo ownership checks remain the authorization boundaries.

### 25. Proposed Implementation Slices

Implementation should be staged so each slice establishes a testable invariant before Kubernetes begins relying on it.

#### Slice A: Persistence types and split schemas

- Add managed storage/revision identity types and validated path construction.
- Add separate shared and execution SQLite open/migration functions.
- Route runtime repositories to the correct database/root.
- Preserve the existing standalone path deliberately.

Likely components: `backend/runtime`, `backend/repo/sqliterepo`, focused new persistence files, and their tests.

#### Slice B: Writer and revision fencing

- Add the lifetime volume lock.
- Add monotonic shared generation claim/verification.
- Add immutable execution binding.
- Change startup/recovery order and give Kubernetes shutdown a real grace margin later in the workload slice.

Likely components: runtime startup/main, SQL repositories, and lifecycle tests.

#### Slice C: Forward legacy migration

- Add layout detection, durable manifest, split-table copy, path relocation, quarantine, verification, and crash replay.
- Do not make legacy execution current.

Likely components: a focused runtime storage-migration package plus fixture-based tests.

#### Slice D: Mongo retained-storage state

- Add v3 storage model and validation.
- Add explicit v2 migration.
- Add claim-fenced storage plan/ready transitions.
- Preserve storage in `RecordDeleted` and reject normal namespace drift.

Likely components: `backend/deployment`, `backend/repo/mongorepo`, reconciler store interface, and tests.

#### Slice E: Kubernetes PVC and live adapter

- Render the deterministic 5 GiB RWO filesystem PVC with default StorageClass policy.
- Implement the live Kubernetes `Runtime` adapter with generation fencing before mutations.
- Observe UID/binding/spec, wire the stable claim into the workload, and implement retained deletion behavior.
- Increase termination grace and validate the chosen StorageClass on a real cluster.

Likely components: `backend/deployment/kubernetes`, reconciler wiring, process composition, RBAC/manifests if present, and tests.

The slices are ordered intentionally. Creating a stable PVC before stable identity and revision fencing would expose unsafe behavior rather than complete the feature.

### 26. Validation Strategy for the Future Implementation

Unit and repository tests should prove:

- storage ID/name determinism, owner scoping, validation, and bounded Kubernetes names;
- exact table creation in each database and rejection of future schema versions;
- stable principal creation and legacy-principal adoption;
- identity mismatch failures without mutation;
- lower/equal/higher generation fence behavior;
- exact-revision restart recovery;
- new revision with new hash starts empty execution state;
- new revision with repeated old hash also starts empty execution state;
- old jobs, callbacks, budgets, locks, and checkpoints are invisible to the new coordinator;
- root and delegate thread/message history remains present;
- legacy execution and scratchpad data lands only in quarantine;
- migration restart at every durable phase reaches the same final result;
- corrupt, future, ambiguous, out-of-space, and path-escape cases fail closed;
- Mongo storage plan/ready/delete writes reject a lost claim;
- delete clears runtime observations while retaining storage identity and PVC UID;
- namespace drift and changed PVC UID are rejected; and
- explicit v2-to-v3 migration handles absent, adoptable, and migration-required PVC states.

Integration tests should use one physical temporary data root and demonstrate:

```text
revision 1 writes thread + message + memory + resumable run + scratchpad
same revision restarts
  -> shared data visible
  -> revision 1 run resumable

revision 2 starts on the same root
  -> same thread/message/memory visible
  -> revision 1 run not found by current execution repository
  -> revision 1 jobs not claimed
  -> revision 1 scratchpad preserved but not mounted as revision 2 workspace

revision 3 republishes revision 1's exact config hash
  -> shared data still visible
  -> revision 1 execution still not adopted
```

Real-cluster validation is still required for StorageClass locking, WAL behavior, atomic rename, hard links, `fsGroup`, RWO attachment/replacement, PVC binding, UID observation, volume expansion capability, and termination timing. In-memory/fake Kubernetes clients cannot prove those filesystem properties.

### 27. Confirmed Breaking Changes and Deliberate Compatibility

Confirmed internal breaking changes:

- managed runtime composition changes from one SQLite handle to shared plus execution handles;
- config-hash-derived identity is replaced by a persisted stable principal;
- managed startup requires trusted storage/revision/generation context;
- current combined data directories require forward migration;
- legacy in-flight execution becomes preserved quarantine rather than resumable work;
- deploy-state record version advances internally from 2 to 3;
- PVC identity moves out of generation-scoped resource observation; and
- normal namespace changes become invalid after storage is planned.

Deliberately preserved behavior:

- public bundle schema remains version 1;
- canonical config hashing remains unchanged and hashes need not be unique across revisions;
- every deployment request still targets a unique forward revision;
- conversations and memory remain owned by the logical deployment;
- exact-revision restart can resume current execution;
- undeploy retains persistent data;
- provider keys remain AgentFlow-owned;
- MCP selection remains per agent and MCP servers remain separate HTTP workloads; and
- no automatic backup, purge, cross-namespace move, or StorageClass migration is added in this slice.

### 28. Result of This Design Phase

The internal storage boundary is now decided:

```text
logical deployment
  -> stable storage ID
  -> one retained PVC
  -> one persisted runtime principal
  -> shared conversations and durable memory

publication revision
  -> unique numeric revision directory
  -> immutable execution binding
  -> runs, checkpoints, tasks, jobs, locks, and scratchpad

deployment generation
  -> monotonic writer fence
  -> prevents stale pod/controller ownership
```

The principal unresolved work is implementation, not product semantics. The next approval boundary should be Slice A only: implement the managed storage types, validated layout paths, split SQLite schemas, repository composition, and focused tests while preserving the existing standalone path. Writer fencing, migration execution, Mongo v3 state, and Kubernetes PVC mutation should remain later separately reviewed slices.

### 29. Slice A Implementation Status

Slice A is now implemented.

The runtime has an explicit managed-storage mode with controller-supplied:

- storage ID;
- deployment ID;
- publication revision;
- deployment generation; and
- expected canonical config hash.

All values are validated against the verified bundle before the first filesystem mutation. Supplying managed values without explicitly selecting managed mode is rejected.

Managed mode now creates and opens:

```text
shared/shared.db
revisions/r-<zero-padded-revision>/execution.db
shared/memory/
revisions/r-<zero-padded-revision>/scratchpad/
```

The shared database contains storage identity, the reserved writer-fence table, threads, messages, and memory tables. The execution database contains revision identity, runs, checkpoints, tasks, task-run keys, jobs, and job locks.

Runtime composition routes repositories according to the classification in this decision:

- thread, message, memory metadata, and memory revision repositories use `shared.db`;
- run, checkpoint, task, job, and job-lock behavior uses `execution.db`;
- memory uses the shared filesystem root; and
- scratchpad uses the current revision's filesystem root.

The shared storage binding generates an opaque principal only on first initialization. On restart or on a later revision, it returns the already-persisted principal. It rejects a different storage or deployment identity without changing the stored row.

The execution binding is immutable over storage ID, deployment ID, revision ID, config hash, and bundle schema version. Reopening the same revision is idempotent. Opening another revision always resolves another execution database, including when both revisions have the same config hash.

Managed mode detects the current legacy `state.db`, SQLite WAL/SHM sidecars, root `memory`, or root `scratchpad` and returns a migration-required error before creating the split layout. Slice A does not attempt an unsafe implicit migration.

Standalone mode deliberately remains unchanged:

- it opens `<data>/state.db`;
- it retains the current config-hash-bound synthetic principal;
- it uses `<data>/memory` and `<data>/scratchpad`; and
- its current tests continue exercising that compatibility path.

### 30. Slice A Validation Evidence

Implemented tests prove:

- shared and execution databases contain only their assigned tables;
- both new databases begin at their independent internal schema version 1;
- a future unsupported schema version is rejected;
- the first shared principal is preserved when a later boot supplies another random candidate;
- a different storage identity is rejected;
- a revision execution identity is idempotent only for an exact match;
- managed path construction uses a parsed numeric revision and fixed internal path components;
- legacy combined-layout indicators fail closed;
- revision 2 sees revision 1's shared conversation history but not revision 1's runs or scratchpad root; and
- revision 8 does not adopt revision 7's runs even when both use the exact same configuration hash.

Commands actually run:

```text
GOCACHE=/tmp/agentflow-go-build-cache go test ./repo/sqliterepo
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./runtime -run '<changed and affected runtime tests>'
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./runtime
  -> passed outside the filesystem/network sandbox
```

The initial sandboxed package-wide runtime command compiled and began running the suite, but an existing `materialize-bundle` test uses `httptest.NewTLSServer` and the sandbox forbids opening its loopback socket. It panicked with `socket: operation not permitted`. That test was not changed or bypassed in source. After the focused tests passed, the same full runtime package command was rerun with the required permission to open the loopback socket, and the complete runtime package passed.

### 31. Remaining Boundary After Slice A

Slice A establishes data placement and immutable identity, but it does not yet enforce the single-writer or stale-generation guarantees. Specifically, it does not yet:

- take a process-lifetime exclusive volume lock;
- claim or compare the durable generation fence;
- clear active writer observation during graceful shutdown;
- migrate an existing combined database;
- add retained storage state to MongoDB; or
- create/observe a Kubernetes PVC.

The next implementation slice should be Slice B: add the volume writer lock and monotonic generation fence, integrate them into startup/shutdown order, and test simultaneous writer rejection plus lower/equal/higher generation behavior. Migration, MongoDB, and Kubernetes remain later approval boundaries.

### 32. Slice B Implementation Status

Slice B is now implemented for managed Linux runtimes.

It adds two complementary protections because neither protection is sufficient by itself:

1. a process-lifetime filesystem lock prevents two live runtime processes from writing the mounted volume simultaneously; and
2. a durable SQLite generation fence prevents an older Kubernetes generation from becoming the writer after a newer generation has already used the volume.

The filesystem lock is stored at:

```text
/var/lib/agentflow/deployment-meta/writer.lock
```

The runtime opens this file relative to an already-opened metadata directory, creates it with mode `0600`, and takes a non-blocking exclusive Linux `flock`. A second process using the same mounted volume receives a distinct `managed storage is already locked` failure instead of waiting indefinitely or opening SQLite concurrently.

This lock is held for the complete managed-storage lifetime. It is acquired before either managed SQLite database is opened and released only after the execution database, durable writer claim, and shared database have been closed or released. Managed mode fails closed on non-Linux platforms because the production guarantee currently depends on Linux filesystem locking semantics. Standalone mode does not use this managed lock and remains unchanged.

The durable generation fence uses the `runtime_writer_fence` table that Slice A deliberately reserved inside `shared.db`. A claim contains:

- the deployment generation;
- the publication revision;
- the canonical configuration hash;
- a random per-process runtime instance ID; and
- the process start time.

The claim operation is transactional. Its rules are:

```text
requested generation < maximum generation ever admitted
  -> reject as a stale writer

requested generation = maximum generation ever admitted
and revision/config hash differ
  -> reject as a generation identity conflict

requested generation = maximum generation ever admitted
and revision/config hash are identical
  -> allow an exact-target restart

requested generation > maximum generation ever admitted
  -> advance the durable maximum and activate the new writer
```

The configuration hash is intentionally not unique. It participates here only in the exact identity of a generation claim. Revision ID remains the unique publication identity, so a later revision with the same configuration hash still has a different execution directory and a different revision binding.

Graceful shutdown clears only the active runtime instance ID and start time, and only when the releasing process still owns the exact claim. It deliberately retains:

- the maximum generation ever admitted;
- the revision bound to that generation; and
- the configuration hash bound to that generation.

Retaining that information is the central stale-writer guarantee. For example:

```text
generation 10 starts and writes the volume
generation 11 replaces it and later exits cleanly
an old generation 10 pod is restarted by delayed infrastructure activity
  -> generation 10 is still rejected because the durable maximum remains 11
```

Clearing the entire fence row on shutdown would make the last step unsafe. A graceful exit must release current process ownership without erasing deployment history.

Managed startup now follows this order:

```text
validate trusted managed-storage context against the verified bundle
  -> reject a legacy combined layout
  -> create/open deployment metadata directory
  -> acquire the lifetime filesystem lock
  -> create revision/shared directories
  -> open shared.db
  -> bind or verify stable storage identity and runtime principal
  -> atomically claim the generation fence
  -> open the current revision's execution.db
  -> bind or verify immutable execution identity
  -> compose runtime repositories and services
```

Managed shutdown reverses the ownership-sensitive part of that lifecycle:

```text
stop runtime application activity
  -> close execution.db
  -> release the owned active writer claim while preserving maximum generation
  -> close shared.db
  -> unlock and close writer.lock
```

Partial startup failures use the same cleanup path. Therefore, a failure after taking the file lock—for example, failure to open a database—does not permanently block a later healthy startup.

Slice B required no new SQLite schema version. The table needed by this behavior was already part of the Slice A shared schema, so changing the schema version merely to begin using that reserved table would have described no structural migration.

Slice B deliberately does not:

- migrate an existing combined `state.db` layout;
- add retained PVC state to MongoDB;
- render, create, adopt, or observe a Kubernetes PVC;
- supply managed-storage flags from the Kubernetes workload; or
- change standalone runtime persistence behavior.

### 33. Slice B Validation Evidence

Focused repository tests now prove:

- lower generations are rejected after a higher generation has been admitted;
- an equal generation is accepted only for the exact same revision and configuration hash;
- release requires the exact owning runtime instance;
- concurrent claims cannot lower the durable maximum generation;
- the writer lock is exclusive for the lifetime of the first process;
- closing the owner releases the lock for a later process;
- the lock file remains mode `0600`;
- managed startup rejects a simultaneous writer;
- an older generation remains rejected after the newer runtime exits;
- an equal-generation identity conflict is rejected;
- a database-open failure releases the already-acquired filesystem lock; and
- managed shutdown closes execution state before releasing the fence and volume lock.

Commands actually run after implementation:

```text
git diff --check
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./repo/sqliterepo
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./runtime
  -> the first sandboxed run was blocked only because an existing HTTPS test
     could not open a loopback socket; the same complete package command was
     rerun with loopback permission and passed

GOCACHE=/tmp/agentflow-go-build-cache go test -race ./repo/sqliterepo ./runtime
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./...
  -> the complete backend suite, including MongoDB integration tests, passed
```

The race run adds confidence that the in-process tests do not hide a Go data race. It does not replace real-cluster validation of the chosen Kubernetes volume and StorageClass. In particular, a fake client or temporary local directory cannot prove that the production filesystem correctly supports SQLite WAL behavior, atomic rename, and Linux advisory locking under pod replacement.

### 34. Read-Only Deployment-Layer Assessment After Slice B

The current deployment layer contains useful and tested building blocks, but it is not yet a functioning Kubernetes control plane.

#### 34.1 What already exists

The repository has:

- a forward-only deployment intent model with monotonically increasing generations;
- unique publication revisions even when configuration hashes repeat;
- MongoDB desired, observed, claim, retry, failure, and deletion state transitions;
- claim-fenced controller writes, so a worker that loses its MongoDB lease cannot publish a late success or failure;
- a bounded worker-pool reconciler with heartbeats, cancellation, retries, and safe persisted error messages;
- a narrow Kubernetes runtime interface separating durable controller workflow from cluster mechanics;
- pure renderers for a hardened one-replica `Deployment`, stable `Service`, and per-deployment runtime `Secret`;
- `Recreate` deployment strategy, matching the one-pod-per-agent/multi-agent decision;
- a PVC volume mount at `/var/lib/agentflow`; and
- a digest-pinned runtime image and init-container bundle materialization flow.

These pieces establish much of the desired architecture without yet mutating a real cluster.

#### 34.2 What is still only a placeholder or incomplete contract

The workload renderer accepts `StatePVCName` from its caller, but it does not derive or render the stable PVC. Its current cross-revision test even supplies a different revision-shaped PVC name for the later revision. That fixture reflects the old unsafe model and does not prove stable storage reuse.

The runtime container is currently started with only:

```text
serve --config <bundle-path> --data /var/lib/agentflow --listen :8080
```

It does not receive the managed mode values implemented by Slices A and B:

```text
--managed-storage
--storage-id <stable owner/deployment-derived identity>
--deployment-id <logical deployment ID>
--revision <unique publication revision>
--generation <desired-state generation>
--expected-config-hash <verified bundle hash>
```

Therefore, applying the present rendered Deployment would mount the volume but start the runtime through its standalone compatibility path. It would not receive split databases, immutable revision binding, or the generation fence.

The workload's termination grace period is currently 30 seconds, while the runtime process itself allows up to 30 seconds for HTTP graceful shutdown before it closes managed storage. Equal timeouts leave no margin for Kubernetes signal delivery, application cleanup, SQLite close, fence release, or filesystem unlock. A later workload change must give the pod a real margin beyond the application's internal timeout.

The MongoDB deployment record is still internal record version 2. Its PVC name exists only inside `observed.resources`, alongside generation-scoped Deployment, Service, and Secret references. `RecordDeleted` removes all those resource references. Consequently, undeploy currently forgets the PVC even though the decided product behavior is to retain it.

There is no authoritative storage object recording:

- stable storage ID;
- deterministic PVC name and namespace;
- requested capacity/access mode/volume mode;
- actual StorageClass;
- bound PVC UID;
- planned, ready, retained, missing, or migration-required phase; or
- whether the claim has ever been successfully bound.

Without the PVC UID and “ever bound” distinction, the controller cannot safely tell the difference between:

```text
first deployment: the planned claim has not been created yet
```

and:

```text
data-loss event: a previously bound retained claim has disappeared
```

Silently creating a new empty PVC in the second case would make the runtime appear healthy while losing conversation and memory history.

#### 34.3 Missing live-control-plane pieces

No implementation of the reconciler's Kubernetes `Runtime` interface exists yet. The backend process does not construct or start the reconciler controller, and it does not expose deployment run/delete/status HTTP handlers. Only the internal artifact delivery endpoint is currently wired.

The module includes Kubernetes API and API-machinery packages for constructing objects, but it does not include `client-go`, a live Kubernetes client, informer/watch logic, apply/update mechanics, or fake-client tests. No Kubernetes RBAC, controller ServiceAccount, deployment manifest, Helm chart, or other cluster installation manifests are present in the repository.

This means there are three distinct unfinished boundaries:

1. **Durable storage authority:** MongoDB must remember the stable retained storage independently of live runtime resources.
2. **Pure Kubernetes contracts:** the renderer must create the stable PVC contract and pass the complete managed-runtime identity into the pod.
3. **Live orchestration and composition:** a Kubernetes adapter must safely apply/observe resources, and the backend must start the reconciler and expose the product API that writes desired deployment state.

They should not be collapsed into one large change. Each boundary has different invariants, failure modes, tests, and dependency consequences.

### 35. Recommended Next Slice

The next safe implementation should be retained-storage state in MongoDB, corresponding to Slice D in the original plan. It should happen before PVC rendering or a live Kubernetes adapter.

The reason is ownership of truth:

```text
MongoDB says which stable storage belongs to the logical deployment
  -> Kubernetes realizes and reports that claim
  -> the workload mounts exactly that recorded claim
  -> the runtime verifies the supplied storage/deployment/revision/generation identity
```

If Kubernetes rendering comes first, the caller still has no durable authoritative record from which to obtain the stable PVC identity, determine whether recreation is safe, enforce namespace immutability, or preserve the claim across undeploy.

The recommended retained-storage slice should:

1. advance only the internal Mongo deploy-state record from version 2 to version 3; bundle schema version remains 1;
2. add an explicit storage state owned by the logical deployment, not by one observed generation;
3. derive a deterministic owner-scoped storage ID and stable PVC name;
4. represent unprovisioned, planned, ready, retained, missing, and migration-required outcomes explicitly;
5. remember the bound PVC UID and effective immutable storage properties;
6. add claim-fenced plan/ready storage transitions to the reconciler store boundary;
7. make deployment deletion clear runtime resources while preserving storage identity and observed PVC facts;
8. reject ordinary namespace drift after storage has been planned; and
9. provide an explicit version-2-to-version-3 migration path without hidden write-on-read behavior.

This slice should not yet add `client-go`, contact a Kubernetes cluster, create a PVC, wire deployment HTTP routes, or start the reconciler. Those remain separately reviewable changes after the durable state contract is proven.

After retained-storage state, the following sequence is recommended:

```text
pure PVC/workload rendering contract
  -> live Kubernetes adapter and cluster-facing tests
  -> backend reconciler lifecycle/composition
  -> deployment run/delete/status HTTP boundary
  -> real-cluster validation and operational manifests/RBAC
```

The forward runtime-storage migration from the existing combined `state.db` remains a separate slice. It concerns data already present inside a mounted volume; MongoDB retained-storage state concerns whether the correct volume is selected and remembered. Neither one substitutes for the other.

### 36. Mongo Retained-Storage State Implementation Status

The retained-storage state slice is now implemented.

The internal MongoDB deployment-state record has advanced from version 2 to version 3. This is an internal control-plane persistence version only. The public deployment bundle remains schema version 1.

Version 3 adds a top-level `storage` object owned by the logical deployment rather than by one observed Kubernetes generation. Its model contains:

```text
storage
├── phase
├── storage_id
├── namespace
├── pvc_name
├── requested_capacity_bytes
├── access_mode
├── volume_mode
├── storage_class_policy
├── pvc_uid
├── storage_class_name
├── capacity_bytes
├── legacy_pvc_name
├── legacy_pvc_namespace
├── planned_at
└── last_observed_at
```

The supported storage phases are:

| Phase | Meaning |
| --- | --- |
| `unprovisioned` | No PVC has ever been planned for this logical deployment. |
| `planned` | The deterministic storage contract is durable, but a bound PVC UID has not yet been verified. |
| `ready` | The expected PVC has been observed with a durable UID and compatible storage properties. |
| `retained` | Runtime resources were deleted, but the verified PVC identity is deliberately retained. |
| `missing` | A previously known claim is absent; future live reconciliation must treat this as a data-loss signal. |
| `migration_required` | Existing PVC information cannot safely be adopted without explicit live verification or migration. |

The initial storage contract is fixed to:

- 5 GiB requested capacity, stored as bytes in the domain model;
- `ReadWriteOnce` access mode;
- `Filesystem` volume mode; and
- cluster-default StorageClass policy.

The domain layer remains independent from Kubernetes packages. It stores typed product concepts and byte counts rather than importing `resource.Quantity` or Kubernetes API types. The later Kubernetes renderer will translate this domain contract into a PVC object.

### 37. Stable Storage Identity and Naming

The storage ID is deterministically derived from trusted control-plane ownership:

```text
storage_id = hex(SHA-256(owner_id + NUL + deployment_id))
```

The stable PVC name is:

```text
af-storage-<first 40 hexadecimal characters of storage_id>
```

This name:

- is independent of revision, generation, and configuration hash;
- differs for two owners using the same deployment ID;
- is a valid bounded DNS subdomain; and
- remains stable through deploy, redeploy, undeploy, and repeated configuration hashes.

The full 256-bit storage ID remains the internal ownership identity. The shortened digest is used only in the bounded Kubernetes resource name.

### 38. Claim-Fenced Storage Transitions

The reconciler now records the deterministic storage plan after it has verified the selected publication and while it still owns the exact MongoDB reconciliation claim.

The effective run flow is now:

```text
claim desired generation
  -> verify immutable publication and bundle
  -> derive owner-scoped storage plan
  -> atomically persist/verify storage plan under the claim
  -> report provisioning
  -> invoke the future Kubernetes runtime adapter
  -> adapter observes the bound PVC
  -> adapter reports PVC UID, StorageClass, capacity, access mode, and volume mode
  -> atomically persist/verify storage readiness under the same claim
  -> only then allow final deployment readiness to be recorded
```

The runtime adapter contract now receives a storage reporter callback. A run reconciliation that returns success without calling this callback is converted into the terminal safe failure `storage_not_verified`. This prevents the future adapter from accidentally starting a supposedly ready deployment before MongoDB remembers the PVC identity.

Storage-plan and storage-ready writes verify:

- owner and deployment ID;
- desired generation;
- claim token and claim owner;
- unexpired claim lease;
- desired action and namespace;
- deterministic storage ID and PVC name;
- fixed requested capacity/access/volume/Class policy; and
- existing PVC UID and StorageClass identity when already recorded.

If a claim was lost, the stale worker receives a non-applied result and stops. If the claim is still owned but the storage identity differs, the repository returns a storage conflict. The reconciler persists that as the terminal safe failure `storage_identity_conflict` rather than retrying it as a temporary Kubernetes outage.

This distinction matters operationally:

```text
claim no longer belongs to this worker
  -> discard late work silently

claim still belongs to this worker, but PVC UID differs
  -> record a visible terminal storage-identity failure
```

### 39. Namespace and Deletion Guarantees

Once storage has moved beyond `unprovisioned`, ordinary deployment requests must use the recorded storage namespace.

This invariant is enforced twice:

1. the deployment application service rejects the request early with a storage conflict; and
2. the MongoDB compare-and-set filter repeats the namespace condition atomically.

The second check is required because an application-only check would be vulnerable to this race:

```text
request reads unprovisioned storage
controller plans storage in namespace A
request concurrently writes a new target in namespace B
```

With the atomic MongoDB condition, only one of those incompatible writes can succeed.

Generation-scoped `ResourceRefs` no longer contain the PVC name. They retain only resources that belong to the current runtime observation: Namespace, Deployment, Service, delivery Secret, and runtime Secret.

`RecordDeleted` still clears those runtime observations, but it changes verified storage from `ready` to `retained` without clearing:

- storage ID;
- namespace and stable PVC name;
- PVC UID;
- StorageClass;
- verified capacity; or
- storage planning and observation timestamps.

This gives undeploy the intended meaning: stop the runtime while preserving the logical deployment's durable data identity.

### 40. Explicit Version-2 Migration

Version-2 documents are not mutated during normal reads. `Get`, deployment mutations, and reconciliation continue to return `deployment state migration required` until an explicit migration operation is invoked.

The explicit version-2-to-version-3 migration behaves as follows:

```text
v2 has no recorded PVC
  -> v3 storage phase = unprovisioned

v2 has any recorded PVC
  -> derive the new stable storage plan
  -> preserve old PVC name and namespace as legacy evidence
  -> remove PVC name from generation-scoped observed resources
  -> v3 storage phase = migration_required
  -> do not invent or trust a PVC UID
```

Even when an old name happens to match the new deterministic name, the migration does not mark it ready. A future live Kubernetes operation must still verify its UID, bound state, StorageClass, capacity, access mode, and volume mode.

The previous flat version-1 migration now writes a version-3 document with `unprovisioned` storage. Both migrations remain explicit operator-visible writes.

### 41. Mongo Index Upgrade Compatibility

The due-work index contains `record_version` in its partial filter. Reusing the version-2 index name with a version-3 filter would make MongoDB startup index reconciliation fail because the existing name would refer to different index options.

Version 3 therefore uses a new index name:

```text
deployment_states_v3_due_claim
```

The old version-2 due-work index may coexist during migration. It is not deleted automatically. This avoids a destructive startup action and allows version-2 documents to remain visible for explicit migration while only version-3 records are claimable by the current reconciler.

### 42. Retained-Storage Validation Evidence

Tests now prove:

- storage plans are deterministic and owner-scoped;
- generated plans use the fixed 5 GiB RWO filesystem/default-Class contract;
- invalid or undersized bound storage is rejected;
- the service rejects namespace drift after storage planning;
- initial version-3 deployment state begins `unprovisioned`;
- storage planning is claim-fenced;
- a stale generation cannot plan storage;
- storage readiness records the bound UID and observed properties;
- a different PVC UID cannot replace an already-recorded UID;
- final deployment readiness requires storage phase `ready`;
- undeploy preserves the PVC identity and changes storage to `retained`;
- repository-level atomic filters reject namespace drift;
- version-1 migration produces a version-3 unprovisioned record;
- version-2 reads fail closed until explicit migration;
- a version-2 PVC becomes migration-required evidence, not an implicitly trusted stable claim;
- the old generation-scoped PVC field is removed during explicit v2 migration;
- version-2 and version-3 due-work indexes can coexist;
- the controller will not record readiness without the storage callback; and
- a bound-storage identity conflict becomes a terminal safe deployment failure.

Commands actually run:

```text
GOCACHE=/tmp/agentflow-go-build-cache go test ./deployment ./deployment/reconciler
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./repo/mongorepo
  -> passed against the local MongoDB instance

GOCACHE=/tmp/agentflow-go-build-cache go test -race ./deployment ./deployment/reconciler ./repo/mongorepo
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test ./...
  -> complete backend suite passed, including integration, runtime, Kubernetes renderer, SQLite, and MongoDB packages

git diff --check
  -> passed
```

The first sandboxed MongoDB attempt was blocked from opening `127.0.0.1:27017`. It did not expose a code failure. The same approved test was rerun with local-loopback permission and passed. The first Mongo run also found a representation-dependent test assertion that assumed nested BSON would decode as `bson.M`; the assertion was corrected to query MongoDB directly for field existence, after which the package and full suite passed.

### 43. Remaining Boundary After Retained-Storage State

MongoDB can now answer the control-plane questions that were previously unsafe:

- Which stable storage belongs to this logical deployment?
- Has the storage merely been planned, or was it previously bound?
- Which PVC UID and StorageClass were verified?
- Should undeploy forget the claim? No—it becomes retained.
- May a request silently change namespace? No.
- May a different claim with the same name be accepted? No.

MongoDB still cannot answer whether Kubernetes currently contains that PVC, because no live Kubernetes adapter exists. The `missing` phase is represented for that future observation, but this slice deliberately does not contact a cluster or invent a missing-storage result without evidence.

The next safe deployment-layer slice is now the pure Kubernetes storage/workload contract:

1. render a PVC from the trusted version-3 storage plan;
2. keep the same PVC name across revisions and generations;
3. replace caller-supplied revision-shaped PVC input with the retained-storage contract;
4. pass all managed-storage flags into the runtime container;
5. increase Kubernetes termination grace beyond the runtime's internal 30-second shutdown window;
6. add object-only tests for PVC ownership metadata, 5 GiB RWO filesystem policy, stable reuse, managed arguments, and retention-safe owner references; and
7. continue to avoid `client-go` or live cluster mutation until that pure contract is reviewed and proven.

The forward migration of an actual legacy combined runtime `state.db` remains a separate data-migration slice. It is needed before an existing combined data directory can start in managed split-storage mode, but it does not change the Kubernetes PVC identity contract described above.

### 44. Pure Kubernetes Retained-Storage Rendering Contract

The next deployment-layer slice is now implemented as a pure object renderer. It does not connect to Kubernetes and does not mutate a cluster. Given a trusted deployment target plus the retained-storage state already persisted in MongoDB, it returns three typed Kubernetes API objects:

```text
Workload
├── PersistentVolumeClaim
├── Deployment
└── Service
```

This boundary is intentionally pure. It lets the project prove exactly what would be submitted to Kubernetes before adding `client-go`, retries, watches, permissions, or partial-failure handling.

The renderer no longer accepts a free-form `StatePVCName`. That old input shape allowed a caller to accidentally construct a revision-shaped name such as `agent-r8-state`, which would silently attach a new empty volume during an update. It now accepts the complete typed `StorageState` from the deployment domain model.

The renderer performs defense-in-depth validation even though the controller and MongoDB repository already protect the same state. It:

1. validates the fixed storage policy;
2. recomputes the expected plan from `owner_id + deployment_id + namespace`;
3. requires the supplied plan to equal that recomputed plan exactly;
4. rejects legacy-storage evidence that still requires explicit migration;
5. accepts `planned` storage only when no bound identity has been recorded;
6. accepts `ready` or `retained` storage only when the PVC UID, StorageClass, capacity, access mode, and volume mode form a valid verified binding; and
7. rejects `unprovisioned`, `missing`, and `migration_required` storage.

This gives the Kubernetes boundary a useful rule:

```text
the caller may describe the desired revision,
but it may not choose which durable storage belongs to the deployment
```

### 45. Rendered PVC Policy

The rendered claim uses the stable name and namespace from the verified storage plan. Its relevant shape is:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: af-storage-<stable owner/deployment digest prefix>
  namespace: agentflow-runtimes
  annotations:
    agentflow.dev/storage-id: <full stable storage digest>
spec:
  accessModes:
    - ReadWriteOnce
  volumeMode: Filesystem
  resources:
    requests:
      storage: 5Gi
```

`storageClassName` is deliberately omitted. In Kubernetes, an omitted value asks the cluster to apply its default StorageClass. An explicitly empty string has different semantics: it requests no StorageClass. Using `nil` in the Go object preserves the intended cluster-default policy.

The PVC deliberately has no `ownerReferences`. A Kubernetes owner reference to the Deployment or one of its ReplicaSets would make storage lifetime follow a replaceable runtime object. Garbage collection could then delete the claim when that owner is deleted. AgentFlow instead retains the PVC through its own deployment-state lifecycle and will eventually need an explicit, product-authorized permanent-delete path.

The pod's `state` volume references this exact rendered claim. The runtime continues to mount it at:

```text
/var/lib/agentflow
```

### 46. Managed Runtime Identity and Shutdown Contract

The runtime container now receives all values required by the managed-storage startup checks and on-volume writer fence:

```text
serve
--config /var/run/agentflow/bundle/bundle.json
--data /var/lib/agentflow
--listen :8080
--managed-storage
--storage-id <stable storage ID>
--deployment-id <logical deployment ID>
--revision <published revision>
--generation <monotonic deployment generation>
--expected-config-hash <canonical configuration hash>
```

These values have separate responsibilities:

| Value | Why the runtime needs it |
| --- | --- |
| storage ID | Detects a different logical volume identity. |
| deployment ID | Prevents one deployment from adopting another deployment's data directory. |
| revision | Binds the active writer to the selected publication. |
| generation | Prevents an older pod from becoming the writer after a newer deployment has started. |
| expected config hash | Proves the mounted writer identity matches the materialized bundle configuration. |

The Kubernetes termination grace period is now 60 seconds. The runtime performs an internal graceful shutdown with a 30-second timeout. Kubernetes therefore gives the process an additional 30-second margin before sending a forced kill. An equal 30-second outer grace would be unsafe because process startup of shutdown handling, HTTP draining, SQLite closure, and scheduler timing all consume part of that same interval.

This does not create a guarantee that every shutdown will complete; a node can still fail abruptly. Durability therefore continues to depend on SQLite and filesystem guarantees, not solely on graceful pod termination.

### 47. Revision Update Example

Assume Alice owns logical deployment `support-agent`. Revision 7 is currently running:

```text
owner             = Alice
deployment        = support-agent
revision          = 7
generation        = 11
config hash       = aaa...
stable PVC        = af-storage-4e91...
```

Alice then deploys revision 8:

```text
owner             = Alice             (unchanged)
deployment        = support-agent     (unchanged)
revision          = 8                 (changed)
generation        = 12                (changed)
config hash       = bbb...            (changed)
stable PVC        = af-storage-4e91... (unchanged)
```

The Deployment uses `Recreate`, so Kubernetes must stop the old pod before starting the new one. The new pod receives generation 12 and revision 8, then mounts the same claim. Its runtime writer fence rejects a stale generation-11 process if that process somehow tries to reopen the data later.

The result is:

```text
new code/configuration + new writer identity + same durable memory/scratchpad
```

Redeploying an older publication follows the same rule. AgentFlow creates a new deployment generation for that request; it never moves the control plane backward to an old generation and never chooses a historical PVC.

### 48. Object-Level Validation Evidence and Remaining Work

The Kubernetes renderer tests now prove:

- exactly one runtime replica with `Recreate` strategy is rendered;
- a PVC object is produced alongside the Deployment and Service;
- the claim requests exactly 5 GiB, `ReadWriteOnce`, and `Filesystem`;
- cluster-default StorageClass semantics are represented by a nil `storageClassName`;
- the PVC has no owner reference;
- the pod volume references the rendered stable PVC name;
- the same PVC identity is retained across revision, generation, bundle URL, and configuration-hash changes;
- planned, ready, and retained storage are handled according to their invariants;
- unprovisioned, missing, migration-required, legacy, foreign, or incomplete storage is rejected;
- all managed-storage runtime arguments are passed with their expected values; and
- Kubernetes grants 60 seconds for termination, exceeding the runtime's internal 30-second shutdown timeout.

Commands actually run for this slice:

```text
GOCACHE=/tmp/agentflow-go-build-cache go test ./deployment/kubernetes
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test -race ./deployment/kubernetes
  -> passed

GOCACHE=/tmp/agentflow-go-build-cache go test -count=1 ./...
  -> complete uncached backend suite passed, including local MongoDB integration

git diff --check
  -> passed for tracked changes

git diff --no-index --check /dev/null <new file>
  -> no whitespace errors in the new renderer, renderer tests, or architecture guide
```

The uncached suite was first started inside the restricted filesystem sandbox. Non-Mongo packages passed, but the remaining packages could not reach the local MongoDB socket and waited for connection timeout. That run was interrupted and the identical approved command was rerun with local-loopback access; it completed successfully. This was an environment restriction, not a failing test.

This slice still does not prove that a real cluster will provision or preserve the claim. The next boundary remains a live Kubernetes adapter that must:

1. read an existing PVC before deciding whether to create or reuse it;
2. compare the observed UID, phase, StorageClass, capacity, access mode, and volume mode with MongoDB state;
3. report the verified binding through the claim-fenced storage callback;
4. fail safely if a previously verified PVC is absent or has a different UID;
5. apply Deployment and Service objects only while the reconciliation generation is still current;
6. wait for rollout readiness and report useful failure reasons; and
7. preserve the PVC during ordinary undeploy.

`client-go`, service-account/RBAC manifests, cluster watches, live reconciliation wiring, and real-cluster tests remain deliberately out of scope for this pure rendering slice.

### 49. Live Kubernetes Adapter Implementation

The boundary described above is now implemented with `client-go`. The adapter is intentionally narrow: product rules still belong to `deployment.Service`, retry and lease behavior still belong to `reconciler.Controller`, and the adapter owns only Kubernetes resource mechanics.

For a run generation, the effective order is now:

```text
claim durable desired generation
  -> re-read desired state (generation fence)
  -> load and verify immutable bundle
  -> derive stable PVC and resource identity
  -> create or verify stable PVC
  -> read AgentFlow-owned provider credentials
  -> rotate scoped artifact-delivery credential
  -> generate a per-generation runtime API credential
  -> apply delivery Secret and runtime Secret
  -> apply ClusterIP Service
  -> apply one-replica Recreate Deployment
  -> wait for PVC binding and record its UID/class/capacity
  -> wait for exactly one available Deployment replica
  -> wait for a ready EndpointSlice endpoint
  -> record ready state, internal resource references, and generation
```

There is a generation fence before cluster mutations. The adapter reloads the deployment state and requires the owner, deployment, generation, desired action, and complete target to still match. A stale worker therefore stops instead of overwriting a newer user's intent.

Every managed object carries two forms of identity:

- a label-safe truncated deployment digest for selectors; and
- a full owner/deployment digest annotation for authoritative ownership checks.

Generation and revision annotations are also present. An object with the same Kubernetes name but a different AgentFlow ownership identity is treated as a terminal resource conflict, not adopted.

#### Why PVC binding occurs after workload creation

The first live implementation waited for a new PVC to become `Bound` before creating the Deployment. Platform-manifest investigation exposed a Kubernetes lifecycle deadlock: a `WaitForFirstConsumer` StorageClass does not bind a claim until a schedulable pod references it.

The corrected order is:

```text
create/verify claim -> create consumer pod -> verify binding -> verify pod readiness
```

This supports both `Immediate` and `WaitForFirstConsumer` default StorageClasses. It does not weaken the storage guarantee: final deployment readiness is still impossible until the exact bound UID, StorageClass, capacity, access mode, and volume mode have been recorded through the claim-fenced callback.

For storage previously recorded as `ready` or `retained`, absence is different from first-time provisioning. The adapter records `storage_missing`, returns a terminal safe failure, and never creates a replacement claim. This protects memory and scratchpad continuity from a particularly dangerous failure mode: an apparently healthy deployment backed by a new empty volume.

Undeploy removes the Deployment, Service, delivery Secret, and runtime Secret, waits for their absence, and revokes relevant artifact credentials. It never deletes the PVC.

### 50. Forward-Only Publications and Deployment Generations

Two monotonic counters solve two different problems:

| Counter | Meaning |
| --- | --- |
| publication revision | Immutable configuration history. |
| deployment generation | Every requested runtime state transition. |

An intentional deploy always creates a new generation, including a redeploy of the same revision. A retry is recognized only when the caller repeats the previous expected generation and the already-created desired target is identical.

Example:

```text
revision history: 1, 2, 3, 4
current generation: 9 running revision 4

explicitly redeploy revision 4
  -> generation 10 running revision 4

retry the same HTTP request with expected_generation 9
  -> returns generation 10 without creating generation 11
```

Historical configuration is also forward-only. `POST /api/agents/{id}/publications/{revision}/restore` reads the owned historical bundle, verifies its canonical hash and metadata, then appends the exact content as a new latest revision. If revision 2 is restored after revision 4, the result is revision 5 with `source_revision: 2`. Deploying revision 2 directly remains rejected as a rollback.

This gives a single operational rule:

```text
configuration may repeat, but history and runtime intent only move forward
```

The config hash is intentionally not unique because identical content may appear in several legitimate audit events. Revision and generation identities remain unique and monotonic within their respective owner/deployment scope.

### 51. Managed Deployment HTTP Contract

The public control-plane API is owner-scoped through the authenticated user context:

```text
PUT    /api/agents/{id}/deployment
GET    /api/agents/{id}/deployment
DELETE /api/agents/{id}/deployment
ANY    /api/agents/{id}/runtime/{path...}
```

Deploy request:

```json
{
  "revision": 5,
  "expected_generation": 10
}
```

Undeploy request:

```json
{
  "expected_generation": 11
}
```

Namespace, runtime image, artifact address, Kubernetes credentials, and Secret names are not accepted from the request. They are platform policy loaded during backend startup. This is both an architectural and a security boundary: users select an immutable publication, while AgentFlow selects infrastructure.

A changed command returns `202 Accepted`; an exact idempotent retry returns `200 OK`. The status response exposes understandable product state:

- desired generation, revision, and the product-facing action `running` or
  `deleted` (the internal controller verbs `run` and `delete` are not exposed);
- observed generation, phase, and readiness;
- storage phase;
- current safe error code, message, retryability, generation, and time;
- reconciliation attempt and next scheduled retry time;
- the last meaningful observed-state transition time; and
- an explicit runtime-availability boolean plus a public runtime path only
  when the desired generation is observed ready.

It deliberately does not expose internal Service URLs, Kubernetes Secret names, PVC UIDs, controller claims, or bearer credentials.

Optimistic generation checks prevent a stale browser tab from overwriting newer intent. A conflict response tells the caller to refresh status and decide again.

### 52. Backend Runtime Proxy and Credential Boundary

Runtime Services are ClusterIP-only. The browser never receives a pod address or runtime API token. For every proxied request, the backend:

1. loads the owner-scoped deployment state;
2. requires desired action `run` and observed readiness for the exact desired generation;
3. recomputes the stable Kubernetes resource name instead of trusting a stored URL;
4. verifies that recorded resource references match that computed identity;
5. reads the live Service and per-deployment runtime Secret;
6. verifies AgentFlow ownership plus exact generation and revision annotations;
7. requires a ready EndpointSlice endpoint;
8. derives the internal Service URL;
9. removes the browser's Authorization and Cookie headers;
10. injects the AgentFlow-generated runtime bearer credential; and
11. streams the upstream response through the public authenticated connection.

The proxy removes runtime `Set-Cookie`, `WWW-Authenticate`, and `Server` response headers. This prevents the internal service from creating browser state, initiating its own browser authentication flow, or leaking internal server identity. Reverse-proxy transport errors become a safe `502` response. Access-resolution failures do not serialize Kubernetes error details.

The per-deployment runtime token lasts until the next successful token creation for a newer deployment generation. Applying the new Secret and changing the pod-template credential identity forces replacement. Ordinary undeploy deletes the Secret.

### 53. Startup and Controller Lifecycle

Managed deployment is enabled explicitly with:

```text
MANAGED_DEPLOYMENTS_ENABLED=true
```

When enabled, startup requires:

- `DEPLOYMENT_NAMESPACE`;
- a digest-pinned `DEPLOYMENT_RUNTIME_IMAGE`;
- an absolute HTTPS `DEPLOYMENT_ARTIFACT_BASE_URL`;
- `ARTIFACT_LISTEN_ADDR`;
- the AgentFlow provider-credential Secret namespace and name; and
- a unique controller owner, normally the Kubernetes pod name.

The backend then creates an in-cluster client, application deployment service, Kubernetes runtime adapter, leased controller, control-plane handlers, and runtime proxy. Invalid or incomplete configuration fails startup rather than producing partially functional endpoints.

When managed deployment is disabled, local Studio authoring can run without Kubernetes. The Kubernetes production manifest enables it explicitly.

Controller workers share the application cancellation context. On signal or listener failure, public and artifact listeners shut down together and the process waits for reconciliation workers within the same bounded shutdown window.

### 54. Kubernetes Platform Manifests

`deploy/kubernetes` now defines the platform contract:

- separate `agentflow-system`, `agentflow-runtimes`, and `mcp-system` namespaces;
- a backend ServiceAccount;
- namespace-scoped RBAC for Deployments, Services, PVCs, scoped runtime Secrets, and EndpointSlices;
- resource-name-scoped read access to the provider credential Secret;
- a hardened non-root backend Deployment;
- separate public and artifact Services;
- HTTPS artifact Ingress termination;
- a runtime NetworkPolicy allowing only backend ingress, DNS, selected MCP namespace traffic, and HTTPS provider/artifact egress; and
- an example Secret contract that is deliberately excluded from Kustomize.

Both backend and runtime image fields use digest-shaped placeholders. Operators must build the two Dockerfiles, push them, and substitute real immutable digests. No real credential or unpinned third-party MCP image is committed.

The artifact listener itself is HTTP behind the Ingress. Runtime bundle URLs are HTTPS and therefore traverse TLS termination before reaching the internal artifact Service. The host and certificate are cluster-specific inputs; runtime containers must trust that certificate chain.

The MCP servers remain separate workloads. Their deployment URLs are frozen into publication bundles from the MongoDB catalog, so deployed runtimes never query Studio MongoDB or ask users for MCP authentication.

### 55. Explicit State and Runtime-Storage Migration

Repository migration methods are now reachable through:

```text
go build ./cmd/deployment-migrate
```

The operator command has deliberately restrictive behavior:

- exactly one owner and deployment per invocation;
- `--kind legacy` or `--kind v2` must be explicit;
- omission of `--apply` performs a real read-only dry run;
- `MONGO_URL` is mandatory and has no localhost fallback;
- legacy immutable hash and schema metadata are derived from the owned publication rather than typed by an operator;
- the publication bundle is parsed and hash-verified before migration; and
- repository compare-and-set filters reject already-changed source documents; and
- the applied document is immediately reloaded and verified before the command reports success.

Version-2 records containing an old PVC reference become `storage_migration_required`. They are not automatically adopted because a PVC name alone does not prove ownership, content, UID, or layout compatibility. The controller stops and requires an operator-controlled data migration. Fresh version-3 deployments do not use this legacy path.

The runtime image now also contains an offline command:

```text
agentflow-runtime migrate-storage
```

Without `--apply`, it verifies the legacy combined SQLite v3 database,
deployment/configuration identity, table row counts, and memory/scratchpad file
trees without writing. With `--apply`, it:

1. acquires the managed writer lock;
2. copies shared tables to `shared/shared.db`;
3. copies execution tables to a non-runnable
   `revisions/legacy-v3-<hash>/execution.db` quarantine because the old layout
   cannot prove the creating publication revision;
4. copies memory and scratchpad file trees;
5. verifies SQLite integrity, stable identity, every table count, and file
   count;
6. atomically installs staged directories;
7. moves the original database, WAL/SHM files, memory, and scratchpad trees to
   the on-volume `legacy` backup; and
8. writes the completed layout marker last.

A durable phase manifest makes the operation forward-replayable. If execution
stops after staging or partway through installation, the identical `--apply`
command continues from the recorded phase. A completed replay re-verifies the
installed layout. Normal runtime startup still never performs this migration.

The operator runbook includes MongoDB dump commands, offline/PVC requirements,
dry-run review, execution, post-migration verification, snapshot retention,
and forward failure-recovery rules.

### 56. Current Validation Boundary

Automated evidence now covers:

- live adapter create/update/delete behavior with client-go's fake cluster;
- no Kubernetes mutation after a generation fence fails;
- stable PVC preservation and missing-PVC safe failure;
- `WaitForFirstConsumer` reconciliation order;
- ownership and generation checks;
- actual Deployment plus EndpointSlice readiness requirements;
- repeat reconciliation against already-ready resources without duplicate
  PVCs, Deployments, or Services;
- compute/Service/Secret removal with PVC retention;
- repeat undeployment after compute resources are already absent;
- runtime access resolution without trusting stored endpoints;
- server-side credential injection and browser credential isolation;
- forward-only same-revision redeploy generations and retry idempotency;
- restore-as-new-revision integrity behavior;
- deployment API response and error contracts;
- managed startup configuration;
- explicit migration service behavior;
- runtime-storage dry run, backup preservation, split-layout verification, and idempotent replay;
- MongoDB atomic generation, storage, and migration transitions; and
- syntactic decoding plus no-Secret checks for deployable platform YAML.

One important boundary remains intentionally unproven: no real Kubernetes cluster lifecycle test has been run. Fake-client tests cannot prove admission/defaulting, StorageClass provisioning, scheduler behavior, image pulling, ingress/DNS/TLS, CNI NetworkPolicy enforcement, container startup, or real endpoint publication.

The final deployment-layer acceptance test must therefore use a disposable Kubernetes environment and prove:

```text
publish -> deploy -> artifact materialization -> PVC bind -> pod ready
       -> authenticated proxy call -> new revision update with same PVC
       -> undeploy with compute absent and PVC retained
       -> redeploy with retained memory/scratchpad intact
```

That test remains deferred by the current decision not to use a real cluster. Until it passes, the deployment layer is implementation-complete at unit/fake-integration level but not production-acceptance-complete.

### 57. Deployment-Layer Acceptance Accounting

The deployment-layer definition contains twenty exact goals. The current
state should be read in two groups rather than summarized as simply “done.”

#### Implemented and locally validated

| Goal | Evidence and current guarantee |
| --- | --- |
| 1. Backend deployment operations | Authenticated, owner-scoped deploy, undeploy, status, restore, and runtime-proxy routes exist. The client cannot choose namespace, image, credentials, Secret names, or bundle URL. |
| 2. Monotonic deployment generations | Every intentional action increments the generation, including the same revision. Optimistic compare-and-set filters handle concurrency, exact request replay is idempotent, and generation fences stop stale workers. |
| 3. Restore older configuration forward | Restoring historical content appends a new immutable revision with `source_revision`; direct desired-state rollback remains rejected. |
| 4. Automatic controller | Managed startup runs the leased controller, which claims due work, refreshes claims, classifies retries, survives durable-state restarts, and shuts down with the backend. |
| 5. Real Kubernetes adapter implementation | The concrete `client-go` adapter creates, verifies, updates, and deletes a stable PVC, two Secrets, a one-replica Deployment, and a ClusterIP Service. Repeating a completed run produces no duplicates. This is validated with the client-go fake API, not a real API server. |
| 6. Safe resource ownership | Full owner/deployment identity plus generation and revision metadata are verified before adoption or mutation. A foreign same-name object is a terminal conflict. |
| 7. AgentFlow-owned credentials | Required provider keys are selected from the platform Secret and copied into the scoped runtime Secret. The runtime token is generated server-side; secret values are absent from bundles, MongoDB deployment state, URLs, logs, and API responses. |
| 8. Secure bundle delivery | Delivery credentials are short-lived and scoped to owner, deployment, generation, revision, hash, and schema. Artifact access is bearer-authenticated over the configured HTTPS URL; runtime materialization verifies the immutable bundle. Tokens are rotated/revoked and never placed in the URL. |
| 9. Stable persistent storage | PVC identity derives only from owner plus logical deployment, not revision or generation. It is retained through rollout, undeploy, and redeploy. |
| 10. Missing/conflicting storage | A missing previously-bound PVC becomes a durable `missing` state and terminal safe failure. The adapter refuses to provision a replacement. UID or policy conflicts also fail closed. |
| 11. Single writer | Deployment replicas are fixed at one with `Recreate`. Runtime startup checks the expected generation and acquires an on-volume writer fence before opening shared writable state. |
| 12. Readiness from runtime reality | Ready state requires PVC binding, successful init-container bundle materialization, pod/container readiness through Deployment availability, and a ready EndpointSlice. Merely creating objects is insufficient. |
| 13. Retaining-data undeploy | Undeploy deletes compute, Service, and per-deployment Secrets and revokes delivery credentials while retaining the PVC. Repeating deletion after those objects are absent succeeds. |
| 14. AgentFlow runtime access | The authenticated backend proxy rechecks ownership and the current live generation, keeps the runtime token server-side, targets only the internal Service, strips browser credentials, and converts transport failures into safe responses. |
| 15. Understandable status | The API reports desired revision/generation/action, observed generation, phase, readiness, storage phase, current safe failure, runtime availability/path, last transition, attempt count, and scheduled retry time. |
| 16. Failure classification | Typed retryable and terminal errors drive bounded backoff or final failure. Public messages are safe while internal causes remain server-side. A failed generation never replaces retained storage. |
| 17. Crash recovery | Durable desired/observed state plus idempotent live inspection allow reconciliation to continue after partial resource creation or deletion. Tests repeat run against already-ready resources and repeat an already-completed undeploy. Artifact token issuance begins by revoking the generation, so replay cannot leave an older token valid. |
| 18. Platform Kubernetes contract | The repository contains namespaces, backend Deployment/Services, ServiceAccount, scoped RBAC, provider-Secret contract, HTTPS artifact Ingress, resource limits, NetworkPolicy, digest-pinned image inputs, StorageClass expectations, Dockerfiles, and installation documentation. Environment-specific MongoDB, Redis, ingress controller, TLS, registry, and MCP workloads remain documented prerequisites. |
| 19. Explicit migrations | Deployment-state and legacy runtime-storage tools provide real dry runs, explicit apply, source backup guidance, compare-and-set or phase-manifest replay, post-write verification, and forward failure recovery. Normal backend/runtime startup does not migrate destructively. |

#### Deliberately outstanding

| Goal | Why it is still open |
| --- | --- |
| 20. Complete real-cluster lifecycle | The user chose not to run Kubernetes at this stage. Therefore admission/defaulting, dynamic volume provisioning, scheduler behavior, image pulling, TLS/Ingress/DNS, NetworkPolicy enforcement, actual pod startup, endpoint publication, and retained-data behavior across real pods remain unproven. |

The honest completion statement is therefore:

```text
19 of 20 acceptance goals have implementation plus local automated evidence.
Goal 20 remains deferred and is required before production acceptance.
```

Final validation after the latest status, migration, runtime-access, and
idempotency changes:

```text
GOCACHE=/tmp/codex-go-cache-graas go test -count=1 ./...
  -> passed, including MongoDB integration

GOCACHE=/tmp/codex-go-cache-graas go build ./...
  -> passed

GOCACHE=/tmp/codex-go-cache-graas go vet ./...
  -> passed

GOCACHE=/tmp/codex-go-cache-graas go test -race \
  ./deployment/... ./handlers ./runtime ./repo/mongorepo
  -> passed

GOCACHE=/tmp/codex-go-cache-graas go mod tidy -diff
  -> passed with no diff

git diff --check
  -> passed
```
