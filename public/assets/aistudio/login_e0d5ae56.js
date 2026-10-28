/* ============================================================
   DICT PROCUREMENT — LOGIN LOGIC
   Same theme-toggle pattern as dashboard-logic.js (shares the
   'dashboard_theme' localStorage key so the choice carries over
   once the user reaches the dashboard).

   Credentials are checked against the ACCOUNTS list defined in
   auth.js (three hardcoded office accounts — no backend yet).
   ============================================================ */

function initThemeToggle() {
    const root = document.documentElement;
    const toggleBtn = document.getElementById('themeToggle');
    const moonIcon = document.getElementById('themeIconMoon');
    const sunIcon = document.getElementById('themeIconSun');

    if (!toggleBtn) return;

    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        if (moonIcon && sunIcon) {
            moonIcon.style.display = theme === 'dark' ? '' : 'none';
            sunIcon.style.display = theme === 'light' ? '' : 'none';
        }
    }

    const savedTheme = localStorage.getItem('dashboard_theme') || 'dark';
    applyTheme(savedTheme);

    toggleBtn.addEventListener('click', function () {
        const nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(nextTheme);
        localStorage.setItem('dashboard_theme', nextTheme);
    });
}

function showLoginError(msg) {
    const banner = document.getElementById('loginError');
    const text = document.getElementById('loginErrorText');
    text.textContent = msg;
    banner.classList.add('show');
}

function clearLoginError() {
    document.getElementById('loginError').classList.remove('show');
}

function setFieldError(fieldId, hasError) {
    const group = document.getElementById(fieldId).closest('.login-field');
    group.classList.toggle('error-state', hasError);
}

function showLoginToast(msg) {
    const toast = document.getElementById('loginToast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1400);
}

function setLoginLoading(loading) {
    const btn = document.getElementById('loginSubmitBtn');
    const label = document.getElementById('loginBtnLabel');
    btn.disabled = loading;
    label.innerHTML = loading
        ? '<span class="login-spinner"></span> Signing in...'
        : 'Sign In';
}

function handleLogin(e) {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    clearLoginError();
    setFieldError('loginEmail', false);
    setFieldError('loginPassword', false);

    let hasError = false;
    if (!email) { setFieldError('loginEmail', true); hasError = true; }
    if (!password) { setFieldError('loginPassword', true); hasError = true; }

    if (hasError) {
        showLoginError('Please fill in all fields.');
        return;
    }

    setLoginLoading(true);

    setTimeout(() => {
        const account = typeof findAccount === 'function' ? findAccount(email, password) : null;

        setLoginLoading(false);

        if (!account) {
            setFieldError('loginEmail', true);
            setFieldError('loginPassword', true);
            showLoginError('Invalid email or password.');
            return;
        }

        setSession(account);
        showLoginToast(`Welcome back, ${account.roleName}!`);
        setTimeout(() => { window.location.href = 'index.html'; }, 700);
    }, 500);
}

document.addEventListener('DOMContentLoaded', function () {
    initThemeToggle();

    // If someone's already signed in, skip straight past the login form.
    if (typeof getSession === 'function' && getSession()) {
        window.location.replace('index.html');
        return;
    }

    const form = document.getElementById('loginForm');
    if (form) form.addEventListener('submit', handleLogin);

    ['loginEmail', 'loginPassword'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', function () {
            clearLoginError();
            setFieldError(id, false);
        });
    });
});