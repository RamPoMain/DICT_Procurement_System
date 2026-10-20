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


// ============================================================
// DASHBOARD STATS CALCULATION
// - Suppliers: Counts APP versions (Total, Pending, Completed, APP Budget)
// - Others: Counts PPMP requests
// ============================================================

// Helper to collect all APP records relevant to the current system
function getSupplierAppList(records) {
    const appRecords = typeof getAllAppRecords === 'function' ? getAllAppRecords() : [];
    
    // Also include any fiscal year from approved PPMPs that hasn't been saved yet
    const yearsFromPpmp = [...new Set(
        (records || [])
            .filter(r => r && r.status === 'Completed' && /^\d{4}$/.test(String(r.fiscal_year).trim()))
            .map(r => String(r.fiscal_year).trim())
    )];

    const appsMap = new Map();
    appRecords.forEach(app => appsMap.set(String(app.fiscal_year), app));
    yearsFromPpmp.forEach(year => {
        if (!appsMap.has(year) && typeof getAppRecord === 'function') {
            appsMap.set(year, getAppRecord(year));
        }
    });

    return Array.from(appsMap.values());
}

// Helper to calculate total budget of an APP for a fiscal year
function getAppTotalBudgetForYear(fiscalYear, records) {
    const relevant = typeof getLatestApprovedPpmpPerOffice === 'function'
        ? getLatestApprovedPpmpPerOffice(records, fiscalYear)
        : (records || []).filter(r => String(r.fiscal_year) === String(fiscalYear));
    
    return relevant.reduce((sum, r) => sum + getRecordTotalBudget(r), 0);
}

// Safely updates ONLY the top small uppercase label (.db-stat-label),
// NEVER touching the big number values (#stat-total, #stat-pending, etc.)
function updateSupplierStatCardLabels(isSupplier) {
    const totalCard = document.getElementById('stat-total')?.closest('.db-stat-card, .stat-card');
    if (totalCard) {
        const label = totalCard.querySelector('.db-stat-label');
        if (label) {
            if (!label.dataset.defaultLabel) label.dataset.defaultLabel = label.textContent.trim();
            label.textContent = isSupplier ? 'TOTAL APP VERSIONS' : label.dataset.defaultLabel;
        }
    }

    const budgetCard = document.getElementById('stat-budget')?.closest('.db-stat-card, .stat-card');
    if (budgetCard) {
        const label = budgetCard.querySelector('.db-stat-label');
        if (label) {
            if (!label.dataset.defaultLabel) label.dataset.defaultLabel = label.textContent.trim();
            label.textContent = isSupplier ? 'TOTAL APP BUDGET' : label.dataset.defaultLabel;
        }
    }
}

function renderStats(records) {
    const totalEl = document.getElementById('stat-total');
    if (!totalEl) return;

    const session = typeof getSession === 'function' ? getSession() : null;

    // --------------------------------------------------------
    // SUPPLIERS: COUNT APP VERSIONS AS NUMBERS
    // --------------------------------------------------------
    if (session && session.role === 'SUP') {
        const apps = getSupplierAppList(records);
        const totalApps = apps.length;
        const completedApps = apps.filter(a => a.status === 'Completed').length;
        const pendingApps = apps.filter(a => a.status !== 'Completed').length;

        // Populate big number values
        totalEl.innerText = totalApps;

        const pendingEl = document.getElementById('stat-pending');
        if (pendingEl) pendingEl.innerText = pendingApps;

        const completedEl = document.getElementById('stat-completed');
        if (completedEl) completedEl.innerText = completedApps;

        const totalAppBudget = apps.reduce((sum, app) => sum + getAppTotalBudgetForYear(app.fiscal_year, records), 0);
        const budgetEl = document.getElementById('stat-budget');
        if (budgetEl) budgetEl.innerText = formatPeso(totalAppBudget);

        updateSupplierStatCardLabels(true);
        return;
    }

    // --------------------------------------------------------
    // OTHER ROLES: COUNT PPMPS
    // --------------------------------------------------------
    updateSupplierStatCardLabels(false);

    totalEl.innerText = records.length;

    const pendingEl = document.getElementById('stat-pending');
    if (pendingEl) {
        pendingEl.innerText = records.filter(r => getPpmpStatus(r) !== 'Completed').length;
    }

    const completedEl = document.getElementById('stat-completed');
    if (completedEl) {
        completedEl.innerText = records.filter(r => r.status === 'Completed').length;
    }

    const totalBudget = records.reduce(
        (sum, record) => sum + getRecordTotalBudget(record),
        0
    );

    const budgetEl = document.getElementById('stat-budget');
    if (budgetEl) budgetEl.innerText = formatPeso(totalBudget);
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
    'Lowest Comparative or Competitive Responsive Bid (LCCRB)',
    'N/A'
];

