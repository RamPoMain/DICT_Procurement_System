// ============================================================
// DASHBOARD LOGIC
// - Stat cards (total / pending / completed / total budget)
// - Recent activity feed (derived from saved records)
// - Dark / light theme toggle (persisted)
// ============================================================


// The first step of the approval chain (see APPROVAL_CHAIN in request-modal.js).
// Submitting a PPMP hands it to this stage.
const FIRST_APPROVAL_STAGE = 'HEAD';
// A PPMP submitted by a Unit Head skips the HEAD step (their submission is
// their approval) and goes straight to this stage.
const SECOND_APPROVAL_STAGE = 'TOD';

function getSessionUser() {
    return (typeof getSession === 'function' && getSession()) || { role: null, canApprove: false, canRequest: false };
}

// True when the signed-in account is an approver AND this record is waiting
// at their stage. Unit heads are additionally limited to their own office.
// Drafts are never actionable.
function session_isHead() {
    const s = typeof getSession === 'function' ? getSession() : null;
    return !!(s && s.stage === 'HEAD');
}

function canSessionActOnRecord(record) {
    const s = typeof getSession === 'function' ? getSession() : null;
    if (!s || !s.canApprove || !record) return false;
    if (getPpmpStatus(record) !== 'For Approval') return false;
    if (record.currentApproverRole !== s.stage) return false;
    if (s.stage === 'HEAD') return record.end_user === s.headOf;
    return true;
}

function getRecords() {
    const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const session = typeof getSession === 'function' ? getSession() : null;

    if (!session) return [];

    return allRecords.filter(record => {
        // Suppliers can ONLY view final, fully approved PPMPs
        if (session.role === 'SUP') {
            return record.status === 'Completed';
        }

        // 1. Requesters see every PPMP that belongs to their office
        //    (drafts included), whatever stage it is at.
        if (session.canRequest && record.end_user === session.office) {
            return true;
        }

        // 2. Fully approved PPMPs are visible to reviewers (TOD, Budget Officer,
        //    Regional Director) - but NOT to requesting offices, which only ever
        //    see their own office's PPMPs (rule 1 above), including Unit Heads.
        if (record.status === 'Completed' && !session.canRequest) {
            return true;
        }

        // 3. Tracking accounts (Suppliers) see every submitted PPMP - waiting
        //    in the approval chain or fully approved - but never Drafts.
        if (session.canTrackApprovals) {
            const st = getPpmpStatus(record);
            if (st === 'For Approval' || st === 'Completed') return true;
        }

        // 4. Approvers see submitted PPMPs that are waiting at their stage,
        //    or that they already acted on (so a forwarded PPMP does not
        //    vanish from their list). Unit heads: own office only.
        if (session.canApprove && getPpmpStatus(record) === 'For Approval') {
            if (session.stage === 'HEAD' && record.end_user !== session.headOf) {
                return false;
            }
            if (record.currentApproverRole === session.stage) return true;
            const history = Array.isArray(record.remarksHistory) ? record.remarksHistory : [];
            if (history.some(h => h.stage === session.stage)) return true;
        }

        return false;
    });
}


function parseBudgetNumber(rawValue) {

    if (!rawValue) return 0;

    const parsed = parseFloat(String(rawValue).replace(/,/g, ''));

    return isNaN(parsed) ? 0 : parsed;
}


function formatPeso(amount) {

    if (amount >= 1000000) {
        return '₱' + (amount / 1000000).toFixed(amount % 1000000 === 0 ? 0 : 1) + 'M';
    }

    if (amount >= 1000) {
        return '₱' + (amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1) + 'K';
    }

    return '₱' + amount.toLocaleString('en-PH');
}


function formatPesoExact(amount) {
    return 'P ' + amount.toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}


function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


// ============================================================
// PPMP LINE ITEMS
// A PPMP record can hold more than one procurement line item, kept in
// record.items[]. Records saved before multi-item support only have a
// single item's fields directly on the record — getRecordItems()
// normalizes both shapes so the rest of the app never has to care which
// one it's looking at.
// ============================================================

// ------------------------------------------------------------
// PPMP approval helpers
// A PPMP is "closed" once it is approved (status === 'Completed').
// approved_by = { name, role, email }, approved_at = timestamp (ms).
// ------------------------------------------------------------
function isPpmpClosed(record) {
    return !!record && record.status === 'Completed';
}

// ------------------------------------------------------------
// PPMP status lifecycle:  Draft  ->  For Approval  ->  Completed
//   Draft         default; only the requesting office sees it, can edit it
//   For Approval  submitted by the requester; locked against edits. It stays
//                 'For Approval' for the whole chain - record.currentApproverRole
//                 ('HEAD' -> 'TOD' -> 'BO' -> 'RD') says whose turn it is.
//   Completed     approved by the last step (see isPpmpClosed above)
// Records saved before this existed use the old 'Pending ...' statuses, which
// are treated as Draft.
// ------------------------------------------------------------
function getPpmpStatus(record) {
    if (!record) return 'Draft';
    if (record.status === 'Completed') return 'Completed';
    if (record.status === 'For Approval') return 'For Approval';
    return 'Draft';
}

function isPpmpDraft(record) {
    return getPpmpStatus(record) === 'Draft';
}

// A Draft that an approver rejected and sent back to the requesting office.
// It stays a normal editable Draft; this flag only drives the "Returned"
// label and the rejection banner. Cleared when the requester resubmits.
function isPpmpReturned(record) {
    return !!record && getPpmpStatus(record) === 'Draft' && !!record.returned_for_revision;
}

// Locked = no longer editable by the requester (submitted or approved).
function isPpmpLocked(record) {
    return !!record && getPpmpStatus(record) !== 'Draft';
}

function statusPillClass(status) {
    if (status === 'Completed') return 'is-completed';
    if (status === 'For Approval') return 'is-pending';
    return 'is-draft';
}

// Status pill for the Entries table ("Returned" replaces "Draft" after a rejection).
function renderStatusPill(record, submittedTitle) {
    if (isPpmpReturned(record)) {
        const by = record.rejected_by && record.rejected_by.name ? record.rejected_by.name : 'an approver';
        return '<span class="db-status-pill is-returned" title="Returned by ' + escapeHtml(by) +
            ' - open the PPMP to read the remarks">Returned</span>';
    }
    const status = getPpmpStatus(record);
    // Tracking accounts (Suppliers) also see whose desk a submitted PPMP is on.
    let label = status;
    const session = typeof getSession === 'function' ? getSession() : null;
    if (status === 'For Approval' && session && session.canTrackApprovals) {
        const stageLabels = { HEAD: 'Unit Head', TOD: 'TOD', BO: 'Budget Officer', RD: 'Regional Director' };
        const where = stageLabels[record.currentApproverRole];
        if (where) label = 'For Approval · ' + where;
    }
    return '<span class="db-status-pill ' + statusPillClass(status) + '"' + (submittedTitle || '') + '>' + label + '</span>';
}

// Approved PPMPs can only be deleted by an approver.
function canDeleteRecord(record) {
    if (!isPpmpClosed(record)) return true;
    return typeof canCurrentUserApprove === 'function' && canCurrentUserApprove();
}

function formatApprovalDate(timestamp) {
    const n = Number(timestamp);
    if (!n) return '';
    return new Date(n).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatApprovalDateTime(timestamp) {
    const n = Number(timestamp);
    if (!n) return '';
    return new Date(n).toLocaleString('en-PH', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

// "Approved By" cell for the Entries table.
function renderApprovedByCell(record) {
    if (!isPpmpClosed(record)) {
        return '<span class="db-approver-none">—</span>';
    }
    const by = record.approved_by;
    if (!by) {
        return '<span class="db-approver-none" title="This PPMP was completed before approver tracking existed">Not recorded</span>';
    }
    return '<div class="db-approver"><strong>' + escapeHtml(by.name) + '</strong><span>' +
        escapeHtml(formatApprovalDate(record.approved_at)) + '</span></div>';
}


function getRecordItems(record) {
    if (!record) return [];

    if (Array.isArray(record.items) && record.items.length > 0) {
        return record.items;
    }

    return [{
        id: record.id,
        project_description: record.project_description,
        project_type: record.project_type,
        mode: record.mode,
        pre_procurement: record.pre_procurement,
        bid_evaluation_criteria: record.bid_evaluation_criteria || '',
        quantity_size: record.quantity_size,
        start_date: record.start_date,
        end_date: record.end_date,
        delivery_period: record.delivery_period,
        fund_source: record.fund_source,
        budget: record.budget,
        strategies: record.strategies || [],
        general_requirements: record.general_requirements || '',
        remarks: record.remarks,
        supporting_documents: record.supporting_documents || []
    }];
}


// ------------------------------------------------------------
// Supporting documents
// The request form requires at least one attached document on every item
// (Technical Specifications / Terms of Reference / Scope of Work, depending
// on the project type). An item can still end up with none - for example one
// created without going through the form - so a PPMP may not be submitted for
// approval until every item has one. This is the single check used by the
// submit dialog, the submit confirmation and the "Needs document" markers.
// ------------------------------------------------------------
function getRequiredDocLabel(projectType) {
    const labels = (typeof PROJECT_TYPE_DOC_LABELS !== 'undefined') ? PROJECT_TYPE_DOC_LABELS : {};
    return labels[projectType] || 'supporting document';
}

function itemHasSupportingDocument(item) {
    return !!item && Array.isArray(item.supporting_documents) && item.supporting_documents.length > 0;
}

// [{ number, item }] for every item of the record that has no attachment.
// `number` is the item's 1-based position, matching the item navigator.
function getItemsMissingDocuments(record) {
    return getRecordItems(record)
        .map(function (item, index) { return { number: index + 1, item: item }; })
        .filter(function (entry) { return !itemHasSupportingDocument(entry.item); });
}

function buildMissingDocsMessage(missing) {
    const shown = missing.slice(0, 3).map(function (m) {
        return 'Item ' + m.number + ' (' + getRequiredDocLabel(m.item.project_type) + ')';
    });
    const more = missing.length - shown.length;
    return 'Attach a supporting document before submitting: ' + shown.join(', ') +
        (more > 0 ? ' and ' + more + ' more' : '') + '. Open the PPMP and press Edit on each item.';
}


function getRecordTotalBudget(record) {
    return getRecordItems(record).reduce(
        (sum, item) => sum + parseBudgetNumber(item.budget),
        0
    );
}


function getRecordDescriptionSummary(record) {
    const items = getRecordItems(record);
    if (items.length === 0) return 'N/A';

    const first = items[0].project_description || items[0].quantity_size || 'N/A';
    const extra = items.length - 1;

    return extra > 0 ? `${first} (+${extra} more item${extra === 1 ? '' : 's'})` : first;
}


function getRecordProjectTypeSummary(record) {
    const items = getRecordItems(record);
    const types = [...new Set(items.map(item => item.project_type).filter(Boolean))];

    if (types.length === 0) return 'N/A';
    if (types.length === 1) return types[0];
    return 'Mixed';
}

function getRecordCriteriaSummary(record) {
    const items = getRecordItems(record);
    const list = [...new Set(items.map(it => it.bid_evaluation_criteria).filter(Boolean))];
    if (list.length === 0) return 'N/A';
    if (list.length === 1) return list[0];
    return 'Mixed';
}


// Redirects an "add another entry" click on this PPMP into the request
// modal. Works whether we're already on a page that has the modal
// (index.html/profile.html — open it straight away) or on entries.html,
// which doesn't have the modal markup, so we stash the target PPMP and
// hop to index.html, which picks it up on load (see DOMContentLoaded below).
function requestAddEntryToPpmp(ppmpNo) {
    if (typeof addEntryToPpmp === 'function' && document.getElementById('requestModalOverlay')) {
        addEntryToPpmp(ppmpNo);
    } else {
        sessionStorage.setItem('add_entry_ppmp', ppmpNo);
        window.location.href = 'index.html';
    }
}


function formatRelativeTime(timestamp) {

    const diffMs = Date.now() - timestamp;

    if (isNaN(timestamp) || diffMs < 0) return '';

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < minute) return 'just now';
    if (diffMs < hour) return Math.floor(diffMs / minute) + ' min ago';
    if (diffMs < day) return Math.floor(diffMs / hour) + ' hr ago';
    if (diffMs < 7 * day) return Math.floor(diffMs / day) + ' day' + (Math.floor(diffMs / day) === 1 ? '' : 's') + ' ago';

    return new Date(timestamp).toLocaleDateString();
}


function renderStats(records) {

    // These stat cards only exist on the dashboard page — bail out quietly
    // on pages (like Profile) that don't have them, instead of throwing.
    const totalEl = document.getElementById('stat-total');
    if (!totalEl) return;

    totalEl.innerText = records.length;

    document.getElementById('stat-pending').innerText =
        records.filter(r => getPpmpStatus(r) !== 'Completed').length;

    document.getElementById('stat-completed').innerText =
        records.filter(r => r.status === 'Completed').length;

    const totalBudget = records.reduce(
        (sum, record) => sum + getRecordTotalBudget(record),
        0
    );

    document.getElementById('stat-budget').innerText = formatPeso(totalBudget);
}


function activityIcon(status) {

    if (status === 'Completed') {
        return {
            className: 'is-completed',
            svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 12.2 L11 14.8 L15.5 9.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        };
    }

    return {
        className: 'is-pending',
        svg: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.5V12L15 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    };
}


function renderActivity(records) {
    const list = document.getElementById('db-activity-list');
    if (!list) return;

    if (records.length === 0) {
        list.innerHTML = '<li class="db-activity-empty">No activity yet.</li>';
        return;
    }

    const recent = [...records].sort((a, b) => b.id - a.id).slice(0, 6);

    list.innerHTML = recent.map(record => {
        const icon = activityIcon(record.status);
        const label = `PPMP No. ${record.ppmp_no} — ${record.end_user || 'N/A'}`;
        const safeLabel = escapeHtml(label);
        const recordId = Number(record.id);
        const time = formatRelativeTime(record.id);

        return `
            <li class="db-activity-item">
                <div class="db-activity-main">
                    <span class="db-activity-icon ${icon.className}">${icon.svg}</span>
                    <div>
                        <p class="db-activity-text" title="${safeLabel}">${safeLabel}</p>
                        <span class="db-activity-time">${time}${isPpmpClosed(record) && record.approved_by ? ' · Approved by ' + escapeHtml(record.approved_by.name) : (getPpmpStatus(record) === 'For Approval' ? ' · For approval' : (getPpmpStatus(record) === 'Draft' ? (isPpmpReturned(record) ? ' · Returned for revision' : ' · Draft') : ''))}</span>
                    </div>
                </div>
                
                <div class="db-activity-actions">
                    <!-- EXCEL PREVIEW BUTTON -->
                    <button class="db-action-btn" title="Preview Excel Format" onclick="openExcelPreview(${recordId})">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H18.5C19.3 4 20 4.7 20 5.5V18.5C20 19.3 19.3 20 18.5 20H5.5C4.7 20 4 19.3 4 18.5V5.5Z"/><path d="M4 9H20M4 14H20M9 4V20M15 4V20"/></svg>
                    </button>

                    <!-- VIEW BUTTON -->
                    <button class="db-action-btn" title="View Details" onclick="openEntryRecord(${recordId})">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    
                    <!-- DELETE BUTTON -->
                    ${canDeleteRecord(record) ? `<button class="db-action-btn delete" title="Delete" onclick="deleteRecord(${recordId})">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>` : ''}
                </div>
            </li>
        `;
    }).join('');
}


// ------------------------------------------------------------
// Inline item editing (Excel preview dropdown on the Entries table)
// A "draft" is a working copy of a record's items, created the moment
// its dropdown is expanded and kept in memory until Save or Discard.
// It survives re-renders (filters, add/remove item) but is never
// written to localStorage until the person clicks Save Changes.
// ------------------------------------------------------------
let previewDrafts = {};
let previewItemIdSeq = 0;

const PREVIEW_PROJECT_TYPES = ['Consulting Services', 'Goods', 'Infrastructure'];

// "General Requirements/Miscellaneous/Common Supplies and Equipment" column:
// the person picks which one the item is (or leaves it blank).
const PREVIEW_GENERAL_REQUIREMENT_OPTIONS = ['General Requirements', 'Miscellaneous', 'Common Supplies and Equipment'];

const PREVIEW_MODE_GROUPS = [
    { label: 'Competitive Mode', options: ['Competitive Bidding'] },
    { label: 'Alternative Modes', options: [
        'Limited Source Bidding', 'Direct Contracting', 'Repeat Order', 'Shopping',
        'Small Value Procurement (SVP)', 'Direct Acquisition', 'Competitive Dialogue',
        'Negotiated Procurement'
    ] }
];

const PREVIEW_CRITERIA_OPTIONS = [
    'Lowest Calculated Responsive Bid (LCRB)',
    'Most Economically Advantageous Responsive Bid (MEARB)',
    'Most Advantageous Responsive Bid (MARB) / HRRB / SRRB',
    'Lowest Comparative or Competitive Responsive Bid (LCCRB)'
];

const PREVIEW_STRATEGY_OPTIONS = [
    'Life Cycle Assessment (LCA) and LCCA', 'Subcontracting', 'Multi-Year Contracting',
    'Design-and-Build Scheme for Infrastructure', 'Engagement of a Procurement Agent',
    'Use of Framework Agreement Section', 'Pooled Procurement Section 17',
    'Renewal of Regular and Recurring Services', 'Warehousing and Inventory Activities'
];

function blankPreviewItem() {
    previewItemIdSeq += 1;
    return {
        id: Date.now() + previewItemIdSeq,
        project_description: '', project_type: '', quantity_size: '', mode: '',
        pre_procurement: '', bid_evaluation_criteria: '', start_date: '', end_date: '',
        delivery_period: '', fund_source: '', budget: '', strategies: [],
        supporting_documents: [], general_requirements: '', remarks: ''
    };
}

// Reads straight from localStorage (not getRecords(), which filters by the
// signed-in office) so drafts always compare against the true saved record.
function getRawRecordById(id) {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    return all.find(r => r.id == id) || null;
}

function ensurePreviewDraft(record) {
    if (!previewDrafts[record.id]) {
        previewDrafts[record.id] = {
            items: JSON.parse(JSON.stringify(getRecordItems(record))),
            touched: {},      // itemId -> { field: true }; errors only show for touched fields
            pending: 0,       // files still being read
            pendingSize: 0    // bytes of those files
        };
    }
    return previewDrafts[record.id];
}

// Which record (if any) is currently shown in the full-screen preview
// modal — lets save/discard/add/remove refresh that surface too, on
// top of the Entries table's inline dropdown (see refreshPreviewSurfaces).
let activeExcelPreviewId = null;

// Editable item editing is intentionally scoped to just these two
// surfaces: the Entries page's inline dropdown, and the full-screen
// Excel Preview modal (openable from both the Entries table and the
// Dashboard's Recent Activity list). It never appears in the read-only
// PDF export or anywhere on the Profile page.
//
// Nothing is editable until the person clicks "Edit". A draft only exists
// while a PPMP is being edited, so "has a draft" == "is in edit mode":
// Save, Cancel, collapsing the dropdown and closing the preview all delete
// the draft and therefore drop back to the read-only view.
function isPreviewEditing(recordId) {
    return !!previewDrafts[recordId];
}

// "Edit" turns the PPMP's rows into editable cells right where they are
// (the Entries dropdown, or the full-screen preview). Nothing is written to
// storage until Save Changes, and Save is blocked until every value passes
// the same rules the request form enforces (see validatePreviewItem).
function startPreviewEdit(recordId) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || !session.canRequest) {
        showToast('Your account is view/approve only and cannot edit requests.');
        return;
    }
    const record = getRawRecordById(recordId);
    if (!record) return;
    if (isPpmpLocked(record)) {
        showToast('This PPMP is locked and can no longer be edited.');
        return;
    }
    ensurePreviewDraft(record);
    refreshPreviewSurfaces(recordId);
}

