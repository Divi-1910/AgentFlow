import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import PixelSnow from "../ui/PixelSnow";

function ToggleLink({ to, label, isActive }) {
  return (
    <Link
      to={to}
      className={`rounded-full px-6 py-2.5 text-[12px] font-headline font-bold uppercase tracking-[0.15em] transition-all duration-300 ${isActive
        ? "bg-white text-black shadow-[0_2px_16px_rgba(255,255,255,0.2)]"
        : "text-white/40 hover:text-white"
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
    <div className="flex h-screen w-full overflow-hidden bg-black font-body text-white selection:bg-white/30 selection:text-white">
      {/* Left Section - Branding/Visuals (Hidden on mobile) */}
      <div className="relative hidden w-[45%] flex-col justify-between overflow-hidden border-r border-white/10 bg-[#020202] lg:flex">
        {/* Pixel Snow Background */}
        <div className="absolute inset-0 z-0">
          <PixelSnow
            color="#ffffff"
            flakeSize={0.015}
            minFlakeSize={1.0}
            pixelResolution={200}
            speed={0.6}
            depthFade={6}
            brightness={1.2}
            density={0.4}
            variant="snowflake"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/0 via-transparent to-black/90" />
          <div className="absolute -left-[50%] top-0 h-[80%] w-[150%] rounded-[100%] bg-white/5 blur-[120px]" />
        </div>

        {/* Top bar with Brand Logo */}
        <div className="relative z-10 p-10 xl:p-14">
          <Link to="/" className="inline-flex items-center gap-4 transition-opacity hover:opacity-80">
            <div>
              <p className="font-headline text-2xl font-extrabold tracking-tight text-white leading-none mb-1">
                Agent<span className="italic font-light text-white/50">Flow</span>
              </p>
            </div>
          </Link>
        </div>

        {/* Center content */}
        <div className="relative z-10 flex flex-1 flex-col justify-center px-10 pb-10 xl:px-14">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <h1 className="font-headline text-5xl font-bold tracking-tight text-white xl:text-[4rem] leading-[1.05]">
              Create with <br />
              <span className="text-white/40 font-light italic">
                AgentFlow
              </span>
            </h1>
            <p className="mt-8 max-w-md text-lg font-light leading-relaxed text-white/50">
              Create and manage your AI agents with ease. Our platform empowers you to orchestrate agents for any use case.
            </p>
          </motion.div>
        </div>
      </div>

      {/* Right Section - Auth Form */}
      <div className="relative flex h-full w-full flex-col overflow-y-auto lg:w-[55%] p-8 sm:p-16 xl:p-24">
        <div className="my-auto relative flex flex-col justify-center min-h-full">
        {/* Glow effect for mobile/tablet */}
        <div className="pointer-events-none absolute left-1/2 top-0 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-white/5 blur-[120px] lg:hidden" />

        <div className="relative z-10 w-full max-w-[420px] mx-auto">
          {/* Mobile Header */}
          <div className="mb-12 flex items-center gap-3 lg:hidden">
            <Link to="/" className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-black shadow-[0_0_24px_rgba(255,255,255,0.2)]">
                <span className="material-symbols-outlined text-xl">all_inclusive</span>
              </div>
              <p className="font-headline text-xl font-extrabold tracking-tight text-white">
                Agent<span className="italic font-light text-white/50">Flow</span>
              </p>
            </Link>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <div className="mb-12 flex justify-end">
              <div className="inline-flex rounded-full bg-white/[0.03] p-1.5 ring-1 ring-white/10 backdrop-blur-md">
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

            <div className="mb-10">
              <h2 className="font-headline text-3xl font-extrabold tracking-tight text-white mb-3">
                {title}
              </h2>
              <p className="text-[15px] font-light leading-relaxed text-white/50 max-w-sm">
                {subtitle}
              </p>
            </div>

            <form
              className="space-y-6"
              onSubmit={(event) => event.preventDefault()}
            >
              {children}

              <button
                type="submit"
                className="group/btn relative mt-10 flex w-full items-center justify-between overflow-hidden rounded-full bg-white px-6 py-4 shadow-[0_0_32px_rgba(255,255,255,0.15)] transition-all hover:bg-neutral-200 hover:shadow-[0_0_48px_rgba(255,255,255,0.3)]"
              >
                <span className="font-headline text-[13px] font-bold uppercase tracking-[0.1em] text-black">
                  {submitLabel}
                </span>
                <span className="material-symbols-outlined text-[18px] text-black transition-transform duration-300 group-hover/btn:translate-x-1">
                  arrow_forward
                </span>
              </button>
            </form>

            <div className="mt-12 text-[13px] font-light text-white/50">
              <span>{switchLabel}</span>{" "}
              <Link
                to={switchTo}
                className="font-bold tracking-wide text-white transition-colors hover:text-neutral-300 ml-1 underline decoration-white/30 underline-offset-4 hover:decoration-white"
              >
                {switchCta}
              </Link>
            </div>
          </motion.div>
        </div>
        </div>
      </div>
    </div>
  );
}

export default AuthShell;
