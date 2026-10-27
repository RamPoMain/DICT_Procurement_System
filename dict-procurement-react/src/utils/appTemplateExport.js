import ExcelJS from 'exceljs';
import { getLatestApprovedPpmpPerOffice, getRecordItems, parseBudgetNumber, getAppRecord } from './procurementRules.js';

export async function exportAppTemplateExcel(targetYear, user) {
  const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const approved = allRecords.filter(r => r.status === 'Completed');
  const year = String(targetYear || new Date().getFullYear());
  const latestPpmp = getLatestApprovedPpmpPerOffice(approved, year);

  if (!latestPpmp.length) {
    alert(`No fully approved PPMPs available for FY ${year}`);
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('APP', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  ws.columns = [
    { width: 20 }, { width: 35 }, { width: 20 }, { width: 24 }, { width: 36 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 34 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 36 }
  ];

  ws.mergeCells('A1:N1');
  ws.getCell('A1').value = `Department of Information and Communications Technology Annual Procurement Plan for FY ${year}`;
  ws.getCell('A1').font = { name: 'Arial', size: 14, bold: true };

  // Headers (Row 3 & 4)
  const THIN = { style: 'thin', color: { argb: 'FF000000' } };
  const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
  
  [['A', 'Code (PAP)'], ['B', 'Procurement Program/Project'], ['C', 'Object Code'],
   ['D', 'PMO/End-User'], ['E', 'Mode of Procurement'], ['J', 'Source of Funds'],
   ['N', 'Remarks']].forEach(([col, title]) => {
    ws.mergeCells(`${col}3:${col}4`);
    const cell = ws.getCell(`${col}3`);
    cell.value = title;
    cell.font = { name: 'Arial', size: 9, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER;
  });

  ws.mergeCells('F3:I3');
  ws.getCell('F3').value = 'Schedule for Each Procurement Activity';
  ws.getCell('F3').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('F3').font = { name: 'Arial', size: 9, bold: true };

  ws.mergeCells('K3:M3');
  ws.getCell('K3').value = 'Estimated Budget (PhP)';
  ws.getCell('K3').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell('K3').font = { name: 'Arial', size: 9, bold: true };

  const sub = [
    ['F', 'Advertisement/Posting'], ['G', 'Submission/Opening'], ['H', 'Notice of Award'],
    ['I', 'Contract Signing'], ['K', 'Total'], ['L', 'MOOE'], ['M', 'CO']
  ];
  sub.forEach(([col, val]) => {
    const c = ws.getCell(`${col}4`);
    c.value = val;
    c.font = { name: 'Arial', size: 8, bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = BORDER;
  });

  let rowIdx = 5;
  latestPpmp.forEach(rec => {
    getRecordItems(rec).forEach(it => {
      const isInfra = String(it.project_type || '').trim() === 'Infrastructure';
      const b = parseBudgetNumber(it.budget);
      const row = ws.getRow(rowIdx);
      row.values = [
        it.reference_no || '', it.project_description || '', it.object_name || '',
        rec.end_user || '', it.mode || '', it.start_date || null, it.bid_opening_date || null,
        it.notice_of_award_date || null, it.end_date || null, it.fund_source || '',
        b, isInfra ? 'No' : 'Yes', isInfra ? 'Yes' : 'No', it.remarks || ''
      ];
      for (let i = 1; i <= 14; i++) {
        const cell = row.getCell(i);
        cell.border = BORDER;
        cell.font = { name: 'Arial', size: 9 };
        if (i === 11) cell.numFmt = '#,##0.00;(#,##0.00);"-"';
      }
      rowIdx++;
    });
  });

  // Total Row
  ws.mergeCells(`A${rowIdx}:J${rowIdx}`);
  ws.getCell(`A${rowIdx}`).value = 'TOTAL';
  ws.getCell(`A${rowIdx}`).font = { name: 'Arial', size: 9, bold: true };
  ws.getCell(`A${rowIdx}`).alignment = { horizontal: 'right', vertical: 'middle' };

  const tot = ws.getCell(`K${rowIdx}`);
  tot.value = { formula: `SUM(K5:K${rowIdx - 1})` };
  tot.font = { name: 'Arial', size: 9, bold: true };
  tot.numFmt = '#,##0.00;(#,##0.00);"-"';
  for (let i = 1; i <= 14; i++) ws.getRow(rowIdx).getCell(i).border = BORDER;

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `APP_Template_FY${year}.xlsx`;
  a.click();
}