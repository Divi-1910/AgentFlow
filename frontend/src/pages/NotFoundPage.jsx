import { Link } from 'react-router-dom'

function NotFoundPage() {
  return (
    <section className="flex min-h-[70vh] items-center justify-center">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-outline">
          404
        </p>
        <h2 className="mt-2 font-headline text-3xl font-semibold text-on-surface">
          Page not found
        </h2>
        <p className="mt-2 text-sm text-on-surface-variant">
          The route does not exist in this starter setup.
        </p>
        <Link
          to="/"
          className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary-container"
        >
          Back to overview
        </Link>
      </div>
    </section>
  )
}

export default NotFoundPage
