import { useState } from "react";
import { motion } from "framer-motion";
import AuthInput from "../components/auth/AuthInput";
import AuthShell from "../components/auth/AuthShell";
import { useAuth } from "../hooks/useAuth";

function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    
    const formData = new FormData(e.target);
    try {
      await login(formData.get("email"), formData.get("password"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      mode="login"
      title="Welcome Back"
      subtitle="Enter your credentials to access your orchestration workspace."
      submitLabel="Sign In"
      switchLabel="Need a new account?"
      switchCta="Create one"
      switchTo="/signup"
      onSubmit={handleSubmit}
    >
      {error && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl border border-red-500/20 bg-red-950/30 p-4 relative overflow-hidden backdrop-blur-md">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500/80"></div>
          <p className="pl-2 font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-red-400">Authentication Failed</p>
          <p className="pl-2 text-sm font-light text-white/60 mt-1">{error}</p>
        </motion.div>
      )}

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
