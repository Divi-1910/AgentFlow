import { Route, Routes } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import AgentLibraryPage from '../pages/AgentLibraryPage'
import DashboardPage from '../pages/DashboardPage'
import LoginPage from '../pages/LoginPage'
import NotFoundPage from '../pages/NotFoundPage'
import OrchestrationChatPage from '../pages/OrchestrationChatPage'
import SignUpPage from '../pages/SignUpPage'
import TeamLibraryPage from '../pages/TeamLibraryPage'

function AppRouter() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="signup" element={<SignUpPage />} />

      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="agents" element={<AgentLibraryPage />} />
        <Route path="teams" element={<TeamLibraryPage />} />
        <Route path="chat" element={<OrchestrationChatPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default AppRouter
