import { lazy, Suspense, useEffect } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import WelcomePage from '../pages/WelcomePage';
import AppShell from '../components/layout/AppShell'
import DashboardPage from '../pages/DashboardPage'
import LoginPage from '../pages/LoginPage'
import NotFoundPage from '../pages/NotFoundPage'
import SignUpPage from '../pages/SignUpPage'

const AgentLibraryPage = lazy(() => import('../pages/AgentLibraryPage'))
const AgentEditorPage = lazy(() => import('../pages/AgentEditorPage'))
const AgentWorkspaceLayout = lazy(() => import('../components/agents/AgentWorkspaceLayout'))
const TeamLibraryPage = lazy(() => import('../pages/TeamLibraryPage'))
const TeamEditorPage = lazy(() => import('../pages/TeamEditorPage'))
const TeamWorkspaceLayout = lazy(() => import('../components/teams/TeamWorkspaceLayout'))
const OrchestrationChatPage = lazy(() => import('../pages/OrchestrationChatPage'))
const DeploymentPage = lazy(() => import('../pages/DeploymentPage'))
const TemplateLibraryPage = lazy(() => import('../pages/TemplateLibraryPage'))

function AgentRouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status">
      <p className="font-headline text-[10px] font-semibold uppercase tracking-[0.24em] text-content-supporting">Loading Agent Forge…</p>
    </div>
  )
}

function LazyAgentRoute({ children }) {
  return <Suspense fallback={<AgentRouteFallback />}>{children}</Suspense>
}

function LazyChatRoute({ children }) {
  return (
    <Suspense fallback={(
      <div className="flex min-h-[calc(100vh-6rem)] items-center justify-center bg-black" role="status">
        <p className="font-headline text-sm font-medium text-content-secondary">Loading Chat…</p>
      </div>
    )}>
      {children}
    </Suspense>
  )
}

function ProtectedRoute({ children }) {
  const { token, isInitializing, authError, loadMe } = useAuth();
  
  if (isInitializing) {
     return (
       <div className="min-h-screen flex items-center justify-center bg-black">
         <p className="font-headline text-[11px] font-bold uppercase tracking-[0.3em] text-content-supporting animate-pulse">
           Initializing...
         </p>
       </div>
     );
  }

  if (authError && token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
        <div className="max-w-md text-center">
          <h1 className="font-headline text-2xl font-semibold">AgentFlow is unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-content-supporting">{authError}</p>
          <button
            type="button"
            onClick={() => loadMe().catch(() => {})}
            className="mt-6 min-h-11 rounded-full bg-white px-6 text-sm font-semibold text-black transition-colors hover:bg-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            Retry connection
          </button>
        </div>
      </main>
    )
  }
  
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function AppRouter() {
  const { loadMe } = useAuth();

  useEffect(() => {
    loadMe().catch(() => {});
  }, [loadMe]);

  return (
    <Routes>
      <Route path="/" element={<WelcomePage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="signup" element={<SignUpPage />} />

      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="agents" element={<LazyAgentRoute><AgentWorkspaceLayout /></LazyAgentRoute>}>
          <Route index element={<AgentLibraryPage />} />
          <Route path="new" element={<AgentEditorPage />} />
          <Route path=":agentId" element={<AgentEditorPage />} />
        </Route>
        <Route path="teams" element={<LazyAgentRoute><TeamWorkspaceLayout /></LazyAgentRoute>}>
          <Route index element={<TeamLibraryPage />} />
          <Route path="new" element={<TeamEditorPage />} />
          <Route path=":teamId" element={<TeamEditorPage />} />
        </Route>
        <Route path="chat" element={<LazyChatRoute><OrchestrationChatPage /></LazyChatRoute>} />
        <Route path="templates" element={<LazyAgentRoute><TemplateLibraryPage /></LazyAgentRoute>} />
        <Route path="deployments" element={<LazyAgentRoute><DeploymentPage /></LazyAgentRoute>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default AppRouter
