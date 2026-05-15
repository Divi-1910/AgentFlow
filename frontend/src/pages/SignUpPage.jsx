import { useState } from 'react'
import { motion } from 'framer-motion'
import AuthInput from '../components/auth/AuthInput'
import AuthShell from '../components/auth/AuthShell'
import { useAuth } from '../hooks/useAuth'

function SignUpPage() {
  const { signup } = useAuth()
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    const formData = new FormData(e.target)
    const pwd     = formData.get('password')
    const confirm = formData.get('confirmPassword')

    if (pwd !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      await signup(
        formData.get('firstName'),
        formData.get('lastName'),
        formData.get('email'),
        pwd,
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      mode="signup"
      title="Create Account"
      subtitle="Initialise your access key and join the AgentFlow network."
      submitLabel={loading ? 'Creating…' : 'Create Account'}
      switchLabel="Already have an account?"
      switchCta="Sign in"
      switchTo="/login"
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
            Failed to create account
          </p>
          <p className="pl-3 text-[12px] font-light text-white/50 mt-1">{error}</p>
        </motion.div>
      )}

      {/* Name row */}
      <div className="grid gap-3 sm:grid-cols-2">
        <AuthInput
          id="signUpFirstName"
          name="firstName"
          label="First name"
          autoComplete="given-name"
          placeholder="First name"
          icon="person"
        />
        <AuthInput
          id="signUpLastName"
          name="lastName"
          label="Last name"
          autoComplete="family-name"
          placeholder="Last name"
          icon="badge"
        />
      </div>

      <AuthInput
        id="signUpEmail"
        name="email"
        label="Email address"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        icon="alternate_email"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <AuthInput
          id="signUpPassword"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          placeholder="Create password"
          icon="lock"
        />
        <AuthInput
          id="signUpConfirmPassword"
          name="confirmPassword"
          label="Confirm"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat password"
          icon="verified_user"
        />
      </div>

      {/* Terms note */}
      <p className="form-item text-[11px] font-light leading-relaxed text-white/25 opacity-0">
        By creating an account you agree to our{' '}
        <button type="button" className="underline decoration-white/20 underline-offset-2 hover:text-white/50 transition-colors">
          Terms of Service
        </button>
        {' '}and{' '}
        <button type="button" className="underline decoration-white/20 underline-offset-2 hover:text-white/50 transition-colors">
          Privacy Policy
        </button>.
      </p>
    </AuthShell>
  )
}

export default SignUpPage
