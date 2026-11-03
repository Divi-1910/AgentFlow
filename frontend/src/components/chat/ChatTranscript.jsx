import { useAtomValue } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { canResumeRun, isRunActive } from '../../features/chat/chatState'
import { nextBottomFollowPosition } from '../../features/chat/streamPresentation'
import {
	buildLiveExecutionActivities,
	executionSummary,
	formatChatTime,
	friendlyChatError,
	liveExecutionStatus,
	resourceLabel,
	statusLabel,
} from '../../features/chat/chatPresentation'
import { useStreamPresentation } from '../../hooks/useStreamPresentation'
import { chatTranscriptRuntimeAtom } from '../../store/atoms/chatAtoms'
import ChatInlineActivity from './ChatInlineActivity'

const spring = { damping: 31, stiffness: 320, type: 'spring' }
const markdownPlugins = [remarkGfm]
const markdownComponents = {
  a({ children, href }) {
    const external = href?.startsWith('http://') || href?.startsWith('https://')
    return <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>{children}</a>
  },
  img({ alt, src }) {
    return <a href={src}>{alt || 'Linked image'}</a>
  },
  pre({ children }) {
    const codeChild = Array.isArray(children) ? children[0] : children
    const className = codeChild?.props?.className || ''
    const language = className.startsWith('language-') ? className.slice(9) : undefined
    return <pre data-language={language}>{children}</pre>
  },
}

