export function formatChatTime(value, options = {}) {
  if (!value) return 'Now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, {
    day: options.includeDate ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
    month: options.includeDate ? 'short' : undefined,
  }).format(date)
}

export function resourceLabel(resource) {
  return resource?.resource_kind === 'agent_team' ? 'Agent team' : 'Agent'
}

export function statusLabel(status) {
  return (status || 'idle').replaceAll('_', ' ')
}

export function tracePresentation(event) {
	const toolName = toolEventPresentation(event).title
	const agentName = event.agent_name || 'Agent'
  const presentations = {
    'run.accepted': ['Run accepted', 'The request is durable and ready to execute.', 'radio_button_checked'],
    'run.started': [`${agentName} started`, 'Execution is now active.', 'play_arrow'],
    'run.resumed': [`${agentName} resumed`, `Attempt ${event.attempt || 1} is active.`, 'resume'],
    'run.waiting': ['Waiting for background work', 'The run will continue when its jobs report back.', 'schedule'],
    'run.persisted': ['Response saved', 'The conversation history is synchronized.', 'cloud_done'],
    'run.persist_failed': ['Response was not saved', event.error?.message || 'The run finished without durable message storage.', 'cloud_off'],
    'run.completed': [`${agentName} completed`, event.duration_ms ? `${event.duration_ms} ms` : 'Execution finished.', 'check_circle'],
    'run.failed': [`${agentName} stopped`, event.error?.message || 'Execution could not complete.', 'error'],
    'run.cancelled': ['Run cancelled', 'Execution stopped safely.', 'cancel'],
    'step.started': [`Reasoning step ${event.step || ''}`.trim(), event.max_steps ? `Step ${event.step} of ${event.max_steps}` : 'Model work started.', 'progress_activity'],
		'step.completed': [`Step ${event.step || ''} completed`.trim(), event.duration_ms ? `${event.duration_ms} ms` : 'Model work finished.', 'done'],
		'status.updated': [statusPresentation(event.status), 'Live execution status', 'progress_activity'],
    'model.completed': ['Model response completed', [event.provider, event.model].filter(Boolean).join(' · ') || 'The provider finished streaming.', 'neurology'],
		'tool.started': [toolName, toolDetail(event), 'build'],
		'tool.completed': [toolName, toolDetail(event), 'check'],
		'tool.failed': [toolName, event.error?.message || toolDetail(event), 'warning'],
    'job.dispatched': ['Background job dispatched', jobDetail(event), 'outbound'],
    'job.started': ['Background job started', jobDetail(event), 'hourglass_top'],
    'job.completed': ['Background job completed', jobDetail(event), 'task_alt'],
    'job.failed': ['Background job failed', event.error?.message || jobDetail(event), 'error'],
    'mcp.unavailable': ['MCP server unavailable', mcpDetail(event), 'link_off'],
    'stream.reset': ['Live history refreshed', 'The retained event window changed; durable state was reloaded.', 'sync'],
  }
  const [title, detail, icon] = presentations[event.type] || [
    statusLabel(event.type),
    event.error?.message || 'Execution state updated.',
    'more_horiz',
  ]
  return { detail, icon, title }
}

function toolDetail(event) {
	const projected = event.tool?.presentation?.summary
	if (projected) return projected
  if (event.tool?.kind === 'delegate') {
    return event.tool.target_agent_id ? `Delegating to ${event.tool.target_agent_id}` : 'Delegating to another agent'
  }
  if (event.tool?.kind === 'mcp') {
    return event.tool.mcp_alias || event.tool.mcp_server_id || 'MCP operation'
  }
  return ''
}

const terminalRunTypes = new Set(['run.completed', 'run.failed', 'run.cancelled'])

