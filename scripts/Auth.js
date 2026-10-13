// ============================================================
// DICT PROCUREMENT — AUTH (client-side only, no backend yet)
//
// Hardcoded accounts: requesting offices, unit heads, TOD, Budget Officer, RD.
//
// Extra fields used by the approval workflow:
//   canRequest  - may create PPMPs (requesters)
//   canApprove  - may approve PPMPs
//   stage       - which approval step this account acts on:
//                 'HEAD' -> 'TOD' -> 'BO' -> 'RD'  (must match APPROVAL_CHAIN)
//   headOf      - HEAD accounts only: the End-User office they approve for
//                 (a Unit Head also does data entry for, and sees all entries
//                 of, that same unit, so their `office` is the unit itself)
//
// Each requester account's `office` string
// must exactly match the "End-User or Implementing Unit" value
// stored on a PPMP record — getRecords() in dashboard-logic.js
// filters on it, and enableModalFields() in request-modal.js
// auto-fills/locks the End-User field to it. Change an office
// name here and both stay in sync automatically.
// ============================================================

const ACCOUNTS = [
    {
        email: 'ILCDB@dict.gov.ph',
        password: 'ILCDB123',
        role: 'ILCDB',
        roleName: 'ILCDB',
        office: 'ICT Literacy Competency and Development Bureu',
        canRequest: true
    },
    {
        email: 'FPIAP@dict.gov.ph',
        password: 'FPIAP123',
        role: 'FPIAP',
        roleName: 'FPIAP',
        office: 'Free Public Internet Access Program',
        canRequest: true
    },

    {
        email: 'GASS@dict.gov.ph',
        password: 'GASS123',
        role: 'GASS',
        roleName: 'GASS',
        office: 'General Administration and Support Services',
        canRequest: true
    },

    // Head accounts are the first approvers to be followed by TOD
    {
        email: 'FPIAPHEAD@dict.gov.ph',
        password: 'FPIAPH123',
        role: 'FPIAPH',
        roleName: 'FPIAP Head',
        office: 'Free Public Internet Access Program',
        canRequest: true,
        canApprove: true,
        stage: 'HEAD',
        headOf: 'Free Public Internet Access Program'
    },
    {
        email: 'ILCDBHEAD@dict.gov.ph',
        password: 'ILCDBH123',
        role: 'ILCDBH',
        roleName: 'ILCDB Head',
        office: 'ICT Literacy Competency and Development Bureu',
        canRequest: true,
        canApprove: true,
        stage: 'HEAD',
        headOf: 'ICT Literacy Competency and Development Bureu'
    },

    {
        email: 'GASSHEAD@dict.gov.ph',
        password: 'GASSH123',
        role: 'GASSH',
        roleName: 'GASS Head',
        office: 'General Administration and Support Services',
        canRequest: true,
        canApprove: true,
        stage: 'HEAD',
        headOf: 'General Administration and Support Services'
    },

    //Next is the TOD, who is the second approver after the heads of the offices
    {
        email: 'tod@dict.gov.ph',
        password: 'tod123',
        role: 'TOD',
        roleName: 'Technical Operations Division',
        office: 'Technical Operations Division',
        canApprove: true,
        stage: 'TOD'
    },

    //Third is the Budget Officer
    {
        email: 'BudgetOfficer@dict.gov.ph',
        password: 'Budget123',
        role: 'BO',
        roleName: 'Budget Officer',
        office: 'Budget Office',
        canApprove: true,
        stage: 'BO'
    },

    {
        email: 'ard@dict.gov.ph',
        password: 'ard123',
        role: 'ARD',
        roleName: 'Assistant Regional Director',
        canApprove: true,
        stage: 'RD'
    },
    
    {
        // Authorized approver. `canApprove` is what unlocks the "Approve
        // PPMP" action. There is deliberately no `office`: getRecords() in
        // dashboard-logic.js only filters by office when the session has
        // one, so this account sees every office's PPMPs. To authorize
        // another account, just add `canApprove: true` to it.
        email: 'rd@dict.gov.ph',
        password: 'rd123',
        role: 'RD',
        roleName: 'Regional Director',
        canApprove: true,
        stage: 'RD'
    },
    {
        // Suppliers: view-only. No `canRequest` (can't create PPMPs) and no
        // `canApprove` (can't approve). There is deliberately no `office`,
        // so getRecords() in dashboard-logic.js applies no office filter;
        // `canTrackApprovals` (below) is what lets it see submitted PPMPs.
        email: 'suppliers@dict.gov.ph',
        password: 'suppliers123',
        role: 'SUP',
        roleName: 'Suppliers',
        canRequest: false,
        canApprove: false,
        canTrackApprovals: false
    },
    {
        email: 'test@dict.gov.ph',
        password: 'test123',
        role: 'POP',
        roleName: 'POP (Test Account)',
        office: 'POP Test Office',
        canRequest: true,
        canApprove: false
    },
];

