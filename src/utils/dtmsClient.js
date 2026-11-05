// DTMS integration for the PPMP app. Talks to server/dtms-proxy.js, never to DTMS directly.
import { APPROVAL_CHAIN, getPpmpStatus } from './procurementRules.js';
import { buildPPMP_PDF_Blob } from './pdfGenerator.js';

const PROXY = import.meta.env?.VITE_DTMS_PROXY || 'http://localhost:3001/api/dtms';

// Emails of the approvers as registered in DTMS (must be ACTIVE DTMS users).
// HEAD depends on the office (record.end_user); the other three are fixed.
export const DTMS_APPROVERS = {
  HEAD: { 'ICT Literacy Competency and Development Bureau X': 'head.example@dict.gov.ph' }, // office -> email
  TOD: 'tod.chief@dict.gov.ph',
  BO: 'budget.officer@dict.gov.ph',
  RD: 'regional.director@dict.gov.ph'
};

export function buildSignatories(record) {
  const headEmail = DTMS_APPROVERS.HEAD[record.end_user];
  if (!headEmail) throw new Error(`No DTMS email configured for the Unit Head of "${record.end_user}".`);
  const emailFor = { HEAD: headEmail, TOD: DTMS_APPROVERS.TOD, BO: DTMS_APPROVERS.BO, RD: DTMS_APPROVERS.RD };
  return APPROVAL_CHAIN.map((step, i) => ({ email: emailFor[step.role], role: 'reviewer', order: i }));
  // 'reviewer' = approve/decline. Use 'signer' if DTMS must put a digital signature on the PDF.
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.detail || (body.errors && Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join('; ')) || res.statusText;
    throw new Error(`DTMS ${res.status}: ${detail}`);
  }
  return body;
}

export async function submitPpmpToDtms(record, session) {
  const pdf = await buildPPMP_PDF_Blob(record);
  const form = new FormData();
  form.append('title', `PPMP No. ${record.ppmp_no} — ${record.end_user}`.slice(0, 100));
  form.append('requestor', (session?.roleName || record.submitted_by?.name || 'PPMP System').slice(0, 100));
  form.append('position', (session?.role || 'Unit').slice(0, 100));
  form.append('message', `PPMP No. ${record.ppmp_no} (FY ${record.fiscal_year}) of ${record.end_user} for approval.`);
  form.append('signatories', JSON.stringify(buildSignatories(record)));
  form.append('files', pdf, `PPMP_${record.ppmp_no}.pdf`);
  const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));
  return { tracknumber: out.tracknumber, submitted_at: Date.now() };
}

export const fetchDtmsStatus = async (track) => asJson(await fetch(`${PROXY}/status/${encodeURIComponent(track)}`));

// Copy DTMS state into the local record. Returns true if the record changed.
export function applyDtmsStatus(record, dtms) {
  if (!record.dtms_track || getPpmpStatus(record) !== 'For Approval') return false;
  const before = JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
  record.dtms_last = `${dtms.status}|${dtms.progress?.signed}`;
  record.dtms_waiting_on = dtms.waiting_on || [];

  if (dtms.status === 'completed') {
    record.status = 'Completed';
    record.currentApproverRole = 'None';
    record.is_indicative = 'Final';
    record.approved_at = Date.now();
    record.approved_by = { name: 'DTMS', role: 'DTMS', email: '' };
    if (dtms.assigned_number) record.dtms_reference = dtms.assigned_number;
  } else if (dtms.status === 'rejected') {
    const who = (dtms.signatories || []).find(s => s.status === 'rejected');
    record.status = 'Draft';
    record.currentApproverRole = null;
    record.returned_for_revision = true;
    record.rejected_at = Date.now();
    record.rejected_by = { name: who?.name || 'DTMS', role: 'DTMS', email: who?.email || '', stage: '' };
    (record.remarksHistory ||= []).push({ stage: '', role: 'DTMS', name: who?.name || 'DTMS', action: 'rejected',
      remarks: who?.reason || 'Rejected in DTMS.', round: Number(record.submission_round) || 1,
      date: new Date().toLocaleDateString(), at: Date.now() });
    record.dtms_track = null; // next submission creates a new DTMS document
  } else {
    // for_signing: show the step currently waiting (by how many steps are done)
    const done = Math.min(dtms.progress?.signed ?? 0, APPROVAL_CHAIN.length - 1);
    record.currentApproverRole = APPROVAL_CHAIN[done].role;
  }
  return before !== JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
}

// Poll every record that is waiting in DTMS. Call on app start and every 30-60 s.
export async function syncAllWithDtms() {
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  let changed = false;
  for (const r of all) {
    if (!r.dtms_track || getPpmpStatus(r) !== 'For Approval') continue;
    try { changed = applyDtmsStatus(r, await fetchDtmsStatus(r.dtms_track)) || changed; }
    catch (e) { console.warn('DTMS sync failed for', r.ppmp_no, e.message); }
  }
  if (changed) localStorage.setItem('procurement_records', JSON.stringify(all));
  return changed;
}
