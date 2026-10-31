# AgentFlow frontend

This directory contains the AgentFlow product UI. It is a React application built with Vite, Tailwind CSS, Jotai, and Framer Motion. The frontend talks to the Go backend; it does not read MongoDB or communicate with deployed agent runtimes directly.

## Local startup

Start the backend on port `9090`, then run:

```bash
npm install
npm run dev
```

Open the URL printed by Vite. During local development, requests beginning with `/api` are proxied to `http://localhost:9090`, so the browser sees the UI and API as one origin.

To use a different local backend address:

```bash
VITE_DEV_API_TARGET=http://localhost:8080 npm run dev
```

To make browser requests directly to an explicit API URL instead of using the relative `/api` prefix:

```bash
VITE_API_BASE_URL=http://localhost:9090/api npm run dev
```

The proxy is the preferred local setup because it avoids unnecessary browser CORS configuration. `VITE_API_BASE_URL` remains useful when the UI and API are intentionally hosted on different origins.

## Commands

```bash
npm run dev      # start the local Vite development server
npm run build    # create a production bundle
npm run lint     # run ESLint
npm test         # run the Vitest test suite once
npm run preview  # serve the production bundle locally
```

## Current product surface

The implemented authenticated surface currently includes:

- signup, login, session restoration, and logout;
- protected application routes;
- a real workspace dashboard backed by the overview, capability, thread, run, agent, and agent-team APIs;
- explicit loading, empty, backend-error, expired-session, and retry states.

The Agents, Teams, and Studio routes still need their full product workflows. They are separate vertical slices, not hidden behavior in the dashboard.

## API configuration and authentication

All ordinary JSON requests go through `src/api/client.js`. The client:

- builds URLs from one configured base path;
- attaches the current bearer token;
- serializes JSON request bodies;
- decodes JSON responses;
- converts backend and network failures into `ApiError` values;
- invalidates the local session when an authenticated request returns `401`.

The token is persisted in browser `localStorage` under `agentflow_token`. On application startup, the frontend calls `/api/auth/me` before rendering protected content. A `401` means the token is no longer valid and sends the user to login. A temporary network failure is different: the token is retained and the UI presents a retry action.

Do not call `fetch` directly from product pages for ordinary JSON endpoints. Use `useApiClient()` so authentication and failure behavior remain consistent.

## Tests

Vitest runs in a JSDOM browser-like environment. The first tests cover:

- API headers, JSON encoding, backend errors, network failures, and `401` handling;
- successful login and expired-session cleanup;
- dashboard loading, real-data, and retry states.

The test suite is intentionally focused on public behavior. It mocks the network boundary rather than depending on a locally running backend.

For the deeper design, data flow, boundaries, and next implementation slices, read [`../FRONTEND_ARCHITECTURE_GUIDE.md`](../FRONTEND_ARCHITECTURE_GUIDE.md).
