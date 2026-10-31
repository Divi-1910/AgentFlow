const optionalNumberFields = [
  'context_window',
  'context_keep_ratio',
  'max_steps',
  'temperature',
  'max_tokens',
  'max_runs',
]

const trimmedFields = new Set([
  'name',
  'provider',
  'model',
  'summarization_model',
])

export function createEmptyAgentForm() {
  return {
    name: '',
    description: '',
    provider: '',
    model: '',
    system_prompt: '',
    tools: [],
    mcp_server_ids: [],
    context_window: '',
    context_keep_ratio: '',
    summarization_model: '',
    max_steps: '',
    temperature: '',
    max_tokens: '',
    max_runs: '',
  }
}

function stringNumber(value) {
  return value === null || value === undefined ? '' : String(value)
}

export function agentToForm(agent) {
  if (!agent) return createEmptyAgentForm()

  return {
    name: agent.name ?? '',
    description: agent.description ?? '',
    provider: agent.provider ?? '',
    model: agent.model ?? '',
    system_prompt: agent.system_prompt ?? '',
    tools: [...(agent.tools ?? [])],
    mcp_server_ids: (agent.mcp_servers ?? []).map((server) => server.server_id),
    context_window: stringNumber(agent.context_window),
    context_keep_ratio: stringNumber(agent.context_keep_ratio),
    summarization_model: agent.summarization_model ?? '',
    max_steps: stringNumber(agent.max_steps),
    temperature: stringNumber(agent.temperature),
    max_tokens: stringNumber(agent.max_tokens),
    max_runs: stringNumber(agent.max_runs),
  }
}

function normalizedString(field, value) {
  const stringValue = value ?? ''
  return trimmedFields.has(field) ? stringValue.trim() : stringValue
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return undefined
  return Number(value)
}

export function validateAgentForm(form, { requireRuntimeValues = false } = {}) {
  const errors = {}

  for (const field of ['name', 'provider', 'model', 'system_prompt']) {
    if (!String(form[field] ?? '').trim()) errors[field] = 'This field is required.'
  }

  for (const field of ['context_window', 'max_steps', 'max_tokens', 'max_runs']) {
    const value = optionalNumber(form[field])
    if (requireRuntimeValues && value === undefined) {
      errors[field] = 'Existing agents require an explicit saved value.'
      continue
    }
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      errors[field] = 'Enter a whole number greater than 0.'
    }
  }

  for (const field of ['context_keep_ratio', 'temperature']) {
    const value = optionalNumber(form[field])
    if (requireRuntimeValues && value === undefined) {
      errors[field] = 'Existing agents require an explicit saved value.'
      continue
    }
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 1)) {
      errors[field] = 'Enter a number greater than 0 and at most 1.'
    }
  }

  return errors
}

export function buildCreateAgentPayload(form) {
  const payload = {
    name: normalizedString('name', form.name),
    description: form.description ?? '',
    provider: normalizedString('provider', form.provider),
    model: normalizedString('model', form.model),
    system_prompt: form.system_prompt ?? '',
    tools: [...(form.tools ?? [])],
    mcp_servers: (form.mcp_server_ids ?? []).map((serverId) => ({ server_id: serverId })),
  }

  const summarizationModel = normalizedString('summarization_model', form.summarization_model)
  if (summarizationModel) payload.summarization_model = summarizationModel

  for (const field of optionalNumberFields) {
    const value = optionalNumber(form[field])
    if (value !== undefined) payload[field] = value
  }

  return payload
}

function arraysEqual(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function buildAgentPatch(form, originalAgent) {
  if (!originalAgent) return {}

  const original = agentToForm(originalAgent)
  const patch = {}

  for (const field of [
    'name',
    'description',
    'provider',
    'model',
    'system_prompt',
    'summarization_model',
  ]) {
    const currentValue = normalizedString(field, form[field])
    const originalValue = normalizedString(field, original[field])
    if (currentValue !== originalValue) patch[field] = currentValue
  }

  if (!arraysEqual(form.tools, original.tools)) {
    patch.tools = [...(form.tools ?? [])]
  }

  if (!arraysEqual(form.mcp_server_ids, original.mcp_server_ids)) {
    patch.mcp_servers = (form.mcp_server_ids ?? []).map((serverId) => ({ server_id: serverId }))
  }

  for (const field of optionalNumberFields) {
    const currentValue = optionalNumber(form[field])
    const originalValue = optionalNumber(original[field])
    if (!Object.is(currentValue, originalValue)) patch[field] = currentValue
  }

  return patch
}

export function hasCreateChanges(form) {
  return Object.values(form).some((value) => (
    Array.isArray(value) ? value.length > 0 : String(value ?? '').length > 0
  ))
}

export function toggleSelection(values, value) {
  return values.includes(value)
    ? values.filter((currentValue) => currentValue !== value)
    : [...values, value]
}