// The row-level buttons (add entry, Excel preview, view details, delete)
// live in the expanded dropdown's toolbar, beside Edit, rather than in the
// table's Action column.
function buildEntryActionButtonsHtml(record) {
    const recordId = Number(record.id);
    const isPending = isPpmpDraft(record);
    const session = typeof getSession === 'function' ? getSession() : null;
    const canReq = !!(session && session.canRequest);

    return `
        <div class="db-entry-actions">
            ${(isPending && canReq) ? `
            <button type="button" class="db-action-btn" title="Add another entry to this PPMP" onclick="addEntryInline(${recordId})">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5V19M5 12H19"/></svg>
            </button>
            ` : ''}
            <button type="button" class="db-action-btn" title="Preview Excel Format" onclick="openExcelPreview(${recordId})">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H18.5C19.3 4 20 4.7 20 5.5V18.5C20 19.3 19.3 20 18.5 20H5.5C4.7 20 4 19.3 4 18.5V5.5Z"/><path d="M4 9H20M4 14H20M9 4V20M15 4V20"/></svg>
            </button>
            <button type="button" class="db-action-btn" title="View Details" onclick="openEntryRecord(${recordId})">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            ${canDeleteRecord(record) ? `<button type="button" class="db-action-btn delete" title="Delete" onclick="deleteRecord(${recordId})">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>` : ''}
        </div>`;
}

// options.record  -> also show that record's action buttons (view mode only,
//                    so nobody navigates away mid-edit with unsaved changes)
// options.canEdit -> false hides Edit (approved PPMPs); default true
function buildPreviewToolbarHtml(recordId, options = {}) {
    const session = typeof getSession === 'function' ? getSession() : null;
    const canReq = !!(session && session.canRequest);
    const canEdit = options.canEdit !== false;
    

    if (!isPreviewEditing(recordId)) {
        const missingDocs = options.record && isPpmpDraft(options.record)
            ? getItemsMissingDocuments(options.record).length
            : 0;
        const docWarning = missingDocs > 0
            ? `<span class="ep-doc-warning" title="Submit for Approval is blocked until every item has a supporting document">${missingDocs} ${missingDocs === 1 ? 'item needs' : 'items need'} a supporting document</span>`
            : '';

        // Submit stays visible but is disabled (greyed out) while any item
        // has no supporting document. aria-disabled (not disabled) keeps the
        // click working, so pressing it still explains what is missing; the
        // real block is in openSubmitApprovalDialog() and
        // confirmSubmitForApproval().
        const submitBlocked = missingDocs > 0;
        const submitBtn = (options.record && isPpmpDraft(options.record) && canReq)
            ? `<button type="button" class="ep-submit-btn${submitBlocked ? ' is-blocked' : ''}"` +
              (submitBlocked
                  ? ` aria-disabled="true" title="Attach a supporting document to ${missingDocs === 1 ? 'the item' : 'each of the ' + missingDocs + ' items'} marked 'Needs document' before submitting"`
                  : '') +
              ` onclick="openSubmitApprovalDialog(${recordId})">Submit for Approval</button>`
            : '';

        return `
        <div class="ep-toolbar">
            <div class="ep-toolbar-status">
                <span class="ep-dirty-indicator hidden" data-record-id="${recordId}">Unsaved changes</span>
                ${docWarning}
            </div>
            <div class="ep-toolbar-actions">
                ${options.record && options.actions !== false ? buildEntryActionButtonsHtml(options.record) : ''}
                ${submitBtn}
                ${canEdit ? `<button type="button" class="ep-save-btn" onclick="startPreviewEdit(${recordId})">Edit</button>` : ''}
            </div>
        </div>
    `;
    }

    return `
        <div class="ep-toolbar">
            <span class="ep-dirty-indicator${isPreviewDirty(recordId) ? '' : ' hidden'}" data-record-id="${recordId}">Unsaved changes</span>
            <div class="ep-toolbar-actions">
                <button type="button" class="ep-add-btn" onclick="addPreviewItem(${Number(recordId)})">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5V19M5 12H19" stroke-linecap="round"/></svg>
                    Add Item
                </button>
                <button type="button" class="ep-discard-btn" onclick="discardPreviewChanges(${recordId})">Cancel</button>
                <button type="button" class="ep-save-btn" onclick="savePreviewChanges(${recordId})">Save Changes</button>
            </div>
        </div>
    `;
}

// Re-renders whichever of the two surfaces above are currently showing
// this record, so a save/discard/add/remove made in one place (say, the
// full-screen modal) is reflected in the other if both happen to be
// open for the same record.
function refreshPreviewSurfaces(recordId) {
    if (expandedEntryId === recordId) {
        renderEntries(getRecords());
    }
    if (activeExcelPreviewId === recordId) {
        const record = getRawRecordById(recordId);
        if (record) {
            renderExcelPreviewOverlay(record);
        } else {
            closeExcelPreview();
        }
    }
}


function isPreviewDirty(recordId) {
    const draft = previewDrafts[recordId];
    if (!draft) return false;
    const saved = getRawRecordById(recordId);
    if (!saved) return true;
    return previewSignature(draft.items) !== previewSignature(getRecordItems(saved));
}

// Attachments are megabytes of base64, so compare their length instead of
// their contents - cheap enough to run on every keystroke.
function previewSignature(items) {
    return JSON.stringify(items, function (key, value) {
        return key === 'dataUrl' ? (value ? value.length : 0) : value;
    });
}

