import React, { useState, useEffect } from 'react';
import Sidebar from '../components/layout/Sidebar.jsx';
import RequestModal from '../components/modals/RequestModal.jsx';
import AppPreviewModal from '../components/modals/AppPreviewModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import {
  formatPeso,
  calculateDeduplicatedBudget,
  getAllAppRecords,
  getAppRecord,
  getLatestApprovedPpmpPerOffice,
  getRecordItems
} from '../utils/procurementRules';

export default function Dashboard() {
  const { user, isAppAuthorized } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [records, setRecords] = useState([]);
  const [apps, setApps] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [appModalYear, setAppModalYear] = useState(null);

  const loadData = () => {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    if (!user) return;

    // Filter PPMPs by role
    const filtered = all.filter(r => {
      if (user.canRequest && r.end_user === user.office) return true;
      if (r.status === 'Completed' && !user.canRequest) return true;
      if (user.canTrackApprovals && ['For Approval', 'Completed'].includes(r.status)) return true;
      if (user.canApprove && r.status === 'For Approval') {
        if (user.stage === 'HEAD' && r.end_user !== user.headOf) return false;
        return true;
      }
      return false;
    });
    setRecords(filtered);

    // APP Records
    const appRecs = getAllAppRecords();
    const approvedYears = [...new Set(all.filter(r => r.status === 'Completed').map(r => String(r.fiscal_year)))];
    const map = new Map();
    appRecs.forEach(a => map.set(String(a.fiscal_year), a));
    approvedYears.forEach(y => { if (!map.has(y)) map.set(y, getAppRecord(y)); });
    setApps(Array.from(map.values()));
  };

  useEffect(() => { loadData(); }, [user]);

  const isSupplier = user?.role === 'SUP';
  const totalRequests = isSupplier ? apps.length : records.length;
  const pendingRequests = isSupplier ? apps.filter(a => a.status !== 'Completed').length : records.filter(r => r.status !== 'Completed').length;
  const completedRequests = isSupplier ? apps.filter(a => a.status === 'Completed').length : records.filter(r => r.status === 'Completed').length;

  const totalBudget = isSupplier
    ? apps.reduce((s, a) => {
        const approved = records.filter(r => r.status === 'Completed');
        const relevant = getLatestApprovedPpmpPerOffice(approved, a.fiscal_year);
        return s + relevant.reduce((sum, r) => sum + calculateDeduplicatedBudget(getRecordItems(r)), 0);
      }, 0)
    : records.reduce((s, r) => s + calculateDeduplicatedBudget(getRecordItems(r)), 0);

  return (
    <div className="db-body">
      <Sidebar onNewRequest={() => { setSelectedRecordId(null); setModalOpen(true); }} />

      <main className="db-main">
        <div className="db-header-banner">
          <img src="/images/header-banner.png" alt="DICT Banner" />
        </div>

        <div className="db-topbar">
          <div>
            <h1 className="db-title">Procurement Dashboard</h1>
            <p className="db-subtitle">Welcome back, {user?.roleName}</p>
          </div>
          <div className="db-topbar-actions">
            <button type="button" className="db-icon-btn" onClick={toggleTheme} title="Toggle theme">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>
        {/* Welcome card with New Request button */}
<div className="db-welcome-card">
  <div>
    <h2>Good day, {user?.roleName}!</h2>
    <p>Here's a quick look at your procurement requests and activity.</p>
  </div>
  {user?.canRequest && (
    <button
      type="button"
      className="db-new-request-btn"
      onClick={() => { setSelectedRecordId(null); setModalOpen(true); }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      New Request
    </button>
  )}
</div>
        {/* Stats Grid */}
        <div className="db-stats-grid">
          <div className="db-stat-card db-stat-blue">
            <div className="db-stat-head">
              <span className="db-stat-label">{isSupplier ? 'Total APP Versions' : 'Total PPMP Versions'}</span>
            </div>
            <p className="db-stat-value">{totalRequests}</p>
          </div>
          <div className="db-stat-card db-stat-amber">
            <div className="db-stat-head">
              <span className="db-stat-label">Pending / In Review</span>
            </div>
            <p className="db-stat-value">{pendingRequests}</p>
          </div>
          <div className="db-stat-card db-stat-green">
            <div className="db-stat-head">
              <span className="db-stat-label">Fully Approved</span>
            </div>
            <p className="db-stat-value">{completedRequests}</p>
          </div>
          <div className="db-stat-card db-stat-violet">
            <div className="db-stat-head">
              <span className="db-stat-label">{isSupplier ? 'Total APP Budget' : 'Total Estimated Budget'}</span>
            </div>
            <p className="db-stat-value">{formatPeso(totalBudget)}</p>
          </div>
        </div>

        {/* Dedicated APP Section for SUP, ARD, and RD */}
        {isAppAuthorized && (
          <div className="db-activity-card" style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Annual Procurement Plans (APP)</h3>
              <span style={{ fontSize: 12, color: 'var(--db-text-faint)' }}>{apps.length} plan(s)</span>
            </div>
            {apps.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--db-text-dim)' }}>No APPs compiled yet.</p>
            ) : (
              apps.map(app => (
                <div key={app.fiscal_year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--db-border)' }}>
                  <div>
                    <strong>Annual Procurement Plan FY {app.fiscal_year}</strong>
                    <div style={{ fontSize: 12, color: 'var(--db-text-dim)', marginTop: 2 }}>
                      Status: <span className={`db-status-pill ${app.status === 'Completed' ? 'is-completed' : (app.status === 'For Approval' ? 'is-pending' : 'is-draft')}`}>{app.status}</span>
                    </div>
                  </div>
                  <button type="button" className="db-action-btn" style={{ padding: '6px 14px', width: 'auto' }} onClick={() => setAppModalYear(app.fiscal_year)}>
                    View APP &rarr;
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Recent Activity */}
        <div className="db-activity-card">
          <h3>Recent Procurement Activity</h3>
          <ul className="db-activity-list">
            {records.length === 0 ? (
              <li className="db-activity-empty">No activity recorded yet.</li>
            ) : (
              records.slice(0, 6).map(r => (
                <li key={r.id} className="db-activity-item">
                  <div>
                    <strong>PPMP No. {r.ppmp_no} — {r.end_user}</strong>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--db-text-dim)' }}>
                      FY {r.fiscal_year} &bull; Status: {r.status}
                    </span>
                  </div>
                  <button type="button" className="db-action-btn" onClick={() => { setSelectedRecordId(r.id); setModalOpen(true); }}>
                    View Details
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </main>

      <RequestModal isOpen={modalOpen} onClose={() => setModalOpen(false)} recordId={selectedRecordId} onSaved={loadData} />
      {appModalYear && <AppPreviewModal isOpen={!!appModalYear} onClose={() => setAppModalYear(null)} fiscalYear={appModalYear} onUpdated={loadData} />}
    </div>
  );
}