export const RESOURCE_KINDS = Object.freeze({
  AGENT: 'standalone_agent',
  TEAM: 'agent_team',
})

const TRANSITIONAL_PHASES = new Set(['pending', 'provisioning', 'starting', 'deleting'])

export function resourceBase(resourceKind) {
  return resourceKind === RESOURCE_KINDS.TEAM ? '/agent-teams' : '/agents'
}

export function isDeploymentTransitional(status) {
  return Boolean(status && TRANSITIONAL_PHASES.has(status.phase))
}

export function deploymentTone(status) {
  if (!status) return 'neutral'
  if (status.phase === 'ready' && status.ready) return 'positive'
  if (status.phase === 'failed') return 'negative'
  if (status.phase === 'degraded') return 'warning'
  if (status.phase === 'deleted') return 'neutral'
  if (isDeploymentTransitional(status)) return 'progress'
  return 'neutral'
}

export function deploymentSummary(status) {
  if (!status) return {
    description: 'This resource has never been deployed.',
    label: 'Not deployed',
  }

  const summaries = {
    pending: ['Queued', 'AgentFlow accepted the desired deployment state and is waiting for reconciliation.'],
    provisioning: ['Provisioning', 'Persistent storage and Kubernetes resources are being prepared.'],
    starting: ['Starting', 'The runtime pod is starting and has not reported ready yet.'],
    ready: ['Live', `Revision ${status.desired_revision} is ready and serving requests.`],
    degraded: ['Degraded', 'The runtime is available but is not fully healthy. Review the failure details before retrying.'],
    failed: ['Failed', 'The requested generation could not be reconciled. The previous persistent workspace remains protected.'],
    deleting: ['Undeploying', 'Runtime resources are being removed. Persistent workspace storage is retained.'],
    deleted: ['Undeployed', 'Runtime resources are removed. Persistent workspace storage remains retained for the next deployment.'],
  }
  const [label, description] = summaries[status.phase] || ['Unknown', 'AgentFlow returned an unrecognized deployment phase.']
  return { description, label }
}

export function latestRevision(publications) {
  return publications.reduce((latest, revision) => (
    !latest || revision.revision > latest.revision ? revision : latest
  ), null)
}

export function isCurrentRevision(status, revision) {
  return Boolean(status && revision && status.desired_revision === revision.revision && status.desired_action === 'run')
}