// Looks up an account by email + password (case-insensitive email).
function findAccount(email, password) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    return ACCOUNTS.find(function (acct) {
        return acct.email.toLowerCase() === normalizedEmail && acct.password === password;
    }) || null;
}

// Builds the session object from an account definition.
function buildSession(account) {
    return {
        id: account.email.toLowerCase(),
        email: account.email,
        role: account.role,
        roleName: account.roleName,
        office: account.office,
        canApprove: !!account.canApprove,
        canRequest: !!account.canRequest,
        canTrackApprovals: !!account.canTrackApprovals,
        stage: account.stage || null,
        headOf: account.headOf || null
    };
}

// Reads the signed-in user. Only the email is trusted from storage: the
// permissions (stage, canApprove, canRequest, office...) are re-read from
// ACCOUNTS every time, so
//   - a login saved before Auth.js was updated picks up new fields
//     automatically (no need to log out and back in), and
//   - editing dashboard_session in devtools can't grant approval rights.
// If the account no longer exists, the user is treated as signed out.
function getSession() {
    try {
        const saved = JSON.parse(localStorage.getItem('dashboard_session'));
        if (!saved || !saved.email) return null;
        const email = String(saved.email).toLowerCase();
        const account = ACCOUNTS.find(function (acct) {
            return acct.email.toLowerCase() === email;
        });
        return account ? buildSession(account) : null;
    } catch (e) {
        return null;
    }
}

function setSession(account) {
    localStorage.setItem('dashboard_session', JSON.stringify(buildSession(account)));
}

// True when the signed-in account is allowed to approve PPMPs.
// (Client-side only, like the rest of auth — fine for the prototype,
// but this must be enforced by the backend once there is one.)
function canCurrentUserApprove() {
    const session = getSession();
    return !!(session && session.canApprove);
}

function clearSession() {
    localStorage.removeItem('dashboard_session');
}

// Call at the very top of every protected page (in <head>, before the
// page renders) — bounces straight to login.html if no one's signed in.
function requireAuth() {
    if (!getSession()) {
        window.location.replace('login.html');
    }
}

// Hides all "New Request" triggers across all pages for accounts without request rights
function applyRequestPermissions() {
    const session = getSession();
    if (!session || !session.canRequest) {
        // Hide sidebar buttons, dashboard CTA, and profile buttons
        const selectors = [
            '.db-nav-item[onclick*="startNewRequest"]',
            '.db-nav-item[onclick*="open_new_request"]',
            '.db-nav-item[onclick*="openRequestModal"]',
            '.db-cta-btn',
            '.profile-request-btn',
            '.profile-quick-card'
        ];
        document.querySelectorAll(selectors.join(', ')).forEach(el => {
            el.style.display = 'none';
        });

        // Also catch any button or link whose text says "New Request"
        document.querySelectorAll('a, button').forEach(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.includes('new request') || text.includes('create request')) {
                if (el.classList.contains('db-nav-item') || el.classList.contains('profile-request-btn') || el.classList.contains('db-cta-btn')) {
                    el.style.display = 'none';
                }
            }
        });
    }
}

// Fills the sidebar's avatar/name/email from the current session.
// Safe to call on any page that has the standard .db-avatar /
// .db-user-name / .db-user-email sidebar markup.
function applySessionToSidebar() {
    const session = getSession();
    if (!session) return;

    const initials = (session.role || '??').slice(0, 2).toUpperCase();

    document.querySelectorAll('.db-avatar').forEach(function (el) {
        el.textContent = initials;
    });
    document.querySelectorAll('.db-user-name').forEach(function (el) {
        el.textContent = session.roleName;
    });
    document.querySelectorAll('.db-user-email').forEach(function (el) {
        el.textContent = session.email;
    });

    // Optional per-page greetings (only index.html has these right now)
    const subtitle = document.getElementById('db-subtitle-greeting');
    if (subtitle) subtitle.textContent = 'Welcome back, ' + session.roleName;

    const heading = document.getElementById('db-welcome-heading');
    if (heading) heading.textContent = 'Good day, ' + session.role + '!';
}

