import { motion, useReducedMotion } from 'framer-motion'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deploymentSummary,
  deploymentTone,
  isDeploymentTransitional,
  latestRevision,
  RESOURCE_KINDS,
} from '../features/deployments/deploymentState'
import { useApiClient } from '../hooks/useApiClient'
import { useDeploymentWorkspace } from '../hooks/useDeploymentWorkspace'

const toneClasses = {
  negative: 'border-red-300/20 bg-red-300/[0.06] text-red-200',
  neutral: 'border-white/10 bg-white/[0.025] text-content-secondary',
  positive: 'border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-200',
  progress: 'border-sky-300/20 bg-sky-300/[0.06] text-sky-200',
  warning: 'border-amber-300/20 bg-amber-300/[0.06] text-amber-200',
}

function formatDate(value) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function ResourceGlyph({ kind }) {
  return (
    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
      {kind === RESOURCE_KINDS.TEAM ? 'account_tree' : 'smart_toy'}
    </span>
  )
}

function DeploymentLoading() {
  return (
    <section className="mx-auto w-full max-w-[1600px] animate-pulse pb-24" aria-label="Loading deployment center">
      <div className="h-24 w-2/5 rounded-3xl bg-white/[0.04]" />
      <div className="mt-10 grid min-h-[620px] gap-5 xl:grid-cols-[310px_1fr]">
        <div className="rounded-3xl bg-white/[0.04]" />
        <div className="rounded-3xl bg-white/[0.04]" />
      </div>
    </section>
  )
}

function DeploymentUnavailable({ error, onRetry }) {
  return (
    <section className="flex min-h-[60vh] items-center justify-center text-center" role={error ? 'alert' : undefined}>
      <div className="max-w-xl rounded-3xl border border-white/[0.08] bg-white/[0.025] p-10">
        <span aria-hidden="true" className="material-symbols-outlined text-3xl text-content-supporting">
          {error ? 'cloud_off' : 'deployed_code'}
        </span>
        <p className="mt-6 font-headline text-[10px] font-semibold uppercase tracking-[0.28em] text-content-supporting">
          {error ? 'Connection problem' : 'Kubernetes capability'}
        </p>
        <h1 className="mt-3 font-headline text-3xl font-semibold text-white">
          {error ? 'Deployment Center could not be loaded' : 'Managed hosting is disabled'}
        </h1>
        <p className="mt-4 text-sm leading-7 text-content-supporting">
          {error?.message || 'This AgentFlow backend is not configured with managed Kubernetes deployments. Publication bundles remain available as an export capability, while deploy, health, runtime, and undeploy controls stay hidden.'}
        </p>
        {error ? (
          <button type="button" onClick={onRetry} className="agent-primary-button mt-7">Retry connection</button>
        ) : (
          <Link to="/dashboard" className="agent-secondary-button mt-7">Return to workspace</Link>
        )}
      </div>
    </section>
  )
}

