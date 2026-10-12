async function generatePPMP_PDF() {
    // The PDF libraries load from a CDN; if they didn't (offline, blocked,
    // or a page that forgot the <script> tags), say so instead of failing silently.
    if (!window.jspdf || !window.jspdf.jsPDF) {
        const msg = 'The PDF library could not be loaded. Check your internet connection and reload the page.';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
    });

    if (typeof doc.autoTable !== 'function') {
        const msg = 'The PDF table plugin could not be loaded. Check your internet connection and reload the page.';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return;
    }

    // 1. COLLECT DATA (Safely)
    const getVal = (id) => document.getElementById(id) ? document.getElementById(id).value : "N/A";

    const data = {
        ppmp: getVal('ppmp_no'),
        type: getVal('is_indicative'),
        year: getVal('fiscal_year'),
        unit: getVal('end_user')
    };

    // The Export PDF button only ever appears once a saved PPMP is open in
    // the modal (see loadRecordIntoModal), so pull every line item that
    // belongs to it from storage — not just whichever single item happens
    // to be on screen — so the export matches the real, multi-item PPMP.
    let items = [];
    let approvedRecord = null;
    if (typeof currentEditingId !== 'undefined' && currentEditingId && typeof getRecords === 'function') {
        const record = getRecords().find(r => r.id == currentEditingId);
        if (record) {
            approvedRecord = record;
            items = typeof getRecordItems === 'function' ? getRecordItems(record) : [record];
        }
    }
    if (items.length === 0) {
        // Fallback (shouldn't normally happen): use whatever is currently
        // on screen as a single-item PDF.
        items = [{
            project_description: getVal('project_description'),
            project_type: getVal('project_type'),
            quantity_size: getVal('quantity_size'),
            mode: getVal('modeOfProcurement'),
            pre_procurement: getVal('pre_procurement'),
            bid_evaluation_criteria: getVal('bid_evaluation_criteria'),
            start_date: getVal('start_date'),
            end_date: getVal('end_date'),
            delivery_period: getVal('delivery_period'),
            fund_source: getVal('fund_source'),
            budget: getVal('budget'),
            strategies: typeof selectedStrategies !== 'undefined' ? selectedStrategies : [],
            remarks: getVal('remarks')
        }];
    }

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 10;

    // 2. LOAD HEADER IMAGE
    // The banner is drawn at its real aspect ratio (fit inside the printable
    // width and a maximum height, centred) so it is never stretched.
    let currentY = 25;
    try {
        // Fetch the image from the local folder as a "Blob"
        const response = await fetch('images/header-banner.png');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const blob = await response.blob();

        // Convert that Blob into a data URL the PDF generator can use
        const imgData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        // Read the picture's natural size so we can keep its proportions
        const natural = await new Promise((resolve, reject) => {
            const probe = new Image();
            probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
            probe.onerror = reject;
            probe.src = imgData;
        });

        const maxImgWidth = pageWidth - margin * 2;
        const maxImgHeight = 30;   // tallest the banner may be (mm); raise if you want a bigger header
        const scale = Math.min(maxImgWidth / natural.w, maxImgHeight / natural.h);
        const imgWidth = natural.w * scale;
        const imgHeight = natural.h * scale;
        const imgX = (pageWidth - imgWidth) / 2;   // centre on the page

        doc.addImage(imgData, 'PNG', imgX, 5, imgWidth, imgHeight);
        currentY = 5 + imgHeight + 10;
    } catch (e) {
        console.error("Image loading failed:", e);
        // If it fails, start lower so the text doesn't overlap a missing image
        currentY = 30;
    }

    // 3. LOGOS AND HEADERS
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${data.ppmp}`, pageWidth / 2, currentY, { align: "center" });

    currentY += 6;
    doc.setFontSize(9);
    doc.rect(130, currentY - 3, 4, 4); 
    if(data.type === "Indicative") doc.text("X", 131, currentY);
    doc.text("INDICATIVE", 136, currentY);

    doc.rect(165, currentY - 3, 4, 4);
    if(data.type === "Final") doc.text("X", 166, currentY);
    doc.text("FINAL", 171, currentY);

    currentY += 10;
    doc.setFontSize(10);
    doc.text(`Fiscal Year : ${data.year}`, margin, currentY);
    doc.text(`End-User or Implementing Unit:  ${data.unit}`, margin, currentY + 5);

    // 4. PREPARE TABLE DATA
    // Clean each item's budget string (remove commas/spaces) so toLocaleString works
    const parseBudget = (raw) => parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
    const totalBudget = items.reduce((sum, item) => sum + parseBudget(item.budget), 0);
    const formattedTotal = totalBudget.toLocaleString('en-PH', { minimumFractionDigits: 2 });

    const headers = [
        [
            { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: { halign: 'center' } },
            { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 3, styles: { halign: 'center' } },
            { content: 'FUNDING DETAILS', colSpan: 2, styles: { halign: 'center' } },
            { content: 'PROCUREMENT STRATEGIES AND TOOLS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
            { content: 'ATTACHED SUPPORTING DOCUMENTS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
            { content: 'REMARKS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } }
        ],
        [
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
        ],
        ['Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5', 'Column 6', 'Column 7', 'Column 8', 'Column 9', 'Column 10', 'Column 11', 'Column 12', 'Column 13', 'Column 14']
    ];

    const itemRows = items.map(item => {
        const formattedBudget = parseBudget(item.budget).toLocaleString('en-PH', { minimumFractionDigits: 2 });
        const strategiesStr = Array.isArray(item.strategies) && item.strategies.length > 0
            ? item.strategies.join("\n") 
            : (item.strategies || "None");
        const docsStr = Array.isArray(item.supporting_documents) && item.supporting_documents.length > 0
            ? item.supporting_documents.map(d => d.name || 'Document').join('\n')
            : "None";

        return [
            item.project_description || '',
            item.project_type || '',
            item.quantity_size || '',
            item.mode || '',
            item.pre_procurement || '',
            item.bid_evaluation_criteria || 'N/A', // Col 6: Criteria
            item.start_date || '',
            item.end_date || '',
            item.delivery_period || '',
            item.fund_source || '',
            `P ${formattedBudget}`,
            strategiesStr,                         // Col 12: Strategies
            docsStr,                               // Col 13: Attached Documents
            item.remarks || ''                     // Col 14: Remarks
        ];
    });

    const rows = [
        ...itemRows,
        [
            { content: 'TOTAL BUDGET:', colSpan: 10, styles: { halign: 'right', fontStyle: 'bold' } },
            { content: `P ${formattedTotal}`, styles: { fontStyle: 'bold' } },
            '',
            '',
            ''
        ]
    ];

    // Column widths are proportional shares of the printable width (A4 landscape
    // minus margins), so all 14 columns fit on the page and no word gets chopped
    // mid-way. Order = the 14 columns of the PPMP form.
    const usableWidth = pageWidth - margin * 2;
    const colWeights = [
        9.5,   // 1  General description
        7,     // 2  Type of project
        7.5,   // 3  Quantity and size
        7.5,   // 4  Mode of procurement
        5.5,   // 5  Pre-procurement conference
        7.5,   // 6  Criteria for bid evaluation
        6,     // 7  Start of procurement
        6,     // 8  End of procurement
        7,     // 9  Delivery / implementation period
        6.5,   // 10 Source of funds
        10,    // 11 Estimated budget
        11.5,  // 12 Strategies and tools
        8.5,   // 13 Attached documents
        6.5    // 14 Remarks
    ];
    const weightTotal = colWeights.reduce((a, b) => a + b, 0);
    const columnStyles = {};
    colWeights.forEach((weight, i) => {
        columnStyles[i] = { cellWidth: usableWidth * weight / weightTotal };
    });
    columnStyles[10].halign = 'right';   // money lines up on the right

    doc.autoTable({
        startY: currentY + 10,
        head: headers,
        body: rows,
        theme: 'grid',
        margin: { left: margin, right: margin },
        tableWidth: usableWidth,
        rowPageBreak: 'avoid',           // never split one item's row across two pages
        styles: {
            fontSize: 6,
            cellPadding: 1.5,
            textColor: [0, 0, 0],
            lineColor: [0, 0, 0],
            lineWidth: 0.1,
            overflow: 'linebreak',
            valign: 'top'
        },
        headStyles: {
            fillColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 5.5,
            halign: 'center',
            valign: 'middle',
            cellPadding: 1.5
        },
        columnStyles: columnStyles
    });

    // 5. SIGNATORIES
    const pageHeight = doc.internal.pageSize.getHeight();
    let finalY = doc.lastAutoTable.finalY + 15;
    // The signature blocks need ~70mm; start a new page instead of running off the bottom.
    if (finalY + 70 > pageHeight) {
        doc.addPage();
        finalY = 20;
    }
    doc.setFontSize(7);
    
    // Left: Prepared By
    doc.text("Prepared by / Submitted by:", margin, finalY);
    doc.line(margin, finalY + 10, margin + 60, finalY + 10);
    doc.setFont("helvetica", "bold");
    doc.text("JAYMARK D. DUMIO", margin + 30, finalY + 14, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text("Signature over Printed Name", margin + 30, finalY + 18, { align: "center" });
    doc.text("Focal, ICT Literacy Competency and Development Bureau X", margin + 30, finalY + 22, { align: "center" });
    doc.text("Date: " + new Date().toLocaleDateString(), margin + 30, finalY + 30, { align: "center" });

    // Center: Certified Funds
    doc.text("Certified Funds Available:", pageWidth / 2 - 30, finalY);
    doc.line(pageWidth / 2 - 35, finalY + 10, pageWidth / 2 + 25, finalY + 10);
    doc.setFont("helvetica", "bold");
    doc.text("BRYAN JOHN M. SABLAS", pageWidth / 2 - 5, finalY + 14, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text("Signature over Printed Name", pageWidth / 2 - 5, finalY + 18, { align: "center" });
    doc.text("Budget Officer II", pageWidth / 2 - 5, finalY + 22, { align: "center" });

    // Right: Approved By
    doc.text("Approved by:", pageWidth - 70, finalY);
    doc.line(pageWidth - 70, finalY + 10, pageWidth - margin, finalY + 10);
    doc.setFont("helvetica", "bold");
    doc.text("SITTIE RAHMA V. ALAWI, MTM, CSSGB", pageWidth - 35, finalY + 14, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text("Signature over Printed Name", pageWidth - 35, finalY + 18, { align: "center" });
    doc.text("Regional Director, DICT X", pageWidth - 35, finalY + 22, { align: "center" });
    if (approvedRecord && approvedRecord.status === 'Completed' && approvedRecord.approved_by) {
        const approvedOn = approvedRecord.approved_at
            ? ' on ' + new Date(Number(approvedRecord.approved_at)).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
            : '';
        doc.text('Approved in system by ' + approvedRecord.approved_by.name + approvedOn, pageWidth - 35, finalY + 26, { align: "center" });
    }

    // Bottom Left: Endorsed By
    const endorseY = finalY + 45;
    doc.text("Endorsed by:", margin, endorseY);
    doc.line(margin, endorseY + 10, margin + 60, endorseY + 10);
    doc.setFont("helvetica", "bold");
    doc.text("EUGENE C. RAPOSALA III", margin + 30, endorseY + 14, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text("Signature over Printed Name", margin + 30, endorseY + 18, { align: "center" });
    doc.text("Chief, Technical Operations Division", margin + 30, endorseY + 22, { align: "center" });

    doc.save(`PPMP_${data.ppmp}_${String(data.unit).replace(/[^\w-]+/g, '_')}.pdf`);
}

// ============================================================
// ANNUAL PROCUREMENT PLAN (APP) — PDF GENERATOR (GPPB FORMAT)
// Aggregates all approved line items into the 12-column APP table
// ============================================================

async function buildAPP_PDF(targetYear = null) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || session.role !== 'SUP') {
        const msg = 'Access denied: Only Suppliers can generate the Annual Procurement Plan (APP).';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return null;
    }
    
    if (!window.jspdf || !window.jspdf.jsPDF) {
        const msg = 'The PDF library could not be loaded. Check your internet connection.';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return null;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
    });

    if (typeof doc.autoTable !== 'function') {
        const msg = 'The PDF table plugin could not be loaded.';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return null;
    }

    // 1. Gather all Completed (fully approved) PPMPs
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const approvedRecords = records.filter(r => r.status === 'Completed');

    if (approvedRecords.length === 0) {
        const msg = 'No fully approved PPMPs available to generate the Annual Procurement Plan.';
        if (typeof showToast === 'function') showToast(msg); else alert(msg);
        return null;
    }

    // Determine Fiscal Year
    const fiscalYear = targetYear || approvedRecords[0].fiscal_year || new Date().getFullYear();
    const relevantRecords = approvedRecords.filter(r => !targetYear || String(r.fiscal_year) === String(targetYear));

    // Flatten line items with their parent implementing unit
    let appItems = [];
    relevantRecords.forEach(record => {
        const items = (typeof getRecordItems === 'function' ? getRecordItems(record) : (record.items || [record]));
        items.forEach(item => {
            appItems.push({
                ...item,
                end_user: record.end_user || 'N/A'
            });
        });
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 10;
    let currentY = 25;

    // 2. Banner Image
    try {
        const response = await fetch('images/header-banner.png');
        if (response.ok) {
            const blob = await response.blob();
            const imgData = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            const natural = await new Promise((resolve, reject) => {
                const probe = new Image();
                probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
                probe.onerror = reject;
                probe.src = imgData;
            });

            const maxImgWidth = pageWidth - margin * 2;
            const maxImgHeight = 25;
            const scale = Math.min(maxImgWidth / natural.w, maxImgHeight / natural.h);
            const imgWidth = natural.w * scale;
            const imgHeight = natural.h * scale;
            const imgX = (pageWidth - imgWidth) / 2;

            doc.addImage(imgData, 'PNG', imgX, 5, imgWidth, imgHeight);
            currentY = 5 + imgHeight + 8;
        }
    } catch (e) {
        console.warn('Banner image could not be loaded:', e);
        currentY = 25;
    }

    // 3. Document Title & Checkboxes (Matches Screenshot)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(`ANNUAL PROCUREMENT PLAN FOR FY ${fiscalYear}`, pageWidth / 2, currentY, { align: 'center' });

    currentY += 6;
    doc.setFontSize(9);
    // [ ] INDICATIVE
    doc.rect(pageWidth / 2 - 38, currentY - 3.5, 4, 4);
    doc.text('INDICATIVE', pageWidth / 2 - 32, currentY);

    // [X] FINAL (Always checked for fully approved APP)
    doc.rect(pageWidth / 2 + 5, currentY - 3.5, 4, 4);
    doc.text('X', pageWidth / 2 + 6, currentY - 0.5);
    doc.text('FINAL', pageWidth / 2 + 11, currentY);

    currentY += 8;

    // 4. Table Headers (12 Columns)
    const headers = [
        [
            { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: { halign: 'center' } },
            { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 2, styles: { halign: 'center' } },
            { content: 'FUNDING DETAILS', colSpan: 2, styles: { halign: 'center' } },
            { content: 'PROCUREMENT STRATEGY OR TOOLS', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } },
            { content: 'REMARKS\n(Other relevant descriptions of the procurement project, if applicable)', rowSpan: 2, styles: { halign: 'center', valign: 'middle' } }
        ],
        [
            'Project Title',
            'End-User or Implementing Unit',
            'General Description of the Project',
            'Mode of Procurement',
            'To be covered by an Early Procurement Activity? (Yes/No)',
            'Criteria for Bid Evaluation\n(Including Sustainability and Domestic Preference)',
            'Start of Procurement Activity',
            'End of Procurement Activity',
            'Source of Fund',
            'Estimated Budget / Approved Budget for the Contract (PhP)'
        ],
        [
            'Column 1', 'Column 2', 'Column 3', 'Column 4', 'Column 5', 'Column 6',
            'Column 7', 'Column 8', 'Column 9', 'Column 10', 'Column 11', 'Column 12'
        ]
    ];

    // Helper budget parser
    const parseBudget = (raw) => parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
    const totalBudget = appItems.reduce((sum, item) => sum + parseBudget(item.budget), 0);
    const formattedTotal = totalBudget.toLocaleString('en-PH', { minimumFractionDigits: 2 });

    // Helper to format an item row
    function formatAppRow(item) {
        const itemBudget = parseBudget(item.budget).toLocaleString('en-PH', { minimumFractionDigits: 2 });
        const strategies = Array.isArray(item.strategies) ? item.strategies.join('\n') : (item.strategies || '');

        return [
            item.project_description || item.project_type || 'N/A',
            item.end_user || 'N/A',
            item.quantity_size ? `${item.project_description} (${item.quantity_size})` : (item.project_description || ''),
            item.mode || 'N/A',
            item.pre_procurement || 'No',
            item.bid_evaluation_criteria || 'N/A',
            item.start_date || '',
            item.end_date || '',
            item.fund_source || 'N/A',
            `P ${itemBudget}`,
            strategies,
            item.remarks || ''
        ];
    }

    // Separate Direct Acquisition from General items
    const isDirectAcquisition = (item) => String(item.mode || '').trim().toLowerCase().includes('direct acquisition');
    const generalItems = appItems.filter(item => !isDirectAcquisition(item));
    const directAcquisitionItems = appItems.filter(item => isDirectAcquisition(item));

    // 5. Data Rows
    const tableBody = [];

    // --- Section 1: General Requirements ---
    tableBody.push([
        {
            content: 'General Requirements',
            colSpan: 12,
            styles: { fontStyle: 'bold', fillColor: [245, 245, 245], halign: 'left' }
        }
    ]);

    if (generalItems.length > 0) {
        generalItems.forEach(item => {
            tableBody.push(formatAppRow(item));
        });
    } else {
        tableBody.push(['', '', '', '', '', '', '', '', '', '', '', '']);
    }

    // --- Section 2: Miscellaneous Items (for Direct Acquisition only) Sec 32.2 of RA No. 12009 ---
    tableBody.push([
        {
            content: 'Miscellaneous Items (for Direct Acquisition only) Sec 32.2 of RA No. 12009',
            colSpan: 12,
            styles: { fontStyle: 'bold', fillColor: [245, 245, 245], halign: 'left' }
        }
    ]);

    if (directAcquisitionItems.length > 0) {
        directAcquisitionItems.forEach(item => {
            tableBody.push(formatAppRow(item));
        });
    } else {
        tableBody.push(['', '', '', '', '', '', '', '', '', '', '', '']);
    }

    // Total Budget Row
    tableBody.push([
        { content: 'TOTAL BUDGET:', colSpan: 9, styles: { halign: 'right', fontStyle: 'bold' } },
        { content: `P ${formattedTotal}`, styles: { halign: 'right', fontStyle: 'bold' } },
        '',
        ''
    ]);

    // Usable Width & Column Width distribution (Total: 277mm)
    const usableWidth = pageWidth - margin * 2;
    const colWeights = [
        9,    // Col 1: Project Title
        9.5,  // Col 2: End-User
        10.5, // Col 3: General Description
        9,    // Col 4: Mode of Procurement
        6.5,  // Col 5: EPA (Yes/No)
        9.5,  // Col 6: Bid Criteria
        6.5,  // Col 7: Start Date
        6.5,  // Col 8: End Date
        7,    // Col 9: Source of Fund
        9.5,  // Col 10: Budget (PhP)
        9,    // Col 11: Strategies
        7     // Col 12: Remarks
    ];
    const totalWeights = colWeights.reduce((a, b) => a + b, 0);
    const columnStyles = {};
    colWeights.forEach((w, idx) => {
        columnStyles[idx] = { cellWidth: (usableWidth * w) / totalWeights };
    });
    columnStyles[9].halign = 'right';

    doc.autoTable({
        startY: currentY,
        head: headers,
        body: tableBody,
        theme: 'grid',
        margin: { left: margin, right: margin },
        tableWidth: usableWidth,
        rowPageBreak: 'avoid',
        styles: {
            fontSize: 5.5,
            cellPadding: 1.5,
            textColor: [0, 0, 0],
            lineColor: [0, 0, 0],
            lineWidth: 0.1,
            overflow: 'linebreak',
            valign: 'top'
        },
        headStyles: {
            fillColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 5.5,
            halign: 'center',
            valign: 'middle',
            cellPadding: 1.5
        },
        columnStyles: columnStyles
    });

    // 6. Signatories Block (Page break if not enough space)
    const pageHeight = doc.internal.pageSize.getHeight();
    let finalY = doc.lastAutoTable.finalY + 12;

    if (finalY + 65 > pageHeight) {
        doc.addPage();
        finalY = 20;
    }

    doc.setFontSize(7);
    
    // Left: Prepared by
    doc.text('Supply Officer II, DICT X', margin, finalY);
    doc.line(margin, finalY + 10, margin + 60, finalY + 10);
    doc.setFont('helvetica', 'bold');
    doc.text('Name', margin + 30, finalY + 14, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.text('Signature over Printed Name', margin + 30, finalY + 18, { align: 'center' });
    doc.text('Bids and Awards Committee Secretariat', margin + 30, finalY + 22, { align: 'center' });
    doc.text('Date: ' + new Date().toLocaleDateString(), margin + 30, finalY + 28, { align: 'center' });

    // Center: Certified Funds Available
    doc.text('Assistant Regional Director, DICT X', pageWidth / 2 - 30, finalY);
    doc.line(pageWidth / 2 - 35, finalY + 10, pageWidth / 2 + 25, finalY + 10);
    doc.setFont('helvetica', 'bold');
    doc.text('Name', pageWidth / 2 - 5, finalY + 14, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.text('Signature over Printed Name', pageWidth / 2 - 5, finalY + 18, { align: 'center' });
    doc.text('Bids and Awards Committee Chairperson', pageWidth / 2 - 5, finalY + 22, { align: 'center' });

    // Right: Approved by
    doc.text('Regional Director, DICT X', pageWidth - 70, finalY);
    doc.line(pageWidth - 70, finalY + 10, pageWidth - margin, finalY + 10);
    doc.setFont('helvetica', 'bold');
    doc.text('Name', pageWidth - 35, finalY + 14, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.text('Signature over Printed Name', pageWidth - 35, finalY + 18, { align: 'center' });
    doc.text('Head of the Procuring Entity', pageWidth - 35, finalY + 22, { align: 'center' });

    // 7. Hand the finished document back (saving / previewing is up to the caller)
    return { doc, fiscalYear, fileName: `APP_FY_${fiscalYear}_DICT.pdf` };
}

// Builds the APP and downloads it.
async function generateAPP_PDF(targetYear = null) {
    const built = await buildAPP_PDF(targetYear);
    if (!built) return;

    built.doc.save(built.fileName);
    if (typeof showToast === 'function') {
        showToast(`Annual Procurement Plan for FY ${built.fiscalYear} generated successfully.`);
    }
}

// Builds the APP but does NOT download it - returns a PDF Blob for the
// preview dialog (previewAPP_PDF -> openAppPreviewModal in dashboard-logic.js).
// Uses the exact same builder as generateAPP_PDF, so the preview always
// matches the downloaded file. Returns null if it could not be built.
async function previewAPP_PDF(targetYear = null) {
    const built = await buildAPP_PDF(targetYear);
    if (!built) return null;

    return {
        blob: built.doc.output('blob'),
        fiscalYear: built.fiscalYear,
        fileName: built.fileName
    };
}