export function toolEventPresentation(event) {
	const tool = event?.tool || {}
	const projection = tool.presentation || {}
	const labels = fallbackToolLabels(tool)
	const reportedError = event?.type === 'tool.failed'
		|| /^error\b/i.test(tool.display || '')
		|| /unavailable/i.test(tool.display || '')
	const status = reportedError
		? 'failed'
		: event?.type === 'tool.completed' ? 'completed' : 'running'
	const title = status === 'failed'
		? projection.failed_label || labels.failed
		: status === 'completed'
			? projection.completed_label || labels.completed
			: projection.running_label || labels.running

	return {
		detail: projection.summary || toolDetailFallback(tool),
		input: normalizePresentationFields(projection.input),
		output: normalizePresentationFields(projection.output),
		status,
		title,
	}
}

export function buildLiveExecutionActivities(events, rootRunId) {
	const activities = []
	const positions = new Map()

	function upsert(key, next) {
		const position = positions.get(key)
		if (position === undefined) {
			positions.set(key, activities.length)
			activities.push(next)
			return
		}
		activities[position] = { ...activities[position], ...next }
	}

	for (const event of events || []) {
		if (event.originator_run_id && rootRunId && event.originator_run_id !== rootRunId) continue
		if (event.type?.startsWith('tool.') && event.tool) {
			const presentation = toolEventPresentation(event)
			const key = `tool:${event.run_id || rootRunId}:${event.tool.id || event.tool.name}:${event.attempt || 1}`
			upsert(key, {
				agentName: event.agent_name || (event.depth ? 'Delegated agent' : 'AgentFlow'),
				depth: event.depth || 0,
				detail: presentation.detail,
				icon: toolActivityIcon(event.tool.kind),
				id: key,
				input: presentation.input,
				output: presentation.output,
				status: presentation.status,
				time: event.time,
				title: presentation.title,
				type: 'tool',
			})
			continue
		}

		if (event.type?.startsWith('job.') && event.job) {
			const key = `job:${event.job.id || event.stream_id}`
			const presentation = tracePresentation(event)
			upsert(key, {
				agentName: event.agent_name || 'AgentFlow',
				depth: event.depth || 0,
				detail: presentation.detail,
				icon: presentation.icon,
				id: key,
				input: [],
				output: [],
				status: event.type === 'job.failed' ? 'failed' : event.type === 'job.completed' ? 'completed' : 'running',
				time: event.time,
				title: presentation.title,
				type: 'job',
			})
			continue
		}

		if ((event.depth || 0) > 0 && (event.type === 'run.started' || event.type === 'run.resumed' || terminalRunTypes.has(event.type))) {
			const key = `agent:${event.run_id}:${event.attempt || 1}`
			const presentation = tracePresentation(event)
			upsert(key, {
				agentName: event.agent_name || 'Delegated agent',
				depth: event.depth || 0,
				detail: presentation.detail,
				icon: 'hub',
				id: key,
				input: [],
				output: [],
				status: event.type === 'run.failed' || event.type === 'run.cancelled' ? 'failed' : event.type === 'run.completed' ? 'completed' : 'running',
				time: event.time,
				title: presentation.title,
				type: 'agent',
			})
			continue
		}

		if (event.type === 'mcp.unavailable') {
			const presentation = tracePresentation(event)
			activities.push({
				agentName: event.agent_name || 'AgentFlow',
				depth: event.depth || 0,
				detail: presentation.detail,
				icon: presentation.icon,
				id: event.stream_id || event.id,
				input: [],
				output: [],
				status: 'failed',
				time: event.time,
				title: presentation.title,
				type: 'notice',
			})
		}
	}

	return activities.slice(-16)
}

