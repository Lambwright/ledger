// LEDGER worker's /portfolio route — authenticated with the Einbau ID token,
// never the sidebar's frontend key. It only ever reads LEDGER's stored
// snapshot rows, except 'refresh_project', which re-pulls one project live.
import { getStoredToken } from "./auth.js";

const WORKER_URL = import.meta.env.VITE_WORKER_URL || "https://ledger.ben-a90.workers.dev";

async function call(action, payload = {}) {
  const res = await fetch(`${WORKER_URL}/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getStoredToken()}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.unauthorized = res.status === 401;
    throw err;
  }
  return data;
}

export const api = {
  list: () => call("list"),
  refreshProject: (projectId) => call("refresh_project", { project_id: projectId }),
};
