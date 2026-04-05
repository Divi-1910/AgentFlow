import { motion } from "framer-motion";
import AuthInput from "../components/auth/AuthInput";
import AuthShell from "../components/auth/AuthShell";

function LoginPage() {
  return (
    <AuthShell
      mode="login"
      title="Welcome back"
      subtitle="Authenticate to access your workspace and manage your AI agents with ease."
      submitLabel="Sign In"
      switchLabel="Need a new account?"
      switchCta="Create one"
      switchTo="/signup"
    >
      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1, duration: 0.5 }}>
        <AuthInput
          id="loginEmail"
          name="email"
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          icon="alternate_email"
        />
      </motion.div>

      <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
        <AuthInput
          id="loginPassword"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••••••"
          icon="lock"
        />
      </motion.div>

      <motion.div 
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3, duration: 0.5 }}
        className="flex items-center justify-between gap-3 pt-2 text-[12px]"
      >
        <label className="group relative flex cursor-pointer items-center gap-3 text-white/50 transition-colors hover:text-white font-light">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-white/20 bg-white/5 transition-all checked:border-white checked:bg-white focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-1 focus:ring-offset-black"
            />
            <span className="material-symbols-outlined pointer-events-none absolute text-[12px] text-black font-extrabold opacity-0 transition-opacity peer-checked:opacity-100">
              check
            </span>
          </div>
          Keep me signed in
        </label>

        <button
          type="button"
          className="font-light text-white/50 transition-colors hover:text-white underline decoration-white/20 underline-offset-4 hover:decoration-white"
        >
          Reset password
        </button>
      </motion.div>
    </AuthShell>
  );
}

export default LoginPage;
