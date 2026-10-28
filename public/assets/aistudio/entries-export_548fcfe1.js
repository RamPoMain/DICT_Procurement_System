// ============================================================
// PPMP EXCEL EXPORT (.xlsx) — Styled matching the Bulk Upload Template
//
// Uses ExcelJS to export official, styled PPMP workbooks featuring:
//   - Header title & Indicative / Final checkboxes
//   - Fiscal Year and End-User metadata
//   - Two-tier grouped headers with MOOE & CO sub-columns (20 columns)
//   - Column 1 to Column 20 numbering
//   - Thin black grid borders, formatted dates, and currency totals
//   - Deduplicated Total Budget calculation
//   - 3-column Signatory block (Prepared by, Endorsed by, Certified Funds)
//
// Can export:
//   - A single PPMP: exportPPMP_Excel(recordId)
//   - Filtered active PPMPs: exportEntriesExcel()
// ============================================================

(function () {
    'use strict';

    function notify(message) {
        if (typeof showToast === 'function') showToast(message);
        else alert(message);
    }

    function loadExcelJS() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
            s.onload = function () { resolve(window.ExcelJS); };
            s.onerror = function () { reject(new Error('Could not load ExcelJS library. Check your internet connection.')); };
            document.head.appendChild(s);
        });
    }

    function isoToDate(val) {
        if (!val) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(val).trim());
        return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }

    function parseNum(val) {
        if (typeof val === 'number') return isFinite(val) ? val : 0;
        var cleaned = String(val == null ? '' : val).replace(/[^0-9.]/g, '');
        return parseFloat(cleaned) || 0;
    }

    var THIN_BORDER = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } }
    };

    var SIG_UNDERLINE = {
        top: { style: 'medium', color: { argb: 'FF000000' } }
    };

    /**
     * Builds a single styled PPMP worksheet matching the Bulk Upload Template
     */
    /**
     * Builds a single styled PPMP worksheet matching the official format
     * (PAP Code, Object Code, MOOE, and CO omitted from PPMP export)
     */
    function buildStyledPpmpWorksheet(workbook, record, sheetTitle) {
        var items = typeof getRecordItems === 'function' ? getRecordItems(record) : (record.items || [record]);
        var ppmpNo = record.ppmp_no || 'N/A';
        var fiscalYear = record.fiscal_year || new Date().getFullYear();
        var endUser = record.end_user || 'N/A';
        var isFinal = record.is_indicative === 'Final';
        var dateStr = new Date().toLocaleDateString('en-US');

        var sheet = workbook.addWorksheet(sheetTitle || ('PPMP No. ' + ppmpNo), {
            views: [{ showGridLines: true }]
        });

        // 1. Column Widths (17 Columns: A to Q)
        sheet.columns = [
            { width: 36 }, // A: Description
            { width: 22 }, // B: Type of Project
            { width: 24 }, // C: Quantity and Size
            { width: 28 }, // D: Mode of Procurement
            { width: 20 }, // E: Pre-Procurement
            { width: 28 }, // F: Criteria for Bid Evaluation
            { width: 22 }, // G: Advertisement/Posting
            { width: 22 }, // H: Submission/Opening of Bids
            { width: 18 }, // I: Notice of Award
            { width: 18 }, // J: Contract Signing
            { width: 22 }, // K: Delivery Period
            { width: 20 }, // L: Source of Funds
            { width: 24 }, // M: Estimated Budget
            { width: 32 }, // N: Strategies
            { width: 26 }, // O: Supporting Documents
            { width: 32 }, // P: General Requirements
            { width: 22 }  // Q: Remarks
        ];

        // 2. Titles & Header Metadata (Rows 1-6)
        sheet.mergeCells('A1:Q1');
        var titleCell = sheet.getCell('A1');
        titleCell.value = 'PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ' + ppmpNo;
        titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF000000' } };
        titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(1).height = 28;

        sheet.mergeCells('A2:Q2');
        var checkCell = sheet.getCell('A2');
        checkCell.value = isFinal ? '[ ] INDICATIVE     [X] FINAL' : '[X] INDICATIVE     [ ] FINAL';
        checkCell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } };
        checkCell.alignment = { horizontal: 'center', vertical: 'middle' };
        sheet.getRow(2).height = 20;

        sheet.getRow(3).height = 8; // Spacer

        var fyCell = sheet.getCell('A4');
        fyCell.value = 'Fiscal Year : ' + fiscalYear;
        fyCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
        sheet.getRow(4).height = 20;

        var euCell = sheet.getCell('A5');
        euCell.value = 'End-User or Implementing Unit: ' + endUser;
        euCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
        sheet.getRow(5).height = 20;

        sheet.getRow(6).height = 10; // Spacer

        // 3. Group Headers (Row 7)
        sheet.mergeCells('A7:F7');
        sheet.getCell('A7').value = 'PROCUREMENT PROJECT DETAILS';

        sheet.mergeCells('G7:K7');
        sheet.getCell('G7').value = 'PROJECTED TIMELINE (MM/YYYY)';

        sheet.mergeCells('L7:M7');
        sheet.getCell('L7').value = 'FUNDING DETAILS';

        sheet.mergeCells('N7:N8');
        sheet.getCell('N7').value = 'PROCUREMENT STRATEGIES AND TOOLS';

        sheet.mergeCells('O7:O8');
        sheet.getCell('O7').value = 'ATTACHED SUPPORTING DOCUMENTS';

        sheet.mergeCells('P7:P8');
        sheet.getCell('P7').value = 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT';

        sheet.mergeCells('Q7:Q8');
        sheet.getCell('Q7').value = 'REMARKS';

        sheet.getRow(7).height = 24;

        // 4. Subheaders (Row 8)
        var subHeaders = [
            'General Description and Objective of the Project to be Procured',
            'Type of the Project to be Procured',
            'Quantity and Size of the Project to be Procured',
            'Recommended Mode of Procurement',
            'Pre-Procurement Conference (Yes/No)',
            'Criteria for Bid Evaluation',
            'Advertisement/Posting of IB/REI',
            'Submission/Opening of Bids',
            'Notice of Award',
            'Contract Signing',
            'Expected Delivery/ Implementation Period',
            'Source of Funds',
            'Estimated Budget / Authorized Budgetary Allocation (PhP)'
        ];
        for (var c = 0; c < subHeaders.length; c++) {
            sheet.getRow(8).getCell(c + 1).value = subHeaders[c];
        }
        sheet.getRow(8).height = 46;

        // 5. Column Numbers (Row 9)
        for (var colIdx = 1; colIdx <= 17; colIdx++) {
            sheet.getRow(9).getCell(colIdx).value = 'Column ' + colIdx;
        }
        sheet.getRow(9).height = 18;

        // Apply Styles & Borders to Headers (Rows 7-9)
        for (var hRow = 7; hRow <= 9; hRow++) {
            var rObj = sheet.getRow(hRow);
            for (var cIdx = 1; cIdx <= 17; cIdx++) {
                var hCell = rObj.getCell(cIdx);
                hCell.border = THIN_BORDER;
                hCell.font = { name: 'Arial', size: 8.5, bold: true, color: { argb: 'FF000000' } };
                hCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            }
        }

        // 6. Data Rows (Rows 10+)
        var startDataRow = 10;
        items.forEach(function (item, idx) {
            var rowNum = startDataRow + idx;
            var dRow = sheet.getRow(rowNum);

            var strategiesStr = Array.isArray(item.strategies) ? item.strategies.join('\n') : (item.strategies || '');
            var docsStr = Array.isArray(item.supporting_documents)
                ? item.supporting_documents.map(function (d) { return d.name || 'Document'; }).join('\n')
                : '';

            dRow.values = [
                item.project_description || '',
                item.project_type || '',
                item.quantity_size || '',
                item.mode || '',
                item.pre_procurement || '',
                item.bid_evaluation_criteria || 'N/A',
                isoToDate(item.start_date),
                isoToDate(item.bid_opening_date),
                isoToDate(item.notice_of_award_date),
                isoToDate(item.end_date),
                isoToDate(item.delivery_period),
                item.fund_source || '',
                parseNum(item.budget),
                strategiesStr,
                docsStr,
                item.general_requirements || '',
                item.remarks || ''
            ];

            dRow.height = 34;

            for (var col = 1; col <= 17; col++) {
                var cell = dRow.getCell(col);
                cell.border = THIN_BORDER;
                cell.font = { name: 'Arial', size: 9, color: { argb: 'FF000000' } };

                if (col >= 7 && col <= 11) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                    cell.numFmt = 'yyyy-mm-dd';
                } else if (col === 13) {
                    cell.alignment = { horizontal: 'right', vertical: 'middle' };
                    cell.numFmt = '"P "#,##0.00';
                } else if (col >= 2 && col <= 6 || col === 12) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                } else {
                    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
                }
            }
        });

        // 7. Total Budget Row (Deduplicated)
        var totalRowNum = startDataRow + items.length;
        sheet.mergeCells('A' + totalRowNum + ':L' + totalRowNum);

        var totLabel = sheet.getCell('A' + totalRowNum);
        totLabel.value = 'TOTAL BUDGET:';
        totLabel.font = { name: 'Arial', size: 9.5, bold: true };
        totLabel.alignment = { horizontal: 'right', vertical: 'middle' };

        var deduplicatedBudget = typeof calculateDeduplicatedBudget === 'function'
            ? calculateDeduplicatedBudget(items)
            : items.reduce(function (sum, it) { return sum + parseNum(it.budget); }, 0);

        var totVal = sheet.getCell('M' + totalRowNum);
        totVal.value = {
            formula: 'SUM(M' + startDataRow + ':M' + (totalRowNum - 1) + ')',
            result: deduplicatedBudget
        };
        totVal.font = { name: 'Arial', size: 9.5, bold: true };
        totVal.alignment = { horizontal: 'right', vertical: 'middle' };
        totVal.numFmt = '"P "#,##0.00';

        sheet.getRow(totalRowNum).height = 24;
        for (var tc = 1; tc <= 17; tc++) {
            sheet.getRow(totalRowNum).getCell(tc).border = THIN_BORDER;
        }

        // 8. Signatories Block (Prepared by, Endorsed by, Certified Funds)
        var sigStartRow = totalRowNum + 3;
        sheet.getRow(sigStartRow).height = 20;

        sheet.getCell('A' + sigStartRow).value = 'Prepared by / Submitted by:';
        sheet.getCell('A' + sigStartRow).font = { name: 'Arial', size: 9.5, bold: true };

        sheet.getCell('G' + sigStartRow).value = 'Endorsed by:';
        sheet.getCell('G' + sigStartRow).font = { name: 'Arial', size: 9.5, bold: true };

        sheet.getCell('M' + sigStartRow).value = 'Certified Funds Available:';
        sheet.getCell('M' + sigStartRow).font = { name: 'Arial', size: 9.5, bold: true };

        function makeSigBlock(startCol, endCol, name, title, office, showDate) {
            var colStartLetter = String.fromCharCode(64 + startCol);
            var colEndLetter = String.fromCharCode(64 + endCol);
            var nameRow = sigStartRow + 3;

            sheet.mergeCells(colStartLetter + nameRow + ':' + colEndLetter + nameRow);
            var nCell = sheet.getCell(colStartLetter + nameRow);
            nCell.value = name;
            nCell.font = { name: 'Arial', size: 9.5, bold: true };
            nCell.alignment = { horizontal: 'center', vertical: 'middle' };

            for (var sc = startCol; sc <= endCol; sc++) {
                sheet.getRow(nameRow).getCell(sc).border = SIG_UNDERLINE;
            }

            sheet.mergeCells(colStartLetter + (nameRow + 1) + ':' + colEndLetter + (nameRow + 1));
            var tCell = sheet.getCell(colStartLetter + (nameRow + 1));
            tCell.value = title;
            tCell.font = { name: 'Arial', size: 8.5 };
            tCell.alignment = { horizontal: 'center', vertical: 'middle' };

            sheet.mergeCells(colStartLetter + (nameRow + 2) + ':' + colEndLetter + (nameRow + 2));
            var oCell = sheet.getCell(colStartLetter + (nameRow + 2));
            oCell.value = office;
            oCell.font = { name: 'Arial', size: 8.5 };
            oCell.alignment = { horizontal: 'center', vertical: 'middle' };

            if (showDate) {
                var dCell = sheet.getCell(colStartLetter + (nameRow + 4));
                dCell.value = 'Date: ' + dateStr;
                dCell.font = { name: 'Arial', size: 8.5 };
                dCell.alignment = { horizontal: 'center', vertical: 'middle' };
            }
        }

        makeSigBlock(1, 4, 'JAYMARK D. DUMIO', 'Signature over Printed Name', 'Focal, ICT Literacy Competency and Development Bureau X', true);
        makeSigBlock(7, 10, 'EUGENE C. RAPOSALA III', 'Signature over Printed Name', 'Chief, Technical Operations Division', false);
        makeSigBlock(13, 16, 'BRYAN JOHN M. SABLAS', 'Signature over Printed Name', 'Budget Officer II', false);
    }

    /**
     * Downloads an individual PPMP record as a styled .xlsx file
     */
    async function exportPPMP_Excel(recordId) {
        var ExcelJS = await loadExcelJS();
        var allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
        var record = allRecords.find(function (r) { return r.id == recordId; });

        if (!record) {
            notify('PPMP record could not be found to export.');
            return;
        }

        notify('Generating styled PPMP Excel file...');

        var workbook = new ExcelJS.Workbook();
        workbook.creator = 'DICT Procurement System';
        workbook.created = new Date();

        buildStyledPpmpWorksheet(workbook, record, 'PPMP No. ' + (record.ppmp_no || '1'));

        var fileName = 'PPMP_' + (record.ppmp_no || '1') + '_' + String(record.end_user || 'Office').replace(/[^\w-]+/g, '_') + '.xlsx';

        var buffer = await workbook.xlsx.writeBuffer();
        var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

        notify('Exported ' + fileName + ' successfully.');
    }

    /**
     * Replaces the old plain export: exports each filtered PPMP as its own
     * beautifully styled sheet inside a master workbook!
     */
    async function exportEntriesExcel() {
        var ExcelJS = await loadExcelJS();
        var allRecords = typeof getRecords === 'function' ? getRecords() : (JSON.parse(localStorage.getItem('procurement_records')) || []);
        var records = typeof getFilteredEntryRecords === 'function'
            ? getFilteredEntryRecords(allRecords).sort(function (a, b) { return b.id - a.id; })
            : allRecords;

        if (records.length === 0) {
            notify('Nothing to export. No PPMP entries match the current filters.');
            return;
        }

        notify('Generating styled PPMP Excel export...');

        var workbook = new ExcelJS.Workbook();
        workbook.creator = 'DICT Procurement System';
        workbook.created = new Date();

        records.forEach(function (rec, index) {
            var sheetName = 'PPMP No. ' + (rec.ppmp_no || (index + 1));
            // Limit sheet name to 31 chars (Excel maximum)
            if (sheetName.length > 31) sheetName = sheetName.slice(0, 31);
            buildStyledPpmpWorksheet(workbook, rec, sheetName);
        });

        var fileName = 'PPMP_Entries_' + new Date().toISOString().slice(0, 10) + '.xlsx';

        var buffer = await workbook.xlsx.writeBuffer();
        var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

        notify('Exported ' + records.length + (records.length === 1 ? ' PPMP' : ' PPMPs') + ' to Excel.');
    }

    window.exportPPMP_Excel = exportPPMP_Excel;
    window.exportEntriesExcel = exportEntriesExcel;
})();