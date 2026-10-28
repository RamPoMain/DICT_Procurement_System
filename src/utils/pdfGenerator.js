import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import {
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  parseBudgetNumber,
  formatPesoExact,
  calculateDeduplicatedBudget,
  getAppRecord
} from './procurementRules.js';

export async function generatePPMP_PDF(record) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const items = getRecordItems(record);
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  let currentY = 25;

  try {
    const res = await fetch('/images/header-banner.png');
    const blob = await res.blob();
    const imgData = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(blob); });
    doc.addImage(imgData, 'PNG', (pageWidth - 277) / 2, 5, 277, 24);
    currentY = 34;
  } catch (e) {}

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${record.ppmp_no || 'N/A'}`, pageWidth / 2, currentY, { align: 'center' });

  currentY += 6;
  doc.setFontSize(9);
  doc.rect(130, currentY - 3, 4, 4);
  if (record.is_indicative === 'Indicative') doc.text('X', 131, currentY);
  doc.text('INDICATIVE', 136, currentY);

  doc.rect(165, currentY - 3, 4, 4);
  if (record.is_indicative === 'Final') doc.text('X', 166, currentY);
  doc.text('FINAL', 171, currentY);

  currentY += 8;
  doc.setFontSize(10);
  doc.text(`Fiscal Year : ${record.fiscal_year || 'N/A'}`, margin, currentY);
  doc.text(`End-User or Implementing Unit:  ${record.end_user || 'N/A'}`, margin, currentY + 5);

  const formattedTotal = formatPesoExact(calculateDeduplicatedBudget(items));
  const headers = [
    [
      { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: { halign: 'center' } },
      { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 5, styles: { halign: 'center' } },
      { content: 'FUNDING DETAILS', colSpan: 2, styles: { halign: 'center' } },
      { content: 'PROCUREMENT STRATEGIES AND TOOLS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
      { content: 'ATTACHED SUPPORTING DOCUMENTS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
      { content: 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
      { content: 'REMARKS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } }
    ],
    [
      'General Description and Objective', 'Type of Project', 'Quantity and Size',
      'Recommended Mode', 'Pre-Procurement (Yes/No)', 'Criteria for Bid Evaluation',
      'Advertisement/Posting', 'Submission/Opening', 'Notice of Award', 'Contract Signing',
      'Expected Delivery', 'Source of Funds', 'Estimated Budget (PhP)'
    ],
    Array.from({ length: 17 }, (_, i) => `Column ${i + 1}`)
  ];

  const bodyRows = items.map(it => [
    it.project_description || '', it.project_type || '', it.quantity_size || '', it.mode || '',
    it.pre_procurement || '', it.bid_evaluation_criteria || 'N/A', it.start_date || '',
    it.bid_opening_date || '', it.notice_of_award_date || '', it.end_date || '', it.delivery_period || '',
    it.fund_source || '', `P ${parseBudgetNumber(it.budget).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`,
    Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || 'None'),
    Array.isArray(it.supporting_documents) ? it.supporting_documents.map(d => d.name).join('\n') : 'None',
    it.general_requirements || '', it.remarks || ''
  ]);

  bodyRows.push([
    { content: 'TOTAL BUDGET:', colSpan: 12, styles: { halign: 'right', fontStyle: 'bold' } },
    { content: formattedTotal, styles: { fontStyle: 'bold', halign: 'right' } },
    '', '', '', ''
  ]);

  doc.autoTable({
    startY: currentY + 10,
    head: headers,
    body: bodyRows,
    theme: 'grid',
    styles: { fontSize: 6, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', halign: 'center' }
  });

  const finalY = doc.lastAutoTable.finalY + 12;
  doc.setFontSize(7);
  doc.text('Prepared by / Submitted by:', margin, finalY);
  doc.line(margin, finalY + 8, margin + 60, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text('JAYMARK D. DUMIO', margin + 30, finalY + 12, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.text('Endorsed by:', pageWidth / 2 - 30, finalY);
  doc.line(pageWidth / 2 - 35, finalY + 8, pageWidth / 2 + 25, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text('EUGENE C. RAPOSALA III', pageWidth / 2 - 5, finalY + 12, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.text('Certified Funds Available:', pageWidth - 70, finalY);
  doc.line(pageWidth - 70, finalY + 8, pageWidth - margin, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text('BRYAN JOHN M. SABLAS', pageWidth - 35, finalY + 12, { align: 'center' });

  doc.save(`PPMP_${record.ppmp_no}_${String(record.end_user).replace(/[^\w-]+/g, '_')}.pdf`);
}

export async function buildAPP_PDF(targetYear = null) {
  const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const approved = records.filter(r => r.status === 'Completed');
  const fiscalYear = String(targetYear || (approved[0]?.fiscal_year) || new Date().getFullYear());
  const relevantRecords = getLatestApprovedPpmpPerOffice(approved, fiscalYear);
  const appRecord = getAppRecord(fiscalYear);
  const isFinalApp = appRecord.status === 'Completed';

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  let currentY = 25;

  try {
    const res = await fetch('/images/header-banner.png');
    const blob = await res.blob();
    const imgData = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result); rd.readAsDataURL(blob); });
    doc.addImage(imgData, 'PNG', (pageWidth - 277) / 2, 5, 277, 22);
    currentY = 32;
  } catch (e) {}

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`ANNUAL PROCUREMENT PLAN FOR FY ${fiscalYear}`, pageWidth / 2, currentY, { align: 'center' });

  currentY += 6;
  doc.setFontSize(9);
  doc.rect(pageWidth / 2 - 38, currentY - 3.5, 4, 4);
  if (!isFinalApp) doc.text('X', pageWidth / 2 - 37, currentY - 0.5);
  doc.text('INDICATIVE', pageWidth / 2 - 32, currentY);

  doc.rect(pageWidth / 2 + 5, currentY - 3.5, 4, 4);
  if (isFinalApp) doc.text('X', pageWidth / 2 + 6, currentY - 0.5);
  doc.text('FINAL', pageWidth / 2 + 11, currentY);

  currentY += 8;

  let allItems = [];
  relevantRecords.forEach(r => {
    getRecordItems(r).forEach(it => allItems.push({ ...it, end_user: r.end_user }));
  });

  // Automated GPPB routing
  const generalItems = [];
  const miscItems = [];
  const cseItems = [];

  allItems.forEach(it => {
    const eu = String(it.end_user || '').toLowerCase();
    const mode = String(it.mode || '').toLowerCase();
    if (eu.includes('general administration') || eu.includes('gass') || it.general_requirements === 'Common Supplies and Equipment') {
      cseItems.push(it);
    } else if (mode.includes('direct acquisition') || it.general_requirements === 'Miscellaneous') {
      miscItems.push(it);
    } else {
      generalItems.push(it);
    }
  });

  const headers = [
    [
      { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: { halign: 'center' } },
      { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 4, styles: { halign: 'center' } },
      { content: 'FUNDING DETAILS', colSpan: 2, styles: { halign: 'center' } },
      { content: 'PROCUREMENT STRATEGY OR TOOLS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
      { content: 'REMARKS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } }
    ],
    [
      'Project Title', 'End-User Unit', 'General Description', 'Mode of Procurement',
      'EPA? (Yes/No)', 'Criteria for Bid Evaluation', 'Advertisement/Posting',
      'Submission/Opening', 'Notice of Award', 'Contract Signing', 'Source of Fund',
      'Estimated Budget (PhP)'
    ],
    Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`)
  ];

  const mapAppRow = it => [
    it.quantity_size ? `${it.project_description} (${it.quantity_size})` : (it.project_description || 'N/A'),
    it.end_user || 'N/A', it.project_type || 'N/A', it.mode || 'N/A',
    it.pre_procurement || 'No', it.bid_evaluation_criteria || 'N/A',
    it.start_date || '', it.bid_opening_date || '', it.notice_of_award_date || '', it.end_date || '',
    it.fund_source || 'N/A', `P ${parseBudgetNumber(it.budget).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`,
    Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || ''),
    it.remarks || ''
  ];

  const tableBody = [
    [{ content: 'General Requirements', colSpan: 14, styles: { fontStyle: 'bold', fillColor: [245, 245, 245] } }],
    ...(generalItems.length ? generalItems.map(mapAppRow) : [['', '', '', '', '', '', '', '', '', '', '', '', '', '']]),
    [{ content: 'Miscellaneous Items (for Direct Acquisition only) Sec 32.2 of RA No. 12009', colSpan: 14, styles: { fontStyle: 'bold', fillColor: [245, 245, 245] } }],
    ...(miscItems.length ? miscItems.map(mapAppRow) : [['', '', '', '', '', '', '', '', '', '', '', '', '', '']]),
    [{ content: 'Common Supplies and Equipment (CSE)', colSpan: 14, styles: { fontStyle: 'bold', fillColor: [245, 245, 245] } }],
    ...(cseItems.length ? cseItems.map(mapAppRow) : [['', '', '', '', '', '', '', '', '', '', '', '', '', '']]),
    [
      { content: 'TOTAL BUDGET:', colSpan: 11, styles: { halign: 'right', fontStyle: 'bold' } },
      { content: formatPesoExact(allItems.reduce((s, it) => s + parseBudgetNumber(it.budget), 0)), styles: { halign: 'right', fontStyle: 'bold' } },
      '', ''
    ]
  ];

  doc.autoTable({
    startY: currentY,
    head: headers,
    body: tableBody,
    theme: 'grid',
    styles: { fontSize: 5.5, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'bold', halign: 'center' }
  });

  const finalY = doc.lastAutoTable.finalY + 12;
  doc.setFontSize(7);
  doc.text('Prepared by / Submitted by:', margin, finalY);
  doc.line(margin, finalY + 8, margin + 60, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text(appRecord.submitted_by?.name || 'SUPPLY OFFICER II', margin + 30, finalY + 12, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.text('Endorsed by:', pageWidth / 2 - 30, finalY);
  doc.line(pageWidth / 2 - 35, finalY + 8, pageWidth / 2 + 25, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text(appRecord.ard_approved_by?.name || 'ASSISTANT REGIONAL DIRECTOR', pageWidth / 2 - 5, finalY + 12, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.text('Approved by:', pageWidth - 70, finalY);
  doc.line(pageWidth - 70, finalY + 8, pageWidth - margin, finalY + 8);
  doc.setFont('helvetica', 'bold');
  doc.text(appRecord.approved_by?.name || 'REGIONAL DIRECTOR', pageWidth - 35, finalY + 12, { align: 'center' });

  return { doc, fiscalYear, fileName: `APP_FY_${fiscalYear}_DICT.pdf` };
}

export async function generateAPP_PDF(year) {
  const built = await buildAPP_PDF(year);
  if (built) built.doc.save(built.fileName);
}

export async function previewAPP_PDF(year) {
  const built = await buildAPP_PDF(year);
  if (!built) return null;
  return { blob: built.doc.output('blob'), fiscalYear: built.fiscalYear };
}