function selectOptionsHtml(options, current) {
    return options.map(opt =>
        `<option value="${escapeHtml(opt)}"${opt === current ? ' selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
}

// Builds one editable item row (12 field columns + a Remove column).
function buildEditableItemRow(record, item) {
    const rid = Number(record.id);
    const iid = item.id;

    const modeOptionsHtml = PREVIEW_MODE_GROUPS.map(group =>
        `<optgroup label="${escapeHtml(group.label)}">${selectOptionsHtml(group.options, item.mode)}</optgroup>`
    ).join('');

    const strategiesHtml = PREVIEW_STRATEGY_OPTIONS.map(opt => {
        const isChecked = Array.isArray(item.strategies) && item.strategies.includes(opt);
        return `
            <label class="ep-strategy-opt" style="display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: flex-start !important; gap: 8px !important; margin: 4px 0 !important; cursor: pointer !important; width: 100% !important;">
                <input type="checkbox" value="${escapeHtml(opt)}" data-record-id="${rid}" data-item-id="${iid}"
                    ${isChecked ? 'checked' : ''}
                    onchange="onPreviewStrategyToggle(this)"
                    style="width: 15px !important; height: 15px !important; min-width: 15px !important; max-width: 15px !important; margin: 0 !important; padding: 0 !important; flex-shrink: 0 !important; cursor: pointer !important; appearance: auto !important; -webkit-appearance: checkbox !important;">
                <span style="flex: 1 1 auto !important; color: #111827 !important; font-size: 10.5px !important; line-height: 1.25 !important; white-space: normal !important; word-break: normal !important; text-align: left !important; font-weight: normal !important;">
                    ${escapeHtml(opt)}
                </span>
            </label>
        `;
    }).join('');

    const docsDisplay = renderPreviewDocEditor(item, record.id);

    return `
        <tr data-preview-item-row="${iid}">
            <!-- Col 1: Description -->
            <td><textarea class="ep-input" rows="2" data-record-id="${rid}" data-item-id="${iid}" data-field="project_description" oninput="onPreviewFieldInput(this)" placeholder="Describe the project...">${escapeHtml(item.project_description || '')}</textarea></td>
            
            <!-- Col 2: Project Type -->
            <td><select class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="project_type" onchange="onPreviewFieldInput(this)">
                <option value=""${!item.project_type ? ' selected' : ''}>Select...</option>
                ${selectOptionsHtml(PREVIEW_PROJECT_TYPES, item.project_type)}
            </select></td>
            
            <!-- Col 3: Quantity & Size -->
            <td><textarea class="ep-input" rows="2" data-record-id="${rid}" data-item-id="${iid}" data-field="quantity_size" oninput="onPreviewFieldInput(this)" placeholder="Quantity and size...">${escapeHtml(item.quantity_size || '')}</textarea></td>
            
            <!-- Col 4: Mode of Procurement -->
            <td><select class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="mode" onchange="onPreviewFieldInput(this)">
                <option value=""${!item.mode ? ' selected' : ''}>Select mode...</option>
                ${modeOptionsHtml}
            </select></td>
            
            <!-- Col 5: Pre-Procurement -->
            <td><select class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="pre_procurement" onchange="onPreviewFieldInput(this)">
                <option value=""${!item.pre_procurement ? ' selected' : ''}>Select...</option>
                ${selectOptionsHtml(['No', 'Yes'], item.pre_procurement)}
            </select></td>
            
            <!-- Col 6: Criteria for Bid Evaluation -->
            <td><select class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="bid_evaluation_criteria" onchange="onPreviewFieldInput(this)">
                <option value=""${!item.bid_evaluation_criteria ? ' selected' : ''}>Select...</option>
                ${selectOptionsHtml(PREVIEW_CRITERIA_OPTIONS, item.bid_evaluation_criteria)}
            </select></td>
            
            <!-- Col 7: Start Date -->
            <td><input type="date" class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="start_date" min="2000-01-01" max="2100-12-31" value="${escapeHtml(item.start_date || '')}" oninput="onPreviewFieldInput(this)"></td>
            
            <!-- Col 8: End Date -->
            <td><input type="date" class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="end_date" min="${escapeHtml(item.start_date || '2000-01-01')}" max="2100-12-31" value="${escapeHtml(item.end_date || '')}" oninput="onPreviewFieldInput(this)"></td>
            
            <!-- Col 9: Delivery Period -->
            <td><input type="date" class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="delivery_period" min="${escapeHtml(item.end_date ? previewNextDay(item.end_date) : '2000-01-01')}" max="2100-12-31" value="${escapeHtml(item.delivery_period || '')}" oninput="onPreviewFieldInput(this)"></td>
            
            <!-- Col 10: Fund Source -->
            <td><input type="text" class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="fund_source" value="${escapeHtml(item.fund_source || '')}" oninput="onPreviewFieldInput(this)" placeholder="Source of funds"></td>
            
            <!-- Col 11: Budget -->
            <td><input type="text" class="ep-input ep-budget" data-record-id="${rid}" data-item-id="${iid}" data-field="budget" value="${escapeHtml(item.budget || '')}" oninput="onPreviewFieldInput(this)" placeholder="0.00" inputmode="decimal" autocomplete="off"></td>
            
            <!-- Col 12: Procurement Strategies & Tools -->
            <td style="min-width: 220px; width: 220px; vertical-align: top;">
                <div class="ep-strategies-box" data-record-id="${rid}" data-item-id="${iid}" style="min-width: 210px; width: 100%; max-height: 110px; overflow-y: auto; overflow-x: hidden; padding: 6px 8px; background: #fff; border: 1px solid #c7c7c7; border-radius: 4px; box-sizing: border-box;">
                    ${strategiesHtml}
                </div>
            </td>
            
            <!-- Col 13: Attached Supporting Documents -->
            <td class="ep-doc-cell" data-record-id="${rid}" data-item-id="${iid}" style="min-width: 180px; width: 180px; vertical-align: top;">
                <div class="ep-doc-cell-body" style="font-size: 10.5px; line-height: 1.4; word-break: break-word; color: #374151;">
                    ${docsDisplay}
                </div>
            </td>
            
            <!-- Col 14: General Requirements / Miscellaneous / Common Supplies and Equipment -->
            <td><select class="ep-input" data-record-id="${rid}" data-item-id="${iid}" data-field="general_requirements" onchange="onPreviewFieldInput(this)">
                <option value=""${!item.general_requirements ? ' selected' : ''}>None / Not applicable</option>
                ${selectOptionsHtml(PREVIEW_GENERAL_REQUIREMENT_OPTIONS, item.general_requirements)}
                ${(item.general_requirements && PREVIEW_GENERAL_REQUIREMENT_OPTIONS.indexOf(item.general_requirements) === -1) ? selectOptionsHtml([item.general_requirements], item.general_requirements) : ''}
            </select></td>
            
            <!-- Col 15: Remarks -->
            <td><textarea class="ep-input" rows="2" data-record-id="${rid}" data-item-id="${iid}" data-field="remarks" oninput="onPreviewFieldInput(this)" placeholder="Remarks">${escapeHtml(item.remarks || '')}</textarea></td>
            
            <!-- Col 16: Actions (Remove) -->
            <td class="ep-remove-cell">
                <button type="button" class="ep-remove-btn" title="Remove this item" onclick="removePreviewItem(${rid}, ${iid})">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6L18 18M18 6L6 18" stroke-linecap="round"/></svg>
                </button>
            </td>
        </tr>
    `;
}


// ------------------------------------------------------------
// Attached supporting documents inside the PPMP preview / dropdown.
// Each file name is a link that opens the document in a new tab, with a
// small download button beside it. The files live in storage as base64
// data: URLs; browsers block opening a data: URL directly in a new tab,
// so the bytes are rebuilt into a Blob and opened through a blob: URL.
// ------------------------------------------------------------
function previewDocToBlob(dataUrl) {
    try {
        const comma = String(dataUrl || '').indexOf(',');
        if (comma === -1) return null;
        const header = dataUrl.slice(0, comma);
        const mimeMatch = header.match(/^data:([^;,]*)/);
        const mime = (mimeMatch && mimeMatch[1]) || 'application/octet-stream';
        const payload = dataUrl.slice(comma + 1);
        let bytes;
        if (/;base64/i.test(header)) {
            const binary = atob(payload);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        } else {
            bytes = new TextEncoder().encode(decodeURIComponent(payload));
        }
        return new Blob([bytes], { type: mime });
    } catch (err) {
        return null;
    }
}

// Finds one stored document. Looks in the open edit draft first (so it also
// works while the PPMP is being edited), then in the saved record.
function findPreviewDoc(recordId, itemId, docIndex) {
    const draft = previewDrafts[recordId];
    const record = getRawRecordById(recordId);
    const sources = [];
    if (draft && Array.isArray(draft.items)) sources.push(draft.items);
    if (record) sources.push(getRecordItems(record));
    for (const items of sources) {
        const item = items.find(it => it.id == itemId);
        const docs = item && Array.isArray(item.supporting_documents) ? item.supporting_documents : null;
        if (docs && docs[docIndex]) return docs[docIndex];
    }
    return null;
}

function resolvePreviewDoc(btn) {
    const doc = findPreviewDoc(
        Number(btn.dataset.recordId), btn.dataset.itemId, Number(btn.dataset.docIndex)
    );
    if (!doc || !doc.dataUrl) {
        showToast('This file could not be opened - its contents were not saved. Re-attach it by editing the item.');
        return null;
    }
    const blob = previewDocToBlob(doc.dataUrl);
    if (!blob) {
        showToast('This file could not be read. Re-attach it by editing the item.');
        return null;
    }
    return { doc: doc, blob: blob };
}

function openPreviewDoc(btn, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const found = resolvePreviewDoc(btn);
    if (!found) return;
    const url = URL.createObjectURL(found.blob);
    const win = window.open(url, '_blank');
    if (!win) {
        // Pop-up blocked: fall back to downloading so the click still does something.
        downloadBlobAs(url, found.doc.name || 'document');
        showToast('Your browser blocked the new tab, so the file was downloaded instead.');
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

function downloadPreviewDoc(btn, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const found = resolvePreviewDoc(btn);
    if (!found) return;
    const url = URL.createObjectURL(found.blob);
    downloadBlobAs(url, found.doc.name || 'document');
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function downloadBlobAs(url, fileName) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// The "Attached Supporting Documents" cell: one row per file, name opens it,
// arrow downloads it. A file with no stored contents shows as plain text.
function renderPreviewDocs(item, recordId) {
    const docs = Array.isArray(item && item.supporting_documents) ? item.supporting_documents : [];
    if (docs.length === 0) return '<span class="ep-none">None</span>';

    return '<ul class="ep-list ep-doc-list">' + docs.map(function (doc, index) {
        const name = (doc && doc.name) || 'Document';
        if (!doc || !doc.dataUrl) {
            return '<li>' + escapeHtml(name) + '</li>';
        }
        const attrs = ' data-record-id="' + Number(recordId) + '" data-item-id="' + escapeHtml(item.id) +
            '" data-doc-index="' + index + '"';
        return '<li class="ep-doc-item">' +
            '<button type="button" class="ep-doc-link"' + attrs + ' title="Open ' + escapeHtml(name) + '"' +
                ' onclick="openPreviewDoc(this, event)">' + escapeHtml(name) + '</button>' +
            '<button type="button" class="ep-doc-download"' + attrs + ' title="Download ' + escapeHtml(name) + '"' +
                ' aria-label="Download ' + escapeHtml(name) + '" onclick="downloadPreviewDoc(this, event)">' +
                '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button></li>';
    }).join('') + '</ul>';
}


// Renders a list of values (strategies, attached document names) as a short
// bulleted list inside a table cell. Accepts an array or a single string;
// anything empty shows a muted "None". Every value is HTML-escaped here.
function renderPreviewList(values) {
    const list = (Array.isArray(values) ? values : [values])
        .map(v => String(v == null ? '' : v).trim())
        .filter(Boolean);

    if (list.length === 0) return '<span class="ep-none">None</span>';

    return '<ul class="ep-list">' +
        list.map(v => '<li>' + escapeHtml(v) + '</li>').join('') +
        '</ul>';
}


function buildExcelPreviewMarkup(record, editable, showSignatures = true) {
    const isIndicative = record.is_indicative === 'Indicative';
    const isFinal = record.is_indicative === 'Final';
    const items = editable ? ensurePreviewDraft(record).items : getRecordItems(record);
    const formattedTotal = formatPesoExact(
        items.reduce((sum, item) => sum + parseBudgetNumber(item.budget), 0)
    );

    const itemRows = editable
        ? items.map(item => buildEditableItemRow(record, item)).join('')
        : items.map(item => {
        const itemStrategies = renderPreviewList(item.strategies);

        const attachedDocs = (!itemHasSupportingDocument(item) && isPpmpDraft(record))
            ? '<span class="ep-none ep-needs-doc" title="Required before this PPMP can be submitted for approval">Needs document</span>'
            : renderPreviewDocs(item, record.id);

        return `
            <tr class="ep-item-row" ${itemFilterAttrs(item)}>
                <td>${escapeHtml(item.project_description || '')}</td>
                <td>${escapeHtml(item.project_type || '')}</td>
                <td>${escapeHtml(item.quantity_size || '')}</td>
                <td>${escapeHtml(item.mode || '')}</td>
                <td>${escapeHtml(item.pre_procurement || '')}</td>
                <td>${escapeHtml(item.bid_evaluation_criteria || 'N/A')}</td>
                <td>${escapeHtml(item.start_date || '')}</td>
                <td>${escapeHtml(item.end_date || '')}</td>
                <td>${escapeHtml(item.delivery_period || '')}</td>
                <td>${escapeHtml(item.fund_source || '')}</td>
                <td>${escapeHtml(formatPesoExact(parseBudgetNumber(item.budget)))}</td>
                <td>${itemStrategies}</td>
                <td>${attachedDocs}</td>
                <td>${escapeHtml(item.general_requirements || '')}</td>
                <td>${escapeHtml(item.remarks || '')}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="excel-preview-sheet">
            <div class="excel-preview-banner">
                <img src="images/header-banner.png" alt="DICT Header Banner">
            </div>

            <h2>PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${escapeHtml(record.ppmp_no || 'N/A')}</h2>

            <div class="excel-preview-checks">
                <span><span class="excel-check-box">${isIndicative ? 'X' : ''}</span> INDICATIVE</span>
                <span><span class="excel-check-box">${isFinal ? 'X' : ''}</span> FINAL</span>
            </div>

            <div class="excel-preview-meta">
                <p>Fiscal Year : ${escapeHtml(record.fiscal_year || 'N/A')}</p>
                <p>End-User or Implementing Unit: ${escapeHtml(record.end_user || 'N/A')}</p>
            </div>

            <div class="excel-preview-table-wrap">
                <table class="excel-preview-table">
                    <thead>
                        <tr>
                            <th colspan="6">PROCUREMENT PROJECT DETAILS</th>
                            <th colspan="3">PROJECTED TIMELINE (MM/YYYY)</th>
                            <th colspan="2">FUNDING DETAILS</th>
                            <th rowspan="2">PROCUREMENT STRATEGIES AND TOOLS</th>
                            <th rowspan="2">ATTACHED SUPPORTING DOCUMENTS</th>
                            <th rowspan="2">GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT</th>
                            <th rowspan="2">REMARKS</th>
                            ${editable ? '<th rowspan="2">Actions</th>' : ''}
                        </tr>
                        <tr>
                            <th>General Description and Objective of the Project to be Procured</th>
                            <th>Type of the Project to be Procured</th>
                            <th>Quantity and Size of the Project to be Procured</th>
                            <th>Recommended Mode of Procurement</th>
                            <th>Pre-Procurement Conference (Yes/No)</th>
                            <th>Criteria for Bid Evaluation</th>
                            <th>Start of Procurement Activity</th>
                            <th>End of Procurement Activity</th>
                            <th>Expected Delivery/ Implementation Period</th>
                            <th>Source of Funds</th>
                            <th>Estimated Budget / Authorized Budgetary Allocation (PhP)</th>
                        </tr>
                        <tr>
                            <th>Column 1</th>
                            <th>Column 2</th>
                            <th>Column 3</th>
                            <th>Column 4</th>
                            <th>Column 5</th>
                            <th>Column 6</th>
                            <th>Column 7</th>
                            <th>Column 8</th>
                            <th>Column 9</th>
                            <th>Column 10</th>
                            <th>Column 11</th>
                            <th>Column 12</th>
                            <th>Column 13</th>
                            <th>Column 14</th>
                            <th>Column 15</th>
                            ${editable ? '<th></th>' : ''}
                        </tr>
                    </thead>
                    <tbody>
                        ${itemRows}
                        ${editable ? '' : '<tr class="ep-filter-empty hidden"><td colspan="15">No items match the current filters.</td></tr>'}
                        <tr>
                            <td colspan="10" class="excel-total-label">TOTAL BUDGET:</td>
                            <td class="excel-total-value">${escapeHtml(formattedTotal)}</td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            ${editable ? '<td></td>' : ''}
                        </tr>
                        ${editable ? '' : `<tr class="ep-filter-subtotal hidden">
                            <td colspan="10" class="excel-total-label ep-filter-subtotal-label"></td>
                            <td class="excel-total-value ep-filter-subtotal-value"></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                        </tr>`}
                        ${editable ? `
                        <tr class="ep-add-row">
                            <td colspan="16">
                                <button type="button" class="ep-add-btn" onclick="addPreviewItem(${Number(record.id)})">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5V19M5 12H19" stroke-linecap="round"/></svg>
                                    Add Item
                                </button>
                            </td>
                        </tr>
                        ` : ''}
                    </tbody>
                </table>
            </div>

            ${showSignatures ? `
            <div class="excel-preview-signatures">
                <div>
                    <p>Prepared by / Submitted by:</p>
                    <span></span>
                    <strong>JAYMARK D. DUMIO</strong>
                    <small>Signature over Printed Name</small>
                    <small>Focal, ICT Literacy Competency and Development Bureau X</small>
                    <small>Date: ${escapeHtml(new Date().toLocaleDateString())}</small>
                </div>
                <div>
                    <p>Certified Funds Available:</p>
                    <span></span>
                    <strong>BRYAN JOHN M. SABLAS</strong>
                    <small>Signature over Printed Name</small>
                    <small>Budget Officer II</small>
                </div>
                <div>
                    <p>Approved by:</p>
                    <span></span>
                    <strong>SITTIE RAHMA V. ALAWI, MTM, CSSGB</strong>
                    <small>Signature over Printed Name</small>
                    <small>Regional Director, DICT X</small>
                    ${isPpmpClosed(record) && record.approved_by ? `<small>Approved in system by ${escapeHtml(record.approved_by.name)}${record.approved_at ? ' on ' + escapeHtml(formatApprovalDate(record.approved_at)) : ''}</small>` : ''}
                </div>
                <div>
                    <p>Endorsed by:</p>
                    <span></span>
                    <strong>EUGENE C. RAPOSALA III</strong>
                    <small>Signature over Printed Name</small>
                    <small>Chief, Technical Operations Division</small>
                </div>
            </div>
            ` : ''}
        </div>
    `;
}


function openExcelPreview(id) {
    const record = getRecords().find(item => item.id == id);
    if (!record) return;

    activeExcelPreviewId = record.id;
    renderExcelPreviewOverlay(record);
}


// Builds/updates the full-screen preview modal's content for one record.
// Called on first open (openExcelPreview) and again after any edit made
// while it's open (refreshPreviewSurfaces), so Save/Discard/Add/Remove
// all stay in sync without closing and reopening the modal.
function renderExcelPreviewOverlay(record) {
    const session = typeof getSession === 'function' ? getSession() : null;
    const canReq = !!(session && session.canRequest);
    const isEditable = !isPpmpLocked(record) && canReq;
    const isEditing = isEditable && isPreviewEditing(record.id);

    let overlay = document.getElementById('excelPreviewOverlay');

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'excelPreviewOverlay';
        overlay.className = 'excel-preview-overlay hidden';
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="excel-preview-modal" role="dialog" aria-modal="true" aria-labelledby="excelPreviewTitle">
            <div class="excel-preview-header">
                <div>
                    <h3 id="excelPreviewTitle">Excel Preview</h3>
                    <p>PPMP No. ${escapeHtml(record.ppmp_no || 'N/A')}</p>
                </div>
                <div class="excel-preview-actions">
                    <button type="button" class="db-action-btn" title="Open Full Request" onclick="openEntryRecord(${Number(record.id)})">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    <button type="button" class="db-action-btn" title="Close Preview" onclick="closeExcelPreview()">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6L18 18M18 6L6 18" stroke-linecap="round"/></svg>
                    </button>
                </div>
            </div>
            <div class="excel-preview-scroll">
                ${isEditable ? buildPreviewToolbarHtml(Number(record.id), { record: record, actions: false }) : ''}
                ${buildExcelPreviewMarkup(record, isEditing)}
            </div>
        </div>
    `;

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    reapplyPreviewErrors();
}


function closeExcelPreview() {
    const overlay = document.getElementById('excelPreviewOverlay');
    if (!overlay) return;

    // Closing discards any unsaved edits, the same as collapsing the
    // Entries dropdown does — Save Changes is the only thing that persists.
    if (activeExcelPreviewId !== null) {
        delete previewDrafts[activeExcelPreviewId];
        activeExcelPreviewId = null;
    }

    overlay.classList.add('hidden');
    document.body.style.overflow = '';
}

// ============================================================
// SUPPLIER: GENERATE APP
// Suppliers get a "Generate APP" link in the sidebar of every page and a
// prominent button in the Entries page header. Both build the Annual
// Procurement Plan immediately (generateAPP_PDF in pdf-generator.js).
// Every other account never sees them. The Export APP buttons inside the
// request modal (.export-app-btn) follow the same rule - all copies of them,
// not just the first one that shares the duplicated id.
// ============================================================

const APP_NAV_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none">' +
        '<path d="M7 3.5H14L18 7.5V19.5C18 20.05 17.55 20.5 17 20.5H7C6.45 20.5 6 20.05 6 19.5V4.5C6 3.95 6.45 3.5 7 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M14 3.5V7.5H18" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M12 11V16M12 16L9.8 13.8M12 16L14.2 13.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

let appGenerating = false;

function isSupplierSession() {
    const session = typeof getSession === 'function' ? getSession() : null;
    return !!(session && session.role === 'SUP');
}

// Shows a busy state on every Generate APP trigger while the PDF is built
// (the label changes too, so the feedback doesn't depend on animation).
function setAppButtonsBusy(busy) {
    document.querySelectorAll('[data-generate-app], [data-app-entry-btn]').forEach(function (el) {
        const label = el.querySelector('.db-app-label');
        el.classList.toggle('is-loading', busy);
        el.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (!label) return;
        if (busy) {
            el.dataset.idleLabel = label.textContent;
            label.textContent = 'Generating\u2026';
        } else if (el.dataset.idleLabel) {
            label.textContent = el.dataset.idleLabel;
        }
    });
}

// One entry point for the sidebar link and the Entries button.
async function runGenerateApp() {
    if (appGenerating) return;

    if (!isSupplierSession()) {
        showToast('Only Suppliers can generate the Annual Procurement Plan.');
        return;
    }
    if (typeof generateAPP_PDF !== 'function') {
        showToast('The PDF generator is not available on this page.');
        return;
    }

    appGenerating = true;
    setAppButtonsBusy(true);
    try {
        await generateAPP_PDF();
    } catch (err) {
        console.error('APP generation failed:', err);
        showToast('The APP could not be generated. Please try again.');
    } finally {
        appGenerating = false;
        setAppButtonsBusy(false);
    }
}

// ------------------------------------------------------------
// Preview APP: builds the same PDF as Generate APP, but shows it in a
// dialog first (with Download / Open in new tab) instead of downloading.
// ------------------------------------------------------------

let appPreviewEl = null;
let appPreviewUrl = null;
let appPreviewPrevFocus = null;

function setAppPreviewBusy(busy) {
    document.querySelectorAll('[data-app-preview-btn]').forEach(function (el) {
        const label = el.querySelector('.db-app-label');
        el.classList.toggle('is-loading', busy);
        el.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (!label) return;
        if (busy) {
            el.dataset.idleLabel = label.textContent;
            label.textContent = 'Preparing\u2026';
        } else if (el.dataset.idleLabel) {
            label.textContent = el.dataset.idleLabel;
        }
    });
}

async function runPreviewApp() {
    if (appGenerating) return;

    if (!isSupplierSession()) {
        showToast('Only Suppliers can preview the Annual Procurement Plan.');
        return;
    }
    if (typeof previewAPP_PDF !== 'function') {
        showToast('The PDF generator is not available on this page.');
        return;
    }

    appGenerating = true;
    setAppPreviewBusy(true);
    try {
        const result = await previewAPP_PDF();
        if (result) openAppPreviewModal(result);
    } catch (err) {
        console.error('APP preview failed:', err);
        showToast('The APP preview could not be prepared. Please try again.');
    } finally {
        appGenerating = false;
        setAppPreviewBusy(false);
    }
}

function buildAppPreviewModal() {
    const overlay = document.createElement('div');
    overlay.className = 'app-preview-overlay';
    overlay.id = 'appPreviewOverlay';
    overlay.innerHTML =
        '<div class="app-preview-modal" role="dialog" aria-modal="true" aria-labelledby="appPreviewTitle">' +
            '<div class="app-preview-head">' +
                '<h3 id="appPreviewTitle">Annual Procurement Plan Preview</h3>' +
                '<button type="button" class="app-preview-x" data-app-preview-close aria-label="Close preview">&times;</button>' +
            '</div>' +
            '<div class="app-preview-body">' +
                '<iframe id="appPreviewFrame" class="app-preview-frame" title="Annual Procurement Plan preview"></iframe>' +
                '<p class="app-preview-fallback">If the preview does not show on this device, use <strong>Open in new tab</strong>.</p>' +
            '</div>' +
            '<div class="app-preview-actions">' +
                '<button type="button" class="app-preview-btn is-secondary" data-app-preview-close>Close</button>' +
                '<span class="app-preview-spacer"></span>' +
                '<button type="button" class="app-preview-btn" data-app-preview-open>Open in new tab</button>' +
            '</div>' +
        '</div>';

    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeAppPreviewModal();
    });
    overlay.querySelectorAll('[data-app-preview-close]').forEach(function (b) {
        b.addEventListener('click', closeAppPreviewModal);
    });
    overlay.querySelector('[data-app-preview-open]').addEventListener('click', function () {
        if (appPreviewUrl) window.open(appPreviewUrl, '_blank', 'noopener');
    });

    document.body.appendChild(overlay);
    return overlay;
}

