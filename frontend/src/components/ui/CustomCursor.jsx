import { useEffect, useRef } from 'react'
import { motion, useMotionValue, useSpring } from 'framer-motion'

export default function CustomCursor() {
  const dotX = useMotionValue(-100)
  const dotY = useMotionValue(-100)

  // Spring-lagged follower for the larger ring
  const ringX = useSpring(dotX, { stiffness: 120, damping: 20 })
  const ringY = useSpring(dotY, { stiffness: 120, damping: 20 })

  const isHovered = useRef(false)
  const ringRef = useRef(null)
  const dotRef = useRef(null)

  useEffect(() => {
    const move = (e) => {
      dotX.set(e.clientX)
      dotY.set(e.clientY)
    }

    const over = (e) => {
      const target = e.target.closest('button, a, [data-cursor="pointer"]')
      if (target && !isHovered.current) {
        isHovered.current = true
        if (ringRef.current) {
          ringRef.current.style.transform += ' scale(2)'
          ringRef.current.style.borderColor = 'rgba(255,255,255,0.6)'
        }
      }
    }

    const out = (e) => {
      const target = e.target.closest('button, a, [data-cursor="pointer"]')
      if (target && isHovered.current) {
        isHovered.current = false
        if (ringRef.current) {
          ringRef.current.style.transform = ''
          ringRef.current.style.borderColor = 'rgba(255,255,255,0.25)'
        }
      }
    }

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseover', over)
    window.addEventListener('mouseout', out)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseover', over)
      window.removeEventListener('mouseout', out)
    }
  }, [dotX, dotY])

  return (
    <>
      {/* Dot — snaps to cursor */}
      <motion.div
        style={{ x: dotX, y: dotY }}
        className="pointer-events-none fixed top-0 left-0 z-[9999] h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
      />
      {/* Ring — spring-lags behind */}
      <motion.div
        ref={ringRef}
        style={{ x: ringX, y: ringY }}
        className="pointer-events-none fixed top-0 left-0 z-[9998] h-[32px] w-[32px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/25 transition-all duration-300"
      />
    </>
  )
}
