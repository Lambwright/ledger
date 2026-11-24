// LEDGER's Procore usage this hour, for the loading animation (Ben,
// 2026-11-19). One shared poller however many loaders are on screen; it only
// runs while at least one is. Each poll reads LEDGER's own count (worker
// procore.js rateStatus) — it never calls Procore.
import { getRateStatus } from './api';
import { getToken } from './auth';

const subscribers = new Set();
let timer = null;
let last = null;

async function poll() {
  if (!getToken()) return; // signed out: nothing to ask, and a refused call is noise in HELM's Security tab
  try {
    last = await getRateStatus();
    subscribers.forEach((fn) => fn(last));
  } catch {
    // The meter is optional; never let it get in the way.
  }
}

export function subscribeRate(fn) {
  subscribers.add(fn);
  if (last) fn(last);
  if (!timer) {
    poll();
    timer = setInterval(poll, 4000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// What the loader shows for a status: { strain 0–3, dead, text }.
export function describeRate(s) {
  if (!s) return null;
  if (s.exhausted) {
    return { dead: true, strain: 3, text: `LEDGER's out of Procore calls${s.resetAt ? ` — fresh ones at ${clock(s.resetAt)}` : ''}` };
  }
  const share = s.limit ? s.used / s.limit : 0;
  const strain = share >= 0.92 ? 3 : share >= 0.8 ? 2 : share >= 0.6 ? 1 : 0;
  return {
    dead: false,
    strain,
    text: `${s.used} of ${s.limit} Procore calls this hour${strain > 0 && s.resetAt ? ` · fresh at ${clock(s.resetAt)}` : ''}`
  };
}
