// ============================================================
// DTMS APPROVAL — sends PPMPs / the APP to DTMS for signing and mirrors the result back.
//
// Replaces the in-app chain (submitPpmpForApproval / performPpmpReviewAction) for records that are
// sent to DTMS. Records that already went through the old flow are left alone.
//
// All calls go to YOUR server at /api/dtms (see dtmsProxy.js). The DTMS API key never reaches the browser.
// ============================================================
import {
  APPROVAL_CHAIN,
  getRecordItems,
  calculateDeduplicatedBudget,
  getItemsMissingDocuments,
  getItemsBudgetModeMismatch,
  buildMissingDocsMessage,
  buildBudgetMismatchMessage,
  isPpmpDraft,
  recordApprovedPpmpNumber,
  getAllAppRecords,
  getAppRecord,
  saveAppRecord
} from './procurementRules.js';
import { previewPPMP_PDF, previewAPP_PDF } from './pdfGenerator.js';

// Turn off to fall back to the old in-app approval for new submissions.
export const DTMS_ENABLED = true;

const API = '/api/dtms';

// ------------------------------------------------------------
// WHO SIGNS  — fill in the DTMS email of each person.
//   heads : one Unit Head per office. The key must match the office name exactly as it is stored
//           on records (record.end_user / user.office).
//   shared: the same person for every office.
// Emails must belong to ACTIVE DTMS users; they are checked against DTMS on every submit.
// ------------------------------------------------------------
export const DTMS_ROUTING = {
  heads: {
    // 'Office name': 'unit.head@dict.gov.ph',
  },
  shared: {
    TOD: '',   // Chief, Technical Operations Division
    BO: '',    // Budget Officer
    RD: '',    // Regional Director
    ARD: ''    // Assistant Regional Director (APP only)
  }
};

// How each step acts in DTMS.  signer = signs the PDF · reviewer = approves or declines.
// PPMP: the PDF has signature lines for the TOD Chief and the Budget Officer, none for the Unit Head or RD.
// APP : the PDF has an "Endorsed by" (ARD) and an "Approved by" (RD) signature line.
const STEP_ROLE = {
  PPMP: { HEAD: 'reviewer', TOD: 'signer', BO: 'signer', RD: 'reviewer' },
  APP: { ARD: 'signer', RD: 'signer' }
};

const APP_CHAIN = [
  { role: 'ARD', label: 'Assistant Regional Director' },
  { role: 'RD', label: 'Regional Director' }
];

