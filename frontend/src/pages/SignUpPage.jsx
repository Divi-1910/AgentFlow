import AuthInput from '../components/auth/AuthInput'
import AuthShell from '../components/auth/AuthShell'

function SignUpPage() {
  return (
    <AuthShell
      mode="signup"
      title="Create your account"
      subtitle="Provision your secure workspace and start coordinating agents in minutes."
      submitLabel="Create Account"
      switchLabel="Already have credentials?"
      switchCta="Sign in"
      switchTo="/login"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <AuthInput
          id="signUpFirstName"
          name="firstName"
          label="First Name"
          autoComplete="given-name"
          placeholder="Alex"
          icon="person"
        />

        <AuthInput
          id="signUpLastName"
          name="lastName"
          label="Last Name"
          autoComplete="family-name"
          placeholder="Chen"
          icon="badge"
        />
      </div>

      <AuthInput
        id="signUpEmail"
        name="email"
        label="Work Email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        icon="alternate_email"
      />

      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>

      <label className="group relative flex cursor-pointer items-start gap-3 pt-2 text-[13px] text-on-surface-variant transition-colors hover:text-white">
        <div className="relative flex shrink-0 items-center justify-center mt-0.5">
          <input
            type="checkbox"
            required
            className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-outline-variant/50 bg-surface-container-high/50 transition-all checked:border-primary checked:bg-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:ring-offset-1 focus:ring-offset-background"
          />
          <span className="material-symbols-outlined pointer-events-none absolute text-[12px] text-background font-bold opacity-0 transition-opacity peer-checked:opacity-100">
            check
          </span>
        </div>
        <span className="leading-relaxed">
          I agree to the <a href="#" className="text-white underline decoration-outline-variant/50 underline-offset-2 transition-colors hover:decoration-white">Terms of Service</a> and <a href="#" className="text-white underline decoration-outline-variant/50 underline-offset-2 transition-colors hover:decoration-white">Privacy Policy</a>.
        </span>
      </label>
    </AuthShell>
  )
}

export default SignUpPage
