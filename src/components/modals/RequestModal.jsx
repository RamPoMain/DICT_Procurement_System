import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  parseBudgetNumber,
  STANDARD_PROCUREMENT_MODES,
  isBracketMismatch,
  exceedsModeCeiling,
  budgetBracketMessage,
  claimEntryRef,
  findExistingReferenceInfo,
  tagFailedAttempts,
  getRecordItems,
  getPpmpStatus
} from '../../utils/procurementRules.js';
import { generatePPMP_PDF } from '../../utils/pdfGenerator.js';
import FileStore from '../../utils/fileStore.js';
import BulkImportModal from './BulkImportModal.jsx';

// NOTE: the original form keeps these options in its HTML (not in the JS), so this is a
// placeholder list. Replace it with the exact <option> values from your original page.
// 'Negotiated' is added automatically when two failed biddings lock the mode.
const BID_CRITERIA_OPTIONS = [
  'Lowest Calculated Responsive Bid (LCRB)',
  'Most Economically Advantageous Responsive Bid (MEARB)',
  'Quality-Based Evaluation (QBE)',
  'Quality-Cost Based Evaluation (QCBE)',
  'Fixed Budget Selection (FBS)',
  'Least-Cost Selection (LCS)',
  'N/A'
];

// NOTE: these three lists live in the original HTML, so they are best-effort placeholders.
// The strategy list starts with the three seen in your original screenshot - replace/extend
// it with the exact options from your original page.
const STRATEGY_OPTIONS = [
  'Multi-Year Contracting',
  'Subcontracting',
  'Life Cycle Assessment (LCA) and LCCA',
  'Framework Agreement',
  'Early Procurement Activities',
  'N/A'
];
const GENERAL_REQ_OPTIONS = ['General Requirements', 'Miscellaneous', 'Common Supplies and Equipment'];
const EXPENSE_CLASS_OPTIONS = ['MOOE', 'CO', 'N/A'];
const PROJECT_TYPE_DOC_LABELS = {
  'Goods': 'Technical Specifications',
  'Consulting Services': 'Terms of Reference',
  'Infrastructure': 'Scope of Work'
};
const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;  // 50MB total per item
const formatFileSize = (b) => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const STEP_PROGRESS = [15, 45, 85];