export function buildExecutionTimeline({ events = [], messages = [], rootRunId = '', streams = {} } = {}) {
	const live = buildLiveExecutionTimeline(events, rootRunId)
	const durable = buildDurableExecutionTimeline(messages, rootRunId)
	if (live.length === 0) return durable

	const durableModels = durable.filter((item) => item.type === 'model')
	const durableTools = durable.filter((item) => item.type === 'tool')
	const currentRequest = latestUserRequest(messagesForRun(messages, rootRunId))
	const matchedModels = new Set()
	const matchedTools = new Set()

	const enriched = live.map((item) => {
		if (item.type === 'model') {
			let persistedIndex = durableModels.findIndex((model, index) => (
				!matchedModels.has(index)
				&& model.runId
				&& item.runId
				&& model.runId === item.runId
				&& model.step === item.step
			))
			if (persistedIndex < 0 && (!item.runId || item.runId === rootRunId)) {
				persistedIndex = durableModels.findIndex((_, index) => !matchedModels.has(index))
			}
			if (persistedIndex >= 0) matchedModels.add(persistedIndex)
			const persisted = persistedIndex >= 0 ? durableModels[persistedIndex] : null
			const streamedOutput = streams[item.runId]?.content
			return {
				...item,
				input: persisted?.input?.length
					? persisted.input
					: item.input?.length ? item.input
						: currentRequest && (!item.runId || item.runId === rootRunId)
							? [{ format: 'text', label: 'Request', value: boundedValue(currentRequest) }]
							: [],
				output: persisted?.output?.length
					? persisted.output
					: streamedOutput ? [{ format: 'text', label: 'Response', value: boundedValue(streamedOutput) }] : item.output,
			}
		}

		if (item.type === 'tool') {
			const persistedIndex = durableTools.findIndex((tool, index) => (
				!matchedTools.has(index)
				&& (
					(item.callId && tool.callId === item.callId)
					|| (!item.callId && item.name && tool.name === item.name && tool.step === item.step)
				)
			))
			if (persistedIndex < 0) return item
			matchedTools.add(persistedIndex)
			const persisted = durableTools[persistedIndex]
			return {
				...item,
				input: item.input?.length ? item.input : persisted.input,
				output: item.output?.length ? item.output : persisted.output,
			}
		}

		return item
	})

	const durableExtras = [
		...durableModels.filter((_, index) => !matchedModels.has(index)),
		...durableTools.filter((_, index) => !matchedTools.has(index)),
	]
	return sortTimeline([...enriched, ...durableExtras])
}

