import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { getAppRecord, saveAppRecord } from '../../utils/procurementRules.js';
import { previewAPP_PDF, generateAPP_PDF } from '../../utils/pdfGenerator.js';

export default function AppPreviewModal({ isOpen, onClose, fiscalYear, onUpdated }) {
  const { user } = useAuth();
  const [blobUrl, setBlobUrl] = useState(null);
  const [appRecord, setAppRecord] = useState(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [reviewError, setReviewError] = useState('');

  useEffect(() => {
    if (!isOpen || !fiscalYear) return;
    const rec = getAppRecord(fiscalYear);
    setAppRecord(rec);

    previewAPP_PDF(fiscalYear).then(res => {
      if (res?.blob) {
        const u = URL.createObjectURL(res.blob);
        setBlobUrl(u);
      }
    });

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [isOpen, fiscalYear]);

  if (!isOpen || !appRecord) return null;

  const handleAction = (action) => {
    if (action !== 'approve' && !remarks.trim()) {
      setReviewError('Remarks are required to reject or add remarks.');
      return;
    }
    const updated = { ...appRecord };
    if (!Array.isArray(updated.remarksHistory)) updated.remarksHistory = [];

    updated.remarksHistory.push({
      stage: user.role,
      role: user.role,
      name: user.roleName,
      action,
      remarks: remarks || 'Approved.',
      date: new Date().toLocaleDateString(),
      at: Date.now()
    });

    if (action === 'reject') {
      updated.status = 'Draft';
      updated.currentApproverRole = null;
      updated.returned_for_revision = true;
      updated.rejected_by = { name: user.roleName, role: user.role };
      updated.rejected_at = Date.now();
    } else if (action === 'approve') {
      if (user.role === 'ARD') {
        updated.currentApproverRole = 'RD';
        updated.ard_approved_by = { name: user.roleName, role: user.role };
        updated.ard_approved_at = Date.now();
      } else if (user.role === 'RD') {
        updated.status = 'Completed';
        updated.currentApproverRole = 'None';
        updated.returned_for_revision = false;
        updated.approved_by = { name: user.roleName, role: user.role };
        updated.approved_at = Date.now();
      }
    }

    saveAppRecord(updated);
    setAppRecord(updated);
    setShowReviewDialog(false);
    if (onUpdated) onUpdated();
  };

  const submitApp = () => {
    const updated = {
      ...appRecord,
      status: 'For Approval',
      currentApproverRole: 'ARD',
      returned_for_revision: false,
      submitted_by: { name: user.roleName, role: user.role },
      submitted_at: Date.now()
    };
    saveAppRecord(updated);
    setAppRecord(updated);
    if (onUpdated) onUpdated();
  };

  return (
    <div className="app-preview-overlay show">
      <div className="app-preview-modal">
        <div className="app-preview-head">
          <div>
            <h3>Annual Procurement Plan (APP) — FY {fiscalYear}</h3>
            <span className={`db-status-pill ${appRecord.status === 'Completed' ? 'is-completed' : (appRecord.status === 'For Approval' ? 'is-pending' : 'is-draft')}`}>
              {appRecord.status === 'Completed' ? 'Final (Approved)' : (appRecord.status === 'For Approval' ? `In Review (${appRecord.currentApproverRole})` : 'Draft')}
            </span>
          </div>
          <button type="button" className="app-preview-x" onClick={onClose}>&times;</button>
        </div>

        <div className="app-preview-body">
          {blobUrl ? (
            <iframe src={`${blobUrl}#view=FitH`} className="app-preview-frame" title="APP Preview" />
          ) : (
            <p>Loading APP preview...</p>
          )}
        </div>

        <div className="app-preview-actions">
          <button type="button" className="app-preview-btn is-secondary" onClick={onClose}>Close</button>
          <span className="app-preview-spacer"></span>

          {user?.role === 'SUP' && appRecord.status === 'Draft' && (
            <button type="button" className="app-preview-btn" onClick={submitApp}>Submit APP for Review &rarr;</button>
          )}

          {((user?.role === 'ARD' && appRecord.currentApproverRole === 'ARD') || (user?.role === 'RD' && appRecord.currentApproverRole === 'RD')) && (
            <button type="button" className="app-preview-btn" onClick={() => setShowReviewDialog(true)}>Review & Decide &rarr;</button>
          )}

          {appRecord.status === 'Completed' && (
            <button type="button" className="app-preview-btn" onClick={() => generateAPP_PDF(fiscalYear)}>Download Final APP (PDF)</button>
          )}
        </div>
      </div>

      {showReviewDialog && (
        <div className="logout-overlay show">
          <div className="logout-modal review-modal">
            <h3>Review APP FY {fiscalYear}</h3>
            <p>{user.role === 'ARD' ? 'Endorse to Regional Director or Reject.' : 'Grant Final Approval or Reject.'}</p>
            <div className="review-field">
              <label>Remarks</label>
              <textarea value={remarks} onChange={e => { setRemarks(e.target.value); setReviewError(''); }} placeholder="Enter remarks..." />
              {reviewError && <p className="review-error" style={{ display: 'block' }}>{reviewError}</p>}
            </div>
            <div className="review-actions">
              <button type="button" className="logout-cancel-btn" onClick={() => setShowReviewDialog(false)}>Cancel</button>
              <button type="button" className="logout-confirm-btn is-reject" onClick={() => handleAction('reject')}>Reject</button>
              <button type="button" className="logout-confirm-btn is-approve" onClick={() => handleAction('approve')}>Approve</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}