import { AnimatePresence, motion } from 'framer-motion'

const spring = { damping: 30, stiffness: 340, type: 'spring' }

function ActivityRow({ activity }) {
	const active = activity.status === 'running'
	const failed = activity.status === 'failed'
	return (
		<motion.li
			className={`chat-inline-activity__item chat-inline-activity__item--${activity.status || 'completed'}`}
			initial={{ opacity: 0, y: 7 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: -5 }}
			transition={spring}
		>
			<div className="chat-inline-activity__row">
				<span className="chat-inline-activity__icon" aria-hidden="true">
					{active ? <i /> : <span className="material-symbols-outlined">{failed ? 'close' : 'check'}</span>}
				</span>
				<span className="chat-inline-activity__copy">
					<strong>{activity.title}</strong>
					{activity.depth > 0 || activity.agentName !== 'AgentFlow' ? <em>{activity.agentName}</em> : null}
				</span>
			</div>
		</motion.li>
	)
}

export default function ChatInlineActivity({ activities = [], active = false, status = 'Thinking' }) {
	if (!active && activities.length === 0) return null
	const hasRunningActivity = activities.some((activity) => activity.status === 'running')

	return (
		<section className="chat-inline-activity" aria-label="Agent activity" aria-live="polite">
			{active && !hasRunningActivity ? (
				<div className="chat-inline-activity__current">
					<span aria-hidden="true"><i /><i /><i /></span>
					<strong>{status || 'Thinking'}</strong>
				</div>
			) : null}
			{activities.length ? (
				<ol>
					<AnimatePresence initial={false}>
						{activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
					</AnimatePresence>
				</ol>
			) : null}
		</section>
	)
}
