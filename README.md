# AgentFlow

**A Go-based, action-driven multi-agent runtime with pluggable agent strategies.**

AgentFlow is a generalized agent execution engine supporting multiple cognition models. It is designed to be a focused, buildable core system that provides a unified abstraction for tools, agents, and workflows.

## 🏗️ 1. Architecture

### V1 Architecture
The current version focuses on a streamlined, in-memory execution pipeline:

```text
UI (React) 
   ↓
Backend (Go) 
   ↓
Execution Engine (Go) 
   ↓
Agents (in-memory)
```

---

## 🧩 2. Core Building Blocks

### 🔹 Node (Agent)
A unit of decision-making. It receives the current state and returns an action.
```go
Run(ctx, state) -> Action
```

### 🔹 Action (MOST IMPORTANT)
The universal contract of the system. Everything revolves around actions.
- `tool`: Call a tool.
- `delegate`: Call another agent.
- `respond`: End execution.
- `plan_update`: Update plan (optional).

### 🔹 State (Shared Context)
- Structure: `TaskID + Data map`
- Shared across all agents.
- Stored externally (or in-memory for V1).

---

## 🔁 3. Execution Model (Core Loop)

The execution engine follows a continuous loop:
```text
Node → Action → Runtime → Next Node
```

**Runtime behavior based on received Action:**
- **`tool`**: Executes the tool and updates the state.
- **`delegate`**: Switches context to another agent.
- **`respond`**: Ends the loop and returns the result.

---

## 🧠 4. Agent Strategies (Cognition Layer)

The system supports **3 distinct architectures**. The key insight is that the **runtime remains the same**; only the **strategy (decision logic)** changes.

### 1️⃣ ReAct
- `LLM → tool → LLM → ...`
- Iterative reasoning and tool usage.

### 2️⃣ Multi-Agent (Network)
- `Agent A ↔ Agent B ↔ Agent C`
- Decentralized flow where any agent can delegate tasks.

### 3️⃣ Supervisor–Worker
- `Supervisor → Workers`
- Centralized flow where workers execute tasks but do not delegate.

### ⚖️ Network vs Supervisor Flow
| Concept    | Network     | Supervisor      |
| ---------- | ----------- | --------------- |
| Control    | distributed | centralized     |
| Delegation | any agent   | only supervisor |
| Flow       | dynamic     | structured      |

*(This is enforced via permissions like `CanDelegate`)*

---

## 🧬 5. Deep Agent Concepts (Lightweight V1)
To demonstrate depth without overwhelming complexity, V1 includes:
- **Planning**: Handled via the `plan_update` action.
- **Task state tracking**: Combines the initial active plan with completed steps.

---

## 🛑 6. Termination Control
To prevent infinite loops, bounded execution is strictly managed.

**Enforced constraints:**
- Maximum steps limit.
- Required `respond` action to formally conclude execution.

**Optional constraints:**
- Loop detection.
- Timeouts.

---

## 🔗 7. Tools System
Tools provide external capabilities to agents. Agents can call tools and use the resulting output in their state.
```go
Execute(input) -> output
```

---

## 🎯 8. Key Design Principles

1. **Action-driven system**: Every outcome is an action.
2. **Strategy ≠ Runtime**: Strategy handles decision-making; the runtime handles execution.
3. **Stateless Agents**: Agents do not hold internal state; state is strictly external.
4. **Unified Abstraction**: Tools, agents, and workflows are all handled through the same underlying abstraction.
5. **Extensible System**: To add a new feature, simply introduce a new action type.