export default function RequestModal({ isOpen, onClose, recordId = null, onSaved, onBulkImport }) {
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [isViewMode, setIsViewMode] = useState(false);
  const [itemIdx, setItemIdx] = useState(0);

  const [headerData, setHeaderData] = useState({
    ppmp_no: '',
    fiscal_year: new Date().getFullYear().toString(),
    end_user: user?.office || '',
    is_indicative: 'Indicative'
  });

  const [items, setItems] = useState([]);
  const [activeItem, setActiveItem] = useState(createBlankItem());
  const [errors, setErrors] = useState({});
  const [failedBiddingWarning, setFailedBiddingWarning] = useState('');
  const [stratOpen, setStratOpen] = useState(false);
  const [recordStatus, setRecordStatus] = useState('Draft');
  const [recordLocked, setRecordLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  function createBlankItem() {
    return {
      id: Date.now(),
      project_description: '',
      object_name: '',
      project_type: '',
      mode: '',
      pre_procurement: '',
      bid_evaluation_criteria: '',
      quantity_size: '',
      start_date: '',
      bid_opening_date: '',
      notice_of_award_date: '',
      end_date: '',
      delivery_period: '',
      fund_source: '',
      budget: '',
      expense_class: 'N/A',
      strategies: [],
      remarks: '',
      general_requirements: '',
      supporting_documents: []
    };
  }

  // Next PPMP number for this office + fiscal year (shown read-only on a new request)
  function nextPpmpNo(fy) {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const n = all.filter(r => r.end_user === user?.office && String(r.fiscal_year) === String(fy)).length + 1;
    return String(n);
  }

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setStratOpen(false);
    setErrors({});
    setNotice('');
    setConfirmDelete(false);
    setRecordStatus('Draft');
    setRecordLocked(false);
    if (recordId) {
      const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
      const rec = records.find(r => r.id === recordId);
      if (rec) {
        setHeaderData({
          ppmp_no: rec.ppmp_no,
          fiscal_year: rec.fiscal_year,
          end_user: rec.end_user,
          is_indicative: rec.is_indicative
        });
        const itms = getRecordItems(rec);
        setItems(itms);
        setItemIdx(0);
        setActiveItem(itms[0] || createBlankItem());
        setIsViewMode(true);
        setRecordStatus(rec.status || 'Draft');
        setRecordLocked(getPpmpStatus(rec) !== 'Draft');
      }
    } else {
      setIsViewMode(false);
      const fresh = createBlankItem();
      setItems([fresh]);
      setItemIdx(0);
      setActiveItem(fresh);
      setHeaderData({
        ppmp_no: nextPpmpNo(new Date().getFullYear().toString()),
        fiscal_year: new Date().getFullYear().toString(),
        end_user: user?.office || '',
        is_indicative: 'Indicative'
      });
    }
  }, [isOpen, recordId]);

  // Live detection of Two Failed Biddings under RA 12009 Sec. 33
  // (re-runs when Edit is pressed, and ignores the record being edited)
  useEffect(() => {
    if (isViewMode) { setFailedBiddingWarning(''); return; }
    const desc = activeItem.project_description.trim();
    if (!desc) {
      setFailedBiddingWarning('');
      return;
    }
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const currentRec = recordId ? all.find(r => r.id === recordId) : null;
    const refInfo = findExistingReferenceInfo(desc, activeItem.project_type, currentRec, user?.office);
    if (refInfo && refInfo.competitiveCount >= 2) {
      setActiveItem(prev => ({
        ...prev,
        mode: 'Negotiated Procurement – Two Failed Biddings',
        bid_evaluation_criteria: 'Negotiated'
      }));
      setFailedBiddingWarning(`Matches ${refInfo.reference_no || 'prior attempts'}: 2 failed biddings detected. Mode is locked to Negotiated Procurement – Two Failed Biddings (Sec. 33).`);
    } else {
      setFailedBiddingWarning('');
      setActiveItem(prev => {
        if (prev.mode?.includes('Two Failed Biddings')) {
          return {
            ...prev,
            mode: '',
            bid_evaluation_criteria: prev.bid_evaluation_criteria === 'Negotiated' ? '' : prev.bid_evaluation_criteria
          };
        }
        return prev;
      });
    }
  }, [activeItem.project_description, activeItem.project_type, isViewMode, recordId, user?.office]);

  // Auto-hide the small toast message
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!isOpen) return null;

  const validateCurrentStep = () => {
    const errs = {};
    if (step === 1) {
      if (!activeItem.project_description) errs.project_description = 'Description is required';
      if (!activeItem.object_name || !/^\d+$/.test(activeItem.object_name)) errs.object_name = 'Object Code must be numbers only';
      if (!activeItem.project_type) errs.project_type = 'Select a Project Type';
      if (!activeItem.mode) errs.mode = 'Select a Procurement Mode';
      if (!activeItem.quantity_size) errs.quantity_size = 'Quantity and size required';
      if (!activeItem.pre_procurement) errs.pre_procurement = 'This field is required.';
      if (!activeItem.bid_evaluation_criteria) errs.bid_evaluation_criteria = 'This field is required.';

      // Shopping / Repeat Order Goods check
      if (['Shopping', 'Repeat Order'].includes(activeItem.mode) && activeItem.project_type !== 'Goods') {
        errs.mode = `${activeItem.mode} is strictly for Goods (RA 12009)`;
      }
    }
    if (step === 2) {
      const dates = [
        { key: 'start_date', label: 'Advertisement/Posting' },
        { key: 'bid_opening_date', label: 'Bid Opening' },
        { key: 'notice_of_award_date', label: 'Notice of Award' },
        { key: 'end_date', label: 'Contract Signing' },
        { key: 'delivery_period', label: 'Delivery Period' }
      ];
      dates.forEach(d => { if (!activeItem[d.key]) errs[d.key] = `${d.label} is required`; });

      // Chronological sequence validation
      if (activeItem.start_date && activeItem.bid_opening_date && activeItem.bid_opening_date < activeItem.start_date) {
        errs.bid_opening_date = 'Bid Opening cannot be before Advertisement/Posting';
      }
      if (activeItem.bid_opening_date && activeItem.notice_of_award_date && activeItem.notice_of_award_date < activeItem.bid_opening_date) {
        errs.notice_of_award_date = 'Notice of Award cannot be before Bid Opening';
      }
      if (activeItem.notice_of_award_date && activeItem.end_date && activeItem.end_date < activeItem.notice_of_award_date) {
        errs.end_date = 'Contract Signing cannot be before Notice of Award';
      }
      if (activeItem.end_date && activeItem.delivery_period && activeItem.delivery_period <= activeItem.end_date) {
        errs.delivery_period = 'Delivery Period must be strictly after Contract Signing';
      }

      // Funding (these fields moved to step 2 to match the original form)
      if (!activeItem.fund_source) errs.fund_source = 'This field is required.';
      const b = parseBudgetNumber(activeItem.budget);
      if (!b || b <= 0) {
        errs.budget = 'Budget must be greater than 0';
      } else if (!activeItem.mode?.includes('Two Failed Biddings') && activeItem.mode !== 'Negotiated Procurement') {
        if (isBracketMismatch(activeItem.mode, b)) errs.budget = budgetBracketMessage(activeItem.mode, b);
        else if (exceedsModeCeiling(activeItem.mode, b)) errs.budget = `Exceeds allowable budget for ${activeItem.mode}`;
      }
      if (!EXPENSE_CLASS_OPTIONS.includes(activeItem.expense_class)) {
        errs.expense_class = 'Please select whether the budget is MOOE, CO, or N/A.';
      }
    }
    if (step === 3) {
      if (!activeItem.strategies?.length) errs.strategies = 'Please select at least one procurement strategy.';
      if (!activeItem.remarks?.trim()) errs.remarks = 'This field is required.';
      if (!activeItem.supporting_documents?.length) errs.supporting_documents = 'Please upload at least one supporting document.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (validateCurrentStep()) setStep(s => s + 1);
  };

  const handleSave = () => {
    if (!validateCurrentStep()) return;
    let records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const updatedItems = [...items];
    const finalItem = { ...activeItem };

    const isTwoFailed = finalItem.mode?.includes('Two Failed Biddings');
    const refInfo = isTwoFailed
      ? findExistingReferenceInfo(finalItem.project_description, finalItem.project_type, recordId ? records.find(r => r.id === recordId) : null, user?.office)
      : null;

    if (!finalItem.reference_no) {
      if (refInfo?.reference_no) {
        finalItem.reference_no = refInfo.reference_no;
      } else {
        finalItem.reference_no = claimEntryRef(records, finalItem.project_type, headerData.fiscal_year);
      }
    }
    updatedItems[itemIdx] = finalItem;

    if (recordId) {
      const idx = records.findIndex(r => r.id === recordId);
      if (idx !== -1 && getPpmpStatus(records[idx]) !== 'Draft') {
        window.alert('This PPMP was submitted or approved in the meantime, so it can no longer be changed.');
        if (onSaved) onSaved();
        onClose();
        return;
      }
      if (idx !== -1) {
        records[idx].items = updatedItems;
        records[idx].fiscal_year = headerData.fiscal_year;
        records[idx].is_indicative = headerData.is_indicative;
      }
    } else {
      const officeRecords = records.filter(r => r.end_user === user.office && String(r.fiscal_year) === String(headerData.fiscal_year));
      const newRec = {
        id: Date.now(),
        ppmp_no: String(officeRecords.length + 1),
        fiscal_year: headerData.fiscal_year,
        end_user: user.office,
        is_indicative: headerData.is_indicative,
        status: 'Draft',
        items: updatedItems,
        remarksHistory: []
      };
      records.push(newRec);
    }

    if (isTwoFailed) {
      records = tagFailedAttempts(records, finalItem.project_description, user?.office);
    }

    localStorage.setItem('procurement_records', JSON.stringify(records));
    if (onSaved) onSaved();
    onClose();
  };

  const clearError = (key) => setErrors(e => { const { [key]: _removed, ...rest } = e; return rest; });

  const addFiles = async (fileList) => {
    const incoming = Array.from(fileList || []);
    let total = (activeItem.supporting_documents || []).reduce((s, d) => s + (d.size || 0), 0);
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        setErrors(e => ({ ...e, supporting_documents: `"${file.name}" is ${formatFileSize(file.size)}, which is over the ${formatFileSize(MAX_FILE_SIZE)} per-file limit. Please attach a smaller file.` }));
        continue;
      }
      if (total + file.size > MAX_TOTAL_SIZE) {
        setErrors(e => ({ ...e, supporting_documents: `Adding "${file.name}" would exceed the ${formatFileSize(MAX_TOTAL_SIZE)} total attachment limit for this request.` }));
        continue;
      }
      try {
        const fileId = FileStore.newId();
        await FileStore.put(fileId, file);
        total += file.size;
        clearError('supporting_documents');
        setActiveItem(prev => ({
          ...prev,
          supporting_documents: [...prev.supporting_documents, { name: file.name, size: file.size, type: file.type, fileId }]
        }));
      } catch {
        setErrors(e => ({ ...e, supporting_documents: `The file "${file.name}" could not be stored in this browser (storage may be full).` }));
      }
    }
  };

  const removeDoc = (idx) => {
    setActiveItem(prev => ({ ...prev, supporting_documents: prev.supporting_documents.filter((_, i) => i !== idx) }));
  };

  // Selecting N/A clears every other strategy; picking a real one clears N/A (as in the original form)
  const toggleStrategy = (s) => {
    const cur = activeItem.strategies || [];
    let next;
    if (s === 'N/A') next = cur.includes('N/A') ? [] : ['N/A'];
    else {
      const base = cur.filter(x => x !== 'N/A');
      next = base.includes(s) ? base.filter(x => x !== s) : [...base, s];
    }
    setActiveItem({ ...activeItem, strategies: next });
    if (next.length) clearError('strategies');
  };

  const dateField = (key, label) => (
  <div className={`field-group ${errors[key] ? 'error-state' : ''}`}>
    <label>{label}</label>
    <input
      type="date"
      value={activeItem[key]}
      disabled={isViewMode}
      onChange={e => setActiveItem({ ...activeItem, [key]: e.target.value })}
      onClick={e => {
        if (isViewMode) return;
        try { e.currentTarget.showPicker(); } catch { /* browser doesn't support it */ }
      }}
    />
    {errors[key] && <p className="text-45">{errors[key]}</p>}
  </div>
);

  // Only requesters can edit, and only while the PPMP is still a Draft
  const canEdit = !!recordId && !recordLocked && !!user?.canRequest;

  const enableEditMode = () => {
    if (!user?.canRequest) { setNotice('Your account is view/approve only and cannot edit requests.'); return; }
    if (recordLocked) { setNotice('This PPMP is submitted for approval or approved - it can no longer be edited.'); return; }
    setIsViewMode(false);
    setNotice('You can now edit this request.');
  };

  const deleteCurrentItem = () => {
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = records.findIndex(r => r.id === recordId);
    if (idx === -1) return;
    if (getPpmpStatus(records[idx]) !== 'Draft') {
      setConfirmDelete(false);
      setNotice('This PPMP is submitted for approval or approved - items can no longer be deleted.');
      return;
    }
    const remaining = getRecordItems(records[idx]).filter((_, i) => i !== itemIdx);
    if (remaining.length === 0) records.splice(idx, 1);   // last item: remove the whole PPMP
    else records[idx].items = remaining;
    localStorage.setItem('procurement_records', JSON.stringify(records));
    setConfirmDelete(false);
    if (onSaved) onSaved();
    onClose();
  };

  const exportPpmp = () => {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const rec = all.find(r => r.id === recordId);
    if (rec) generatePPMP_PDF(rec);
  };

  const docLabel = PROJECT_TYPE_DOC_LABELS[activeItem.project_type];
  const docs = activeItem.supporting_documents || [];

  return (
    <div className="db-modal-overlay" id="requestModalOverlay">
      <div className="db-modal">
        {(!recordId || (isViewMode && canEdit)) && (
          <div className="db-modal-header-actions">
            {!recordId && onBulkImport && (
              <button
                type="button"
                className="db-modal-pdf-btn"
                onClick={onBulkImport}
              >
                &#8593; Bulk import
              </button>
            )}
            {recordId && isViewMode && canEdit && (
              <>
                <button type="button" className="db-modal-edit-item-btn" onClick={enableEditMode}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                  Edit
                </button>
                <button type="button" className="db-modal-delete-item-btn" onClick={() => setConfirmDelete(true)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                  Delete Item
                </button>
              </>
            )}
          </div>
        )}
        <button type="button" className="db-modal-close" onClick={onClose}>&times;</button>

        <div className="title-tab-wrapper">
          <span className="text-9">
            {step === 1 && 'PROCUREMENT PROJECT DETAILS'}
            {step === 2 && 'PROJECTED TIMELINE'}
            {step === 3 && 'FUNDING DETAILS'}
          </span>
          {recordId && (
            <span className={`modal-status-badge ${recordStatus === 'Completed' ? 'is-completed' : recordStatus === 'For Approval' ? 'is-pending' : 'is-draft'}`}>
              {recordStatus === 'Completed' || recordStatus === 'For Approval' ? recordStatus : 'Draft'}
            </span>
          )}
        </div>

        {items.length > 1 && isViewMode && (
          <div className="modal-item-nav">
            <button type="button" className="modal-item-nav-btn" disabled={itemIdx === 0} onClick={() => { setItemIdx(i => i - 1); setActiveItem(items[itemIdx - 1]); }}>&larr;</button>
            <span>Item {itemIdx + 1} of {items.length}</span>
            <button type="button" className="modal-item-nav-btn" disabled={itemIdx === items.length - 1} onClick={() => { setItemIdx(i => i + 1); setActiveItem(items[itemIdx + 1]); }}>&rarr;</button>
          </div>
        )}

        <div className="track-4" style={{ maxWidth: 520, margin: '0 auto 22px' }}>
          <div className="filled-5" style={{ width: `${STEP_PROGRESS[step - 1]}%` }} />
        </div>

        {failedBiddingWarning && (
          <div style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
            {failedBiddingWarning}
          </div>
        )}

        {step === 1 && (
          <div className="form-grid">
            {/* LEFT COLUMN */}
            <div className="form-col">
              <div className="field-group">
                <label>PPMP Number</label>
                <input type="text" value={headerData.ppmp_no} readOnly />
              </div>

              <div className={`field-group ${errors.project_description ? 'error-state' : ''}`}>
                <label>General Description and Objective</label>
                <textarea
                  placeholder="Enter the objective of the project..."
                  value={activeItem.project_description}
                  disabled={isViewMode}
                  onChange={e => setActiveItem({ ...activeItem, project_description: e.target.value })}
                />
                {errors.project_description && <p className="text-45">{errors.project_description}</p>}
              </div>

              <div className={`field-group ${errors.object_name ? 'error-state' : ''}`}>
                <label>Object Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 5020301002"
                  value={activeItem.object_name}
                  disabled={isViewMode}
                  onChange={e => setActiveItem({ ...activeItem, object_name: e.target.value.replace(/\D/g, '') })}
                />
                {errors.object_name && <p className="text-45">{errors.object_name}</p>}
              </div>

              <div className="field-group">
                <label>Is Indicative or Final?</label>
                <select value={headerData.is_indicative} disabled={isViewMode} onChange={e => setHeaderData({ ...headerData, is_indicative: e.target.value })}>
                  <option value="Indicative">Indicative</option>
                  <option value="Final">Final</option>
                </select>
              </div>

              <div className="field-group">
                <label>End-User or Implementing Unit</label>
                <input type="text" value={headerData.end_user} readOnly />
              </div>

              <div className="field-group">
                <label>Fiscal Year</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={`e.g. ${new Date().getFullYear()}`}
                  value={headerData.fiscal_year}
                  disabled={isViewMode}
                  onChange={e => {
                    const fy = e.target.value.replace(/\D/g, '');
                    setHeaderData({ ...headerData, fiscal_year: fy, ...(recordId ? {} : { ppmp_no: nextPpmpNo(fy) }) });
                  }}
                />
              </div>

              <div className={`field-group ${errors.project_type ? 'error-state' : ''}`}>
                <label>Type of Project to be Procured</label>
                <select value={activeItem.project_type} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, project_type: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="Goods">Goods</option>
                  <option value="Infrastructure">Infrastructure</option>
                  <option value="Consulting Services">Consulting Services</option>
                </select>
                {errors.project_type && <p className="text-45">{errors.project_type}</p>}
              </div>
            </div>

            {/* RIGHT COLUMN */}
            <div className="form-col">
              <div className={`field-group ${errors.mode ? 'error-state' : ''}`}>
                <label>Recommended Mode of Procurement</label>
                <select
                  value={activeItem.mode}
                  disabled={isViewMode || !!failedBiddingWarning}
                  onChange={e => setActiveItem({ ...activeItem, mode: e.target.value })}
                >
                  <option value="">Select mode...</option>
                  {STANDARD_PROCUREMENT_MODES.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {(activeItem.mode?.includes('Two Failed Biddings') || !!failedBiddingWarning) && (
                    <option value={activeItem.mode || 'Negotiated Procurement – Two Failed Biddings'}>
                      {activeItem.mode || 'Negotiated Procurement – Two Failed Biddings'}
                    </option>
                  )}
                  {activeItem.mode &&
                    !STANDARD_PROCUREMENT_MODES.includes(activeItem.mode) &&
                    !activeItem.mode.includes('Two Failed Biddings') && (
                      <option value={activeItem.mode}>{activeItem.mode}</option>
                  )}
                </select>
                <p className="mode-hint">
                  Recommended by budget: &le;&#8369;199,999 &rarr; Direct Acquisition &middot; &#8369;200,000&ndash;&#8369;1,999,999 &rarr; Small Value Procurement (SVP) &middot; &#8369;2,000,000 and above &rarr; Competitive Bidding
                </p>
                {errors.mode && <p className="text-45">{errors.mode}</p>}
              </div>

              <div className={`field-group ${errors.pre_procurement ? 'error-state' : ''}`}>
                <label>Pre Procurement Conference?</label>
                <select value={activeItem.pre_procurement} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, pre_procurement: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
                {errors.pre_procurement && <p className="text-45">{errors.pre_procurement}</p>}
              </div>

              <div className={`field-group ${errors.bid_evaluation_criteria ? 'error-state' : ''}`}>
                <label>Criteria for Bid Evaluation (Including Sustainability and Domestic Preference)</label>
                <select
                  value={activeItem.bid_evaluation_criteria}
                  disabled={isViewMode || !!failedBiddingWarning}
                  onChange={e => setActiveItem({ ...activeItem, bid_evaluation_criteria: e.target.value })}
                >
                  <option value="">Select Criteria for Bid Evaluation...</option>
                  {BID_CRITERIA_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  {activeItem.bid_evaluation_criteria === 'Negotiated' && <option value="Negotiated">Negotiated</option>}
                </select>
                {errors.bid_evaluation_criteria && <p className="text-45">{errors.bid_evaluation_criteria}</p>}
              </div>

              <div className={`field-group ${errors.quantity_size ? 'error-state' : ''}`}>
                <label>Quantity and Size of the Project</label>
                <textarea
                  placeholder="e.g. 10 units, 2 lots, 500 sq.m."
                  value={activeItem.quantity_size}
                  disabled={isViewMode}
                  onChange={e => setActiveItem({ ...activeItem, quantity_size: e.target.value })}
                />
                {errors.quantity_size && <p className="text-45">{errors.quantity_size}</p>}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid">
            {/* LEFT COLUMN: timeline + budget classification */}
            <div className="form-col">
              {dateField('start_date', 'Advertisement/Posting of IB/REI (Start of Procurement Activity)')}
              {dateField('bid_opening_date', 'Submission/Opening of Bids')}
              {dateField('notice_of_award_date', 'Notice of Award')}
              {dateField('end_date', 'Contract Signing (End of Procurement Activity)')}
              {dateField('delivery_period', 'Expected Delivery/ Implementation Period')}

              <div className={`field-group ${errors.expense_class ? 'error-state' : ''}`}>
                <label>Budget Classification *</label>
                <select value={activeItem.expense_class} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, expense_class: e.target.value })}>
                  {EXPENSE_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {errors.expense_class && <p className="text-45">{errors.expense_class}</p>}
              </div>
            </div>

            {/* RIGHT COLUMN: funding */}
            <div className="form-col">
              <div className={`field-group ${errors.fund_source ? 'error-state' : ''}`}>
                <label>Source of Funds</label>
                <input type="text" value={activeItem.fund_source} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, fund_source: e.target.value })} />
                {errors.fund_source && <p className="text-45">{errors.fund_source}</p>}
              </div>

              <div className={`field-group ${errors.budget ? 'error-state' : ''}`}>
                <label>Estimated Budget / Budgetary Allocation</label>
                <div className="budget-wrap">
                  <span className="prefix">PHP</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={activeItem.budget}
                    disabled={isViewMode}
                    onChange={e => setActiveItem({ ...activeItem, budget: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') })}
                  />
                </div>
                {errors.budget && <p className="text-45">{errors.budget}</p>}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="step3-stack">
            <div className={`field-group ${errors.strategies ? 'error-state' : ''}`}>
              <label>Procurement Strategies and Tools</label>
              <p className="mode-hint" style={{ margin: '0 0 8px' }}>Click to toggle one or more strategies:</p>
              <div className="strategy-wrap">
                <div className="select-box" onClick={() => !isViewMode && setStratOpen(o => !o)}>
                  {(activeItem.strategies || []).length === 0
                    ? <span className="placeholder">Select strategies...</span>
                    : activeItem.strategies.map(s => <span key={s} className="tag">{s}</span>)}
                </div>
                {stratOpen && !isViewMode && (
                  <div className="options-list">
                    {STRATEGY_OPTIONS.map(s => (
                      <div key={s} className={`option ${(activeItem.strategies || []).includes(s) ? 'selected' : ''}`} onClick={() => toggleStrategy(s)}>
                        {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {errors.strategies && <p className="text-45">{errors.strategies}</p>}
            </div>

            <div className="field-group">
              <label>General Requirements/Miscellaneous/Common Supplies and Equipment</label>
              <select value={activeItem.general_requirements || ''} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, general_requirements: e.target.value })}>
                <option value="">Select (optional)...</option>
                {GENERAL_REQ_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <p className="mode-hint">Optional. Choose which one this PPMP item is, if any.</p>
            </div>

            <div className={`field-group ${errors.remarks ? 'error-state' : ''}`}>
              <label>Remarks</label>
              <textarea value={activeItem.remarks} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, remarks: e.target.value })} />
              {errors.remarks && <p className="text-45">{errors.remarks}</p>}
            </div>

            <div className={`field-group ${errors.supporting_documents ? 'error-state' : ''}`}>
              <label>Attached Supporting Documents</label>
              <div className="doc-type-hint" style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {docLabel ? `Required document: ${docLabel}` : 'Select a Type of Project in Step 1 to see the required document.'}
              </div>

              {!isViewMode && (
                <>
                  <div
                    className={`upload-zone ${dragOver ? 'drag-over' : ''} ${docs.length ? 'has-file' : ''}`}
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                  >
                    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <p style={{ margin: 0 }}>Drop here to attach or <span className="upload-link">upload</span></p>
                    <small>Max 10MB per file, 50MB total</small>
                  </div>
                  <input ref={fileInputRef} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
                </>
              )}

              {docs.length > 0 && (
                <ul className="uploaded-file-list">
                  {docs.map((d, i) => (
                    <li key={d.fileId || i} className="uploaded-file-item">
                      <span className="uploaded-file-info">{d.name}</span>
                      <span className="uploaded-file-size">{formatFileSize(d.size || 0)}</span>
                      {!isViewMode && <button type="button" className="remove-doc-btn" onClick={() => removeDoc(i)}>Remove</button>}
                    </li>
                  ))}
                </ul>
              )}
              {errors.supporting_documents && <p className="text-45">{errors.supporting_documents}</p>}
            </div>
          </div>
        )}

        <div className="footer-actions">
          {step > 1
            ? <button type="button" className="back-btn" onClick={() => setStep(s => s - 1)}>&larr; Back</button>
            : <button type="button" className="back-btn" onClick={onClose}>&larr; {isViewMode ? 'Close' : 'Cancel'}</button>}

          <div className="footer-right-actions">
            {isViewMode && recordId && (
              <button type="button" className="export-app-btn" onClick={exportPpmp}>Export PPMP</button>
            )}
            {step < 3 ? (
              <button type="button" className="next-btn" onClick={handleNext}>Next &rarr;</button>
            ) : (
              isViewMode
                ? <button type="button" className="next-btn" onClick={onClose}>Close</button>
                : <button type="button" className="next-btn" onClick={handleSave}>{recordId ? 'Save Changes' : 'Finish & Save'} &rarr;</button>
            )}
          </div>
        </div>

        {confirmDelete && (
          <div className="logout-overlay show" style={{ zIndex: 2000 }}>
            <div className="logout-modal" role="dialog" aria-modal="true">
              <div className="logout-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
              </div>
              <h3>Delete this item?</h3>
              <p>{items.length > 1 ? 'This item will be permanently removed from the PPMP.' : 'This is the only item in the PPMP, so the whole PPMP will be deleted.'}</p>
              <div className="logout-actions">
                <button type="button" className="logout-cancel-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="logout-confirm-btn" onClick={deleteCurrentItem}>Delete</button>
              </div>
            </div>
          </div>
        )}

        <div className={`db-toast ${notice ? 'show' : ''}`} style={{ zIndex: 2100 }}>{notice}</div>

        <BulkImportModal
          isOpen={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          headerData={headerData}
          recordId={recordId}
          onSuccess={(_result) => {
            setBulkModalOpen(false);
            if (onSaved) onSaved();
            onClose();
          }}
        />
      </div>
    </div>
  );
}