export function executionSummary({ events = [], messages = [], rootRunId = '', run = null } = {}) {
	const timeline = buildExecutionTimeline({ events, messages, rootRunId })
	const actionCount = timeline.filter((item) => item.type !== 'model').length
	const modelStepCount = timeline.filter((item) => item.type === 'model').length
	const terminal = [...events].reverse().find((event) => (
		['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)
		&& (!rootRunId || event.run_id === rootRunId)
	))
	let durationMs = Number(terminal?.duration_ms) || 0
	if (!durationMs && run?.created_at && run?.updated_at) {
		durationMs = Math.max(0, new Date(run.updated_at).getTime() - new Date(run.created_at).getTime())
	}
	if (!durationMs && actionCount === 0 && modelStepCount === 0) return null

	return {
		actionCount,
		durationMs,
		label: durationMs ? `Worked for ${formatExecutionDuration(durationMs)}` : 'Work completed',
		stepCount: timeline.length,
	}
}

export function formatExecutionDuration(durationMs) {
	const seconds = Math.max(1, Math.round(Number(durationMs || 0) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainder = seconds % 60
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function buildLiveExecutionTimeline(events, rootRunId) {
	const items = []
	const positions = new Map()

	function upsert(key, next) {
		const position = positions.get(key)
		if (position === undefined) {
			positions.set(key, items.length)
			items.push(next)
			return
		}
		items[position] = { ...items[position], ...next }
	}

	for (const event of events || []) {
		if (event.originator_run_id && rootRunId && event.originator_run_id !== rootRunId) continue
		if (event.type === 'step.started' || event.type === 'model.completed') {
			const key = `model:${event.run_id || rootRunId}:${event.step || 1}:${event.attempt || 1}`
			const usage = event.usage || {}
			upsert(key, {
				agentName: event.agent_name || (event.depth ? 'Delegated agent' : 'AgentFlow'),
				depth: event.depth || 0,
				detail: [event.provider, event.model].filter(Boolean).join(' · '),
				durationMs: event.duration_ms || 0,
				icon: 'neurology',
				id: key,
				input: [],
				model: event.model || '',
				output: [],
				provider: event.provider || '',
				runId: event.run_id || rootRunId,
				status: event.type === 'model.completed' ? 'completed' : 'running',
				step: event.step || 1,
				time: event.time,
				title: `Model step ${event.step || 1}`,
				type: 'model',
				usage,
			})
			continue
		}

		if (event.type?.startsWith('tool.') && event.tool) {
			const presentation = toolEventPresentation(event)
			const key = `tool:${event.run_id || rootRunId}:${event.tool.id || event.tool.name}:${event.attempt || 1}`
			upsert(key, {
				agentName: event.agent_name || (event.depth ? 'Delegated agent' : 'AgentFlow'),
				callId: event.tool.id || '',
				depth: event.depth || 0,
				detail: presentation.detail,
				durationMs: event.duration_ms || 0,
				icon: toolActivityIcon(event.tool.kind),
				id: key,
				input: presentation.input,
				name: event.tool.name || '',
				output: presentation.output,
				runId: event.run_id || rootRunId,
				status: presentation.status,
				step: event.step || 0,
				time: event.time,
				title: presentation.title,
				type: 'tool',
			})
			continue
		}

		if (event.type?.startsWith('job.') && event.job) {
			const presentation = tracePresentation(event)
			const key = `job:${event.job.id || event.stream_id}`
			upsert(key, {
				agentName: event.agent_name || 'AgentFlow',
				depth: event.depth || 0,
				detail: presentation.detail,
				durationMs: event.duration_ms || 0,
				icon: presentation.icon,
				id: key,
				input: event.job.target_agent_id ? [{ label: 'Target agent', value: event.job.target_agent_id }] : [],
				output: event.job.status ? [{ label: 'Status', value: statusLabel(event.job.status) }] : [],
				status: event.type === 'job.failed' ? 'failed' : event.type === 'job.completed' ? 'completed' : 'running',
				time: event.time,
				title: presentation.title,
				type: 'job',
			})
			continue
		}

		if ((event.depth || 0) > 0 && (event.type === 'run.started' || event.type === 'run.resumed' || terminalRunTypes.has(event.type))) {
			const presentation = tracePresentation(event)
			const key = `agent:${event.run_id}:${event.attempt || 1}`
			upsert(key, {
				agentName: event.agent_name || 'Delegated agent',
				depth: event.depth || 0,
				detail: presentation.detail,
				durationMs: event.duration_ms || 0,
				icon: 'hub',
				id: key,
				input: [],
				output: event.content ? [{ format: 'text', label: 'Response', value: boundedValue(event.content) }] : [],
				status: event.type === 'run.failed' || event.type === 'run.cancelled' ? 'failed' : terminalRunTypes.has(event.type) ? 'completed' : 'running',
				time: event.time,
				title: presentation.title,
				type: 'agent',
			})
			continue
		}

		if (event.type === 'mcp.unavailable') {
			const presentation = tracePresentation(event)
			items.push({
				agentName: event.agent_name || 'AgentFlow',
				depth: event.depth || 0,
				detail: presentation.detail,
				durationMs: event.duration_ms || 0,
				icon: presentation.icon,
				id: event.stream_id || event.id,
				input: [],
				output: [],
				status: 'failed',
				time: event.time,
				title: presentation.title,
				type: 'notice',
			})
		}
	}

	return items.slice(-80)
}

function buildDurableExecutionTimeline(messages, rootRunId) {
	const items = []
	const calls = new Map()
	let request = ''
	let modelStep = 0
	let priorToolResults = []
	const scopedMessages = messagesForRun(messages, rootRunId)

	for (const message of scopedMessages) {
		if (message.role === 'user' && String(message.content || '').trim()) {
			request = String(message.content).trim()
			priorToolResults = []
			continue
		}

		if (message.role === 'assistant' && (String(message.content || '').trim() || message.tool_calls?.length)) {
			modelStep += 1
			const input = []
			if (modelStep === 1 && request) input.push({ format: 'text', label: 'Request', value: boundedValue(request) })
			if (priorToolResults.length) {
				input.push({ format: 'json', label: 'Tool results available', value: boundedValue(priorToolResults) })
			}
			const output = []
			if (message.tool_calls?.length) {
				output.push({
					format: 'text',
					label: 'Selected tools',
					value: message.tool_calls.map((call) => humanize(call.name)).join(', '),
				})
			}
			if (String(message.content || '').trim()) {
				output.push({ format: 'text', label: 'Response', value: boundedValue(message.content) })
			}
			items.push({
				agentName: 'AgentFlow',
				depth: 0,
				detail: '',
				durationMs: Number(message.metadata?.duration_ms) || 0,
				icon: 'neurology',
				id: `durable-model:${message.id || modelStep}`,
				input,
				output,
				runId: message.run_id || message.metadata?.run_id || '',
				status: 'completed',
				step: modelStep,
				time: message.created_at,
				title: `Model step ${modelStep}`,
				type: 'model',
				usage: {},
			})
			for (const call of message.tool_calls || []) {
				calls.set(call.id, { call, modelStep })
			}
			priorToolResults = []
			continue
		}

		if (message.role === 'tool') {
			const call = calls.get(message.tool_call_id)?.call
			const persisted = normalizePersistedProjection(message.metadata?.presentation)
			const projection = persisted || legacyToolProjection(message.tool_name || call?.name, message.metadata?.arguments || call?.arguments)
			const failed = Boolean(message.metadata?.is_error)
			const toolName = message.tool_name || call?.name || 'tool'
			const labels = fallbackToolLabels({ kind: toolKindFromName(toolName), name: toolName, operation: toolName })
			const safeOutput = projection.output?.length
				? projection.output
				: [{ format: 'text', label: 'Result', value: 'Detailed output is unavailable for this earlier execution.' }]
			const item = {
				agentName: 'AgentFlow',
				callId: message.tool_call_id || call?.id || '',
				depth: 0,
				detail: projection.summary,
				durationMs: Number(message.metadata?.latency_ms) || 0,
				icon: toolActivityIcon(toolKindFromName(toolName)),
				id: `durable-tool:${message.id || message.tool_call_id}`,
				input: projection.input,
				name: toolName,
				output: safeOutput,
				status: failed ? 'failed' : 'completed',
				step: calls.get(message.tool_call_id)?.modelStep || modelStep,
				time: message.created_at,
				title: failed ? projection.failed_label || labels.failed : projection.completed_label || labels.completed,
				type: 'tool',
			}
			items.push(item)
			priorToolResults.push({
				output: safeOutput.map((field) => ({ label: field.label, value: field.value })),
				tool: toolName,
			})
		}
	}

	return items
}

function messageRunId(message) {
	return message?.run_id || message?.metadata?.run_id || ''
}

function messagesForRun(messages, rootRunId) {
	const allMessages = messages || []
	if (!rootRunId) return allMessages
	const matchingMessages = allMessages.filter((message) => messageRunId(message) === rootRunId)
	if (matchingMessages.length) return matchingMessages

	let lastPersistedRunIndex = -1
	for (let index = 0; index < allMessages.length; index += 1) {
		if (messageRunId(allMessages[index])) lastPersistedRunIndex = index
	}
	if (lastPersistedRunIndex < 0) return allMessages
	return allMessages.slice(lastPersistedRunIndex + 1).filter((message) => !messageRunId(message))
}

function latestUserRequest(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message.role === 'user' && String(message.content || '').trim()) return String(message.content).trim()
	}
	return ''
}

function sortTimeline(items) {
	return items
		.map((item, index) => {
			const parsedTime = item.time ? new Date(item.time).getTime() : Number.NaN
			return { index, item, time: Number.isNaN(parsedTime) ? Number.MAX_SAFE_INTEGER : parsedTime }
		})
		.sort((left, right) => {
			if (left.time === right.time) return left.index - right.index
			return left.time - right.time
		})
		.map(({ item }) => item)
}

export function liveExecutionStatus(events, active) {
	if (!active) return ''
	const activities = buildLiveExecutionActivities(events)
	const running = [...activities].reverse().find((activity) => activity.status === 'running')
	if (running) return running.title
	const latestStatus = [...(events || [])].reverse().find((event) => event.type === 'status.updated')
	return latestStatus ? statusPresentation(latestStatus.status) : 'Thinking'
}

function statusPresentation(status) {
	if (!status || status === 'Calling model') return 'Thinking'
	if (status.startsWith('Using ')) return `Using ${humanize(status.slice(6))}`
	if (status.includes('durability degraded')) return 'Saving progress is temporarily degraded'
	return status
}

function fallbackToolLabels(tool = {}) {
	const name = tool.name || ''
	const operation = tool.operation || name.replace(/^(memory_|scratchpad_)/, '')
	const labels = {
		await_job: ['Waiting for delegated work', 'Received delegated work', 'Delegated work did not complete'],
		calculator: ['Calculating', 'Calculated the result', 'Could not calculate the result'],
		dispatch_agent: ['Dispatching agent work', 'Dispatched agent work', 'Could not dispatch agent work'],
		http_request: ['Contacting an external service', 'Contacted an external service', 'Could not contact the external service'],
		memory_history: ['Reviewing memory history', 'Reviewed memory history', 'Could not review memory history'],
		memory_patch: ['Editing a memory', 'Edited a memory', 'Could not edit the memory'],
		memory_read: ['Reading from memory', 'Read from memory', 'Could not read from memory'],
		memory_restore: ['Restoring a memory', 'Restored a memory', 'Could not restore the memory'],
		memory_retire: ['Retiring a memory', 'Retired a memory', 'Could not retire the memory'],
		memory_search: ['Searching memory', 'Searched memory', 'Could not search memory'],
		memory_update: ['Updating a memory', 'Updated a memory', 'Could not update the memory'],
		memory_write: ['Saving this to memory', 'Saved this to memory', 'Could not save this to memory'],
		scratchpad_append_section: ['Adding findings to the workspace', 'Added findings to the workspace', 'Could not add findings to the workspace'],
		scratchpad_create: ['Creating a shared workspace', 'Created a shared workspace', 'Could not create the shared workspace'],
		scratchpad_get_sections: ['Reviewing workspace sections', 'Reviewed workspace sections', 'Could not review workspace sections'],
		scratchpad_list: ['Checking the shared workspace', 'Checked the shared workspace', 'Could not check the shared workspace'],
		scratchpad_read_section: ['Reading the shared workspace', 'Read the shared workspace', 'Could not read the shared workspace'],
		scratchpad_replace_section: ['Updating the shared workspace', 'Updated the shared workspace', 'Could not update the shared workspace'],
		scratchpad_search: ['Searching the shared workspace', 'Searched the shared workspace', 'Could not search the shared workspace'],
		web_search: ['Searching the web', 'Searched the web', 'Could not search the web'],
	}
	if (labels[name]) {
		return { running: labels[name][0], completed: labels[name][1], failed: labels[name][2] }
	}
	if (tool.kind === 'delegate') {
		const target = tool.target_agent_id || 'another agent'
		return { running: `Asking ${target} for help`, completed: `Received work from ${target}`, failed: 'Could not complete delegated work' }
	}
	if (tool.kind === 'mcp' || name.startsWith('mcp__')) {
		const parts = name.replace(/^mcp__/, '').split('__')
		const server = tool.mcp_alias || parts[0] || 'MCP'
		const action = humanize(tool.operation || parts[1] || 'capability').toLowerCase()
		return { running: `Using ${server} to ${action}`, completed: `Used ${server} to ${action}`, failed: `${server} could not ${action}` }
	}
	const readable = humanize(operation || name || 'tool')
	return { running: `Using ${readable}`, completed: `Used ${readable}`, failed: `Could not use ${readable}` }
}

function legacyToolProjection(name = '', rawArguments) {
	const kind = toolKindFromName(name)
	const operation = name.replace(/^(memory_|scratchpad_)/, '')
	const labels = fallbackToolLabels({ kind, name, operation })
	const args = parseArguments(rawArguments)
	const safeKeys = name === 'http_request'
		? ['method', 'url']
		: name.startsWith('mcp__') ? [] : Object.keys(args).sort()
	const input = safeKeys.map((key) => ({
		format: typeof args[key] === 'object' ? 'json' : 'text',
		label: humanize(key),
		value: boundedValue(redactClientValue(key, args[key])),
	})).filter((field) => field.value)
	const summaryKey = name === 'web_search' ? 'query'
		: name === 'calculator' ? 'expression'
			: name === 'memory_search' ? 'pattern' : ''
	return {
		completed_label: labels.completed,
		failed_label: labels.failed,
		input,
		output: [],
		running_label: labels.running,
		summary: summaryKey ? String(args[summaryKey] || '') : '',
	}
}

function normalizePersistedProjection(value) {
	if (!value || typeof value !== 'object') return null
	return {
		completed_label: value.completed_label || 'Capability completed',
		failed_label: value.failed_label || 'Capability failed',
		input: normalizePresentationFields(value.input),
		output: normalizePresentationFields(value.output),
		running_label: value.running_label || 'Using capability',
		summary: value.summary || '',
	}
}

function normalizePresentationFields(fields) {
	if (!Array.isArray(fields)) return []
	return fields
		.filter((field) => field && field.value !== undefined && field.value !== null)
		.map((field) => ({ format: field.format || 'text', label: field.label || 'Detail', value: boundedValue(field.value) }))
}

function parseArguments(value) {
	if (!value) return {}
	if (typeof value === 'object') return value
	try {
		const parsed = JSON.parse(value)
		return parsed && typeof parsed === 'object' ? parsed : {}
	} catch {
		return {}
	}
}

function redactClientValue(key, value) {
	const sensitive = ['authorization', 'api_key', 'apikey', 'token', 'secret', 'password', 'cookie', 'credential']
	if (sensitive.some((part) => key.toLowerCase().includes(part))) return '[redacted]'
	if (Array.isArray(value)) return value.map((item) => redactClientValue('', item))
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactClientValue(childKey, childValue)]))
	}
	return value
}