function onAppPreviewKeydown(e) {
    if (e.key === 'Escape' && appPreviewEl && appPreviewEl.classList.contains('show')) {
        e.preventDefault();
        closeAppPreviewModal();
    }
}

function openAppPreviewModal(result) {
    if (!appPreviewEl) appPreviewEl = buildAppPreviewModal();

    // Drop any previous preview before showing the new one.
    if (appPreviewUrl) URL.revokeObjectURL(appPreviewUrl);
    appPreviewUrl = URL.createObjectURL(result.blob);

    appPreviewEl.querySelector('#appPreviewTitle').textContent =
        'Annual Procurement Plan Preview \u2014 FY ' + result.fiscalYear;
    appPreviewEl.querySelector('#appPreviewFrame').src = appPreviewUrl + '#view=FitH';

    appPreviewPrevFocus = document.activeElement;
    appPreviewEl.classList.add('show');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onAppPreviewKeydown);
    appPreviewEl.querySelector('[data-app-preview-open]').focus();
}

function closeAppPreviewModal() {
    if (!appPreviewEl) return;
    appPreviewEl.classList.remove('show');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onAppPreviewKeydown);

    appPreviewEl.querySelector('#appPreviewFrame').src = 'about:blank';
    if (appPreviewUrl) {
        URL.revokeObjectURL(appPreviewUrl);
        appPreviewUrl = null;
    }
    if (appPreviewPrevFocus && typeof appPreviewPrevFocus.focus === 'function') {
        appPreviewPrevFocus.focus();
    }
}

// Adds the "Generate APP" link to the sidebar, right under Entries.
function addGenerateAppNavItem() {
    document.querySelectorAll('.db-nav').forEach(function (nav) {
        if (nav.querySelector('[data-generate-app]')) return;

        const link = document.createElement('a');
        link.href = '#';
        link.className = 'db-nav-item db-nav-app';
        link.setAttribute('data-generate-app', '');
        link.setAttribute('role', 'button');
        link.title = 'Generate the Annual Procurement Plan from all approved PPMPs';
        link.innerHTML = APP_NAV_ICON + '<span class="db-app-label">Generate APP</span>';
        link.addEventListener('click', function (e) {
            e.preventDefault();
            runGenerateApp();
        });

        const entriesLink = nav.querySelector('a[href="entries.html"]');
        if (entriesLink) {
            entriesLink.after(link);
        } else {
            nav.appendChild(link);
        }
    });
}

function renderAppExportButton() {
    const supplier = isSupplierSession();

    // Entries header buttons (Preview APP + Generate APP) + every Export APP
    // button in the request modal.
    document.querySelectorAll('.export-app-btn, [data-app-entry-btn], [data-app-preview-btn]').forEach(function (btn) {
        btn.style.display = supplier ? 'inline-flex' : 'none';
    });

    // The sidebar "Generate APP" link is intentionally no longer added for
    // Suppliers. They still generate the APP from the Entries page header
    // button and the Export APP buttons in the request modal.
    // (addGenerateAppNavItem() is kept above in case it is needed again.)
}

document.addEventListener('DOMContentLoaded', function () {
    renderAppExportButton();
});

