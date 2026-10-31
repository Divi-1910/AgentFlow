export function fieldId(field) {
  if (['mcp_servers', 'mcp_server_ids', 'tools'].includes(field)) return 'capability-search'
  return `agent-${field.replaceAll('_', '-')}`
}
