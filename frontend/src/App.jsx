import { Provider } from 'jotai'
import AppRouter from './app/AppRouter'

function App() {
  return (
    <Provider>
      <AppRouter />
    </Provider>
  )
}

export default App
