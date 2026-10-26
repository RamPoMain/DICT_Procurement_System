// ============================================================
// APP TEMPLATE EXPORT (Suppliers) — fills the DBM "APP" template as .xlsx
//
// Produces the required APP columns of APP_Template_2027 (A-N):
//   A Code (PAP)   B Procurement Program/Project   C Object Code (numeric)
//   D PMO/End-User E Mode of Procurement
//   F-I Schedule: Ads/Posting, Submission/Opening of Bids, Notice of Award,
//                 Contract Signing
//   J Source of Funds   K-M Estimated Budget (Total = MOOE + CO, a formula)
//   N Remarks
// Columns O-AQ of the template are the post-award Procurement Monitoring
// Report (not part of the APP), so they are not exported.
//
// Data = same source as the APP PDF: the latest fully approved (Completed)
// PPMP of each office for the default APP fiscal year.
//
// Needs (loaded on the page): ExcelJS, dashboard-logic.js, Auth.js.
// Load this file AFTER dashboard-logic.js.
// ============================================================

(function () {
    'use strict';

    // Accounts that get the button (session.role). Add 'ARD', 'RD' to share it.
    const EXPORT_ROLES = ['SUP'];

    const AGENCY_NAME = 'Department of Information and Communications Technology';
    const FIRST_DATA_ROW = 5;

    // The PPMP has no MOOE / CO field yet, so the class is derived here.
    // Infrastructure = Capital Outlay (CO); Goods and Consulting Services =
    // MOOE. Change this ONE function if the rule should differ, or return
    // item.expense_class once the PPMP form captures it.
    function expenseClass(item) {
        return String(item.project_type || '').trim() === 'Infrastructure' ? 'CO' : 'MOOE';
    }

    function notify(message) {
        if (typeof showToast === 'function') showToast(message);
        else alert(message);
    }

    function isoToDate(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }

    function budgetOf(item) {
        return typeof parseBudgetNumber === 'function'
            ? parseBudgetNumber(item.budget)
            : (parseFloat(String(item.budget || '').replace(/[^0-9.]/g, '')) || 0);
    }

    // ---------- workbook ----------

    const THIN = { style: 'thin', color: { argb: 'FF000000' } };
    const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    const WHITE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
    const DATE_FMT = 'dd-mmm-yyyy';
    const PESO_FMT = '#,##0.00;(#,##0.00);"-"';

    function headerCell(ws, ref, text, size) {
        const c = ws.getCell(ref);
        c.value = text;
        c.font = { name: 'Arial', size: size || 9, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.fill = WHITE;
        c.border = BORDER;
    }

    // rows: [{ code, title, end_user, mode, start, bids, award, end, fund, cls, amount, remarks }]
    function buildAppTemplateWorkbook(ExcelJSLib, rows, opts) {
        const wb = new ExcelJSLib.Workbook();
        wb.creator = 'DICT Procurement';
        wb.created = new Date();

        const ws = wb.addWorksheet('APP', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });

        const widths = [20.4, 34.9, 20.4, 24, 36, 12, 12, 12, 12, 34, 14, 14, 14, 36.4];
        widths.forEach(function (w, i) { ws.getColumn(i + 1).width = w; });

        // Title rows
        ws.mergeCells('A1:N1');
        ws.getCell('A1').value = AGENCY_NAME + ' Annual Procurement Plan for FY ' + opts.year;
        ws.getCell('A1').font = { name: 'Arial', size: 14, bold: true };
        ws.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
        ws.getRow(1).height = 30;

        ws.mergeCells('A2:N2');
        ws.getCell('A2').value = opts.statusNote;
        ws.getCell('A2').font = { name: 'Arial', size: 9, italic: true };
        ws.getCell('A2').alignment = { horizontal: 'left', vertical: 'middle' };
        ws.getRow(2).height = 18;

        // Two-row header (same layout / merges as the template)
        [['A', 'Code (PAP)'], ['B', 'Procurement Program/Project'], ['C', 'Object Code'],
         ['D', 'PMO/End-User'], ['E', 'Mode of Procurement'], ['J', 'Source of Funds'],
         ['N', 'Remarks (brief description of Program/Activity/Project)']].forEach(function (h) {
            ws.mergeCells(h[0] + '3:' + h[0] + '4');
            headerCell(ws, h[0] + '3', h[1]);
            ws.getCell(h[0] + '4').border = BORDER;
        });
        ws.mergeCells('F3:I3');
        headerCell(ws, 'F3', 'Schedule for Each Procurement Activity');
        ws.mergeCells('K3:M3');
        headerCell(ws, 'K3', 'Estimated Budget (PhP)');
        [['F', 'Advertisement/Posting of IB/REI'], ['G', 'Submission/Opening of Bids'],
         ['H', 'Notice of Award'], ['I', 'Contract Signing'],
         ['K', 'Total'], ['L', 'MOOE'], ['M', 'CO']].forEach(function (h) {
            headerCell(ws, h[0] + '4', h[1], 8);
        });
        ws.getRow(3).height = 24;
        ws.getRow(4).height = 36;

        // Data rows
        // Data rows
        rows.forEach(function (r, i) {
            const n = FIRST_DATA_ROW + i;
            const row = ws.getRow(n);
            row.values = [
                r.code || null, r.title || null,
                /^\d+$/.test(String(r.object || '')) ? Number(r.object) : null,
                r.end_user || null, r.mode || null,
                isoToDate(r.start), isoToDate(r.bids), isoToDate(r.award), isoToDate(r.end),
                r.fund || null,
                r.amount,     // Col K: Total Estimated Budget (PhP)
                r.mooe,       // Col L: MOOE ("Yes", "No", or "N/A")
                r.co,         // Col M: CO ("Yes", "No", or "N/A")
                r.remarks || null
            ];
            row.height = 36;
            for (let c = 1; c <= 14; c++) {
                const cell = row.getCell(c);
                cell.font = { name: 'Arial', size: 9 };
                cell.border = BORDER;
                cell.alignment = { 
                    vertical: 'middle', 
                    wrapText: true,
                    horizontal: (c >= 6 && c <= 9) || (c === 12 || c === 13) ? 'center' : (c === 11 ? 'right' : 'left') 
                };
                if (c === 3) cell.numFmt = '0';
                if (c >= 6 && c <= 9) cell.numFmt = DATE_FMT;
                if (c === 11) cell.numFmt = PESO_FMT; // Total is Peso; L and M remain text
            }
        });

        // Total row: Sum only Column K (Total Budget); Columns L and M remain blank
        const last = FIRST_DATA_ROW + rows.length - 1;
        const tot = last + 1;
        ws.mergeCells('A' + tot + ':J' + tot);
        ws.getCell('A' + tot).value = 'TOTAL';
        const sumTotal = rows.reduce((s, r) => s + (r.amount || 0), 0);
        ws.getCell('K' + tot).value = { formula: 'SUM(K' + FIRST_DATA_ROW + ':K' + last + ')', result: sumTotal };
        ws.getCell('K' + tot).numFmt = PESO_FMT;
        for (let c = 1; c <= 14; c++) {
            const cell = ws.getRow(tot).getCell(c);
            cell.font = { name: 'Arial', size: 9, bold: true };
            cell.border = BORDER;
            cell.fill = WHITE;
            if (c === 1) cell.alignment = { horizontal: 'right', vertical: 'middle' };
            if (c >= 11 && c <= 13) cell.alignment = { horizontal: 'right', vertical: 'middle' };
        }

        // Template behaviour: blank required cells show orange
        const orange = { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC000' } };
        ws.addConditionalFormatting({
            ref: 'A' + FIRST_DATA_ROW + ':E' + last,
            rules: [{ type: 'expression', formulae: ['LEN(TRIM(A' + FIRST_DATA_ROW + '))=0'], style: { fill: orange } }]
        });
        ws.addConditionalFormatting({
            ref: 'F' + FIRST_DATA_ROW + ':J' + last,
            rules: [{ type: 'expression', formulae: ['LEN(TRIM(F' + FIRST_DATA_ROW + '))=0'], style: { fill: orange } }]
        });

        ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

        // Notes sheet: where the data came from and what was assumed
        const ns = wb.addWorksheet('Export Notes');
        ns.getColumn(1).width = 28;
        ns.getColumn(2).width = 90;
        const notes = [
            ['APP Template Export', ''],
            ['Fiscal year', opts.year],
            ['APP status', opts.appStatus],
            ['Exported by', opts.exportedBy],
            ['Exported on', new Date().toLocaleString('en-PH')],
            ['Source PPMPs', opts.sources.join('; ')],
            ['', ''],
            ['Code (PAP)', "The entry's reference number from the system (e.g. GDS-0001)."],
            ['Object Code', "The entry's Object Code (numbers only). Entries saved before that rule with non-numeric text are left blank here."],
            ['MOOE / CO', 'The PPMP has no MOOE/CO field. Infrastructure entries are placed under CO; Goods and Consulting Services under MOOE. Review before submission.'],
            ['Estimated Budget Total', 'Formula =MOOE + CO, as in the template.'],
            ['Columns O-AQ', 'The Procurement Monitoring Report part of the template is not part of the APP and is not exported.']
        ];
        notes.forEach(function (n, i) {
            const row = ns.getRow(i + 1);
            row.values = n;
            row.font = { name: 'Arial', size: 10, bold: i === 0 || n[0] !== '' };
            row.getCell(2).font = { name: 'Arial', size: 10 };
            row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
            row.getCell(1).alignment = { vertical: 'top' };
        });
        ns.getRow(1).font = { name: 'Arial', size: 12, bold: true };

        return wb;
    }

    // ---------- data + download ----------

    function collectRows(year) {
        const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
        const approved = all.filter(function (r) { return r.status === 'Completed'; });
        const picked = typeof getLatestApprovedPpmpPerOffice === 'function'
            ? getLatestApprovedPpmpPerOffice(approved, year)
            : approved.filter(function (r) { return String(r.fiscal_year) === String(year); });

        const rows = [];
        const sources = [];
        picked.forEach(function (record) {
            sources.push((record.end_user || 'N/A') + ' - PPMP No. ' + (record.ppmp_no || 'N/A'));
            getRecordItems(record).forEach(function (item) {
                const indicators = (typeof getMooeCoIndicators === 'function')
                    ? getMooeCoIndicators(item)
                    : {
                        mooe: (item.expense_class === 'MOOE' ? 'Yes' : (item.expense_class === 'CO' ? 'No' : 'N/A')),
                        co: (item.expense_class === 'CO' ? 'Yes' : (item.expense_class === 'MOOE' ? 'No' : 'N/A'))
                    };

                rows.push({
                    code: item.reference_no || '',
                    title: item.project_description || '',
                    object: item.object_name || '',
                    end_user: record.end_user || '',
                    mode: item.mode || '',
                    start: item.start_date,
                    bids: item.bid_opening_date,
                    award: item.notice_of_award_date,
                    end: item.end_date,
                    fund: item.fund_source || '',
                    amount: budgetOf(item),
                    mooe: indicators.mooe,
                    co: indicators.co,
                    remarks: item.remarks || ''
                });
            });
        });
        return { rows: rows, sources: sources };
    }

    async function exportAppTemplateExcel(targetYear) {
        const session = typeof getSession === 'function' ? getSession() : null;
        if (!session || EXPORT_ROLES.indexOf(session.role) === -1) {
            notify('Access denied: you do not have permission to export the APP template.');
            return;
        }
        if (typeof ExcelJS === 'undefined') {
            notify('The Excel library could not be loaded. Check your internet connection.');
            return;
        }

        const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
        const year = String(targetYear || (typeof getDefaultAppFiscalYear === 'function'
            ? getDefaultAppFiscalYear(records) : new Date().getFullYear())).trim();

        const data = collectRows(year);
        if (data.rows.length === 0) {
            notify('No fully approved PPMPs for FY ' + year + ' to put in the APP template.');
            return;
        }

        const appRec = typeof getAppRecord === 'function' ? getAppRecord(year) : null;
        const isFinal = !!(appRec && appRec.status === 'Completed');
        const appStatus = isFinal ? 'Final (approved)' : 'Draft: the APP for this year has not been approved yet';

        const wb = buildAppTemplateWorkbook(ExcelJS, data.rows, {
            year: year,
            appStatus: appStatus,
            statusNote: isFinal ? 'Final APP (approved)' : 'DRAFT: this APP has not been approved yet',
            exportedBy: session.roleName + ' (' + session.email + ')',
            sources: data.sources
        });

        try {
            const buffer = await wb.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'APP_FY' + year + (isFinal ? '_Final' : '_Draft') + '.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            notify('Exported APP template for FY ' + year + ' (' + data.rows.length + ' entries).');
        } catch (err) {
            console.error('APP template export failed:', err);
            notify('The APP template could not be exported.');
        }
    }

    // Show the button only for the allowed accounts.
    document.addEventListener('DOMContentLoaded', function () {
        const session = typeof getSession === 'function' ? getSession() : null;
        const btn = document.getElementById('entriesAppTemplateBtn');
        if (btn) btn.style.display = (session && EXPORT_ROLES.indexOf(session.role) !== -1) ? 'inline-flex' : 'none';
    });

    window.exportAppTemplateExcel = exportAppTemplateExcel;
    window.buildAppTemplateWorkbook = buildAppTemplateWorkbook;
})();