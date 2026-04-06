import { useEffect } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import WelcomePage from '../pages/WelcomePage';
import AppShell from '../components/layout/AppShell'
import AgentLibraryPage from '../pages/AgentLibraryPage'
import DashboardPage from '../pages/DashboardPage'
import LoginPage from '../pages/LoginPage'
import NotFoundPage from '../pages/NotFoundPage'
import OrchestrationChatPage from '../pages/OrchestrationChatPage'
import SignUpPage from '../pages/SignUpPage'
import TeamLibraryPage from '../pages/TeamLibraryPage'

function ProtectedRoute({ children }) {
  const { token, isInitializing } = useAuth();
  
  if (isInitializing) {
     return (
       <div className="min-h-screen flex items-center justify-center bg-black">
         <p className="font-headline text-[11px] font-bold uppercase tracking-[0.3em] text-white/50 animate-pulse">
           Initializing...
         </p>
       </div>
     );
  }
  
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function AppRouter() {
  const { loadMe } = useAuth();

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  return (
    <Routes>
      <Route path="/" element={<WelcomePage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="signup" element={<SignUpPage />} />

      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="agents" element={<AgentLibraryPage />} />
        <Route path="teams" element={<TeamLibraryPage />} />
        <Route path="chat" element={<OrchestrationChatPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default AppRouter