const fail = (error) => ({ success: false, error });

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------
function readRecords() {
  try { return JSON.parse(localStorage.getItem('procurement_records')) || []; } catch { return []; }
}
function writeRecords(all) {
  localStorage.setItem('procurement_records', JSON.stringify(all));
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, { credentials: 'include', ...options });
  } catch {
    throw new Error('Could not reach the DTMS service. Check your connection and try again.');
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = body?.errors ? Object.values(body.errors).join(' ') : body?.detail;
    const err = new Error(msg || `DTMS request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// DTMS people lookup, cached for 10 minutes. Gives the exact printed name and position, and proves the
// email belongs to an active DTMS user before anything is uploaded.
const peopleCache = new Map();
async function resolvePeople(emails) {
  const out = {};
  for (const email of emails) {
    const hit = peopleCache.get(email);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) { out[email] = hit.person; continue; }
    const r = await api(`/signatories?search=${encodeURIComponent(email)}&limit=5`);
    const person = (r.results || []).find((p) => String(p.email).toLowerCase() === email);
    if (!person) throw new Error(`No active DTMS user for ${email}. Ask an admin to correct the signatory setup.`);
    peopleCache.set(email, { at: Date.now(), person });
    out[email] = person;
  }
  return out;
}

const asSigner = (p) => (p ? { name: String(p.name || '').toUpperCase(), role: p.position } : undefined);

// DTMS has no "cancel", so a submit that timed out must be checked before it is sent again.
async function findSubmittedByTitle(title) {
  try {
    const r = await api('/documents?limit=50');
    return (r.results || []).find((d) => d.title === title) || null;
  } catch { return null; }
}

function buildDtmsBlock(prev, tracknumber, route) {
  return {
    tracknumber,
    route: route.map(({ stage, label, email, role, order }) => ({ stage, label, email, role, order })),
    submitted_at: Date.now(),
    last_seen: null,
    history: [...(prev?.history || []), ...(prev?.tracknumber ? [prev.tracknumber] : [])]
  };
}

// ------------------------------------------------------------
// ROUTE — the ordered list of DTMS signatories for one submission
// ------------------------------------------------------------
export function buildRoute(kind, office, session) {
  const chain = kind === 'APP' ? APP_CHAIN : APPROVAL_CHAIN;
  // A Unit Head submitting for their own unit already counts as endorsed, so the route starts at the TOD.
  const start = kind === 'PPMP' && session?.stage === 'HEAD' ? 1 : 0;
  const emailFor = (stage) => (stage === 'HEAD' ? DTMS_ROUTING.heads[office] : DTMS_ROUTING.shared[stage]);

  const steps = chain.slice(start).map((s, i) => ({
    stage: s.role,
    label: s.label,
    email: String(emailFor(s.role) || '').trim().toLowerCase(),
    role: STEP_ROLE[kind][s.role],
    order: i
  }));
  const missing = steps.filter((s) => !s.email).map((s) => s.label);
  if (missing.length) {
    throw new Error(`No DTMS signatory is set up for: ${missing.join(', ')}${office ? ` (${office})` : ''}.`);
  }
  return steps;
}

// ------------------------------------------------------------
// SUBMIT — PPMP
// ------------------------------------------------------------
export async function submitPpmpViaDtms(recordId, session) {
  if (!session) return fail('Not authenticated.');
  const record = readRecords().find((r) => r.id === recordId);
  if (!record) return fail('Record not found.');
  if (!isPpmpDraft(record)) return fail('This PPMP was already submitted for approval.');

  const missingDocs = getItemsMissingDocuments(record);
  if (missingDocs.length) return fail(buildMissingDocsMessage(missingDocs));
  const mismatch = getItemsBudgetModeMismatch(record);
  if (mismatch.length) return fail(buildBudgetMismatchMessage(mismatch));

  const round = (Number(record.submission_round) || 1) + (record.rejected_at ? 1 : 0);
  const title = `PPMP No. ${record.ppmp_no} (Round ${round}) FY ${record.fiscal_year} - ${record.end_user}`.slice(0, 100);

  let route;
  let tracknumber;
  try {
    route = buildRoute('PPMP', record.end_user, session);
    const people = await resolvePeople(route.map((s) => s.email));

    const existing = await findSubmittedByTitle(title);   // an earlier attempt that timed out
    tracknumber = existing?.tracknumber;

    if (!tracknumber) {
      const person = (stage) => people[route.find((s) => s.stage === stage)?.email];
      const { blob, fileName } = await previewPPMP_PDF(record, {
        preparedBy: { name: String(session.roleName || '').toUpperCase(), role: session.position },
        endorsedBy: asSigner(person('TOD')),
        certifiedBy: asSigner(person('BO'))
      });

      const total = calculateDeduplicatedBudget(getRecordItems(record));
      const form = new FormData();
      form.append('title', title);
      form.append('requestor', String(session.roleName || 'Requester').slice(0, 100));
      form.append('position', String(session.position || record.end_user || 'Requester').slice(0, 100));
      form.append('message',
        `PPMP No. ${record.ppmp_no} for FY ${record.fiscal_year}. End-user: ${record.end_user}. ` +
        `${getRecordItems(record).length} item(s), total estimated budget PHP ` +
        `${total.toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`);
      form.append('files', blob, fileName);
      form.append('signatories', JSON.stringify(route.map(({ email, role, order }) => ({ email, role, order }))));

      tracknumber = (await api('/submit', { method: 'POST', body: form })).tracknumber;
    }
  } catch (err) {
    return fail(err.message);
  }

  // Re-read: the network call took time and the stored records may have changed meanwhile.
  const all = readRecords();
  const rec = all.find((r) => r.id === recordId);
  if (!rec) return fail(`Sent to DTMS (Tracking No. ${tracknumber}) but the PPMP could not be found locally.`);

  rec.status = 'For Approval';
  rec.submitted_at = Date.now();
  rec.returned_for_revision = false;
  rec.submission_round = round;
  rec.currentApproverRole = route[0].stage;
  rec.approval_channel = 'dtms';
  rec.submitted_by = { name: session.roleName, role: session.role, email: session.email };
  rec.dtms = buildDtmsBlock(rec.dtms, tracknumber, route);
  if (!Array.isArray(rec.remarksHistory)) rec.remarksHistory = [];
  if (session.stage === 'HEAD') {
    rec.remarksHistory.push({
      stage: 'HEAD', role: session.role, name: session.roleName, action: 'submitted', round,
      remarks: 'Submitted by the Unit Head.', date: new Date().toLocaleDateString(), at: Date.now()
    });
  }

  try {
    writeRecords(all);
  } catch {
    return fail(`Sent to DTMS (Tracking No. ${tracknumber}) but could not be saved here. Press Submit again to link it.`);
  }
  return { success: true, record: rec, message: `PPMP No. ${rec.ppmp_no} sent to DTMS for signing (Tracking No. ${tracknumber}).` };
}

// ------------------------------------------------------------
// SUBMIT — APP  (call this where the APP page currently submits the APP for approval)
// ------------------------------------------------------------
export async function submitAppViaDtms(fiscalYear, session) {
  if (!session) return fail('Not authenticated.');
  const app = getAppRecord(fiscalYear);
  if (app.status === 'For Approval') return fail('This APP was already submitted for approval.');
  if (app.status === 'Completed') return fail('This APP is already final.');

  const round = (Number(app.submission_round) || 0) + 1;
  const title = `APP FY ${app.fiscal_year} (Round ${round}) - DICT`.slice(0, 100);

  let route;
  let tracknumber;
  try {
    route = buildRoute('APP', null, session);
    const people = await resolvePeople(route.map((s) => s.email));

    const existing = await findSubmittedByTitle(title);
    tracknumber = existing?.tracknumber;

    if (!tracknumber) {
      const person = (stage) => people[route.find((s) => s.stage === stage)?.email];
      const built = await previewAPP_PDF(app.fiscal_year, {
        preparedBy: { name: session.roleName },
        endorsedBy: asSigner(person('ARD')),
        approvedBy: asSigner(person('RD'))
      });
      if (!built) return fail('There are no fully approved PPMPs to compile into the APP yet.');

      const form = new FormData();
      form.append('title', title);
      form.append('requestor', String(session.roleName || 'Requester').slice(0, 100));
      form.append('position', String(session.position || 'Supply Officer II / BAC Secretariat').slice(0, 100));
      form.append('message', `Annual Procurement Plan for FY ${app.fiscal_year}, compiled from the latest approved PPMP of each office.`);
      form.append('files', built.blob, built.fileName);
      form.append('signatories', JSON.stringify(route.map(({ email, role, order }) => ({ email, role, order }))));

      tracknumber = (await api('/submit', { method: 'POST', body: form })).tracknumber;
    }
  } catch (err) {
    return fail(err.message);
  }

  const fresh = getAppRecord(app.fiscal_year);
  Object.assign(fresh, {
    status: 'For Approval',
    currentApproverRole: route[0].stage,
    approval_channel: 'dtms',
    submission_round: round,
    submitted_by: { name: session.roleName, role: session.role, email: session.email },
    submitted_at: Date.now(),
    returned_for_revision: false,
    rejected_by: null,
    rejected_at: null,
    ard_approved_by: null,
    ard_approved_at: null,
    approved_by: null,
    approved_at: null,
    dtms: buildDtmsBlock(fresh.dtms, tracknumber, route)
  });
  try {
    saveAppRecord(fresh);
  } catch {
    return fail(`Sent to DTMS (Tracking No. ${tracknumber}) but could not be saved here. Press Submit again to link it.`);
  }
  return { success: true, record: fresh, message: `APP FY ${fresh.fiscal_year} sent to DTMS for signing (Tracking No. ${tracknumber}).` };
}

// ------------------------------------------------------------
// STATUS — turn a DTMS document into the fields the rest of the app already reads
// ------------------------------------------------------------
function readDtmsDoc(d, route) {
  const sigs = Array.isArray(d.signatories) ? d.signatories : [];
  const stepOf = (s) =>
    route.find((r) => r.order === s.order) || route.find((r) => r.email === String(s.email).toLowerCase());
  const acted = sigs
    .filter((s) => s.status === 'signed' || s.status === 'rejected')
    .map((s) => ({ ...s, step: stepOf(s), at: Date.parse(s.signed_at) || Date.now() }));
  const pending = sigs.filter((s) => s.status === 'pending').sort((a, b) => a.order - b.order)[0];
  return { acted, nextStage: pending ? stepOf(pending)?.stage : null };
}

// Rebuilds this document's entries in remarksHistory on every sync, so repeated syncs never duplicate them.
function historyWith(rec, tracknumber, acted, round) {
  const keep = (Array.isArray(rec.remarksHistory) ? rec.remarksHistory : []).filter((h) => h.dtms !== tracknumber);
  const mine = acted.map((a) => ({
    stage: a.step?.stage,
    role: a.step?.stage,
    name: a.name,
    action: a.status === 'signed' ? 'approved' : 'rejected',
    remarks: a.status === 'signed' ? 'Approved in DTMS.' : (a.reason || 'Rejected in DTMS.'),
    round,
    date: new Date(a.at).toLocaleDateString(),
    at: a.at,
    dtms: tracknumber
  }));
  return [...keep, ...mine];
}

const lastSigned = (acted) =>
  acted.filter((a) => a.status === 'signed').sort((a, b) => b.order - a.order)[0];

// Returns true when something the user would notice changed.
export function applyDtmsToPpmp(rec, d) {
  const tn = rec.dtms.tracknumber;
  const { acted, nextStage } = readDtmsDoc(d, rec.dtms.route);
  const before = JSON.stringify([rec.status, rec.currentApproverRole, rec.remarksHistory]);

  rec.remarksHistory = historyWith(rec, tn, acted, Number(rec.submission_round) || 1);

  if (d.status === 'for_signing') {
    rec.status = 'For Approval';
    if (nextStage) rec.currentApproverRole = nextStage;
  } else if (d.status === 'completed') {
    const last = lastSigned(acted);
    Object.assign(rec, {
      status: 'Completed',
      currentApproverRole: 'None',
      returned_for_revision: false,
      is_indicative: 'Final',
      approved_at: last?.at || Date.now(),
      approved_by: { name: last?.name || 'DTMS', role: last?.step?.stage || 'RD', email: last?.email }
    });
    recordApprovedPpmpNumber(rec);
  } else if (d.status === 'rejected') {
    const r = acted.find((a) => a.status === 'rejected');
    Object.assign(rec, {
      status: 'Draft',
      currentApproverRole: null,
      returned_for_revision: true,
      rejected_at: r?.at || Date.now(),
      rejected_by: { name: r?.name, role: r?.step?.stage, email: r?.email, stage: r?.step?.stage }
    });
  }
  rec.dtms.last_seen = d.updated_at;
  return before !== JSON.stringify([rec.status, rec.currentApproverRole, rec.remarksHistory]);
}

export function applyDtmsToApp(app, d) {
  const tn = app.dtms.tracknumber;
  const { acted, nextStage } = readDtmsDoc(d, app.dtms.route);
  const before = JSON.stringify([app.status, app.currentApproverRole, app.ard_approved_at]);

  app.remarksHistory = historyWith(app, tn, acted, Number(app.submission_round) || 1);

  const ard = acted.find((a) => a.status === 'signed' && a.step?.stage === 'ARD');
  if (ard) {
    app.ard_approved_by = { name: ard.name, email: ard.email };
    app.ard_approved_at = ard.at;
  }

  if (d.status === 'for_signing') {
    app.status = 'For Approval';
    if (nextStage) app.currentApproverRole = nextStage;
  } else if (d.status === 'completed') {
    const last = lastSigned(acted);
    Object.assign(app, {
      status: 'Completed',
      currentApproverRole: 'None',
      returned_for_revision: false,
      approved_at: last?.at || Date.now(),
      approved_by: { name: last?.name || 'DTMS', email: last?.email }
    });
  } else if (d.status === 'rejected') {
    const r = acted.find((a) => a.status === 'rejected');
    Object.assign(app, {
      status: 'Draft',
      currentApproverRole: null,
      returned_for_revision: true,
      rejected_at: r?.at || Date.now(),
      rejected_by: { name: r?.name, email: r?.email, stage: r?.step?.stage }
    });
  }
  app.dtms.last_seen = d.updated_at;
  return before !== JSON.stringify([app.status, app.currentApproverRole, app.ard_approved_at]);
}

// ------------------------------------------------------------
// SYNC — one cheap list call; the full document is fetched only when DTMS says it changed.
// Returns true if any PPMP or APP changed (so the caller can refresh its screen).
// ------------------------------------------------------------
export async function syncDtmsApprovals() {
  const waitingPpmps = readRecords().filter((r) => r.status === 'For Approval' && r.dtms?.tracknumber);
  const waitingApps = getAllAppRecords().filter((a) => a.status === 'For Approval' && a.dtms?.tracknumber);
  if (!waitingPpmps.length && !waitingApps.length) return false;

  let summaries;
  try {
    summaries = new Map(((await api('/documents?limit=50')).results || []).map((d) => [d.tracknumber, d]));
  } catch {
    return false;   // offline or DTMS down: keep what we have and try again next time
  }

  const wanted = [...waitingPpmps, ...waitingApps]
    .map((r) => r.dtms)
    .filter((x) => {
      const s = summaries.get(x.tracknumber);
      return !s || s.updated_at !== x.last_seen;   // not in the newest 50, or changed since last look
    })
    .map((x) => x.tracknumber);

  const details = new Map();
  for (const tn of [...new Set(wanted)]) {
    try { details.set(tn, await api(`/documents/${encodeURIComponent(tn)}`)); } catch { /* try again next time */ }
  }
  if (!details.size) return false;

  let changed = false;

  const all = readRecords();   // fresh copy right before writing
  let touched = false;
  all.forEach((r) => {
    const d = r.status === 'For Approval' && r.dtms && details.get(r.dtms.tracknumber);
    if (d) { touched = true; changed = applyDtmsToPpmp(r, d) || changed; }
  });
  if (touched) writeRecords(all);

  getAllAppRecords().forEach((a) => {
    const d = a.status === 'For Approval' && a.dtms && details.get(a.dtms.tracknumber);
    if (d) { changed = applyDtmsToApp(a, d) || changed; saveAppRecord(a); }
  });

  return changed;
}

// ------------------------------------------------------------
// SIGNED COPY — what DTMS holds now (the signed version once people have signed)
// ------------------------------------------------------------
export async function downloadDtmsSignedPdf(tracknumber, notify = () => {}) {
  try {
    const d = await api(`/documents/${encodeURIComponent(tracknumber)}`);
    const file = (d.file_list || []).find((f) => f.type === 'original');
    if (!file) { notify('The signed file was not found in DTMS.'); return; }

    const res = await fetch(`${API}/documents/${encodeURIComponent(tracknumber)}/files/${file.id}`, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));

    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name || `${tracknumber}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    notify('Could not download the signed copy from DTMS.');
  }
}
