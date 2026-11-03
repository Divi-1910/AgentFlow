import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { useDashboardData } from "../hooks/useDashboardData";

const reveal = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { delayChildren: 0.05, staggerChildren: 0.06 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
  },
};

function formatDate(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function labelFromStatus(status) {
  return (status || "unknown").replaceAll("_", " ");
}

function StatusBadge({ status }) {
  const normalizedStatus = status || "unknown";
  const tone =
    {
      completed: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
      failed: "border-red-400/20 bg-red-400/10 text-red-300",
      running: "border-sky-400/20 bg-sky-400/10 text-sky-300",
      waiting_jobs: "border-amber-400/20 bg-amber-400/10 text-amber-300",
      cancelling: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    }[normalizedStatus] ?? "border-white/10 bg-white/5 text-content-supporting";

  return (
    <span
      className={`rounded-full border px-2.5 py-1 font-headline text-[9px] font-semibold uppercase tracking-[0.14em] ${tone}`}
    >
      {labelFromStatus(normalizedStatus)}
    </span>
  );
}

function Metric({ label, value, detail }) {
  return (
    <motion.div
      variants={fadeUp}
      className="min-w-0 border-t border-white/10 pt-5"
    >
      <p className="font-headline text-4xl font-semibold tracking-tight text-white sm:text-5xl">
        {value}
      </p>
      <p className="mt-3 font-headline text-[10px] font-semibold uppercase tracking-[0.22em] text-content-supporting">
        {label}
      </p>
      <p className="mt-1 text-xs text-content-muted">{detail}</p>
    </motion.div>
  );
}

function Panel({ eyebrow, title, action, children }) {
  return (
    <motion.section
      variants={fadeUp}
      className="rounded-3xl border border-white/[0.08] bg-white/[0.025] p-6 sm:p-7"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-supporting">
            {eyebrow}
          </p>
          <h2 className="mt-2 font-headline text-xl font-semibold text-white">
            {title}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </motion.section>
  );
}

function EmptyState({ children }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 text-center">
      <p className="max-w-sm text-sm leading-6 text-content-supporting">{children}</p>
    </div>
  );
}

function DashboardLoading() {
  return (
    <section
      aria-label="Loading workspace overview"
      className="w-full max-w-[1600px] animate-pulse pb-32"
    >
      <div className="mb-12 h-16 w-72 rounded-2xl bg-white/5" />
      <div className="grid grid-cols-2 gap-7 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-28 rounded-2xl bg-white/[0.04]" />
        ))}
      </div>
      <div className="mt-12 grid gap-6 xl:grid-cols-2">
        <div className="h-80 rounded-3xl bg-white/[0.04]" />
        <div className="h-80 rounded-3xl bg-white/[0.04]" />
      </div>
    </section>
  );
}

function DashboardError({ error, onRetry }) {
  return (
    <section
      className="flex min-h-[60vh] w-full items-center justify-center px-6 text-center"
      role="alert"
    >
      <div className="max-w-md">
        <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.25em] text-red-300/70">
          Connection problem
        </p>
        <h1 className="mt-4 font-headline text-3xl font-semibold text-white">
          The workspace could not be loaded
        </h1>
        <p className="mt-4 text-sm leading-6 text-content-supporting">
          {error?.message ||
            "AgentFlow could not reach the backend. Your data has not been changed."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-7 min-h-11 rounded-full bg-white px-6 text-sm font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          Retry connection
        </button>
      </div>
    </section>
  );
}

function Capability({ enabled, label }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] py-3 last:border-0">
      <span className="text-sm text-content-supporting">{label}</span>
      <span
        className={`font-headline text-[9px] font-semibold uppercase tracking-[0.16em] ${enabled ? "text-emerald-300" : "text-content-muted"}`}
      >
        {enabled ? "Available" : "Unavailable"}
      </span>
    </div>
  );
}

const journeySteps = [
  {
    detail: "Define one responsibility, its model, instructions, tools, memory, and MCP access.",
    href: "/agents/new",
    icon: "smart_toy",
    label: "Agent",
  },
  {
    detail: "Connect reusable Agents into a directed, acyclic delegation graph.",
    href: "/teams/new",
    icon: "account_tree",
    label: "Team",
  },
  {
    detail: "Run the Agent or Team with streaming output and inspectable activity.",
    href: "/chat",
    icon: "forum",
    label: "Chat",
  },
  {
    detail: "Freeze an immutable revision, deploy it, and observe runtime health.",
    href: "/deployments",
    icon: "deployed_code",
    label: "Publish",
  },
];

