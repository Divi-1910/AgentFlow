import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

/*
  AuthInput — floating-label input
  ─────────────────────────────────
  Layout geometry (inner container = 52 px tall, fixed):

    ┌─────────────────────────────────────────┐  ← top of inner container
    │  [label — active]  top: 8 px             │  y = 0   (scale 0.76)
    │                                          │
    │  [input cursor / typed text]  at ~31 px  │  absolute bottom: 8 px
    └─────────────────────────────────────────┘

    Resting state: label y = +14 → visual top ≈ 22 px → centred in 52 px ✓
    Active state:  label y =   0 → visual top =  8 px → floated up ✓
    Gap between label bottom (active) and input cursor: ~11 px — clear separation ✓
*/

export default function AuthInput({
  id,
  name,
  label,
  type = 'text',
  autoComplete,
  placeholder,
  icon,
  required = true,
}) {
  const [focused,  setFocused]  = useState(false)
  const [hasValue, setHasValue] = useState(false)
  const [showPwd,  setShowPwd]  = useState(false)
  const inputRef = useRef(null)

  const isPassword = type === 'password'
  const inputType  = isPassword ? (showPwd ? 'text' : 'password') : type
  const isActive   = focused || hasValue

  return (
    <div className="form-item group relative opacity-0">
      <div
        onClick={() => inputRef.current?.focus()}
        className={`relative overflow-hidden rounded-2xl border transition-all duration-300 cursor-text ${
          focused
            ? 'border-white/20 bg-white/[0.05] shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_0_28px_rgba(255,255,255,0.03)]'
            : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.03]'
        }`}
      >
        {/* Top shimmer on focus */}
        <motion.div
          animate={{ opacity: focused ? 1 : 0 }}
          transition={{ duration: 0.3 }}
          className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent pointer-events-none"
        />

        <div className="flex items-center gap-3 px-4 py-2.5">

          {/* Icon — filled on focus */}
          <span
            className="material-symbols-outlined flex-shrink-0 text-[18px] transition-all duration-300"
            style={{
              color: focused ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)',
              fontVariationSettings: focused
                ? "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24"
                : "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24",
            }}
          >
            {icon}
          </span>

          {/*
            Inner container: fixed 52 px height, both label and input
            are absolute so their positions are completely predictable.
          */}
          <div className="relative flex-1 h-[52px]">

            {/* Floating label */}
            <motion.label
              htmlFor={id}
              animate={{
                y:       isActive ? 0 : 14,
                scale:   isActive ? 0.76 : 1,
                opacity: isActive ? 0.50 : 0.35,
              }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-none absolute top-[8px] left-0 origin-top-left font-body text-[13px] text-white leading-none select-none"
            >
              {label}
            </motion.label>

            {/* Input — anchored to the bottom of the container */}
            <input
              ref={inputRef}
              id={id}
              name={name}
              type={inputType}
              autoComplete={autoComplete}
              placeholder={isActive ? (placeholder ?? '') : ''}
              required={required}
              onFocus={() => setFocused(true)}
              onBlur={(e) => {
                setFocused(false)
                setHasValue(e.target.value.length > 0)
              }}
              onChange={(e) => setHasValue(e.target.value.length > 0)}
              className="absolute bottom-[8px] left-0 w-full bg-transparent font-body text-[14px] text-white leading-none placeholder-white/20 focus:outline-none"
            />
          </div>

          {/* Password visibility toggle */}
          <AnimatePresence>
            {isPassword && (
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: focused || hasValue ? 1 : 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.2 }}
                onClick={() => setShowPwd(v => !v)}
                tabIndex={-1}
                className="flex-shrink-0 text-white/20 transition-colors hover:text-white/50 focus:outline-none"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {showPwd ? 'visibility_off' : 'visibility'}
                </span>
              </motion.button>
            )}
          </AnimatePresence>

        </div>
      </div>
    </div>
  )
}
