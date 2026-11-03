import { describe, expect, it } from 'vitest'
import {
	buildExecutionTimeline,
	buildLiveExecutionActivities,
	executionSummary,
	friendlyChatError,
	toolEventPresentation,
} from './chatPresentation'

describe('chat execution presentation', () => {
	it('uses one live activity while a tool moves from started to completed', () => {
		const events = [
			{
				originator_run_id: 'root', run_id: 'root', stream_id: 'root:1', type: 'tool.started',
				tool: {
					id: 'call-1', kind: 'memory', name: 'memory_write', operation: 'write',
					presentation: {
						running_label: 'Saving this to memory', completed_label: 'Saved this to memory',
						input: [{ label: 'Content', value: 'Prefers concise answers' }],
					},
				},
			},
			{
				originator_run_id: 'root', run_id: 'root', stream_id: 'root:2', type: 'tool.completed',
				tool: {
					id: 'call-1', kind: 'memory', name: 'memory_write', operation: 'write',
					presentation: {
						running_label: 'Saving this to memory', completed_label: 'Saved this to memory',
						input: [{ label: 'Content', value: 'Prefers concise answers' }],
						output: [{ label: 'Result', value: 'Saved' }],
					},
				},
			},
		]

		const activities = buildLiveExecutionActivities(events, 'root')
		expect(activities).toHaveLength(1)
		expect(activities[0]).toMatchObject({ status: 'completed', title: 'Saved this to memory' })
		expect(activities[0].input[0].value).toBe('Prefers concise answers')
		expect(activities[0].output[0].value).toBe('Saved')
	})

	it('provides deliberate fallback copy for known capabilities', () => {
		expect(toolEventPresentation({
			type: 'tool.started', tool: { kind: 'memory', name: 'memory_search', operation: 'search' },
		}).title).toBe('Searching memory')
		expect(toolEventPresentation({
			type: 'tool.completed', tool: { kind: 'regular', name: 'calculator', operation: 'calculator' },
		}).title).toBe('Calculated the result')
		expect(toolEventPresentation({
			type: 'tool.completed', tool: { kind: 'regular', name: 'custom_tool', operation: 'custom_tool' },
		}).detail).toBe('')
	})

	it('reconstructs model and tool input/output as one durable timeline', () => {
		const messages = [
			{ id: 'user', role: 'user', run_id: 'run-1', content: 'Remember that I prefer concise answers.' },
			{
				id: 'model-tools', role: 'assistant', run_id: 'run-1', content: '',
				tool_calls: [{ id: 'call-1', name: 'memory_write', arguments: { content: 'Prefers concise answers' } }],
			},
			{
				id: 'tool', role: 'tool', run_id: 'run-1', tool_call_id: 'call-1', tool_name: 'memory_write', content: 'saved',
				metadata: {
					presentation: {
						completed_label: 'Saved this to memory', input: [{ label: 'Content', value: 'Prefers concise answers' }],
						output: [{ label: 'Result', value: 'saved' }],
					},
				},
			},
			{ id: 'final', role: 'assistant', run_id: 'run-1', content: 'I will remember that.' },
		]

		const timeline = buildExecutionTimeline({ messages })
		expect(timeline.map((item) => item.type)).toEqual(['model', 'tool', 'model'])
		expect(timeline[0].input[0].value).toContain('Remember that')
		expect(timeline[1].input[0].value).toBe('Prefers concise answers')
		expect(timeline[1].output[0].value).toBe('saved')
		expect(timeline[2].output[0].value).toBe('I will remember that.')
	})

	it('summarizes completed work without exposing the inline trail', () => {
		const summary = executionSummary({
			events: [{ type: 'run.completed', run_id: 'run-1', duration_ms: 8200 }],
			messages: [
				{ id: 'user', role: 'user', run_id: 'run-1', content: 'Hello' },
				{ id: 'final', role: 'assistant', run_id: 'run-1', content: 'Hi' },
			],
			rootRunId: 'run-1',
		})

		expect(summary).toMatchObject({ durationMs: 8200, label: 'Worked for 8s', stepCount: 1 })
	})

	it('limits a reopened activity timeline to the selected run', () => {
		const messages = [
			{ id: 'old-user', role: 'user', run_id: 'run-old', content: 'Old request' },
			{ id: 'old-final', role: 'assistant', run_id: 'run-old', content: 'Old response' },
			{ id: 'new-user', role: 'user', run_id: 'run-new', content: 'New request' },
			{ id: 'new-final', role: 'assistant', run_id: 'run-new', content: 'New response' },
		]

		const timeline = buildExecutionTimeline({ messages, rootRunId: 'run-new' })
		expect(timeline).toHaveLength(1)
		expect(timeline[0].input[0].value).toBe('New request')
		expect(timeline[0].output[0].value).toBe('New response')
	})

	it('does not blend older runs into a newly accepted live run', () => {
		const timeline = buildExecutionTimeline({
			events: [{ type: 'step.started', run_id: 'run-new', originator_run_id: 'run-new', step: 1 }],
			messages: [
				{ id: 'old-user', role: 'user', run_id: 'run-old', content: 'Old request' },
				{ id: 'old-final', role: 'assistant', run_id: 'run-old', content: 'Old response' },
				{ id: 'optimistic-user', role: 'user', content: 'New request' },
			],
			rootRunId: 'run-new',
		})

		expect(timeline).toHaveLength(1)
		expect(timeline[0]).toMatchObject({ runId: 'run-new', type: 'model' })
		expect(timeline[0].input[0].value).toBe('New request')
		expect(timeline.some((item) => item.output?.some((field) => field.value === 'Old response'))).toBe(false)
	})

	it('does not expose raw legacy tool results when no curated projection exists', () => {
		const timeline = buildExecutionTimeline({
			messages: [
				{
					id: 'model-tools', role: 'assistant', run_id: 'run-1', content: '',
					tool_calls: [{ id: 'call-1', name: 'custom_tool', arguments: { token: 'secret-token' } }],
				},
				{
					id: 'legacy-result', role: 'tool', run_id: 'run-1', tool_call_id: 'call-1',
					tool_name: 'custom_tool', content: 'private raw response',
				},
			],
			rootRunId: 'run-1',
		})

		const tool = timeline.find((item) => item.type === 'tool')
		expect(tool.input[0].value).toBe('[redacted]')
		expect(tool.output[0].value).toContain('unavailable')
		expect(tool.output[0].value).not.toContain('private raw response')
	})

	it('turns provider and MCP failure codes into actionable product language', () => {
		expect(friendlyChatError({ code: 'provider.unavailable' })).toEqual(expect.objectContaining({
			title: 'Model provider unavailable',
		}))
		expect(friendlyChatError({ code: 'provider.stream_interrupted' }).detail).toContain('visible text is partial')
		expect(friendlyChatError({ code: 'mcp.unavailable' }).detail).toContain('instead of crashing')
	})
})
