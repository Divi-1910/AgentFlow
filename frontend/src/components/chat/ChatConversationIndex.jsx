import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useDeferredValue, useMemo, useState } from "react";
import {
  formatChatTime,
  resourceLabel,
} from "../../features/chat/chatPresentation";

const spring = { damping: 30, stiffness: 340, type: "spring" };
const modeTransition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] };

export default function ChatConversationIndex({
  collapsed,
  resources,
  selectedResource,
  selectedThread,
  onSelectResource,
  onSelectThread,
  onToggleCollapsed,
  threads,
}) {
  const reduceMotion = useReducedMotion();
  const [conversationQuery, setConversationQuery] = useState("");
  const [resourceQuery, setResourceQuery] = useState("");
  const [choosingResource, setChoosingResource] = useState(false);
  const deferredConversationQuery = useDeferredValue(
    conversationQuery.trim().toLowerCase(),
  );
  const deferredResourceQuery = useDeferredValue(
    resourceQuery.trim().toLowerCase(),
  );
  const resourcesById = useMemo(
    () => new Map(resources.map((resource) => [resource.id, resource])),
    [resources],
  );
  const filteredThreads = useMemo(
    () =>
      threads.filter((thread) => {
        if (!deferredConversationQuery) return true;
        const resource = resourcesById.get(thread.resource_id);
        return `${thread.title} ${resource?.name || ""}`
          .toLowerCase()
          .includes(deferredConversationQuery);
      }),
    [deferredConversationQuery, resourcesById, threads],
  );
  const filteredResources = useMemo(
    () =>
      resources.filter(
        (resource) =>
          !deferredResourceQuery ||
          `${resource.name} ${resourceLabel(resource)}`
            .toLowerCase()
            .includes(deferredResourceQuery),
      ),
    [deferredResourceQuery, resources],
  );

  function chooseResource(resource) {
    onSelectResource(resource);
    setChoosingResource(false);
    setResourceQuery("");
  }

  function startConversation() {
    if (collapsed) onToggleCollapsed();
    setChoosingResource(true);
  }

  return (
    <motion.aside
      className={`chat-index ${collapsed ? "chat-index--collapsed" : ""}`}
      initial={reduceMotion ? false : { opacity: 0, x: -18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={spring}
      aria-label="Conversation index"
    >
      {collapsed ? (
        <div className="chat-index__collapsed-actions">
          <button
            type="button"
            className="chat-plain-icon"
            onClick={onToggleCollapsed}
            aria-label="Show conversations"
            title="Show conversations"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              left_panel_open
            </span>
          </button>
          <button
            type="button"
            className="chat-square-button"
            onClick={startConversation}
            aria-label="Start a new conversation"
            title="New conversation"
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
          </button>
        </div>
      ) : null}

      {!collapsed ? (
        <>
          <header className="chat-index__header">
            <div>
              <p>
                {choosingResource
                  ? "Choose who should answer"
                  : `${threads.length} ${threads.length === 1 ? "conversation" : "conversations"}`}
              </p>
              <h1>{choosingResource ? "New conversation" : "Conversations"}</h1>
            </div>
            <div className="chat-index__header-actions">
              <button
                type="button"
                className="chat-square-button"
                onClick={() => setChoosingResource((open) => !open)}
                aria-label={
                  choosingResource
                    ? "Return to conversations"
                    : "Start a new conversation"
                }
                aria-expanded={choosingResource}
                title={
                  choosingResource
                    ? "Return to conversations"
                    : "New conversation"
                }
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {choosingResource ? "close" : "add"}
                </span>
              </button>
            </div>
          </header>

          <AnimatePresence initial={false} mode="wait">
            {choosingResource ? (
              <motion.div
                className="chat-index__mode"
                key="intelligence"
                initial={reduceMotion ? false : { opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: -8 }}
                transition={modeTransition}
              >
                <label className="chat-search">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    search
                  </span>
                  <span className="sr-only">Find an agent or team</span>
                  <input
                    aria-label="Find an agent or team"
                    value={resourceQuery}
                    onChange={(event) => setResourceQuery(event.target.value)}
                    placeholder="Find an agent or team"
                    autoFocus
                  />
                </label>
                <section
                  className="chat-intelligence-index"
                  aria-label="Available intelligence"
                >
                  <header className="chat-intelligence-index__header">
                    <strong>Available intelligence</strong>
                    <span>{filteredResources.length}</span>
                  </header>
                  <div className="chat-intelligence-list">
                    {filteredResources.map((resource) => (
                      <button
                        type="button"
                        className="chat-intelligence-row"
                        key={resource.id}
                        onClick={() => chooseResource(resource)}
                        aria-current={
                          !selectedThread &&
                          selectedResource?.id === resource.id
                            ? "true"
                            : undefined
                        }
                      >
                        <span className="chat-intelligence-row__copy">
                          <strong>{resource.name}</strong>
                          <small>{resourceLabel(resource)}</small>
                        </span>
                        <span className="chat-intelligence-row__action">
                          Start
                        </span>
                      </button>
                    ))}
                    {resources.length === 0 ? (
                      <p>
                        Create an agent or team before starting a conversation.
                      </p>
                    ) : null}
                    {resources.length > 0 && filteredResources.length === 0 ? (
                      <p>No agents or teams match “{resourceQuery}”.</p>
                    ) : null}
                  </div>
                </section>
              </motion.div>
            ) : (
              <motion.div
                className="chat-index__mode"
                key="history"
                initial={reduceMotion ? false : { opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: 8 }}
                transition={modeTransition}
              >
                <label className="chat-search">
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    search
                  </span>
                  <span className="sr-only">Search conversations</span>
                  <input
                    aria-label="Search conversations"
                    value={conversationQuery}
                    onChange={(event) =>
                      setConversationQuery(event.target.value)
                    }
                    placeholder="Search conversations"
                  />
                </label>

                {!selectedThread && selectedResource ? (
                  <button
                    type="button"
                    className="chat-thread-row chat-thread-row--selected chat-thread-row--draft"
                    onClick={() => setChoosingResource(true)}
                  >
                    <span className="chat-thread-row__copy">
                      <strong>New conversation</strong>
                      <small>{selectedResource.name}</small>
                    </span>
                    <span className="chat-thread-row__state">Draft</span>
                  </button>
                ) : null}

                <div className="chat-index__section-heading">
                  <span>History</span>
                  <span>{filteredThreads.length}</span>
                </div>
                <nav
                  className="chat-thread-list"
                  aria-label="Conversation history"
                >
                  {filteredThreads.map((thread) => {
                    const resource = resourcesById.get(thread.resource_id);
                    const selected = selectedThread?.id === thread.id;
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        className={`chat-thread-row ${selected ? "chat-thread-row--selected" : ""}`}
                        onClick={() => onSelectThread(thread)}
                        aria-current={selected ? "page" : undefined}
                      >
                        <span className="chat-thread-row__copy">
                          <strong>
                            {thread.title || "Untitled conversation"}
                          </strong>
                          <small>
                            {resource?.name ||
                              resourceLabel({
                                resource_kind: thread.resource_kind,
                              })}
                          </small>
                        </span>
                        <time dateTime={thread.updated_at}>
                          {formatChatTime(thread.updated_at)}
                        </time>
                      </button>
                    );
                  })}
                  {filteredThreads.length === 0 && threads.length > 0 ? (
                    <p className="chat-index__empty">
                      No conversations match “{conversationQuery}”.
                    </p>
                  ) : null}
                  {threads.length === 0 && !selectedResource ? (
                    <button
                      type="button"
                      className="chat-index__empty-action"
                      onClick={() => setChoosingResource(true)}
                    >
                      Choose an agent or team to begin.
                    </button>
                  ) : null}
                </nav>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : null}
    </motion.aside>
  );
}
