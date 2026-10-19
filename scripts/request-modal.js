// ============================================================
// PROCUREMENT REQUEST FORM SCRIPT
// ============================================================
// Features:
// - Step navigation
// - Required field validation
// - Inline validation errors (NO browser alerts)
// - PPMP number auto-increment
// - Number-only restrictions
// - Fiscal year validation
// - Budget validation
// - Date validation
// - Procurement strategy multi-select
// - Supporting document upload
// - File size validation
// - File preview
// - View existing procurement records
// - LocalStorage saving
// ============================================================


// ============================================================
// GLOBAL VARIABLES
// ============================================================

let selectedStrategies = [];
let uploadedFiles = [];
let uploadIdCounter = 0;

let isViewMode = false;

const MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10MB per file (files live in IndexedDB, see file-store.js)
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total per item
// Approval chain. `role` is a STAGE code: it must equal the `stage` set on the
// approver's account in Auth.js, and is what record.currentApproverRole stores.
// (The record's `status` stays 'For Approval' for the whole chain.)
const APPROVAL_CHAIN = [
    { role: 'HEAD', label: 'Unit Head' },
    { role: 'TOD',  label: 'Technical Operations Division' },
    { role: 'BO',   label: 'Budget Officer' },
    { role: 'RD',   label: 'Regional Director' }
];

// ============================================================
// INDICATIVE / FINAL — suggested from Source of Funds
// Any item funded "Before GAA" makes the PPMP Indicative; otherwise Final.
// Stays editable: choosing by hand switches to 'manual' and auto stops.
// ============================================================
const BEFORE_GAA_PATTERN = /\b(?:before|pre|prior(?:\s+to)?)[\s-]*(?:the\s+)?(?:gaa|general\s+appropriations?(?:\s+act)?)\b/i;
let indicativeManual = false;

function suggestIndicativeFromItems(items) {
    const sources = (items || [])
        .map(function (it) { return String((it && it.fund_source) || '').trim(); })
        .filter(Boolean);
    if (!sources.length) return null;   // nothing to decide from yet
    return sources.some(function (s) { return BEFORE_GAA_PATTERN.test(s); }) ? 'Indicative' : 'Final';
}

// What to store on a record. A manual choice is never overwritten.
function resolveIndicative(items, currentValue, manual) {
    if (manual) return { is_indicative: currentValue, indicative_mode: 'manual' };
    return { is_indicative: suggestIndicativeFromItems(items) || currentValue, indicative_mode: 'auto' };
}

// Other items already saved under this PPMP + the fund source currently typed.
function getItemsForIndicative() {
    const items = [];
    if (currentEditingId && typeof getRecordItems === 'function') {
        const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
        const rec = records.find(function (r) { return r.id == currentEditingId; });
        if (rec) getRecordItems(rec).forEach(function (it) {
            if (it.id != currentEditingItemId) items.push(it);
        });
    }
    const fund = document.getElementById('fund_source');
    items.push({ fund_source: fund ? fund.value : '' });
    return items;
}

function renderIndicativeHint() {
    const sel = document.getElementById('is_indicative');
    if (!sel) return;
    let hint = document.getElementById('indicativeHint');
    if (!hint) {
        hint = document.createElement('p');
        hint.id = 'indicativeHint';
        hint.className = 'mode-hint';
        sel.closest('.field-group').appendChild(hint);
    }
    const suggestion = suggestIndicativeFromItems(getItemsForIndicative());
    hint.textContent = '';
    if (!indicativeManual) {
        hint.textContent = suggestion
            ? 'Set automatically from Source of Funds (' + (suggestion === 'Indicative' ? 'Before GAA' : 'GAA-funded') + '). You can still change it.'
            : 'Set automatically from Source of Funds in Step 3: Before GAA → Indicative, otherwise Final. You can still change it.';
        return;
    }
    hint.textContent = 'Set manually' +
        (suggestion && suggestion !== sel.value ? ' (Source of Funds suggests ' + suggestion + ')' : '') + '. ';
    if (!sel.disabled && !isViewMode) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Reset to automatic';
        btn.style.cssText = 'background:none;border:none;padding:0;font:inherit;color:var(--db-accent,#3B82F6);text-decoration:underline;cursor:pointer;';
        btn.addEventListener('click', function () { indicativeManual = false; syncIndicative(); });
        hint.appendChild(btn);
    }
}

function syncIndicative() {
    const sel = document.getElementById('is_indicative');
    if (!sel || isViewMode) return;
    if (!indicativeManual) {
        const suggestion = suggestIndicativeFromItems(getItemsForIndicative());
        if (suggestion) sel.value = suggestion;   // programmatic: fires no 'change', so it stays automatic
    }
    renderIndicativeHint();
}

function initIndicativeAuto() {
    const fund = document.getElementById('fund_source');
    const sel = document.getElementById('is_indicative');
    if (!fund || !sel) return;

    // Suggestions only; free text is still allowed, so the data shape doesn't change.
    if (!document.getElementById('fundSourceOptions')) {
        const dl = document.createElement('datalist');
        dl.id = 'fundSourceOptions';
        ['Before GAA', 'GAA'].forEach(function (v) {
            const o = document.createElement('option'); o.value = v; dl.appendChild(o);
        });
        fund.parentNode.appendChild(dl);
        fund.setAttribute('list', 'fundSourceOptions');
    }

    fund.addEventListener('input', syncIndicative);
    fund.addEventListener('change', function () {   // fires on blur, so one toast, not one per keystroke
        if (!indicativeManual && !isViewMode && sel.value && typeof showToast === 'function') {
            showToast('Marked ' + sel.value + ' from Source of Funds. You can change it in Step 1.');
        }
    });
    sel.addEventListener('change', function () { indicativeManual = true; renderIndicativeHint(); });
    renderIndicativeHint();
}

function getApprovalStep(stage) {
    return APPROVAL_CHAIN.find(step => step.role === stage) || null;
}

// ============================================================
// REQUIRED DOCUMENT BY TYPE OF PROJECT
// (Technical Specifications for Goods, Terms of Reference for
// Regular/Consulting Services, Scope of Work for Infrastructure)
// ============================================================

const PROJECT_TYPE_DOC_LABELS = {
    'Goods': 'Technical Specifications',
    'Consulting Services': 'Terms of Reference',
    'Infrastructure': 'Scope of Work'
};

function getCurrentUser() {
    return (typeof getSession === 'function' && getSession()) || { role: null, canApprove: false, canRequest: false };
}

function updateDocTypeHint() {

    const hintEl = document.getElementById('docTypeHint');
    if (!hintEl) return;

    const projectTypeEl = document.getElementById('project_type');
    const projectType = projectTypeEl ? projectTypeEl.value : '';

    const docLabel = PROJECT_TYPE_DOC_LABELS[projectType];

    hintEl.innerText = docLabel
        ? `Required document: ${docLabel}`
        : 'Select a Type of Project in Step 1 to see the required document.';
}


// ============================================================
// NAVIGATION LOGIC
// ============================================================

function showNextStep() {

    document.getElementById('step-1').classList.add('hidden');
    document.getElementById('step-2').classList.remove('hidden');

    document.getElementById('page-title').innerText =
        "PROJECTED TIMELINE";

    document.getElementById('progress-fill').style.width =
        "45%";
}


function showStep3() {

    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-3').classList.remove('hidden');

    document.getElementById('page-title').innerText =
        "FUNDING DETAILS";

    document.getElementById('progress-fill').style.width =
        "85%";

    updateDocTypeHint();
}


function showStep1() {

    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-1').classList.remove('hidden');

    document.getElementById('page-title').innerText =
        "PROCUREMENT PROJECT DETAILS";

    document.getElementById('progress-fill').style.width =
        "15%";
}


function showStep2() {

    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-2').classList.remove('hidden');

    document.getElementById('page-title').innerText =
        "PROJECTED TIMELINE";

    document.getElementById('progress-fill').style.width =
        "45%";
}


// ============================================================
// FIELD HELPERS
// ============================================================

function getFieldGroup(fieldName) {

    return document.querySelector(
        `.field-group[data-field="${fieldName}"]`
    );
}


// ============================================================
// INLINE ERROR MESSAGE
// ============================================================

function showFieldError(fieldName, message) {

    const group = getFieldGroup(fieldName);

    if (!group) return;

    group.classList.add('error-state');

    // Reuse the .field-error-msg element that's already in the HTML for
    // this field-group instead of creating a second, separate message.
    let errorMessage =
        group.querySelector('.field-error-msg');

    if (!errorMessage) {

        errorMessage =
            document.createElement('p');

        errorMessage.className =
            'field-error-msg';

        group.appendChild(errorMessage);
    }

    // Remember the default markup text the first time so it can be
    // restored later instead of permanently overwriting it.
    if (errorMessage.dataset.defaultText === undefined) {
        errorMessage.dataset.defaultText = errorMessage.textContent;
    }

    errorMessage.textContent = message;
}


function clearFieldError(fieldName) {

    const group = getFieldGroup(fieldName);

    if (!group) return;

    group.classList.remove('error-state');

    const errorMessage =
        group.querySelector('.field-error-msg');

    if (errorMessage && errorMessage.dataset.defaultText !== undefined) {
        errorMessage.textContent = errorMessage.dataset.defaultText;
    }
}


function clearAllFieldErrors() {

    document
        .querySelectorAll('.field-group')
        .forEach(group => {

            group.classList.remove('error-state');

            const errorMessage =
                group.querySelector('.field-error-msg');

            if (errorMessage && errorMessage.dataset.defaultText !== undefined) {
                errorMessage.textContent = errorMessage.dataset.defaultText;
            }
        });
}


// ============================================================
// PPMP NUMBER AUTO-INCREMENT
// ============================================================

// PPMP numbers restart at 1 for every fiscal year, and every office numbers
// its PPMPs independently. So PPMP No. 4 of FY 2026 and PPMP No. 1 of FY 2027
// can both exist for the same office. Choosing a year that already has PPMPs
// continues that year's numbering (FY 2026 -> No. 5 after No. 4); a year with
// none yet (e.g. next year's plan) starts at No. 1.
//
// The last approved number is also remembered per office + year in
// localStorage 'ppmp_number_counters_by_year' ("<office>|<year>" -> number), so
// deleting an approved PPMP can never make its number come around again.
// Drafts and returned PPMPs don't move the counter - only an approval does.
//
// 'ppmp_number_counters' is the OLD counter (per office, no year). It is still
// read, but only as a floor for the current calendar year, because every
// number it recorded was issued before numbering became per-year.
const PPMP_COUNTER_KEY = 'ppmp_number_counters';
const PPMP_YEAR_COUNTER_KEY = 'ppmp_number_counters_by_year';