function ConversationTitle({ onRename, resource, thread }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(thread?.title || 'New conversation')

  async function save() {
    if (!thread || !title.trim()) return
    const saved = await onRename(title)
    if (saved) setEditing(false)
  }

  return (
    <div className="chat-conversation-title">
      {editing ? (
        <form onSubmit={(event) => { event.preventDefault(); void save() }}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus aria-label="Conversation title" />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <div><strong>{thread?.title || 'New conversation'}</strong><small>{resource?.name || 'Choose intelligence'} · {resource ? resourceLabel(resource) : 'No resource selected'}</small></div>
          {thread ? (
            <button type="button" className="chat-plain-icon" onClick={() => setEditing(true)} aria-label="Rename conversation">
              <span className="material-symbols-outlined" aria-hidden="true">edit</span>
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

function Message({ message, seamless = false }) {
  const fromUser = message.role === 'user'
  return (
    <motion.article
      className={`chat-message ${fromUser ? 'chat-message--user' : 'chat-message--assistant'}`}
      initial={seamless ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
		<header>
        <strong>{fromUser ? 'You' : 'AgentFlow'}</strong>
        <time dateTime={message.created_at}>{formatChatTime(message.created_at)}</time>
		</header>
		<MessageContent content={message.content} />
      {message.pending ? <small className="chat-message__pending">Synchronizing message…</small> : null}
    </motion.article>
  )
}

function MessageContent({ content }) {
  return (
    <div className="chat-message-content">
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        skipHtml
        components={markdownComponents}
      >
        {String(content || '')}
      </ReactMarkdown>
    </div>
  )
}

function StreamingMessage({ activities, active, partial, status, stream }) {
  return (
    <motion.article
      className={`chat-message chat-message--assistant chat-message--streaming ${partial ? 'chat-message--partial' : ''}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
		<header><strong>{stream.agentName || 'AgentFlow'}</strong><span className="chat-streaming-mark"><i /><span>{partial ? 'Interrupted' : active ? 'Working' : 'Responding'}</span></span></header>
		<ChatInlineActivity activities={activities} active={active} status={status} />
		{stream.content ? <MessageContent content={stream.content} /> : null}
      {partial ? <small className="chat-message__partial">Incomplete response — this text was not saved.</small> : null}
    </motion.article>
  )
}

function EmptyConversation({ onPrompt, resource }) {
  const prompts = resource?.resource_kind === 'agent_team'
    ? ['Describe how this team will approach my request.', 'Plan a task and delegate it across the team.', 'Show me what this team can accomplish.']
    : ['Describe what you can help me accomplish.', 'Plan a concrete first task with me.', 'Explain how you would approach a difficult request.']

  return (
    <div className="chat-empty-conversation">
      <span className="material-symbols-outlined chat-empty-conversation__mark" aria-hidden="true">
        {resource?.resource_kind === 'agent_team' ? 'group_work' : 'smart_toy'}
      </span>
      <h2>{resource ? `Ask ${resource.name}` : 'Choose who should answer'}</h2>
      <p>{resource ? 'Start with a concrete outcome. AgentFlow will surface tools, MCP servers and delegated work only when they participate.' : 'Choose an agent or team from the conversation index to begin.'}</p>
      {resource ? (
        <div className="chat-prompt-starters">
          {prompts.map((prompt) => <button type="button" key={prompt} onClick={() => onPrompt(prompt)}>{prompt}<span className="material-symbols-outlined" aria-hidden="true">north_east</span></button>)}
        </div>
      ) : null}
    </div>
  )
}

function Composer({
  active,
  disabled,
  onCancel,
  onReconnect,
  onResume,
  onRetry,
  onSend,
  reconnectable,
  resource,
  resumable,
  retryable,
  submitting,
}) {
  const [content, setContent] = useState('')
  const textareaRef = useRef(null)

  function submit() {
    if (!content.trim() || disabled || active || submitting) return
    const message = content
    setContent('')
    void onSend(message)
  }

  return (
    <footer className="chat-composer-shell">
      {retryable || reconnectable || resumable ? (
        <div className="chat-recovery-actions">
          {retryable ? <button type="button" onClick={onRetry}>Retry the unsent message</button> : null}
          {reconnectable ? <button type="button" onClick={onReconnect}>Reconnect to the live run</button> : null}
          {resumable ? <button type="button" onClick={onResume}>Resume from checkpoint</button> : null}
        </div>
      ) : null}
      <div className={`chat-composer ${disabled ? 'chat-composer--disabled' : ''}`}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={1}
          placeholder={disabled ? 'Choose an agent or team first' : active ? `${resource?.name || 'AgentFlow'} is working…` : `Message ${resource?.name || 'AgentFlow'}…`}
          disabled={disabled}
          aria-label="Message"
        />
        <span className="chat-composer__hint">Enter to send · Shift + Enter for a new line</span>
        {active ? (
          <button type="button" className="chat-composer__stop" onClick={onCancel} aria-label="Stop run">
            <span aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="chat-composer__send" onClick={submit} disabled={disabled || submitting || !content.trim()} aria-label="Send message">
            <span className="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
          </button>
        )}
      </div>
    </footer>
  )
}

function backgroundJobPresentation(job) {
  if (job.status === 'failed') {
    return { detail: 'The delegated Agent could not complete this task. The conversation is still safe to continue.', label: 'Background task failed', status: 'failed' }
  }
  if (job.status === 'cancelled') {
    return { detail: 'This background task was cancelled safely.', label: 'Background task cancelled', status: 'failed' }
  }
  if (job.callback_status === 'failed') {
    return { detail: 'The work completed, but AgentFlow could not deliver its result into this conversation.', label: 'Result delivery failed', status: 'failed' }
  }
  if (job.callback_status === 'cancelled') {
    return { detail: 'The work completed, but its conversation update was cancelled.', label: 'Result delivery cancelled', status: 'failed' }
  }
  if (job.callback_status === 'completed') {
    return { detail: 'The result was added to this conversation.', label: 'Background task completed', status: 'completed' }
  }
  if (job.status === 'succeeded') {
    return { detail: 'The delegated work is ready and its result is being added here.', label: 'Preparing the result', status: 'running' }
  }
  if (job.status === 'running' || job.status === 'starting') {
    return { detail: 'A delegated Agent is working independently. You can continue using AgentFlow.', label: 'Working in background', status: 'running' }
  }
  return { detail: 'The task is queued and will update this conversation when ready.', label: 'Queued in background', status: 'running' }
}

function BackgroundWork({ jobs = [] }) {
  if (!jobs.length) return null
  return (
    <section className="chat-background-work" aria-label="Background work" aria-live="polite">
      {jobs.map((job) => {
        const presentation = backgroundJobPresentation(job)
        return (
          <article className={`chat-background-work__item chat-background-work__item--${presentation.status}`} key={job.id}>
            <span className="chat-background-work__mark" aria-hidden="true"><i /></span>
            <div>
              <strong>{presentation.label}</strong>
              <p>{job.task || presentation.detail}</p>
              <small>{presentation.detail}</small>
            </div>
          </article>
        )
      })}
    </section>
  )
}

export default function ChatTranscript({
  actionError,
  backgroundJobs = [],
  latestRun,
  messages,
  onCancel,
  onOpenTrace,
  onReconnect,
  onRename,
  onResume,
  onRetry,
  onSend,
  resource,
  retryable,
  submitting,
  thread,
  threadLoading,
  traceOpen,
}) {
  const runtime = useAtomValue(chatTranscriptRuntimeAtom)
  const reduceMotion = useReducedMotion()
  const autoFollowingRef = useRef(false)
  const scrollRef = useRef(null)
  const scrollFrameRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const primaryDraft = runtime.primaryDraft
  const sceneKey = thread?.id || `draft-${resource?.id || 'unselected'}`
  const presentation = useStreamPresentation({
    messages,
    partial: runtime.partial,
    reducedMotion: Boolean(reduceMotion),
    sceneKey,
    stream: primaryDraft,
  })
	const presentedDraft = presentation.stream
	const active = isRunActive(latestRun?.status) || isRunActive(runtime.status)
	const liveActivities = useMemo(
		() => buildLiveExecutionActivities(runtime.events, runtime.rootRunId),
		[runtime.events, runtime.rootRunId],
	)
	const currentActivities = useMemo(
		() => liveActivities.filter((activity) => activity.status === 'running').slice(-1),
		[liveActivities],
	)
	const executionStatus = useMemo(
		() => liveExecutionStatus(runtime.events, active),
		[runtime.events, active],
	)
	const executionRunId = runtime.rootRunId || latestRun?.id || ''
	const workSummary = useMemo(
		() => executionSummary({ events: runtime.events, messages, rootRunId: executionRunId, run: latestRun }),
		[executionRunId, latestRun, messages, runtime.events],
	)
	const visibleError = useMemo(() => {
		if (actionError) return friendlyChatError(actionError)
		if (runtime.error) return friendlyChatError({ errorCode: runtime.errorCode, message: runtime.error })
		return null
	}, [actionError, runtime.error, runtime.errorCode])
  const visibleMessages = useMemo(
    () => messages.filter((message) => (
      (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim()
      && message.id !== presentation.suppressedMessageId
    )),
    [messages, presentation.suppressedMessageId],
  )
	const liveTurn = presentedDraft || (active ? {
		agentName: resource?.name || 'AgentFlow',
		content: '',
		runId: runtime.rootRunId || 'pending',
	} : null)

  useEffect(() => {
    stickToBottomRef.current = true
    const scrollNode = scrollRef.current
    if (!scrollNode) return undefined

    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollNode.scrollTop = scrollNode.scrollHeight
      scrollFrameRef.current = null
    })

    return undefined
  }, [sceneKey, threadLoading])

  useEffect(() => {
    const scrollNode = scrollRef.current
    if (!scrollNode || !stickToBottomRef.current) return undefined
    if (scrollFrameRef.current !== null) return undefined

    if (reduceMotion) {
      scrollNode.scrollTop = scrollNode.scrollHeight
      return undefined
    }

    autoFollowingRef.current = true

    function followBottom() {
      if (!stickToBottomRef.current) {
        autoFollowingRef.current = false
        scrollFrameRef.current = null
        return
      }

      const target = Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight)
      const distance = target - scrollNode.scrollTop
      if (Math.abs(distance) <= 0.75) {
        scrollNode.scrollTop = target
        autoFollowingRef.current = false
        scrollFrameRef.current = null
        return
      }

      scrollNode.scrollTop = nextBottomFollowPosition(scrollNode.scrollTop, target)
      scrollFrameRef.current = window.requestAnimationFrame(followBottom)
    }

    scrollFrameRef.current = window.requestAnimationFrame(followBottom)
    return undefined
		}, [presentedDraft?.content, liveActivities.length, reduceMotion, visibleMessages.length])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
    autoFollowingRef.current = false
  }, [])

  return (
    <motion.main className="chat-transcript" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} layout>
      <header className="chat-transcript__header">
        <ConversationTitle key={thread?.id || resource?.id || 'unselected'} onRename={onRename} resource={resource} thread={thread} />
        <div className="chat-transcript__controls">
          {active ? <span className="chat-run-state"><i />{statusLabel(latestRun?.status || runtime.status)}</span> : null}
          {!traceOpen ? (
            <button type="button" className="chat-trace-toggle" onClick={onOpenTrace} aria-expanded={false}>
              <span className="material-symbols-outlined" aria-hidden="true">route</span>Activity
            </button>
          ) : null}
        </div>
      </header>

      <div
        className="chat-transcript__scroll"
        ref={scrollRef}
        onScroll={(event) => {
          if (autoFollowingRef.current) return
          const node = event.currentTarget
          stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 96
          if (!stickToBottomRef.current && scrollFrameRef.current !== null) {
            window.cancelAnimationFrame(scrollFrameRef.current)
            scrollFrameRef.current = null
          }
        }}
        onTouchStart={() => {
          stickToBottomRef.current = false
          autoFollowingRef.current = false
          if (scrollFrameRef.current !== null) {
            window.cancelAnimationFrame(scrollFrameRef.current)
            scrollFrameRef.current = null
          }
        }}
        onPointerDown={(event) => {
          const node = event.currentTarget
          const scrollbarEdge = node.getBoundingClientRect().right - 18
          if (event.clientX < scrollbarEdge) return

          stickToBottomRef.current = false
          autoFollowingRef.current = false
          if (scrollFrameRef.current !== null) {
            window.cancelAnimationFrame(scrollFrameRef.current)
            scrollFrameRef.current = null
          }
        }}
        onWheel={(event) => {
          if (event.deltaY >= 0) return

          stickToBottomRef.current = false
          autoFollowingRef.current = false
          if (scrollFrameRef.current !== null) {
            window.cancelAnimationFrame(scrollFrameRef.current)
            scrollFrameRef.current = null
          }
        }}
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            className="chat-transcript__content"
            key={sceneKey}
            initial={reduceMotion ? false : { opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: -14 }}
            transition={spring}
          >
            {threadLoading ? (
              <div className="chat-message-skeleton" role="status" aria-label="Loading conversation"><span /><span /><span /></div>
            ) : null}
            {!threadLoading && visibleMessages.length === 0 && !primaryDraft && !active ? <EmptyConversation resource={resource} onPrompt={onSend} /> : null}
			{!threadLoading ? visibleMessages.map((message) => (
				<Message
					key={message.id}
                message={message}
                seamless={message.id === presentation.handoffMessageId}
              />
            )) : null}
			<AnimatePresence initial={false}>
				{!threadLoading && liveTurn ? (
					<StreamingMessage
						activities={currentActivities}
						active={active}
						key={liveTurn.runId}
						partial={Boolean(presentedDraft?.partial)}
						status={executionStatus}
						stream={liveTurn}
					/>
				) : null}
            </AnimatePresence>
			{!threadLoading && !liveTurn ? <BackgroundWork jobs={backgroundJobs} /> : null}
			{!threadLoading && !liveTurn && workSummary ? (
				<button type="button" className="chat-work-summary" onClick={onOpenTrace} aria-label="Open complete activity">
					<span className="material-symbols-outlined" aria-hidden="true">schedule</span>
					<strong>{workSummary.label}</strong>
					<span>{workSummary.stepCount} {workSummary.stepCount === 1 ? 'step' : 'steps'}</span>
					<span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
				</button>
			) : null}
            {visibleError ? (
              <div className="chat-inline-error" role="alert">
                <span className="material-symbols-outlined" aria-hidden="true">error</span>
                <div><strong>{visibleError.title}</strong><p>{visibleError.detail}</p></div>
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <Composer
        active={active}
        disabled={!resource}
        onCancel={onCancel}
        onReconnect={onReconnect}
        onResume={onResume}
        onRetry={onRetry}
        onSend={onSend}
        reconnectable={runtime.connection === 'interrupted' && Boolean(latestRun?.id) && active}
        resource={resource}
        resumable={canResumeRun(latestRun) && !active}
        retryable={retryable}
        submitting={submitting}
      />
    </motion.main>
  )
}
