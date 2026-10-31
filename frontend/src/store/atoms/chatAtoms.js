import { atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { chatRuntimeReducer, initialChatRuntimeState, selectPrimaryDraft } from '../../features/chat/chatState'

export const selectedChatThreadIdAtom = atom(null)
export const selectedChatResourceAtom = atom(null)
export const chatTraceOpenAtom = atom(false)
export const chatRuntimeAtom = atom({ ...initialChatRuntimeState })

export const chatTranscriptRuntimeAtom = selectAtom(
  chatRuntimeAtom,
  (runtime) => ({
    connection: runtime.connection,
	events: runtime.events,
    partial: runtime.partial,
    primaryDraft: selectPrimaryDraft(runtime),
	rootRunId: runtime.rootRunId,
    status: runtime.status,
  }),
  (previous, next) => previous.connection === next.connection
	&& previous.events === next.events
    && previous.partial === next.partial
    && previous.primaryDraft === next.primaryDraft
	&& previous.rootRunId === next.rootRunId
    && previous.status === next.status,
)

export const chatTraceRuntimeAtom = selectAtom(
  chatRuntimeAtom,
  (runtime) => ({
    connection: runtime.connection,
    events: runtime.events,
    rootRunId: runtime.rootRunId,
    status: runtime.status,
	streams: runtime.streams,
  }),
  (previous, next) => previous.connection === next.connection
    && previous.events === next.events
    && previous.rootRunId === next.rootRunId
    && previous.status === next.status
	&& previous.streams === next.streams,
)

export const dispatchChatRuntimeAtom = atom(null, (get, set, action) => {
  set(chatRuntimeAtom, chatRuntimeReducer(get(chatRuntimeAtom), action))
})