function StatusPill({ status }) {
  const summary = deploymentSummary(status)
  const tone = deploymentTone(status)
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-headline text-[9px] font-semibold uppercase tracking-[0.18em] ${toneClasses[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${isDeploymentTransitional(status) ? 'animate-pulse' : ''}`} />
      {summary.label}
    </span>
  )
}

function Metric({ label, value }) {
  return (
    <div className="border-t border-white/[0.08] pt-4">
      <p className="font-headline text-xl font-semibold text-white">{value}</p>
      <p className="mt-1 font-headline text-[9px] font-semibold uppercase tracking-[0.2em] text-content-muted">{label}</p>
    </div>
  )
}

export default function DeploymentPage() {
  const api = useApiClient()
  const workspace = useDeploymentWorkspace()
  const reduceMotion = useReducedMotion()
  const [downloading, setDownloading] = useState(null)

  const latest = useMemo(() => latestRevision(workspace.publications), [workspace.publications])
  const selectedDeployment = workspace.deployments.find((item) => (
    item.resource_id === workspace.selectedResource?.id
  ))
  const currentStatus = workspace.status || selectedDeployment || null
  const managedHosting = Boolean(workspace.capabilities?.managed_deployments)
  const summary = managedHosting
    ? deploymentSummary(currentStatus)
    : {
        description: 'You can still publish immutable revisions and download their bundles. Configure managed Kubernetes hosting to deploy and observe a runtime.',
        label: 'Publication only',
      }

  if (workspace.loading) return <DeploymentLoading />
  if (workspace.error) return <DeploymentUnavailable error={workspace.error} onRetry={workspace.reload} />

  async function downloadBundle(revision) {
    setDownloading(revision.revision)
    workspace.clearActionError()
    try {
      const path = revision.bundle_url.replace(/^\/api/, '')
      const result = await api.download(path, {
        filename: `deployment-${workspace.selectedResource.id}-r${revision.revision}.json`,
      })
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      // The workspace hook owns operation errors; downloads are local-only and can be retried safely.
      window.alert(error.message || 'The bundle could not be downloaded.')
    } finally {
      setDownloading(null)
    }
  }

  function confirmUndeploy() {
    if (!currentStatus || currentStatus.phase === 'deleted') return
    const confirmed = window.confirm(
      `Undeploy “${workspace.selectedResource.name}”?\n\nThe runtime pod, service, and per-deployment secret will be removed. The persistent volume containing memory and scratchpad data will be retained for the next deployment.`,
    )
    if (confirmed) workspace.undeploy().catch(() => {})
  }

  return (
    <motion.section
      className="mx-auto w-full max-w-[1600px] pb-24"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-white/[0.07] pb-8">
        <div>
          <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.3em] text-content-supporting">Release operations</p>
          <h1 className="mt-3 font-headline text-5xl font-semibold uppercase tracking-tight text-white">Deployment Center</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-content-supporting">
            Publish immutable configurations, move Kubernetes runtimes forward by generation, and protect persistent agent memory across redeployments.
          </p>
        </div>
        <button type="button" onClick={() => workspace.refreshDetail().catch(() => {})} className="agent-secondary-button" disabled={workspace.detailLoading || Boolean(workspace.action)}>
          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">refresh</span>
          Refresh state
        </button>
      </header>

      {!managedHosting && (
        <div className="mt-6 flex items-start gap-4 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5">
          <span aria-hidden="true" className="material-symbols-outlined text-content-supporting">deployed_code</span>
          <div>
            <p className="text-sm font-medium text-white">Managed Kubernetes hosting is disabled</p>
            <p className="mt-1 text-xs leading-5 text-content-supporting">Publication and bundle export remain available. Deployment mutations, runtime health, and undeploy controls require a backend started with managed deployments enabled.</p>
          </div>
        </div>
      )}

      {workspace.resources.length === 0 ? (
        <div className="mt-10 rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-8 py-20 text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-3xl text-content-muted">deployed_code</span>
          <h2 className="mt-5 font-headline text-2xl font-semibold text-white">Create something before publishing</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-content-supporting">Deployment starts with a configured Agent or Agent Team. Nothing has been created in this workspace yet.</p>
          <div className="mt-7 flex justify-center gap-3">
            <Link to="/agents/new" className="agent-primary-button">Create agent</Link>
            <Link to="/teams/new" className="agent-secondary-button">Create team</Link>
          </div>
        </div>
      ) : (
        <div className="mt-8 grid min-h-[680px] gap-5 xl:grid-cols-[310px_minmax(0,1fr)]">
          <aside className="rounded-3xl border border-white/[0.08] bg-white/[0.022] p-3">
            <div className="px-4 pb-4 pt-3">
              <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-muted">Resources</p>
              <p className="mt-2 text-xs text-content-supporting">{workspace.resources.length} publishable objects</p>
            </div>
            <div className="space-y-1" role="listbox" aria-label="Publishable resources">
              {workspace.resources.map((resource) => {
                const selected = resource.id === workspace.selectedResource?.id && resource.resource_kind === workspace.selectedResource?.resource_kind
                const deployment = workspace.deployments.find((item) => item.resource_id === resource.id)
                return (
                  <button
                    type="button"
                    key={`${resource.resource_kind}:${resource.id}`}
                    role="option"
                    aria-selected={selected}
                    onClick={() => workspace.selectResource(resource)}
                    className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors ${selected ? 'border-white/15 bg-white/[0.07]' : 'border-transparent hover:bg-white/[0.035]'}`}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-black/30 text-content-secondary"><ResourceGlyph kind={resource.resource_kind} /></span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-white">{resource.name || 'Untitled resource'}</strong>
                      <small className="mt-1 block truncate text-[11px] text-content-muted">{resource.resource_kind === RESOURCE_KINDS.TEAM ? 'Agent Team' : 'Agent'}</small>
                    </span>
                    <span className={`h-1.5 w-1.5 rounded-full ${deployment?.ready ? 'bg-emerald-300' : deployment ? 'bg-white/40' : 'bg-white/15'}`} />
                  </button>
                )
              })}
            </div>
          </aside>

          <main className="min-w-0 rounded-3xl border border-white/[0.08] bg-white/[0.018]">
            <div className="border-b border-white/[0.07] p-7 sm:p-9">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div>
                  <div className="flex items-center gap-3">
                    <ResourceGlyph kind={workspace.selectedResource.resource_kind} />
                    <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-muted">
                      {workspace.selectedResource.resource_kind === RESOURCE_KINDS.TEAM ? 'Agent Team' : 'Standalone Agent'}
                    </p>
                  </div>
                  <h2 className="mt-3 font-headline text-3xl font-semibold text-white">{workspace.selectedResource.name}</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-content-supporting">{workspace.selectedResource.description || 'No resource description has been added.'}</p>
                </div>
                {managedHosting ? <StatusPill status={currentStatus} /> : (
                  <span className="inline-flex rounded-full border border-white/10 bg-white/[0.025] px-3 py-1.5 font-headline text-[9px] font-semibold uppercase tracking-[0.18em] text-content-secondary">Export mode</span>
                )}
              </div>

              <div className="mt-8 rounded-2xl border border-white/[0.08] bg-black/25 p-6">
                <div className="flex flex-wrap items-start justify-between gap-6">
                  <div className="max-w-2xl">
                    <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.22em] text-content-muted">{managedHosting ? 'Runtime state' : 'Release state'}</p>
                    <h3 className="mt-2 font-headline text-xl font-semibold text-white">{summary.label}</h3>
                    <p className="mt-2 text-sm leading-6 text-content-supporting">{summary.description}</p>
                    {currentStatus?.last_error && (
                      <div className="mt-4 rounded-xl border border-red-300/15 bg-red-300/[0.05] p-4" role="alert">
                        <p className="text-sm font-medium text-red-100">{currentStatus.last_error.message}</p>
                        <p className="mt-1 text-xs text-red-200/60">
                          {currentStatus.last_error.retryable ? 'AgentFlow will retry this failure when scheduled.' : 'This failure requires a configuration change or operator attention.'}
                          {currentStatus.retry_scheduled_at ? ` Next attempt: ${formatDate(currentStatus.retry_scheduled_at)}.` : ''}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={() => workspace.publish().catch(() => {})} className="agent-secondary-button" disabled={Boolean(workspace.action)}>
                      <span aria-hidden="true" className="material-symbols-outlined text-[17px]">inventory_2</span>
                      {workspace.action === 'publish' ? 'Publishing…' : 'Publish revision'}
                    </button>
                    {managedHosting && latest && (
                      <button type="button" onClick={() => workspace.deploy(latest.revision).catch(() => {})} className="agent-primary-button" disabled={Boolean(workspace.action) || isDeploymentTransitional(currentStatus)}>
                        <span aria-hidden="true" className="material-symbols-outlined text-[17px]">rocket_launch</span>
                        {workspace.action === `deploy:${latest.revision}` ? 'Requesting…' : `Deploy r${latest.revision}`}
                      </button>
                    )}
                    {managedHosting && currentStatus && !['deleted', 'deleting'].includes(currentStatus.phase) && (
                      <button type="button" onClick={confirmUndeploy} className="agent-danger-button" disabled={Boolean(workspace.action) || isDeploymentTransitional(currentStatus)}>
                        {workspace.action === 'undeploy' ? 'Undeploying…' : 'Undeploy'}
                      </button>
                    )}
                  </div>
                </div>
                {managedHosting && (
                  <div className="mt-7 grid gap-4 sm:grid-cols-4">
                    <Metric label="Desired generation" value={currentStatus?.desired_generation ?? '—'} />
                    <Metric label="Observed generation" value={currentStatus?.observed_generation ?? '—'} />
                    <Metric label="Desired revision" value={currentStatus?.desired_revision ? `r${currentStatus.desired_revision}` : '—'} />
                    <Metric label="Storage" value={(currentStatus?.storage_phase || 'unprovisioned').replaceAll('_', ' ')} />
                  </div>
                )}
                {currentStatus?.runtime_available && (
                  <div className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.04] px-4 py-3">
                    <div>
                      <p className="text-xs font-medium text-emerald-100">Runtime proxy available</p>
                      <p className="mt-1 font-mono text-[11px] text-emerald-100/55">{currentStatus.runtime_path}</p>
                    </div>
                    <span aria-hidden="true" className="material-symbols-outlined text-emerald-200">check_circle</span>
                  </div>
                )}
              </div>

              {workspace.actionError && (
                <div className="mt-5 flex items-start justify-between gap-4 rounded-2xl border border-red-300/15 bg-red-300/[0.05] p-4" role="alert">
                  <p className="text-sm leading-6 text-red-100/80">{workspace.actionError}</p>
                  <button type="button" onClick={workspace.clearActionError} className="text-red-100/60 hover:text-white" aria-label="Dismiss deployment error">
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>
              )}
            </div>

            <section className="p-7 sm:p-9" aria-labelledby="revision-heading">
              <div className="flex items-end justify-between gap-5">
                <div>
                  <p className="font-headline text-[9px] font-semibold uppercase tracking-[0.24em] text-content-muted">Immutable history</p>
                  <h3 id="revision-heading" className="mt-2 font-headline text-2xl font-semibold text-white">Published revisions</h3>
                </div>
                <span className="font-headline text-[10px] font-semibold uppercase tracking-[0.18em] text-content-muted">{workspace.publications.length} total</span>
              </div>

              {workspace.detailLoading ? (
                <div className="mt-6 h-28 animate-pulse rounded-2xl bg-white/[0.035]" />
              ) : workspace.publications.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-dashed border-white/10 px-7 py-12 text-center">
                  <h4 className="font-headline text-lg font-semibold text-white">No publication exists yet</h4>
                  <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-content-supporting">Publishing captures the current Agent or Team graph as an immutable, downloadable bundle. Later edits do not alter an existing revision.</p>
                  <button type="button" onClick={() => workspace.publish().catch(() => {})} className="agent-primary-button mt-6" disabled={Boolean(workspace.action)}>Publish first revision</button>
                </div>
              ) : (
                <div className="mt-6 divide-y divide-white/[0.07] border-y border-white/[0.07]">
                  {workspace.publications.map((revision) => {
                    const isLatest = revision.revision === latest?.revision
                    const isDesired = revision.revision === currentStatus?.desired_revision
                    return (
                      <article key={revision.revision} className="grid gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="flex min-w-0 items-start gap-4">
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] font-headline text-sm font-semibold text-white">r{revision.revision}</span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="font-headline text-sm font-semibold text-white">Revision {revision.revision}</h4>
                              {isLatest && <span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-content-supporting">Latest</span>}
                              {isDesired && <span className="rounded-full border border-emerald-300/15 bg-emerald-300/[0.05] px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-emerald-200">Desired</span>}
                              {revision.source_revision > 0 && <span className="text-[10px] text-content-muted">restored from r{revision.source_revision}</span>}
                            </div>
                            <p className="mt-1 text-xs text-content-muted">Published {formatDate(revision.created_at)} · schema {revision.schema_version}</p>
                            <p className="mt-1 truncate font-mono text-[10px] text-content-disabled" title={revision.config_hash}>sha256 {revision.config_hash}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <button type="button" onClick={() => downloadBundle(revision)} className="agent-secondary-button" disabled={downloading === revision.revision}>
                            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">download</span>
                            {downloading === revision.revision ? 'Downloading…' : 'Bundle'}
                          </button>
                          {!managedHosting ? null : isLatest ? (
                            <button type="button" onClick={() => workspace.deploy(revision.revision).catch(() => {})} className="agent-secondary-button" disabled={Boolean(workspace.action) || isDeploymentTransitional(currentStatus)}>
                              {isDesired ? 'Redeploy' : 'Deploy'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                const confirmed = window.confirm(`Restore revision ${revision.revision} as a new immutable revision, then deploy that new revision? The revision history will not be rolled back or rewritten.`)
                                if (confirmed) workspace.restoreAndDeploy(revision.revision).catch(() => {})
                              }}
                              className="agent-secondary-button"
                              disabled={Boolean(workspace.action) || isDeploymentTransitional(currentStatus)}
                            >
                              Restore as new + deploy
                            </button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          </main>
        </div>
      )}
    </motion.section>
  )
}