function getFilteredEntryRecords(records) {
    const statusFilter = document.getElementById('entryStatusFilter');
    const indicativeFilter = document.getElementById('entryIndicativeFilter');
    const typeFilter = document.getElementById('entryTypeFilter');
    const categoryFilter = document.getElementById('entryCategoryFilter');
    const officeFilter = document.getElementById('entryOfficeFilter');
    const searchInput = document.getElementById('entrySearchInput');

    const statusValue = statusFilter ? statusFilter.value : 'All';
    const indicativeValue = indicativeFilter ? indicativeFilter.value : 'All';
    const typeValue = typeFilter ? typeFilter.value : 'All';
    const categoryValue = categoryFilter ? categoryFilter.value : 'All';
    const officeValue = officeFilter ? officeFilter.value : 'All';
    const searchValue = searchInput ? searchInput.value.trim().toLowerCase() : '';

    return records.filter(record => {
        const items = getRecordItems(record);
        const statusMatches = statusValue === 'All' || getPpmpStatus(record) === statusValue;
        const indicativeMatches = indicativeValue === 'All' || record.is_indicative === indicativeValue;
        const typeMatches = typeValue === 'All' || items.some(item => item.project_type === typeValue);
        const categoryMatches = categoryValue === 'All' || items.some(item => item.general_requirements === categoryValue);
        const officeMatches = officeValue === 'All' || record.end_user === officeValue;
        const searchHaystack = [
            record.ppmp_no,
            record.end_user,
            record.fiscal_year,
            ...items.map(item => item.project_description),
            ...items.map(item => item.project_type),
            ...items.map(item => item.mode),
            ...items.map(item => item.general_requirements)
        ].join(' ').toLowerCase();

        return statusMatches && indicativeMatches && typeMatches && categoryMatches && officeMatches && (!searchValue || searchHaystack.includes(searchValue));
    });
}


function getApprovedEntryNumbers(records) {
    // Only approved (Completed) entries get a number, and every office is
    // numbered on its own: FPIAP's fifth approval is "5" while an office with
    // nothing approved yet has no number at all. Numbers follow approval order
    // within the office and never shift because of filters or new requests.
    const numbers = new Map();
    const perOffice = new Map();

    records
        .filter(record => record.status === 'Completed')
        .sort((a, b) =>
            (Number(a.approved_at) || Number(a.id)) -
            (Number(b.approved_at) || Number(b.id))
        )
        .forEach(record => {
            const office = record.end_user || 'N/A';
            const next = (perOffice.get(office) || 0) + 1;
            perOffice.set(office, next);
            numbers.set(String(record.id), next);
        });

    return numbers;
}


// Fills the Office filter from the offices present in the records this account
// can see. Hidden when there is only one (requesting offices), so it only shows
// up for reviewers. Rebuilt only when the list changes, so an open dropdown
// is never disturbed by a re-render.
function populateOfficeFilter(records) {
    const select = document.getElementById('entryOfficeFilter');
    if (!select) return;

    const offices = [...new Set(records.map(r => r.end_user).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));

    const wrap = select.closest('.db-filter-control');
    if (wrap) wrap.classList.toggle('hidden', offices.length < 2);

    const wanted = ['All'].concat(offices);
    const have = Array.from(select.options).map(o => o.value);

    if (JSON.stringify(wanted) !== JSON.stringify(have)) {
        const current = select.value;
        select.innerHTML = wanted.map(o =>
            '<option value="' + escapeHtml(o) + '">' + (o === 'All' ? 'All offices' : escapeHtml(o)) + '</option>'
        ).join('');
        select.value = wanted.includes(current) ? current : 'All';
    }
}


// ------------------------------------------------------------
// Inline "Excel preview" dropdown on the Entries table.
// Clicking a row's PPMP number expands a preview of that PPMP directly
// under the row, built from the same buildExcelPreviewMarkup() used by
// the full-screen preview. Because renderEntries() re-runs on every
// filter/search change and re-derives this from the current filtered
// list, the dropdown is automatically "filter-aware": if the expanded
// PPMP gets filtered out, it collapses on its own.
// ------------------------------------------------------------
let expandedEntryId = null;

function toggleEntryPreviewRow(id) {
    // Collapsing (or opening another PPMP) throws away unsaved edits, so ask first.
    if (expandedEntryId !== null && isPreviewDirty(expandedEntryId) &&
        !confirm('You have unsaved changes in this PPMP. Discard them?')) {
        return;
    }
    // Whichever row was open loses its unsaved draft, whether we collapse it
    // or switch to another row.
    if (expandedEntryId !== null) {
        delete previewDrafts[expandedEntryId];
    }
    expandedEntryId = (expandedEntryId === id) ? null : id;
    resetEntryItemFilters();
    renderEntries(getRecords());
}

// ------------------------------------------------------------
// Inline item editing — field handlers. These write into the draft only
// (never localStorage) and touch just the dirty indicator in the DOM, so
// typing never triggers a full table re-render and never drops focus.
// ------------------------------------------------------------
function updatePreviewDirtyIndicator(recordId) {
    document.querySelectorAll(`.ep-dirty-indicator[data-record-id="${recordId}"]`).forEach(el => {
        el.classList.toggle('hidden', !isPreviewDirty(recordId));
    });
}

function onPreviewFieldInput(el) {
    const recordId = Number(el.dataset.recordId);
    const itemId = Number(el.dataset.itemId);
    const field = el.dataset.field;
    const draft = previewDrafts[recordId];
    if (!draft) return;

    const item = draft.items.find(it => it.id == itemId);
    if (!item) return;

    // Stop clearly wrong characters at the keyboard.
    if (field === 'budget') {
        const cleaned = cleanBudgetInput(el.value);
        if (cleaned !== el.value) el.value = cleaned;
    }

    item[field] = el.value;
    updatePreviewDirtyIndicator(recordId);

    // Picking from a list or a calendar is a deliberate choice, so check it
    // right away; for typed text wait until the person leaves the box
    // (unless it already showed an error - then clear it as they fix it).
    if (el.tagName === 'SELECT' || el.type === 'date') markPreviewTouched(draft, itemId, field);

    if (field === 'start_date' || field === 'end_date') syncPreviewDateLimits(recordId, itemId, item);
    if (field === 'project_type') refreshPreviewDocCell(recordId, itemId);

    if (isPreviewTouched(draft, itemId, field)) validatePreviewField(recordId, itemId, field);
}

function onPreviewStrategyToggle(checkbox) {
    const recordId = Number(checkbox.dataset.recordId);
    const itemId = Number(checkbox.dataset.itemId);
    const draft = previewDrafts[recordId];
    if (!draft) return;

    const item = draft.items.find(it => it.id == itemId);
    if (!item) return;

    const current = new Set(Array.isArray(item.strategies) ? item.strategies : []);
    if (checkbox.checked) current.add(checkbox.value); else current.delete(checkbox.value);
    item.strategies = Array.from(current);
    updatePreviewDirtyIndicator(recordId);

    markPreviewTouched(draft, itemId, 'strategies');
    validatePreviewField(recordId, itemId, 'strategies');
}

// Leaving a text box counts as "done typing", so its error (if any) can show.
document.addEventListener('focusout', function (e) {
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains('ep-input')) return;
    const recordId = Number(el.dataset.recordId);
    const itemId = Number(el.dataset.itemId);
    const field = el.dataset.field;
    const draft = previewDrafts[recordId];
    if (!draft || !field) return;
    markPreviewTouched(draft, itemId, field);
    validatePreviewField(recordId, itemId, field);
});

// Budget: digits and one decimal point, at most 2 decimals.
function cleanBudgetInput(raw) {
    let value = String(raw).replace(/[^0-9.]/g, '');
    const parts = value.split('.');
    if (parts.length > 2) value = parts[0] + '.' + parts.slice(1).join('');
    const bits = value.split('.');
    if (bits.length === 2) value = bits[0] + '.' + bits[1].slice(0, 2);
    return value;
}

