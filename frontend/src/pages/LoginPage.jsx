import { useState } from 'react'
import { motion } from 'framer-motion'
import AuthInput from '../components/auth/AuthInput'
import AuthShell from '../components/auth/AuthShell'
import { useAuth } from '../hooks/useAuth'

function LoginPage() {
  const { login } = useAuth()
  const [error, setError]   = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const formData = new FormData(e.target)
    try {
      await login(formData.get('email'), formData.get('password'))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      mode="login"
      title="Welcome Back"
      subtitle="Enter your credentials to access your orchestration workspace."
      submitLabel={loading ? 'Signing in…' : 'Sign In'}
      switchLabel="Need a new account?"
      switchCta="Create one"
      switchTo="/signup"
      onSubmit={handleSubmit}
    >
      {/* Error banner */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-red-500/20 bg-red-950/25 p-4 relative overflow-hidden"
        >
          <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-red-500/70" />
          <p className="pl-3 font-headline text-[10px] font-bold uppercase tracking-[0.12em] text-red-400">
            Authentication Failed
          </p>
          <p className="pl-3 text-[12px] font-light text-white/50 mt-1">{error}</p>
        </motion.div>
      )}

      {/* Fields — AuthInput handles its own form-item + opacity-0 */}
      <AuthInput
        id="loginEmail"
        name="email"
        label="Email address"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        icon="alternate_email"
      />

      <AuthInput
        id="loginPassword"
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••••"
        icon="lock"
      />

      {/* Remember + forgot — styled as a form-item so AnimeJS staggers it */}
      <div className="form-item flex items-center justify-between gap-3 pt-1 text-[12px] opacity-0">
        <label className="flex cursor-pointer items-center gap-2.5 text-white/35 transition-colors hover:text-white/60 font-light select-none">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-white/15 bg-white/[0.03] transition-all
                         checked:border-white/50 checked:bg-white/10 focus:outline-none focus:ring-1 focus:ring-white/15"
            />
            <span className="material-symbols-outlined pointer-events-none absolute text-[11px] text-white opacity-0 transition-opacity peer-checked:opacity-100"
              style={{ fontVariationSettings: "'FILL' 1, 'wght' 700, 'GRAD' 0, 'opsz' 24" }}>
              check
            </span>
          </div>
          Keep me signed in
        </label>

        <button
          type="button"
          className="font-light text-white/30 transition-colors hover:text-white/60 underline decoration-white/10 underline-offset-4 hover:decoration-white/30"
        >
          Reset password
        </button>
      </div>
    </AuthShell>
  )
}

export default LoginPage
