/* ============================================================
   DICT PROCUREMENT — BULK IMPORT (Excel template)

   Adds a "Bulk import" button to the request form's top bar (beside
   Close). It opens a small dialog with two steps:
     1. Download template  -> PPMP_Items_Template.xlsx
     2. Upload the filled template -> every row is checked with the
        same rules the form uses, a review dialog shows what is ready
        and what is not, and the valid rows are saved as line items.

   Where the items go
     - New request:  a new Draft PPMP is created using the form's
       PPMP No., Fiscal Year and End-User, and the "Indicative or
       Final" choice made on the form.
     - "Add entry" to an existing Draft PPMP: the items are appended
       to that PPMP.
   The button is hidden while viewing or editing a saved item.

   Not in the spreadsheet: supporting documents. Imported items have
   none, so they are attached later (Edit) before submitting — the
   existing "missing document" check at submit time already covers it.

   Needs: SheetJS (xlsx.full.min.js) loaded before this file, plus
   request-modal.js and dashboard-logic.js on the same page.
   ============================================================ */

(function () {
    'use strict';

    var TEMPLATE_SHEET = 'PPMP Items';
    var TEMPLATE_FILE = 'PPMP_Items_Template.xlsx';
    var MAX_IMPORT_BYTES = 2 * 1024 * 1024;
    var MAX_IMPORT_ROWS = 200;

    // "General Requirements/Miscellaneous/Common Supplies and Equipment" column:
    // optional, and when filled it must be one of these three.
    var GENERAL_REQUIREMENT_OPTIONS = ['General Requirements', 'Miscellaneous', 'Common Supplies and Equipment'];

    // One entry per template column, in display order. `match` finds the
    // column by its header text, so reordering columns or adding extra ones
    // in Excel does not break the import.
    var COLUMNS = [
        { key: 'project_description',     label: 'Description',        match: /description|objective/,        width: 36, header: 'General Description and Objective of the Project to be Procured' },
        { key: 'project_type',            label: 'Type of Project',    match: /type of (the )?project/,       width: 22, header: 'Type of the Project to be Procured' },
        { key: 'quantity_size',           label: 'Quantity and Size',  match: /quantity|size/,                width: 24, header: 'Quantity and Size of the Project to be Procured' },
        { key: 'mode',                    label: 'Mode of Procurement',match: /\bmode\b/,                     width: 26, header: 'Recommended Mode of Procurement' },
        { key: 'pre_procurement',         label: 'Pre-Procurement',    match: /pre.?procurement/,             width: 20, header: 'Pre-Procurement Conference (Yes/No)' },
        { key: 'bid_evaluation_criteria', label: 'Bid Criteria',       match: /criteria/,                     width: 30, header: 'Criteria for Bid Evaluation' },
        { key: 'start_date',              label: 'Start date',         match: /^start/,                       width: 18, header: 'Start of Procurement Activity' },
        { key: 'end_date',                label: 'End date',           match: /^end/,                         width: 18, header: 'End of Procurement Activity' },
        { key: 'delivery_period',         label: 'Delivery period',    match: /delivery|implementation/,      width: 22, header: 'Expected Delivery/ Implementation Period' },
        { key: 'fund_source',             label: 'Source of Funds',    match: /fund/,                         width: 18, header: 'Source of Funds' },
        { key: 'budget',                  label: 'Budget',             match: /budget/,                       width: 24, header: 'Estimated Budget / Authorized Budgetary Allocation (PhP)' },
        { key: 'strategies',              label: 'Strategies',         match: /strateg/,                      width: 32, header: 'PROCUREMENT STRATEGIES AND TOOLS' },
        { key: 'supporting_documents',    label: 'Supporting Docs',    match: /supporting|attached/,          width: 24, header: 'ATTACHED SUPPORTING DOCUMENTS', optional: true },
        { key: 'general_requirements',    label: 'General Requirements', match: /general requirements|miscellaneous|common suppl/, width: 32, header: 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT', optional: true },
        { key: 'remarks',                 label: 'Remarks',            match: /remark/,                       width: 20, header: 'REMARKS' }
    ];

    // ------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function str(value) {
        return value == null ? '' : String(value).trim();
    }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function toast(message) {
        if (typeof showToast === 'function') showToast(message); else alert(message);
    }

    function pesoText(n) {
        return '\u20B1' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
    }

    // Case-insensitive match of a cell against the allowed values.
    // Returns the canonical spelling, or null.
    function canonical(value, allowed) {
        var v = str(value).toLowerCase();
        if (!v) return null;
        for (var i = 0; i < allowed.length; i++) {
            if (allowed[i].toLowerCase() === v) return allowed[i];
        }
        return null;
    }

    // Allowed values come from the form itself so they never drift from it.
    function readSelectOptions(selectId) {
        var select = document.getElementById(selectId);
        if (!select) return [];
        return Array.prototype.slice.call(select.options)
            .filter(function (o) { return o.value && !o.disabled; })
            .map(function (o) { return o.value.trim(); });
    }

    function readStrategyOptions() {
        return Array.prototype.slice.call(document.querySelectorAll('#strategiesMenu .option'))
            .map(function (o) { return o.textContent.trim(); })
            .filter(Boolean);
    }

    function getAllowedValues() {
        return {
            types: readSelectOptions('project_type'),
            modes: readSelectOptions('modeOfProcurement'),
            yesNo: ['Yes', 'No'],
            criteria: readSelectOptions('bid_evaluation_criteria'),
            strategies: readStrategyOptions()
        };
    }

    // ------------------------------------------------------------
    // Cell parsing
    // ------------------------------------------------------------

    // Accepts an Excel date serial, a Date, "YYYY-MM-DD" or "MM/DD/YYYY".
    // Returns "YYYY-MM-DD" or null.
    function toIsoDate(v) {
        if (v === '' || v == null) return null;
        var y, m, d, dt;

        if (v instanceof Date && !isNaN(v)) {
            y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
        } else if (typeof v === 'number' && isFinite(v)) {
            // Excel serial days since 1899-12-30
            dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
            y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
        } else {
            var s = String(v).trim();
            var iso = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(s);
            var us = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/.exec(s);
            if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
            else if (us) { m = +us[1]; d = +us[2]; y = +us[3]; }
            else return null;
        }

        dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
        return y + '-' + pad2(m) + '-' + pad2(d);
    }

    // Returns { number, text } or null when the cell is not a valid amount.
    function toBudget(v) {
        if (typeof v === 'number') {
            return isFinite(v) ? { number: v, text: String(v) } : null;
        }
        var cleaned = String(v == null ? '' : v).replace(/[\u20B1,\s]/g, '').replace(/^php/i, '').replace(/^p(?=\d)/i, '');
        if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
        return { number: parseFloat(cleaned), text: cleaned };
    }

    // ------------------------------------------------------------
    // Sheet -> rows
    // ------------------------------------------------------------

    // Maps each column key to its index in ONE header row.
    // Returns { index, missing, foundCount }. Columns marked `optional`
    // are never reported as missing.
    function mapHeaders(headerRow) {
        var index = {};
        var used = {};
        var foundCount = 0;
        (headerRow || []).forEach(function (cell, i) {
            var text = str(cell).toLowerCase().replace(/\s+/g, ' ');
            if (!text) return;
            for (var c = 0; c < COLUMNS.length; c++) {
                var col = COLUMNS[c];
                if (!used[col.key] && col.match.test(text)) {
                    index[col.key] = i;
                    used[col.key] = true;
                    foundCount += 1;
                    break;
                }
            }
        });
        var missing = COLUMNS.filter(function (col) {
            return !col.optional && index[col.key] === undefined;
        });
        return { index: index, missing: missing, foundCount: foundCount };
    }

    // The downloaded template (and the PPMP form it copies) splits its
    // headers over TWO rows: a group row (PROCUREMENT STRATEGIES AND TOOLS,
    // ATTACHED SUPPORTING DOCUMENTS, REMARKS, ...) above a row holding the
    // other eleven column titles. This reads the two rows together; the
    // lower, more specific row wins when both name the same column.
    function mapHeaderBlock(upperRow, lowerRow) {
        var upper = mapHeaders(upperRow);
        var lower = mapHeaders(lowerRow);
        var index = {};
        var usedIdx = {};
        // Lower row first so its specific titles claim their columns.
        [lower.index, upper.index].forEach(function (source) {
            Object.keys(source).forEach(function (key) {
                var i = source[key];
                if (index[key] !== undefined || usedIdx[i]) return;
                index[key] = i;
                usedIdx[i] = true;
            });
        });
        var foundCount = Object.keys(index).length;
        var missing = COLUMNS.filter(function (col) {
            return !col.optional && index[col.key] === undefined;
        });
        return { index: index, missing: missing, foundCount: foundCount };
    }

    // Finds the table header in the first rows of the sheet. Tries each row
    // alone and together with the row below it, and keeps whichever reads
    // the most columns (a single row wins ties). Returns
    // { mapped, rowsUsed, headerIndex } or null.
    function findHeader(rows) {
        var best = null;
        var limit = Math.min(rows.length, 15);
        for (var i = 0; i < limit; i++) {
            var single = mapHeaders(rows[i]);
            if (single.foundCount >= 4 && (!best || single.foundCount > best.mapped.foundCount)) {
                best = { mapped: single, rowsUsed: 1, headerIndex: i };
            }
            var lowerRow = rows[i + 1];
            // Only fold in the next row if it looks like a header row itself
            // (never a data row that happens to contain a keyword).
            if (lowerRow && mapHeaders(lowerRow).foundCount >= 3) {
                var block = mapHeaderBlock(rows[i], lowerRow);
                if (block.foundCount >= 4 && (!best || block.foundCount > best.mapped.foundCount)) {
                    best = { mapped: block, rowsUsed: 2, headerIndex: i };
                }
            }
        }
        return best;
    }

    // Checks one row. Returns { item, errors }. `item` is only set when
    // there are no errors.
    function validateRow(raw, allowed) {
        var errors = [];
        var item = {};

        function text(key) { return str(raw[key]); }

        var description = text('project_description');
        if (description.length < 3) errors.push('Description is required (at least 3 characters).');
        item.project_description = description;

        var type = canonical(raw.project_type, allowed.types);
        if (!type) errors.push('Type of Project must be one of: ' + allowed.types.join(', ') + '.');
        item.project_type = type || '';

        var quantity = text('quantity_size');
        if (quantity.length < 3) errors.push('Quantity and Size is required (at least 3 characters).');
        item.quantity_size = quantity;

        var mode = canonical(raw.mode, allowed.modes);
        if (!mode) errors.push('Mode of Procurement is missing or not one of the valid modes.');
        item.mode = mode || '';

        var pre = canonical(raw.pre_procurement, allowed.yesNo);
        if (!pre) errors.push('Pre-Procurement Conference must be Yes or No.');
        item.pre_procurement = pre || '';

        var criteria = canonical(raw.bid_evaluation_criteria, allowed.criteria);
        if (!criteria) errors.push('Criteria for Bid Evaluation is missing or not one of the valid criteria.');
        item.bid_evaluation_criteria = criteria || '';

        var start = toIsoDate(raw.start_date);
        var end = toIsoDate(raw.end_date);
        var delivery = toIsoDate(raw.delivery_period);
        if (!start) errors.push('Start date is missing or not a valid date (use YYYY-MM-DD).');
        if (!end) errors.push('End date is missing or not a valid date (use YYYY-MM-DD).');
        if (!delivery) errors.push('Delivery period is missing or not a valid date (use YYYY-MM-DD).');
        if (start && end && end < start) errors.push('End date cannot be earlier than the start date.');
        if (end && delivery && delivery <= end) errors.push('Delivery period must be after the end date.');
        item.start_date = start || '';
        item.end_date = end || '';
        item.delivery_period = delivery || '';

        var fund = text('fund_source');
        if (fund.length < 2) errors.push('Source of Funds is required.');
        item.fund_source = fund;

        var budget = toBudget(raw.budget);
        if (!budget) {
            errors.push('Budget must be a valid number.');
        } else if (budget.number <= 0) {
            errors.push('Budget must be greater than 0.');
            budget = null;
        }
        item.budget = budget ? budget.text : '';

        // Same mode/budget bracket rule as the form (request-modal.js).
        // RA 12009 Sec 7.7.2 (d) validation for bulk import
        if (budget && mode && typeof PROCUREMENT_MODE_RULES !== 'undefined') {
            var rule = PROCUREMENT_MODE_RULES[mode];
            if (rule) {
                if (type && rule.allowedTypes && rule.allowedTypes.indexOf(type) === -1) {
                    errors.push('Mode "' + mode + '" is restricted to ' + rule.allowedTypes.join(', ') + ' under ' + rule.legalBasis + '.');
                } else if (budget.number > rule.maxBudget) {
                    errors.push('Budget of ' + pesoText(budget.number) + ' exceeds the allowable limit of ' + pesoText(rule.maxBudget) + ' for ' + mode + ' (' + rule.legalBasis + ').');
                }
            }
        }

        var strategies = [];
        var unknown = [];
        str(raw.strategies).split(/[;\n|,]+/).forEach(function (part) {
            var name = part.trim();
            if (!name) return;
            var match = canonical(name, allowed.strategies);
            if (match) { if (strategies.indexOf(match) === -1) strategies.push(match); }
            else unknown.push(name);
        });
        if (unknown.length) errors.push('Unknown strategy: ' + unknown.join('; ') + '.');
        else if (strategies.length === 0) errors.push('Select at least one Procurement Strategy.');
        item.strategies = strategies;

        var remarks = text('remarks');
        if (remarks.length < 3) errors.push('Remarks is required (at least 3 characters).');
        item.remarks = remarks;

        // Optional choice: General Requirements / Miscellaneous / Common Supplies and Equipment.
        var generalReq = text('general_requirements');
        var generalMatch = generalReq ? canonical(generalReq, GENERAL_REQUIREMENT_OPTIONS) : '';
        if (generalReq && !generalMatch) {
            errors.push('General Requirements/Miscellaneous/Common Supplies and Equipment must be one of: ' +
                GENERAL_REQUIREMENT_OPTIONS.join(', ') + ' (or left blank).');
        }
        item.general_requirements = generalMatch || '';

        item.supporting_documents = [];

        return { item: errors.length ? null : item, errors: errors };
    }

    // Turns the sheet's rows (array of arrays, header first) into a result:
    //   { fatal, ready: [{ rowNumber, item }], problems: [{ rowNumber, errors }], total }
    function analyzeRows(rows, allowed) {
        if (!rows || rows.length === 0) {
            return { fatal: 'The file is empty.', ready: [], problems: [], total: 0 };
        }

        var header = findHeader(rows);
        if (!header) {
            return {
                fatal: 'The column headers were not found. Please use the downloaded template and keep its table header rows intact.',
                ready: [], problems: [], total: 0
            };
        }
        var mapped = header.mapped;
        if (mapped.missing.length) {
            return {
                fatal: 'These columns are missing from the file: ' +
                    mapped.missing.map(function (col) { return col.label; }).join(', ') +
                    '. Please use the downloaded template and keep its table header rows intact.',
                ready: [], problems: [], total: 0
            };
        }

        var ready = [];
        var problems = [];
        var total = 0;

        // Start right after the header rows, skipping the "Column 1 ... Column 15"
        // numbering row the template has under them.
        var startRow = header.headerIndex + header.rowsUsed;
        while (startRow < rows.length) {
            var numbering = (rows[startRow] || []).map(str).filter(Boolean);
            var isNumberRow = numbering.length > 0 && numbering.every(function (t) { return /^column\s*\d+$/i.test(t); });
            if (!isNumberRow) break;
            startRow++;
        }

        for (var r = startRow; r < rows.length; r++) {
            var cells = rows[r] || [];

            // Stop reading rows when reaching Total Budget or Signatures
            var lineText = str(cells[0] || cells[1] || cells[9] || '').toLowerCase();
            if (lineText.indexOf('total budget') !== -1 ||
                lineText.indexOf('prepared by') !== -1 ||
                lineText.indexOf('certified funds') !== -1 ||
                lineText.indexOf('approved by') !== -1 ||
                lineText.indexOf('endorsed by') !== -1) {
                break;
            }

            var raw = {};
            var hasData = false;
            COLUMNS.forEach(function (col) {
                var cell = mapped.index[col.key] !== undefined ? cells[mapped.index[col.key]] : '';
                raw[col.key] = cell;
                if (str(cell) !== '') hasData = true;
            });
            if (!hasData) continue; // Skip blank rows

            total += 1;
            if (total > MAX_IMPORT_ROWS) {
                return {
                    fatal: 'This file has more than ' + MAX_IMPORT_ROWS + ' items. Please split it into smaller files.',
                    ready: [], problems: [], total: total
                };
            }

            var result = validateRow(raw, allowed);
            if (result.item) ready.push({ rowNumber: r + 1, item: result.item });
            else problems.push({ rowNumber: r + 1, errors: result.errors });
        }

        if (total === 0) {
            return { fatal: 'No filled-in rows were found under the table header.', ready: [], problems: [], total: 0 };
        }

        return { fatal: null, ready: ready, problems: problems, total: total };
    }

    // ------------------------------------------------------------
    // Template download
    // ------------------------------------------------------------

    function loadExcelJS() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
            s.onload = function () { resolve(window.ExcelJS); };
            s.onerror = function () { reject(new Error('Could not load ExcelJS library')); };
            document.head.appendChild(s);
        });
    }

    async function downloadTemplate() {
        var btn = document.getElementById('biDownloadBtn');
        if (btn) btn.disabled = true;

        try {
            toast('Generating styled Excel template...');
            var ExcelJS = await loadExcelJS();

            var header = readHeader();
            var ppmpNo = header.ppmp_no || '1';
            var fiscalYear = header.fiscal_year || new Date().getFullYear();
            var endUser = header.end_user || 'Free Public Internet Access Program';
            var isFinal = header.is_indicative === 'Final';
            var dateStr = new Date().toLocaleDateString('en-US'); // e.g. 10/1/2026

            var workbook = new ExcelJS.Workbook();
            workbook.creator = 'DICT Procurement System';
            var sheet = workbook.addWorksheet(TEMPLATE_SHEET, {
                views: [{ showGridLines: true }]
            });

            // 1. Column Widths (15 columns)
            sheet.columns = [
                { width: 36 }, // Col 1: Description
                { width: 22 }, // Col 2: Type
                { width: 24 }, // Col 3: Quantity
                { width: 26 }, // Col 4: Mode
                { width: 20 }, // Col 5: Pre-procurement
                { width: 28 }, // Col 6: Criteria
                { width: 18 }, // Col 7: Start Date
                { width: 18 }, // Col 8: End Date
                { width: 22 }, // Col 9: Delivery
                { width: 18 }, // Col 10: Fund Source
                { width: 24 }, // Col 11: Budget
                { width: 32 }, // Col 12: Strategies
                { width: 24 }, // Col 13: Attached Docs
                { width: 32 }, // Col 14: General Requirements / Misc. / Common Supplies
                { width: 20 }  // Col 15: Remarks
            ];

            // 2. Titles & Metadata
            sheet.mergeCells('A1:O1');
            var title = sheet.getCell('A1');
            title.value = 'PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ' + ppmpNo;
            title.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF000000' } };
            title.alignment = { horizontal: 'center', vertical: 'middle' };
            sheet.getRow(1).height = 28;

            sheet.mergeCells('A2:O2');
            var checks = sheet.getCell('A2');
            checks.value = isFinal ? '[ ] INDICATIVE     [X] FINAL' : '[X] INDICATIVE     [ ] FINAL';
            checks.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } };
            checks.alignment = { horizontal: 'center', vertical: 'middle' };
            sheet.getRow(2).height = 20;

            sheet.getRow(3).height = 8;

            var fyCell = sheet.getCell('A4');
            fyCell.value = 'Fiscal Year : ' + fiscalYear;
            fyCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
            sheet.getRow(4).height = 20;

            var euCell = sheet.getCell('A5');
            euCell.value = 'End-User or Implementing Unit: ' + endUser;
            euCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
            sheet.getRow(5).height = 20;

            sheet.getRow(6).height = 10;

            // 3. Group Headers (Row 7)
            sheet.mergeCells('A7:F7');
            sheet.getCell('A7').value = 'PROCUREMENT PROJECT DETAILS';

            sheet.mergeCells('G7:I7');
            sheet.getCell('G7').value = 'PROJECTED TIMELINE (MM/YYYY)';

            sheet.mergeCells('J7:K7');
            sheet.getCell('J7').value = 'FUNDING DETAILS';

            sheet.mergeCells('L7:L8');
            sheet.getCell('L7').value = 'PROCUREMENT STRATEGIES AND TOOLS';

            sheet.mergeCells('M7:M8');
            sheet.getCell('M7').value = 'ATTACHED SUPPORTING DOCUMENTS';

            sheet.mergeCells('N7:N8');
            sheet.getCell('N7').value = 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT';

            sheet.mergeCells('O7:O8');
            sheet.getCell('O7').value = 'REMARKS';

            sheet.getRow(7).height = 24;

            // 4. Subheaders (Row 8)
            var subHeaders = [
                'General Description and Objective of the Project to be Procured',
                'Type of the Project to be Procured',
                'Quantity and Size of the Project to be Procured',
                'Recommended Mode of Procurement',
                'Pre-Procurement Conference (Yes/No)',
                'Criteria for Bid Evaluation',
                'Start of Procurement Activity',
                'End of Procurement Activity',
                'Expected Delivery/ Implementation Period',
                'Source of Funds',
                'Estimated Budget / Authorized Budgetary Allocation (PhP)'
            ];
            for (var i = 0; i < subHeaders.length; i++) {
                sheet.getRow(8).getCell(i + 1).value = subHeaders[i];
            }
            sheet.getRow(8).height = 46;

            // 5. Column Numbers (Row 9)
            for (var c = 1; c <= 15; c++) {
                sheet.getRow(9).getCell(c).value = 'Column ' + c;
            }
            sheet.getRow(9).height = 18;

            // 6. Data Entry Rows (Rows 10 to 14: 5 Blank Sample Rows)
            for (var r = 10; r <= 14; r++) {
                sheet.getRow(r).height = 32;
            }

            // Dropdown on the General Requirements column (N10:N14).
            for (var dv = 10; dv <= 14; dv++) {
                sheet.getCell('N' + dv).dataValidation = {
                    type: 'list',
                    allowBlank: true,
                    formulae: ['"' + GENERAL_REQUIREMENT_OPTIONS.join(',') + '"']
                };
            }

            // 7. Total Budget Row (Row 15)
            sheet.mergeCells('A15:J15');
            var totLabel = sheet.getCell('A15');
            totLabel.value = 'TOTAL BUDGET:';
            totLabel.font = { name: 'Arial', size: 9.5, bold: true };
            totLabel.alignment = { horizontal: 'right', vertical: 'middle' };

            var totVal = sheet.getCell('K15');
            totVal.value = { formula: 'SUM(K10:K14)', result: 0 };
            totVal.font = { name: 'Arial', size: 9.5, bold: true };
            totVal.alignment = { horizontal: 'right', vertical: 'middle' };
            totVal.numFmt = '"P "#,##0.00';
            sheet.getRow(15).height = 24;

            // 8. Apply Clean Black Borders & Alignment Across the Table (Rows 7 to 15)
            var thinBorder = {
                top: { style: 'thin', color: { argb: 'FF000000' } },
                left: { style: 'thin', color: { argb: 'FF000000' } },
                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                right: { style: 'thin', color: { argb: 'FF000000' } }
            };

            for (var rowIdx = 7; rowIdx <= 15; rowIdx++) {
                var rowObj = sheet.getRow(rowIdx);
                for (var colIdx = 1; colIdx <= 15; colIdx++) {
                    var cell = rowObj.getCell(colIdx);
                    cell.border = thinBorder;

                    if (rowIdx <= 9) {
                        cell.font = { name: 'Arial', size: 8.5, bold: true, color: { argb: 'FF000000' } };
                        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                    } else if (rowIdx >= 10 && rowIdx <= 14) {
                        cell.font = { name: 'Arial', size: 9, color: { argb: 'FF000000' } };
                        var align = (colIdx === 11) ? 'right' : ((colIdx >= 2 && colIdx <= 9) ? 'center' : 'left');
                        cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
                        if (colIdx === 11) cell.numFmt = '"P "#,##0.00';
                        if (colIdx >= 7 && colIdx <= 9) cell.numFmt = 'yyyy-mm-dd';
                    }
                }
            }

            // 9. Signatures Block (Rows 18 to 32)
            sheet.getRow(18).height = 20;
            sheet.getCell('A18').value = 'Prepared by / Submitted by:';
            sheet.getCell('A18').font = { name: 'Arial', size: 9.5, bold: true };

            sheet.getCell('F18').value = 'Certified Funds Available:';
            sheet.getCell('F18').font = { name: 'Arial', size: 9.5, bold: true };

            sheet.getCell('L18').value = 'Approved by:';
            sheet.getCell('L18').font = { name: 'Arial', size: 9.5, bold: true };

            var sigUnderline = { top: { style: 'medium', color: { argb: 'FF000000' } } };

            // Helper to build a clean signatory block
            function makeSigBlock(startCol, endCol, name, title, office, date) {
                var startLetter = String.fromCharCode(64 + startCol);
                var endLetter = String.fromCharCode(64 + endCol);

                sheet.mergeCells(startLetter + '21:' + endLetter + '21');
                var nCell = sheet.getCell(startLetter + '21');
                nCell.value = name;
                nCell.font = { name: 'Arial', size: 9.5, bold: true };
                nCell.alignment = { horizontal: 'center', vertical: 'middle' };

                // Apply underline border across merged cells
                for (var c = startCol; c <= endCol; c++) {
                    sheet.getRow(21).getCell(c).border = sigUnderline;
                }

                sheet.mergeCells(startLetter + '22:' + endLetter + '22');
                var tCell = sheet.getCell(startLetter + '22');
                tCell.value = title;
                tCell.font = { name: 'Arial', size: 8.5 };
                tCell.alignment = { horizontal: 'center', vertical: 'middle' };

                sheet.mergeCells(startLetter + '23:' + endLetter + '23');
                var oCell = sheet.getCell(startLetter + '23');
                oCell.value = office;
                oCell.font = { name: 'Arial', size: 8.5 };
                oCell.alignment = { horizontal: 'center', vertical: 'middle' };

                if (date) {
                    var dCell = sheet.getCell(startLetter + '25');
                    dCell.value = 'Date: ' + date;
                    dCell.font = { name: 'Arial', size: 8.5 };
                    dCell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
            }

            makeSigBlock(1, 4, 'JAYMARK D. DUMIO', 'Signature over Printed Name', 'Focal, ICT Literacy Competency and Development Bureau X', dateStr);
            makeSigBlock(6, 9, 'BRYAN JOHN M. SABLAS', 'Signature over Printed Name', 'Budget Officer II', null);
            makeSigBlock(12, 15, 'SITTIE RAHMA V. ALAWI, MTM, CSSGB', 'Signature over Printed Name', 'Regional Director, DICT X', null);

            // Endorsed By Section
            sheet.getCell('A27').value = 'Endorsed by:';
            sheet.getCell('A27').font = { name: 'Arial', size: 9.5, bold: true };

            sheet.mergeCells('A30:D30');
            var endCell = sheet.getCell('A30');
            endCell.value = 'EUGENE C. RAPOSALA III';
            endCell.font = { name: 'Arial', size: 9.5, bold: true };
            endCell.alignment = { horizontal: 'center', vertical: 'middle' };
            for (var ec = 1; ec <= 4; ec++) {
                sheet.getRow(30).getCell(ec).border = sigUnderline;
            }

            sheet.mergeCells('A31:D31');
            var endTCell = sheet.getCell('A31');
            endTCell.value = 'Signature over Printed Name';
            endTCell.font = { name: 'Arial', size: 8.5 };
            endTCell.alignment = { horizontal: 'center', vertical: 'middle' };

            sheet.mergeCells('A32:D32');
            var endOCell = sheet.getCell('A32');
            endOCell.value = 'Chief, Technical Operations Division';
            endOCell.font = { name: 'Arial', size: 8.5 };
            endOCell.alignment = { horizontal: 'center', vertical: 'middle' };

            // 10. Instructions sheet: allowed values, read from the form itself
            var allowed = getAllowedValues();
            var help = workbook.addWorksheet('Instructions');
            help.columns = [{ width: 34 }, { width: 80 }];
            var helpRows = [
                ['How to fill in the "' + TEMPLATE_SHEET + '" sheet', ''],
                ['', ''],
                ['Rows', 'One item per row, in the numbered rows under the headers. Add more rows above the TOTAL BUDGET row if you need them.'],
                ['Dates', 'Start, End and Delivery must be full dates (YYYY-MM-DD), e.g. 2026-10-01. End must not be before Start; Delivery must be after End.'],
                ['Budget', 'A number greater than 0. The mode must match the budget bracket (e.g. Small Value Procurement within its limit).'],
                ['Strategies', 'One or more of the strategies below, separated by a semicolon or a new line.'],
                ['Supporting documents', 'Leave blank. Files cannot be imported; attach them to each item (Edit) before submitting.'],
                ['General Requirements/Miscellaneous/Common Supplies and Equipment', 'Optional. Pick one of the options below (the cells have a dropdown), or leave blank.\n' + GENERAL_REQUIREMENT_OPTIONS.join('\n')],
                ['Do not change', 'The header rows, the sheet name, or the TOTAL BUDGET / signature rows.'],
                ['', ''],
                ['Type of the Project', allowed.types.join('\n')],
                ['Recommended Mode of Procurement', allowed.modes.join('\n')],
                ['Pre-Procurement Conference', allowed.yesNo.join('\n')],
                ['Criteria for Bid Evaluation', allowed.criteria.join('\n')],
                ['Procurement Strategies and Tools', allowed.strategies.join('\n')]
            ];
            helpRows.forEach(function (values, i) {
                var row = help.getRow(i + 1);
                row.getCell(1).value = values[0];
                row.getCell(2).value = values[1];
                row.getCell(1).font = { name: 'Arial', size: i === 0 ? 13 : 10, bold: true };
                row.getCell(2).font = { name: 'Arial', size: 10 };
                row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
                row.getCell(1).alignment = { vertical: 'top' };
            });

            // 11. Generate and trigger download
            var buffer = await workbook.xlsx.writeBuffer();
            var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = TEMPLATE_FILE;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toast('Template downloaded successfully.');
        } catch (err) {
            console.error('Failed to generate template:', err);
            toast('Could not download styled template: ' + err.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ------------------------------------------------------------
    // Reading the uploaded file
    // ------------------------------------------------------------

    function handleFile(file) {
        if (!file) return;

        if (!window.XLSX) {
            toast('The Excel library could not be loaded. Check your internet connection and reload the page.');
            return;
        }
        if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
            toast('Please choose an Excel (.xlsx, .xls) or .csv file.');
            return;
        }
        if (file.size > MAX_IMPORT_BYTES) {
            toast('That file is larger than 2 MB. Please split it into smaller files.');
            return;
        }

        var reader = new FileReader();
        reader.onerror = function () { toast('The file could not be read.'); };
        reader.onload = function () {
            var rows;
            try {
                var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
                var sheetName = wb.SheetNames.indexOf(TEMPLATE_SHEET) !== -1 ? TEMPLATE_SHEET : wb.SheetNames[0];
                rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
            } catch (err) {
                console.error('Bulk import: could not parse file', err);
                toast('That file could not be read. Is it a valid Excel or CSV file?');
                return;
            }
            showReview(analyzeRows(rows, getAllowedValues()), file.name);
        };
        reader.readAsArrayBuffer(file);
    }

    // ------------------------------------------------------------
    // Where the items will go
    // ------------------------------------------------------------

    function readHeader() {
        var val = function (id) {
            var el = document.getElementById(id);
            return el ? String(el.value || '').trim() : '';
        };
        return {
            ppmp_no: val('ppmp_no'),
            fiscal_year: val('fiscal_year'),
            end_user: val('end_user'),
            is_indicative: val('is_indicative')
        };
    }

    function isAddingToExisting() {
        return typeof currentEditingId !== 'undefined' && !!currentEditingId;
    }

    function describeTarget() {
        var h = readHeader();
        if (isAddingToExisting()) return 'Items will be added to PPMP No. ' + (h.ppmp_no || '-') + '.';
        return 'Items will create a new Draft PPMP: No. ' + (h.ppmp_no || '-') +
            (h.fiscal_year ? ', FY ' + h.fiscal_year : '') + (h.end_user ? ', ' + h.end_user : '') + '.';
    }

    // Saves the items. Mirrors the record shape used by saveProcurementRequest().
    function commitImport(items) {
        var permSession = typeof getSession === 'function' ? getSession() : null;
        if (!permSession || !permSession.canRequest) {
            toast('Your account is view/approve only and cannot import items.');
            return false;
        }

        var header = readHeader();

        if (!header.is_indicative) {
            if (typeof showFieldError === 'function') {
                showFieldError('is_indicative', 'Select Indicative or Final before importing items.');
            }
            toast('Select "Indicative or Final" on the form first, then import.');
            return false;
        }

        // A new PPMP can't be created under a fiscal year whose APP is Final.
        if (!isAddingToExisting() && typeof getClosedFiscalYearMessage === 'function') {
            var closedMsg = getClosedFiscalYearMessage(header.fiscal_year || String(new Date().getFullYear()));
            if (closedMsg) {
                if (typeof showFieldError === 'function') showFieldError('fiscal_year', closedMsg);
                toast(closedMsg);
                return false;
            }
        }

        var stamp = Date.now();
        var stamped = items.map(function (item, i) {
            return Object.assign({ id: stamp + i }, item);
        });

        var db = JSON.parse(localStorage.getItem('procurement_records')) || [];
        var session = typeof getSession === 'function' ? getSession() : null;
        var existing = isAddingToExisting() ? db.find(function (r) { return r.id == currentEditingId; }) : null;

        // The PPMP may have been submitted or approved since the form opened.
        if (existing && typeof getPpmpStatus === 'function' && getPpmpStatus(existing) !== 'Draft') {
            toast('This PPMP was submitted or approved in the meantime, so items can no longer be added.');
            return false;
        }
        var ppmpNo;

        if (existing) {
            var merged = (typeof getRecordItems === 'function' ? getRecordItems(existing) : []).slice().concat(stamped);
            var updated = Object.assign({}, existing, { items: merged });
            db[db.findIndex(function (r) { return r.id == currentEditingId; })] = updated;
            ppmpNo = updated.ppmp_no;
        } else {
            ppmpNo = header.ppmp_no || (typeof getNextPpmpNumber === 'function' ? String(getNextPpmpNumber(header.fiscal_year)) : 'N/A');
            db.push({
                id: stamp,
                creatorId: session ? session.id : null,
                ppmp_no: ppmpNo,
                is_indicative: header.is_indicative,
                end_user: header.end_user || (session && session.office) || 'N/A',
                fiscal_year: header.fiscal_year || String(new Date().getFullYear()),
                items: stamped,
                status: 'Draft',
                currentApproverRole: null,
                remarksHistory: [],
                date: new Date().toLocaleDateString()
            });
        }

        try {
            localStorage.setItem('procurement_records', JSON.stringify(db));
        } catch (err) {
            console.error('Bulk import: could not save', err);
            toast('The items could not be saved (browser storage is full).');
            return false;
        }

        if (typeof closeRequestModal === 'function') closeRequestModal();
        if (typeof refreshDashboardRecords === 'function') refreshDashboardRecords();

        toast(stamped.length + (stamped.length === 1 ? ' item' : ' items') +
            ' imported under PPMP No. ' + ppmpNo + '. Attach the supporting documents before submitting.');
        return true;
    }

    // ------------------------------------------------------------
    // Dialogs (one at a time): the import dialog and the review dialog
    // ------------------------------------------------------------

    var dialogEl = null;

    function closeDialog() {
        if (dialogEl && dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
        dialogEl = null;
    }

    // Capture phase so Esc closes only this dialog, not the request form
    // behind it (request-modal.js closes on Esc too).
    if (typeof document !== 'undefined') {
        document.addEventListener('keydown', function (e) {
            if (dialogEl && e.key === 'Escape') {
                e.stopPropagation();
                e.preventDefault();
                closeDialog();
            }
        }, true);
    }

    // Builds the overlay + card, shows it, and returns the overlay.
    function openDialog(titleId, innerHtml) {
        closeDialog();
        var overlay = document.createElement('div');
        overlay.className = 'bi-overlay';
        overlay.innerHTML =
            '<div class="bi-dialog" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' + innerHtml + '</div>';
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(); });
        document.body.appendChild(overlay);
        dialogEl = overlay;
        return overlay;
    }

    // ------------------------------------------------------------
    // Review dialog (after a file has been read)
    // ------------------------------------------------------------

    function showReview(result, fileName) {
        var body = '';
        if (result.fatal) {
            body = '<p class="bi-fatal">' + esc(result.fatal) + '</p>';
        } else {
            body += '<div class="bi-summary">' +
                '<span class="bi-chip is-ok">' + result.ready.length + ' ready</span>' +
                (result.problems.length ? '<span class="bi-chip is-bad">' + result.problems.length + ' with problems</span>' : '') +
                '<span class="bi-chip">' + result.total + ' rows read</span></div>';

            if (result.problems.length) {
                body += '<h4 class="bi-sub">Rows that need fixing (they will be skipped)</h4><ul class="bi-problems">' +
                    result.problems.map(function (p) {
                        return '<li><strong>Row ' + p.rowNumber + '</strong><ul>' +
                            p.errors.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></li>';
                    }).join('') + '</ul>';
            }

            if (result.ready.length) {
                var shown = result.ready.slice(0, 8);
                body += '<h4 class="bi-sub">Ready to import</h4><div class="bi-table-wrap"><table class="bi-table"><thead><tr>' +
                    '<th>Row</th><th>Description</th><th>Type</th><th>Mode</th><th>Budget</th></tr></thead><tbody>' +
                    shown.map(function (r) {
                        return '<tr><td>' + r.rowNumber + '</td><td>' + esc(r.item.project_description) + '</td><td>' +
                            esc(r.item.project_type) + '</td><td>' + esc(r.item.mode) + '</td><td>' +
                            esc(pesoText(parseFloat(r.item.budget))) + '</td></tr>';
                    }).join('') + '</tbody></table></div>' +
                    (result.ready.length > shown.length
                        ? '<p class="bi-more">and ' + (result.ready.length - shown.length) + ' more</p>' : '');
                body += '<p class="bi-note">' + esc(describeTarget()) +
                    ' Supporting documents are not part of the file, so attach them to each item (Edit) before submitting.</p>';
            }
        }

        var canImport = !result.fatal && result.ready.length > 0;
        var overlay = openDialog('biReviewTitle',
            '<h3 id="biReviewTitle">Review import</h3>' +
            '<p class="bi-file">' + esc(fileName) + '</p>' +
            '<div class="bi-dialog-body">' + body + '</div>' +
            '<div class="bi-dialog-actions">' +
                '<button type="button" class="bi-btn is-secondary" data-bi-back>Choose another file</button>' +
                '<span class="bi-spacer"></span>' +
                '<button type="button" class="bi-btn is-secondary" data-bi-cancel>' + (canImport ? 'Cancel' : 'Close') + '</button>' +
                (canImport ? '<button type="button" class="bi-btn" data-bi-confirm>Import ' + result.ready.length +
                    (result.ready.length === 1 ? ' item' : ' items') + '</button>' : '') +
            '</div>');

        overlay.querySelector('[data-bi-cancel]').addEventListener('click', closeDialog);
        overlay.querySelector('[data-bi-back]').addEventListener('click', openImportDialog);
        var confirmBtn = overlay.querySelector('[data-bi-confirm]');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', function () {
                // On failure the form shows what to fix (e.g. Indicative/Final).
                commitImport(result.ready.map(function (r) { return r.item; }));
                closeDialog();
            });
        }
        (confirmBtn || overlay.querySelector('[data-bi-cancel]')).focus();
    }

    // ------------------------------------------------------------
    // Import dialog: download the template, then drop the filled file
    // ------------------------------------------------------------

    function openImportDialog() {
        var indicativeEl = document.getElementById('is_indicative');
        // Only a brand-new PPMP needs the choice here; adding to an existing
        // PPMP keeps that PPMP's own value.
        var needsType = !isAddingToExisting() && indicativeEl && !indicativeEl.disabled;
        var typeField = '';
        if (needsType) {
            var options = Array.prototype.slice.call(indicativeEl.options)
                .filter(function (o) { return o.value && !o.disabled; });
            typeField =
                '<label class="bi-type-field"><span>PPMP type for these items</span>' +
                '<select id="biIndicative"><option value="">Select\u2026</option>' +
                options.map(function (o) {
                    return '<option value="' + esc(o.value) + '"' + (o.value === indicativeEl.value ? ' selected' : '') + '>' + esc(o.value) + '</option>';
                }).join('') + '</select></label>';
        }

        var overlay = openDialog('biImportTitle',
            '<h3 id="biImportTitle">Bulk import from Excel</h3>' +
            '<p class="bi-file">' + esc(describeTarget()) + '</p>' +
            '<div class="bi-dialog-body">' +
                '<div class="bi-step"><span class="bi-num">1</span><div class="bi-step-main">' +
                    '<strong>Download the template</strong>' +
                    '<p>Fill in one row per item. The Instructions sheet lists the allowed values.</p>' +
                    '<button type="button" class="bi-btn is-secondary" id="biDownloadBtn">' +
                        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                        'Download template</button>' +
                '</div></div>' +
                '<div class="bi-step"><span class="bi-num">2</span><div class="bi-step-main">' +
                    '<strong>Upload the filled file</strong>' +
                    '<p>Every row is checked before anything is saved.</p>' +
                    typeField +
                    '<div class="bi-drop" id="biDrop" tabindex="0" role="button" aria-label="Upload the filled template">' +
                        '<span class="bi-drop-text">Drop the file here or <span class="bi-link">browse</span></span>' +
                        '<span class="bi-drop-sub">.xlsx, .xls or .csv &middot; up to 2 MB &middot; up to ' + MAX_IMPORT_ROWS + ' items</span>' +
                    '</div>' +
                    '<input type="file" id="biFileInput" accept=".xlsx,.xls,.csv" hidden>' +
                '</div></div>' +
            '</div>' +
            '<div class="bi-dialog-actions"><span class="bi-spacer"></span>' +
                '<button type="button" class="bi-btn is-secondary" data-bi-cancel>Close</button></div>');

        var input = overlay.querySelector('#biFileInput');
        var drop = overlay.querySelector('#biDrop');

        overlay.querySelector('[data-bi-cancel]').addEventListener('click', closeDialog);
        overlay.querySelector('#biDownloadBtn').addEventListener('click', downloadTemplate);

        var typeSelect = overlay.querySelector('#biIndicative');
        if (typeSelect) {
            typeSelect.addEventListener('change', function () {
                // Keeps the form's own field in step, so the saved PPMP uses it.
                indicativeEl.value = typeSelect.value;
            });
        }

        drop.addEventListener('click', function () { input.click(); });
        drop.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
        });
        input.addEventListener('change', function () { handleFile(input.files && input.files[0]); });

        ['dragenter', 'dragover'].forEach(function (name) {
            drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
        });
        ['dragleave', 'drop'].forEach(function (name) {
            drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
        });
        drop.addEventListener('drop', function (e) {
            handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
        });

        drop.focus();
    }

    // ------------------------------------------------------------
    // The button in the request form's top bar (beside Close)
    // ------------------------------------------------------------

    function buildButton() {
        if (document.getElementById('biOpenBtn')) return;
        var bar = document.querySelector('#requestModalOverlay .db-modal-header-actions');
        if (!bar) return;

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'biOpenBtn';
        btn.className = 'bi-open-btn hidden';
        btn.setAttribute('aria-label', 'Bulk import items from Excel');
        btn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M12 15V4m0 0L8 8m4-4l4 4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            'Bulk import';
        btn.addEventListener('click', openImportDialog);
        bar.insertBefore(btn, bar.firstChild);
    }

    // Visible only when creating: not while viewing a saved PPMP, not while
    // editing one of its items, and only for accounts that can request.
    function updateButton() {
        var btn = document.getElementById('biOpenBtn');
        if (!btn) return;

        var session = typeof getSession === 'function' ? getSession() : null;
        var viewing = typeof isViewMode !== 'undefined' && isViewMode;
        var editingItem = typeof currentEditingItemId !== 'undefined' && !!currentEditingItemId;
        btn.classList.toggle('hidden', !(session && session.canRequest) || viewing || editingItem);
    }

    // Re-check the button after each way of opening/changing the form.
    function hookFormFunctions() {
        ['openRequestModal', 'addEntryToPpmp', 'loadRecordIntoModal', 'enableEditMode'].forEach(function (name) {
            var original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function () {
                var result = original.apply(this, arguments);
                updateButton();
                return result;
            };
        });
    }

    function init() {
        buildButton();
        hookFormFunctions();
        updateButton();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    // Exposed for testing and for the console.
    var api = {
        COLUMNS: COLUMNS,
        toIsoDate: toIsoDate,
        toBudget: toBudget,
        mapHeaders: mapHeaders,
        findHeader: findHeader,
        validateRow: validateRow,
        analyzeRows: analyzeRows,
        downloadTemplate: downloadTemplate
    };
    if (typeof window !== 'undefined') window.BulkImport = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();