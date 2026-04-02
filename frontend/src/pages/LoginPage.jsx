import AuthInput from "../components/auth/AuthInput";
import AuthShell from "../components/auth/AuthShell";

function LoginPage() {
  return (
    <AuthShell
      mode="login"
      title="Welcome back"
      subtitle="Authenticate to access your AgentFlow workspace and manage your AI agents with ease."
      submitLabel="Sign In"
      switchLabel="Need a new workspace account?"
      switchCta="Create one"
      switchTo="/signup"
    >
      <AuthInput
        id="loginEmail"
        name="email"
        label="Work Email"
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
        placeholder="Enter your password"
        icon="lock"
      />

      <div className="flex items-center justify-between gap-3 pt-2 text-[13px]">
        <label className="group relative flex cursor-pointer items-center gap-2.5 text-on-surface-variant transition-colors hover:text-white">
          <div className="relative flex items-center justify-center">
            <input
              type="checkbox"
              className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-outline-variant/50 bg-surface-container-high/50 transition-all checked:border-primary checked:bg-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:ring-offset-1 focus:ring-offset-background"
            />
            <span className="material-symbols-outlined pointer-events-none absolute text-[12px] text-background font-bold opacity-0 transition-opacity peer-checked:opacity-100">
              check
            </span>
          </div>
          Keep me signed in
        </label>

        <button
          type="button"
          className="font-medium text-on-surface-variant transition-colors hover:text-white"
        >
          Reset password
        </button>
      </div>
    </AuthShell>
  );
}

export default LoginPage;
