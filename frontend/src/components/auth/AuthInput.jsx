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
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="text-[13px] font-medium text-white/80 ml-1"
      >
        {label}
      </label>

      <div className="relative group">
        <span className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[18px] text-outline transition-colors group-focus-within:text-primary">
          {icon}
        </span>

        <input
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          className="w-full rounded-xl border border-outline-variant/30 bg-surface-container-high/30 px-11 py-3 text-sm text-white outline-none transition-all duration-300 placeholder:text-outline focus:border-primary/50 focus:bg-surface-container-high/60 focus:ring-4 focus:ring-primary/10 shadow-[inset_0_2px_4px_rgba(0,0,0,0.1)]"
        />
      </div>
    </div>
  )
}

export default AuthInput
