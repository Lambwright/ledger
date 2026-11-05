// T&M ticket backup on invoices (Ben, 2026-10-28: "Both") and draft Change
// Orders (2026-11-05). When LEDGER creates either one for T&M tickets (their
// hours or their materials), it attaches, for every ticket involved:
//   1. Procore's own ticket PDF (GET .../time_and_material_entries/{id}.pdf,
//      found 2026-11-03), which already shows the photos and signatures, plus
//      any non-image files on the ticket;
//   2. only if that PDF can't be had: a PDF made by LEDGER (project, ticket
//      number, date, description, hours per worker by time type, materials,
//      signature images or the signer's name / "Not signed") plus every file
//      attached to the ticket (photos, receipts).
// Invoice attachments go on by multipart PATCH with a top-level attachments[]
// field (api-directory, 2026-10-28). A Change Order ignores that: it takes
// Procore's two-step upload, then a JSON PATCH of upload_ids (2026-11-05).
// Direct cost and commitment backup is NOT attached (Ben: those are marked up;
// backup only on request).
// Never fails the invoice or CO: problems come back as a progress-log message.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { procoreRequest, procoreUpload, procoreDownload } from './procore.js';

const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const TIME_TYPE_LABEL = { 'Regular Time': 'Regular', Overtime: 'Overtime', 'Double Time': 'Double Time', 'Per Diem': 'Per Diem' };
const PAGE = [612, 792]; // US Letter
const M = 48;

// Rate limits: wait and retry instead of giving up (a 429 on the first call
// lost a test invoice's backup, 2026-11-02).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(call) {
  let res;
  for (const wait of [0, 2000, 5000, 10000, 20000]) {
    if (wait) await sleep(wait);
    res = await call();
    if (res.status !== 429) break;
  }
  return res;
}

async function getAll(env, path) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await withRetry(() => procoreRequest(env, 'GET', `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`));
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`${path.split('?')[0]} ${res.status}`);
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

