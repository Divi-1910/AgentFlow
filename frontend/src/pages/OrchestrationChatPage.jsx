import { useAtom } from 'jotai'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useState } from 'react'
import ChatConversationIndex from '../components/chat/ChatConversationIndex'
import ChatExecutionTrace from '../components/chat/ChatExecutionTrace'
import ChatTranscript from '../components/chat/ChatTranscript'
import { useChatWorkspace } from '../hooks/useChatWorkspace'
import { chatTraceOpenAtom } from '../store/atoms/chatAtoms'
import '../features/chat/chatWorkspace.css'

function ChatLoading() {
  return (
    <section className="chat-workspace chat-workspace--loading" aria-label="Loading Chat" role="status">
      <div className="chat-loading-index"><span /><span /><span /><span /></div>
      <div className="chat-loading-transcript"><span /><span /><span /></div>
    </section>
  )
}

function ChatError({ error }) {
  return (
    <section className="chat-workspace-state" role="alert">
      <span className="material-symbols-outlined" aria-hidden="true">cloud_off</span>
      <h1>Chat could not be loaded</h1>
      <p>{error?.message || 'AgentFlow could not reach the backend. Your conversation data has not been changed.'}</p>
      <button type="button" onClick={() => window.location.reload()}>Retry connection</button>
    </section>
  )
}

export default function OrchestrationChatPage() {
  const chat = useChatWorkspace()
  const [traceOpen, setTraceOpen] = useAtom(chatTraceOpenAtom)
  const [indexCollapsed, setIndexCollapsed] = useState(false)
  const reduceMotion = useReducedMotion()

  if (chat.loading) return <ChatLoading />
  if (chat.workspaceError) return <ChatError error={chat.workspaceError} />

  return (
    <motion.section
      className={`chat-workspace ${indexCollapsed ? 'chat-workspace--index-collapsed' : ''}`}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.24 }}
    >
      <ChatConversationIndex
        collapsed={indexCollapsed}
        resources={chat.resources}
        selectedResource={chat.selectedResource}
        selectedThread={chat.selectedThread}
        onSelectResource={chat.selectResource}
        onSelectThread={chat.selectThread}
        onToggleCollapsed={() => setIndexCollapsed((collapsed) => !collapsed)}
        threads={chat.threads}
      />
      <motion.div className="chat-stage" layout transition={{ layout: { duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] } }}>
        <ChatTranscript
          actionError={chat.actionError}
          latestRun={chat.latestRun}
          messages={chat.messages}
          onCancel={chat.cancelRun}
          onOpenTrace={() => setTraceOpen(true)}
          onReconnect={chat.reconnectRun}
          onRename={chat.renameThread}
          onResume={chat.resumeRun}
          onRetry={chat.retryMessage}
          onSend={chat.sendMessage}
          resource={chat.selectedResource}
          retryable={Boolean(chat.retrySubmission)}
          submitting={chat.submitting}
          thread={chat.selectedThread}
          threadLoading={chat.threadLoading}
          traceOpen={traceOpen}
        />
        <AnimatePresence initial={false}>
          {traceOpen ? (
            <ChatExecutionTrace
              messages={chat.messages}
              onClose={() => setTraceOpen(false)}
              run={chat.latestRun}
            />
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.section>
  )
}
