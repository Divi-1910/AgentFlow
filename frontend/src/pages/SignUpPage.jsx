import { useState } from "react";
import { motion } from "framer-motion";
import AuthInput from '../components/auth/AuthInput'
import AuthShell from '../components/auth/AuthShell'
import { useAuth } from "../hooks/useAuth";

function SignUpPage() {
  const { signup } = useAuth();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    
    const formData = new FormData(e.target);
    const pwd = formData.get("password");
    const confirm = formData.get("confirmPassword");
    
    if (pwd !== confirm) {
        setError("Passwords do not match");
        return;
    }

    setLoading(true);
    try {
      await signup(
        formData.get("firstName"), 
        formData.get("lastName"), 
        formData.get("email"), 
        pwd
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      mode="signup"
      title="Create Account"
      subtitle="Initialize your access key and join the AgentFlow network."
      submitLabel="Sign Up"
      switchLabel="Already have an account?"
      switchCta="Sign in"
      switchTo="/login"
      onSubmit={handleSubmit}
    >
      {error && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl border border-red-500/20 bg-red-950/30 p-4 relative overflow-hidden backdrop-blur-md">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500/80"></div>
          <p className="pl-2 font-headline text-[11px] font-bold uppercase tracking-[0.1em] text-red-400">Failed to create account</p>
          <p className="pl-2 text-sm font-light text-white/60 mt-1">{error}</p>
        </motion.div>
      )}

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
