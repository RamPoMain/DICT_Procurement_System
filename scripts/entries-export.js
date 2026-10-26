// ============================================================
// ENTRIES EXPORT — downloads the Entries table as an Excel file
//
// Exports exactly what the Entries page is showing: it reuses
// getRecords() (so each account only exports what it is allowed to see)
// and getFilteredEntryRecords() (so the Status / PPMP Type / Type /
// Category / Office / Search filters are respected).
//
// Workbook sheets:
//   1. "PPMP Entries"  one row per PPMP (same columns as the on-screen table,
//                      plus Fiscal Year, Items and Source of Funds)
//   2. "Line Items"    one row per entry (line item) inside those PPMPs
//   3. "Export Info"   who exported, when, and which filters were active
//
// Entry reference numbers (GDS-0001 ...) are intentionally NOT exported:
// dashboard-logic.js documents them as display-only in the Entries section.
//
// Needs: SheetJS (xlsx.full.min.js) and dashboard-logic.js loaded on the page.
// Load this file AFTER dashboard-logic.js.
// ============================================================

(function () {
    'use strict';

    function notify(message) {
        if (typeof showToast === 'function') showToast(message);
        else alert(message);
    }

    function pad2(n) { return String(n).padStart(2, '0'); }

    function todayStamp() {
        const d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    // Same label the table pill shows ("Returned" replaces "Draft" after a rejection).
    function statusLabel(record) {
        return isPpmpReturned(record) ? 'Returned' : getPpmpStatus(record);
    }

    function listText(value) {
        return Array.isArray(value) ? value.filter(Boolean).join('; ') : (value || '');
    }

    function docsText(item) {
        const docs = Array.isArray(item.supporting_documents) ? item.supporting_documents : [];
        return docs.map(function (d) { return d && d.name; }).filter(Boolean).join('; ');
    }

    function activeFilters() {
        function val(id, fallback) {
            const el = document.getElementById(id);
            return el && el.value ? el.value : fallback;
        }
        const search = document.getElementById('entrySearchInput');
        return [
            ['Office', val('entryOfficeFilter', 'All')],
            ['Status', val('entryStatusFilter', 'All')],
            ['PPMP Type', val('entryIndicativeFilter', 'All')],
            ['Project Type', val('entryTypeFilter', 'All')],
            ['Category', val('entryCategoryFilter', 'All')],
            ['Search', search && search.value.trim() ? search.value.trim() : '(none)']
        ];
    }

    // Sizes each column to its longest cell (capped) so the file opens readable.
    function fitColumns(rows) {
        if (!rows.length) return [];
        const keys = Object.keys(rows[0]);
        return keys.map(function (key) {
            let width = String(key).length;
            rows.forEach(function (row) {
                const len = String(row[key] == null ? '' : row[key]).length;
                if (len > width) width = len;
            });
            return { wch: Math.min(Math.max(width + 2, 10), 60) };
        });
    }

    function sheetFromRows(rows, pesoColumns) {
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = fitColumns(rows);
        // Budgets are real numbers (sortable / summable in Excel), shown as pesos.
        if (ws['!ref'] && pesoColumns && pesoColumns.length) {
            const range = XLSX.utils.decode_range(ws['!ref']);
            const headers = Object.keys(rows[0] || {});
            pesoColumns.forEach(function (name) {
                const c = headers.indexOf(name);
                if (c === -1) return;
                for (let r = range.s.r + 1; r <= range.e.r; r++) {
                    const cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
                    if (cell && cell.t === 'n') cell.z = '"₱"#,##0.00';
                }
            });
        }
        return ws;
    }

    function exportEntriesExcel() {
        if (typeof XLSX === 'undefined') {
            notify('Excel library is still loading. Please try again in a moment.');
            return;
        }

        const allRecords = getRecords();
        const records = getFilteredEntryRecords(allRecords).sort(function (a, b) { return b.id - a.id; });

        if (records.length === 0) {
            notify('Nothing to export. No PPMP entries match the current filters.');
            return;
        }

        const approvedNumbers = getApprovedEntryNumbers(allRecords);
        const ppmpRows = [];
        const itemRows = [];

        records.forEach(function (record) {
            const items = getRecordItems(record);
            const by = record.approved_by;

            ppmpRows.push({
                'No.': approvedNumbers.get(String(record.id)) || '',
                'PPMP No.': record.ppmp_no || '',
                'Fiscal Year': record.fiscal_year || '',
                'Description': getRecordDescriptionSummary(record),
                'End-User': record.end_user || '',
                'Type': getRecordProjectTypeSummary(record),
                'Items': items.length,
                'Budget': getRecordTotalBudget(record),
                'Status': statusLabel(record),
                'PPMP Type': record.is_indicative || 'N/A',
                'Approved By': isPpmpClosed(record) ? (by && by.name ? by.name : 'Not recorded') : '',
                'Date Approved': isPpmpClosed(record) ? formatApprovalDate(record.approved_at) : ''
            });

            items.forEach(function (item, i) {
                itemRows.push({
                    'PPMP No.': record.ppmp_no || '',
                    'Fiscal Year': record.fiscal_year || '',
                    'End-User': record.end_user || '',
                    'Status': statusLabel(record),
                    'Item #': i + 1,
                    'Description': item.project_description || '',
                    'Object': item.object_name || '',
                    'Type of Project': item.project_type || '',
                    'Category': item.general_requirements || '',
                    'Mode of Procurement': item.mode || '',
                    'Pre-Procurement Conference': item.pre_procurement || '',
                    'Bid Evaluation Criteria': item.bid_evaluation_criteria || '',
                    'Quantity and Size': item.quantity_size || '',
                    'Procurement Strategies': listText(item.strategies),
                    'Advertisement / Posting': item.start_date || '',
                    'Submission / Opening of Bids': item.bid_opening_date || '',
                    'Notice of Award': item.notice_of_award_date || '',
                    'Contract Signing': item.end_date || '',
                    'Delivery / Implementation': item.delivery_period || '',
                    'Source of Funds': item.fund_source || '',
                    'Estimated Budget': parseBudgetNumber(item.budget),
                    'Remarks': item.remarks || '',
                    'Supporting Documents': docsText(item)
                });
            });
        });

        const session = typeof getSession === 'function' ? getSession() : null;
        const infoRows = [
            ['DICT Procurement: PPMP Entries Export'],
            ['Exported by', session ? session.roleName + ' (' + session.email + ')' : ''],
            ['Exported on', new Date().toLocaleString('en-PH')],
            ['PPMPs exported', records.length],
            ['Line items exported', itemRows.length],
            [],
            ['Filters applied']
        ].concat(activeFilters());

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, sheetFromRows(ppmpRows, ['Budget']), 'PPMP Entries');
        XLSX.utils.book_append_sheet(wb, sheetFromRows(itemRows, ['Estimated Budget']), 'Line Items');

        const info = XLSX.utils.aoa_to_sheet(infoRows);
        info['!cols'] = [{ wch: 22 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, info, 'Export Info');

        XLSX.writeFile(wb, 'PPMP_Entries_' + todayStamp() + '.xlsx');
        notify('Exported ' + records.length + (records.length === 1 ? ' PPMP' : ' PPMPs') + ' to Excel.');
    }

    window.exportEntriesExcel = exportEntriesExcel;
})();