function boundedValue(value) {
	const rendered = typeof value === 'string' ? value : JSON.stringify(value)
	if (!rendered) return ''
	return rendered.length > 4000 ? `${rendered.slice(0, 4000)}\n… (truncated)` : rendered
}

function toolKindFromName(name = '') {
	if (name.startsWith('memory_')) return 'memory'
	if (name.startsWith('scratchpad_')) return 'scratchpad'
	if (name.startsWith('mcp__')) return 'mcp'
	if (name === 'dispatch_agent' || name === 'await_job') return 'async'
	return 'regular'
}

function toolActivityIcon(kind) {
	return {
		async: 'schedule',
		delegate: 'account_tree',
		mcp: 'extension',
		memory: 'database',
		scratchpad: 'description',
	}[kind] || 'build'
}

function toolDetailFallback(tool) {
	if (tool.kind === 'delegate') return tool.target_agent_id ? `Delegating to ${tool.target_agent_id}` : 'Delegating to another agent'
	if (tool.kind === 'mcp') return tool.mcp_alias || tool.mcp_server_id || 'MCP operation'
	return ''
}

function humanize(value) {
	return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function jobDetail(event) {
  const parts = [event.job?.mode, event.job?.status]
  return parts.filter(Boolean).map(statusLabel).join(' · ') || 'Asynchronous delegated work'
}

function mcpDetail(event) {
  const servers = event.mcp?.unavailable || []
  if (servers.length === 0) return 'The selected MCP capability could not be reached.'
  return servers.map((server) => server.alias || server.server_id).join(', ')
}
