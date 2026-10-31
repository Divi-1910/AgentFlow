import { describeTeamExecution } from '../../features/teams/teamGraph'

function RouteCopy({ route }) {
  return (
    <>
      <span>{route.source?.name || 'Unavailable Agent'} <i aria-hidden="true">→</i> {route.target?.name || 'Unavailable Agent'}</span>
      <strong>{route.condition || `May delegate work to ${route.target?.name || 'this Agent'}.`}</strong>
    </>
  )
}

export default function TeamExecutionSummary({
  agents,
  compact = false,
  draft,
  onSelectRoute,
  validation,
}) {
  const execution = describeTeamExecution(draft, agents)
  const visibleRoutes = compact ? execution.routes.slice(0, 2) : execution.routes
  const issues = validation
    ? [
        ...Object.values(validation.errors || {}),
        ...Object.values(validation.edgeErrors || {}),
      ]
    : []

  return (
    <section className={`team-execution-summary ${compact ? 'team-execution-summary--compact' : ''}`}>
      {!compact ? (
        <div className="team-execution-summary__heading">
          <span aria-hidden="true" className="material-symbols-outlined">play_circle</span>
          <div>
            <span>How this Team runs</span>
            <p>A truthful preview of the runtime behavior.</p>
          </div>
        </div>
      ) : null}

      <p className="team-execution-summary__intro">{execution.intro}</p>

      {visibleRoutes.length > 0 ? (
        <div className="team-execution-summary__routes">
          {visibleRoutes.map((route, index) => onSelectRoute ? (
            <button key={route.id} type="button" onClick={() => onSelectRoute(route.id)}>
              <em>{String(index + 1).padStart(2, '0')}</em>
              <span><RouteCopy route={route} /></span>
              <i aria-hidden="true" className="material-symbols-outlined">arrow_outward</i>
            </button>
          ) : (
            <div key={route.id}>
              <em>{String(index + 1).padStart(2, '0')}</em>
              <span><RouteCopy route={route} /></span>
            </div>
          ))}
          {compact && execution.routes.length > visibleRoutes.length ? (
            <small>+{execution.routes.length - visibleRoutes.length} more delegation {execution.routes.length - visibleRoutes.length === 1 ? 'route' : 'routes'}</small>
          ) : null}
        </div>
      ) : null}

      <p className="team-execution-summary__note">
        <span aria-hidden="true" className="material-symbols-outlined">info</span>
        {execution.note}
      </p>

      {!compact && validation ? (
        <div className={`team-readiness ${validation.valid ? 'team-readiness--ready' : ''}`}>
          <span>{validation.valid ? 'Ready to save' : `${issues.length} ${issues.length === 1 ? 'item' : 'items'} to finish`}</span>
          {validation.valid ? (
            <p>The Team graph is complete and every Agent can be reached from the entry Agent.</p>
          ) : (
            <ul>{issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul>
          )}
        </div>
      ) : null}
    </section>
  )
}