function FirstRunJourney() {
  return (
    <motion.section variants={fadeUp} className="mt-10 rounded-3xl border border-white/[0.08] bg-white/[0.025] p-6 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-supporting">Your first working system</p>
          <h2 className="mt-2 font-headline text-2xl font-semibold text-white">Agent → Team → Chat → Publish</h2>
        </div>
        <Link to="/templates" className="agent-secondary-button">Browse templates</Link>
      </div>
      <div className="mt-7 grid gap-3 lg:grid-cols-4">
        {journeySteps.map((step, index) => (
          <Link key={step.label} to={step.href} className="group rounded-2xl border border-white/[0.08] bg-black/20 p-5 transition-colors hover:border-white/15 hover:bg-white/[0.04]">
            <div className="flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-content-secondary">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">{step.icon}</span>
              </span>
              <span className="font-headline text-[9px] font-semibold uppercase tracking-[0.2em] text-content-muted">0{index + 1}</span>
            </div>
            <h3 className="mt-5 font-headline text-base font-semibold text-white">{step.label}</h3>
            <p className="mt-2 text-xs leading-5 text-content-supporting">{step.detail}</p>
            <span className="mt-5 inline-flex items-center gap-1 text-[11px] text-white/70 transition-colors group-hover:text-white">Open <span aria-hidden="true" className="material-symbols-outlined text-[14px]">arrow_outward</span></span>
          </Link>
        ))}
      </div>
    </motion.section>
  );
}

