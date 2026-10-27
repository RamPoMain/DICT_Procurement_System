# 🏛️ DICT Procurement Management System

[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)](https://react.dev/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/)

A centralized web application developed for the **Department of Information and Communications Technology (DICT)** to prepare, manage, approve, and consolidate **Project Procurement Management Plans (PPMP)** and compile **Annual Procurement Plans (APP)** in compliance with Philippine procurement laws (**Republic Act No. 12009**).

---

## 📋 Features

### 1. PPMP Management & 3-Step Wizard
- **3-Step Guided Form**: Form wizard validating *Project Details*, *Timeline Sequence*, and *Funding & Supporting Documents*.
- **Multi-Item Grouping**: Multiple line items grouped under one official PPMP number per office.
- **Reference Number Engine**: Auto-generates standardized reference numbers per category (`<Year>-GDS-####`, `<Year>-INF-####`, `<Year>-CSV-####`, `<Year>-GEN-####`).

### 2. Philippine Procurement Rules (RA 12009 Compliance)
- **Automated Two Failed Biddings Detection (Sec. 33)**: 
  - Detects duplicate project descriptions across approved PPMPs.
  - Automatically switches the 3rd attempt to **Negotiated Procurement – Two Failed Biddings** with **Negotiated** evaluation criteria.
  - Automatically appends `[1st Failure]` and `[2nd Failure]` tags to previous attempts.
- **Budget Threshold & Bracket Enforcement**:
  - **Direct Acquisition (Sec. 32)**: Up to ₱200,000.00 for NGAs.
  - **Small Value Procurement (SVP) (Sec. 31)**: ₱200,001.00 to ₱2,000,000.00.
  - **Shopping (Sec. 30)**: Up to ₱2,000,000.00 (restricted strictly to *Goods*).
  - **Competitive Bidding (Sec. 15)**: ₱2,000,000.00 and above (or any eligible amount).
- **Milestone Date Sequencing**: Strict chronological date validation (`Advertisement/Posting` $\rightarrow$ `Bid Opening` $\rightarrow$ `Notice of Award` $\rightarrow$ `Contract Signing` $\rightarrow$ `Delivery Period`).
- **Deduplicated Total Budget**: Multiple re-bidding attempts sharing the same reference number count only once toward the total budget.
- **Parallel Planning Lanes**: Requesting offices can maintain an active *Final* PPMP (current year) and an *Indicative* PPMP (next year) in parallel.

### 3. Multi-Stage Approval Workflows
- **PPMP Chain**: `Requesting Unit / Unit Head` $\rightarrow$ `TOD (Technical Operations Division)` $\rightarrow$ `Budget Officer` $\rightarrow$ `RD (Regional Director)`.
  - *Unit Head Submissions*: Automatically bypass the HEAD stage and endorse directly to TOD.
- **APP Master Workflow**:
  - Compiled by the **Supply Account (`SUP`)**.
  - Endorsed by the **Assistant Regional Director (`ARD`)**.
  - Final approval and marking as Final by the **Regional Director (`RD`)**.
- **Audit Trails**: Full review history tracking approver role, date, decision (Approve/Reject/Remark), and mandatory returned remarks.

### 4. Native Storage & Large File Management
- **IndexedDB `FileStore`**: Stores up to 50MB of raw document blobs (PDFs, Scope of Work, Technical Specs) natively in the browser without filling `localStorage`.
- **System Persistence**: State persistence for dark/light themes, offline sessions, and sequential approval logs.

### 5. Document Generation & Export Engines
- **GPPB-Compliant PDF Generator**:
  - Official PPMP printout with multi-item layout and 3-column signature block.
  - Automated APP PDF assembly with automated category routing:
    - General Administration and Support Services (GASS) $\rightarrow$ *Common Supplies and Equipment (CSE)*.
    - Direct Acquisition $\rightarrow$ *Miscellaneous Items (Sec. 32.2)*.
    - All other items $\rightarrow$ *General Requirements*.
- **ExcelJS Styled Spreadsheets**:
  - Single PPMP `.xlsx` download formatted to official government templates.
  - Master Entries export packaging all filtered PPMPs into dedicated sheets in one workbook.
  - Official DBM APP Template export (`.xlsx`) with embedded `=SUM()` and `=MOOE + CO` formulas.
- **Bulk Import**:
  - Excel template generator with drop-down data validation and instruction guides.
  - Multi-row template parser via SheetJS with row-by-row error diagnostics.

---

## 💻 Tech Stack

- **Framework**: [React 18+](https://react.dev/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Routing**: [React Router DOM v6](https://reactrouter.com/)
- **Spreadsheet Processing**: [ExcelJS](https://github.com/exceljs/exceljs) & [SheetJS (xlsx)](https://sheetjs.com/)
- **PDF Generation**: [jsPDF](https://github.com/parallax/jsPDF) & [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable)
- **Local Database**: IndexedDB (Native Blob API) + LocalStorage

---

## 🚀 Getting Started

### Prerequisites

Ensure you have **Node.js (v18.0.0 or higher)** and **npm** installed on your system.

```bash
node -v
npm -v