const PREVIEW_STRATEGY_OPTIONS = [
    'Life Cycle Assessment (LCA) and LCCA', 'Subcontracting', 'Multi-Year Contracting',
    'Design-and-Build Scheme for Infrastructure', 'Engagement of a Procurement Agent',
    'Use of Framework Agreement Section', 'Pooled Procurement Section 17',
    'Renewal of Regular and Recurring Services', 'Warehousing and Inventory Activities',
    'N/A'
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

// Resolves to { doc, blob } or null (after telling the user why). The file
// bytes live in IndexedDB (FileStore); older records may still hold a dataUrl.
function resolvePreviewDoc(btn) {
    const doc = findPreviewDoc(
        Number(btn.dataset.recordId), btn.dataset.itemId, Number(btn.dataset.docIndex)
    );
    if (!doc || !(doc.fileId || doc.dataUrl)) {
        showToast('This file could not be opened - its contents were not saved. Re-attach it by editing the item.');
        return Promise.resolve(null);
    }
    return FileStore.docBlob(doc).then(function (blob) {
        if (!blob) {
            showToast('This file could not be read. Re-attach it by editing the item.');
            return null;
        }
        return { doc: doc, blob: blob };
    }).catch(function () {
        showToast('This file could not be read. Re-attach it by editing the item.');
        return null;
    });
}

function openPreviewDoc(btn, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    // Open the tab right away (inside the click) so pop-up blockers allow it,
    // then point it at the file once it has been read from storage.
    const win = window.open('', '_blank');
    resolvePreviewDoc(btn).then(function (found) {
        if (!found) { if (win) win.close(); return; }
        const url = URL.createObjectURL(found.blob);
        if (win) {
            win.location.href = url;
        } else {
            // Pop-up blocked: fall back to downloading so the click still does something.
            downloadBlobAs(url, found.doc.name || 'document');
            showToast('Your browser blocked the new tab, so the file was downloaded instead.');
        }
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
}

function downloadPreviewDoc(btn, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    resolvePreviewDoc(btn).then(function (found) {
        if (!found) return;
        const url = URL.createObjectURL(found.blob);
        downloadBlobAs(url, found.doc.name || 'document');
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
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
        if (!doc || !(doc.fileId || doc.dataUrl)) {
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
    // Criteria for Bid Evaluation (col 6) and Procurement Strategies (col 12)
    // are only shown while the PPMP is still a Draft. Once it is submitted for
    // approval they are hidden here and only appear in the APP. The cells stay
    // in the markup (class ep-cs-col) so the column-position CSS keeps working.
    const showCS = isPpmpDraft(record);
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
            <tr class="ep-item-row" ${itemFilterAttrs(item, showCS)}>
                <td>${escapeHtml(item.project_description || '')}</td>
                <td>${escapeHtml(item.project_type || '')}</td>
                <td>${escapeHtml(item.quantity_size || '')}</td>
                <td>${escapeHtml(item.mode || '')}</td>
                <td>${escapeHtml(item.pre_procurement || '')}</td>
                <td class="ep-cs-col">${showCS ? escapeHtml(item.bid_evaluation_criteria || 'N/A') : ''}</td>
                <td>${escapeHtml(item.start_date || '')}</td>
                <td>${escapeHtml(item.end_date || '')}</td>
                <td>${escapeHtml(item.delivery_period || '')}</td>
                <td>${escapeHtml(item.fund_source || '')}</td>
                <td>${escapeHtml(formatPesoExact(parseBudgetNumber(item.budget)))}</td>
                <td class="ep-cs-col">${showCS ? itemStrategies : ''}</td>
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
                <table class="excel-preview-table${showCS ? '' : ' ep-hide-cs'}">
                    <thead>
                        <tr>
                            <th colspan="${showCS ? 6 : 5}">PROCUREMENT PROJECT DETAILS</th>
                            <th colspan="3">PROJECTED TIMELINE (MM/YYYY)</th>
                            <th colspan="2">FUNDING DETAILS</th>
                            <th rowspan="2" class="ep-cs-col">PROCUREMENT STRATEGIES AND TOOLS</th>
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
                            <th class="ep-cs-col">Criteria for Bid Evaluation</th>
                            <th>Start of Procurement Activity</th>
                            <th>End of Procurement Activity</th>
                            <th>Expected Delivery/ Implementation Period</th>
                            <th>Source of Funds</th>
                            <th>Estimated Budget / Authorized Budgetary Allocation (PhP)</th>
                        </tr>
                        <tr>
                            ${(() => {
                                // Number only the visible columns so hiding two leaves no gap.
                                let shown = 0;
                                return Array.from({ length: 15 }, (_, i) => {
                                    const isCS = (i + 1 === 6 || i + 1 === 12);
                                    if (isCS && !showCS) return '<th class="ep-cs-col"></th>';
                                    shown += 1;
                                    return '<th>Column ' + shown + '</th>';
                                }).join('');
                            })()}
                            ${editable ? '<th></th>' : ''}
                        </tr>
                    </thead>
                    <tbody>
                        ${itemRows}
                        ${editable ? '' : `<tr class="ep-filter-empty hidden"><td colspan="${showCS ? 15 : 13}">No items match the current filters.</td></tr>`}
                        <tr>
                            <td colspan="${showCS ? 10 : 9}" class="excel-total-label">TOTAL BUDGET:</td>
                            <td class="excel-total-value">${escapeHtml(formattedTotal)}</td>
                            <td class="ep-cs-col"></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            ${editable ? '<td></td>' : ''}
                        </tr>
                        ${editable ? '' : `<tr class="ep-filter-subtotal hidden">
                            <td colspan="${showCS ? 10 : 9}" class="excel-total-label ep-filter-subtotal-label"></td>
                            <td class="excel-total-value ep-filter-subtotal-value"></td>
                            <td class="ep-cs-col"></td>
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
// ANNUAL PROCUREMENT PLAN (APP) APPROVAL WORKFLOW
// Chain: Supply Account (Submit) -> ARD (Approve) -> RD (Approve) -> Final APP
// ============================================================


// Checks if the signed-in account is part of the APP preparation & approval chain
function isAppAuthorizedUser(session) {
    const s = session || (typeof getSession === 'function' ? getSession() : null);
    return !!(s && ['SUP', 'ARD', 'RD'].includes(s.role));
}

const APP_RECORDS_KEY = 'app_records';

function getAllAppRecords() {
    try {
        const records = JSON.parse(localStorage.getItem(APP_RECORDS_KEY));
        return Array.isArray(records) ? records : [];
    } catch (e) {
        return [];
    }
}

function getAppRecord(fiscalYear) {
    const all = getAllAppRecords();
    const strYear = String(fiscalYear || new Date().getFullYear());
    let record = all.find(r => String(r.fiscal_year) === strYear);

    if (!record) {
        record = {
            id: 'app_' + strYear,
            fiscal_year: strYear,
            status: 'Draft',
            currentApproverRole: null, // 'ARD' -> 'RD' -> 'None'
            submitted_by: null,
            submitted_at: null,
            ard_approved_by: null,
            ard_approved_at: null,
            approved_by: null,
            approved_at: null,
            returned_for_revision: false,
            rejected_by: null,
            rejected_at: null,
            remarksHistory: []
        };
    }
    return record;
}

function saveAppRecord(record) {
    const all = getAllAppRecords();
    const idx = all.findIndex(r => String(r.fiscal_year) === String(record.fiscal_year));
    if (idx !== -1) {
        all[idx] = record;
    } else {
        all.push(record);
    }
    try {
        localStorage.setItem(APP_RECORDS_KEY, JSON.stringify(all));
    } catch (e) {
        console.error('Could not save APP record:', e);
    }
}

// ------------------------------------------------------------
// WHICH PPMPs GO INTO THE APP
// The APP of a fiscal year uses only the LATEST fully approved (Completed)
// PPMP of each office: when an office has more than one approved PPMP for
// that year (No. 1, No. 2, ...), the newer one replaces the older ones, so
// the same office is never counted twice.
// "Latest" = most recently approved (approved_at; records saved before that
// field existed fall back to their creation time), then the higher PPMP No.
// ------------------------------------------------------------

function ppmpApprovalOrder(record) {
    return Number(record.approved_at) || Number(record.id) || 0;
}

function isApprovedLaterThan(a, b) {
    const diff = ppmpApprovalOrder(a) - ppmpApprovalOrder(b);
    if (diff !== 0) return diff > 0;
    return (parseInt(a.ppmp_no, 10) || 0) > (parseInt(b.ppmp_no, 10) || 0);
}

// Returns one PPMP record per office (the latest approved one) for the fiscal
// year. Pass null/undefined as the year to ignore the year.
function getLatestApprovedPpmpPerOffice(records, fiscalYear) {
    const latestByOffice = new Map();
    const targetYearStr = fiscalYear != null ? String(fiscalYear).trim() : null;

    (records || []).forEach(record => {
        if (!record || record.status !== 'Completed') return;
        
        // Strictly filter to the requested fiscal year
        if (targetYearStr && String(record.fiscal_year).trim() !== targetYearStr) return;

        const office = record.end_user || 'N/A';
        const current = latestByOffice.get(office);
        if (!current || isApprovedLaterThan(record, current)) {
            latestByOffice.set(office, record);
        }
    });

    return Array.from(latestByOffice.values());
}

// ------------------------------------------------------------
// FISCAL YEAR ROLLOVER
// Once the APP of the CURRENT fiscal year is Final, that year's planning is
// closed, so the next PPMP defaults to the following year (and keeps rolling
// forward if that year's APP is final too). Nothing is stored: it is worked
// out from the APP records each time, so it takes effect the moment the RD
// marks the APP Final.
// ------------------------------------------------------------

function isAppFinal(fiscalYear) {
    return getAppRecord(fiscalYear).status === 'Completed';
}

// Year a NEW PPMP should be pre-filled with, or null when the current
// year's APP is not Final yet (the user then types the year, as before).
function getDefaultNewPpmpFiscalYear() {
    let year = new Date().getFullYear();
    if (!isAppFinal(year)) return null;

    while (year < 2100 && isAppFinal(year)) year++;
    return String(year);
}

// First fiscal year after `afterYear` whose APP is not Final yet.
function getNextOpenFiscalYear(afterYear) {
    let year = (parseInt(afterYear, 10) || new Date().getFullYear()) + 1;
    while (year < 2100 && isAppFinal(year)) year++;
    return String(year);
}

// Fiscal year the Generate/Preview APP button works on: the earliest year
// that has approved PPMPs and whose APP is not Final yet. Once every such
// year is Final it stays on the latest one. (It used to take the year of the
// oldest approved PPMP, which would stay on a Final APP forever after the
// rollover above starts producing PPMPs for the next year.)
function getDefaultAppFiscalYear(records) {
    const years = [...new Set(
        (records || [])
            .filter(r => r && r.status === 'Completed' && /^\d{4}$/.test(String(r.fiscal_year).trim()))
            .map(r => String(r.fiscal_year).trim())
    )].sort();

    if (years.length === 0) return new Date().getFullYear();
    return years.find(y => !isAppFinal(y)) || years[years.length - 1];
}

function isAppPendingForUser(session) {
    if (!session) return false;
    const all = getAllAppRecords();
    return all.some(r => r.status === 'For Approval' && r.currentApproverRole === session.role);
}

// ------------------------------------------------------------
// APP PREVIEW MODAL WITH APPROVAL CONTROLS
// ------------------------------------------------------------

let appPreviewEl = null;
let appPreviewUrl = null;
let appPreviewYear = null;
let appGenerating = false;

function buildAppPreviewModal() {
    const overlay = document.createElement('div');
    overlay.className = 'app-preview-overlay';
    overlay.id = 'appPreviewOverlay';
    overlay.innerHTML = `
        <div class="app-preview-modal" role="dialog" aria-modal="true" aria-labelledby="appPreviewTitle">
            <div class="app-preview-head">
                <div>
                    <h3 id="appPreviewTitle">Annual Procurement Plan Preview</h3>
                    <div id="appModalStatusWrap" style="margin-top: 4px;"></div>
                </div>
                <button type="button" class="app-preview-x" data-app-preview-close aria-label="Close preview">&times;</button>
            </div>
            <div id="appRejectionBanner" style="display: none; padding: 10px 16px; background-color: #fef2f2; border-bottom: 1px solid #fee2e2; color: #991b1b; font-size: 12.5px;"></div>
            <div class="app-preview-body">
                <iframe id="appPreviewFrame" class="app-preview-frame" title="Annual Procurement Plan preview"></iframe>
            </div>
            <div class="app-preview-actions">
                <button type="button" class="app-preview-btn is-secondary" data-app-preview-close>Close</button>
                <button type="button" class="app-preview-btn is-secondary" data-app-preview-open>Open in new tab</button>
                <span class="app-preview-spacer"></span>
                <div id="appWorkflowActions"></div>
            </div>
        </div>
    `;

    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeAppPreviewModal();
    });
    overlay.querySelectorAll('[data-app-preview-close]').forEach(b => b.addEventListener('click', closeAppPreviewModal));
    overlay.querySelector('[data-app-preview-open]').addEventListener('click', function () {
        if (appPreviewUrl) window.open(appPreviewUrl, '_blank', 'noopener');
    });

    document.body.appendChild(overlay);
    return overlay;
}

function openAppPreviewModal(result) {
    if (!appPreviewEl) appPreviewEl = buildAppPreviewModal();

    // Revoke old blob URL to prevent memory leaks and cache collision
    if (appPreviewUrl) {
        URL.revokeObjectURL(appPreviewUrl);
        appPreviewUrl = null;
    }

    appPreviewUrl = URL.createObjectURL(result.blob);
    appPreviewYear = result.fiscalYear;

    const record = getAppRecord(result.fiscalYear);
    const session = typeof getSession === 'function' ? getSession() : null;

    appPreviewEl.querySelector('#appPreviewTitle').textContent = `Annual Procurement Plan (APP) — FY ${result.fiscalYear}`;

    // Force iframe PDF viewer to completely reload the canvas for the new year
    const frame = appPreviewEl.querySelector('#appPreviewFrame');
    if (frame) {
        frame.src = 'about:blank';
        setTimeout(function () {
            frame.src = appPreviewUrl + '#view=FitH';
        }, 30);
    }

    renderAppWorkflowUi(record, session);

    appPreviewEl.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeAppPreviewModal() {
    if (!appPreviewEl) return;
    appPreviewEl.classList.remove('show');
    document.body.style.overflow = '';

    appPreviewEl.querySelector('#appPreviewFrame').src = 'about:blank';
    if (appPreviewUrl) {
        URL.revokeObjectURL(appPreviewUrl);
        appPreviewUrl = null;
    }
}

// Renders the approval status pill, rejection remarks banner, and action buttons
function renderAppWorkflowUi(record, session) {
    const statusWrap = document.getElementById('appModalStatusWrap');
    const banner = document.getElementById('appRejectionBanner');
    const actionsWrap = document.getElementById('appWorkflowActions');
    if (!statusWrap || !actionsWrap || !banner) return;

    let statusPill = '';
    if (record.status === 'Completed') {
        statusPill = '<span class="db-status-pill is-completed">Final (Fully Approved)</span>';
    } else if (record.status === 'For Approval') {
        const waitingFor = record.currentApproverRole === 'ARD' ? 'Assistant Regional Director' : 'Regional Director';
        statusPill = `<span class="db-status-pill is-pending">For Approval · With ${waitingFor}</span>`;
    } else if (record.returned_for_revision) {
        statusPill = '<span class="db-status-pill is-returned">Returned for Revision</span>';
    } else {
        statusPill = '<span class="db-status-pill is-draft">Draft (Indicative)</span>';
    }
    statusWrap.innerHTML = statusPill;

    // Show rejection banner if returned
    if (record.returned_for_revision && record.rejected_by) {
        const lastReject = (record.remarksHistory || []).slice().reverse().find(h => h.action === 'rejected');
        banner.style.display = 'block';
        banner.innerHTML = `
            <strong>Returned for revision by ${escapeHtml(record.rejected_by.name)}:</strong>
            <span>${escapeHtml(lastReject ? lastReject.remarks : 'Please revise.')}</span>
        `;
    } else {
        banner.style.display = 'none';
    }

    // Context-sensitive workflow buttons
    let buttonsHtml = '';
    const isSupplier = session && session.role === 'SUP';
    const isArd = session && session.role === 'ARD';
    const isRd = session && session.role === 'RD';

    if (isSupplier && (record.status === 'Draft' || record.returned_for_revision)) {
        buttonsHtml = `<button type="button" class="app-preview-btn" onclick="submitAppForApproval('${record.fiscal_year}')" style="background-color: #2563eb; color: #fff;">Submit APP for Approval</button>`;
    } else if (isArd && record.status === 'For Approval' && record.currentApproverRole === 'ARD') {
        buttonsHtml = `<button type="button" class="app-preview-btn" onclick="openAppReviewDialog('${record.fiscal_year}')" style="background-color: #2563eb; color: #fff;">Review & Decide →</button>`;
    } else if (isRd && record.status === 'For Approval' && record.currentApproverRole === 'RD') {
        buttonsHtml = `<button type="button" class="app-preview-btn" onclick="openAppReviewDialog('${record.fiscal_year}')" style="background-color: #2563eb; color: #fff;">Review & Final Approve →</button>`;
    } else if (record.status === 'Completed') {
        buttonsHtml = `<button type="button" class="app-preview-btn" onclick="generateAPP_PDF('${record.fiscal_year}')" style="background-color: #10b981; color: #fff;">Download Final APP (PDF)</button>`;
    }

    actionsWrap.innerHTML = buttonsHtml;
}

// ------------------------------------------------------------
// WORKFLOW ACTIONS: SUBMIT, REVIEW, APPROVE, REJECT
// ------------------------------------------------------------

function submitAppForApproval(fiscalYear) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || session.role !== 'SUP') {
        showToast('Only the Supply Account can submit the APP for approval.');
        return;
    }

    if (!confirm(`Submit the Annual Procurement Plan for FY ${fiscalYear} to the Assistant Regional Director (ARD) for review?`)) return;

    const record = getAppRecord(fiscalYear);
    record.status = 'For Approval';
    record.currentApproverRole = 'ARD';
    record.returned_for_revision = false;
    record.submitted_by = { name: session.roleName, role: session.role, email: session.email };
    record.submitted_at = Date.now();

    if (!Array.isArray(record.remarksHistory)) record.remarksHistory = [];
    record.remarksHistory.push({
        stage: 'SUP',
        role: session.role,
        name: session.roleName,
        action: 'submitted',
        remarks: 'Submitted by Supply Account for ARD endorsement.',
        date: new Date().toLocaleDateString(),
        at: Date.now()
    });
    
    saveAppRecord(record);
    if (typeof refreshDashboardRecords === 'function') {
        refreshDashboardRecords();
    }

    saveAppRecord(record);
    showToast(`APP for FY ${fiscalYear} submitted to the ARD for review.`);
    runPreviewApp();
    renderAppExportButton();
}

let appReviewDialogEl = null;

function buildAppReviewDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'logout-overlay';
    overlay.id = 'appReviewOverlay';
    overlay.innerHTML = `
        <div class="logout-modal review-modal" role="alertdialog" aria-modal="true" aria-labelledby="appReviewTitle">
            <div class="logout-icon is-approve">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <h3 id="appReviewTitle">Review Annual Procurement Plan</h3>
            <p id="appReviewDesc"></p>
            <div class="review-field" id="appReviewRemarksField">
                <label for="appReviewRemarks">Remarks</label>
                <textarea id="appReviewRemarks" maxlength="1000" placeholder="Enter review notes, corrections, or approval remarks..."></textarea>
                <p class="review-error">Remarks are required to reject or add remarks.</p>
            </div>
            <div class="review-actions">
                <button type="button" class="logout-cancel-btn" data-app-review-cancel>Cancel</button>
                <button type="button" class="logout-cancel-btn" data-app-review-comment>Add remark only</button>
                <button type="button" class="logout-confirm-btn is-reject" data-app-review-reject>Reject</button>
                <button type="button" class="logout-confirm-btn is-approve" data-app-review-approve>Approve</button>
            </div>
        </div>
    `;

    overlay.querySelector('[data-app-review-cancel]').addEventListener('click', closeAppReviewDialog);
    document.body.appendChild(overlay);
    return overlay;
}

function openAppReviewDialog(fiscalYear) {
    if (!appReviewDialogEl) appReviewDialogEl = buildAppReviewDialog();

    const record = getAppRecord(fiscalYear);
    const session = typeof getSession === 'function' ? getSession() : null;
    const isArd = session && session.role === 'ARD';

    document.getElementById('appReviewTitle').textContent = `Review APP FY ${fiscalYear}`;
    document.getElementById('appReviewDesc').textContent = isArd
        ? 'Approve to endorse this APP and forward it to the Regional Director (RD). Reject returns it to the Supply Account for revision.'
        : 'Approve will grant final approval, finalizing the APP for official release. Reject returns it to the Supply Account for revision.';

    const box = document.getElementById('appReviewRemarks');
    box.value = '';
    document.getElementById('appReviewRemarksField').classList.remove('has-error');

    appReviewDialogEl.querySelector('[data-app-review-comment]').onclick = () => performAppReviewAction(fiscalYear, 'comment');
    appReviewDialogEl.querySelector('[data-app-review-reject]').onclick = () => performAppReviewAction(fiscalYear, 'reject');
    appReviewDialogEl.querySelector('[data-app-review-approve]').onclick = () => performAppReviewAction(fiscalYear, 'approve');

    appReviewDialogEl.classList.add('show');
    box.focus();
}

function closeAppReviewDialog() {
    if (appReviewDialogEl) appReviewDialogEl.classList.remove('show');
}

function performAppReviewAction(fiscalYear, action) {
    const box = document.getElementById('appReviewRemarks');
    const field = document.getElementById('appReviewRemarksField');
    const remarks = box ? box.value.trim() : '';

    if (action !== 'approve' && !remarks) {
        if (field) field.classList.add('has-error');
        if (box) box.focus();
        return;
    }

    closeAppReviewDialog();

    const session = typeof getSession === 'function' ? getSession() : null;
    const record = getAppRecord(fiscalYear);
    const isArd = session && session.role === 'ARD';
    let message = '';

    if (!Array.isArray(record.remarksHistory)) record.remarksHistory = [];
    record.remarksHistory.push({
        stage: session.role,
        role: session.role,
        name: session.roleName,
        action: action,
        remarks: remarks || 'Approved.',
        date: new Date().toLocaleDateString(),
        at: Date.now()
    });

    if (action === 'comment') {
        message = `Remark added to APP FY ${fiscalYear}.`;
    } else if (action === 'reject') {
        record.status = 'Draft';
        record.currentApproverRole = null;
        record.returned_for_revision = true;
        record.rejected_at = Date.now();
        record.rejected_by = { name: session.roleName, role: session.role, email: session.email };
        message = `APP FY ${fiscalYear} rejected and returned to the Supply Account.`;
    } else {
        // Approve
        if (isArd) {
            record.currentApproverRole = 'RD';
            record.ard_approved_by = { name: session.roleName, role: session.role, email: session.email };
            record.ard_approved_at = Date.now();
            message = `APP FY ${fiscalYear} endorsed by ARD and forwarded to Regional Director (RD).`;
        } else {
            record.status = 'Completed';
            record.currentApproverRole = 'None';
            record.returned_for_revision = false;
            record.approved_by = { name: session.roleName, role: session.role, email: session.email };
            record.approved_at = Date.now();
            message = `APP FY ${fiscalYear} fully approved and marked Final by Regional Director.`;
        }
    }

    saveAppRecord(record);
    if (typeof refreshDashboardRecords === 'function') {
        refreshDashboardRecords();
    }

    // A Final APP closes the year: say what new PPMPs will start with now.
    if (record.status === 'Completed') {
        const nextYear = getDefaultNewPpmpFiscalYear();
        if (nextYear) message += ` New PPMPs will now start in FY ${nextYear}.`;
    }

    showToast(message);
    runPreviewApp();
    renderAppExportButton();
}

// ------------------------------------------------------------
// ENTRY POINT & BUTTON VISIBILITY
// ------------------------------------------------------------

// Accepts targetYear so it generates the preview for the exact requested year
async function runPreviewApp(targetYear = null) {
    if (appGenerating) return;

    const session = typeof getSession === 'function' ? getSession() : null;
    if (!isAppAuthorizedUser(session)) {
        showToast('Access denied: You do not have permission to view the Annual Procurement Plan.');
        return;
    }

    if (typeof previewAPP_PDF !== 'function') {
        showToast('The PDF generator is not available on this page.');
        return;
    }

    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const yearToPreview = targetYear 
        ? String(targetYear).trim() 
        : (typeof getDefaultAppFiscalYear === 'function' ? String(getDefaultAppFiscalYear(records)).trim() : null);

    appGenerating = true;
    try {
        const result = await previewAPP_PDF(yearToPreview);
        if (result) openAppPreviewModal(result);
    } catch (err) {
        console.error('APP preview failed:', err);
        showToast('The APP preview could not be prepared.');
    } finally {
        appGenerating = false;
    }
}

function getLatestApprovedPpmpPerOffice(records, fiscalYear) {
    const latestByOffice = new Map();
    const targetYearStr = fiscalYear != null ? String(fiscalYear).trim() : null;

    (records || []).forEach(record => {
        if (!record || record.status !== 'Completed') return;
        
        // Strictly filter to the requested fiscal year
        if (targetYearStr && String(record.fiscal_year).trim() !== targetYearStr) return;

        const office = record.end_user || 'N/A';
        const current = latestByOffice.get(office);
        if (!current || isApprovedLaterThan(record, current)) {
            latestByOffice.set(office, record);
        }
    });

    return Array.from(latestByOffice.values());
}

async function runGenerateApp(targetYear = null) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!isAppAuthorizedUser(session)) {
        showToast('Access denied: You do not have permission to generate the Annual Procurement Plan.');
        return;
    }

    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const year = targetYear 
        ? String(targetYear).trim() 
        : (typeof getDefaultAppFiscalYear === 'function' ? String(getDefaultAppFiscalYear(records)).trim() : String(new Date().getFullYear()));
    
    const appRec = getAppRecord(year);

    if (appRec.status !== 'Completed') {
        runPreviewApp(year);
        return;
    }

    if (typeof generateAPP_PDF === 'function') {
        generateAPP_PDF(year);
    }
}

// Shows the APP button for SUP, ARD, and RD
// Shows a single unified APP button for SUP, ARD, and RD matching general button styling
function renderAppExportButton() {
    const session = typeof getSession === 'function' ? getSession() : null;
    const authorized = session && ['SUP', 'ARD', 'RD'].includes(session.role);

    // Find all APP buttons that might exist in the page
    const buttons = Array.from(document.querySelectorAll('#exportAppPdfBtn, .export-app-btn, [data-app-entry-btn], [data-app-preview-btn]'));

    if (!authorized || buttons.length === 0) {
        buttons.forEach(btn => btn.style.display = 'none');
        return;
    }

    // Hide any duplicates and keep ONLY the first button
    buttons.forEach((btn, idx) => {
        if (idx > 0) {
            btn.style.display = 'none';
        }
    });

    const primaryBtn = buttons[0];
    primaryBtn.style.display = 'inline-flex';

    // Remove foreign inline styles so native CSS classes take effect
    primaryBtn.style.backgroundColor = '';
    primaryBtn.style.color = '';
    primaryBtn.style.border = '';

    // Ensure it uses the app's native button classes
    if (!primaryBtn.classList.contains('db-btn')) {
        primaryBtn.className = 'db-btn is-primary export-app-btn';
    }

    // Get current APP status for the label
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const year = getDefaultAppFiscalYear(records);
    const appRec = getAppRecord(year);

    let labelText = `Annual Procurement Plan (APP)`;
    let isActionNeeded = false;

    if (session.role === 'ARD' && appRec.status === 'For Approval' && appRec.currentApproverRole === 'ARD') {
        labelText = `Review APP FY ${year} (Action Needed)`;
        isActionNeeded = true;
    } else if (session.role === 'RD' && appRec.status === 'For Approval' && appRec.currentApproverRole === 'RD') {
        labelText = `Review APP FY ${year} (Final Action)`;
        isActionNeeded = true;
    } else if (appRec.status === 'Completed') {
        labelText = `Final APP FY ${year} (Approved)`;
    } else if (appRec.status === 'For Approval') {
        labelText = `APP FY ${year} (In Review)`;
    } else if (appRec.returned_for_revision) {
        labelText = `APP FY ${year} (Returned)`;
    }

    // Render clean layout: Icon + Label (without destroying the SVG icon)
    primaryBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <span class="db-app-label">${labelText}</span>
    `;

    primaryBtn.onclick = function (e) {
        e.preventDefault();
        runPreviewApp();
    };

    // Update notification dot on the bell icon for pending ARD / RD actions
    const notifDot = document.getElementById('notifDot');
    if (notifDot && session) {
        const hasPendingPpmp = (typeof getRecords === 'function') ? getRecords().some(canSessionActOnRecord) : false;
        const hasPendingApp = isAppPendingForUser(session);
        notifDot.classList.toggle('hidden', !hasPendingPpmp && !hasPendingApp);
    }
}

document.addEventListener('DOMContentLoaded', function () {
    renderAppExportButton();
});

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

    let current = new Set(Array.isArray(item.strategies) ? item.strategies : []);
    const val = checkbox.value;

    if (val === 'N/A') {
        if (checkbox.checked) {
            document.querySelectorAll(`.ep-strategies-box[data-record-id="${recordId}"][data-item-id="${itemId}"] input[type="checkbox"]`).forEach(cb => {
                if (cb.value !== 'N/A') cb.checked = false;
            });
            current = new Set(['N/A']);
        } else {
            current.delete('N/A');
        }
    } else {
        if (checkbox.checked) {
            const naCb = document.querySelector(`.ep-strategies-box[data-record-id="${recordId}"][data-item-id="${itemId}"] input[value="N/A"]`);
            if (naCb) naCb.checked = false;
            current.delete('N/A');
            current.add(val);
        } else {
            current.delete(val);
        }
    }

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
    mode: ['mode', 'budget', 'project_type', 'project_description'],
    project_type: ['project_type', 'mode'],
    project_description: ['project_description', 'mode'],
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
    const modeVal = text('mode');
    const projType = text('project_type');
    const budgetRaw = text('budget');
    const budgetNumber = parsePreviewBudget(budgetRaw);

    if (modeVal && !isNaN(budgetNumber) && budgetNumber > 0) {
        const rules = (typeof PROCUREMENT_MODE_RULES !== 'undefined') ? PROCUREMENT_MODE_RULES : null;
        const rule = rules ? rules[modeVal] : null;

        if (rule) {
            // Project type check
            if (projType && rule.allowedTypes && !rule.allowedTypes.includes(projType)) {
                errors.mode = `"${modeVal}" under ${rule.legalBasis} is restricted to ${rule.allowedTypes.join(' / ')}.`;
            }
            // Budget threshold check
            else if (budgetNumber > rule.maxBudget) {
                if (modeVal === 'Direct Acquisition') {
                    errors.mode = `Budget exceeds ₱200,000.00 ceiling for Direct Acquisition (RA 12009 Sec. 32).`;
                    errors.budget = errors.mode;
                } else if (modeVal === 'Small Value Procurement (SVP)') {
                    errors.mode = `Budget exceeds ₱2,000,000.00 ceiling for SVP (RA 12009 Sec. 31). Requires Competitive Bidding.`;
                    errors.budget = errors.mode;
                } else if (modeVal === 'Shopping') {
                    errors.mode = `Budget exceeds ₱2,000,000.00 ceiling for Shopping (RA 12009 Sec. 30).`;
                    errors.budget = errors.mode;
                }
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
// Same limits as the request form (see MAX_FILE_SIZE / MAX_TOTAL_SIZE).
// ------------------------------------------------------------
function previewFileLimits() {
    return {
        file: (typeof MAX_FILE_SIZE === 'number') ? MAX_FILE_SIZE : 10 * 1024 * 1024,
        total: (typeof MAX_TOTAL_SIZE === 'number') ? MAX_TOTAL_SIZE : 50 * 1024 * 1024
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
            const open = (doc && (doc.fileId || doc.dataUrl))
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

        // The file goes straight into IndexedDB; the record only keeps a reference.
        const fileId = FileStore.newId();
        FileStore.put(fileId, file).then(function () {
            draft.pending -= 1;
            draft.pendingSize -= file.size;
            if (previewDrafts[recordId] !== draft) {      // edit was cancelled meanwhile
                FileStore.remove(fileId);
                return;
            }
            item.supporting_documents.push({ name: file.name, size: file.size, type: file.type || '', fileId: fileId });
            refreshPreviewDocCell(recordId, itemId);
            updatePreviewDirtyIndicator(recordId);
        }).catch(function () {
            draft.pending -= 1;
            draft.pendingSize -= file.size;
            showToast('"' + file.name + '" could not be stored in this browser (storage may be full). Please try again.');
        });
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
function itemFilterAttrs(item, includeCriteriaStrategies = true) {
    const docNames = Array.isArray(item.supporting_documents)
        ? item.supporting_documents.map(function (d) { return d.name || ''; })
        : [];
    const haystack = [
        item.project_description, item.project_type, item.quantity_size, item.mode,
        item.pre_procurement, includeCriteriaStrategies ? item.bid_evaluation_criteria : '', item.fund_source,
        item.remarks, item.general_requirements, item.start_date, item.end_date, item.delivery_period,
        formatPesoExact(parseBudgetNumber(item.budget)),
        includeCriteriaStrategies ? (Array.isArray(item.strategies) ? item.strategies.join(' ') : item.strategies) : '',
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
                <td>${escapeHtml(budget)}</td>
                <td>${renderStatusPill(record, submittedTitle)}</td>
                <td>${ppmpType === 'N/A' ? 'N/A' : `<span class="db-status-pill ${ppmpType === 'Final' ? 'is-type-final' : 'is-type-indicative'}">${ppmpType}</span>`}</td>
                <td>${renderApprovedByCell(record)}</td>
            </tr>
            ${isExpanded ? `
            <tr class="db-entry-expand-row">
                <td colspan="9">
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

// ============================================================
// RENDER DEDICATED APP SECTION ON THE DASHBOARD (index.html)
// Matches Recent Activity card styles and supports theme switching
// ============================================================

function renderDashboardAppSection() {
    const list = document.getElementById('db-activity-list');
    if (!list) return; // Only runs on index.html (Dashboard)

    const session = typeof getSession === 'function' ? getSession() : null;
    let appDashCard = document.getElementById('dbAppDashboardCard');

    // SECURITY CHECK: If user is NOT SUP, ARD, or RD, hide the section and exit
    if (!isAppAuthorizedUser(session)) {
        if (appDashCard) appDashCard.style.display = 'none';
        return;
    }

    // Ensure it is visible if previously hidden
    if (appDashCard) appDashCard.style.display = 'block';

    const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const apps = typeof getSupplierAppList === 'function' ? getSupplierAppList(allRecords) : [];

    if (!appDashCard) {
        appDashCard = document.createElement('div');
        appDashCard.id = 'dbAppDashboardCard';
        appDashCard.className = 'db-activity-card';
        appDashCard.style.cssText = 'margin-bottom: 22px; padding: 22px 24px; background: var(--db-card); border: 1px solid var(--db-border); border-radius: var(--db-radius); box-shadow: var(--db-shadow);';

        const anchor = list.closest('.db-activity-card, .db-card, .db-recent-activity, section');
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(appDashCard, anchor);
        } else {
            list.parentNode.appendChild(appDashCard);
        }
    }

    if (apps.length === 0) {
        appDashCard.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
                <h3 style="margin:0; font-size:14.5px; font-weight:700; color:var(--db-text);">Annual Procurement Plans (APP)</h3>
            </div>
            <p style="margin:0; font-size:13px; color:var(--db-text-dim);">No Annual Procurement Plans compiled yet. Approved PPMPs will assemble here.</p>
        `;
        return;
    }

    const itemsHtml = apps.map(app => {
        const yearStr = String(app.fiscal_year);
        const totalBudget = typeof getAppTotalBudgetForYear === 'function' 
            ? getAppTotalBudgetForYear(yearStr, allRecords) 
            : 0;
        const isCompleted = app.status === 'Completed';

        let statusBadge = '<span class="db-status-pill is-draft">Draft</span>';
        if (isCompleted) {
            statusBadge = '<span class="db-status-pill is-completed">Final (Approved)</span>';
        } else if (app.status === 'For Approval') {
            const roleName = app.currentApproverRole === 'ARD' ? 'ARD' : 'RD';
            statusBadge = `<span class="db-status-pill is-pending">Under Review (${roleName})</span>`;
        } else if (app.returned_for_revision) {
            statusBadge = '<span class="db-status-pill is-returned">Returned</span>';
        }

        let actionBtn = `
            <button type="button" class="db-action-btn" title="View APP" onclick="runPreviewApp('${yearStr}')" style="padding: 7px 16px; font-size: 12.5px; font-weight: 600; width: auto; height: auto;">
                View APP
            </button>
        `;

        if (session && session.role === 'ARD' && app.status === 'For Approval' && app.currentApproverRole === 'ARD') {
            actionBtn = `
                <button type="button" class="db-action-btn" title="Review (ARD)" onclick="runPreviewApp('${yearStr}')" style="padding: 7px 16px; font-size: 12.5px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                    Review (ARD) &rarr;
                </button>
            `;
        } else if (session && session.role === 'RD' && app.status === 'For Approval' && app.currentApproverRole === 'RD') {
            actionBtn = `
                <button type="button" class="db-action-btn" title="Review (RD)" onclick="runPreviewApp('${yearStr}')" style="padding: 7px 16px; font-size: 12.5px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                    Review (RD) &rarr;
                </button>
            `;
        } else if (isCompleted) {
            actionBtn = `
                <div style="display:flex; gap:8px;">
                    <button type="button" class="db-action-btn" title="View APP" onclick="runPreviewApp('${yearStr}')" style="padding: 7px 16px; font-size: 12.5px; font-weight: 600; width: auto; height: auto;">
                        View APP
                    </button>
                    <button type="button" class="db-action-btn" title="Download PDF" onclick="generateAPP_PDF('${yearStr}')" style="padding: 7px 16px; font-size: 12.5px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                        Download PDF
                    </button>
                </div>
            `;
        }

        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-top:1px solid var(--db-border);">
                <div>
                    <strong style="font-size:13.5px; color:var(--db-text); display:block; margin-bottom:3px;">
                        Annual Procurement Plan for FY ${escapeHtml(yearStr)}
                    </strong>
                    <div style="display:flex; gap:8px; align-items:center; font-size:12.5px; color:var(--db-text-dim);">
                        <span>Budget: <strong style="color:var(--db-text); display:inline;">${formatPeso(totalBudget)}</strong></span>
                        <span>&bull;</span>
                        ${statusBadge}
                    </div>
                </div>
                <div>
                    ${actionBtn}
                </div>
            </div>
        `;
    }).join('');

    appDashCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
            <h3 style="margin:0; font-size:14.5px; font-weight:700; color:var(--db-text);">Annual Procurement Plans (APP)</h3>
            <span style="font-size:12px; color:var(--db-text-faint);">${apps.length} plan(s) recorded</span>
        </div>
        <div>
            ${itemsHtml}
        </div>
    `;
}

// This gathers the rendering logic so it can be called from the modal
function refreshDashboardRecords() {
    const records = getRecords();

    if (typeof renderStats === 'function') renderStats(records);
    if (typeof renderActivity === 'function') renderActivity(records);
    if (typeof renderEntries === 'function') renderEntries(records);

    // Call the dedicated APP views
    if (typeof renderDashboardAppSection === 'function') renderDashboardAppSection();
    if (typeof renderEntriesAppSection === 'function') renderEntriesAppSection();

    // Notification Dot
    const notifDot = document.getElementById('notifDot');
    const session = typeof getSession === 'function' ? getSession() : null;
    if (notifDot && session) {
        const pendingCount = records.filter(canSessionActOnRecord).length;
        const hasPendingApp = typeof isAppPendingForUser === 'function' && isAppPendingForUser(session);
        notifDot.classList.toggle('hidden', pendingCount === 0 && !hasPendingApp);
    }
}

// ============================================================
// DEDICATED APP ENTRIES & DASHBOARD SECTIONS
// Separates APP management from individual PPMP requests
// ============================================================

// 1. Gather all active APPs (from stored records and approved PPMP years)
function getAppList() {
    const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const appRecords = typeof getAllAppRecords === 'function' ? getAllAppRecords() : [];

    const yearsFromPpmp = [...new Set(
        allRecords
            .filter(r => r && r.status === 'Completed' && /^\d{4}$/.test(String(r.fiscal_year).trim()))
            .map(r => String(r.fiscal_year).trim())
    )];

    const appsMap = new Map();
    appRecords.forEach(app => appsMap.set(String(app.fiscal_year), app));
    yearsFromPpmp.forEach(year => {
        if (!appsMap.has(year) && typeof getAppRecord === 'function') {
            appsMap.set(year, getAppRecord(year));
        }
    });

    return Array.from(appsMap.values()).sort((a, b) => Number(b.fiscal_year) - Number(a.fiscal_year));
}

// 2. Tab switching logic for entries.html
let activeEntriesTab = 'ppmp';

function switchEntriesTab(tabName) {
    activeEntriesTab = tabName;

    const ppmpBtn = document.getElementById('tabPpmpBtn');
    const appBtn = document.getElementById('tabAppBtn');
    const ppmpContent = document.getElementById('ppmpTabContent');
    const appContent = document.getElementById('appTabContent');

    if (ppmpBtn) ppmpBtn.classList.toggle('active', tabName === 'ppmp');
    if (appBtn) appBtn.classList.toggle('active', tabName === 'app');

    if (ppmpContent) ppmpContent.style.display = (tabName === 'ppmp' ? 'block' : 'none');
    if (appContent) appContent.style.display = (tabName === 'app' ? 'block' : 'none');
}

// 3. Render APP entries table on entries.html
function renderEntriesAppSection() {
    const entriesCard = document.querySelector('.db-entries-card');
    if (!entriesCard) return; // Not on entries.html

    const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const session = typeof getSession === 'function' ? getSession() : null;
    const apps = typeof getSupplierAppList === 'function' ? getSupplierAppList(allRecords) : [];

    // 1. Setup Tab Navigation and Section Wrappers if not yet created
    let tabsNav = document.getElementById('entriesTabsNav');
    let ppmpContent = document.getElementById('ppmpTabContent');
    let appContent = document.getElementById('appTabContent');

    if (!tabsNav) {
        tabsNav = document.createElement('div');
        tabsNav.id = 'entriesTabsNav';
        tabsNav.className = 'db-entries-tabs';
        tabsNav.innerHTML = `
            <button type="button" id="tabPpmpBtn" class="db-tab-btn active" onclick="switchEntriesTab('ppmp')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                <span>PPMP Requests</span>
            </button>
            <button type="button" id="tabAppBtn" class="db-tab-btn" onclick="switchEntriesTab('app')">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                <span>Annual Procurement Plans (APP)</span>
            </button>
        `;

        // Wrap current children of entriesCard into ppmpTabContent
        ppmpContent = document.createElement('div');
        ppmpContent.id = 'ppmpTabContent';

        while (entriesCard.firstChild) {
            ppmpContent.appendChild(entriesCard.firstChild);
        }

        // Create container for the APP table
        appContent = document.createElement('div');
        appContent.id = 'appTabContent';
        appContent.style.display = 'none';

        // Reassemble inside entriesCard
        entriesCard.appendChild(tabsNav);
        entriesCard.appendChild(ppmpContent);
        entriesCard.appendChild(appContent);

        // For Suppliers, open the APP tab by default
        if (session && session.role === 'SUP') {
            switchEntriesTab('app');
        }
    }

    // 2. Render APP Table Body
    if (apps.length === 0) {
        appContent.innerHTML = `
            <div class="db-entries-empty" style="padding: 36px 18px; text-align: center;">
                <p style="margin: 0; font-size: 14px; color: var(--db-text-dim);">
                    No Annual Procurement Plans available yet. Fully approve PPMPs to compile the plan.
                </p>
            </div>
        `;
        return;
    }

    const rowsHtml = apps.map(app => {
        const totalBudget = getAppTotalBudgetForYear(app.fiscal_year, allRecords);
        const isCompleted = app.status === 'Completed';

        let statusBadge = '<span class="db-status-pill is-draft">Draft</span>';
        if (isCompleted) {
            statusBadge = '<span class="db-status-pill is-completed">Final (Approved)</span>';
        } else if (app.status === 'For Approval') {
            const roleName = app.currentApproverRole === 'ARD' ? 'ARD' : 'RD';
            statusBadge = `<span class="db-status-pill is-pending">Under Review (${roleName})</span>`;
        } else if (app.returned_for_revision) {
            statusBadge = '<span class="db-status-pill is-returned">Returned</span>';
        }

        const typeBadge = isCompleted 
            ? '<span class="db-status-pill is-type-final">Final</span>' 
            : '<span class="db-status-pill is-type-indicative">Indicative</span>';

        const submittedInfo = app.submitted_by 
            ? `<strong>${escapeHtml(app.submitted_by.name)}</strong><span>${formatApprovalDate(app.submitted_at)}</span>` 
            : '<span class="db-approver-none">—</span>';

        const endorsedInfo = app.ard_approved_by 
            ? `<strong>${escapeHtml(app.ard_approved_by.name)}</strong><span>${formatApprovalDate(app.ard_approved_at)}</span>` 
            : '<span class="db-approver-none">—</span>';

        const approvedInfo = app.approved_by 
            ? `<strong>${escapeHtml(app.approved_by.name)}</strong><span>${formatApprovalDate(app.approved_at)}</span>` 
            : '<span class="db-approver-none">—</span>';

        let actionBtn = `
            <button type="button" class="db-action-btn" title="View APP" onclick="runPreviewApp('${app.fiscal_year}')" style="padding: 6px 14px; font-size: 12px; font-weight: 600; width: auto; height: auto;">
                View APP
            </button>
        `;
        if (session && session.role === 'ARD' && app.status === 'For Approval' && app.currentApproverRole === 'ARD') {
            actionBtn = `
                <button type="button" class="db-action-btn" title="Review (ARD)" onclick="runPreviewApp('${app.fiscal_year}')" style="padding: 6px 14px; font-size: 12px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                    Review (ARD) &rarr;
                </button>
            `;
        } else if (session && session.role === 'RD' && app.status === 'For Approval' && app.currentApproverRole === 'RD') {
            actionBtn = `
                <button type="button" class="db-action-btn" title="Review (RD)" onclick="runPreviewApp('${app.fiscal_year}')" style="padding: 6px 14px; font-size: 12px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                    Review (RD) &rarr;
                </button>
            `;
        } else if (isCompleted) {
            actionBtn = `
                <div style="display:flex; gap:6px;">
                    <button type="button" class="db-action-btn" title="View APP" onclick="runPreviewApp('${app.fiscal_year}')" style="padding: 6px 14px; font-size: 12px; font-weight: 600; width: auto; height: auto;">
                        View
                    </button>
                    <button type="button" class="db-action-btn" title="Download PDF" onclick="generateAPP_PDF('${app.fiscal_year}')" style="padding: 6px 14px; font-size: 12px; font-weight: 600; width: auto; height: auto; background: var(--db-accent); color: #fff; border-color: var(--db-accent);">
                        PDF
                    </button>
                </div>
            `;
        }

        return `
            <tr>
                <td><strong>FY ${escapeHtml(app.fiscal_year)}</strong></td>
                <td class="db-entry-description" style="max-width:320px;">
                    <strong style="color:var(--db-text);">Annual Procurement Plan for FY ${escapeHtml(app.fiscal_year)}</strong>
                    <span>Master Consolidated Plan</span>
                </td>
                <td><strong>${formatPeso(totalBudget)}</strong></td>
                <td>${statusBadge}</td>
                <td>${typeBadge}</td>
                <td><div class="db-approver">${submittedInfo}</div></td>
                <td><div class="db-approver">${endorsedInfo}</div></td>
                <td><div class="db-approver">${approvedInfo}</div></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');

    appContent.innerHTML = `
        <div class="db-section-head" style="margin-bottom: 16px;">
            <div>
                <h3>Annual Procurement Plans (APP)</h3>
                <p>Consolidated annual procurement plans across all implementing units</p>
            </div>
            <div style="color:var(--db-text-faint); font-size:12.5px;">
                ${apps.length} plan(s) recorded
            </div>
        </div>
        <div class="db-entries-table-wrap">
            <table class="db-entries-table">
                <thead>
                    <tr>
                        <th>Fiscal Year</th>
                        <th>Plan Title</th>
                        <th>Approved Budget</th>
                        <th>Status</th>
                        <th>Type</th>
                        <th>Submitted By</th>
                        <th>Endorsed By (ARD)</th>
                        <th>Approved By (RD)</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
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
    renderAppExportButton();

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

    if (typeof renderEntriesAppSection === 'function') renderEntriesAppSection();
    if (typeof renderDashboardAppSection === 'function') renderDashboardAppSection();

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