// The standard PDF fonts only cover WinAnsi: swap common typographic
// characters and drop anything else rather than failing.
function clean(text) {
  return String(text ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
    .trim();
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function embedSignature(pdf, sig) {
  if (!sig?.url) return null;
  try {
    const bytes = await fetchBytes(sig.url);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await pdf.embedPng(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes);
  } catch { /* fall back to the signer's name */ }
  return null;
}

export async function ticketPdf({ entry, projectName, timecards, materials }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`T&M Ticket #${entry.number}`);
  pdf.setProducer('LEDGER (Einbau)');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.12, 0.12);
  const muted = rgb(0.42, 0.42, 0.42);
  let page = pdf.addPage(PAGE);
  let y = PAGE[1] - M;

  const ensure = (h) => { if (y - h < M + 24) { page = pdf.addPage(PAGE); y = PAGE[1] - M; } };
  const text = (str, { x = M, size = 10, f = font, color = ink } = {}) => page.drawText(clean(str), { x, y, size, font: f, color });
  const wrap = (str, width, size, f = font) => {
    const lines = [];
    let line = '';
    for (const w of clean(str).split(' ')) {
      const next = line ? `${line} ${w}` : w;
      if (line && f.widthOfTextAtSize(next, size) > width) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const rule = () => { page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: rgb(0.8, 0.8, 0.8) }); y -= 16; };
  const field = (label, value) => {
    if (!clean(value)) return;
    ensure(28);
    text(label, { size: 8, f: bold, color: muted });
    y -= 13;
    for (const l of wrap(value, PAGE[0] - 2 * M, 10)) { ensure(14); text(l); y -= 14; }
    y -= 4;
  };

  // Header
  text(`T&M TICKET #${entry.number}`, { size: 20, f: bold });
  y -= 18;
  if (projectName) { text(projectName, { size: 11, color: muted }); y -= 14; }
  text('Prepared by LEDGER (Einbau) from the Procore T&M ticket', { size: 8, color: muted });
  y -= 14;
  rule();
  field('WORK DATE', entry.work_performed_on_date || '');
  field('DESCRIPTION', entry.description || '');
  field('ORDERED BY', entry.ordered_by_party?.name || entry.ordered_by?.name || '');
  field('LOCATION', entry.location?.name || '');
  field('REFERENCE', entry.reference_number || '');

  // Labour
  const cols = [M, M + 260, M + 420];
  ensure(48);
  rule();
  text('LABOUR', { size: 9, f: bold });
  y -= 16;
  text('Worker', { x: cols[0], size: 8, f: bold, color: muted });
  text('Time type', { x: cols[1], size: 8, f: bold, color: muted });
  text('Hours', { x: cols[2], size: 8, f: bold, color: muted });
  y -= 14;
  const totals = {};
  if (timecards.length === 0) { text('No hours recorded on this ticket.', { color: muted }); y -= 14; }
  for (const tc of timecards) {
    ensure(14);
    const type = tc.timecard_time_type?.time_type || '';
    const hours = Number(tc.hours_worked) || 0;
    totals[type] = (totals[type] || 0) + hours;
    text(wrap(tc.party?.name || 'Worker', 250, 10)[0], { x: cols[0] });
    text(TIME_TYPE_LABEL[type] || type, { x: cols[1] });
    text(hours.toFixed(2), { x: cols[2] });
    y -= 14;
  }
  for (const [type, hours] of Object.entries(totals)) {
    ensure(14);
    text(`Total ${TIME_TYPE_LABEL[type] || type}`, { x: cols[1], f: bold });
    text(hours.toFixed(2), { x: cols[2], f: bold });
    y -= 14;
  }

  // Materials
  if (materials.length > 0) {
    ensure(48);
    y -= 4;
    rule();
    text('MATERIALS', { size: 9, f: bold });
    y -= 16;
    text('Material', { x: cols[0], size: 8, f: bold, color: muted });
    text('Quantity', { x: cols[2], size: 8, f: bold, color: muted });
    y -= 14;
    for (const m of materials) {
      ensure(14);
      const name = [m.name, m.description].map(clean).filter(Boolean).join(' - ') || 'Material';
      text(wrap(name, 400, 10)[0], { x: cols[0] });
      text(`${m.quantity ?? ''} ${m.uom || ''}`.trim(), { x: cols[2] });
      y -= 14;
    }
  }

  // Signatures
  const sigs = [
    { role: 'CUSTOMER', s: entry.customer_signature, party: entry.customer_signee_party },
    { role: 'EINBAU', s: entry.company_signature, party: entry.company_signee_party }
  ];
  ensure(130);
  y -= 6;
  rule();
  text('SIGNATURES', { size: 9, f: bold });
  y -= 16;
  const top = y;
  for (const [i, sig] of sigs.entries()) {
    const x = M + i * 270;
    const image = await embedSignature(pdf, sig.s);
    page.drawText(sig.role, { x, y: top, size: 8, font: bold, color: muted });
    if (image) {
      const dims = image.scaleToFit(210, 56);
      page.drawImage(image, { x, y: top - 66, width: dims.width, height: dims.height });
    } else {
      page.drawText(sig.s ? '(signature on file in Procore)' : 'Not signed', { x, y: top - 40, size: 10, font, color: muted });
    }
    page.drawLine({ start: { x, y: top - 72 }, end: { x: x + 230, y: top - 72 }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) });
    const name = sig.party?.name || sig.s?.created_by?.name || '';
    if (name) page.drawText(clean(name), { x, y: top - 86, size: 10, font, color: ink });
    if (sig.s?.created_at) page.drawText(`Signed ${String(sig.s.created_at).slice(0, 10)}`, { x, y: top - 98, size: 8, font, color: muted });
  }

  page.drawText(clean(`Generated ${new Date().toISOString().slice(0, 10)} from Procore T&M ticket #${entry.number}. Hours are as recorded on the ticket.`),
    { x: M, y: M - 12, size: 7, font, color: muted });
  return pdf.save();
}

// Procore's two-step upload: create the upload, post the bytes to the storage
// URL it hands back. Returns the id that upload_ids takes.
async function uploadFile(env, projectId, f) {
  const created = await withRetry(() => procoreRequest(env, 'POST', `/rest/v1.1/projects/${projectId}/uploads`, {
    response_filename: f.name, response_content_type: f.type
  }));
  if (created.status !== 201 || !created.data?.url || !created.data?.uuid) throw new Error(`create ${created.status}`);
  const form = new FormData();
  for (const [k, v] of Object.entries(created.data.fields || {})) form.append(k, v);
  form.append('file', new Blob([f.bytes], { type: f.type }), f.name);
  const stored = await fetch(created.data.url, { method: 'POST', body: form });
  if (!stored.ok) throw new Error(`storage ${stored.status}`);
  return created.data.uuid;
}