function previewNextDay(isoDate) {
    const d = new Date(isoDate + 'T00:00:00Z');
    if (isNaN(d)) return '2000-01-01';
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

// Keeps the calendar pickers from offering dates the rules would reject.
function syncPreviewDateLimits(recordId, itemId, item) {
    document.querySelectorAll(`[data-record-id="${recordId}"][data-item-id="${itemId}"][data-field="end_date"]`).forEach(el => {
        el.min = item.start_date || '2000-01-01';
    });
    document.querySelectorAll(`[data-record-id="${recordId}"][data-item-id="${itemId}"][data-field="delivery_period"]`).forEach(el => {
        el.min = item.end_date ? previewNextDay(item.end_date) : '2000-01-01';
    });
}

// ------------------------------------------------------------
// Validation for inline edits. These are the same rules the request form
// applies (required fields, minimum lengths, budget > 0, mode matching the
// budget bracket, date order), so an edit made here can never save
// something the form would have refused.
// ------------------------------------------------------------
const PREVIEW_ALL_FIELDS = [
    'project_description', 'project_type', 'quantity_size', 'mode', 'pre_procurement',
    'bid_evaluation_criteria', 'start_date', 'end_date', 'delivery_period',
    'fund_source', 'budget', 'strategies', 'remarks'
];

// When one field changes, these others may become right or wrong too.
const PREVIEW_FIELD_DEPENDENTS = {
    budget: ['budget', 'mode'],
    mode: ['mode', 'budget'],
    start_date: ['start_date', 'end_date', 'delivery_period'],
    end_date: ['end_date', 'delivery_period'],
    delivery_period: ['end_date', 'delivery_period']
};

const PREVIEW_FALLBACK_BRACKETS = [
    { max: 199999, mode: 'Direct Acquisition', label: '\u20B10 \u2013 \u20B1199,999' },
    { max: 1999999, mode: 'Small Value Procurement (SVP)', label: '\u20B1200,000 \u2013 \u20B11,999,999' },
    { max: Infinity, mode: 'Competitive Bidding', label: '\u20B12,000,000 and above' }
];

function getPreviewModeValues() {
    const out = [];
    PREVIEW_MODE_GROUPS.forEach(group => (group.options || []).forEach(opt => out.push(opt)));
    return out;
}

function parsePreviewBudget(raw) {
    const cleaned = String(raw == null ? '' : raw).replace(/[,\s\u20B1]/g, '').replace(/^P/i, '');
    if (cleaned === '' || !/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return NaN;
    return Number(cleaned);
}

function isRealPreviewDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    if (isNaN(d) || d.toISOString().slice(0, 10) !== value) return false;
    const year = d.getUTCFullYear();
    return year >= 2000 && year <= 2100;
}

// Returns { field: 'message' } for everything wrong with one item.
function validatePreviewItem(item) {
    const errors = {};
    const text = key => String(item[key] == null ? '' : item[key]).trim();

    if (!text('project_description')) errors.project_description = 'Project description is required.';

    if (!text('project_type')) errors.project_type = 'Select a type of project.';
    else if (PREVIEW_PROJECT_TYPES.indexOf(text('project_type')) === -1) errors.project_type = 'Choose a type from the list.';

    if (!text('quantity_size')) errors.quantity_size = 'Quantity and size is required.';
    else if (text('quantity_size').length < 3) errors.quantity_size = 'Please provide a more detailed quantity or size.';

    if (!text('mode')) errors.mode = 'Select a mode of procurement.';
    else if (getPreviewModeValues().indexOf(text('mode')) === -1) errors.mode = 'Choose a mode from the list.';

    if (!text('pre_procurement')) errors.pre_procurement = 'Select Yes or No.';
    else if (['Yes', 'No'].indexOf(text('pre_procurement')) === -1) errors.pre_procurement = 'Choose Yes or No.';

    if (!text('bid_evaluation_criteria')) errors.bid_evaluation_criteria = 'Select the criteria for bid evaluation.';
    else if (PREVIEW_CRITERIA_OPTIONS.indexOf(text('bid_evaluation_criteria')) === -1) errors.bid_evaluation_criteria = 'Choose a criteria from the list.';

    // Dates: present, real, in range, and in order.
    const start = text('start_date'), end = text('end_date'), delivery = text('delivery_period');
    if (!start) errors.start_date = 'Select a start date.';
    else if (!isRealPreviewDate(start)) errors.start_date = 'Enter a valid date (2000-2100).';
    if (!end) errors.end_date = 'Select an end date.';
    else if (!isRealPreviewDate(end)) errors.end_date = 'Enter a valid date (2000-2100).';
    if (!delivery) errors.delivery_period = 'Select the expected delivery/implementation date.';
    else if (!isRealPreviewDate(delivery)) errors.delivery_period = 'Enter a valid date (2000-2100).';

    if (!errors.start_date && !errors.end_date && new Date(end) < new Date(start)) {
        errors.end_date = 'End date cannot be earlier than the start date.';
    }
    if (!errors.end_date && !errors.delivery_period && new Date(delivery) <= new Date(end)) {
        errors.delivery_period = 'Delivery must be after the end of procurement activity.';
    }

    if (!text('fund_source')) errors.fund_source = 'Source of funds is required.';
    else if (text('fund_source').length < 2) errors.fund_source = 'Please provide a valid fund source.';

    // Budget: a real number above zero, and consistent with the mode.
    const budgetRaw = text('budget');
    const budgetNumber = parsePreviewBudget(budgetRaw);
    if (!budgetRaw) errors.budget = 'Estimated budget is required.';
    else if (isNaN(budgetNumber)) errors.budget = 'Budget must contain a valid number.';
    else if (budgetNumber <= 0) errors.budget = 'Budget must be greater than 0.';

    if (!errors.mode && !errors.budget && text('mode') && budgetRaw) {
        const brackets = (typeof MODE_BUDGET_BRACKETS !== 'undefined') ? MODE_BUDGET_BRACKETS : PREVIEW_FALLBACK_BRACKETS;
        const isBracketMode = brackets.some(tier => tier.mode === text('mode'));
        if (isBracketMode) {
            const recommended = brackets.find(tier => budgetNumber <= tier.max) || brackets[brackets.length - 1];
            if (recommended.mode !== text('mode')) {
                const message = 'A budget of \u20B1' + budgetNumber.toLocaleString('en-PH', { maximumFractionDigits: 2 }) +
                    ' falls in the ' + recommended.label + ' bracket, which requires "' + recommended.mode + '".';
                errors.mode = message;
                errors.budget = message;
            }
        }
    }

    if (!Array.isArray(item.strategies) || item.strategies.length === 0) {
        errors.strategies = 'Select at least one procurement strategy.';
    }

    if (!text('remarks')) errors.remarks = 'Remarks are required.';
    else if (text('remarks').length < 3) errors.remarks = 'Remarks must contain at least 3 characters.';

    return errors;
}

function markPreviewTouched(draft, itemId, field) {
    if (!draft.touched) draft.touched = {};
    if (!draft.touched[itemId]) draft.touched[itemId] = {};
    draft.touched[itemId][field] = true;
}

function isPreviewTouched(draft, itemId, field) {
    return !!(draft.touched && draft.touched[itemId] && draft.touched[itemId][field]);
}

// Shows (or clears) the red outline + message under one field, on every
// surface currently showing this record.
function setPreviewFieldError(recordId, itemId, field, message) {
    const selector = field === 'strategies'
        ? `.ep-strategies-box[data-record-id="${recordId}"][data-item-id="${itemId}"]`
        : `[data-record-id="${recordId}"][data-item-id="${itemId}"][data-field="${field}"]`;

    document.querySelectorAll(selector).forEach(el => {
        const cell = el.closest('td');
        if (!cell) return;
        el.classList.toggle('is-invalid', !!message);
        let msg = cell.querySelector('.ep-cell-error[data-for="' + field + '"]');
        if (message) {
            if (!msg) {
                msg = document.createElement('div');
                msg.className = 'ep-cell-error';
                msg.dataset.for = field;
                msg.setAttribute('role', 'alert');
                cell.appendChild(msg);
            }
            msg.textContent = message;
        } else if (msg) {
            msg.remove();
        }
    });
}

// Re-checks one field (and the fields that depend on it, if the person has
// already visited them).
function validatePreviewField(recordId, itemId, field) {
    const draft = previewDrafts[recordId];
    if (!draft) return;
    const item = draft.items.find(it => it.id == itemId);
    if (!item) return;

    const errors = validatePreviewItem(item);

    // A mode that doesn't fit the budget is wrong on BOTH fields, so show it
    // on both. A dependent field is also updated if it is already showing an
    // error (so the error disappears when the other field is fixed).
    const sharedMismatch = !!errors.mode && errors.mode === errors.budget;
    (PREVIEW_FIELD_DEPENDENTS[field] || [field]).forEach(f => {
        const showingError = !!document.querySelector(
            `.ep-cell-error[data-for="${f}"]`
        ) && !!document.querySelector(`[data-record-id="${recordId}"][data-item-id="${itemId}"][data-field="${f}"].is-invalid, .ep-strategies-box.is-invalid[data-item-id="${itemId}"]`);
        const isBracketField = (f === 'mode' || f === 'budget') && sharedMismatch;
        if (f === field || isPreviewTouched(draft, itemId, f) || isBracketField || showingError) {
            setPreviewFieldError(recordId, itemId, f, errors[f] || '');
        }
    });
}

// Checks every item and shows every problem. Returns how many fields failed.
function validatePreviewDraft(recordId) {
    const draft = previewDrafts[recordId];
    if (!draft) return 0;
    let count = 0;
    draft.items.forEach(item => {
        const errors = validatePreviewItem(item);
        PREVIEW_ALL_FIELDS.forEach(field => {
            markPreviewTouched(draft, item.id, field);
            setPreviewFieldError(recordId, item.id, field, errors[field] || '');
            if (errors[field]) count += 1;
        });
    });
    return count;
}

// A re-render (for example after Add Item) rebuilds the cells, so put back
// the errors for every field the person has already visited.
function reapplyPreviewErrors() {
    Object.keys(previewDrafts).forEach(key => {
        const recordId = Number(key);
        const draft = previewDrafts[key];
        draft.items.forEach(item => {
            const errors = validatePreviewItem(item);
            PREVIEW_ALL_FIELDS.forEach(field => {
                if (isPreviewTouched(draft, item.id, field) && errors[field]) {
                    setPreviewFieldError(recordId, item.id, field, errors[field]);
                }
            });
        });
    });
}

// ------------------------------------------------------------
// Supporting documents while editing: attach, open, download, remove.
// Same limits as the request form (2 MB per file, 8 MB per item).
// ------------------------------------------------------------
function previewFileLimits() {
    return {
        file: (typeof MAX_FILE_SIZE === 'number') ? MAX_FILE_SIZE : 2 * 1024 * 1024,
        total: (typeof MAX_TOTAL_SIZE === 'number') ? MAX_TOTAL_SIZE : 8 * 1024 * 1024
    };
}

function previewFormatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderPreviewDocEditor(item, recordId) {
    const docs = Array.isArray(item && item.supporting_documents) ? item.supporting_documents : [];
    const limits = previewFileLimits();
    const labels = (typeof PROJECT_TYPE_DOC_LABELS !== 'undefined') ? PROJECT_TYPE_DOC_LABELS : {};
    const required = labels[item && item.project_type];
    const rid = Number(recordId);
    const iid = escapeHtml(item.id);

    const list = docs.length === 0
        ? '<span class="ep-none">None attached</span>'
        : '<ul class="ep-list ep-doc-list">' + docs.map(function (doc, index) {
            const name = (doc && doc.name) || 'Document';
            const attrs = ' data-record-id="' + rid + '" data-item-id="' + iid + '" data-doc-index="' + index + '"';
            const open = (doc && doc.dataUrl)
                ? '<button type="button" class="ep-doc-link"' + attrs + ' title="Open ' + escapeHtml(name) + '" onclick="openPreviewDoc(this, event)">' + escapeHtml(name) + '</button>' +
                  '<button type="button" class="ep-doc-download"' + attrs + ' title="Download ' + escapeHtml(name) + '" aria-label="Download ' + escapeHtml(name) + '" onclick="downloadPreviewDoc(this, event)">' +
                  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
                : '<span>' + escapeHtml(name) + '</span>';
            return '<li class="ep-doc-item">' + open +
                '<button type="button" class="ep-doc-remove"' + attrs + ' title="Remove ' + escapeHtml(name) + '" aria-label="Remove ' + escapeHtml(name) + '" onclick="removePreviewDoc(this, event)">' +
                '<svg viewBox="0 0 24 24" width="11" height="11" fill="none"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></li>';
        }).join('') + '</ul>';

    return list +
        '<input type="file" class="ep-doc-input" multiple hidden data-record-id="' + rid + '" data-item-id="' + iid + '" onchange="onPreviewDocsPicked(this)">' +
        '<button type="button" class="ep-doc-attach-btn" onclick="triggerPreviewDocPicker(this)">+ Attach file</button>' +
        '<div class="ep-doc-hint">' + (required ? 'Required: ' + escapeHtml(required) + '. ' : 'Pick a project type to see the required document. ') +
        'Max ' + previewFormatSize(limits.file) + ' per file.</div>';
}

function refreshPreviewDocCell(recordId, itemId) {
    const draft = previewDrafts[recordId];
    if (!draft) return;
    const item = draft.items.find(it => it.id == itemId);
    if (!item) return;
    document.querySelectorAll(`.ep-doc-cell[data-record-id="${recordId}"][data-item-id="${itemId}"] .ep-doc-cell-body`).forEach(body => {
        body.innerHTML = renderPreviewDocEditor(item, recordId);
    });
}

function triggerPreviewDocPicker(btn) {
    const cell = btn.closest('.ep-doc-cell');
    const input = cell && cell.querySelector('.ep-doc-input');
    if (input) input.click();
}

function onPreviewDocsPicked(input) {
    const recordId = Number(input.dataset.recordId);
    const itemId = Number(input.dataset.itemId);
    const draft = previewDrafts[recordId];
    const files = Array.from(input.files || []);
    input.value = '';
    if (!draft || files.length === 0) return;

    const item = draft.items.find(it => it.id == itemId);
    if (!item) return;
    if (!Array.isArray(item.supporting_documents)) item.supporting_documents = [];

    const limits = previewFileLimits();
    const problems = [];
    let usedBytes = item.supporting_documents.reduce((sum, d) => sum + (Number(d.size) || 0), 0) + (draft.pendingSize || 0);

    files.forEach(file => {
        const duplicate = item.supporting_documents.some(d => d.name === file.name && Number(d.size) === file.size);
        if (duplicate) { problems.push('"' + file.name + '" is already attached.'); return; }
        if (file.size > limits.file) {
            problems.push('"' + file.name + '" is ' + previewFormatSize(file.size) + ', over the ' + previewFormatSize(limits.file) + ' per-file limit.');
            return;
        }
        if (usedBytes + file.size > limits.total) {
            problems.push('Adding "' + file.name + '" would exceed the ' + previewFormatSize(limits.total) + ' limit for this item.');
            return;
        }

        usedBytes += file.size;
        draft.pending = (draft.pending || 0) + 1;
        draft.pendingSize = (draft.pendingSize || 0) + file.size;

        const reader = new FileReader();
        reader.onload = function (event) {
            draft.pending -= 1;
            draft.pendingSize -= file.size;
            if (previewDrafts[recordId] !== draft) return;      // edit was cancelled meanwhile
            item.supporting_documents.push({ name: file.name, size: file.size, dataUrl: event.target.result });
            refreshPreviewDocCell(recordId, itemId);
            updatePreviewDirtyIndicator(recordId);
        };
        reader.onerror = function () {
            draft.pending -= 1;
            draft.pendingSize -= file.size;
            showToast('"' + file.name + '" could not be read. Please try attaching it again.');
        };
        reader.readAsDataURL(file);
    });

    if (problems.length) {
        showToast(problems[0] + (problems.length > 1 ? ' (+' + (problems.length - 1) + ' more)' : ''));
    }
}

function removePreviewDoc(btn, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const recordId = Number(btn.dataset.recordId);
    const itemId = btn.dataset.itemId;
    const draft = previewDrafts[recordId];
    if (!draft) return;
    const item = draft.items.find(it => it.id == itemId);
    if (!item || !Array.isArray(item.supporting_documents)) return;
    item.supporting_documents.splice(Number(btn.dataset.docIndex), 1);
    refreshPreviewDocCell(recordId, itemId);
    updatePreviewDirtyIndicator(recordId);
}

function addPreviewItem(recordId) {
    const record = getRawRecordById(recordId);
    if (!record || isPpmpLocked(record)) return;

    const draft = ensurePreviewDraft(record);
    const fresh = blankPreviewItem();
    draft.items.push(fresh);
    refreshPreviewSurfaces(recordId);

    // Drop the cursor into the new row's first box.
    setTimeout(function () {
        const first = document.querySelector(`[data-record-id="${recordId}"][data-item-id="${fresh.id}"][data-field="project_description"]`);
        if (first) {
            if (typeof first.scrollIntoView === 'function') first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            first.focus({ preventScroll: true });
        }
    }, 0);
}

// The "+" button in the dropdown toolbar: switches the PPMP into edit mode
// (if it isn't already) and drops a blank row in, so another entry is typed
// straight into the dropdown instead of going through the request form.
// Nothing is saved until Save Changes, same as every other inline edit.
function addEntryInline(recordId) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || !session.canRequest) {
        showToast('Your account is view/approve only and cannot add items.');
        return;
    }
    const record = getRawRecordById(recordId);
    if (!record) return;
    if (isPpmpLocked(record)) {
        showToast('This PPMP is locked and can no longer be edited.');
        return;
    }
    addPreviewItem(recordId);
}

// ------------------------------------------------------------
// SUBMIT FOR APPROVAL
// Moves a Draft PPMP to "For Approval". From then on it is visible to
// approvers (see getRecords) and locked against edits by the requester.
// Confirmation reuses the .logout-* dialog styling, like the approval one.
// ------------------------------------------------------------
let submitApprovalEl = null;
let submitApprovalRecordId = null;
let submitApprovalPrevFocus = null;

function buildSubmitApprovalDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'logout-overlay';
    overlay.id = 'submitApprovalOverlay';
    overlay.innerHTML =
        '<div class="logout-modal" role="alertdialog" aria-modal="true" aria-labelledby="submitApprovalTitle" aria-describedby="submitApprovalDesc">' +
            '<div class="logout-icon is-approve">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M5 12L19 5L15 19L11.5 13L5 12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
            '</div>' +
            '<h3 id="submitApprovalTitle">Submit for approval?</h3>' +
            '<p id="submitApprovalDesc"></p>' +
            '<div class="logout-actions">' +
                '<button type="button" class="logout-cancel-btn" data-submit-cancel>Cancel</button>' +
                '<button type="button" class="logout-confirm-btn is-approve" data-submit-confirm>Submit</button>' +
            '</div>' +
        '</div>';

    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeSubmitApprovalDialog();
    });
    overlay.querySelector('[data-submit-cancel]').addEventListener('click', closeSubmitApprovalDialog);
    overlay.querySelector('[data-submit-confirm]').addEventListener('click', confirmSubmitForApproval);

    document.body.appendChild(overlay);
    return overlay;
}

function onSubmitApprovalKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't also close the Excel preview / request modal behind it
        closeSubmitApprovalDialog();
    }
}

function openSubmitApprovalDialog(recordId) {
    const record = getRawRecordById(recordId);
    if (!record || !isPpmpDraft(record)) return;

    if (isPreviewDirty(recordId)) {
        showToast('You have unsaved changes - Save or Cancel them before submitting.');
        return;
    }

    const missingDocs = getItemsMissingDocuments(record);
    if (missingDocs.length > 0) {
        showToast(buildMissingDocsMessage(missingDocs));
        return;
    }

    if (!submitApprovalEl) submitApprovalEl = buildSubmitApprovalDialog();
    submitApprovalRecordId = recordId;

    document.getElementById('submitApprovalTitle').textContent =
        'Submit PPMP No. ' + (record.ppmp_no || 'N/A') + ' for approval?';
    document.getElementById('submitApprovalDesc').textContent =
        (session_isHead() ? 'Its status will change from Draft to For Approval and it goes straight to the TOD. ' :
                            'Its status will change from Draft to For Approval and it goes to your Unit Head. ') +
        'While it is under review it can no longer be edited or get new items.';

    submitApprovalPrevFocus = document.activeElement;
    submitApprovalEl.classList.add('show');
    document.addEventListener('keydown', onSubmitApprovalKeydown, true);

    // Default focus on Cancel so a stray Enter never submits anything.
    submitApprovalEl.querySelector('[data-submit-cancel]').focus();
}

