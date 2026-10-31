const essentialFields = ['name', 'provider', 'model', 'system_prompt']

const runtimeFields = [
  'context_window',
  'context_keep_ratio',
  'temperature',
  'max_steps',
  'max_tokens',
  'max_runs',
]

export const agentToolGroups = [
  {
    description: 'Long-term knowledge the agent can write, retrieve, revise, retire, and audit.',
    icon: 'database',
    id: 'memory',
    label: 'Memory',
    tools: [
      'memory_write',
      'memory_read',
      'memory_search',
      'memory_patch',
      'memory_update',
      'memory_retire',
      'memory_restore',
      'memory_history',
    ],
  },
  {
    description: 'A temporary working surface for structured notes, sections, and intermediate results.',
    icon: 'edit_note',
    id: 'scratchpad',
    label: 'Scratchpad',
    tools: [
      'scratchpad_create',
      'scratchpad_append_section',
      'scratchpad_replace_section',
      'scratchpad_list',
      'scratchpad_get_sections',
      'scratchpad_read_section',
      'scratchpad_search',
    ],
  },
]

const groupedToolNames = new Set(agentToolGroups.flatMap((group) => group.tools))

export function isGroupedAgentTool(toolName) {
  return groupedToolNames.has(toolName)
}

export function getToolGroupSelection(selectedTools, toolNames) {
  const selectedCount = toolNames.filter((toolName) => selectedTools.includes(toolName)).length
  return {
    selectedCount,
    state: selectedCount === 0 ? 'none' : selectedCount === toolNames.length ? 'all' : 'partial',
    total: toolNames.length,
  }
}

export function toggleToolGroup(selectedTools, toolNames) {
  const { state } = getToolGroupSelection(selectedTools, toolNames)
  if (state === 'all') {
    const groupNames = new Set(toolNames)
    return selectedTools.filter((toolName) => !groupNames.has(toolName))
  }

  const nextTools = [...selectedTools]
  const selectedNames = new Set(selectedTools)
  for (const toolName of toolNames) {
    if (!selectedNames.has(toolName)) nextTools.push(toolName)
  }
  return nextTools
}

function hasValue(value) {
  return String(value ?? '').trim().length > 0
}

export function getAgentReadiness(form) {
  const completed = essentialFields.filter((field) => hasValue(form[field])).length

  return {
    completed,
    percent: Math.round((completed / essentialFields.length) * 100),
    ready: completed === essentialFields.length,
    total: essentialFields.length,
  }
}

export function getSelectedAgentCapabilities(form, toolChoices, mcpChoices) {
  const selectedGroups = agentToolGroups.flatMap((group) => {
    const selection = getToolGroupSelection(form.tools, group.tools)
    if (selection.state === 'none') return []

    return [{
      description: selection.state === 'partial'
        ? `${selection.selectedCount} of ${selection.total} operations enabled`
        : `${selection.total} operations enabled`,
      icon: group.icon,
      id: `tool-group:${group.id}`,
      kind: selection.state === 'partial' ? 'Core capability · Partial' : 'Core capability',
      label: group.label,
      tone: 'tool',
    }]
  })

  const selectedTools = toolChoices
    .filter((tool) => !isGroupedAgentTool(tool.name) && form.tools.includes(tool.name))
    .map((tool) => ({
      description: tool.description || 'Embedded AgentFlow capability',
      icon: 'extension',
      id: `tool:${tool.name}`,
      kind: 'Embedded tool',
      label: tool.name,
      tone: 'tool',
    }))

  const selectedMcp = mcpChoices
    .filter((server) => form.mcp_server_ids.includes(server.server_id))
    .map((server) => ({
      description: server.description || 'External MCP capability',
      icon: 'lan',
      id: `mcp:${server.server_id}`,
      kind: 'MCP server',
      label: server.name,
      tone: 'mcp',
    }))

  return [...selectedGroups, ...selectedTools, ...selectedMcp].map((capability, index) => ({
    ...capability,
    index: `C${String(index + 1).padStart(2, '0')}`,
  }))
}

export const agentEditorTabs = ['overview', 'instructions', 'model', 'capabilities', 'runtime']

export function tabForAgentField(field) {
  if (field === 'system_prompt') return 'instructions'
  if (['provider', 'model', 'summarization_model'].includes(field)) return 'model'
  if (['tools', 'mcp_servers', 'mcp_server_ids'].includes(field)) return 'capabilities'
  if (runtimeFields.includes(field)) return 'runtime'
  return 'overview'
}
