import { useEffect, useRef, useState } from 'react'
import { animate } from 'animejs'

const USE_CASES = [
  'customer support',
  'code review',
  'data analysis',
  'market research',
  'content creation',
  'sales automation',
  'financial modeling',
  'anything you imagine',
]

export default function CyclingText() {
  const [displayIndex, setDisplayIndex] = useState(0)
  const spanRef     = useRef(null)
  const isAnimating = useRef(false)

  useEffect(() => {
    const interval = setInterval(() => {
      if (isAnimating.current) return
      isAnimating.current = true

      animate(spanRef.current, {
        opacity: [1, 0],
        translateY: [0, -12],
        duration: 280,
        ease: 'inCubic',
        onComplete: () => {
          setDisplayIndex(prev => (prev + 1) % USE_CASES.length)
          animate(spanRef.current, {
            opacity: [0, 1],
            translateY: [12, 0],
            duration: 500,
            ease: 'outExpo',
            onComplete: () => { isAnimating.current = false },
          })
        },
      })
    }, 2800)

    return () => clearInterval(interval)
  }, [])

  /*
    Sizing math — must fit "anything you imagine" (20 chars) without wrapping.
    Clash Display italic cap-width ≈ 0.58em per char.
    At each breakpoint:
      mobile  (≥320px):  5.5vw → at 360px = 19.8px → 20 × 0.58 × 19.8 ≈ 229px  < 312px avail ✓
      sm      (≥640px):  4.2vw → at 640px = 26.9px → 20 × 0.58 × 26.9 ≈ 312px  < 560px avail ✓
      lg      (≥1024px): 3.2vw → at 1440px = 46px  → 20 × 0.58 × 46   ≈ 533px  < 740px avail ✓

    Container height = font-size × 1.5 to avoid descender clip during the translateY animation.
    We use a fixed pixel height at each breakpoint via a responsive class trick.
  */
  return (
    <div
      className="overflow-hidden"
      style={{ height: 'clamp(1.8rem, 8.5vw, 5rem)' }}
    >
      <span
        ref={spanRef}
        className="block font-headline font-light italic tracking-[-0.02em]
                   text-white/30 select-none leading-[1.4]
                   text-[5.5vw] sm:text-[4.2vw] lg:text-[3.2vw]"
      >
        {USE_CASES[displayIndex]}
      </span>
    </div>
  )
}