function CatalogReadiness({ mcpServers = [], models = [] }) {
  const emptyModels = models.length === 0;
  const providersUnavailable = models.length > 0 && models.every((model) => !model.available);
  const emptyMcp = mcpServers.length === 0;
  if (!emptyModels && !providersUnavailable && !emptyMcp) return null;

  return (
    <motion.section variants={fadeUp} className="mt-6 rounded-3xl border border-amber-200/15 bg-amber-200/[0.045] p-6 sm:p-7" aria-labelledby="catalog-readiness-heading">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-200/15 bg-amber-200/[0.06] text-amber-100">
          <span aria-hidden="true" className="material-symbols-outlined text-[19px]">database</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.22em] text-amber-100/60">Local catalog setup</p>
          <h2 id="catalog-readiness-heading" className="mt-2 font-headline text-xl font-semibold text-white">The runtime catalog needs attention</h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-content-supporting">
            {emptyModels && <p><strong className="text-white/85">No LLM records:</strong> add model metadata to <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-white/75">AgentFlow.llm_registry</code> with <code className="text-xs text-white/75">mongosh</code>.</p>}
            {providersUnavailable && <p><strong className="text-white/85">Models exist, but no provider is available:</strong> set the matching backend credential such as <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-white/75">OPENAI_API_KEY</code>, <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-white/75">ANTHROPIC_API_KEY</code>, or <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-white/75">NVIDIA_API_KEY</code>, then restart the backend.</p>}
            {emptyMcp && <p><strong className="text-white/85">No enabled MCP records:</strong> start the local harness with <code className="rounded bg-black/40 px-1.5 py-0.5 text-xs text-white/75">./mcp_servers/start-all.sh</code>, then manually upsert the documented catalog entries.</p>}
          </div>
          <a href="https://github.com/Divi-1910/AgentFlow/blob/master/docs/LOCAL_CATALOG_SETUP.md" target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 text-xs font-medium text-white underline decoration-white/25 underline-offset-4 hover:decoration-white">
            Open exact local setup commands
            <span aria-hidden="true" className="material-symbols-outlined text-[15px]">open_in_new</span>
          </a>
        </div>
      </div>
    </motion.section>
  );
}

export default function DashboardPage() {
  const { data, error, loading, reload } = useDashboardData();
  const reduceMotion = useReducedMotion();

  if (loading) return <DashboardLoading />;
  if (error) return <DashboardError error={error} onRetry={reload} />;

  const { capabilities, mcpServers, models, overview, runs, threads } = data;
  const firstRun = overview.resources.agents === 0
    && overview.resources.teams === 0
    && threads.length === 0;
  const animationProps = reduceMotion
    ? {}
    : { variants: reveal, initial: "hidden", animate: "show" };

  return (
    <motion.section {...animationProps} className="w-full max-w-[1600px] pb-32">
      <motion.header
        variants={reduceMotion ? undefined : fadeUp}
        className="flex flex-col gap-6 border-b border-white/[0.06] pb-10 sm:flex-row sm:items-end sm:justify-between"
      >
        <div>
          <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.3em] text-content-supporting">
            System overview
          </p>
          <h1 className="mt-3 font-headline text-5xl font-semibold uppercase tracking-tight text-white sm:text-6xl">
            Workspace
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-content-supporting">
            Live inventory, execution activity, and deployment health from your
            AgentFlow backend.
          </p>
        </div>
        <Link
          to="/chat"
          className="inline-flex min-h-11 items-center justify-center rounded-full bg-white px-6 font-headline text-[10px] font-semibold uppercase tracking-[0.18em] text-black transition-colors hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          Open studio
        </Link>
      </motion.header>

      {firstRun ? <FirstRunJourney /> : null}
      <CatalogReadiness mcpServers={mcpServers} models={models} />

      <div className="mt-12 grid grid-cols-2 gap-x-7 gap-y-10 lg:grid-cols-4">
        <Metric
          label="Agents"
          value={overview.resources.agents}
          detail="Individual resources"
        />
        <Metric
          label="Agent teams"
          value={overview.resources.teams}
          detail="Multi-agent resources"
        />
        <Metric
          label="Active runs"
          value={overview.runs.active}
          detail="Running or resumable"
        />
        <Metric
          label="Ready deployments"
          value={
            overview.deployments.managed_enabled
              ? overview.deployments.ready
              : "—"
          }
          detail={
            overview.deployments.managed_enabled
              ? `${overview.deployments.total} managed total`
              : "Managed hosting disabled"
          }
        />
      </div>

      <div className="mt-14 grid gap-6 xl:grid-cols-2">
        <Panel
          eyebrow="Resume work"
          title="Recent conversations"
          action={
            <Link
              to="/chat"
              className="text-xs text-content-supporting underline decoration-white/20 underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            >
              View studio
            </Link>
          }
        >
          {threads.length === 0 ? (
            <EmptyState>
              No conversations yet. Open Studio when you are ready to run an
              agent or team.
            </EmptyState>
          ) : (
            <div>
              {threads.map((thread) => (
                <div
                  key={thread.id}
                  className="flex items-center justify-between gap-5 border-b border-white/[0.06] py-4 first:pt-0 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white/80">
                      {thread.title || "Untitled conversation"}
                    </p>
                    <p className="mt-1 truncate text-xs text-content-muted">
                      {thread.resource?.name ||
                        labelFromStatus(thread.resource_kind)}
                    </p>
                  </div>
                  <time
                    className="shrink-0 text-right text-[11px] text-content-muted"
                    dateTime={thread.updated_at}
                  >
                    {formatDate(thread.updated_at)}
                  </time>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel eyebrow="Execution" title="Recent runs">
          {runs.length === 0 ? (
            <EmptyState>
              No runs yet. Execution history will appear here after your first
              Studio request.
            </EmptyState>
          ) : (
            <div>
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between gap-5 border-b border-white/[0.06] py-4 first:pt-0 last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white/80">
                      {run.resource?.name || "Unknown resource"}
                    </p>
                    <p className="mt-1 text-xs text-content-muted">
                      Attempt {run.attempt || 1} · {run.steps_completed || 0}{" "}
                      steps completed
                    </p>
                  </div>
                  <StatusBadge status={run.status} />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Panel eyebrow="Runtime supply" title="Available catalog">
          <div className="grid grid-cols-3 gap-4">
            <Metric
              label="Models"
              value={overview.catalog.available_models}
              detail="Provider-backed"
            />
            <Metric
              label="Tools"
              value={overview.catalog.available_tools}
              detail="Runtime-ready"
            />
            <Metric
              label="MCP servers"
              value={overview.catalog.available_mcp_servers}
              detail="Enabled-Usage"
            />
          </div>
        </Panel>

        <Panel eyebrow="Platform" title="Capabilities">
          <Capability
            enabled={capabilities.studio_execution}
            label="Studio execution"
          />
          <Capability
            enabled={capabilities.managed_deployments}
            label="Managed deployments"
          />
          <Capability
            enabled={capabilities.runtime_proxy}
            label="Runtime proxy"
          />
        </Panel>
      </div>

      {overview.deployments.managed_enabled &&
        (overview.deployments.in_progress > 0 ||
          overview.deployments.degraded > 0 ||
          overview.deployments.failed > 0) && (
          <motion.div
            variants={reduceMotion ? undefined : fadeUp}
            className="mt-6 rounded-3xl border border-amber-300/15 bg-amber-300/[0.06] p-6"
          >
            <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200/70">
              Deployment attention
            </p>
            <p className="mt-2 text-sm leading-6 text-content-supporting">
              {overview.deployments.in_progress} in progress,{" "}
              {overview.deployments.degraded} degraded, and{" "}
              {overview.deployments.failed} failed.
            </p>
          </motion.div>
        )}
    </motion.section>
  );
}
