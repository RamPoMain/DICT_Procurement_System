import ExcelJS from 'exceljs';
import { getRecordItems, parseBudgetNumber, calculateDeduplicatedBudget } from './procurementRules.js';

const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function buildWorksheet(wb, record, title) {
  const items = getRecordItems(record);
  const sheet = wb.addWorksheet(title || `PPMP No. ${record.ppmp_no}`, { views: [{ showGridLines: true }] });

  sheet.columns = [
    { width: 36 }, { width: 22 }, { width: 24 }, { width: 28 }, { width: 20 },
    { width: 28 }, { width: 22 }, { width: 22 }, { width: 18 }, { width: 18 },
    { width: 22 }, { width: 20 }, { width: 24 }, { width: 32 }, { width: 26 },
    { width: 32 }, { width: 22 }
  ];

  sheet.mergeCells('A1:Q1');
  const t = sheet.getCell('A1');
  t.value = `PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${record.ppmp_no || 'N/A'}`;
  t.font = { name: 'Arial', size: 14, bold: true };
  t.alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.mergeCells('A2:Q2');
  const c = sheet.getCell('A2');
  c.value = record.is_indicative === 'Final' ? '[ ] INDICATIVE     [X] FINAL' : '[X] INDICATIVE     [ ] FINAL';
  c.font = { name: 'Arial', size: 10, bold: true };
  c.alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.getCell('A4').value = `Fiscal Year : ${record.fiscal_year || 'N/A'}`;
  sheet.getCell('A5').value = `End-User or Implementing Unit: ${record.end_user || 'N/A'}`;
  [sheet.getCell('A4'), sheet.getCell('A5')].forEach(cell => cell.font = { name: 'Arial', size: 11, bold: true });

  // Group headers row 7
  sheet.mergeCells('A7:F7'); sheet.getCell('A7').value = 'PROCUREMENT PROJECT DETAILS';
  sheet.mergeCells('G7:K7'); sheet.getCell('G7').value = 'PROJECTED TIMELINE (MM/YYYY)';
  sheet.mergeCells('L7:M7'); sheet.getCell('L7').value = 'FUNDING DETAILS';
  sheet.mergeCells('N7:N8'); sheet.getCell('N7').value = 'PROCUREMENT STRATEGIES AND TOOLS';
  sheet.mergeCells('O7:O8'); sheet.getCell('O7').value = 'ATTACHED SUPPORTING DOCUMENTS';
  sheet.mergeCells('P7:P8'); sheet.getCell('P7').value = 'GENERAL REQUIREMENTS';
  sheet.mergeCells('Q7:Q8'); sheet.getCell('Q7').value = 'REMARKS';

  const subHeaders = [
    'General Description', 'Type of Project', 'Quantity and Size', 'Recommended Mode',
    'Pre-Procurement (Yes/No)', 'Criteria for Bid Evaluation', 'Advertisement/Posting',
    'Submission/Opening', 'Notice of Award', 'Contract Signing', 'Expected Delivery',
    'Source of Funds', 'Estimated Budget (PhP)'
  ];
  subHeaders.forEach((h, i) => { sheet.getRow(8).getCell(i + 1).value = h; });
  for (let i = 1; i <= 17; i++) sheet.getRow(9).getCell(i).value = `Column ${i}`;

  for (let r = 7; r <= 9; r++) {
    for (let col = 1; col <= 17; col++) {
      const cell = sheet.getRow(r).getCell(col);
      cell.border = BORDER;
      cell.font = { name: 'Arial', size: 8.5, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
  }

  items.forEach((it, idx) => {
    const row = sheet.getRow(10 + idx);
    row.values = [
      it.project_description || '', it.project_type || '', it.quantity_size || '', it.mode || '',
      it.pre_procurement || '', it.bid_evaluation_criteria || 'N/A', it.start_date || '',
      it.bid_opening_date || '', it.notice_of_award_date || '', it.end_date || '', it.delivery_period || '',
      it.fund_source || '', parseBudgetNumber(it.budget),
      Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || ''),
      Array.isArray(it.supporting_documents) ? it.supporting_documents.map(d => d.name).join('\n') : '',
      it.general_requirements || '', it.remarks || ''
    ];
    for (let c = 1; c <= 17; c++) {
      const cell = row.getCell(c);
      cell.border = BORDER;
      cell.font = { name: 'Arial', size: 9 };
      if (c === 13) {
        cell.numFmt = '"P "#,##0.00';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = { horizontal: (c >= 7 && c <= 11) ? 'center' : 'left', vertical: 'middle', wrapText: true };
      }
    }
  });

  const totRow = 10 + items.length;
  sheet.mergeCells(`A${totRow}:L${totRow}`);
  sheet.getCell(`A${totRow}`).value = 'TOTAL BUDGET:';
  sheet.getCell(`A${totRow}`).font = { name: 'Arial', size: 9.5, bold: true };
  sheet.getCell(`A${totRow}`).alignment = { horizontal: 'right', vertical: 'middle' };

  const totCell = sheet.getCell(`M${totRow}`);
  totCell.value = calculateDeduplicatedBudget(items);
  totCell.numFmt = '"P "#,##0.00';
  totCell.font = { name: 'Arial', size: 9.5, bold: true };

  for (let c = 1; c <= 17; c++) sheet.getRow(totRow).getCell(c).border = BORDER;
}

export async function exportPPMP_Excel(record) {
  const wb = new ExcelJS.Workbook();
  buildWorksheet(wb, record, `PPMP No. ${record.ppmp_no}`);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `PPMP_${record.ppmp_no}_${String(record.end_user).replace(/[^\w-]+/g, '_')}.xlsx`;
  a.click();
}

export async function exportEntriesExcel(records) {
  const wb = new ExcelJS.Workbook();
  records.forEach((r, idx) => {
    buildWorksheet(wb, r, `PPMP No. ${r.ppmp_no || idx + 1}`.slice(0, 31));
  });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `PPMP_Master_Entries_${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
}