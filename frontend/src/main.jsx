import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import PreviewEditPopout from './PreviewEditPopout.jsx'
import TicketDetailPopout from './TicketDetailPopout.jsx'
import DirectCostDetailPopout from './DirectCostDetailPopout.jsx'
import AuthGate from './AuthGate.jsx'

// Popped-out windows (Ben's ask 2026-09-15) load this SAME app bundle at the
// same URL, distinguished only by a `view` param — there's no server-side
// routing here, just picking which top-level component to mount.
const view = new URLSearchParams(window.location.search).get('view');
const Root = view === 'preview_edit' ? PreviewEditPopout
  : view === 'ticket_detail' ? TicketDetailPopout
  : view === 'direct_cost_detail' ? DirectCostDetailPopout
  : App;

// The preview/edit popout never calls the API (it talks to its opener), so
// it's the one view without the sign-in gate.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    {Root === PreviewEditPopout
      ? <Root />
      : <AuthGate>{(user, signOut) => <Root user={user} onSignOut={signOut} />}</AuthGate>}
  </StrictMode>,
)
