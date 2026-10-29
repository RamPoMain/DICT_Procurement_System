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
  getRecordItems,
  getPpmpStatus,
  isPpmpReturned,
  formatApprovalDate,
  getApprovalStep
} from '../utils/procurementRules';
import { getVisibleRecords } from '../utils/dashboardHelpers';
import { exportPPMP_Excel, exportEntriesExcel } from '../utils/entriesExport';
import { exportAppTemplateExcel } from '../utils/appTemplateExport';
import { generatePPMP_PDF } from '../utils/pdfGenerator';

export default function Entries() {
  const { user, isAppAuthorized } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState(user?.role === 'SUP' ? 'app' : 'ppmp');
  const [records, setRecords] = useState([]);
  const [apps, setApps] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [expandedId, setExpandedId] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [appModalYear, setAppModalYear] = useState(null);

  const loadData = () => {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    setRecords(getVisibleRecords(all, user));
    setApps(getAllAppRecords());
  };

  useEffect(() => { loadData(); }, [user]);

  const filteredRecords = records.filter(r => {
    if (statusFilter !== 'All' && getPpmpStatus(r) !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const match = (r.ppmp_no + ' ' + r.end_user + ' ' + r.fiscal_year).toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });

  return (
    <div className="db-body">
      <Sidebar onNewRequest={() => { setSelectedRecordId(null); setModalOpen(true); }} />

      <main className="db-main">
        <div className="db-topbar">
          <div>
            <h1 className="db-title">Procurement Entries</h1>
            <p className="db-subtitle">Consolidated view of all requests and compiled plans</p>
          </div>
          <div className="db-topbar-actions">
            
            {user?.role === 'SUP' && (
              <button type="button" className="db-btn is-secondary" onClick={() => exportAppTemplateExcel(new Date().getFullYear(), user)}>
                Export APP Template (.xlsx)
              </button>
            )}
            <button type="button" className="db-icon-btn" onClick={toggleTheme}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>

        <div className="db-entries-card">
          <div className="db-entries-tabs">
            <button type="button" className={`db-tab-btn ${tab === 'ppmp' ? 'active' : ''}`} onClick={() => setTab('ppmp')}>
              PPMP Requests
            </button>
            <button type="button" className={`db-tab-btn ${tab === 'app' ? 'active' : ''}`} onClick={() => setTab('app')}>
              Annual Procurement Plans (APP)
            </button>
          </div>

          {tab === 'ppmp' && (
            <>
              <div className="db-entry-tools" style={{ marginBottom: 14 }}>
                <div className="db-filter-control">
                  <span>Status</span>
                  <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                    <option value="All">All Statuses</option>
                    <option value="Draft">Draft</option>
                    <option value="For Approval">For Approval</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div className="db-filter-control db-search-control">
                  <span>Search</span>
                  <input type="text" placeholder="Search entries..." value={search} onChange={e => setSearch(e.target.value)} />
                </div>
              </div>

              <div className="db-entries-table-wrap">
                <table className="db-entries-table">
                  <thead>
                    <tr>
                      <th>PPMP No.</th>
                      <th>End-User</th>
                      <th>Fiscal Year</th>
                      <th>Type</th>
                      <th>Budget</th>
                      <th>Status</th>
                      <th>Approved By</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(r => (
                      <React.Fragment key={r.id}>
                        <tr>
                          <td style={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                            {expandedId === r.id ? '▼' : '▶'} PPMP No. {r.ppmp_no}
                          </td>
                          <td>{r.end_user}</td>
                          <td>{r.fiscal_year}</td>
                          <td>{r.is_indicative}</td>
                          <td>{formatPeso(calculateDeduplicatedBudget(getRecordItems(r)))}</td>
                          <td>
                            {isPpmpReturned(r) ? (
                              <span
                                className="db-status-pill is-returned"
                                title={`Returned by ${r.rejected_by?.name || 'an approver'} - open the PPMP to read the remarks`}
                              >
                                Returned
                              </span>
                            ) : r.status === 'For Approval' && user?.canTrackApprovals ? (
                              <span className="db-status-pill is-pending">
                                For Approval · {getApprovalStep(r.currentApproverRole)?.label || r.currentApproverRole}
                              </span>
                            ) : (
                              <span className={`db-status-pill ${r.status === 'Completed' ? 'is-completed' : (r.status === 'For Approval' ? 'is-pending' : 'is-draft')}`}>
                                {r.status}
                              </span>
                            )}
                          </td>
                          <td>
                            {r.status !== 'Completed' ? (
                              <span className="db-approver-none">—</span>
                            ) : r.approved_by ? (
                              <div className="db-approver">
                                <strong>{r.approved_by.name}</strong>
                                <span>{formatApprovalDate(r.approved_at)}</span>
                              </div>
                            ) : (
                              <span className="db-approver-none" title="This PPMP was completed before approver tracking existed">Not recorded</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button" className="db-action-btn" title="View details" onClick={() => { setSelectedRecordId(r.id); setModalOpen(true); }}>
                                View
                              </button>
                              <button type="button" className="db-action-btn" title="Export PDF" onClick={() => generatePPMP_PDF(r)}>
                                PDF
                              </button>
                              <button type="button" className="db-action-btn" title="Export Excel" onClick={() => exportPPMP_Excel(r)}>
                                XLSX
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* Inline Expandable Sheet */}
                        {expandedId === r.id && (
                          <tr className="db-entry-expand-row">
                            <td colSpan="8" style={{ padding: 12, background: 'var(--db-card-alt)' }}>
                              <div style={{ overflowX: 'auto' }}>
                                <table className="db-entries-table" style={{ background: '#fff', color: '#000' }}>
                                  <thead>
                                    <tr>
                                      <th>Ref No.</th>
                                      <th>Description</th>
                                      <th>Type</th>
                                      <th>Mode</th>
                                      <th>Budget (PhP)</th>
                                      <th>Remarks</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {getRecordItems(r).map((it, i) => (
                                      <tr key={i}>
                                        <td>{it.reference_no || '—'}</td>
                                        <td>{it.project_description}</td>
                                        <td>{it.project_type}</td>
                                        <td>{it.mode}</td>
                                        <td>{it.budget}</td>
                                        <td>{it.remarks}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'app' && (
            <div className="db-entries-table-wrap">
              <table className="db-entries-table">
                <thead>
                  <tr>
                    <th>Fiscal Year</th>
                    <th>Plan Title</th>
                    <th>Status</th>
                    <th>Current Approver</th>
                    <th>Submitted By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map(a => (
                    <tr key={a.fiscal_year}>
                      <td>FY {a.fiscal_year}</td>
                      <td>Annual Procurement Plan for FY {a.fiscal_year}</td>
                      <td>
                        <span className={`db-status-pill ${a.status === 'Completed' ? 'is-completed' : (a.status === 'For Approval' ? 'is-pending' : 'is-draft')}`}>
                          {a.status}
                        </span>
                      </td>
                      <td>{a.currentApproverRole || '—'}</td>
                      <td>{a.submitted_by?.name || '—'}</td>
                      <td>
                        <button type="button" className="db-action-btn" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => setAppModalYear(a.fiscal_year)}>
                          Open APP &rarr;
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      <RequestModal isOpen={modalOpen} onClose={() => setModalOpen(false)} recordId={selectedRecordId} onSaved={loadData} />
      {appModalYear && <AppPreviewModal isOpen={!!appModalYear} onClose={() => setAppModalYear(null)} fiscalYear={appModalYear} onUpdated={loadData} />}
    </div>
  );
}