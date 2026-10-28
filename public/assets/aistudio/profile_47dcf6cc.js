// ============================================================
// PROFILE PAGE
// ============================================================

document.addEventListener("DOMContentLoaded", function () {


    const session = typeof getSession === 'function' ? getSession() : null;
    if (!session || !session.canRequest) {
        document.querySelectorAll('.profile-request-btn, .profile-quick-card').forEach(el => {
            el.style.display = 'none';
        });
    }
    
    // --------------------------------------------------------
    // ELEMENTS
    // --------------------------------------------------------

    const personalTab =
        document.getElementById("personalInfoTab");

    const passwordTab =
        document.getElementById("changePasswordTab");

    const personalSection =
        document.getElementById("personalInfoSection");

    const passwordSection =
        document.getElementById("changePasswordSection");

    const saveButton =
        document.getElementById("saveProfileBtn");

    const themeToggle =
        document.getElementById("themeToggle");

    const moonIcon =
        document.getElementById("themeIconMoon");

    const sunIcon =
        document.getElementById("themeIconSun");


    // --------------------------------------------------------
    // LOAD PROFILE
    // --------------------------------------------------------

    loadProfile();


    function loadProfile() {

        const savedProfile =
            JSON.parse(
                localStorage.getItem("user_profile")
            );

        if (!savedProfile) {
            return;
        }

        const firstName =
            document.getElementById("firstName");

        const lastName =
            document.getElementById("lastName");

        const email =
            document.getElementById("email");

        const position =
            document.getElementById("position");

        const office =
            document.getElementById("office");


        if (firstName && savedProfile.firstName) {
            firstName.value =
                savedProfile.firstName;
        }

        if (lastName && savedProfile.lastName) {
            lastName.value =
                savedProfile.lastName;
        }

        if (email && savedProfile.email) {
            email.value =
                savedProfile.email;
        }

        if (position && savedProfile.position) {
            position.value =
                savedProfile.position;
        }

        if (office && savedProfile.office) {
            office.value =
                savedProfile.office;
        }


        updateProfileSummary();

    }


    // --------------------------------------------------------
    // UPDATE PROFILE SUMMARY
    // --------------------------------------------------------

    function updateProfileSummary() {

        const firstName =
            document.getElementById("firstName");

        const lastName =
            document.getElementById("lastName");

        const email =
            document.getElementById("email");

        const position =
            document.getElementById("position");


        const summaryName =
            document.querySelector(
                ".profile-summary-info h2"
            );

        const summaryEmail =
            document.querySelector(
                ".profile-summary-info .profile-email"
            );

        const summaryRole =
            document.querySelector(
                ".profile-summary-info .profile-role"
            );

        const avatar =
            document.querySelector(
                ".profile-avatar"
            );


        if (!firstName || !lastName) {
            return;
        }


        const first =
            firstName.value.trim();

        const last =
            lastName.value.trim();


        const fullName =
            `${first} ${last}`.trim();


        if (summaryName) {
            summaryName.textContent =
                fullName || "User";
        }


        if (summaryEmail && email) {
            summaryEmail.textContent =
                email.value.trim();
        }


        if (summaryRole && position) {
            summaryRole.textContent =
                position.value.trim();
        }


        // Generate initials
        if (avatar) {

            const firstInitial =
                first
                    ? first.charAt(0).toUpperCase()
                    : "";

            const lastInitial =
                last
                    ? last.charAt(0).toUpperCase()
                    : "";

            avatar.textContent =
                firstInitial + lastInitial;
        }

    }


    // --------------------------------------------------------
    // PERSONAL INFO TAB
    // --------------------------------------------------------

    if (personalTab) {

        personalTab.addEventListener(
            "click",
            function () {

                personalTab.classList.add("active");

                passwordTab.classList.remove("active");

                personalSection.style.display =
                    "block";

                passwordSection.style.display =
                    "none";

                saveButton.style.display =
                    "inline-flex";

            }
        );

    }


    // --------------------------------------------------------
    // CHANGE PASSWORD TAB
    // --------------------------------------------------------

    if (passwordTab) {

        passwordTab.addEventListener(
            "click",
            function () {

                passwordTab.classList.add("active");

                personalTab.classList.remove("active");

                passwordSection.style.display =
                    "block";

                personalSection.style.display =
                    "none";

                saveButton.style.display =
                    "inline-flex";

            }
        );

    }


    // --------------------------------------------------------
    // THEME
    // --------------------------------------------------------

    initializeTheme();


    function initializeTheme() {

        const savedTheme =
            localStorage.getItem(
                "dashboard_theme"
            ) || "dark";


        document.documentElement.setAttribute(
            "data-theme",
            savedTheme
        );


        updateThemeIcon(savedTheme);

    }


    function updateThemeIcon(theme) {

        if (!moonIcon || !sunIcon) {
            return;
        }


        if (theme === "light") {

            moonIcon.style.display =
                "none";

            sunIcon.style.display =
                "block";

        } else {

            moonIcon.style.display =
                "block";

            sunIcon.style.display =
                "none";

        }

    }


    if (themeToggle) {

        themeToggle.addEventListener(
            "click",
            function () {

                const currentTheme =
                    document.documentElement
                        .getAttribute("data-theme");


                const newTheme =
                    currentTheme === "dark"
                        ? "light"
                        : "dark";


                document.documentElement.setAttribute(
                    "data-theme",
                    newTheme
                );


                localStorage.setItem(
                    "dashboard_theme",
                    newTheme
                );


                updateThemeIcon(newTheme);

            }
        );

    }


    // --------------------------------------------------------
    // SAVE PROFILE
    // --------------------------------------------------------

    if (saveButton) {

        saveButton.addEventListener(
            "click",
            function () {

                // If currently on Change Password
                if (
                    passwordSection &&
                    passwordSection.style.display !== "none"
                ) {

                    changePassword();

                    return;

                }


                // Otherwise save personal information
                saveProfile();

            }
        );

    }


    // --------------------------------------------------------
    // SAVE PERSONAL INFORMATION
    // --------------------------------------------------------

    function saveProfile() {

        const firstName =
            document.getElementById("firstName");

        const lastName =
            document.getElementById("lastName");

        const email =
            document.getElementById("email");

        const position =
            document.getElementById("position");

        const office =
            document.getElementById("office");


        // Basic validation
        if (!firstName.value.trim()) {

            alert("Please enter your first name.");

            firstName.focus();

            return;

        }


        if (!lastName.value.trim()) {

            alert("Please enter your last name.");

            lastName.focus();

            return;

        }


        if (!email.value.trim()) {

            alert("Please enter your email.");

            email.focus();

            return;

        }


        if (!position.value.trim()) {

            alert("Please enter your position or role.");

            position.focus();

            return;

        }


        if (!office.value) {

            alert("Please select your office or division.");

            office.focus();

            return;

        }


        // Profile object
        const profile = {

            firstName:
                firstName.value.trim(),

            lastName:
                lastName.value.trim(),

            email:
                email.value.trim(),

            position:
                position.value.trim(),

            office:
                office.value

        };


        // Save profile
        localStorage.setItem(
            "user_profile",
            JSON.stringify(profile)
        );


        // Update summary
        updateProfileSummary();


        // Update avatar
        updateSidebarProfile();


        alert(
            "Profile changes saved successfully."
        );

    }


    // --------------------------------------------------------
    // CHANGE PASSWORD
    // --------------------------------------------------------

    function changePassword() {

        const currentPassword =
            document.getElementById(
                "currentPassword"
            );

        const newPassword =
            document.getElementById(
                "newPassword"
            );

        const confirmPassword =
            document.getElementById(
                "confirmPassword"
            );


        if (!currentPassword.value) {

            alert(
                "Please enter your current password."
            );

            currentPassword.focus();

            return;

        }


        if (!newPassword.value) {

            alert(
                "Please enter a new password."
            );

            newPassword.focus();

            return;

        }


        if (newPassword.value.length < 8) {

            alert(
                "New password must contain at least 8 characters."
            );

            newPassword.focus();

            return;

        }


        if (!confirmPassword.value) {

            alert(
                "Please confirm your new password."
            );

            confirmPassword.focus();

            return;

        }


        if (
            newPassword.value !==
            confirmPassword.value
        ) {

            alert(
                "New passwords do not match."
            );

            confirmPassword.focus();

            return;

        }


        /*
         * IMPORTANT:
         *
         * Do NOT store the actual password
         * in localStorage.
         *
         * This is only a frontend placeholder.
         * Password changes should eventually
         * be handled by your backend.
         */


        alert(
            "Password change submitted successfully."
        );


        currentPassword.value = "";

        newPassword.value = "";

        confirmPassword.value = "";

    }


    // --------------------------------------------------------
    // UPDATE PROFILE SIDEBAR / OTHER PROFILE ELEMENTS
    // --------------------------------------------------------

    function updateSidebarProfile() {

        const profile =
            JSON.parse(
                localStorage.getItem(
                    "user_profile"
                )
            );


        if (!profile) {
            return;
        }


        // If other profile elements exist,
        // update them automatically.

        const userNameElements =
            document.querySelectorAll(
                ".db-user-name, .user-name"
            );


        const fullName =
            `${profile.firstName} ${profile.lastName}`.trim();


        userNameElements.forEach(
            element => {

                element.textContent =
                    fullName;

            }
        );


        const emailElements =
            document.querySelectorAll(
                ".db-user-email, .user-email"
            );


        emailElements.forEach(
            element => {

                element.textContent =
                    profile.email;

            }
        );

    }


    // --------------------------------------------------------
    // LIVE PROFILE PREVIEW
    // --------------------------------------------------------

    const profileInputs =
        document.querySelectorAll(
            "#firstName, #lastName, #email, #position"
        );


    profileInputs.forEach(
        input => {

            input.addEventListener(
                "input",
                function () {

                    updateProfileSummary();

                }
            );

        }
    );


    // --------------------------------------------------------
    // CAMERA BUTTON
    // --------------------------------------------------------

    const cameraButton =
        document.querySelector(
            ".avatar-camera-btn"
        );


    if (cameraButton) {

        cameraButton.addEventListener(
            "click",
            function () {

                alert(
                    "Profile picture upload will be available when the account system is connected."
                );

            }
        );

    }


    // --------------------------------------------------------
    // INITIAL PROFILE UPDATE
    // --------------------------------------------------------

    updateProfileSummary();

    updateSidebarProfile();

});