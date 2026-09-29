import { useEffect, useRef, useState } from 'react';
import { searchProjects } from './api';

// Project picker for LEDGER opened outside Procore — the phone / home-screen
// app (2026-09-29). Inside Procore the side panel already knows the project.
// Searches the project list the company portfolio keeps (no Procore calls)
// and remembers the last few projects on this device.

const RECENTS_KEY = 'ledger_recent_projects';
const MAX_RECENTS = 6;

export function recentProjects() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberProject(p) {
  const entry = { project_id: String(p.project_id), name: p.name, project_number: p.project_number || null };
  const next = [entry, ...recentProjects().filter((r) => r.project_id !== entry.project_id)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked — recents just won't persist */
  }
}

const label = (p) => [p.name, p.project_number].filter(Boolean).join(' · ');

export default function ProjectPicker({ projectId, onPick }) {
  const [current, setCurrent] = useState(() => recentProjects().find((r) => r.project_id === String(projectId)) || null);
  const [open, setOpen] = useState(!projectId);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // Opened by link (e.g. the portfolio's "Open in LEDGER") — put a name to the id.
  useEffect(() => {
    if (!projectId || current?.project_id === String(projectId)) return;
    let stale = false;
    searchProjects({ query: String(projectId) })
      .then(({ projects }) => {
        const match = projects.find((p) => String(p.project_id) === String(projectId));
        if (!stale && match) {
          rememberProject(match);
          setCurrent(match);
        }
      })
      .catch(() => {});
    return () => { stale = true; };
  }, [projectId, current]);

  // Debounced search as you type.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      return undefined;
    }
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchProjects({ query: q })
        .then(({ projects }) => { if (!stale) { setResults(projects); setError(null); } })
        .catch((e) => { if (!stale) setError(e.message); })
        .finally(() => { if (!stale) setSearching(false); });
    }, 250);
    return () => { stale = true; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function pick(p) {
    rememberProject(p);
    setCurrent(p);
    setOpen(false);
    setQuery('');
    onPick(String(p.project_id));
  }

  if (!open) {
    return (
      <div className="project-picked">
        <div className="project-picked-name">
          {current ? label(current) : `Project ${projectId}`}
          {current?.stage && <span className="project-picked-stage">{current.stage}</span>}
        </div>
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>Change</button>
      </div>
    );
  }

  const recents = recentProjects().filter((r) => r.project_id !== String(projectId));
  return (
    <div className="project-picker">
      <input
        ref={inputRef}
        type="search"
        inputMode="search"
        placeholder="Search projects by name or number"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="banner banner-error">{error}</div>}
      {query.trim().length >= 2 ? (
        <div className="project-options">
          {searching && results.length === 0 && <div className="project-option-note">Searching…</div>}
          {!searching && results.length === 0 && !error && <div className="project-option-note">No projects match.</div>}
          {results.map((p) => (
            <button type="button" key={p.project_id} className="project-option" onClick={() => pick(p)}>
              <span className="project-option-name">{p.name}</span>
              <span className="project-option-meta">{[p.project_number, p.stage].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </div>
      ) : recents.length > 0 ? (
        <div className="project-options">
          <div className="project-option-note">Recent</div>
          {recents.map((p) => (
            <button type="button" key={p.project_id} className="project-option" onClick={() => pick(p)}>
              <span className="project-option-name">{p.name}</span>
              <span className="project-option-meta">{p.project_number || ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      {projectId && (
        <button type="button" className="link-btn" onClick={() => { setOpen(false); setQuery(''); }}>Cancel</button>
      )}
    </div>
  );
}
