function AuthInput({
  id,
  name,
  label,
  type = 'text',
  autoComplete,
  placeholder,
  icon,
  required = true,
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <label
        htmlFor={id}
        className="ml-1 font-headline text-[11px] font-bold uppercase tracking-[0.15em] text-white/50"
      >
        {label}
      </label>

      <div className="group relative">
        <span className="material-symbols-outlined pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-[20px] text-white/30 transition-colors group-focus-within:text-white">
          {icon}
        </span>

        <input
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          className="w-full rounded-2xl border border-white/10 bg-white/[0.02] px-12 py-4 text-[15px] font-light text-white outline-none transition-all duration-300 placeholder:text-white/20 focus:border-white/40 focus:bg-white/[0.05] focus:ring-4 focus:ring-white/10 shadow-[inset_0_2px_8px_rgba(0,0,0,0.5)]"
        />
      </div>
    </div>
  )
}

export default AuthInput;
