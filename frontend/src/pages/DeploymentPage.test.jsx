import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useApiClient } from '../hooks/useApiClient'
import { useDeploymentWorkspace } from '../hooks/useDeploymentWorkspace'
import DeploymentPage from './DeploymentPage'

vi.mock('../hooks/useApiClient', () => ({ useApiClient: vi.fn() }))
vi.mock('../hooks/useDeploymentWorkspace', () => ({ useDeploymentWorkspace: vi.fn() }))

const agent = {
  description: 'Investigates technical questions.',
  id: 'agent-1',
  name: 'Research Analyst',
  resource_kind: 'standalone_agent',
}

function workspace(overrides = {}) {
  return {
    action: null,
    actionError: null,
    capabilities: { managed_deployments: true },
    clearActionError: vi.fn(),
    deploy: vi.fn(),
    deployments: [],
    detailLoading: false,
    error: null,
    loading: false,
    publications: [
      { bundle_url: '/api/agents/agent-1/publications/2/bundle', config_hash: 'new-hash', created_at: '2026-11-01T12:00:00Z', revision: 2, schema_version: 1 },
      { bundle_url: '/api/agents/agent-1/publications/1/bundle', config_hash: 'old-hash', created_at: '2026-10-31T12:00:00Z', revision: 1, schema_version: 1 },
    ],
    publish: vi.fn(),
    refreshDetail: vi.fn(),
    reload: vi.fn(),
    resources: [agent],
    restoreAndDeploy: vi.fn(),
    selectedResource: agent,
    selectResource: vi.fn(),
    status: null,
    undeploy: vi.fn(),
    ...overrides,
  }
}

function renderPage() {
  return render(<MemoryRouter><DeploymentPage /></MemoryRouter>)
}

describe('DeploymentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useApiClient.mockReturnValue({ download: vi.fn() })
  })

  it('keeps publication and bundle export available without managed hosting', () => {
    useDeploymentWorkspace.mockReturnValue(workspace({
      capabilities: { managed_deployments: false },
    }))

    renderPage()

    expect(screen.getByText('Managed Kubernetes hosting is disabled')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Publish revision' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Bundle' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Deploy/ })).toBeNull()
  })

  it('shows immutable forward restoration and current deployment health', () => {
    useDeploymentWorkspace.mockReturnValue(workspace({
      status: {
        desired_generation: 4,
        desired_revision: 2,
        observed_generation: 4,
        phase: 'ready',
        ready: true,
        storage_phase: 'ready',
      },
    }))

    renderPage()

    expect(screen.getAllByText('Live').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Restore as new + deploy' })).toBeTruthy()
    expect(screen.getAllByText('r2').length).toBeGreaterThan(0)
  })
})
