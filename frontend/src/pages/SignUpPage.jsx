import { motion } from "framer-motion";
import AuthInput from '../components/auth/AuthInput'
import AuthShell from '../components/auth/AuthShell'

function SignUpPage() {
  return (
    <AuthShell
      mode="signup"
      title="Create an account"
      subtitle="Set up your workspace and start building your intelligent agents."
      submitLabel="Sign Up"
      switchLabel="Already have an account?"
      switchCta="Sign in"
      switchTo="/login"
    >
      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1, duration: 0.5 }} className="grid gap-4 sm:grid-cols-2">
        <AuthInput
          id="signUpFirstName"
          name="firstName"
          label="First Name"
          autoComplete="given-name"
          placeholder="First name"
          icon="person"
        />

        <AuthInput
          id="signUpLastName"
          name="lastName"
          label="Last Name"
          autoComplete="family-name"
          placeholder="Last name"
          icon="badge"
        />
      </motion.div>

      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
        <AuthInput
          id="signUpEmail"
          name="email"
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          icon="alternate_email"
        />
      </motion.div>

      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3, duration: 0.5 }} className="grid gap-4 sm:grid-cols-2">
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
          label="Confirm Password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat password"
          icon="verified_user"
        />
      </motion.div>

      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4, duration: 0.5 }}>
        <label className="group relative flex cursor-pointer items-start gap-3 pt-2 text-[12px] text-white/50 transition-colors hover:text-white font-light">
          <div className="relative flex shrink-0 items-center justify-center mt-0.5">
            <input
              type="checkbox"
              required
              className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-white/20 bg-white/5 transition-all checked:border-white checked:bg-white focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-1 focus:ring-offset-black"
            />
            <span className="material-symbols-outlined pointer-events-none absolute text-[12px] text-black font-extrabold opacity-0 transition-opacity peer-checked:opacity-100">
              check
            </span>
          </div>
          <span className="leading-relaxed">
            I agree to the <a href="#" className="font-bold text-white underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white">Terms of Service</a> and <a href="#" className="font-bold text-white underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white">Privacy Policy</a>.
          </span>
        </label>
      </motion.div>
    </AuthShell>
  )
}

export default SignUpPage
