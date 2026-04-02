function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-xl rounded-xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <p className="text-sm font-medium uppercase tracking-wider text-slate-500">
          Setup Complete
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">
          React + Tailwind CSS v3
        </h1>
        <p className="mt-4 text-slate-600">
          Your frontend is ready. Start building UI in{' '}
          <code className="rounded bg-slate-100 px-2 py-1 text-sm text-slate-800">
            src/App.jsx
          </code>{' '}
          with Tailwind utility classes.
        </p>
      </div>
    </main>
  )
}

export default App
