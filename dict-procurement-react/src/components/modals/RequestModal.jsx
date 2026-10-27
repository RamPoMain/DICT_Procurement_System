import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  parseBudgetNumber,
  formatPesoMessage,
  PROCUREMENT_MODE_RULES,
  isBracketMismatch,
  exceedsModeCeiling,
  budgetBracketMessage,
  getRecommendedMode,
  claimEntryRef,
  findExistingReferenceInfo,
  getRecordItems
} from '../../utils/procurementRules.js';
import FileStore from '../../utils/fileStore.js';

export default function RequestModal({ isOpen, onClose, recordId = null, onSaved }) {
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

  function createBlankItem() {
    return {
      id: Date.now(),
      project_description: '',
      object_name: '',
      project_type: '',
      mode: '',
      pre_procurement: 'No',
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
      supporting_documents: []
    };
  }

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setErrors({});
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
      }
    } else {
      setIsViewMode(false);
      const fresh = createBlankItem();
      setItems([fresh]);
      setItemIdx(0);
      setActiveItem(fresh);
      setHeaderData({
        ppmp_no: 'Auto',
        fiscal_year: new Date().getFullYear().toString(),
        end_user: user?.office || '',
        is_indicative: 'Indicative'
      });
    }
  }, [isOpen, recordId]);

  // Live detection of Two Failed Biddings under RA 12009 Sec. 33
  useEffect(() => {
    if (isViewMode) return;
    const desc = activeItem.project_description.trim();
    if (!desc) {
      setFailedBiddingWarning('');
      return;
    }
    const refInfo = findExistingReferenceInfo(desc, activeItem.project_type, null, user?.office);
    if (refInfo && refInfo.competitiveCount >= 2) {
      setActiveItem(prev => ({
        ...prev,
        mode: 'Negotiated Procurement – Two Failed Biddings',
        bid_evaluation_criteria: 'Negotiated'
      }));
      setFailedBiddingWarning(`Matches ${refInfo.reference_no}: 2 failed biddings detected. Mode is locked to Negotiated Procurement – Two Failed Biddings (Sec. 33).`);
    } else {
      setFailedBiddingWarning('');
    }
  }, [activeItem.project_description, activeItem.project_type]);

  if (!isOpen) return null;

  const validateCurrentStep = () => {
    const errs = {};
    if (step === 1) {
      if (!activeItem.project_description) errs.project_description = 'Description is required';
      if (!activeItem.object_name || !/^\d+$/.test(activeItem.object_name)) errs.object_name = 'Object Code must be numbers only';
      if (!activeItem.project_type) errs.project_type = 'Select a Project Type';
      if (!activeItem.mode) errs.mode = 'Select a Procurement Mode';
      if (!activeItem.quantity_size) errs.quantity_size = 'Quantity and size required';

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
    }
    if (step === 3) {
      const b = parseBudgetNumber(activeItem.budget);
      if (!b || b <= 0) errs.budget = 'Budget must be greater than 0';
      if (isBracketMismatch(activeItem.mode, b)) errs.budget = budgetBracketMessage(activeItem.mode, b);
      if (exceedsModeCeiling(activeItem.mode, b)) errs.budget = `Exceeds allowable budget for ${activeItem.mode}`;
      if (!activeItem.fund_source) errs.fund_source = 'Source of Funds is required';
      if (!activeItem.remarks) errs.remarks = 'Remarks are required';
      if (!activeItem.supporting_documents?.length) errs.supporting_documents = 'At least one supporting document required';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (validateCurrentStep()) setStep(s => s + 1);
  };

  const handleSave = () => {
    if (!validateCurrentStep()) return;
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const updatedItems = [...items];
    const finalItem = { ...activeItem };

    if (!finalItem.reference_no) {
      finalItem.reference_no = claimEntryRef(records, finalItem.project_type, headerData.fiscal_year);
    }
    updatedItems[itemIdx] = finalItem;

    if (recordId) {
      const idx = records.findIndex(r => r.id === recordId);
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

    localStorage.setItem('procurement_records', JSON.stringify(records));
    if (onSaved) onSaved();
    onClose();
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const fileId = FileStore.newId();
      await FileStore.put(fileId, file);
      setActiveItem(prev => ({
        ...prev,
        supporting_documents: [...prev.supporting_documents, { name: file.name, size: file.size, type: file.type, fileId }]
      }));
    }
  };

  return (
    <div className="db-modal-overlay">
      <div className="db-modal">
        <button type="button" className="db-modal-close" onClick={onClose}>&times;</button>

        <div className="title-tab-wrapper">
          <span className="text-9">
            {step === 1 && 'PROCUREMENT PROJECT DETAILS'}
            {step === 2 && 'PROJECTED TIMELINE'}
            {step === 3 && 'FUNDING & ATTACHMENTS'}
          </span>
        </div>

        {items.length > 1 && (
          <div className="modal-item-nav">
            <button disabled={itemIdx === 0} onClick={() => { setItemIdx(i => i - 1); setActiveItem(items[itemIdx - 1]); }}>&larr;</button>
            <span>Item {itemIdx + 1} of {items.length}</span>
            <button disabled={itemIdx === items.length - 1} onClick={() => { setItemIdx(i => i + 1); setActiveItem(items[itemIdx + 1]); }}>&rarr;</button>
          </div>
        )}

        {failedBiddingWarning && (
          <div style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
            {failedBiddingWarning}
          </div>
        )}

        {step === 1 && (
          <div className="form-grid">
            <div className="field-group">
              <label>Fiscal Year</label>
              <input type="text" value={headerData.fiscal_year} disabled={isViewMode} onChange={e => setHeaderData({ ...headerData, fiscal_year: e.target.value })} />
            </div>
            <div className="field-group">
              <label>Type</label>
              <select value={headerData.is_indicative} disabled={isViewMode} onChange={e => setHeaderData({ ...headerData, is_indicative: e.target.value })}>
                <option value="Indicative">Indicative</option>
                <option value="Final">Final</option>
              </select>
            </div>
            <div className="field-group" style={{ gridColumn: 'span 2' }}>
              <label>General Description</label>
              <textarea value={activeItem.project_description} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, project_description: e.target.value })} />
              {errors.project_description && <p className="text-45">{errors.project_description}</p>}
            </div>
            <div className="field-group">
              <label>Object Code</label>
              <input type="text" value={activeItem.object_name} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, object_name: e.target.value })} />
              {errors.object_name && <p className="text-45">{errors.object_name}</p>}
            </div>
            <div className="field-group">
              <label>Type of Project</label>
              <select value={activeItem.project_type} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, project_type: e.target.value })}>
                <option value="">Select...</option>
                <option value="Goods">Goods</option>
                <option value="Infrastructure">Infrastructure</option>
                <option value="Consulting Services">Consulting Services</option>
              </select>
            </div>
            <div className="field-group">
              <label>Recommended Mode of Procurement</label>
              <select value={activeItem.mode} disabled={isViewMode || !!failedBiddingWarning} onChange={e => setActiveItem({ ...activeItem, mode: e.target.value })}>
                <option value="">Select...</option>
                {Object.keys(PROCUREMENT_MODE_RULES).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              {errors.mode && <p className="text-45">{errors.mode}</p>}
            </div>
            <div className="field-group">
              <label>Quantity and Size</label>
              <input type="text" value={activeItem.quantity_size} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, quantity_size: e.target.value })} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid">
            <div className="field-group">
              <label>Advertisement/Posting</label>
              <input type="date" value={activeItem.start_date} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, start_date: e.target.value })} />
            </div>
            <div className="field-group">
              <label>Submission/Opening of Bids</label>
              <input type="date" value={activeItem.bid_opening_date} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, bid_opening_date: e.target.value })} />
              {errors.bid_opening_date && <p className="text-45">{errors.bid_opening_date}</p>}
            </div>
            <div className="field-group">
              <label>Notice of Award</label>
              <input type="date" value={activeItem.notice_of_award_date} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, notice_of_award_date: e.target.value })} />
              {errors.notice_of_award_date && <p className="text-45">{errors.notice_of_award_date}</p>}
            </div>
            <div className="field-group">
              <label>Contract Signing</label>
              <input type="date" value={activeItem.end_date} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, end_date: e.target.value })} />
              {errors.end_date && <p className="text-45">{errors.end_date}</p>}
            </div>
            <div className="field-group" style={{ gridColumn: 'span 2' }}>
              <label>Expected Delivery Period</label>
              <input type="date" value={activeItem.delivery_period} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, delivery_period: e.target.value })} />
              {errors.delivery_period && <p className="text-45">{errors.delivery_period}</p>}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="form-grid">
            <div className="field-group">
              <label>Source of Funds</label>
              <input type="text" value={activeItem.fund_source} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, fund_source: e.target.value })} />
            </div>
            <div className="field-group">
              <label>Estimated Budget (PhP)</label>
              <input type="text" value={activeItem.budget} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, budget: e.target.value })} />
              {errors.budget && <p className="text-45">{errors.budget}</p>}
            </div>
            <div className="field-group" style={{ gridColumn: 'span 2' }}>
              <label>Supporting Documents</label>
              {!isViewMode && <input type="file" multiple onChange={handleFileUpload} />}
              <ul style={{ fontSize: 12, marginTop: 6 }}>
                {activeItem.supporting_documents.map((d, i) => <li key={i}>{d.name} ({Math.round(d.size / 1024)} KB)</li>)}
              </ul>
              {errors.supporting_documents && <p className="text-45">{errors.supporting_documents}</p>}
            </div>
            <div className="field-group" style={{ gridColumn: 'span 2' }}>
              <label>Remarks</label>
              <textarea value={activeItem.remarks} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, remarks: e.target.value })} />
            </div>
          </div>
        )}

        <div className="footer-actions">
          {step > 1 && <button type="button" className="back-btn" onClick={() => setStep(s => s - 1)}>&larr; Back</button>}
          {step < 3 ? (
            <button type="button" className="next-btn" onClick={handleNext}>Next &rarr;</button>
          ) : (
            !isViewMode && <button type="button" className="next-btn" onClick={handleSave}>Finish & Save</button>
          )}
        </div>
      </div>
    </div>
  );
}