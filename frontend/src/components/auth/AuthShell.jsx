import { Link } from "react-router-dom";

function ToggleLink({ to, label, isActive }) {
  return (
    <Link
      to={to}
      className={`rounded-lg px-6 py-2 text-[13px] font-bold transition-all duration-300 ${
        isActive
          ? "bg-surface shadow-[0_2px_10px_rgba(0,0,0,0.2)] text-white"
          : "text-on-surface-variant hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}
function AuthShell({
  mode,
  title,
  subtitle,
  submitLabel,
  switchLabel,
  switchCta,
  switchTo,
  children,
}) {
  return (
    <div className="flex min-h-screen w-full bg-background font-body selection:bg-primary/30 selection:text-white">
      {/* Left Section - Branding/Visuals (Hidden on smaller screens, prominent on desktop) */}
      <div className="relative hidden w-1/2 lg:flex flex-col justify-between overflow-hidden bg-surface-container-low border-r border-outline-variant/20">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-[30%] -left-[20%] h-[80%] w-[80%] rounded-[100%] bg-primary/10 blur-[120px]" />
          <div className="absolute top-[40%] -right-[30%] h-[70%] w-[70%] rounded-[100%] bg-secondary/10 blur-[120px]" />
          <div className="absolute inset-0 bg-[radial-gradient(#192540_1px,transparent_1px)] [background-size:24px_24px] opacity-40 mix-blend-screen" />
          <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-background to-transparent" />
        </div>

        {/* Top bar with Brand Logo */}
        <div className="relative z-10 flex items-center gap-3 p-10 xl:p-14">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-dim text-on-primary-container shadow-[0_0_30px_rgba(0,212,236,0.2)]">
            <span className="material-symbols-outlined text-2xl font-light">
              hub
            </span>
          </div>
          <div>
            <p className="font-headline text-2xl font-bold tracking-tight text-white leading-none mb-1">
              AgentFlow
            </p>
            <p className="text-[10px] uppercase tracking-[0.25em] text-primary font-bold">
              AI Agent Center
            </p>
          </div>
        </div>

        {/* Center content */}
        <div className="relative z-10 pb-10 px-10 xl:px-14 flex-1 flex flex-col justify-center max-w-2xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 mb-8 text-xs font-bold uppercase tracking-widest text-primary w-fit backdrop-blur-md">
            Orchestration Platform
          </span>
          <h1 className="font-headline text-5xl xl:text-6xl font-extrabold text-white text-balance tracking-tight leading-[1.1]">
            Create with <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-primary to-secondary">
              AgentFlow
            </span>
          </h1>
          <p className="mt-8 text-lg leading-relaxed text-on-surface-variant max-w-lg font-light">
            Create and manage your AI agents with ease. Our platform empowers
            you to orchestrate agents for any use case, from automating
            workflows to building AI assistants, all with a single interface.
          </p>
        </div>
      </div>

      {/* Right Section - Auth Form */}
      <div className="flex w-full items-center justify-center lg:w-1/2 p-6 sm:p-12 xl:p-20 relative">
        {/* Glow effect for mobile/tablet */}
        <div className="absolute top-0 right-0 h-[600px] w-[600px] rounded-full bg-primary/5 blur-[120px] lg:hidden pointer-events-none" />
        <div className="absolute bottom-0 left-0 h-[500px] w-[500px] rounded-full bg-secondary/5 blur-[120px] lg:hidden pointer-events-none" />

        <div className="w-full max-w-[420px] relative z-10">
          <div className="lg:hidden flex items-center gap-3 mb-10">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary-dim text-on-primary-container shadow-[0_0_20px_rgba(0,212,236,0.3)]">
              <span className="material-symbols-outlined text-xl">hub</span>
            </div>
            <div>
              <p className="font-headline text-xl font-bold tracking-tight text-white mb-0.5">
                AgentFlow
              </p>
              <p className="text-[9px] uppercase tracking-[0.2em] text-primary font-bold">
                Command Center
              </p>
            </div>
          </div>

          <div className="flex items-end justify-end mb-8">
            <div className="inline-flex rounded-xl bg-surface-container-high/50 p-1 backdrop-blur-sm border border-outline-variant/20 shadow-inner">
              <ToggleLink
                to="/login"
                label="Log in"
                isActive={mode === "login"}
              />
              <ToggleLink
                to="/signup"
                label="Sign up"
                isActive={mode === "signup"}
              />
            </div>
          </div>

          <div className="mb-8">
            <h2 className="font-headline text-3xl font-bold tracking-tight text-white mb-2">
              {title}
            </h2>
            <p className="text-sm text-on-surface-variant max-w-sm">
              {subtitle}
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => event.preventDefault()}
          >
            {children}

            <button
              type="submit"
              className="mt-6 w-full group relative flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3.5 text-sm font-bold text-background transition-all duration-300 hover:bg-zinc-200 active:scale-[0.98] shadow-[0_0_15px_rgba(255,255,255,0.05)] hover:shadow-[0_0_25px_rgba(255,255,255,0.2)]"
            >
              {submitLabel}
              <span className="material-symbols-outlined text-[18px] opacity-70 transition-transform group-hover:translate-x-1 group-hover:opacity-100">
                arrow_forward
              </span>
            </button>
          </form>

          <div className="mt-12 text-center text-sm text-on-surface-variant">
            <span>{switchLabel}</span>{" "}
            <Link
              to={switchTo}
              className="font-semibold text-white transition-colors hover:text-primary relative inline-block after:absolute after:bottom-0 after:left-0 after:h-[1px] after:w-full after:origin-right after:scale-x-0 after:bg-primary after:transition-transform hover:after:origin-left hover:after:scale-x-100"
            >
              {switchCta}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AuthShell;
