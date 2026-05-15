/**
 * TransitionLink
 * ──────────────
 * Drop-in replacement for react-router's <Link> that runs the
 * page-transition animation before handing off to React Router.
 *
 * Usage:
 *   <TransitionLink to="/login" className="...">Sign In</TransitionLink>
 *
 * Renders an <a> tag so all existing className/style props work.
 */

import { useCallback } from 'react'
import { usePageTransition } from './usePageTransition'

export default function TransitionLink({
  to,
  children,
  className,
  style,
  onClick,
  ...rest
}) {
  const go = usePageTransition()

  const handleClick = useCallback((e) => {
    e.preventDefault()
    onClick?.()
    go(to)
  }, [go, to, onClick])

  return (
    <a href={to} onClick={handleClick} className={className} style={style} {...rest}>
      {children}
    </a>
  )
}
