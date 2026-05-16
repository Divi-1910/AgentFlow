import { Provider } from 'jotai'
import AppRouter from './app/AppRouter'

function App() {
  return (
    <Provider>
      <AppRouter />

      {/*
        ── Page-transition overlay ───────────────────────────────
        Fixed over everything (z-9999). Hidden by default (display:none).
        GSAP sets display:flex when a transition fires, then resets to
        display:none at the end so it never blocks interaction at rest.

        The repeating-linear-gradient scan-line texture adds a subtle
        analogue film feel consistent with the global grain overlay.
      */}
      <div
        id="page-transition-overlay"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          background: '#000',
          backgroundImage: [
            /* Horizontal scan lines — CRT feel */
            'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(255,255,255,0.016) 2px, rgba(255,255,255,0.016) 4px)',
          ].join(','),
        }}
      >
        {/*
          Stamp — the AgentFlow wordmark that pulses at the peak of
          long transitions (home ↔ auth). Fades in/out via GSAP.
          Starts invisible; GSAP brings it to opacity:1 at the right moment.
        */}
        <div
          id="pt-stamp"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            opacity: 0,
            userSelect: 'none',
          }}
        >
          {/* Logo mark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 56, height: 56,
              borderRadius: 16,
              background: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 40px rgba(255,255,255,0.25), 0 0 80px rgba(255,255,255,0.10)',
            }}>
              <span
                className="material-symbols-outlined"
                style={{ fontSize: 28, color: '#000', lineHeight: 1 }}
              >
                hive
              </span>
            </div>
            <span style={{
              fontFamily: "'Clash Display', 'Trebuchet MS', sans-serif",
              fontSize: '2rem',
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: '#fff',
            }}>
              Agent
              <span style={{
                fontWeight: 300,
                fontStyle: 'italic',
                opacity: 0.40,
              }}>
                Flow
              </span>
            </span>
          </div>

          {/* Thin ruled separator below logo */}
          <div style={{
            width: 48,
            height: 1,
            background: 'rgba(255,255,255,0.10)',
          }} />
        </div>
      </div>
    </Provider>
  )
}

export default App