// ============================================================
// LOGOUT — custom confirmation modal (replaces the browser confirm())
//
// The modal is built on first use and appended to <body>, so no page
// needs extra markup. Styles live in dashboard.css (.logout-*), which
// follows the same dark/light theme variables as the rest of the app.
// ============================================================

let logoutModalEl = null;
let logoutPrevFocus = null;

function buildLogoutModal() {
    const overlay = document.createElement('div');
    overlay.className = 'logout-overlay';
    overlay.id = 'logoutOverlay';
    overlay.innerHTML =
        '<div class="logout-modal" role="alertdialog" aria-modal="true" ' +
            'aria-labelledby="logoutTitle" aria-describedby="logoutDesc">' +
            '<div class="logout-icon">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="none">' +
                    '<path d="M9 20H5.6C5 20 4.5 19.5 4.5 18.9V5.1C4.5 4.5 5 4 5.6 4H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
                    '<path d="M15.5 16L19.5 12L15.5 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
                    '<path d="M19.2 12H10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
                '</svg>' +
            '</div>' +
            '<h3 id="logoutTitle">Log out?</h3>' +
            '<p id="logoutDesc">You will need to sign in again to get back to your procurement records.</p>' +
            '<div class="logout-actions">' +
                '<button type="button" class="logout-cancel-btn" data-logout-cancel>Cancel</button>' +
                '<button type="button" class="logout-confirm-btn" data-logout-confirm>Log out</button>' +
            '</div>' +
        '</div>';

    // Click on the dimmed backdrop (but not the card) cancels.
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeLogoutModal();
    });
    overlay.querySelector('[data-logout-cancel]').addEventListener('click', closeLogoutModal);
    overlay.querySelector('[data-logout-confirm]').addEventListener('click', performLogout);

    document.body.appendChild(overlay);
    return overlay;
}

// Escape closes; Tab is kept inside the two buttons while the modal is open.
function onLogoutKeydown(e) {
    if (!logoutModalEl || !logoutModalEl.classList.contains('show')) return;

    if (e.key === 'Escape') {
        e.preventDefault();
        closeLogoutModal();
        return;
    }

    if (e.key === 'Tab') {
        const buttons = logoutModalEl.querySelectorAll('button');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }
}

function openLogoutModal() {
    if (!logoutModalEl) logoutModalEl = buildLogoutModal();

    logoutPrevFocus = document.activeElement;
    logoutModalEl.classList.add('show');
    document.addEventListener('keydown', onLogoutKeydown);

    // Default focus on Cancel so a stray Enter press never logs anyone out.
    logoutModalEl.querySelector('[data-logout-cancel]').focus();
}

function closeLogoutModal() {
    if (!logoutModalEl) return;
    logoutModalEl.classList.remove('show');
    document.removeEventListener('keydown', onLogoutKeydown);
    if (logoutPrevFocus && typeof logoutPrevFocus.focus === 'function') {
        logoutPrevFocus.focus();
    }
}

function performLogout() {
    // Keep application data such as procurement_records —
    // only the session itself is cleared.
    clearSession();

    // replace() (not href) so the Back button can't return to a
    // protected page after logging out.
    window.location.replace('login.html');
}

// Wires every logout trigger on the page to the confirmation modal.
// Triggers: the sidebar .db-logout link, or any element with a
// data-logout attribute (used by the Logout button on profile.html).
function initLogoutLinks() {
    document.querySelectorAll('.db-logout, [data-logout]').forEach(function (el) {
        el.addEventListener('click', function (e) {
            e.preventDefault();
            openLogoutModal();
        });
    });
}

// If a protected page is restored from the browser's back/forward cache
// after logging out, the head script (requireAuth) doesn't run again —
// re-check here so the old page can't be viewed while signed out.
window.addEventListener('pageshow', function (e) {
    const onLoginPage = /login(\.html)?$/i.test(window.location.pathname);
    if (e.persisted && !onLoginPage && !getSession()) {
        window.location.replace('login.html');
    }
});

document.addEventListener('DOMContentLoaded', function () {
    applySessionToSidebar();
    applyRequestPermissions();
    initLogoutLinks();
});