// Pass contractId + invoiceId for an invoice, or changeOrderId for a Change Order.
export async function attachTicketBackup(env, { projectId, contractId, invoiceId, changeOrderId, entryIds, onProgress = () => {} }) {
  const ids = [...new Set((entryIds || []).map(String))];
  if (ids.length === 0 || !(changeOrderId || (contractId && invoiceId))) return { attached: 0, problems: [] };
  const target = changeOrderId ? 'Change Order' : 'invoice';
  try {
    onProgress({ message: `${changeOrderId ? 'Draft Change Order' : 'Invoice'} done and recorded. Attaching backup for ${ids.length} T&M ticket(s)…` });
    const entries = await getAll(env, `/rest/v1.0/projects/${projectId}/time_and_material_entries`);
    // Only needed if Procore's own PDF can't be had and LEDGER builds one.
    let fallbackData = null;
    const loadFallback = async () => {
      if (fallbackData) return fallbackData;
      const [timecards, materials, project] = await Promise.all([
        getAll(env, `/rest/v1.0/projects/${projectId}/time_and_material_timecards`),
        getAll(env, `/rest/v1.0/projects/${projectId}/materials`).catch(() => []),
        withRetry(() => procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}?company_id=${env.PROCORE_COMPANY_ID}`)).catch(() => null)
      ]);
      const projectName = project?.status === 200
        ? [project.data.project_number, project.data.name].filter(Boolean).join(' ')
        : '';
      return (fallbackData = { timecards, materials, projectName });
    };
    const problems = [];
    // Upload in batches as files come in, so neither a single request nor the
    // worker's memory (128MB — a ticket can carry 20+ phone photos) gets too big.
    let attached = 0;
    let batch = [];
    let size = 0;
    const send = async (files) => {
      if (changeOrderId) {
        const uploadIds = [];
        for (const f of files) uploadIds.push(await uploadFile(env, projectId, f));
        // upload_ids adds to what's already on the CO, it doesn't replace it.
        return withRetry(() => procoreRequest(env, 'PATCH', `/rest/v1.0/projects/${projectId}/prime_change_orders/${changeOrderId}`, {
          change_order: { upload_ids: uploadIds }
        }));
      }
      // A fresh form per attempt: a sent FormData body can't be reused.
      return withRetry(() => {
        const form = new FormData();
        form.append('project_id', String(projectId));
        for (const f of files) form.append('attachments[]', new Blob([f.bytes], { type: f.type }), f.name);
        return procoreUpload(env, 'PATCH', `/rest/v1.0/prime_contracts/${contractId}/payment_applications/${invoiceId}?project_id=${projectId}`, form);
      });
    };
    const flush = async () => {
      if (batch.length === 0) return;
      try {
        const res = await send(batch);
        if (res.status === 200) attached += batch.length;
        else problems.push(`upload ${res.status}`);
      } catch (e) {
        problems.push(`upload ${e.message}`);
      }
      batch = [];
      size = 0;
    };
    const add = async (f) => {
      if (size + f.bytes.length > MAX_BATCH_BYTES) await flush();
      batch.push(f);
      size += f.bytes.length;
    };
    for (const entry of entries.filter(e => ids.includes(String(e.id))).sort((a, b) => a.number - b.number)) {
      // Procore's own ticket PDF (the same one as Export in Procore) already
      // shows the photos and signatures, so only non-image files go alongside it.
      const own = await withRetry(() => procoreDownload(env, `/rest/v1.0/projects/${projectId}/time_and_material_entries/${entry.id}.pdf`)).catch(() => null);
      const procorePdf = own?.status === 200 && own.bytes?.length > 0;
      if (procorePdf) {
        await add({ name: `T&M-${entry.number}.pdf`, type: 'application/pdf', bytes: own.bytes });
      } else {
        try {
          const { timecards, materials, projectName } = await loadFallback();
          const bytes = await ticketPdf({
            entry,
            projectName,
            timecards: timecards.filter(tc => String(tc.time_and_material_entry?.id) === String(entry.id)),
            materials: materials.filter(m => String(m.time_and_material_entry_id) === String(entry.id) && !m.deleted_at)
          });
          await add({ name: `T&M-${entry.number}.pdf`, type: 'application/pdf', bytes });
        } catch (e) {
          problems.push(`T&M #${entry.number} PDF: ${e.message}`);
        }
      }
      for (const att of entry.time_and_material_entry_attachments || []) {
        if (procorePdf && String(att.content_type || '').startsWith('image/')) continue;
        const url = att.url || att.presentation_url;
        if (!url) continue;
        try {
          const bytes = await fetchBytes(url);
          await add({ name: `T&M-${entry.number} - ${att.filename || 'attachment'}`, type: att.content_type || 'application/octet-stream', bytes });
        } catch (e) {
          problems.push(`T&M #${entry.number} "${att.filename}": ${e.message}`);
        }
      }
    }
    await flush();
    onProgress({
      message: problems.length
        ? `Attached ${attached} backup file(s); couldn't attach: ${problems.join('; ')}`
        : `Attached ${attached} backup file(s): the T&M ticket PDF(s)${attached > ids.length ? ' and other ticket files' : ''}`
    });
    return { attached, problems };
  } catch (e) {
    onProgress({ message: `Couldn't attach the T&M ticket backup (the ${target} itself is fine): ${e.message}` });
    return { attached: 0, problems: [e.message] };
  }
}