function readPpmpCounters() {
    try {
        const parsed = JSON.parse(localStorage.getItem(PPMP_COUNTER_KEY));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function readPpmpYearCounters() {
    try {
        const parsed = JSON.parse(localStorage.getItem(PPMP_YEAR_COUNTER_KEY));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function ppmpYearCounterKey(office, year) {
    return office + '|' + year;
}

// Returns the year as a 4-digit string, or '' when it isn't one.
function normalizeFiscalYear(value) {
    const text = String(value == null ? '' : value).trim();
    return /^\d{4}$/.test(text) ? text : '';
}

// A fiscal year is CLOSED once its APP is Final: no PPMP can be filed under it
// any more. Returns the message to show when the PPMP in the form would land in
// a closed year, or '' when that's fine. It only blocks CREATING in a closed
// year - a brand-new PPMP, or an existing draft whose year is being CHANGED to
// a closed one. Drafts that already sit in a closed year are left as they are
// (they can still be edited and get entries added).
function getClosedFiscalYearMessage(yearText) {
    const year = normalizeFiscalYear(yearText);
    if (!year || isViewMode) return '';
    if (typeof isAppFinal !== 'function' || !isAppFinal(year)) return '';

    if (currentEditingId) {
        // Existing PPMP: only an actual change of year is blocked.
        const record = (JSON.parse(localStorage.getItem('procurement_records')) || [])
            .find(r => r.id == currentEditingId);
        if (!record || String(record.fiscal_year) === year) return '';
    } else if (!ppmpNumberFollowsYear) {
        return '';   // adding an entry to a PPMP: its year is fixed by the PPMP
    }

    const next = typeof getNextOpenFiscalYear === 'function'
        ? getNextOpenFiscalYear(year)
        : String(Number(year) + 1);
    return 'The APP for FY ' + year + ' is already Final, so PPMPs can no longer be filed under that year. Use FY ' + next + ' or later.';
}

// Called when a PPMP is fully approved (see performReviewAction).
function recordApprovedPpmpNumber(record) {
    if (!record) return;
    const number = parseInt(record.ppmp_no, 10);
    const year = normalizeFiscalYear(record.fiscal_year);
    if (isNaN(number) || !year) return;

    const office = record.end_user || 'N/A';
    const key = ppmpYearCounterKey(office, year);
    const counters = readPpmpYearCounters();
    if (number > (Number(counters[key]) || 0)) {
        counters[key] = number;
        try {
            localStorage.setItem(PPMP_YEAR_COUNTER_KEY, JSON.stringify(counters));
        } catch (e) {
            console.warn('Could not save the PPMP number counter', e);
        }
    }
}

// Next PPMP number for the signed-in office in the given fiscal year.
// Without a valid year it falls back to the current calendar year.
function getNextPpmpNumber(fiscalYear) {
    const currentYear = String(new Date().getFullYear());
    const year = normalizeFiscalYear(fiscalYear) || currentYear;

    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];

    const session = typeof getSession === 'function' ? getSession() : null;
    const office = session && session.office ? session.office : null;

    let highest = 0;

    // Highest approved number still on record for this office in this year...
    records.forEach(record => {
        if (record.status !== 'Completed') return;
        if (office && record.end_user !== office) return;
        if (normalizeFiscalYear(record.fiscal_year) !== year) return;
        const number = parseInt(record.ppmp_no, 10);
        if (!isNaN(number) && number > highest) highest = number;
    });

    // ...or the remembered counter for this office + year, whichever is higher.
    const yearCounters = readPpmpYearCounters();
    if (office) {
        highest = Math.max(highest, Number(yearCounters[ppmpYearCounterKey(office, year)]) || 0);
    } else {
        // Accounts without an office fall back to counting every office.
        Object.keys(yearCounters).forEach(key => {
            if (key.slice(-(year.length + 1)) === '|' + year) {
                highest = Math.max(highest, Number(yearCounters[key]) || 0);
            }
        });
    }

    // Old per-office counter: only counts toward the current year (see top).
    if (year === currentYear) {
        const legacy = readPpmpCounters();
        if (office) {
            highest = Math.max(highest, Number(legacy[office]) || 0);
        } else {
            Object.keys(legacy).forEach(key => {
                highest = Math.max(highest, Number(legacy[key]) || 0);
            });
        }
    }

    return highest + 1;
}

// ============================================================
// VERSION CARRY-OVER HELPERS
// Carries over approved line items from previous versions (v1 -> v2 -> v3)
// ============================================================

function getLatestApprovedPpmpForOffice(office, fiscalYear) {
    if (!office || !fiscalYear) return null;
    const year = normalizeFiscalYear(fiscalYear);
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    
    const approved = records.filter(r =>
        r && r.status === 'Completed' &&
        r.end_user === office &&
        normalizeFiscalYear(r.fiscal_year) === year
    );

    if (approved.length === 0) return null;

    // Pick the highest approved PPMP No. for this office and year
    approved.sort((a, b) => {
        const numA = parseInt(a.ppmp_no, 10) || 0;
        const numB = parseInt(b.ppmp_no, 10) || 0;
        if (numB !== numA) return numB - numA;
        return (Number(b.approved_at) || Number(b.id) || 0) - (Number(a.approved_at) || Number(a.id) || 0);
    });

    return approved[0];
}

function clonePpmpItemsForCarryOver(sourceRecord, newBaseTimestamp) {
    if (!sourceRecord) return [];
    const items = typeof getRecordItems === 'function' ? getRecordItems(sourceRecord) : (sourceRecord.items || []);
    const base = newBaseTimestamp || Date.now();
    
    return items.map((item, idx) => {
        const cloned = JSON.parse(JSON.stringify(item));
        // Assign a fresh unique ID so editing in the new version does not mutate the old version
        cloned.id = base + idx + 1;
        return cloned;
    });
}


// True while the PPMP No. field should follow the Fiscal Year field (a brand
// new PPMP). False when the number is fixed by an existing PPMP.
let ppmpNumberFollowsYear = false;

function initializePpmpNumber() {

    const ppmpField =
        document.getElementById('ppmp_no');

    if (!ppmpField) return;

    // Do not change PPMP number when viewing a record
    if (isViewMode) return;

    const viewId =
        sessionStorage.getItem('view_record_id');

    if (viewId) return;

    // The number depends on the fiscal year, which the user types in next,
    // so it stays blank until a valid year is entered
    // (see refreshPpmpNumberForYear).
    ppmpNumberFollowsYear = true;
    ppmpField.value = '';
    ppmpField.placeholder = 'Enter Fiscal Year first';

    // User should not manually change the generated number
    ppmpField.readOnly = true;
}

// Re-generates the PPMP No. whenever the Fiscal Year field changes.
function refreshPpmpNumberForYear() {
    const ppmpField = document.getElementById('ppmp_no');
    const yearField = document.getElementById('fiscal_year');
    if (!ppmpField || !yearField) return;

    if (!ppmpNumberFollowsYear || isViewMode || currentEditingId) return;

    const year = normalizeFiscalYear(yearField.value);
    const yearNumber = parseInt(year, 10);

    if (!year || yearNumber < 2000 || yearNumber > 2100) {
        ppmpField.value = '';
        return;
    }

    if (getClosedFiscalYearMessage(year)) {
        ppmpField.value = '';
        return;
    }

    const nextNo = getNextPpmpNumber(year);
    ppmpField.value = nextNo;
    if (typeof clearFieldError === 'function') clearFieldError('ppmp_no');

    // Inform user if items from a previous approved version will carry over
    const session = typeof getSession === 'function' ? getSession() : null;
    const office = session ? session.office : null;
    if (office && nextNo > 1) {
        const prev = getLatestApprovedPpmpForOffice(office, year);
        if (prev) {
            const count = (typeof getRecordItems === 'function' ? getRecordItems(prev) : (prev.items || [])).length;
            const hint = document.getElementById('docTypeHint');
            if (hint) {
                hint.innerText = `Version ${nextNo}: ${count} approved item(s) from PPMP No. ${prev.ppmp_no} will carry over into this plan.`;
            }
        }
    }
}

// Returns the year it pre-filled (see below), or '' when it left the field blank.
function initializeFiscalYear() {
    const fiscalYearField = document.getElementById('fiscal_year');
    if (!fiscalYearField) return '';

    if (isViewMode || currentEditingId) return '';

    // Fiscal year is normally typed in by the user: start blank and editable;
    // validation still requires 4 digits.
    fiscalYearField.value = '';
    fiscalYearField.readOnly = false;
    fiscalYearField.maxLength = 4;
    fiscalYearField.setAttribute('inputmode', 'numeric');
    fiscalYearField.placeholder = 'e.g. ' + new Date().getFullYear();
    fiscalYearField.title = '';
    fiscalYearField.style.backgroundColor = '';
    fiscalYearField.style.cursor = '';

    // Exception: once the APP of the current fiscal year is Final, a new PPMP
    // starts in the NEXT year. It stays editable, and the PPMP No. follows it
    // (No. 1 for a year with no approved PPMPs yet).
    const rollover = typeof getDefaultNewPpmpFiscalYear === 'function'
        ? getDefaultNewPpmpFiscalYear()
        : null;

    if (rollover) {
        fiscalYearField.value = rollover;
        fiscalYearField.title = 'The APP for FY ' + (Number(rollover) - 1) + ' is already Final, so new PPMPs start in FY ' + rollover + '.';
        refreshPpmpNumberForYear();
        return rollover;
    }

    return '';
}


// ============================================================
// ADD ENTRY TO AN EXISTING (NOT YET APPROVED) PPMP
// A PPMP can hold more than one entry. While it still has at least one
// Pending entry, it isn't approved yet, so the user can add another entry
// under the same PPMP No. / fiscal year instead of starting a brand-new one.
// ============================================================

function getPendingPpmpGroups() {
    const records = typeof getRecords === 'function' ? getRecords() : [];
    const groups = new Map();

    records.forEach(record => {
        if (getPpmpStatus(record) !== 'Draft') return;

        const key = String(record.ppmp_no || 'N/A');
        const itemCount = (typeof getRecordItems === 'function' ? getRecordItems(record) : [record]).length;

        if (!groups.has(key)) {
            groups.set(key, { ppmp_no: key, fiscal_year: record.fiscal_year, count: 0 });
        }

        groups.get(key).count += itemCount;
    });

    return [...groups.values()].sort((a, b) =>
        String(a.ppmp_no).localeCompare(String(b.ppmp_no), undefined, { numeric: true })
    );
}


function startNewRequest() {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (session && !session.canRequest) {
        showToast('Your account is view/approve only and cannot create new requests.');
        return;
    }

    const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const office = session ? session.office : null;
    const records = office ? allRecords.filter(r => r.end_user === office) : allRecords;

    // 1. If ongoing PPMP is submitted for review, block until higher-ups approve or return it
    const submittedPpmp = records.find(r => getPpmpStatus(r) === 'For Approval');
    if (submittedPpmp) {
        showToast('PPMP No. ' + (submittedPpmp.ppmp_no || 'N/A') + ' is currently submitted for approval. You cannot add entries or start a new PPMP until it is approved or returned.');
        return;
    }

    // 2. If there is an existing Draft PPMP, directly open the form to add the next item!
    const draftRecords = records.filter(r => getPpmpStatus(r) === 'Draft');
    if (draftRecords.length > 0) {
        const targetPpmpNo = draftRecords[0].ppmp_no || '1';
        addEntryToPpmp(targetPpmpNo, draftRecords[0].fiscal_year);
        return;
    }

    // 3. No active PPMPs exist (all deleted or fully approved) -> Start a brand new PPMP
    openRequestModal();
}


function openPpmpChoiceModal(groups) {
    const overlay = document.getElementById('ppmpChoiceModalOverlay');
    const select = document.getElementById('pendingPpmpSelect');

    if (!overlay || !select) {
        if (groups && groups.length > 0) {
            addEntryToPpmp(groups[0].ppmp_no);
        } else {
            openRequestModal();
        }
        return;
    }

    const esc = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v ?? ''));

    select.innerHTML = groups.map(group =>
        `<option value="${esc(group.ppmp_no)}">PPMP No. ${esc(group.ppmp_no)} — FY ${esc(group.fiscal_year || 'N/A')} (${group.count} ${group.count === 1 ? 'entry' : 'entries'})</option>`
    ).join('');

    // Hide "Start New PPMP"
    const startNewBtn = overlay.querySelector('.choice-footer .back-btn, button[onclick*="startBrandNewPpmp"]');
    if (startNewBtn) {
        startNewBtn.style.display = 'none';
    }

    const desc = overlay.querySelector('.choice-description');
    if (desc) {
        desc.textContent = "You have an ongoing PPMP in progress. Add this as another entry under it.";
    }

    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
}


function closePpmpChoiceModal() {
    const overlay = document.getElementById('ppmpChoiceModalOverlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }
}


function confirmAddToSelectedPpmp() {
    const select = document.getElementById('pendingPpmpSelect');
    const ppmpNo = select ? select.value : null;

    closePpmpChoiceModal();

    if (ppmpNo) {
        addEntryToPpmp(ppmpNo);
    } else {
        const groups = typeof getPendingPpmpGroups === 'function' ? getPendingPpmpGroups() : [];
        if (groups.length > 0) {
            addEntryToPpmp(groups[0].ppmp_no);
        }
    }
}


function startBrandNewPpmp() {
    closePpmpChoiceModal();
    openRequestModal();
}


// ============================================================
// NUMBER-ONLY INPUT RESTRICTIONS
// ============================================================

function restrictNumberOnly(fieldId) {

    const field =
        document.getElementById(fieldId);

    if (!field) return;

    field.addEventListener('input', function () {

        const originalValue =
            this.value;

        const cleanedValue =
            originalValue.replace(/\D/g, '');

        if (originalValue !== cleanedValue) {
            this.value = cleanedValue;
        }
    });
}


function restrictDecimalNumber(fieldId) {

    const field =
        document.getElementById(fieldId);

    if (!field) return;

    field.addEventListener('input', function () {

        let value =
            this.value;

        // Allow numbers and decimal point only
        value =
            value.replace(/[^0-9.]/g, '');

        // Only allow one decimal point
        const parts =
            value.split('.');

        if (parts.length > 2) {

            value =
                parts[0] + '.' + parts.slice(1).join('');
        }

        this.value = value;
    });
}


// ============================================================
// PROCUREMENT STRATEGY MULTI-SELECT
// ============================================================

function renderTags(container) {

    if (!container) return;

    if (selectedStrategies.length === 0) {

        container.innerHTML =
            '<span class="placeholder">Select strategies...</span>';

    } else {

        container.innerHTML =
            selectedStrategies
                .map(strategy =>
                    `<span class="tag">${strategy}</span>`
                )
                .join('');
    }
}


function removeStrategy(strategy) {

    selectedStrategies =
        selectedStrategies.filter(
            item => item !== strategy
        );

    renderTags(
        document.getElementById('selectedTags')
    );

    if (selectedStrategies.length > 0) {
        clearFieldError('procurement_strategies');
    }
}


function initializeStrategies() {
    ensureStrategyNaOption();

    const trigger = document.getElementById('strategiesTrigger');
    const menu = document.getElementById('strategiesMenu');
    const tagsContainer = document.getElementById('selectedTags');

    if (!trigger || !menu) return;

    const options = menu.querySelectorAll('.option');

    // Open / close menu
    trigger.onclick = function (event) {
        event.stopPropagation();
        menu.classList.toggle('hidden');
    };

    // Strategy options
    options.forEach(option => {
        option.onclick = function (event) {
            event.stopPropagation();
            const text = this.innerText.trim();

            if (text === 'N/A') {
                if (this.classList.contains('selected')) {
                    this.classList.remove('selected');
                    selectedStrategies = [];
                } else {
                    // Selecting N/A clears all other strategies
                    options.forEach(opt => opt.classList.remove('selected'));
                    this.classList.add('selected');
                    selectedStrategies = ['N/A'];
                }
            } else {
                // Selecting any other strategy unchecks N/A
                const naOpt = Array.from(options).find(opt => opt.innerText.trim() === 'N/A');
                if (naOpt) naOpt.classList.remove('selected');
                selectedStrategies = selectedStrategies.filter(s => s !== 'N/A');

                this.classList.toggle('selected');
                if (this.classList.contains('selected')) {
                    if (!selectedStrategies.includes(text)) selectedStrategies.push(text);
                } else {
                    selectedStrategies = selectedStrategies.filter(item => item !== text);
                }
            }

            renderTags(tagsContainer);

            if (selectedStrategies.length > 0) {
                clearFieldError('procurement_strategies');
            }
        };
    });

    document.addEventListener('click', function () {
        menu.classList.add('hidden');
    });
}


// ============================================================
// SAVE PROCUREMENT REQUEST
// ============================================================

// What a saved record keeps for one attachment: a small reference, never the
// file bytes (those are in IndexedDB under entry.fileId - see file-store.js).
// A document that came from an older record and was not migrated yet still
// carries its inline dataUrl; file-store.js moves it on the next page load.
function buildSavedDocFromEntry(entry) {
    const doc = {
        name: entry.file.name,
        size: entry.file.size,
        type: (entry.file && entry.file.type) || entry.type || ''
    };
    if (entry.fileId) {
        doc.fileId = entry.fileId;
    } else if (entry.dataUrl) {
        doc.dataUrl = entry.dataUrl;
    }
    return doc;
}

function saveProcurementRequest() {
    // If we are just viewing, clicking "Close" (Finish button) should just close the modal
    if (isViewMode) {
        closeRequestModal();
        return;
    }

    // Only requesting accounts may create or change PPMP entries.
    const permSession = typeof getSession === 'function' ? getSession() : null;
    if (!permSession || !permSession.canRequest) {
        showToast('Your account is view/approve only and cannot save requests.');
        return;
    }

    // Final validation before saving
    if (!validateStep('form-step-3')) {
        return;
    }

    // Belt-and-suspenders: re-verify mode/budget compliance in case the
    // form was reached without passing through the normal step flow.
    if (!validateModeBudgetMatch()) {
        showStep1(); // Bring user back to Step 1/2 to see the budget/mode error
        showToast('Please check the Mode of Procurement and Budget match.');
        return;
    }

    if (typeof validateDeliveryDateMatch === 'function' && !validateDeliveryDateMatch()) {
        showStep2(); // Bring user back to Step 2 to see the date error
        showToast('Please check the End Date and Delivery Period.');
        return;
    }

    // The APP for this fiscal year may have become Final while the form was
    // open (or the year was changed after Step 1): don't save into a closed year.
    const closedYearMessage = getClosedFiscalYearMessage(
        (document.getElementById('fiscal_year') || {}).value
    );
    if (closedYearMessage) {
        showStep1();
        showFieldError('fiscal_year', closedYearMessage);
        showToast(closedYearMessage);
        return;
    }

    if (!validateStep('form-step-3')) {
        return;
    }

    // Attachments are written to IndexedDB as soon as they are picked; wait
    // for any that are still being stored so the record never points at a
    // file that is not there yet.
    if (uploadedFiles.some(entry => entry.pending)) {
        showToast('Still attaching files - wait a moment, then press Finish again.');
        return;
    }

    const db =
        JSON.parse(
            localStorage.getItem(
                'procurement_records'
            )
        ) || [];

    // currentEditingId is set by openRequestModal()/loadRecordIntoModal()/
    // addEntryToPpmp() whenever this save targets an existing PPMP record.
    // currentEditingItemId then tells us whether we're updating one of its
    // existing items (set) or appending a brand-new one (null).
    const existingRecord = currentEditingId
        ? db.find(r => r.id == currentEditingId)
        : null;

    // The PPMP may have been submitted or approved since this form was opened
    // (for example from another tab). Locked PPMPs are read-only.
    if (existingRecord && getPpmpStatus(existingRecord) !== 'Draft') {
        showToast('This PPMP was submitted or approved in the meantime, so it can no longer be changed.');
        closeRequestModal();
        if (typeof refreshDashboardRecords === 'function') refreshDashboardRecords();
        return;
    }

    // Everything specific to this one procurement project — as opposed to
    // the PPMP header info (ppmp_no, fiscal year, end-user, indicative/final)
    // that's shared by every item under the same PPMP.
    const itemPayload = {
        id:
            (existingRecord && currentEditingItemId) ? currentEditingItemId : Date.now(),

        project_description:
            document.getElementById(
                'project_description'
            ).value,

        project_type:
            document.getElementById(
                'project_type'
            ).value,

        mode:
            document.getElementById(
                'modeOfProcurement'
            ).value,

        pre_procurement:
            document.getElementById(
                'pre_procurement'
            ).value,

        bid_evaluation_criteria:
            document.getElementById(
                'bid_evaluation_criteria')
                ? document.getElementById(
                    'bid_evaluation_criteria'
                ).value : '',

        quantity_size:
            document.getElementById(
                'quantity_size'
            ).value,

        start_date:
            document.getElementById(
                'start_date'
            ).value,

        end_date:
            document.getElementById(
                'end_date'
            ).value,

        delivery_period:
            document.getElementById(
                'delivery_period'
            ).value,

        fund_source:
            document.getElementById(
                'fund_source'
            ).value,

        budget:
            document.getElementById(
                'budget'
            ).value,

        strategies:
            [...selectedStrategies],

        remarks:
            document.getElementById(
                'remarks'
            ).value,

        general_requirements:
            document.getElementById('general_requirements')
                ? document.getElementById('general_requirements').value.trim()
                : '',

        supporting_documents:
            uploadedFiles.map(buildSavedDocFromEntry)
    };

    let entry;
    let isNewItem = false;

    if (existingRecord) {
        // Updating the PPMP header, plus either replacing one existing
        // item or appending a brand-new one onto the same record — this
        // is what keeps "Add another entry" from creating a second row
        // in Entries.
        const items = (typeof getRecordItems === 'function' ? getRecordItems(existingRecord) : [existingRecord]).slice();

        if (currentEditingItemId) {
            const idx = items.findIndex(it => it.id == currentEditingItemId);
            if (idx !== -1) {
                items[idx] = itemPayload;
            } else {
                items.push(itemPayload);
                isNewItem = true;
            }
        } else {
            items.push(itemPayload);
            isNewItem = true;
        }

    entry = Object.assign({}, existingRecord, {
        ppmp_no:       document.getElementById('ppmp_no').value || existingRecord.ppmp_no || 'N/A',
        is_indicative: document.getElementById('is_indicative').value || existingRecord.is_indicative,
        end_user:      document.getElementById('end_user').value || existingRecord.end_user || 'N/A',
        fiscal_year:   document.getElementById('fiscal_year').value || existingRecord.fiscal_year,
        items:         items
});
    } else {
        // Define the timestamp ID for the new PPMP
        const stamp = Date.now();

        const session = typeof getSession === 'function' ? getSession() : null;
        const office = document.getElementById('end_user').value || (session ? session.office : 'N/A');
        const fiscalYear = document.getElementById('fiscal_year').value;
        const ppmpNo = document.getElementById('ppmp_no').value || 'N/A';

        // ----------------------------------------------------
        // VERSION CARRY-OVER LOGIC:
        // Carry over all approved items from the previous version of this year
        // ----------------------------------------------------
        const prevApproved = getLatestApprovedPpmpForOffice(office, fiscalYear);
        let versionItems = [];
        let carriedCount = 0;

        if (prevApproved) {
            versionItems = clonePpmpItemsForCarryOver(prevApproved, stamp);
            carriedCount = versionItems.length;
        }

        // Add the new line item created in this submission
        versionItems.push(itemPayload);

        // Brand-new PPMP (Version 1 or subsequent Version N)
        entry = {
            id: stamp,
            creatorId: session ? session.id : null,
            ppmp_no: ppmpNo,
            is_indicative: document.getElementById('is_indicative').value,
            end_user: office,
            fiscal_year: fiscalYear,
            items: versionItems,
            status: 'Draft',
            currentApproverRole: null,
            remarksHistory: [],
            date: new Date().toLocaleDateString()
        };
    }
    
    Object.assign(entry, resolveIndicative(entry.items, entry.is_indicative, indicativeManual));


    if (existingRecord) {
        const idx = db.findIndex(r => r.id == currentEditingId);
        if (idx !== -1) {
            db[idx] = entry;
        } else {
            db.push(entry);
        }
    } else {
        db.push(entry);
    }


    try {

        localStorage.setItem(
            'procurement_records',
            JSON.stringify(db)
        );

        // No alert, no page navigation — this is already the dashboard.
        // Close the modal and refresh the dashboard's own stats/activity
        // (renderStats/renderActivity/getRecords live in dashboard-logic.js,
        // loaded on the same page).
        closeRequestModal();

        if (typeof refreshDashboardRecords === 'function') {
            refreshDashboardRecords();
        }

        showToast(
            existingRecord
                ? (isNewItem
                    ? `New item added under PPMP No. ${entry.ppmp_no}.`
                    : `Request "PPMP No. ${entry.ppmp_no}" was updated successfully.`)
                : (typeof carriedCount !== 'undefined' && carriedCount > 0 && prevApproved
                    ? `PPMP No. ${entry.ppmp_no} (Version ${entry.ppmp_no}) created with ${entry.items.length} items (${carriedCount} carried over from PPMP No. ${prevApproved.ppmp_no}).`
                    : `Request "PPMP No. ${entry.ppmp_no}" was saved successfully.`)
        );

    } catch (err) {

        showFieldError(
            'supporting_docs',
            'This request could not be saved because the attached files are too large for browser storage. Please remove or shrink an attachment and try again.'
        );
    }
}

// ============================================================
// Approval
// ============================================================

// --- ADDITION: WORKFLOW STEERING FUNCTION ---
// ============================================================
// REQUIRED FIELD CHECK
// ============================================================

function isFieldFilled(fieldGroup) {

    const fieldName =
        fieldGroup.dataset.field;


    // Procurement strategies
    if (
        fieldName ===
        'procurement_strategies'
    ) {

        return selectedStrategies.length > 0;
    }


    // Supporting documents
    if (
        fieldName ===
        'supporting_docs'
    ) {

        return (
            uploadedFiles &&
            uploadedFiles.length > 0
        );
    }


    // Select fields
    const select =
        fieldGroup.querySelector(
            'select'
        );

    if (select) {

        return (
            select.value !== '' &&
            select.value !== null
        );
    }


    // Input / textarea
    const input =
        fieldGroup.querySelector(
            'input, textarea'
        );

    if (input) {

        return (
            input.value.trim() !== ''
        );
    }


    return true;
}


// ============================================================
// FIELD-SPECIFIC VALIDATION
// ============================================================

function validateIndividualField(fieldGroup) {

    const fieldName =
        fieldGroup.dataset.field;


    // --------------------------------------------------------
    // Optional fields: never required, nothing else to check
    // --------------------------------------------------------

    if (fieldName === 'general_requirements') {

        clearFieldError(fieldName);

        return true;
    }


    // --------------------------------------------------------
    // Required check
    // --------------------------------------------------------

    if (!isFieldFilled(fieldGroup)) {

        let message =
            'This field is required.';


        if (
            fieldName ===
            'procurement_strategies'
        ) {

            message =
                'Please select at least one procurement strategy.';
        }


        if (
            fieldName ===
            'supporting_docs'
        ) {

            message =
                'Please upload at least one supporting document.';
        }


        showFieldError(
            fieldName,
            message
        );

        return false;
    }


    // --------------------------------------------------------
    // Get input
    // --------------------------------------------------------

    const input =
        fieldGroup.querySelector(
            'input, textarea, select'
        );


    if (!input) {

        clearFieldError(fieldName);

        return true;
    }


    const value =
        input.value.trim();


    // --------------------------------------------------------
    // PPMP NUMBER
    // --------------------------------------------------------

    if (
        fieldName ===
        'ppmp_no'
    ) {

        if (!/^\d+$/.test(value)) {

            showFieldError(
                fieldName,
                'PPMP Number must contain numbers only.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // FISCAL YEAR
    // --------------------------------------------------------

    if (
        fieldName ===
        'fiscal_year'
    ) {

        if (!/^\d{4}$/.test(value)) {

            showFieldError(
                fieldName,
                'Fiscal Year must contain exactly 4 numbers.'
            );

            return false;
        }


        const year =
            parseInt(
                value,
                10
            );


        if (
            year < 2000 ||
            year > 2100
        ) {

            showFieldError(
                fieldName,
                'Fiscal Year must be between 2000 and 2100.'
            );

            return false;
        }

        // The APP for this year is already Final: it can't take new PPMPs.
        const closedYearMessage =
            getClosedFiscalYearMessage(value);

        if (closedYearMessage) {

            showFieldError(
                fieldName,
                closedYearMessage
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // END USER
    // --------------------------------------------------------

    if (
        fieldName ===
        'end_user'
    ) {

        if (value.length < 2) {

            showFieldError(
                fieldName,
                'End User must contain at least 2 characters.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // QUANTITY / SIZE
    // --------------------------------------------------------

    if (
        fieldName ===
        'quantity_size'
    ) {

        if (value.length < 3) {

            showFieldError(
                fieldName,
                'Please provide a more detailed quantity or size.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // FUND SOURCE
    // --------------------------------------------------------

    if (
        fieldName ===
        'fund_source'
    ) {

        if (value.length < 2) {

            showFieldError(
                fieldName,
                'Please provide a valid fund source.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // REMARKS
    // --------------------------------------------------------

    if (
        fieldName ===
        'remarks'
    ) {

        if (value.length < 3) {

            showFieldError(
                fieldName,
                'Remarks must contain at least 3 characters.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // BUDGET
    // --------------------------------------------------------

    if (
        fieldName ===
        'budget'
    ) {

        const numericValue =
            parseFloat(
                value.replace(/,/g, '')
            );


        if (
            isNaN(numericValue)
        ) {

            showFieldError(
                fieldName,
                'Budget must contain a valid number.'
            );

            return false;
        }


        if (
            numericValue <= 0
        ) {

            showFieldError(
                fieldName,
                'Budget must be greater than 0.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // Delivery period
    // --------------------------------------------------------

    if (
        fieldName ===
        'delivery_period'
    ) {

        if (value.length < 1) {

            showFieldError(
                fieldName,
                'Please specify the delivery period.'
            );

            return false;
        }
    }


    // --------------------------------------------------------
    // Everything passed
    // --------------------------------------------------------

    clearFieldError(fieldName);

    return true;
}

// ============================================================
// DYNAMIC N/A OPTIONS INJECTION
// Ensures "N/A" is available in Criteria and Strategies even if missing in HTML
// ============================================================

function ensureCriteriaNaOption() {
    const select = document.getElementById('bid_evaluation_criteria');
    if (!select) return;
    const exists = Array.from(select.options).some(opt => opt.value === 'N/A');
    if (!exists) {
        const opt = document.createElement('option');
        opt.value = 'N/A';
        opt.textContent = 'N/A';
        select.appendChild(opt);
    }
}

function ensureStrategyNaOption() {
    const menu = document.getElementById('strategiesMenu');
    if (!menu) return;
    const options = Array.from(menu.querySelectorAll('.option'));
    const hasNa = options.some(opt => opt.textContent.trim() === 'N/A');
    if (!hasNa) {
        const naDiv = document.createElement('div');
        naDiv.className = 'option';
        naDiv.textContent = 'N/A';
        menu.appendChild(naDiv);
    }
}

// ============================================================
// LIVE MODE VS. PROJECT TYPE & GENERAL DESCRIPTION VALIDATION
// Runs on Step 1 without waiting for Budget
// ============================================================

function validateModeTypeMatch() {
    const modeSelect = document.getElementById('modeOfProcurement');
    const typeSelect = document.getElementById('project_type');
    const descInput = document.getElementById('project_description');

    if (!modeSelect) return true;
    const modeValue = modeSelect.value.trim();
    if (!modeValue) {
        clearFieldError('modeOfProcurement');
        return true;
    }

    const projectType = typeSelect ? typeSelect.value.trim() : '';
    const description = descInput ? descInput.value.trim().toLowerCase() : '';

    const rule = (typeof PROCUREMENT_MODE_RULES !== 'undefined') ? PROCUREMENT_MODE_RULES[modeValue] : null;

    // 1. Check selected Project Type (Shopping and Repeat Order are restricted to Goods)
    if (rule && rule.allowedTypes && projectType) {
        if (!rule.allowedTypes.includes(projectType)) {
            const typeMsg = `"${modeValue}" under ${rule.legalBasis} is restricted to ${rule.allowedTypes.join(' / ')}. It cannot be used for "${projectType}".`;
            showFieldError('modeOfProcurement', typeMsg);
            return false;
        }
    }

    // 2. Check General Description for non-goods indicators when Shopping / Repeat Order is selected
    if (modeValue === 'Shopping' || modeValue === 'Repeat Order') {
        const nonGoodsKeywords = [
            'consulting', 'consultant', 'consultancy', 'civil work',
            'construction', 'renovation', 'repair of building',
            'infrastructure', 'architectural', 'engineering design'
        ];
        const matched = nonGoodsKeywords.find(kw => description.includes(kw));
        if (matched) {
            const descMsg = `"${modeValue}" under RA 12009 is strictly for Goods (ordinary office supplies and off-the-shelf items). The General Description specifies non-goods ("${matched}").`;
            showFieldError('modeOfProcurement', descMsg);
            return false;
        }
    }

    clearFieldError('modeOfProcurement');
    return true;
}

// Cross-checks both Type/Description and Budget Thresholds
function validateModeBudgetMatch() {
    // 1. Run live type/description check first
    if (!validateModeTypeMatch()) {
        return false;
    }

    // 2. Run budget ceiling check if budget is entered
    const modeSelect = document.getElementById('modeOfProcurement');
    const budgetInput = document.getElementById('budget');
    if (!modeSelect || !budgetInput) return true;

    const modeValue = modeSelect.value.trim();
    const budgetRaw = budgetInput.value.trim();
    if (!modeValue || !budgetRaw) return true;

    const budgetNumber = parseFloat(budgetRaw.replace(/,/g, ''));
    if (isNaN(budgetNumber) || budgetNumber <= 0) return true;

    const rule = (typeof PROCUREMENT_MODE_RULES !== 'undefined') ? PROCUREMENT_MODE_RULES[modeValue] : null;
    if (rule && budgetNumber > rule.maxBudget) {
        let ceilingMsg = '';
        if (modeValue === 'Direct Acquisition') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱200,000.00 ceiling for Direct Acquisition under RA 12009 Sec. 32. Please use SVP or Competitive Bidding.`;
        } else if (modeValue === 'Small Value Procurement (SVP)') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱2,000,000.00 ceiling for SVP under RA 12009 Sec. 31. Requires Competitive Bidding.`;
        } else if (modeValue === 'Shopping') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱2,000,000.00 ceiling for Shopping under RA 12009 Sec. 30.`;
        } else {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the allowable threshold of ${formatPesoMessage(rule.maxBudget)} for ${modeValue}.`;
        }

        showFieldError('modeOfProcurement', ceilingMsg);
        showFieldError('budget', ceilingMsg);
        return false;
    }

    clearFieldError('modeOfProcurement');
    clearFieldError('budget');
    return true;
}

// ============================================================
// RECOMMENDED MODE OF PROCUREMENT (BUDGET-BASED)
// ============================================================

const PROCUREMENT_MODE_RULES = {
    'Direct Acquisition': {
        mode: 'Direct Acquisition',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: 200000, // RA 12009 Section 32 ceiling for NGAs
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 32',
        bracketLabel: '₱0 – ₱200,000'
    },
    'Small Value Procurement (SVP)': {
        mode: 'Small Value Procurement (SVP)',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: 2000000, // RA 12009 Section 31 ceiling for NGAs
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 31',
        bracketLabel: '₱200,001 – ₱2,000,000'
    },
    'Shopping': {
        mode: 'Shopping',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: 2000000, // RA 12009 Section 30 ceiling for NGAs
        allowedTypes: ['Goods'], // Goods ONLY
        legalBasis: 'RA 12009 Sec. 30',
        bracketLabel: '₱0 – ₱2,000,000 (Goods only)'
    },
    'Competitive Bidding': {
        mode: 'Competitive Bidding',
        category: 'Competitive Mode',
        minBudget: 0.01,
        maxBudget: Infinity, // Primary mode, allowed for any budget amount
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 15',
        bracketLabel: '₱2,000,000 and above (or any amount)'
    },
    'Repeat Order': {
        mode: 'Repeat Order',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: Infinity,
        allowedTypes: ['Goods'], // Goods ONLY
        legalBasis: 'RA 12009 Sec. 29',
        bracketLabel: 'Up to 25% of original contract (Goods only)'
    },
    'Direct Contracting': {
        mode: 'Direct Contracting',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: Infinity,
        allowedTypes: ['Goods', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 28',
        bracketLabel: 'Proprietary / Exclusive Source'
    },
    'Limited Source Bidding': {
        mode: 'Limited Source Bidding',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: Infinity,
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 25',
        bracketLabel: 'Specialized goods / complex infrastructure'
    },
    'Competitive Dialogue': {
        mode: 'Competitive Dialogue',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: Infinity,
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 26',
        bracketLabel: 'Complex or innovative procurement'
    },
    'Negotiated Procurement': {
        mode: 'Negotiated Procurement',
        category: 'Alternative Mode',
        minBudget: 0.01,
        maxBudget: Infinity,
        allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
        legalBasis: 'RA 12009 Sec. 33',
        bracketLabel: 'Authorized statutory grounds'
    }
};

const MODE_BUDGET_BRACKETS = [
    { max: 200000, mode: 'Direct Acquisition', label: '₱0 – ₱200,000' },
    { max: 2000000, mode: 'Small Value Procurement (SVP)', label: '₱200,001 – ₱2,000,000' },
    { max: Infinity, mode: 'Competitive Bidding', label: '₱2,000,000 and above' }
];


function getRecommendedMode(budgetNumber) {
    const bracket = MODE_BUDGET_BRACKETS.find(tier => budgetNumber <= tier.max);
    return bracket || MODE_BUDGET_BRACKETS[MODE_BUDGET_BRACKETS.length - 1];
}


// Named differently from formatPesoExact() in dashboard-logic.js, which formats
// table/preview totals ('P 1,234.50'). This one is only for the validation message.
function formatPesoMessage(amount) {
    return '₱' + Number(amount).toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}


// Cross-checks the selected Mode of Procurement (Step 1) against the
// Estimated Budget (Step 2). Only runs once BOTH fields have a value —
// each field's own required/format validation is left to handle empties
// and malformed input. Returns true when there's nothing to block on.
function validateModeBudgetMatch() {
    const modeSelect = document.getElementById('modeOfProcurement');
    const budgetInput = document.getElementById('budget');
    const typeSelect = document.getElementById('project_type');

    if (!modeSelect || !budgetInput) return true;

    const modeValue = modeSelect.value.trim();
    const budgetRaw = budgetInput.value.trim();
    const projectType = typeSelect ? typeSelect.value.trim() : '';

    if (!modeValue || !budgetRaw) return true;

    const budgetNumber = parseFloat(budgetRaw.replace(/,/g, ''));
    if (isNaN(budgetNumber) || budgetNumber <= 0) return true;

    const rule = PROCUREMENT_MODE_RULES[modeValue];
    if (!rule) {
        clearFieldError('modeOfProcurement');
        clearFieldError('budget');
        return true;
    }

    // 1. Project Type Rule Check (e.g., Shopping and Repeat Order are for Goods only)
    if (projectType && rule.allowedTypes && !rule.allowedTypes.includes(projectType)) {
        const typeMsg = `"${modeValue}" under ${rule.legalBasis} is restricted to ${rule.allowedTypes.join(' / ')}. It cannot be used for "${projectType}" (IRR of RA 12009 Sec 7.7.2 (d)).`;
        showFieldError('modeOfProcurement', typeMsg);
        return false;
    }

    // 2. Budget Maximum Threshold Ceiling Check
    if (budgetNumber > rule.maxBudget) {
        let ceilingMsg = '';
        if (modeValue === 'Direct Acquisition') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱200,000.00 ceiling for Direct Acquisition under RA 12009 Sec. 32. Please use Small Value Procurement (SVP) or Competitive Bidding.`;
        } else if (modeValue === 'Small Value Procurement (SVP)') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱2,000,000.00 ceiling for Small Value Procurement (SVP) under RA 12009 Sec. 31. Projects exceeding ₱2,000,000.00 require Competitive Bidding (or an authorized alternative mode).`;
        } else if (modeValue === 'Shopping') {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the ₱2,000,000.00 ceiling for Shopping under RA 12009 Sec. 30.`;
        } else {
            ceilingMsg = `Estimated budget of ${formatPesoMessage(budgetNumber)} exceeds the maximum allowable threshold of ${formatPesoMessage(rule.maxBudget)} for ${modeValue}.`;
        }

        showFieldError('modeOfProcurement', ceilingMsg);
        showFieldError('budget', ceilingMsg);
        return false;
    }

    clearFieldError('modeOfProcurement');
    clearFieldError('budget');
    return true;
}



// ============================================================
// DATE VALIDATION
// ============================================================

function validateDates(container) {

    const startGroup = getFieldGroup('start_date');
    const endGroup = getFieldGroup('end_date');
    const deliveryGroup = getFieldGroup('delivery_period');

    if (!startGroup || !endGroup || !deliveryGroup) {
        return true;
    }

    const startInput = startGroup.querySelector('input');
    const endInput = endGroup.querySelector('input');
    const deliveryInput = deliveryGroup.querySelector('input');

    if (!startInput || !endInput || !deliveryInput) {
        return true;
    }

    const startDate = startInput.value;
    const endDate = endInput.value;
    const deliveryDate = deliveryInput.value;

    let valid = true;

    // Start date check
    if (!startDate) {
        showFieldError('start_date', 'Please select a start date.');
        valid = false;
    } else {
        clearFieldError('start_date');
    }

    // End date check
    if (!endDate) {
        showFieldError('end_date', 'Please select an end date.');
        valid = false;
    } else {
        clearFieldError('end_date');
    }

    // Delivery period check
    if (!deliveryDate) {
        showFieldError('delivery_period', 'Please specify the expected delivery/implementation period.');
        valid = false;
    } else {
        clearFieldError('delivery_period');
    }

    // Compare Start Date vs. End Date
    if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);

        if (end < start) {
            showFieldError('end_date', 'End date cannot be earlier than the start date.');
            valid = false;
        }
    }

    // Compare End Date vs. Expected Delivery Period
    if (endDate && deliveryDate) {
        const end = new Date(endDate);
        const delivery = new Date(deliveryDate);

        if (delivery <= end) {
            showFieldError(
                'delivery_period',
                'Expected delivery/implementation period cannot be on or before the end of procurement activity.'
            );
            valid = false;
        }
    }

    return valid;
}


// ============================================================
// STEP VALIDATION
// ============================================================

function validateStep(containerId) {

    // Do not validate while viewing
    if (isViewMode) {
        return true;
    }


    const container =
        document.getElementById(
            containerId
        );


    if (!container) {
        return true;
    }


    let allValid = true;


    const fieldGroups =
        container.querySelectorAll(
            '.field-group[data-field]'
        );


    fieldGroups.forEach(
        fieldGroup => {

            const fieldValid =
                validateIndividualField(
                    fieldGroup
                );


            if (!fieldValid) {
                allValid = false;
            }
        }
    );


    // Date validation for Step 2
    if (
        containerId ===
        'form-step-2'
    ) {

        if (!validateDates(container)) {
            allValid = false;
        }
    }


    // Mode of Procurement vs. Budget cross-check.
    // Relevant whenever either field's step is being validated, since a
    // mismatch can be introduced by editing either one after the other
    // was already filled in.
    if (
        containerId === 'form-step-1' ||
        containerId === 'form-step-2'
    ) {

        if (!validateModeBudgetMatch()) {
            allValid = false;
        }
    }


    return allValid;
}

function validateDeliveryDateMatch() {
    const endGroup = getFieldGroup('end_date');
    const deliveryGroup = getFieldGroup('delivery_period');

    if (!endGroup || !deliveryGroup) return true;

    const endInput = endGroup.querySelector('input');
    const deliveryInput = deliveryGroup.querySelector('input');

    if (!endInput || !deliveryInput) return true;

    const endDate = endInput.value;
    const deliveryDate = deliveryInput.value;

    // Only compare when both dates have been selected
    if (!endDate || !deliveryDate) return true;

    const end = new Date(endDate);
    const delivery = new Date(deliveryDate);

    if (delivery <= end) {
        showFieldError(
            'delivery_period',
            'Expected delivery/implementation period cannot be on or before the end of procurement activity.'
        );
        return false;
    }

    clearFieldError('delivery_period');
    return true;
}

// ============================================================
// VALIDATE AND PROCEED
// ============================================================

function validateAndProceed(
    stepNumber,
    nextFn
) {

    const containerId =
        'form-step-' +
        stepNumber;


    const valid =
        validateStep(
            containerId
        );


    if (valid) {

        if (
            typeof nextFn ===
            'function'
        ) {

            nextFn();
        }

        return;
    }


    // Find first error
    const container =
        document.getElementById(
            containerId
        );


    if (!container) return;


    const firstError =
        container.querySelector(
            '.field-group.error-state'
        );


    if (firstError) {

        firstError.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }
}


// ============================================================
// LIVE REQUIRED FIELD VALIDATION
// ============================================================

function initRequiredFieldValidation() {

    // Input event
    document.addEventListener(
        'input',
        function (event) {

            const group =
                event.target.closest(
                    '.field-group[data-field]'
                );


            if (!group) return;


            const fieldName =
                group.dataset.field;


            // Don't clear errors blindly.
            // Re-check the field so specific errors remain.
            const fieldValid =
                validateIndividualField(
                    group
                );


            // Only re-run the cross-check once the field's own
            // validation is satisfied, so a mismatch message doesn't
            // override a more fundamental "required"/format error.
            if (
                fieldValid &&
                (
                    fieldName === 'modeOfProcurement' ||
                    fieldName === 'project_type' ||
                    fieldName === 'project_description' ||
                    fieldName === 'budget'
                )
            ) {
                validateModeTypeMatch();
                validateModeBudgetMatch();
            }
            if (fieldValid && (fieldName === 'end_date' || fieldName === 'delivery_period')) {
            validateDeliveryDateMatch();
            }
        }
    );


    // Change event
    document.addEventListener(
        'change',
        function (event) {

            const group =
                event.target.closest(
                    '.field-group[data-field]'
                );


            if (!group) return;


            const fieldName =
                group.dataset.field;


            const fieldValid =
                validateIndividualField(
                    group
                );


            if (
                fieldValid &&
                (
                    fieldName === 'modeOfProcurement' ||
                    fieldName === 'budget'
                )
            ) {

                validateModeBudgetMatch();
            }
            if (fieldValid && (fieldName === 'end_date' || fieldName === 'delivery_period')) {
                validateDeliveryDateMatch();
            }
        }
    );
}


// ============================================================
// MODE OF PROCUREMENT ERROR HANDLING
// ============================================================

function initializeModeValidation() {

    const modeSelect =
        document.getElementById(
            'modeOfProcurement'
        );


    if (!modeSelect) return;


    modeSelect.onchange =
        function () {

            if (
                this.value !== ''
            ) {

                const wrapper =
                    document.getElementById(
                        'modeWrapper'
                    );

                if (wrapper) {

                    wrapper.classList.remove(
                        'error-state'
                    );
                }


                const errorMessage =
                    document.getElementById(
                        'modeErrorMsg'
                    );

                if (errorMessage) {

                    errorMessage.classList.add(
                        'hidden'
                    );
                }


                clearFieldError(
                    'modeOfProcurement'
                );
            }
        };
}


// ============================================================
// FILE SIZE FORMATTING
// ============================================================

function formatFileSize(bytes) {

    if (
        bytes <
        1024
    ) {

        return bytes +
            ' B';
    }


    if (
        bytes <
        1024 * 1024
    ) {

        return (
            bytes / 1024
        ).toFixed(1) +
            ' KB';
    }


    if (
        bytes <
        1024 * 1024 * 1024
    ) {

        return (
            bytes /
            (1024 * 1024)
        ).toFixed(1) +
            ' MB';
    }


    return (
        bytes /
        (1024 * 1024 * 1024)
    ).toFixed(2) +
        ' GB';
}


// ============================================================
// TOTAL UPLOAD SIZE
// ============================================================

function getTotalUploadedSize() {

    return uploadedFiles.reduce(
        (
            total,
            entry
        ) =>
            total +
            entry.file.size,
        0
    );
}


// ============================================================
// RENDER UPLOADED FILES
// ============================================================

function renderUploadedFiles() {

    const listEl =
        document.getElementById(
            'uploadedFileList'
        );


    if (!listEl) return;


    listEl.innerHTML = '';


    uploadedFiles.forEach(
        entry => {

            const li =
                document.createElement(
                    'li'
                );


            li.className =
                'uploaded-file-item';


            li.dataset.uploadId =
                entry.id;


            // File information
            const info =
                document.createElement(
                    'div'
                );


            info.className =
                'uploaded-file-info';


            // File link
            const link =
                document.createElement(
                    'a'
                );


            link.className =
                'uploaded-file-name';


            link.textContent =
                entry.file.name;


            link.title =
                'Click to view ' +
                entry.file.name;


            link.href =
                entry.objectUrl ||
                '#';


            link.target =
                '_blank';


            link.rel =
                'noopener noreferrer';


            // File size
            const size =
                document.createElement(
                    'span'
                );


            size.className =
                'uploaded-file-size';


            size.textContent =
                formatFileSize(
                    entry.file.size
                );


            info.appendChild(
                link
            );


            info.appendChild(
                size
            );


            // Remove button
            const removeBtn =
                document.createElement(
                    'button'
                );


            removeBtn.type =
                'button';


            removeBtn.className =
                'uploaded-file-remove';


            removeBtn.textContent =
                'Remove';


            removeBtn.onclick =
                function () {

                    removeUploadedFile(
                        entry.id
                    );
                };


            li.appendChild(
                info
            );


            li.appendChild(
                removeBtn
            );


            listEl.appendChild(
                li
            );
        }
    );


    updateUploadFieldState();
}


// ============================================================
// UPLOAD FIELD STATE
// ============================================================

function updateUploadFieldState() {

    const zone =
        document.getElementById(
            'uploadZone'
        );


    if (!zone) return;


    const group =
        zone.closest(
            '.field-group[data-field]'
        );


    if (
        uploadedFiles.length > 0
    ) {

        zone.classList.add(
            'has-file'
        );


        if (group) {

            group.classList.remove(
                'error-state'
            );
        }


        clearFieldError(
            'supporting_docs'
        );

    } else {

        zone.classList.remove(
            'has-file'
        );
    }
}


// ============================================================
// ADD FILES
// ============================================================

function addFiles(fileList) {

    Array.from(fileList)
        .forEach(file => {


            // ------------------------------------------------
            // Per-file size
            // ------------------------------------------------

            if (
                file.size >
                MAX_FILE_SIZE
            ) {

                showFieldError(
                    'supporting_docs',
                    `"${file.name}" is ${formatFileSize(file.size)}, which is over the ${formatFileSize(MAX_FILE_SIZE)} per-file limit. Please attach a smaller file.`
                );

                return;
            }


            // ------------------------------------------------
            // Total size
            // ------------------------------------------------

            if (
                getTotalUploadedSize() +
                file.size >
                MAX_TOTAL_SIZE
            ) {

                showFieldError(
                    'supporting_docs',
                    `Adding "${file.name}" would exceed the ${formatFileSize(MAX_TOTAL_SIZE)} total attachment limit for this request.`
                );

                return;
            }


            // ------------------------------------------------
            // Create upload entry
            // ------------------------------------------------

            const id =
                ++uploadIdCounter;


            const objectUrl =
                URL.createObjectURL(
                    file
                );


            const entry = {

                file,

                id,

                objectUrl,

                // The bytes go to IndexedDB (file-store.js); the saved record
                // only keeps this id. `pending` blocks saving until it is stored.
                fileId: FileStore.newId(),

                isNew: true,

                pending: true
            };


            uploadedFiles.push(
                entry
            );


            renderUploadedFiles();


            FileStore.put(entry.fileId, file)
                .then(function () {

                    entry.pending = false;
                })
                .catch(function () {

                    entry.pending = false;

                    uploadedFiles =
                        uploadedFiles.filter(
                            item =>
                                item !== entry
                        );

                    if (entry.objectUrl) {
                        URL.revokeObjectURL(entry.objectUrl);
                    }

                    renderUploadedFiles();

                    showFieldError(
                        'supporting_docs',
                        `The file "${file.name}" could not be stored in this browser (storage may be full). Please free up space or try a smaller file.`
                    );
                });
        });
}


// ============================================================
// REMOVE UPLOADED FILE
// ============================================================

function removeUploadedFile(id) {

    const entry =
        uploadedFiles.find(
            item =>
                item.id === id
        );


    if (
        entry &&
        entry.objectUrl
    ) {

        URL.revokeObjectURL(
            entry.objectUrl
        );
    }


    // A file added in this session and never saved can be deleted right away.
    if (
        entry &&
        entry.isNew &&
        entry.fileId &&
        typeof FileStore !== 'undefined'
    ) {

        FileStore.remove(
            entry.fileId
        );
    }


    uploadedFiles =
        uploadedFiles.filter(
            item =>
                item.id !== id
        );


    renderUploadedFiles();


    if (
        uploadedFiles.length === 0
    ) {

        showFieldError(
            'supporting_docs',
            'Please upload at least one supporting document.'
        );
    }
}


// ============================================================
// BASE64 DATA URL → BLOB URL
// ============================================================

function base64DataUrlToObjectUrl(
    dataUrl
) {

    try {

        const [
            header,
            base64
        ] =
            dataUrl.split(',');


        const mimeMatch =
            header.match(
                /data:(.*?);base64/
            );


        const mime =
            mimeMatch
                ? mimeMatch[1]
                : 'application/octet-stream';


        const byteString =
            atob(base64);


        const bytes =
            new Uint8Array(
                byteString.length
            );


        for (
            let i = 0;
            i < byteString.length;
            i++
        ) {

            bytes[i] =
                byteString.charCodeAt(i);
        }


        return URL.createObjectURL(
            new Blob(
                [bytes],
                {
                    type: mime
                }
            )
        );

    } catch (err) {

        return null;
    }
}


// ============================================================
// FILE UPLOAD INITIALIZATION
// ============================================================

function initFileUpload() {

    const uploadZoneEl =
        document.getElementById(
            'uploadZone'
        );


    const fileInputEl =
        document.getElementById(
            'fileInput'
        );


    const uploadLinkEl =
        document.getElementById(
            'uploadLink'
        );


    if (
        !uploadZoneEl ||
        !fileInputEl
    ) {
        return;
    }


    // --------------------------------------------------------
    // Click upload zone
    // --------------------------------------------------------

    uploadZoneEl.addEventListener(
        'click',
        function () {

            if (isViewMode) return;

            fileInputEl.click();
        }
    );


    // --------------------------------------------------------
    // Upload link
    // --------------------------------------------------------

    if (uploadLinkEl) {

        uploadLinkEl.addEventListener(
            'click',
            function (event) {

                event.stopPropagation();

                if (isViewMode) return;

                fileInputEl.click();
            }
        );
    }


    // --------------------------------------------------------
    // File input change
    // --------------------------------------------------------

    fileInputEl.addEventListener(
        'change',
        function (event) {

            if (
                event.target.files &&
                event.target.files.length
            ) {

                addFiles(
                    event.target.files
                );
            }


            // Reset input so same file can
            // be selected again if necessary
            fileInputEl.value = '';
        }
    );


    // --------------------------------------------------------
    // Drag enter / drag over
    // --------------------------------------------------------

    [
        'dragenter',
        'dragover'
    ].forEach(
        eventName => {

            uploadZoneEl.addEventListener(
                eventName,
                function (event) {

                    if (isViewMode) return;

                    event.preventDefault();
                    event.stopPropagation();

                    uploadZoneEl.classList.add(
                        'drag-over'
                    );
                }
            );
        }
    );


    // --------------------------------------------------------
    // Drag leave
    // --------------------------------------------------------

    [
        'dragleave',
        'dragend'
    ].forEach(
        eventName => {

            uploadZoneEl.addEventListener(
                eventName,
                function (event) {

                    event.preventDefault();
                    event.stopPropagation();

                    uploadZoneEl.classList.remove(
                        'drag-over'
                    );
                }
            );
        }
    );


    // --------------------------------------------------------
    // Drop
    // --------------------------------------------------------

    uploadZoneEl.addEventListener(
        'drop',
        function (event) {

            if (isViewMode) return;

            event.preventDefault();
            event.stopPropagation();

            uploadZoneEl.classList.remove(
                'drag-over'
            );


            if (
                event.dataTransfer.files &&
                event.dataTransfer.files.length
            ) {

                addFiles(
                    event.dataTransfer.files
                );
            }
        }
    );
}


// ============================================================
// MODAL CONTROLS
// ============================================================

function resetRequestForm() {
    if (typeof hideReviewRemarks === 'function') hideReviewRemarks();

    // Clear which item (if any) we were viewing/editing within a PPMP —
    // a fresh form always starts as "brand-new PPMP, first item".
    currentEditingItemId = null;
    currentItemIndex = 0;
    hideItemNavigator();

    // Clear every text/select/textarea value in the modal
    document
        .querySelectorAll(
            '#requestModalOverlay input, #requestModalOverlay select, #requestModalOverlay textarea'
        )
        .forEach(field => {

            if (field.id === 'ppmp_no' || field.id === 'fiscal_year') return; // regenerated below

            field.value = '';
        });
           
   indicativeManual = false;
   const indSel = document.getElementById('is_indicative');
   if (indSel) indSel.value = 'Indicative';   // automatic default; Step 3 can flip it to Final
   renderIndicativeHint();


    // Reset strategies + uploads
    selectedStrategies = [];
    uploadedFiles = [];
    uploadIdCounter = 0;

    renderTags(
        document.getElementById('selectedTags')
    );

    if (typeof renderUploadedFiles === 'function') {
        renderUploadedFiles();
    }

    if (typeof updateUploadFieldState === 'function') {
        updateUploadFieldState();
    }

    const uploadZone =
        document.getElementById('uploadZone');

    if (uploadZone) {
        uploadZone.classList.remove('has-file');
        uploadZone.style.pointerEvents = '';
    }


    // Clear any leftover validation state
    clearAllFieldErrors();

    updateDocTypeHint();


    // Back to Step 1
    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-1').classList.remove('hidden');

    document.getElementById('page-title').innerText =
        'PROCUREMENT PROJECT DETAILS';

    document.getElementById('progress-fill').style.width = '15%';

    // Edit/Verify controls and the status badge are only ever shown once
    // a saved record is loaded in view mode, in loadRecordIntoModal()
    const editBtn = document.getElementById('editRequestBtn');
    if (editBtn) editBtn.classList.add('hidden');

    const verifyBtn = document.getElementById('verifyRequestBtn');
    if (verifyBtn) verifyBtn.classList.add('hidden');

    const deleteItemBtn = document.getElementById('deleteItemBtn');
    if (deleteItemBtn) deleteItemBtn.classList.add('hidden');

    const statusBadge = document.getElementById('modalStatusBadge');
    if (statusBadge) statusBadge.classList.add('hidden');
    hideApprovalInfo();

    const finishBtn = document.getElementById('finishBtn');
    if (finishBtn) {
        finishBtn.innerText = 'Finish →';
        finishBtn.onclick = saveProcurementRequest;
    }

    const pdfButtons = document.querySelectorAll('.pdf-btn-global');
    pdfButtons.forEach(btn => btn.style.display = 'none');

    // Fresh PPMP number for this new request
    initializePpmpNumber();
}


let currentEditingId = null; // Track if we are viewing/editing
let currentEditingItemId = null; // Which item within that PPMP is loaded (null = adding a new one)
let currentItemIndex = 0; // Which item the on-screen navigator is pointing at

function openRequestModal(id = null) {
    console.log("openRequestModal() opening with id:", id);

    const overlay = document.getElementById('requestModalOverlay');
    if (!overlay) {
        console.error("Critical: #requestModalOverlay element was not found in the HTML.");
        return;
    }

    // Run form reset safely
    try {
        resetRequestForm();
    } catch (err) {
        console.warn("resetRequestForm caught an issue (proceeding anyway):", err);
    }

    // Force display in case inline style or class is blocking it
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    if (id) {
        // VIEW MODE
        currentEditingId = id;
        if (typeof loadRecordIntoModal === 'function') {
            loadRecordIntoModal(id);
        }
    } else {
        // NEW REQUEST MODE
        currentEditingId = null;
        isViewMode = false;

        try { enableModalFields(); } catch (e) { console.warn(e); }
        try { initializePpmpNumber(); } catch (e) { console.warn(e); }
        try {
            const rolledYear = initializeFiscalYear();
            if (rolledYear && typeof showToast === 'function') {
                showToast('The APP for FY ' + (Number(rolledYear) - 1) + ' is Final, so this PPMP starts in FY ' + rolledYear + '.');
            }
        } catch (e) { console.warn(e); }

        const finishBtn = document.getElementById('finishBtn');
        if (finishBtn) {
            finishBtn.innerText = 'Finish →';
            finishBtn.onclick = saveProcurementRequest;
        }
    }
}


function addEntryToPpmp(ppmpNo, fiscalYear) {
    // 1. Reset form fields cleanly
    try {
        resetRequestForm();
    } catch (err) {
        console.warn("resetRequestForm issue:", err);
    }

    // The number belongs to the parent PPMP here, so it must not follow the
    // Fiscal Year field (resetRequestForm() switched that on).
    ppmpNumberFollowsYear = false;

    // 2. Make modal visible
    const overlay = document.getElementById('requestModalOverlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');
    overlay.style.display = 'flex'; // <-- FIX: Resets inline display so modal appears!
    document.body.style.overflow = 'hidden';

    // 3. Find the parent PPMP directly from localStorage.
    // PPMP numbers are only unique PER OFFICE (every office numbers its PPMPs
    // from 1), so the lookup must be limited to the signed-in office. Without
    // this, "PPMP No. 1" can resolve to ANOTHER office's PPMP: the form then
    // shows that office as End-User and the new entry is saved into its record.
    const lookupSession = typeof getSession === 'function' ? getSession() : null;
    const lookupOffice = lookupSession && lookupSession.office ? lookupSession.office : null;
    const allRecords = (JSON.parse(localStorage.getItem('procurement_records')) || [])
        .filter(r => !lookupOffice || r.end_user === lookupOffice);
    // PPMP numbers restart every fiscal year, so when the caller knows the
    // year, the lookup must match it too (e.g. No. 1 exists in 2026 AND 2027).
    const sameYear = r => !fiscalYear || String(r.fiscal_year) === String(fiscalYear);
    const groupRecord = allRecords.find(r => String(r.ppmp_no) === String(ppmpNo) && sameYear(r) && getPpmpStatus(r) === 'Draft')
        || allRecords.find(r => String(r.ppmp_no) === String(ppmpNo) && sameYear(r));

    currentEditingId = groupRecord ? groupRecord.id : null;
    currentEditingItemId = null; // null means saving will append a new item
    isViewMode = false;

    // 4. Enable fields
    try {
        enableModalFields();
    } catch (err) {
        console.warn("enableModalFields issue:", err);
    }

    // 5. Pre-fill and lock the header fields to the parent PPMP
    const ppmpField = document.getElementById('ppmp_no');
    if (ppmpField) {
        ppmpField.value = ppmpNo;
        ppmpField.readOnly = true;
    }

    const fiscalYearField = document.getElementById('fiscal_year');
    if (fiscalYearField) {
        // Adding an entry to an existing PPMP: the year is fixed by the parent PPMP.
        fiscalYearField.value = (groupRecord && groupRecord.fiscal_year) || '';
        fiscalYearField.readOnly = !!(groupRecord && groupRecord.fiscal_year);
        fiscalYearField.style.backgroundColor = '';
        fiscalYearField.style.cursor = '';
    }

    const endUserField = document.getElementById('end_user');
    if (endUserField) {
        const session = typeof getSession === 'function' ? getSession() : null;
        endUserField.value = (groupRecord && groupRecord.end_user) || (session ? session.office : '');
        endUserField.readOnly = true;
    }

       const indicativeField = document.getElementById('is_indicative');
   if (indicativeField) {
       indicativeField.value = (groupRecord && groupRecord.is_indicative) || 'Indicative';
       indicativeManual = !!groupRecord && (groupRecord.indicative_mode || 'manual') === 'manual';
       renderIndicativeHint();   // no longer locked, so a new Before-GAA item can flip the PPMP
   }

    // 6. Ensure Finish button saves the new entry
    const finishBtn = document.getElementById('finishBtn');
    if (finishBtn) {
        finishBtn.innerText = 'Finish →';
        finishBtn.onclick = saveProcurementRequest;
    }

    hideItemNavigator();

    const titleEl = document.getElementById('page-title');
    if (titleEl) {
        titleEl.innerText = 'NEW ITEM — PPMP NO. ' + ppmpNo;
    }

    if (typeof showToast === 'function') {
        showToast('Adding a new line item under PPMP No. ' + ppmpNo + '.');
    }
}


// ============================================================
// ITEM NAVIGATOR
// Shown above the form whenever the PPMP being viewed has more than one
// line item, so the user can step between them without leaving the modal.
// ============================================================

function hideItemNavigator() {
    const nav = document.getElementById('modalItemNav');
    if (nav) nav.classList.add('hidden');
}

function renderItemNavigator(recordId, items, currentIndex) {
    const wrapper = document.querySelector('#requestModalOverlay .title-tab-wrapper');
    if (!wrapper) return;

    if (!items || items.length <= 1) {
        hideItemNavigator();
        return;
    }

    let nav = document.getElementById('modalItemNav');

    if (!nav) {
        nav = document.createElement('div');
        nav.id = 'modalItemNav';
        nav.className = 'modal-item-nav';
        nav.innerHTML =
            '<button type="button" class="modal-item-nav-btn" id="modalItemPrev" aria-label="Previous item">&larr;</button>' +
            '<span id="modalItemNavLabel"></span>' +
            '<button type="button" class="modal-item-nav-btn" id="modalItemNext" aria-label="Next item">&rarr;</button>';
        wrapper.insertAdjacentElement('afterend', nav);
    }

    nav.classList.remove('hidden');
    nav.querySelector('#modalItemNavLabel').textContent = `Item ${currentIndex + 1} of ${items.length}`;

    const prevBtn = nav.querySelector('#modalItemPrev');
    const nextBtn = nav.querySelector('#modalItemNext');

    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex === items.length - 1;

    // Replace onclick each render so we always jump using the item index
    // and record id that are current right now, not whatever was current
    // the first time the navigator was created.
    prevBtn.onclick = () => loadRecordIntoModal(recordId, currentIndex - 1);
    nextBtn.onclick = () => loadRecordIntoModal(recordId, currentIndex + 1);
}

function loadRecordIntoModal(id, itemIndex = 0) {
    const pdfButtons = document.querySelectorAll('.pdf-btn-global');
    pdfButtons.forEach(btn => btn.style.display = 'inline-flex');
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const data = records.find(r => r.id == id);
    if (!data) return;

    // Only open records this account is allowed to see (e.g. an office can
    // never open another office's PPMP by id).
    if (typeof getRecords === 'function' && !getRecords().some(r => r.id == data.id)) return;

    isViewMode = true;
    currentEditingId = data.id;

    const items = typeof getRecordItems === 'function' ? getRecordItems(data) : [data];
    const safeIndex = Math.min(Math.max(itemIndex, 0), items.length - 1);
    const item = items[safeIndex] || {};

    currentEditingItemId = item.id;
    currentItemIndex = safeIndex;

    // Fill header fields (shared by every item under this PPMP) plus this
    // one item's own fields.
    const fieldMap = {
        'ppmp_no': data.ppmp_no,
        'is_indicative': data.is_indicative,
        'end_user': data.end_user,
        'fiscal_year': data.fiscal_year,
        'project_description': item.project_description,
        'project_type': item.project_type,
        'modeOfProcurement': item.mode,
        'pre_procurement': item.pre_procurement,
        'bid_evaluation_criteria': item.bid_evaluation_criteria,
        'quantity_size': item.quantity_size,
        'start_date': item.start_date,
        'end_date': item.end_date,
        'delivery_period': item.delivery_period,
        'fund_source': item.fund_source,
        'budget': item.budget,
        'general_requirements': item.general_requirements,
        'remarks': item.remarks
    };

    Object.keys(fieldMap).forEach(key => {
        const el = document.getElementById(key);
        if (el) el.value = fieldMap[key] || '';
    });
    
    indicativeManual = (data.indicative_mode || 'manual') === 'manual';
    renderIndicativeHint();
    
    updateDocTypeHint();

    // Load Strategies
    selectedStrategies = item.strategies || [];
    renderTags(document.getElementById('selectedTags'));

    // Load Files (Visual only) — always reset first so switching to an
    // item with no files doesn't leave the previous item's files showing.
    uploadedFiles = (item.supporting_documents || []).map(doc => {
        const entry = {
            id: Math.random(),
            file: { name: doc.name, size: doc.size, type: doc.type || '' },
            type: doc.type || '',
            fileId: doc.fileId || null,
            dataUrl: doc.dataUrl || null,   // only on records not migrated yet
            objectUrl: null
        };
        // Browsers block target="_blank" navigation straight to a data: URL,
        // so read the file from storage and give the link a real blob URL.
        FileStore.docBlob(doc).then(blob => {
            if (blob && uploadedFiles.includes(entry)) {
                entry.objectUrl = URL.createObjectURL(blob);
                renderUploadedFiles();
            }
        }).catch(() => {});
        return entry;
    });
    renderUploadedFiles();

    // Change UI for Viewing
    document.getElementById('page-title').innerText = "VIEWING REQUEST: " + data.ppmp_no;
    document.getElementById('finishBtn').innerText = 'Close';
    
    // Disable all inputs so it's "Read Only"
    disableModalFields();

    const session = typeof getSession === 'function' ? getSession() : null;
    const finishBtn = document.getElementById('finishBtn');

    finishBtn.style.background = '';
    if (canSessionActOnRecord(data)) {
        document.getElementById('page-title').innerText = "APPROVAL REQUIRED: " + data.ppmp_no;

        finishBtn.innerText = "Review & Decide \u2192";
        finishBtn.style.background = "var(--db-accent, #3B82F6)";
        finishBtn.onclick = () => openApprovalDialog();
    }

    // Status badge, approval banner, and which action buttons apply.
    // A closed (approved) PPMP is read-only: no Edit, no Delete Item.
    const statusBadge = document.getElementById('modalStatusBadge');
    if (statusBadge) statusBadge.classList.remove('hidden');
    applyApprovalState(data);

    renderItemNavigator(data.id, items, safeIndex);
}

// Reflects a record's status as a colored pill next to the modal title.
function updateStatusBadge(status) {
    const badge = document.getElementById('modalStatusBadge');
    if (!badge) return;

    const label = status === 'Completed' ? 'Completed'
        : (status === 'For Approval' ? 'For Approval' : 'Draft');
    badge.textContent = label;
    badge.classList.toggle('is-completed', label === 'Completed');
    badge.classList.toggle('is-pending', label === 'For Approval');
    badge.classList.toggle('is-draft', label === 'Draft');
}

// ============================================================
// PPMP APPROVAL
// Only an account flagged canApprove (see auth.js) can approve.
// Approving turns the PPMP Final, marks it Completed (closed), and
// records who approved it and when. A closed PPMP is read-only:
// no edits, no new items, no item deletion.
// ============================================================

function isCurrentPpmpLocked() {
    if (!currentEditingId) return false;
    const db = JSON.parse(localStorage.getItem('procurement_records')) || [];
    return getPpmpStatus(db.find(r => r.id == currentEditingId)) !== 'Draft';
}

function isCurrentPpmpClosed() {
    if (!currentEditingId) return false;
    const db = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const record = db.find(r => r.id == currentEditingId);
    return !!record && record.status === 'Completed';
}

// The header button is now the "Approve PPMP" action. Its id and the
// toggleVerifyStatus() onclick name are unchanged so the page markup
// keeps working without edits.
function updateVerifyButtonLabel() {
    const verifyBtn = document.getElementById('verifyRequestBtn');
    const label = document.getElementById('verifyBtnLabel');
    if (!verifyBtn || !label) return;

    label.textContent = 'Review PPMP';
    verifyBtn.classList.remove('is-completed');
    verifyBtn.setAttribute('aria-label', 'Review this PPMP: approve, reject or add remarks');
}

// Shows/hides the modal controls for a record in view mode.
function applyApprovalState(record) {
    const status = getPpmpStatus(record);
    const isLocked = status !== 'Draft';
    const canApprove = typeof canSessionActOnRecord === 'function' && canSessionActOnRecord(record);
    const session = typeof getSession === 'function' ? getSession() : null;
    const canReq = !!(session && session.canRequest);
    const canEdit = !isLocked && canReq; // Only requesters can edit drafts
    updateStatusBadge(record.status);
    applyReturnedBadge(record);
    updateVerifyButtonLabel();
    renderApprovalInfo(record);
    renderReviewRemarks(record);

    const verifyBtn = document.getElementById('verifyRequestBtn');
    if (verifyBtn) verifyBtn.classList.toggle('hidden', status !== 'For Approval' || !canApprove);

    // Hide edit and delete item buttons from TOD, BO, and RD
    const editBtn = document.getElementById('editRequestBtn');
    if (editBtn) editBtn.classList.toggle('hidden', !canEdit);

    const deleteItemBtn = document.getElementById('deleteItemBtn');
    if (deleteItemBtn) deleteItemBtn.classList.toggle('hidden', !canEdit);
}

// Green banner near the top of the modal: who approved and when.
function renderApprovalInfo(record) {
    let box = document.getElementById('approvalInfo');

    if (!record || record.status !== 'Completed') {
        if (box) box.classList.add('hidden');
        return;
    }

    if (!box) {
        const anchor = document.querySelector('#requestModalOverlay .progress-section');
        if (!anchor || !anchor.parentNode) return;
        box = document.createElement('div');
        box.id = 'approvalInfo';
        box.className = 'approval-info';
        anchor.parentNode.insertBefore(box, anchor);
    }

    box.innerHTML = '';
    const title = document.createElement('strong');
    const detail = document.createElement('span');

    if (record.approved_by) {
        const when = typeof formatApprovalDateTime === 'function'
            ? formatApprovalDateTime(record.approved_at)
            : '';
        title.textContent = 'Approved by ' + record.approved_by.name;
        detail.textContent = [record.approved_by.email, when].filter(Boolean).join(' · ');
    } else {
        title.textContent = 'Approved';
        detail.textContent = 'The approver was not recorded for this PPMP.';
    }

    box.appendChild(title);
    box.appendChild(detail);
    box.classList.remove('hidden');
}

function hideApprovalInfo() {
    const box = document.getElementById('approvalInfo');
    if (box) box.classList.add('hidden');
}

// ---- Approval confirmation dialog (custom, no browser confirm) ----

let approvalDialogEl = null;
let approvalPrevFocus = null;

function buildApprovalDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'logout-overlay';
    overlay.id = 'approvalOverlay';
    overlay.innerHTML =
        '<div class="logout-modal review-modal" role="alertdialog" aria-modal="true" ' +
            'aria-labelledby="approvalTitle" aria-describedby="approvalDesc">' +
            '<div class="logout-icon is-approve">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="none">' +
                    '<path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>' +
            '</div>' +
            '<h3 id="approvalTitle"></h3>' +
            '<p id="approvalDesc"></p>' +
            '<div class="review-field" id="approvalRemarksField">' +
                '<label for="approvalRemarks">Remarks</label>' +
                '<textarea id="approvalRemarks" maxlength="1000" ' +
                    'placeholder="Point out errors, ask for clarification, or leave a note for the requester..."></textarea>' +
                '<p class="review-error">Remarks are required to reject or to add a remark.</p>' +
            '</div>' +
            '<div class="review-actions">' +
                '<button type="button" class="logout-cancel-btn" data-review-cancel>Cancel</button>' +
                '<button type="button" class="logout-cancel-btn" data-review-comment>Add remark only</button>' +
                '<button type="button" class="logout-confirm-btn is-reject" data-review-reject>Reject</button>' +
                '<button type="button" class="logout-confirm-btn is-approve" data-review-approve>Approve</button>' +
            '</div>' +
        '</div>';

    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeApprovalDialog();
    });
    overlay.querySelector('[data-review-cancel]').addEventListener('click', closeApprovalDialog);
    overlay.querySelector('[data-review-comment]').addEventListener('click', function () { submitReview('comment'); });
    overlay.querySelector('[data-review-reject]').addEventListener('click', function () { submitReview('reject'); });
    overlay.querySelector('[data-review-approve]').addEventListener('click', function () { submitReview('approve'); });
    overlay.querySelector('#approvalRemarks').addEventListener('input', function () {
        overlay.querySelector('#approvalRemarksField').classList.remove('has-error');
    });

    document.body.appendChild(overlay);
    return overlay;
}

// Runs in the capture phase so Escape closes only this dialog, not the
// request modal underneath it.
function onApprovalKeydown(e) {
    if (!approvalDialogEl || !approvalDialogEl.classList.contains('show')) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeApprovalDialog();
        return;
    }

    if (e.key === 'Tab') {
        const focusable = approvalDialogEl.querySelectorAll('textarea, button');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

// Called by the header button (name kept from the old verify toggle).
function toggleVerifyStatus() {
    openApprovalDialog();
}

function openApprovalDialog() {
    if (!currentEditingId) return;

    if (typeof canCurrentUserApprove !== 'function' || !canCurrentUserApprove()) {
        showToast('Only an authorized approver can review a PPMP.');
        return;
    }
    const currentRecord = (JSON.parse(localStorage.getItem('procurement_records')) || []).find(r => r.id == currentEditingId);
    if (getPpmpStatus(currentRecord) !== 'For Approval') {
        showToast('This PPMP must be submitted for approval before it can be reviewed.');
        return;
    }
    if (!canSessionActOnRecord(currentRecord)) {
        showToast('This PPMP is not waiting for your approval.');
        return;
    }

    if (!approvalDialogEl) approvalDialogEl = buildApprovalDialog();

    const ppmpNo = (document.getElementById('ppmp_no') || {}).value || '';
    const session = typeof getSession === 'function' ? getSession() : null;
    const who = session && session.roleName ? session.roleName : 'you';

    document.getElementById('approvalTitle').textContent = 'Review PPMP No. ' + ppmpNo;
    const stepIdx = APPROVAL_CHAIN.findIndex(step => step.role === currentRecord.currentApproverRole);
    const isLastStep = stepIdx === APPROVAL_CHAIN.length - 1;
    const nextStep = !isLastStep && stepIdx > -1 ? APPROVAL_CHAIN[stepIdx + 1] : null;
    document.getElementById('approvalDesc').textContent =
        (nextStep
            ? 'Approve to forward it to the ' + nextStep.label + '.'
            : 'Approve is the final step: it marks the PPMP Final and closes it.') +
        ' Reject returns it to the requesting office for revision (remarks required). ' +
        'Your decision is recorded under ' + who + '.';

    const box = document.getElementById('approvalRemarks');
    box.value = '';
    document.getElementById('approvalRemarksField').classList.remove('has-error');

    approvalPrevFocus = document.activeElement;
    approvalDialogEl.classList.add('show');
    document.addEventListener('keydown', onApprovalKeydown, true);

    // Focus the remarks box: Enter there only adds a new line, so a stray
    // keypress can never approve or reject anything.
    box.focus();
}

function closeApprovalDialog() {
    if (!approvalDialogEl) return;
    approvalDialogEl.classList.remove('show');
    document.removeEventListener('keydown', onApprovalKeydown, true);
    if (approvalPrevFocus && typeof approvalPrevFocus.focus === 'function') {
        approvalPrevFocus.focus();
    }
}

// action: 'approve' | 'reject' | 'comment'. Reject and comment need remarks.
function submitReview(action) {
    const field = document.getElementById('approvalRemarksField');
    const box = document.getElementById('approvalRemarks');
    const remarks = box ? box.value.trim() : '';

    if (action !== 'approve' && !remarks) {
        if (field) field.classList.add('has-error');
        if (box) box.focus();
        return;
    }

    closeApprovalDialog();
    performReviewAction(action, remarks);
}

// Kept for any old callers.
function approveCurrentPpmp() {
    const box = document.getElementById('approvalRemarks');
    closeApprovalDialog();
    performReviewAction('approve', box ? box.value : '');
}

// ---- Review history + "returned" banner inside the request modal ----

const REVIEW_ACTION_LABELS = { approved: 'Approved', rejected: 'Rejected', remark: 'Remark', submitted: 'Submitted' };

function applyReturnedBadge(record) {
    const badge = document.getElementById('modalStatusBadge');
    if (!badge) return;
    const returned = typeof isPpmpReturned === 'function' && isPpmpReturned(record);
    badge.classList.toggle('is-returned', returned);
    if (returned) {
        badge.textContent = 'Returned';
        badge.classList.remove('is-draft');
    }
}

function hideReviewRemarks() {
    const box = document.getElementById('reviewRemarks');
    if (box) box.classList.add('hidden');
}

function renderReviewRemarks(record) {
    let box = document.getElementById('reviewRemarks');
    const history = record && Array.isArray(record.remarksHistory) ? record.remarksHistory : [];
    const returned = typeof isPpmpReturned === 'function' && isPpmpReturned(record);

    // Tracking accounts (Suppliers) see who is handling / approved a PPMP and
    // where it is now, but not the internal remark text.
    const trackSession = typeof getSession === 'function' ? getSession() : null;
    const tracking = !!(trackSession && trackSession.canTrackApprovals);
    const waitingStep = (tracking && record && getPpmpStatus(record) === 'For Approval' && typeof getApprovalStep === 'function')
        ? getApprovalStep(record.currentApproverRole)
        : null;

    if (!history.length && !returned && !waitingStep) {
        if (box) box.classList.add('hidden');
        return;
    }

    if (!box) {
        const anchor = document.querySelector('#requestModalOverlay .progress-section');
        if (!anchor || !anchor.parentNode) return;
        box = document.createElement('div');
        box.id = 'reviewRemarks';
        box.className = 'review-remarks';
        anchor.parentNode.insertBefore(box, anchor);
    }
    box.innerHTML = '';

    const when = ts => (typeof formatApprovalDateTime === 'function' ? formatApprovalDateTime(ts) : '');

    // Everything below uses textContent, so remarks can never inject HTML.
    if (returned) {
        const lastRejection = history.slice().reverse().find(h => h.action === 'rejected');
        const by = record.rejected_by && record.rejected_by.name ? record.rejected_by.name : 'an approver';
        const banner = document.createElement('div');
        banner.className = 'review-returned';

        const title = document.createElement('strong');
        title.textContent = 'Returned for revision by ' + by;
        banner.appendChild(title);

        if (lastRejection && lastRejection.remarks) {
            const reason = document.createElement('span');
            reason.textContent = lastRejection.remarks;
            banner.appendChild(reason);
        }

        const meta = document.createElement('small');
        meta.textContent = 'Edit the PPMP, then submit it for approval again.' +
            (record.rejected_at ? ' \u00b7 ' + when(record.rejected_at) : '');
        banner.appendChild(meta);
        box.appendChild(banner);
    }

    if (waitingStep) {
        const current = document.createElement('div');
        current.className = 'review-returned';
        const currentTitle = document.createElement('strong');
        currentTitle.textContent = 'Currently with: ' + waitingStep.label;
        current.appendChild(currentTitle);
        box.appendChild(current);
    }

    if (history.length) {
        const heading = document.createElement('p');
        heading.className = 'review-history-title';
        heading.textContent = 'Review history';
        box.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'review-list';

        history.forEach(h => {
            const action = h.action || 'approved';   // older entries had no action
            const stage = (typeof getApprovalStep === 'function' && getApprovalStep(h.stage)) || null;

            const li = document.createElement('li');
            li.className = 'review-item';

            const head = document.createElement('div');
            head.className = 'review-item-head';

            const tag = document.createElement('span');
            tag.className = 'review-tag is-' + action;
            tag.textContent = REVIEW_ACTION_LABELS[action] || action;

            const name = document.createElement('strong');
            name.textContent = h.name || h.role || 'Approver';

            const meta = document.createElement('span');
            meta.textContent = [stage ? stage.label : h.stage, when(h.at)].filter(Boolean).join(' \u00b7 ');

            head.appendChild(tag);
            head.appendChild(name);
            head.appendChild(meta);
            li.appendChild(head);

            if (h.remarks && !tracking) {
                const text = document.createElement('p');
                text.className = 'review-item-text';
                text.textContent = h.remarks;
                li.appendChild(text);
            }
            list.appendChild(li);
        });

        box.appendChild(list);
    }

    box.classList.remove('hidden');
}

// Deletes just the item currently shown in the modal, rather than the
// whole PPMP — hands off to dashboard-logic.js, which owns the shared
// confirm dialog, and refreshes/steps the modal once it's done.
function deleteCurrentItem() {
    if (!currentEditingId || !currentEditingItemId) return;

    if (typeof deleteRecordItem === 'function') {
        deleteRecordItem(currentEditingId, currentEditingItemId);
    }
}

function enableEditMode() {

    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || !session.canRequest) {
        showToast('Your account is view/approve only and cannot edit requests.');
        return;
    }
    if (isCurrentPpmpLocked()) {
        showToast('This PPMP is submitted for approval or approved — it can no longer be edited.');
        return;
    }
    
    if (isCurrentPpmpLocked()) {
        showToast('This PPMP is submitted for approval or approved — it can no longer be edited.');
        return;
    }

    isViewMode = false;
    enableModalFields();
    hideItemNavigator();
    renderIndicativeHint();


    const editBtn = document.getElementById('editRequestBtn');
    if (editBtn) editBtn.classList.add('hidden');

    const verifyBtn = document.getElementById('verifyRequestBtn');
    if (verifyBtn) verifyBtn.classList.add('hidden');

    // Deleting a single item only makes sense while read-only viewing it —
    // once editing, "Save Changes" / "Cancel" are the relevant actions.
    const deleteItemBtn = document.getElementById('deleteItemBtn');
    if (deleteItemBtn) deleteItemBtn.classList.add('hidden');

    // Reflect the mode switch in the title if it's still showing the
    // "viewing" label (it gets overwritten anyway on step navigation)
    const title = document.getElementById('page-title');
    if (title && title.innerText.indexOf('VIEWING REQUEST') === 0) {
        title.innerText = title.innerText.replace('VIEWING REQUEST', 'EDITING REQUEST');
    }

    // finishBtn only exists on step 3 — guard in case we're on step 1/2
    const finishBtn = document.getElementById('finishBtn');
    if (finishBtn) {
        finishBtn.innerText = 'Save Changes →';
        finishBtn.onclick = saveProcurementRequest;
    }

    showToast('You can now edit this request.');
}

function disableModalFields() {
    const finishBtn = document.getElementById('finishBtn');

    // Read-only view: the Finish button just closes the modal.
    // (loadRecordIntoModal turns it into "Approve & Forward" for the approver
    // whose stage the PPMP is currently at.)
    if (finishBtn) {
        finishBtn.innerText = 'Close';
        finishBtn.onclick = closeRequestModal;
    }

    document.querySelectorAll('#requestModalOverlay input, #requestModalOverlay select, #requestModalOverlay textarea')
        .forEach(el => el.disabled = true);
    document.getElementById('uploadZone').style.pointerEvents = 'none';
    document.getElementById('strategiesTrigger').style.pointerEvents = 'none';
}

function enableModalFields() {
    document.querySelectorAll('#requestModalOverlay input, #requestModalOverlay select, #requestModalOverlay textarea')
        .forEach(el => el.disabled = false);
    
    document.getElementById('uploadZone').style.pointerEvents = 'auto';
    document.getElementById('strategiesTrigger').style.pointerEvents = 'auto';

    document.getElementById('ppmp_no').readOnly = true;
    document.getElementById('fiscal_year').readOnly = false; // typed manually; addEntryToPpmp() re-locks it for existing PPMPs

    // End-User/Implementing Unit is always the signed-in office — never
    // free-typed, so filtering in getRecords() stays an exact match.
    const endUserField = document.getElementById('end_user');
    if (endUserField) {
        const session = typeof getSession === 'function' ? getSession() : null;
        if (session && session.office) {
            endUserField.value = session.office;
        }
        endUserField.readOnly = true;
    }
}


function closeRequestModal() {
    const overlay = document.getElementById('requestModalOverlay');
    if (!overlay) return;

    overlay.classList.add('hidden');
    overlay.style.display = 'none'; // Resets display
    document.body.style.overflow = '';
    currentEditingId = null;
    currentEditingItemId = null;
    hideItemNavigator();
}


// Close on Escape, close on backdrop click
document.addEventListener('keydown', function (event) {

    if (event.key !== 'Escape') return;

    const overlay =
        document.getElementById('requestModalOverlay');

    if (overlay && !overlay.classList.contains('hidden')) {
        closeRequestModal();
    }
});


document.addEventListener('click', function (event) {

    if (event.target && event.target.id === 'requestModalOverlay') {
        closeRequestModal();
    }
});

// ============================================================
// APPROVAL STEP (single implementation)
// Called by both the "Approve & Forward" footer button and the header
// "Approve PPMP" dialog. Moves the PPMP to the next stage of APPROVAL_CHAIN;
// only the last stage (Regional Director) completes it.
// ============================================================
function performApprovalStep(remarksText) {
    performReviewAction('approve', remarksText);
}

// The single implementation behind Approve / Reject / Add remark.
//   approve -> forwards to the next stage (or completes after the last one)
//   reject  -> back to the requesting office as an editable Draft ("Returned");
//              the chain restarts from the first step when they resubmit
//   comment -> logs a remark at the current stage without moving the PPMP
function performReviewAction(action, remarksText) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || !session.canApprove) {
        showToast('Only an authorized approver can review a PPMP.');
        return;
    }
    if (!currentEditingId) return;

    const db = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = db.findIndex(r => r.id == currentEditingId);
    if (idx === -1) return;

    const record = db[idx];

    if (getPpmpStatus(record) !== 'For Approval') {
        showToast('This PPMP must be submitted for approval before it can be reviewed.');
        return;
    }
    if (!canSessionActOnRecord(record)) {
        showToast('This PPMP is not waiting for your approval.');
        return;
    }

    const remarks = (remarksText || '').trim();
    if ((action === 'reject' || action === 'comment') && !remarks) {
        showToast('Please enter remarks first.');
        return;
    }

    // 1. Log the decision (who, which stage, what they said)
    if (!Array.isArray(record.remarksHistory)) record.remarksHistory = [];
    record.remarksHistory.push({
        stage: session.stage,
        role: session.role,
        name: session.roleName,
        action: action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'remark'),
        remarks: remarks || 'Approved.',
        round: Number(record.submission_round) || 1,
        date: new Date().toLocaleDateString(),
        at: Date.now()
    });

    // 2. Apply the decision
    let message;

    if (action === 'comment') {
        message = 'Remark added to PPMP No. ' + record.ppmp_no + '.';

    } else if (action === 'reject') {
        record.status = 'Draft';
        record.currentApproverRole = null;
        record.returned_for_revision = true;
        record.rejected_at = Date.now();
        record.rejected_by = {
            name: session.roleName,
            role: session.role,
            email: session.email,
            stage: session.stage
        };
        message = 'PPMP No. ' + record.ppmp_no + ' rejected and returned to the requesting office.';

    } else {
        const currentIdx = APPROVAL_CHAIN.findIndex(step => step.role === record.currentApproverRole);

        if (currentIdx > -1 && currentIdx < APPROVAL_CHAIN.length - 1) {
            const next = APPROVAL_CHAIN[currentIdx + 1];
            record.currentApproverRole = next.role;      // status stays 'For Approval'
            message = 'PPMP No. ' + record.ppmp_no + ' approved and forwarded to ' + next.label + '.';
        } else {
            record.status = 'Completed';
            record.currentApproverRole = 'None';
            record.returned_for_revision = false;
            record.is_indicative = 'Final';
            record.approved_at = Date.now();
            recordApprovedPpmpNumber(record);
            record.approved_by = {
                name: session.roleName,
                role: session.role,
                email: session.email
            };
            message = 'PPMP No. ' + record.ppmp_no + ' fully approved and marked Final.';
        }
    }

    try {
        localStorage.setItem('procurement_records', JSON.stringify(db));
    } catch (err) {
        console.error('Save failed', err);
        showToast('Could not save your review - please try again.');
        return;
    }

    if (action === 'comment') {
        // Stay on the PPMP so the approver sees their remark in the history.
        if (typeof refreshDashboardRecords === 'function') refreshDashboardRecords();
        loadRecordIntoModal(record.id, currentItemIndex);
    } else {
        closeRequestModal();
        if (typeof refreshDashboardRecords === 'function') refreshDashboardRecords();
    }
    showToast(message);
}

// Footer "Review & Decide" button (approver view): opens the review dialog.
function approveWorkflowStep() {
    openApprovalDialog();
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', function () {

        // This script only ever powers the "new request" modal — there is
        // no view-mode branch here (viewing existing records still happens
        // on page1.html).
        ensureCriteriaNaOption();
        ensureStrategyNaOption();

        initializePpmpNumber();
        initializeFiscalYear();
        initializeStrategies();
        initializeModeValidation();
        initRequiredFieldValidation();
        initFileUpload();
        initIndicativeAuto();
        restrictNumberOnly('ppmp_no');
        restrictNumberOnly('fiscal_year');
        restrictDecimalNumber('budget');

        // PPMP No. follows the Fiscal Year: typing a year re-numbers the PPMP.
        const fiscalYearInput = document.getElementById('fiscal_year');
        if (fiscalYearInput) {
            fiscalYearInput.addEventListener('input', refreshPpmpNumberForYear);
        }

        renderTags(
            document.getElementById('selectedTags')
        );

        const projectTypeEl = document.getElementById('project_type');
        if (projectTypeEl) {
            projectTypeEl.addEventListener('change', updateDocTypeHint);
        }
        updateDocTypeHint();

        const criteriaSelect = document.getElementById('bid_evaluation_criteria');
        const mearbHint = document.getElementById('mearbHint');
        if (criteriaSelect && mearbHint) {
            criteriaSelect.addEventListener('change', function () {
                mearbHint.classList.toggle('hidden', !this.value.includes('MEARB'));
            });
        }
    }
);