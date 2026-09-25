// Procore Side Panel context handshake.
//
// Procore does NOT append company/project/resource/view to the iframe URL for
// side-panel apps. The app posts `{type:'initialize'}` to the parent window;
// Procore replies with a `{type:'setup'}` message whose `context` carries:
//   context.company_id, context.project_id, context.id (the open record's id),
//   context.view
// plus lifecycle messages: sidepanel:app:visible / :hidden / :destroy.
// Docs: developers.procore.com — "Building Embedded Applications".

export function isEmbedded() {
  try {
    return window.parent && window.parent !== window;
  } catch {
    return true; // cross-origin parent access threw → we're framed
  }
}

function isProcoreOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'procore.com' || host.endsWith('.procore.com');
  } catch {
    return false;
  }
}

// Starts the handshake. Calls `onContext({ companyId, projectId, resourceId,
// view, raw })` whenever Procore sends setup context. Returns a cleanup fn.
export function connectProcoreSidePanel({ onContext, onVisible, onHidden } = {}) {
  function handleMessage(event) {
    if (!isProcoreOrigin(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // Left in on purpose: makes the first real embed self-diagnosing — if
    // Procore's message shape differs from what's coded here, it's visible in
    // the panel's console instead of failing silently.
    console.info('[LEDGER] Procore message:', event.origin, JSON.stringify(data));

    if (data.type === 'setup' && data.context) {
      const c = data.context;
      onContext?.({
        companyId: c.company_id != null ? String(c.company_id) : null,
        projectId: c.project_id != null ? String(c.project_id) : null,
        resourceId: c.id != null ? String(c.id) : null,
        view: c.view ?? null,
        // The real Procore host this instance is on (e.g. https://us02.procore.com)
        // — use it to build deep links instead of hardcoding a region.
        origin: event.origin,
        raw: c,
      });
    } else if (data.type === 'sidepanel:app:visible') {
      onVisible?.();
    } else if (data.type === 'sidepanel:app:hidden') {
      onHidden?.();
    }
  }

  window.addEventListener('message', handleMessage);

  // Ping the parent for context. targetOrigin '*' is acceptable here — the
  // payload is non-sensitive ({type:'initialize'}), and every inbound message
  // is origin-checked against *.procore.com before we trust it. Retry a few
  // times in case Procore's listener isn't ready on our first frame.
  let tries = 0;
  function ping() {
    if (!isEmbedded()) return;
    try {
      window.parent.postMessage({ type: 'initialize' }, '*');
    } catch {
      /* ignore */
    }
    if (++tries < 6) setTimeout(ping, 400);
  }
  ping();

  return () => window.removeEventListener('message', handleMessage);
}