function closeSubmitApprovalDialog() {
    if (!submitApprovalEl) return;
    submitApprovalEl.classList.remove('show');
    document.removeEventListener('keydown', onSubmitApprovalKeydown, true);
    if (submitApprovalPrevFocus && typeof submitApprovalPrevFocus.focus === 'function') {
        submitApprovalPrevFocus.focus();
    }
}

function confirmSubmitForApproval() {
    const recordId = submitApprovalRecordId;
    closeSubmitApprovalDialog();
    submitApprovalRecordId = null;
    if (recordId === null) return;

    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session) return;

    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = all.findIndex(r => r.id == recordId);
    if (idx === -1) return;

    if (!isPpmpDraft(all[idx])) {
        showToast('This PPMP was already submitted for approval.');
        refreshPreviewSurfaces(recordId);
        return;
    }

    const missingDocs = getItemsMissingDocuments(all[idx]);
    if (missingDocs.length > 0) {
        showToast(buildMissingDocsMessage(missingDocs));
        refreshPreviewSurfaces(recordId);
        return;
    }

    all[idx].status = 'For Approval';
    all[idx].submitted_at = Date.now();
    // A resubmission after a rejection starts a new review round.
    all[idx].returned_for_revision = false;
    all[idx].submission_round = (Number(all[idx].submission_round) || 1) + (all[idx].rejected_at ? 1 : 0);

    if (session.stage === 'HEAD') {
        // Unit Head submitting for their own unit: counts as the head's approval.
        all[idx].currentApproverRole = SECOND_APPROVAL_STAGE;
        if (!Array.isArray(all[idx].remarksHistory)) all[idx].remarksHistory = [];
        all[idx].remarksHistory.push({
            stage: 'HEAD',
            role: session.role,
            name: session.roleName,
            action: 'submitted',
            round: all[idx].submission_round,
            remarks: 'Submitted by the Unit Head.',
            date: new Date().toLocaleDateString(),
            at: Date.now()
        });
    } else {
        all[idx].currentApproverRole = FIRST_APPROVAL_STAGE;
    }
    all[idx].submitted_by = {
        name: session.roleName,
        role: session.role,
        email: session.email
    };

    try {
        localStorage.setItem('procurement_records', JSON.stringify(all));
    } catch (err) {
        showToast('Could not submit for approval — please try again.');
        return;
    }

    delete previewDrafts[recordId];
    refreshDashboardRecords();
    refreshPreviewSurfaces(recordId);
    showToast('PPMP No. ' + all[idx].ppmp_no + ' submitted for approval.');
}

function removePreviewItem(recordId, itemId) {
    const draft = previewDrafts[recordId];
    if (!draft) return;

    if (draft.items.length <= 1) {
        showToast('A PPMP needs at least one item — add a replacement before removing this one.');
        return;
    }

    draft.items = draft.items.filter(it => it.id != itemId);
    refreshPreviewSurfaces(recordId);
}

// Resets the draft back to the last-saved version (does not collapse the
// dropdown), so the person can see the discard take effect immediately.
function discardPreviewChanges(recordId) {
    if (isPreviewDirty(recordId) && !confirm('Discard your unsaved changes to this PPMP?')) return;
    delete previewDrafts[recordId];
    refreshPreviewSurfaces(recordId);
}

function savePreviewChanges(recordId) {
    const draft = previewDrafts[recordId];
    if (!draft) return;

    if (draft.pending > 0) {
        showToast('Still attaching files - wait a moment, then press Save Changes again.');
        return;
    }

    // Tidy the text the person typed, then check every item against the same
    // rules the request form uses. Nothing is saved until all of it passes.
    draft.items.forEach(item => {
        ['project_description', 'quantity_size', 'fund_source', 'general_requirements', 'remarks'].forEach(key => {
            item[key] = String(item[key] == null ? '' : item[key]).trim();
        });
        const budget = parsePreviewBudget(item.budget);
        if (!isNaN(budget)) item.budget = String(item.budget).replace(/[,\s\u20B1]/g, '').replace(/^P/i, '');
    });

    const problemCount = validatePreviewDraft(recordId);
    if (problemCount > 0) {
        showToast('Please fix ' + problemCount + ' highlighted ' + (problemCount === 1 ? 'field' : 'fields') + ' before saving.');
        const firstBad = document.querySelector('.ep-input.is-invalid, .ep-strategies-box.is-invalid');
        if (firstBad) {
            if (typeof firstBad.scrollIntoView === 'function') firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
            if (typeof firstBad.focus === 'function' && firstBad.tagName !== 'DIV') firstBad.focus({ preventScroll: true });
        }
        return;
    }

    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = all.findIndex(r => r.id == recordId);
    if (idx === -1) return;

    if (getPpmpStatus(all[idx]) !== 'Draft') {
        showToast('This PPMP was submitted or approved while you were editing, so it is now read-only.');
        delete previewDrafts[recordId];
        refreshPreviewSurfaces(recordId);
        return;
    }

    all[idx].items = JSON.parse(JSON.stringify(draft.items));

    try {
        localStorage.setItem('procurement_records', JSON.stringify(all));
    } catch (err) {
        showToast('Could not save - the attached files are too large for browser storage. Remove or shrink an attachment and try again.');
        return;
    }

    delete previewDrafts[recordId];
    refreshDashboardRecords();
    refreshPreviewSurfaces(recordId);
    showToast('PPMP items saved.');
}


// ------------------------------------------------------------
// Item filter inside the expanded PPMP dropdown (Entries page)
// Lets the person narrow the line items of the one open PPMP by
// keyword, project type, mode of procurement and document status.
//
// Filtering is done by hiding/showing the item <tr> rows already in the
// DOM (each carries data-* attributes, see itemFilterAttrs), NOT by
// re-rendering the table. That keeps typing smooth and the search box
// focused. The filter state lives in entryItemFilters, resets whenever a
// different PPMP is opened, and is re-applied after every renderEntries().
// The bar only shows in read-only view (editing always shows every item)
// and only when the PPMP has 2+ items. The PDF export and the full-screen
// preview are unaffected and always contain every item.
// ------------------------------------------------------------
const ENTRY_ITEM_FILTER_DEFAULTS = { search: '', type: 'All', category: 'All', mode: 'All', docs: 'All' };
let entryItemFilters = Object.assign({}, ENTRY_ITEM_FILTER_DEFAULTS);

function resetEntryItemFilters() {
    entryItemFilters = Object.assign({}, ENTRY_ITEM_FILTER_DEFAULTS);
}

function isEntryItemFilterActive() {
    const f = entryItemFilters;
    return !!(f.search.trim() || f.type !== 'All' || f.category !== 'All' || f.mode !== 'All' || f.docs !== 'All');
}

// data-* attributes for one item row: everything the filter needs to
// decide whether the row matches, without touching the DOM cells.
function itemFilterAttrs(item) {
    const docNames = Array.isArray(item.supporting_documents)
        ? item.supporting_documents.map(function (d) { return d.name || ''; })
        : [];
    const haystack = [
        item.project_description, item.project_type, item.quantity_size, item.mode,
        item.pre_procurement, item.bid_evaluation_criteria, item.fund_source,
        item.remarks, item.general_requirements, item.start_date, item.end_date, item.delivery_period,
        formatPesoExact(parseBudgetNumber(item.budget)),
        Array.isArray(item.strategies) ? item.strategies.join(' ') : item.strategies,
        docNames.join(' ')
    ].map(function (v) { return String(v == null ? '' : v); }).join(' ').toLowerCase();

    return 'data-search="' + escapeHtml(haystack) + '"' +
        ' data-type="' + escapeHtml(item.project_type || '') + '"' +
        ' data-category="' + escapeHtml(item.general_requirements || '') + '"' +
        ' data-mode="' + escapeHtml(item.mode || '') + '"' +
        ' data-docs="' + (itemHasSupportingDocument(item) ? 'with' : 'missing') + '"' +
        ' data-budget="' + parseBudgetNumber(item.budget) + '"';
}

function buildItemFilterBarHtml(record) {
    const items = getRecordItems(record);
    if (items.length < 2) return '';

    function uniqueValues(key) {
        const seen = [];
        items.forEach(function (item) {
            const v = String(item[key] || '').trim();
            if (v && seen.indexOf(v) === -1) seen.push(v);
        });
        return seen.sort();
    }
    const types = uniqueValues('project_type');
    const modes = uniqueValues('mode');

    // Category = the "General Requirements/Miscellaneous/Common Supplies and
    // Equipment" choice. Only the categories actually used by this PPMP's
    // items are offered, plus "None" when some item has no category.
    const usedCategories = uniqueValues('general_requirements');
    const categories = PREVIEW_GENERAL_REQUIREMENT_OPTIONS.filter(function (c) { return usedCategories.indexOf(c) !== -1; })
        .concat(usedCategories.filter(function (c) { return PREVIEW_GENERAL_REQUIREMENT_OPTIONS.indexOf(c) === -1; }));
    const hasUncategorized = items.some(function (item) { return !String(item.general_requirements || '').trim(); });

    // A stale selection (its items were deleted) falls back to "All".
    if (entryItemFilters.type !== 'All' && types.indexOf(entryItemFilters.type) === -1) entryItemFilters.type = 'All';
    if (entryItemFilters.mode !== 'All' && modes.indexOf(entryItemFilters.mode) === -1) entryItemFilters.mode = 'All';
    if (entryItemFilters.category !== 'All' && entryItemFilters.category !== '__none__' && categories.indexOf(entryItemFilters.category) === -1) entryItemFilters.category = 'All';
    if (entryItemFilters.category === '__none__' && !hasUncategorized) entryItemFilters.category = 'All';

    function options(values, current, allLabel) {
        return '<option value="All">' + allLabel + '</option>' + values.map(function (v) {
            return '<option value="' + escapeHtml(v) + '"' + (v === current ? ' selected' : '') + '>' + escapeHtml(v) + '</option>';
        }).join('');
    }

    const docs = entryItemFilters.docs;
    return `
        <div class="ep-filter-bar" role="search" aria-label="Filter items in this PPMP">
            <label class="db-filter-control ep-filter-search">
                <span>Search items</span>
                <input id="epFilterSearch" type="search" placeholder="Description, remarks, fund source…"
                       value="${escapeHtml(entryItemFilters.search)}" oninput="onEntryItemFilterChange()">
            </label>
            <label class="db-filter-control">
                <span>Item type</span>
                <select id="epFilterType" onchange="onEntryItemFilterChange()">${options(types, entryItemFilters.type, 'All types')}</select>
            </label>
            <label class="db-filter-control">
                <span>Category</span>
                <select id="epFilterCategory" onchange="onEntryItemFilterChange()">${options(categories, entryItemFilters.category, 'All categories')}${hasUncategorized ? '<option value="__none__"' + (entryItemFilters.category === '__none__' ? ' selected' : '') + '>None / Not applicable</option>' : ''}</select>
            </label>
            <label class="db-filter-control">
                <span>Mode</span>
                <select id="epFilterMode" onchange="onEntryItemFilterChange()">${options(modes, entryItemFilters.mode, 'All modes')}</select>
            </label>
            <label class="db-filter-control">
                <span>Documents</span>
                <select id="epFilterDocs" onchange="onEntryItemFilterChange()">
                    <option value="All"${docs === 'All' ? ' selected' : ''}>All</option>
                    <option value="with"${docs === 'with' ? ' selected' : ''}>With document</option>
                    <option value="missing"${docs === 'missing' ? ' selected' : ''}>Missing document</option>
                </select>
            </label>
            <div class="ep-filter-meta">
                <span id="epFilterCount" class="ep-filter-count" aria-live="polite"></span>
                <button type="button" id="epFilterClear" class="ep-filter-clear hidden" onclick="clearEntryItemFilters()">Clear filters</button>
            </div>
        </div>
    `;
}

function onEntryItemFilterChange() {
    const get = function (id, fallback) {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
    };
    entryItemFilters = {
        search: get('epFilterSearch', ''),
        type: get('epFilterType', 'All'),
        category: get('epFilterCategory', 'All'),
        mode: get('epFilterMode', 'All'),
        docs: get('epFilterDocs', 'All')
    };
    applyEntryItemFilters();
}

function clearEntryItemFilters() {
    resetEntryItemFilters();
    const search = document.getElementById('epFilterSearch');
    if (search) {
        search.value = '';
        search.focus();
    }
    ['epFilterType', 'epFilterCategory', 'epFilterMode', 'epFilterDocs'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.value = 'All';
    });
    applyEntryItemFilters();
}

