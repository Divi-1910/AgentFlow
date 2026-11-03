import { describe, expect, it } from 'vitest'
import {
  deploymentSummary,
  deploymentTone,
  isDeploymentTransitional,
  latestRevision,
  resourceBase,
  RESOURCE_KINDS,
} from './deploymentState'

describe('deployment presentation state', () => {
  it('maps resource kinds to their API boundary', () => {
    expect(resourceBase(RESOURCE_KINDS.AGENT)).toBe('/agents')
    expect(resourceBase(RESOURCE_KINDS.TEAM)).toBe('/agent-teams')
  })

  it('identifies only reconciling phases as transitional', () => {
    expect(isDeploymentTransitional({ phase: 'provisioning' })).toBe(true)
    expect(isDeploymentTransitional({ phase: 'deleting' })).toBe(true)
    expect(isDeploymentTransitional({ phase: 'ready' })).toBe(false)
    expect(isDeploymentTransitional(null)).toBe(false)
  })

  it('keeps failed and degraded states visually distinct', () => {
    expect(deploymentTone({ phase: 'failed' })).toBe('negative')
    expect(deploymentTone({ phase: 'degraded' })).toBe('warning')
    expect(deploymentTone({ phase: 'ready', ready: true })).toBe('positive')
  })

  it('explains that an undeploy retains workspace storage', () => {
    expect(deploymentSummary({ phase: 'deleted' }).description).toContain('storage remains retained')
  })

  it('selects the highest immutable publication revision', () => {
    expect(latestRevision([{ revision: 2 }, { revision: 5 }, { revision: 3 }])).toEqual({ revision: 5 })
    expect(latestRevision([])).toBeNull()
  })
})