// Shows/hides item rows in the open dropdown to match entryItemFilters
// and refreshes the count, "Clear filters" button, empty message and the
// filtered subtotal. The real TOTAL BUDGET row always stays the full total.
function applyEntryItemFilters() {
    const inner = document.querySelector('.db-entry-expand-inner');
    if (!inner) return;

    const rows = inner.querySelectorAll('tr.ep-item-row');
    if (rows.length === 0) return;

    const f = entryItemFilters;
    const terms = f.search.toLowerCase().split(/\s+/).filter(Boolean);
    const active = isEntryItemFilterActive();
    let shown = 0;
    let subtotal = 0;

    rows.forEach(function (row) {
        const d = row.dataset;
        const matches =
            (f.type === 'All' || d.type === f.type) &&
            (f.category === 'All' || (f.category === '__none__' ? d.category === '' : d.category === f.category)) &&
            (f.mode === 'All' || d.mode === f.mode) &&
            (f.docs === 'All' || d.docs === f.docs) &&
            terms.every(function (t) { return d.search.indexOf(t) !== -1; });

        row.classList.toggle('hidden', !matches);
        if (matches) {
            shown += 1;
            subtotal += Number(d.budget) || 0;
        }
    });

    const count = inner.querySelector('#epFilterCount');
    if (count) {
        count.textContent = active
            ? 'Showing ' + shown + ' of ' + rows.length + ' items'
            : rows.length + ' items';
    }

    const clearBtn = inner.querySelector('#epFilterClear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !active);

    const emptyRow = inner.querySelector('tr.ep-filter-empty');
    if (emptyRow) emptyRow.classList.toggle('hidden', shown !== 0);

    const subtotalRow = inner.querySelector('tr.ep-filter-subtotal');
    if (subtotalRow) {
        subtotalRow.classList.toggle('hidden', !(active && shown > 0));
        const label = subtotalRow.querySelector('.ep-filter-subtotal-label');
        const value = subtotalRow.querySelector('.ep-filter-subtotal-value');
        if (label) label.textContent = 'FILTERED TOTAL (' + shown + ' of ' + rows.length + ' items):';
        if (value) value.textContent = formatPesoExact(subtotal);
    }
}


function renderEntries(records) {
    const tbody = document.getElementById('entriesTableBody');
    if (!tbody) return;

    const emptyState = document.getElementById('entriesEmptyState');
    const resultCount = document.getElementById('entriesResultCount');
    populateOfficeFilter(records);
    const filteredRecords = getFilteredEntryRecords(records).sort((a, b) => b.id - a.id);
    const approvedNumbers = getApprovedEntryNumbers(records);

    if (expandedEntryId !== null && !filteredRecords.some(r => r.id == expandedEntryId)) {
        delete previewDrafts[expandedEntryId];
        expandedEntryId = null;
        resetEntryItemFilters();
    }

    if (resultCount) {
        resultCount.textContent =
            `${filteredRecords.length} ${filteredRecords.length === 1 ? 'entry' : 'entries'}` +
            ` · ${filteredRecords.filter(r => r.status === 'Completed').length} approved`;
    }

    if (filteredRecords.length === 0) {
        tbody.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    tbody.innerHTML = filteredRecords.map(record => {
        const status = getPpmpStatus(record);
        const submittedTitle = status === 'For Approval' && record.submitted_by
            ? ` title="Submitted by ${escapeHtml(record.submitted_by.name)}${record.submitted_at ? ' on ' + escapeHtml(formatApprovalDate(record.submitted_at)) : ''}"`
            : '';
        const ppmpType = record.is_indicative === 'Final' ? 'Final' : (record.is_indicative === 'Indicative' ? 'Indicative' : 'N/A');
        const description = getRecordDescriptionSummary(record);
        const budget = formatPeso(getRecordTotalBudget(record));
        const recordId = Number(record.id);
        const entryNumber = approvedNumbers.get(String(record.id));
        
        const isExpanded = (typeof expandedEntryId !== 'undefined') && expandedEntryId === record.id;
        // Check if current user is allowed to request/edit
        const session = typeof getSession === 'function' ? getSession() : null;
        const canReq = !!(session && session.canRequest);

        // isEditable will now be FALSE for TOD, Budget Officer, and RD
        const isEditable = isExpanded && !isPpmpLocked(record) && canReq;
        const isEditing = isEditable && isPreviewEditing(record.id);

        return `
            <tr>
                <td class="db-entry-number"${entryNumber ? '' : ' style="opacity:.4" title="Numbered within its office once approved"'}>${entryNumber || '—'}</td>
                <td class="db-entry-ppmp-cell${isExpanded ? ' is-expanded' : ''}" onclick="toggleEntryPreviewRow(${recordId})" title="${isExpanded ? 'Hide' : 'Show'} Excel preview">
                    <svg class="db-entry-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6L15 12L9 18" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <div><strong>PPMP No. ${escapeHtml(record.ppmp_no || 'N/A')}</strong><span>${escapeHtml(record.fiscal_year || '')}</span></div>
                </td>
                <td class="db-entry-description">${escapeHtml(description)}</td>
                <td>${escapeHtml(record.end_user || 'N/A')}</td>
                <td>${escapeHtml(getRecordProjectTypeSummary(record))}</td>
                <td>${escapeHtml(getRecordCriteriaSummary(record))}</td>
                <td>${escapeHtml(budget)}</td>
                <td>${renderStatusPill(record, submittedTitle)}</td>
                <td>${ppmpType === 'N/A' ? 'N/A' : `<span class="db-status-pill ${ppmpType === 'Final' ? 'is-type-final' : 'is-type-indicative'}">${ppmpType}</span>`}</td>
                <td>${renderApprovedByCell(record)}</td>
            </tr>
            ${isExpanded ? `
            <tr class="db-entry-expand-row">
                <td colspan="10">
                    <div class="db-entry-expand-inner">
                        ${buildPreviewToolbarHtml(Number(record.id), { record: record, canEdit: isEditable })}
                        ${isEditing ? '' : buildItemFilterBarHtml(record)}
                        ${buildExcelPreviewMarkup(record, isEditing, false)}
                    </div>
                </td>
            </tr>
            ` : ''}
        `;
    }).join('');

    applyEntryItemFilters();
    reapplyPreviewErrors();
}

function initEntryFilters() {
    ['entryStatusFilter', 'entryIndicativeFilter', 'entryTypeFilter', 'entryCategoryFilter', 'entryOfficeFilter', 'entrySearchInput'].forEach(id => {
        const control = document.getElementById(id);
        if (!control) return;

        control.addEventListener('input', function () {
            renderEntries(getRecords());
        });

        control.addEventListener('change', function () {
            renderEntries(getRecords());
        });
    });
}


function openEntryRecord(id) {
    if (
        typeof openRequestModal === 'function' &&
        document.getElementById('requestModalOverlay')
    ) {
        openRequestModal(id);
    }
}
// Shared toast notification (used by every page that loads this file)
function showToast(message) {
    let toast = document.getElementById('dbToast');

    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'dbToast';
        toast.className = 'db-toast';
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(function () {
        toast.classList.remove('show');
    }, 3200);
}


// Function to Delete a record (or a single line item within one)
// pendingDelete shape: { type: 'record', id } or { type: 'item', recordId, itemId }
let pendingDelete = null;

// Swaps the confirm modal's heading/message. Falls back to doing nothing
// if a page (e.g. one without the delete feature) doesn't have these ids.
function setConfirmModalText(title, message) {
    const titleEl = document.getElementById('confirmModalTitle');
    const textEl = document.getElementById('confirmModalText');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = message;
}

// 1. Function called when clicking the trash icon on a whole PPMP row
function deleteRecord(id) {
    const target = getRecords().find(r => r.id == id);
    if (!target) return; // not visible to this account, so not theirs to delete
    if (!canDeleteRecord(target)) {
        showToast('An approved PPMP is closed and can only be deleted by an approver.');
        return;
    }

    pendingDelete = { type: 'record', id: id };
    setConfirmModalText(
        'Delete Request?',
        'Are you sure you want to delete this procurement request? This action cannot be undone.'
    );
    const confirmModal = document.getElementById('confirmModalOverlay');
    confirmModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Stop background scrolling
}

// 1b. Function called when clicking "Delete Item" while viewing a single
// line item inside the request modal. Warns up front if this is the only
// item left, since removing it removes the whole PPMP.
function deleteRecordItem(recordId, itemId) {
    if (!recordId || !itemId) return;

    const confirmModal = document.getElementById('confirmModalOverlay');
    if (!confirmModal) return; // page has no delete UI (e.g. Profile)

    const records = getRecords();
    const record = records.find(r => r.id == recordId);
    if (isPpmpLocked(record)) {
        showToast('This PPMP was submitted for approval or approved — its items can no longer be deleted.');
        return;
    }
    const items = record && typeof getRecordItems === 'function' ? getRecordItems(record) : [];
    const isOnlyItem = items.length <= 1;

    pendingDelete = { type: 'item', recordId: recordId, itemId: itemId };

    setConfirmModalText(
        isOnlyItem ? 'Delete Request?' : 'Delete This Item?',
        isOnlyItem
            ? 'This is the only item on this PPMP, so deleting it will delete the entire request. This action cannot be undone.'
            : 'Are you sure you want to delete this line item from the PPMP? This action cannot be undone.'
    );

    confirmModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

// 2. Function to close the popup
function closeConfirmModal() {
    const confirmModal = document.getElementById('confirmModalOverlay');
    confirmModal.classList.add('hidden');
    document.body.style.overflow = '';
    pendingDelete = null;
}

// This gathers the rendering logic so it can be called from the modal
function refreshDashboardRecords() {
    const records = getRecords(); // This uses the filtered logic from our previous step

    if (typeof renderStats === 'function') renderStats(records);
    if (typeof renderActivity === 'function') renderActivity(records);
    
    // Entries page: render the table from the same (role-filtered) records.
    // (Previously called a non-existent renderEntriesTable(), so the table
    // stayed empty until a filter or search box was touched.)
    if (typeof renderEntries === 'function') renderEntries(records);

    // Update the Notification Dot
    const notifDot = document.getElementById('notifDot');
    if (notifDot) {
        // Show dot if there are any requests waiting for the current user's approval
        const pendingCount = records.filter(canSessionActOnRecord).length;
        notifDot.classList.toggle('hidden', pendingCount === 0);
    }
}

// 3. Event Listener for the actual "Delete" button inside the popup
document.addEventListener('DOMContentLoaded', function() {
    const session = getSession();
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    if (confirmBtn) {
        confirmBtn.onclick = function() {
            if (!pendingDelete) return;

            if (pendingDelete.type === 'item') {
                executeItemDeletion(pendingDelete.recordId, pendingDelete.itemId);
            } else if (pendingDelete.type === 'record') {
                executeDeletion(pendingDelete.id);
            }

            closeConfirmModal();
        };
    }
    if (!session || !session.canRequest) {
        const newRequestButtons = document.querySelectorAll('.db-nav-item[onclick*="startNewRequest"], .db-nav-item[onclick*="open_new_request"], .db-nav-item[onclick*="openRequestModal"], .db-cta-btn');
        newRequestButtons.forEach(btn => btn.style.display = 'none');
    }
    
    refreshDashboardRecords();
});

// 4. The actual whole-record deletion logic
function executeDeletion(id) {
    let records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    records = records.filter(r => r.id !== id);
    localStorage.setItem('procurement_records', JSON.stringify(records));
    
    // Update the Dashboard UI
    refreshDashboardRecords();
    
    // Show the Toast notification (if you have the function)
    if (typeof showToast === 'function') {
        showToast("Request deleted successfully.");
    }
}

// 4b. Deletes a single line item from a PPMP record. If it was the last
// remaining item, the whole record is removed instead (a PPMP with zero
// items has nothing left to show).
function executeItemDeletion(recordId, itemId) {
    let records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = records.findIndex(r => r.id == recordId);
    if (idx === -1) return;

    const remainingItems = getRecordItems(records[idx]).filter(it => it.id != itemId);
    const wholeRecordRemoved = remainingItems.length === 0;

    if (wholeRecordRemoved) {
        records.splice(idx, 1);
    } else {
        records[idx] = Object.assign({}, records[idx], { items: remainingItems });
    }

    localStorage.setItem('procurement_records', JSON.stringify(records));

    refreshDashboardRecords();

    // If the request modal is currently open on this same record, keep it
    // in sync: jump to a neighboring item, or close it if nothing is left.
    if (typeof currentEditingId !== 'undefined' && currentEditingId == recordId) {
        if (wholeRecordRemoved) {
            if (typeof closeRequestModal === 'function') closeRequestModal();
        } else if (typeof loadRecordIntoModal === 'function') {
            const nextIndex = Math.min(
                typeof currentItemIndex === 'number' ? currentItemIndex : 0,
                remainingItems.length - 1
            );
            loadRecordIntoModal(recordId, nextIndex);
        }
    }

    if (typeof showToast === 'function') {
        showToast(wholeRecordRemoved ? 'Request deleted successfully.' : 'Item deleted successfully.');
    }
}


function initThemeToggle() {

    const root = document.documentElement;
    const toggleBtn = document.getElementById('themeToggle');
    const moonIcon = document.getElementById('themeIconMoon');
    const sunIcon = document.getElementById('themeIconSun');

    if (!toggleBtn) return;

    function applyTheme(theme) {

        root.setAttribute('data-theme', theme);

        if (moonIcon && sunIcon) {
            moonIcon.style.display = theme === 'dark' ? '' : 'none';
            sunIcon.style.display = theme === 'light' ? '' : 'none';
        }
    }

    const savedTheme = localStorage.getItem('dashboard_theme') || 'dark';
    applyTheme(savedTheme);

    toggleBtn.addEventListener('click', function () {

        const nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';

        applyTheme(nextTheme);
        localStorage.setItem('dashboard_theme', nextTheme);
    });
}

document.addEventListener('DOMContentLoaded', function () {

    initThemeToggle();
    initEntryFilters();
    refreshDashboardRecords();

    const openRecordId = sessionStorage.getItem('open_record_id');
    const shouldOpenNewRequest = sessionStorage.getItem('open_new_request') === '1';
    const addEntryPpmp = sessionStorage.getItem('add_entry_ppmp');

    if (openRecordId && typeof openRequestModal === 'function') {
        sessionStorage.removeItem('open_record_id');
        setTimeout(function () {
            openRequestModal(openRecordId);
        }, 0);
    } else if (addEntryPpmp && typeof addEntryToPpmp === 'function') {
        sessionStorage.removeItem('add_entry_ppmp');
        setTimeout(function () {
            addEntryToPpmp(addEntryPpmp);
        }, 0);
    } else if (shouldOpenNewRequest && typeof startNewRequest === 'function') {
        sessionStorage.removeItem('open_new_request');
        setTimeout(function () {
            startNewRequest();
        }, 0);
    } else if (shouldOpenNewRequest && typeof openRequestModal === 'function') {
        sessionStorage.removeItem('open_new_request');
        setTimeout(function () {
            openRequestModal();
        }, 0);
    }
});


document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
        closeExcelPreview();
    }
});


document.addEventListener('click', function (event) {
    if (event.target && event.target.id === 'excelPreviewOverlay') {
        closeExcelPreview();
    }
});

// Leaving the page with unsaved inline edits (or an attachment still being
// read) triggers the browser's own "Leave site?" warning.
window.addEventListener('beforeunload', function (e) {
    const hasUnsaved = Object.keys(previewDrafts).some(function (id) {
        return isPreviewDirty(Number(id)) || previewDrafts[id].pending > 0;
    });
    if (hasUnsaved) {
        e.preventDefault();
        e.returnValue = '';
    }
});