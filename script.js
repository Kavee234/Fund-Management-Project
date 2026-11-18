const fundMode = new URLSearchParams(window.location.search).get("fund");
const hasSelectedFund = fundMode === "community" || fundMode === "activities";
const isActivitiesFund = fundMode === "activities";
const activitiesAccessStorageKey = "activitiesFundAccess";
const hasActivitiesFundAccess = !isActivitiesFund ||
    sessionStorage.getItem(activitiesAccessStorageKey) === "granted";
const shouldOpenFund = hasSelectedFund && hasActivitiesFundAccess;
let members = [];
const receiptBrandName = isActivitiesFund
    ? "External Activities Fund"
    : "බාහිර ක්‍රියාකාරකම් අපේ එකතුව";
const weeklyContribution = 100;
const storagePrefix = isActivitiesFund ? "activitiesFund" : "fund";
const storageKey = isActivitiesFund ? "activitiesFundData" : "fundData";
const monthlyStorageKey = `${storagePrefix}MonthlyData`;
const activeMonthStorageKey = `${storagePrefix}ActiveMonth`;
const receiptsStorageKey = `${storagePrefix}Receipts`;
const expensesStorageKey = `${storagePrefix}Expenses`;
const supabaseConfig = window.FUND_APP_CONFIG || {};
const sharedBackendConfigured = Boolean(supabaseConfig.url || supabaseConfig.anonKey);
let supabaseClient = null;
let sharedBackendReady = !sharedBackendConfigured;
let sharedBackendError = "";
let sharedRevision = 0;
let authenticatedRole = null;
let authenticatedAdmin = false;
let sharedRefreshTimer = null;
let localImportAvailable = false;
let localImportData = null;
if (sharedBackendConfigured) {
    try {
        if (!supabaseConfig.url || !supabaseConfig.anonKey) {
            throw new Error("Both the Supabase project URL and publishable key are required.");
        }
        if (!window.supabase || typeof window.supabase.createClient !== "function") {
            throw new Error("The Supabase client library did not load.");
        }
        const projectRef = new URL(supabaseConfig.url).hostname.split(".")[0];
        localStorage.removeItem(`sb-${projectRef}-auth-token`);
        supabaseClient = window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey, {
            auth: {
                storage: window.sessionStorage,
                autoRefreshToken: true,
                persistSession: true
            }
        });
    } catch (error) {
        sharedBackendError = error.message;
        console.error("Could not initialize the shared fund database.", error);
    }
}
const currentMonthKey = getMonthKey(new Date());
const savedActiveMonth = localStorage.getItem(activeMonthStorageKey);
let activeMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(savedActiveMonth || "") ? savedActiveMonth : currentMonthKey;
const summaryTable = document.getElementById("summaryTable");
const memberGrid = document.getElementById("membersGrid");
const searchInput = document.getElementById("memberSearch");
const statusFilter = document.getElementById("statusFilter");
const monthSelector = document.getElementById("monthSelector");
const transactionFilter = document.getElementById("transactionFilter");
const expenseMembers = document.getElementById("expenseMembers");
const storageStatus = document.querySelector(".table-note");
const activitiesPinModal = document.getElementById("activitiesPinModal");
const pinModal = document.getElementById("pinModal");
const collectionModal = document.getElementById("collectionModal");
const receiptModal = document.getElementById("receiptModal");
const activitiesPinDigest = "0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c";
let monthlyContributions = {};
let contributions = monthlyContributions[activeMonth] || createEmptyContributions();
monthlyContributions[activeMonth] = contributions;
let receipts = [];
let expenses = [];
let activeMemberIndex = null;
let activeReceipt = null;
let pendingEditAction = null;
let collectionMode = "weekly";

function updateEditLockButton() {
    const button = document.getElementById("editLockButton");
    const hasEditAccess = sharedBackendConfigured && authenticatedAdmin;
    document.body.classList.toggle("fund-read-only", !hasEditAccess);
    button.textContent = sharedBackendConfigured
        ? (authenticatedRole ? "Sign out" : "Sign in")
        : "Private storage unavailable";
    button.setAttribute("aria-pressed", String(hasEditAccess));
    button.classList.toggle("button-primary", hasEditAccess);
    button.classList.toggle("button-quiet", !hasEditAccess);
    const resetButton = document.getElementById("resetButton");
    resetButton.disabled = sharedBackendConfigured
        ? !authenticatedAdmin || !sharedBackendReady
        : true;
    resetButton.title = hasEditAccess
        ? "Reset this fund's saved records"
        : "Sign in as an admin to enable record resets";
    const resetAccessNote = document.getElementById("resetAccessNote");
    resetAccessNote.textContent = sharedBackendConfigured
        ? (authenticatedRole && !authenticatedAdmin
            ? "Your approved account is read-only."
            : "Sign in with an authorized admin account to reset records.")
        : "Private storage is not configured.";
    resetAccessNote.hidden = hasEditAccess;
    document.getElementById("importLocalButton").hidden =
        !sharedBackendConfigured || !sharedBackendReady || !authenticatedAdmin || !localImportAvailable;
}

function requestEditAccess(action) {
    if (!sharedBackendConfigured) {
        setSyncStatus("Private storage is not configured. Viewing and editing are disabled.", true);
        return false;
    }
    if (authenticatedAdmin) {
        if (action && localImportAvailable) {
            setSyncStatus("Import this browser’s existing records before making new changes.", true);
            return false;
        }
        return true;
    }
    if (action && authenticatedRole) {
        setSyncStatus("Only an authorized fund administrator can change records.", true);
        return false;
    }

    pendingEditAction = action || null;
    document.getElementById("pinMessage").textContent = "";
    document.getElementById("adminEmail").value = "";
    document.getElementById("adminPassword").value = "";
    document.getElementById("adminEmailField").hidden = false;
    document.getElementById("adminPasswordField").hidden = false;
    document.getElementById("adminEmail").required = true;
    document.getElementById("adminPassword").required = true;
    document.getElementById("editAccessIntro").textContent =
        "Sign in with an approved account to view this private fund. Only administrators can edit records.";
    document.getElementById("pinTitle").textContent = "Sign in to the private fund";
    document.getElementById("editAccessDisclaimer").textContent =
        "Your fund access is checked by the database.";
    document.getElementById("editAccessSubmit").textContent = "Sign in";
    pinModal.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("adminEmail").focus();
    return false;
}

function closePinModal() {
    pinModal.hidden = true;
    document.body.classList.remove("modal-open");
    pendingEditAction = null;
}

async function submitPin(event) {
    event.preventDefault();
    if (!sharedBackendConfigured || !supabaseClient) {
        setSyncStatus("Private storage is unavailable. No records were loaded or saved.", true);
        return;
    }

    try {
        const { error } = await supabaseClient.auth.signInWithPassword({
            email: document.getElementById("adminEmail").value.trim(),
            password: document.getElementById("adminPassword").value
        });
        if (error) {
            throw error;
        }
        let snapshot;
        try {
            snapshot = await fetchSharedLedger();
        } catch (accessError) {
            await supabaseClient.auth.signOut();
            throw accessError;
        }
        activateSharedAccess(snapshot);
        const action = pendingEditAction;
        pendingEditAction = null;
        closePinModal();
        if (action) {
            if (authenticatedAdmin) {
                action();
            } else {
                setSyncStatus("Your account can view this fund but cannot edit records.", true);
            }
        }
    } catch (error) {
        console.error("Could not sign in to the private fund.", error);
        document.getElementById("pinMessage").textContent =
            "Sign-in failed or this account is not approved for this fund.";
    }
}

function openActivitiesPin() {
    document.getElementById("activitiesPinMessage").textContent = "";
    document.getElementById("activitiesPin").value = "";
    activitiesPinModal.hidden = false;
    document.body.classList.add("modal-open");
    document.getElementById("activitiesPin").focus();
}

function closeActivitiesPin() {
    activitiesPinModal.hidden = true;
    document.body.classList.remove("modal-open");
}

async function submitActivitiesPin(event) {
    event.preventDefault();
    const input = document.getElementById("activitiesPin");
    const message = document.getElementById("activitiesPinMessage");
    try {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.value));
        const submittedDigest = Array.from(new Uint8Array(digest), byte =>
            byte.toString(16).padStart(2, "0")).join("");
        if (submittedDigest !== activitiesPinDigest) {
            message.textContent = "Incorrect PIN. Try again.";
            input.select();
            return;
        }

        sessionStorage.setItem(activitiesAccessStorageKey, "granted");
        const url = new URL(window.location.href);
        url.searchParams.set("fund", "activities");
        url.hash = "";
        window.location.assign(url.href);
    } catch (error) {
        console.error("Could not verify the activities fund PIN.", error);
        message.textContent = "Could not verify the PIN in this browser. Try a current browser over HTTPS.";
    }
}

function createEmptyContributions() {
    return members.map(() => [false, false, false, false]);
}

function normalizeContributions(data) {
    return members.map((member, index) => {
        const savedWeeks = Array.isArray(data[index]) ? data[index] : [];
        return Array.from({ length: 4 }, (_, week) => Boolean(savedWeeks[week]));
    });
}

function validateExpenses(expenseList) {
    return Array.isArray(expenseList) && expenseList.every(expense => {
        if (!expense || typeof expense.eventName !== "string" || !expense.eventName.trim() ||
            !/^\d{4}-(0[1-9]|1[0-2])$/.test(expense.month) ||
            !Number.isSafeInteger(expense.costCents) || expense.costCents <= 0 ||
            !Array.isArray(expense.shares) || expense.shares.length === 0 ||
            expense.shares.some(share =>
                !Number.isInteger(share.memberIndex) || share.memberIndex < 0 ||
                share.memberIndex >= members.length ||
                !Number.isSafeInteger(share.amountCents) || share.amountCents < 0) ||
            (expense.date && Number.isNaN(Date.parse(expense.date)))) {
            return false;
        }
        const memberIndexes = expense.shares.map(share => share.memberIndex);
        return new Set(memberIndexes).size === memberIndexes.length &&
            expense.shares.reduce((total, share) => total + share.amountCents, 0) === expense.costCents;
    });
}

function captureFundData() {
    return JSON.parse(JSON.stringify({ monthlyContributions, receipts, expenses }));
}

function applyFundData(data) {
    if (!data || !data.monthlyContributions || Array.isArray(data.monthlyContributions) ||
        typeof data.monthlyContributions !== "object" || !Array.isArray(data.receipts) ||
        !Array.isArray(data.expenses) || !validateExpenses(data.expenses)) {
        throw new TypeError("The shared fund record has an invalid format.");
    }

    const normalizedMonthlyData = {};
    Object.entries(data.monthlyContributions).forEach(([month, monthData]) => {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Array.isArray(monthData)) {
            throw new TypeError("The shared fund record contains invalid monthly contributions.");
        }
        normalizedMonthlyData[month] = normalizeContributions(monthData);
    });
    const validReceipts = data.receipts.every(receipt =>
        receipt && typeof receipt.id === "string" &&
        Number.isInteger(receipt.memberIndex) && receipt.memberIndex >= 0 &&
        receipt.memberIndex < members.length &&
        typeof receipt.memberName === "string" &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(receipt.month) &&
        typeof receipt.date === "string" && !Number.isNaN(Date.parse(receipt.date)) &&
        Number.isFinite(receipt.amount) && receipt.amount >= 0 &&
        (!receipt.weeks || (Array.isArray(receipt.weeks) &&
            receipt.weeks.every(week => Number.isInteger(week) && week >= 1 && week <= 4))));
    if (!validReceipts) {
        throw new TypeError("The shared fund record contains invalid receipts.");
    }

    monthlyContributions = normalizedMonthlyData;
    contributions = monthlyContributions[activeMonth] || createEmptyContributions();
    monthlyContributions[activeMonth] = contributions;
    receipts = data.receipts;
    expenses = data.expenses;
    renderFundData();
}

function renderFundData() {
    renderMembers();
    renderSummaryTable();
    updateSummary();
    renderBirthdays();
    renderRecentCollections();
    renderTransactions();
}

function renderMemberFilters() {
    transactionFilter.replaceChildren();
    const allMembersOption = document.createElement("option");
    allMembersOption.value = "all";
    allMembersOption.textContent = members.length === 1 ? "My records" : "All members";
    transactionFilter.appendChild(allMembersOption);
    members.forEach((member, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = member.name;
        transactionFilter.appendChild(option);
    });
}

function loadMonthlyData() {
    const storedMonthlyData = localStorage.getItem(monthlyStorageKey);
    if (storedMonthlyData) {
        try {
            const parsedData = JSON.parse(storedMonthlyData);
            if (!parsedData || Array.isArray(parsedData) || typeof parsedData !== "object") {
                throw new TypeError("Saved monthly contributions are not a month map.");
            }

            const normalizedData = {};
            Object.entries(parsedData).forEach(([month, monthData]) => {
                if (/^\d{4}-\d{2}$/.test(month) && Array.isArray(monthData)) {
                    normalizedData[month] = normalizeContributions(monthData);
                }
            });
            return normalizedData;
        } catch (error) {
            console.error("Could not read the saved monthly contributions.", error);
            storageStatus.textContent = "Monthly contributions could not be read. New changes will be saved here.";
            storageStatus.classList.add("storage-warning");
            return {};
        }
    }

    const legacyData = localStorage.getItem(storageKey);
    if (!legacyData) {
        return {};
    }

    try {
        const parsedData = JSON.parse(legacyData);
        if (Array.isArray(parsedData)) {
            return { [activeMonth]: normalizeContributions(parsedData) };
        }
        throw new TypeError("Legacy contribution data is not a list.");
    } catch (error) {
        console.error("Could not read the saved contribution data.", error);
        storageStatus.textContent = "Saved data could not be read. New changes will be saved here.";
        storageStatus.classList.add("storage-warning");
        return {};
    }
}

function loadReceipts() {
    const storedReceipts = localStorage.getItem(receiptsStorageKey);
    if (!storedReceipts) {
        return [];
    }

    try {
        const parsedReceipts = JSON.parse(storedReceipts);
        if (Array.isArray(parsedReceipts)) {
            return parsedReceipts;
        }
        throw new TypeError("Saved receipt history is not a list.");
    } catch (error) {
        console.error("Could not read the saved receipt history.", error);
        storageStatus.textContent = "Receipt history could not be read. New collections can still be recorded.";
        storageStatus.classList.add("storage-warning");
        return [];
    }
}

function loadExpenses() {
    const storedExpenses = localStorage.getItem(expensesStorageKey);
    if (!storedExpenses) {
        return [];
    }

    try {
        const parsedExpenses = JSON.parse(storedExpenses);
        if (validateExpenses(parsedExpenses)) {
            return parsedExpenses;
        }
        throw new TypeError("Saved expenses contain invalid records.");
    } catch (error) {
        console.error("Could not read the saved expenses.", error);
        storageStatus.textContent = "Saved expenses could not be read. New expenses can still be recorded.";
        storageStatus.classList.add("storage-warning");
        return [];
    }
}

function readLocalFundData() {
    return {
        monthlyContributions: loadMonthlyData(),
        receipts: loadReceipts(),
        expenses: loadExpenses()
    };
}

function setSyncStatus(message, isError = false) {
    const notice = document.getElementById("syncNotice");
    notice.hidden = false;
    notice.textContent = message;
    notice.classList.toggle("storage-warning", isError);
}

function clearLocalFundCache(fundId = storagePrefix) {
    const prefix = fundId === "activitiesFund" ? "activitiesFund" : "fund";
    localStorage.removeItem(`${prefix}MonthlyData`);
    localStorage.removeItem(prefix === "activitiesFund" ? "activitiesFundData" : "fundData");
    localStorage.removeItem(`${prefix}Receipts`);
    localStorage.removeItem(`${prefix}Expenses`);
}

function clearAllLocalFundCaches() {
    clearLocalFundCache("fund");
    clearLocalFundCache("activitiesFund");
}

async function saveSharedState() {
    if (!sharedBackendReady || !authenticatedAdmin || !supabaseClient) {
        throw new Error("Sign in as a fund administrator before saving shared records.");
    }

    setSyncStatus("Saving shared fund records…");
    const { data, error } = await supabaseClient
        .from("fund_ledgers")
        .update({
            data: { monthlyContributions, receipts, expenses },
            revision: sharedRevision + 1,
            updated_at: new Date().toISOString()
        })
        .eq("fund_id", storagePrefix)
        .eq("revision", sharedRevision)
        .select("revision")
        .maybeSingle();
    if (error) {
        throw error;
    }
    if (!data) {
        throw new Error("The shared ledger changed in another session. Reload the page before trying again.");
    }

    sharedRevision = data.revision;
    localImportAvailable = false;
    localImportData = null;
    clearLocalFundCache();
    storageStatus.textContent = "Changes are saved to the private shared fund.";
    setSyncStatus("Shared fund records saved.");
}

async function fetchSharedLedger() {
    const { data, error } = await supabaseClient.rpc("read_fund_ledger", {
        p_fund_id: storagePrefix
    });
    if (error) {
        throw error;
    }
    if (!data || !Array.isArray(data.members) || !data.data ||
        !Number.isSafeInteger(data.revision)) {
        throw new TypeError("The private fund response has an invalid format.");
    }
    return data;
}

function activateSharedAccess(snapshot) {
    const validRoles = isActivitiesFund
        ? ["admin", "activities_viewer"]
        : ["admin", "community_member"];
    if (!validRoles.includes(snapshot.role) ||
        snapshot.members.some(member => !member || typeof member.name !== "string")) {
        throw new TypeError("This account is not authorized to view this fund.");
    }

    members = snapshot.members.map(member => ({
        name: member.name,
        ...(typeof member.birthday === "string" ? { birthday: member.birthday } : {})
    }));
    applyFundData(snapshot.data);
    renderMemberFilters();
    renderExpenseMembers();
    sharedRevision = snapshot.revision;
    authenticatedRole = snapshot.role;
    authenticatedAdmin = snapshot.role === "admin";
    sharedBackendReady = true;
    sharedBackendError = "";
    document.getElementById("appShell").hidden = false;

    if (authenticatedAdmin && isEmptyFundData(snapshot.data)) {
        localImportData = readLocalFundData();
        localImportAvailable = !isEmptyFundData(localImportData);
    } else {
        localImportData = null;
        localImportAvailable = false;
        if (authenticatedAdmin) {
            clearLocalFundCache();
        } else {
            clearAllLocalFundCaches();
        }
    }

    document.querySelector(".masthead-status").textContent =
        authenticatedAdmin ? "Admin connected" : "Private fund";
    document.querySelector(".local-badge").textContent = "Private shared records";
    storageStatus.textContent = "Records are loaded for your approved account.";
    document.getElementById("heroMemberCount").textContent = String(members.length);
    document.getElementById("summaryRowCount").textContent = `${members.length} members`;
    document.getElementById("summaryNoteMembersCount").textContent = String(members.length);
    updateEditLockButton();
    setSyncStatus(authenticatedAdmin
        ? "Administrator access is active."
        : (isActivitiesFund
            ? "Activities Fund access is limited to its approved group."
            : "Only your community records and receipts are shown."));
}

async function loadSharedLedger() {
    const snapshot = await fetchSharedLedger();
    activateSharedAccess(snapshot);
    return snapshot;
}

function clearSharedView(clearLocalCache = true) {
    if (sharedRefreshTimer) {
        window.clearInterval(sharedRefreshTimer);
        sharedRefreshTimer = null;
    }
    authenticatedRole = null;
    authenticatedAdmin = false;
    sharedBackendReady = false;
    sharedRevision = 0;
    localImportAvailable = false;
    localImportData = null;
    members = [];
    monthlyContributions = {};
    contributions = createEmptyContributions();
    receipts = [];
    expenses = [];
    if (clearLocalCache) {
        clearAllLocalFundCaches();
    }
    document.getElementById("appShell").hidden = true;
    renderMemberFilters();
    renderExpenseMembers();
    renderFundData();
    updateEditLockButton();
}

function isEmptyFundData(data) {
    const hasContributions = Object.values(data.monthlyContributions)
        .some(monthData => monthData.some(memberWeeks => memberWeeks.some(Boolean)));
    return !hasContributions && data.receipts.length === 0 && data.expenses.length === 0;
}

function subscribeToSharedLedger() {
    if (sharedRefreshTimer) {
        window.clearInterval(sharedRefreshTimer);
    }
    sharedRefreshTimer = window.setInterval(async () => {
        try {
            const snapshot = await fetchSharedLedger();
            if (snapshot.revision > sharedRevision) {
                activateSharedAccess(snapshot);
                setSyncStatus("Your approved fund view was refreshed.");
            }
        } catch (error) {
            console.error("Could not refresh the private fund.", error);
            clearSharedView(false);
            document.querySelector(".masthead-status").textContent = "Sign in required";
            document.querySelector(".local-badge").textContent = "No records displayed";
            setSyncStatus("The private fund could not be refreshed. Reload and sign in again.", true);
            requestEditAccess();
        }
    }, 30000);
}

async function initializeSharedBackend() {
    if (!hasSelectedFund) {
        return;
    }

    const mastheadStatus = document.querySelector(".masthead-status");
    const localBadge = document.querySelector(".local-badge");
    if (!sharedBackendConfigured) {
        mastheadStatus.textContent = "Private storage unavailable";
        localBadge.textContent = "No records displayed";
        setSyncStatus("Private storage is not configured. Viewing and editing are disabled.", true);
        return;
    }

    mastheadStatus.textContent = "Connecting to shared fund";
    localBadge.textContent = "Checking private access";
    setSyncStatus("Checking your access…");
    try {
        if (!supabaseClient) {
            throw new Error(sharedBackendError || "The shared database client is unavailable.");
        }
        const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
        if (sessionError) {
            throw sessionError;
        }
        if (!sessionData.session) {
            sharedBackendReady = false;
            authenticatedRole = null;
            authenticatedAdmin = false;
            mastheadStatus.textContent = "Sign in required";
            localBadge.textContent = "Private fund";
            setSyncStatus("Sign in with an approved account to view this private fund.");
            updateEditLockButton();
            requestEditAccess();
            return;
        }

        await loadSharedLedger();
        subscribeToSharedLedger();
    } catch (error) {
        sharedBackendError = error.message || "The shared database could not be reached.";
        clearSharedView(false);
        mastheadStatus.textContent = "Private access unavailable";
        localBadge.textContent = "No records displayed";
        storageStatus.textContent = "No private records are displayed until access is verified.";
        console.error("Could not load the shared fund.", error);
        setSyncStatus("Could not verify access. Confirm your account is approved, then try again.", true);
        updateEditLockButton();
        requestEditAccess();
    }
}

async function importLocalRecords() {
    if (!authenticatedAdmin || !localImportAvailable || !localImportData) {
        return;
    }
    if (!window.confirm("Import this browser’s records into the shared fund? This only works while the shared fund is empty.")) {
        return;
    }

    const previousData = captureFundData();
    try {
        applyFundData(localImportData);
        await saveSharedState();
        localImportAvailable = false;
        localImportData = null;
        clearLocalFundCache();
        updateEditLockButton();
        setSyncStatus("This browser’s records were imported into the shared fund.");
    } catch (error) {
        console.error("Could not import this browser’s records.", error);
        applyFundData(previousData);
        setSyncStatus(`Could not import local records: ${error.message}`, true);
    }
}

async function saveData() {
    if (!sharedBackendConfigured) {
        setSyncStatus("Private storage is not configured. Changes were not saved.", true);
        return false;
    }
    const previousMonthData = monthlyContributions[activeMonth];
    monthlyContributions[activeMonth] = contributions;
    try {
        await saveSharedState();
        return true;
    } catch (error) {
        if (previousMonthData === undefined) {
            delete monthlyContributions[activeMonth];
        } else {
            monthlyContributions[activeMonth] = previousMonthData;
        }
        console.error("Could not save shared fund contributions.", error);
        setSyncStatus(`Could not save shared contributions: ${error.message}`, true);
        return false;
    }
}

async function saveReceipts() {
    if (!sharedBackendConfigured) {
        setSyncStatus("Private storage is not configured. Changes were not saved.", true);
        return false;
    }

    try {
        await saveSharedState();
        return true;
    } catch (error) {
        console.error("Could not save shared receipt history.", error);
        setSyncStatus(`Could not save the receipt to the private fund: ${error.message}`, true);
        return false;
    }
}

async function saveExpenses(nextExpenses) {
    if (!sharedBackendConfigured) {
        setSyncStatus("Private storage is not configured. Changes were not saved.", true);
        return false;
    }

    const previousExpenses = expenses;
    expenses = nextExpenses;
    try {
        await saveSharedState();
        return true;
    } catch (error) {
        expenses = previousExpenses;
        console.error("Could not save shared expenses.", error);
        document.getElementById("expenseMessage").textContent =
            `Could not save this expense to the private fund: ${error.message}`;
        setSyncStatus("The expense was not saved to the private fund.", true);
        return false;
    }
}

function createMemberRow(member, index) {
    const row = document.createElement("tr");
    const weeksPaid = contributions[index] || [false, false, false, false];
    const paidCount = weeksPaid.filter(Boolean).length;
    const paidAmount = paidCount * weeklyContribution;
    const expenseShareCents = getMemberExpenseCents(index, activeMonth);
    const additionalCollectionCents = getMemberAdditionalCollectionCents(index, activeMonth);
    const savings = getMemberSavingsCents(index, activeMonth) / 100;
    row.dataset.memberIndex = String(index);

    const memberCell = document.createElement("td");
    memberCell.className = "member-name";
    const memberButton = document.createElement("button");
    memberButton.type = "button";
    memberButton.className = "member-select-button";
    memberButton.setAttribute("aria-label", `Add collection for ${member.name}`);
    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = member.name.slice(0, 1).toUpperCase();
    memberButton.append(avatar, document.createTextNode(member.name));
    memberCell.appendChild(memberButton);
    row.appendChild(memberCell);

    if (member.birthday) {
        const birthdayCell = document.createElement("td");
        birthdayCell.className = "birthday-cell";
        birthdayCell.textContent = formatBirthday(member.birthday);
        row.appendChild(birthdayCell);
    }

    weeksPaid.forEach((isPaid, week) => {
        const cell = document.createElement("td");
        cell.className = "week-cell";
        const mark = document.createElement("span");
        mark.className = `week-mark${isPaid ? " week-mark-paid" : ""}`;
        mark.setAttribute("aria-label", `Week ${week + 1}: ${isPaid ? "paid" : "not paid"}`);
        mark.textContent = isPaid ? "✓" : "·";
        cell.appendChild(mark);
        row.appendChild(cell);
    });

    const outstandingCell = document.createElement("td");
    outstandingCell.className = "money-cell outstanding-cell";
    outstandingCell.textContent = formatCurrency((4 - paidCount) * weeklyContribution);
    row.appendChild(outstandingCell);

    const paidCell = document.createElement("td");
    paidCell.className = "money-cell paid-cell";
    paidCell.textContent = formatCurrency(paidAmount);
    row.appendChild(paidCell);

    const additionalCollectionCell = document.createElement("td");
    additionalCollectionCell.className = "money-cell paid-cell";
    additionalCollectionCell.textContent = formatCurrency(additionalCollectionCents / 100);
    row.appendChild(additionalCollectionCell);

    const expenseCell = document.createElement("td");
    expenseCell.className = "money-cell expense-share-cell";
    expenseCell.textContent = formatCurrency(expenseShareCents / 100);
    row.appendChild(expenseCell);

    const savingsCell = document.createElement("td");
    savingsCell.className = `money-cell savings-cell${savings < 0 ? " savings-negative" : ""}`;
    savingsCell.textContent = formatCurrency(savings);
    row.appendChild(savingsCell);

    const actionCell = document.createElement("td");
    actionCell.className = "action-cell";
    const collectButton = document.createElement("button");
    collectButton.type = "button";
    collectButton.className = "collect-button";
    collectButton.textContent = "Add collection";
    collectButton.setAttribute("aria-label", `Add collection for ${member.name}`);
    const additionalCollectionButton = document.createElement("button");
    additionalCollectionButton.type = "button";
    additionalCollectionButton.className = "history-button additional-collection-button";
    additionalCollectionButton.textContent = "Extra";
    additionalCollectionButton.setAttribute("aria-label", `Add additional collection for ${member.name}`);
    const historyButton = document.createElement("button");
    historyButton.type = "button";
    historyButton.className = "history-button";
    historyButton.textContent = "Receipts";
    historyButton.setAttribute("aria-label", `View and print receipts for ${member.name}`);
    actionCell.append(collectButton, additionalCollectionButton, historyButton);
    row.appendChild(actionCell);
    return row;
}

function renderMembers() {
    const query = searchInput.value.trim().toLowerCase();
    const filter = statusFilter.value;
    const matchingMembers = members
        .map((member, index) => ({ member, index }))
        .filter(({ member, index }) => {
            const weeks = contributions[index] || [];
            const paidCount = weeks.filter(Boolean).length;
            const matchesSearch = member.name.toLowerCase().includes(query);
            const matchesStatus = filter === "all" ||
                (filter === "complete" && paidCount === 4) ||
                (filter === "outstanding" && paidCount < 4);
            return matchesSearch && matchesStatus;
        });

    memberGrid.replaceChildren();
    matchingMembers.forEach(({ member, index }) => memberGrid.appendChild(createMemberCard(member, index)));
    document.getElementById("visibleMemberCount").textContent =
        `${matchingMembers.length} ${matchingMembers.length === 1 ? "member" : "members"}`;

    if (matchingMembers.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No members match your search.";
        memberGrid.appendChild(empty);
    }
}

function createMemberCard(member, index) {
    const weeksPaid = contributions[index] || [false, false, false, false];
    const paidCount = weeksPaid.filter(Boolean).length;
    const expenseShareCents = getMemberExpenseCents(index, activeMonth);
    const savings = getMemberSavingsCents(index, activeMonth) / 100;
    const card = document.createElement("article");
    card.className = "member-card";

    const top = document.createElement("div");
    top.className = "member-card-top";
    const memberButton = document.createElement("button");
    memberButton.type = "button";
    memberButton.className = "member-card-main";
    memberButton.setAttribute("aria-label", `Open collection for ${member.name}`);
    const avatar = document.createElement("span");
    avatar.className = "member-card-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = member.name.slice(0, 1).toUpperCase();
    const identity = document.createElement("span");
    identity.className = "member-card-identity";
    const name = document.createElement("strong");
    name.textContent = member.name;
    identity.appendChild(name);
    if (member.birthday) {
        const birthday = document.createElement("span");
        birthday.textContent = `Birthday · ${formatBirthday(member.birthday)}`;
        identity.appendChild(birthday);
    }
    memberButton.append(avatar, identity);
    const status = document.createElement("span");
    status.className = `member-status${paidCount === 4 ? " member-status-paid" : ""}`;
    status.textContent = paidCount === 4 ? "Complete" : `${4 - paidCount} due`;
    top.append(memberButton, status);
    card.appendChild(top);

    const weekList = document.createElement("div");
    weekList.className = "member-card-weeks";
    weeksPaid.forEach((isPaid, week) => {
        const mark = document.createElement("span");
        mark.className = `member-week${isPaid ? " member-week-paid" : ""}`;
        mark.textContent = `Week ${week + 1} ${isPaid ? "✓" : "·"}`;
        weekList.appendChild(mark);
    });
    card.appendChild(weekList);

    const finances = document.createElement("div");
    finances.className = "member-card-financials";
    [
        ["Savings", savings, savings < 0 ? "member-saving-negative" : ""],
        ["Expenses", expenseShareCents / 100, ""],
        ["Outstanding", (4 - paidCount) * weeklyContribution, ""]
    ].forEach(([label, amount, className]) => {
        const detail = document.createElement("span");
        detail.className = "member-card-financial";
        const value = document.createElement("strong");
        value.className = className;
        value.textContent = `Rs. ${formatCurrency(amount)}`;
        detail.append(document.createTextNode(label), value);
        finances.appendChild(detail);
    });
    card.appendChild(finances);

    const footer = document.createElement("div");
    footer.className = "member-card-footer";
    const collectButton = document.createElement("button");
    collectButton.type = "button";
    collectButton.className = "collect-button";
    collectButton.textContent = "Add collection";
    collectButton.setAttribute("aria-label", `Add collection for ${member.name}`);
    const additionalCollectionButton = document.createElement("button");
    additionalCollectionButton.type = "button";
    additionalCollectionButton.className = "history-button additional-collection-button";
    additionalCollectionButton.textContent = "Extra collection";
    additionalCollectionButton.setAttribute("aria-label", `Add additional collection for ${member.name}`);
    const historyButton = document.createElement("button");
    historyButton.type = "button";
    historyButton.className = "history-button";
    historyButton.textContent = "My receipts";
    historyButton.setAttribute("aria-label", `View and print receipts for ${member.name}`);
    const collectionActions = document.createElement("div");
    collectionActions.className = "member-card-collection-actions";
    collectionActions.append(collectButton, additionalCollectionButton);
    footer.append(collectionActions, historyButton);
    card.appendChild(footer);
    card.dataset.memberIndex = String(index);
    return card;
}

function getMemberExpenseCents(memberIndex, month) {
    return expenses.reduce((total, expense) => {
        if (expense.month !== month || !Array.isArray(expense.shares)) {
            return total;
        }
        const memberShare = expense.shares.find(share => share.memberIndex === memberIndex);
        return total + (memberShare ? memberShare.amountCents : 0);
    }, 0);
}

function getMemberExpenseCentsThrough(memberIndex, month) {
    return expenses.reduce((total, expense) => {
        if (expense.month > month || !Array.isArray(expense.shares)) {
            return total;
        }
        const memberShare = expense.shares.find(share => share.memberIndex === memberIndex);
        return total + (memberShare ? memberShare.amountCents : 0);
    }, 0);
}

function getMemberContributionCentsThrough(memberIndex, month) {
    const weeklyContributionCents = Object.entries(monthlyContributions).reduce((total, [savedMonth, monthData]) => {
        if (savedMonth > month || !monthData[memberIndex]) {
            return total;
        }
        return total + monthData[memberIndex].filter(Boolean).length * weeklyContribution * 100;
    }, 0);
    return weeklyContributionCents + getMemberAdditionalCollectionCentsThrough(memberIndex, month);
}

function getMemberAdditionalCollectionCents(memberIndex, month) {
    return getMemberAdditionalCollectionCentsThrough(memberIndex, month, month);
}

function getMemberAdditionalCollectionCentsThrough(memberIndex, month, exactMonth) {
    return receipts.reduce((total, receipt) => {
        if (!receipt || receipt.type !== "additional") {
            return total;
        }

        const receiptMonth = receipt.month ||
            (receipt.date && !Number.isNaN(Date.parse(receipt.date))
                ? getMonthKey(new Date(receipt.date))
                : "");
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(receiptMonth)) {
            return total;
        }
        const receiptMemberIndex = Number.isInteger(receipt.memberIndex)
            ? receipt.memberIndex
            : members.findIndex(member => member.name === receipt.memberName);
        const matchesMonth = exactMonth === undefined
            ? receiptMonth <= month
            : receiptMonth === exactMonth;
        if (!matchesMonth || receiptMemberIndex !== memberIndex) {
            return total;
        }

        const amountCents = Number.isSafeInteger(receipt.amountCents)
            ? receipt.amountCents
            : Math.round(Number(receipt.amount) * 100);
        return Number.isSafeInteger(amountCents) && amountCents > 0
            ? total + amountCents
            : total;
    }, 0);
}

function getMemberSavingsCents(memberIndex, month) {
    return getMemberContributionCentsThrough(memberIndex, month) -
        getMemberExpenseCentsThrough(memberIndex, month);
}

function getMonthExpenseCents(month) {
    return expenses.reduce((total, expense) =>
        expense.month === month ? total + expense.costCents : total, 0);
}

function getCumulativeCollectedCents(month) {
    return members.reduce((total, member, index) =>
        total + getMemberContributionCentsThrough(index, month), 0);
}

function getCumulativeExpenseCents(month) {
    return expenses.reduce((total, expense) =>
        expense.month <= month ? total + expense.costCents : total, 0);
}

function renderSummaryTable() {
    summaryTable.replaceChildren();
    members.forEach((member, index) => {
        summaryTable.appendChild(createMemberRow(member, index));
    });
    document.getElementById("summaryRowCount").textContent = `${members.length} members`;
}

function formatCurrency(amount) {
    return amount.toLocaleString("en-LK", { maximumFractionDigits: 2 });
}

function getMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthName(monthKey) {
    const [year, month] = monthKey.split("-").map(Number);
    return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" })
        .format(new Date(year, month - 1, 1));
}

function formatBirthday(birthday) {
    const [month, day] = birthday.split("/").map(Number);
    return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" })
        .format(new Date(2000, month - 1, day));
}

function updateSummary() {
    const weeklyTotals = [0, 0, 0, 0];
    let paymentsCount = 0;

    contributions.forEach(weeks => {
        weeks.forEach((isPaid, week) => {
            if (isPaid) {
                weeklyTotals[week] += weeklyContribution;
                paymentsCount += 1;
            }
        });
    });

    const weeklyCollected = weeklyTotals.reduce((total, amount) => total + amount, 0);
    const additionalCollectedCents = members.reduce((total, member, index) =>
        total + getMemberAdditionalCollectionCents(index, activeMonth), 0);
    const totalCollected = weeklyCollected + additionalCollectedCents / 100;
    const totalExpenses = getMonthExpenseCents(activeMonth) / 100;
    const fundBalance = (getCumulativeCollectedCents(activeMonth) -
        getCumulativeExpenseCents(activeMonth)) / 100;
    const totalPossible = members.length * 4 * weeklyContribution;
    const totalDebt = totalPossible - weeklyCollected;
    const percent = totalPossible === 0 ? 0 : Math.round((weeklyCollected / totalPossible) * 100);

    document.getElementById("membersCount").textContent = String(members.length);
    document.getElementById("totalCollected").textContent = formatCurrency(totalCollected);
    document.getElementById("totalDebt").textContent = formatCurrency(totalDebt);
    document.getElementById("paymentsCount").textContent = String(paymentsCount);
    document.getElementById("collectionPercent").textContent = String(percent);
    document.getElementById("summaryMembersCount").textContent = String(members.length);
    document.getElementById("summaryCollected").textContent = formatCurrency(totalCollected);
    document.getElementById("summaryExpenses").textContent = formatCurrency(totalExpenses);
    document.getElementById("summaryBalance").textContent = formatCurrency(fundBalance);
    document.getElementById("summaryOutstanding").textContent = formatCurrency(totalDebt);
    document.getElementById("summaryPercent").textContent = String(percent);
    document.getElementById("summaryMonth").textContent = formatMonthName(activeMonth);
    document.getElementById("transactionsCollected").textContent = formatCurrency(totalCollected);
    document.getElementById("transactionsExpenses").textContent = formatCurrency(totalExpenses);
    document.getElementById("transactionsBalance").textContent = formatCurrency(fundBalance);

    const progressBar = document.getElementById("progressBar");
    progressBar.setAttribute("aria-valuenow", String(percent));
    progressBar.querySelector("span").style.width = `${percent}%`;
    renderWeeklyChart(weeklyTotals);
}

function renderExpenseMembers() {
    expenseMembers.replaceChildren();
    members.forEach((member, index) => {
        const label = document.createElement("label");
        label.className = "expense-member-option";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "expense-member-checkbox";
        checkbox.value = String(index);
        const name = document.createElement("span");
        name.textContent = member.name;
        label.append(checkbox, name);
        expenseMembers.appendChild(label);
    });
    updateExpensePreview();
}

function getSelectedExpenseMembers() {
    return Array.from(expenseMembers.querySelectorAll(".expense-member-checkbox:checked"))
        .map(input => Number(input.value));
}

function getExpenseCostCents() {
    const cost = Number(document.getElementById("expenseCost").value);
    if (!Number.isFinite(cost) || cost <= 0) {
        return 0;
    }
    return Math.round(cost * 100);
}

function splitExpense(costCents, participantIndexes) {
    const baseShare = Math.floor(costCents / participantIndexes.length);
    const extraCents = costCents % participantIndexes.length;
    return participantIndexes.map((memberIndex, index) => ({
        memberIndex,
        amountCents: baseShare + (index < extraCents ? 1 : 0)
    }));
}

function updateExpensePreview() {
    const participantIndexes = getSelectedExpenseMembers();
    const costCents = getExpenseCostCents();
    document.getElementById("expenseCostPreview").textContent =
        `Rs. ${formatCurrency(costCents / 100)}`;

    const preview = document.getElementById("expenseSharePreview");
    if (participantIndexes.length === 0) {
        preview.textContent = "Select members to preview their share.";
        return;
    }
    if (costCents <= 0) {
        preview.textContent = "Enter an expense amount to calculate each share.";
        return;
    }

    const shares = splitExpense(costCents, participantIndexes);
    const amounts = shares.map(share => share.amountCents);
    const lowestShare = Math.min(...amounts) / 100;
    const highestShare = Math.max(...amounts) / 100;
    const shareText = lowestShare === highestShare
        ? `Rs. ${formatCurrency(lowestShare)} each`
        : `Rs. ${formatCurrency(lowestShare)}–${formatCurrency(highestShare)} each`;
    preview.textContent =
        `${participantIndexes.length} members share the cost · ${shareText}. Shares add up exactly to the total.`;
}

function renderTransactions() {
    const table = document.getElementById("transactionsTable");
    table.replaceChildren();
    const memberFilter = transactionFilter.value;
    const transactions = [];
    const recordedWeeks = new Set();

    receipts.forEach(receipt => {
        const receiptMonth = receipt.month ||
            (receipt.date ? getMonthKey(new Date(receipt.date)) : activeMonth);
        if (receiptMonth !== activeMonth) {
            return;
        }

        const memberIndex = Number.isInteger(receipt.memberIndex)
            ? receipt.memberIndex
            : members.findIndex(member => member.name === receipt.memberName);
        if (!members[memberIndex]) {
            return;
        }

        const weeks = Array.isArray(receipt.weeks) ? receipt.weeks : [];
        weeks.forEach(week => recordedWeeks.add(`${memberIndex}:${week}`));
        const amountCents = Math.round(Number(receipt.amount) * 100);
        if (!Number.isFinite(amountCents)) {
            return;
        }
        const receiptDate = receipt.date && !Number.isNaN(Date.parse(receipt.date))
            ? receipt.date
            : `${receiptMonth}-01T00:00:00.000Z`;
        const collectionDetails = receipt.type === "additional"
            ? `Additional collection${receipt.description ? ` · ${receipt.description}` : ""} · ${receipt.method || "Payment"}`
            : `${weeks.map(week => `Week ${week}`).join(", ")} · ${receipt.method || "Payment"}`;
        transactions.push({
            date: receiptDate,
            memberIndex,
            type: "Collection",
            details: collectionDetails,
            amountCents,
            receipt
        });
    });

    contributions.forEach((weeksPaid, memberIndex) => {
        weeksPaid.forEach((isPaid, weekIndex) => {
            const weekNumber = weekIndex + 1;
            if (isPaid && !recordedWeeks.has(`${memberIndex}:${weekNumber}`)) {
                transactions.push({
                    date: `${activeMonth}-01T00:00:00.000Z`,
                    memberIndex,
                    type: "Collection",
                    details: `Week ${weekNumber} · Previously recorded`,
                    amountCents: weeklyContribution * 100
                });
            }
        });
    });

    expenses.forEach(expense => {
        if (expense.month !== activeMonth) {
            return;
        }
        expense.shares.forEach(share => {
            transactions.push({
                date: expense.date || `${expense.month}-01T00:00:00.000Z`,
                memberIndex: share.memberIndex,
                type: "Expense",
                details: `${expense.eventName} · Rs. ${formatCurrency(expense.costCents / 100)} total`,
                amountCents: -share.amountCents
            });
        });
    });

    const visibleTransactions = transactions
        .filter(transaction => memberFilter === "all" || transaction.memberIndex === Number(memberFilter))
        .sort((first, second) => new Date(second.date) - new Date(first.date));

    if (visibleTransactions.length === 0) {
        const emptyRow = document.createElement("tr");
        const emptyCell = document.createElement("td");
        emptyCell.colSpan = 6;
        emptyCell.className = "empty-transaction-cell";
        emptyCell.textContent = "No transactions recorded for this month and selection.";
        emptyRow.appendChild(emptyCell);
        table.appendChild(emptyRow);
        return;
    }

    visibleTransactions.forEach(transaction => {
        const row = document.createElement("tr");
        const dateCell = document.createElement("td");
        dateCell.textContent = new Intl.DateTimeFormat("en-LK", { dateStyle: "medium" })
            .format(new Date(transaction.date));
        const memberCell = document.createElement("td");
        memberCell.textContent = members[transaction.memberIndex].name;
        const typeCell = document.createElement("td");
        typeCell.className = transaction.type === "Expense" ? "transaction-expense" : "transaction-collection";
        typeCell.textContent = transaction.type;
        const detailsCell = document.createElement("td");
        detailsCell.textContent = transaction.details;
        const amountCell = document.createElement("td");
        amountCell.className = `money-cell transaction-amount${transaction.amountCents < 0 ? " transaction-expense" : ""}`;
        const sign = transaction.amountCents < 0 ? "−" : "+";
        amountCell.textContent = `${sign}Rs. ${formatCurrency(Math.abs(transaction.amountCents) / 100)}`;
        const receiptCell = document.createElement("td");
        if (transaction.receipt) {
            const receiptButton = document.createElement("button");
            receiptButton.type = "button";
            receiptButton.className = "text-button transaction-receipt-button";
            receiptButton.textContent = "View / print";
            receiptButton.setAttribute("aria-label", `View or print ${members[transaction.memberIndex].name}'s receipt`);
            receiptButton.addEventListener("click", () => showReceipt(transaction.receipt));
            receiptCell.appendChild(receiptButton);
        } else {
            receiptCell.textContent = "—";
        }
        row.append(dateCell, memberCell, typeCell, detailsCell, amountCell, receiptCell);
        table.appendChild(row);
    });
}

function openMemberTransactions(memberIndex) {
    if (!members[memberIndex]) {
        return;
    }
    transactionFilter.value = String(memberIndex);
    renderTransactions();
    showView("transactions");
}

function renderWeeklyChart(weeklyTotals) {
    const chart = document.getElementById("weeklyChart");
    const maxTotal = Math.max(...weeklyTotals, 1);
    chart.replaceChildren();

    weeklyTotals.forEach((amount, index) => {
        const column = document.createElement("div");
        column.className = "chart-column";
        const amountLabel = document.createElement("span");
        amountLabel.className = "chart-amount";
        amountLabel.textContent = formatCurrency(amount);
        const track = document.createElement("div");
        track.className = "chart-bar-track";
        const bar = document.createElement("span");
        bar.className = "chart-bar";
        bar.style.height = `${amount === 0 ? 0 : Math.max(8, (amount / maxTotal) * 100)}%`;
        track.appendChild(bar);
        const weekLabel = document.createElement("span");
        weekLabel.className = "chart-week";
        weekLabel.textContent = `Week ${index + 1}`;
        column.append(amountLabel, track, weekLabel);
        chart.appendChild(column);
    });
}

function getDaysUntilBirthday(birthday, today) {
    const [month, day] = birthday.split("/").map(Number);
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    let birthdayUtc = Date.UTC(today.getFullYear(), month - 1, day);

    if (birthdayUtc < todayUtc) {
        birthdayUtc = Date.UTC(today.getFullYear() + 1, month - 1, day);
    }

    return Math.round((birthdayUtc - todayUtc) / 86400000);
}

function renderBirthdays() {
    const list = document.getElementById("birthdayList");
    list.replaceChildren();
    if (isActivitiesFund) {
        return;
    }

    const today = new Date();
    const upcoming = members
        .map(member => ({ ...member, days: getDaysUntilBirthday(member.birthday, today) }))
        .sort((first, second) => first.days - second.days)
        .slice(0, 2);

    upcoming.forEach((member, index) => {
        const item = document.createElement("div");
        item.className = "birthday-item";
        const avatar = document.createElement("span");
        avatar.className = "birthday-avatar";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = member.name.slice(0, 1).toUpperCase();
        const details = document.createElement("span");
        details.className = "birthday-details";
        const name = document.createElement("strong");
        name.textContent = member.name;
        const date = document.createElement("span");
        date.textContent = member.days === 0 ? "Celebrating today!" :
            member.days === 1 ? "Birthday tomorrow" :
                `Birthday in ${member.days} days`;
        details.append(name, date);
        const dateBadge = document.createElement("span");
        dateBadge.className = "birthday-date";
        dateBadge.textContent = formatBirthday(member.birthday);
        item.append(avatar, details, dateBadge);
        list.appendChild(item);

        if (index < upcoming.length - 1) {
            const divider = document.createElement("div");
            divider.className = "birthday-divider";
            list.appendChild(divider);
        }
    });
}

function showView(viewName) {
    ["overview", "members", "summary", "transactions"].forEach(name => {
        document.getElementById(`${name}View`).hidden = name !== viewName;
    });

    document.querySelectorAll(".nav-link").forEach(button => {
        const isActive = button.dataset.view === viewName;
        button.classList.toggle("active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

async function selectMonth(monthKey) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
        monthSelector.value = activeMonth;
        return;
    }

    activeMonth = monthKey;
    contributions = monthlyContributions[activeMonth] || createEmptyContributions();
    monthlyContributions[activeMonth] = contributions;
    monthSelector.value = activeMonth;
    document.getElementById("currentMonth").textContent = formatMonthName(activeMonth);
    document.getElementById("expenseMonth").textContent = formatMonthName(activeMonth);
    document.getElementById("resetMessage").textContent = "";
    try {
        localStorage.setItem(activeMonthStorageKey, activeMonth);
    } catch (error) {
        console.error("Could not save the selected collection month.", error);
        document.getElementById("resetMessage").textContent =
            "The selected month could not be remembered after closing this page.";
    }

    renderMembers();
    renderSummaryTable();
    updateSummary();
    renderTransactions();
}

function exportCsv() {
    const headings = [
        "Month", "Name", ...(isActivitiesFund ? [] : ["Birthday"]), "Week 1 paid", "Week 2 paid", "Week 3 paid",
        "Week 4 paid", "Outstanding (Rs.)", "Total paid (Rs.)", "Extra collections (Rs.)",
        "Expense share (Rs.)", "Savings (Rs.)"
    ];
    const rows = members.map((member, index) => {
        const weeks = contributions[index] || [false, false, false, false];
        const paidCount = weeks.filter(Boolean).length;
        const paidAmount = paidCount * weeklyContribution;
        const additionalCollectionCents = getMemberAdditionalCollectionCents(index, activeMonth);
        const expenseShareCents = getMemberExpenseCents(index, activeMonth);
        const savingsCents = getMemberSavingsCents(index, activeMonth);
        return [
            formatMonthName(activeMonth),
            member.name,
            ...(isActivitiesFund ? [] : [member.birthday]),
            ...weeks.map(isPaid => isPaid ? "Yes" : "No"),
            String((4 - paidCount) * weeklyContribution),
            String(paidAmount),
            String(additionalCollectionCents / 100),
            String(expenseShareCents / 100),
            String(savingsCents / 100)
        ];
    });
    const csv = [headings, ...rows]
        .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(","))
        .join("\r\n");
    const file = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = isActivitiesFund ? "external-activities-fund.csv" : "baahira-community-fund.csv";
    link.click();
    URL.revokeObjectURL(url);
}

async function resetRecords() {
    if (!requestEditAccess(resetRecords)) {
        return;
    }

    const confirmed = window.confirm(
        "Reset all member contributions, expenses, and receipt history? This cannot be undone."
    );
    if (!confirmed) {
        return;
    }

    const previousState = captureFundData();
    monthlyContributions = {};
    contributions = createEmptyContributions();
    monthlyContributions[activeMonth] = contributions;
    receipts = [];
    expenses = [];
    try {
        await saveSharedState();
    } catch (error) {
        console.error("Could not reset the shared records.", error);
        applyFundData(previousState);
        document.getElementById("resetMessage").textContent =
            `Reset failed. Shared records were kept: ${error.message}`;
        return;
    }

    renderFundData();
    document.getElementById("resetMessage").textContent =
        "All monthly contributions, expenses, and saved receipts have been reset.";
}

async function saveExpense(event) {
    event.preventDefault();
    if (!requestEditAccess(saveExpenseAfterUnlock)) {
        return;
    }
    await saveExpenseAfterUnlock();
}

async function saveExpenseAfterUnlock() {
    const form = document.getElementById("expenseForm");
    const eventName = document.getElementById("expenseEventName").value.trim();
    const costCents = getExpenseCostCents();
    const participantIndexes = getSelectedExpenseMembers();
    const message = document.getElementById("expenseMessage");
    message.textContent = "";

    if (!eventName || costCents <= 0 || !Number.isSafeInteger(costCents)) {
        message.textContent = "Enter an event name and a valid expense amount.";
        return;
    }
    if (participantIndexes.length === 0) {
        message.textContent = "Select at least one member to share this expense.";
        return;
    }

    const shares = splitExpense(costCents, participantIndexes);
    const confirmed = window.confirm(
        `Record "${eventName}" for Rs. ${formatCurrency(costCents / 100)} in ${formatMonthName(activeMonth)}, split among ${participantIndexes.length} selected member${participantIndexes.length === 1 ? "" : "s"}?`
    );
    if (!confirmed) {
        return;
    }

    const expense = {
        id: `EX-${Date.now().toString(36).toUpperCase()}`,
        eventName,
        costCents,
        month: activeMonth,
        date: new Date().toISOString(),
        participants: participantIndexes,
        shares
    };
    const updatedExpenses = [expense, ...expenses];
    if (!await saveExpenses(updatedExpenses)) {
        return;
    }

    expenses = updatedExpenses;
    form.reset();
    updateExpensePreview();
    renderMembers();
    renderSummaryTable();
    updateSummary();
    renderTransactions();
    message.textContent = `“${eventName}” was recorded, and savings were updated for ${participantIndexes.length} member${participantIndexes.length === 1 ? "" : "s"}.`;
}

function openCollection(memberIndex, initialMode = "weekly") {
    const member = members[memberIndex];
    if (!member) {
        return;
    }
    if (!requestEditAccess(() => openCollection(memberIndex, initialMode))) {
        return;
    }

    activeMemberIndex = memberIndex;
    collectionMode = "weekly";
    document.getElementById("additionalCollectionFields").hidden = true;
    document.getElementById("collectionModeToggle").textContent = "Record an additional amount";
    document.getElementById("additionalCollectionAmount").value = "";
    document.getElementById("additionalCollectionNote").value = "";
    document.getElementById("collectionMemberName").textContent =
        `Select the unpaid weeks collected from ${member.name} for ${formatMonthName(activeMonth)}. Each week is Rs. ${weeklyContribution}.`;
    document.getElementById("collectionMessage").textContent = "";
    document.getElementById("paymentMethod").value = "Cash";
    const weekList = document.getElementById("collectionWeeks");
    weekList.replaceChildren();

    contributions[memberIndex].forEach((isPaid, week) => {
        const label = document.createElement("label");
        label.className = `week-option${isPaid ? " week-option-paid" : ""}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "collection-week-input";
        checkbox.value = String(week);
        checkbox.disabled = isPaid;
        checkbox.checked = false;
        const name = document.createElement("span");
        name.className = "week-option-name";
        name.textContent = `Week ${week + 1} · ${formatMonthName(activeMonth)}`;
        const amount = document.createElement("span");
        amount.className = "week-option-amount";
        amount.textContent = isPaid ? "Already collected" : `Rs. ${weeklyContribution}`;
        label.append(checkbox, name, amount);
        weekList.appendChild(label);
    });

    collectionModal.hidden = false;
    document.body.classList.add("modal-open");
    if (initialMode === "additional") {
        setCollectionMode("additional");
    } else {
        updateCollectionAmount();
        const firstAvailableWeek = weekList.querySelector("input:not(:disabled)");
        if (firstAvailableWeek) {
            firstAvailableWeek.focus();
        }
    }
}

function updateCollectionAmount() {
    const saveButton = document.getElementById("saveCollectionButton");
    if (collectionMode === "additional") {
        const amountCents = getAdditionalCollectionInputCents();
        document.getElementById("collectionAmount").textContent =
            formatCurrency(amountCents / 100);
        saveButton.disabled = amountCents === 0;
        saveButton.textContent = "Save additional collection & create receipt";
        return;
    }

    const selectedWeeks = document.querySelectorAll(".collection-week-input:checked").length;
    document.getElementById("collectionAmount").textContent =
        formatCurrency(selectedWeeks * weeklyContribution);
    saveButton.disabled = selectedWeeks === 0;
    saveButton.textContent = "Save collection & create receipt";
}

function closeCollection() {
    collectionModal.hidden = true;
    document.body.classList.remove("modal-open");
    activeMemberIndex = null;
    collectionMode = "weekly";
}

function getAdditionalCollectionInputCents() {
    const amount = Number(document.getElementById("additionalCollectionAmount").value);
    if (!Number.isFinite(amount) || amount <= 0) {
        return 0;
    }
    const amountCents = Math.round(amount * 100);
    return Number.isSafeInteger(amountCents) ? amountCents : 0;
}

function setCollectionMode(mode) {
    collectionMode = mode;
    const isAdditional = collectionMode === "additional";
    document.getElementById("collectionWeeks").hidden = isAdditional;
    document.getElementById("additionalCollectionFields").hidden = !isAdditional;
    document.getElementById("collectionModeToggle").textContent =
        isAdditional ? "Back to weekly ticks" : "Record an additional amount";
    document.getElementById("collectionMemberName").textContent = isAdditional
        ? `Record an extra contribution for ${members[activeMemberIndex].name}.`
        : `Select the unpaid weeks collected from ${members[activeMemberIndex].name} for ${formatMonthName(activeMonth)}. Each week is Rs. ${weeklyContribution}.`;
    document.getElementById("collectionMessage").textContent = "";
    updateCollectionAmount();
    if (isAdditional && !collectionModal.hidden) {
        document.getElementById("additionalCollectionAmount").focus();
    }
}

function toggleCollectionMode() {
    setCollectionMode(collectionMode === "weekly" ? "additional" : "weekly");
}

function createReceiptId() {
    const now = new Date();
    const dateStamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("");
    return `BK-${dateStamp}-${Date.now().toString(36).toUpperCase()}`;
}

async function saveCollection() {
    if (!requestEditAccess(saveCollection)) {
        return;
    }

    const memberIndex = activeMemberIndex;
    if (memberIndex === null || !members[memberIndex]) {
        return;
    }

    let receipt;
    let receiptSaved;
    if (collectionMode === "additional") {
        const amountCents = getAdditionalCollectionInputCents();
        if (amountCents <= 0) {
            document.getElementById("collectionMessage").textContent =
                "Enter a valid additional amount before saving.";
            return;
        }

        receipt = {
            id: createReceiptId(),
            type: "additional",
            memberIndex,
            memberName: members[memberIndex].name,
            weeks: [],
            amount: amountCents / 100,
            amountCents,
            description: document.getElementById("additionalCollectionNote").value.trim(),
            method: document.getElementById("paymentMethod").value,
            month: activeMonth,
            date: new Date().toISOString()
        };
        receipts.unshift(receipt);
        receiptSaved = await saveReceipts();
        if (!receiptSaved) {
            receipts.shift();
            document.getElementById("collectionMessage").textContent =
                sharedBackendConfigured
                    ? "Could not save this additional collection to the shared fund. Check the status message and try again."
                    : "Could not save this additional collection in the browser. Check available storage and try again.";
            return;
        }
    } else {
        const weeks = Array.from(document.querySelectorAll(".collection-week-input:checked"))
            .map(input => Number(input.value));
        const invalidSelection = weeks.length === 0 ||
            weeks.some(week => contributions[memberIndex][week]);
        if (invalidSelection) {
            document.getElementById("collectionMessage").textContent =
                "Choose at least one unpaid week before saving.";
            return;
        }

        const previousContributions = contributions;
        contributions = contributions.map((memberWeeks, index) =>
            index === memberIndex
                ? memberWeeks.map((isPaid, week) => isPaid || weeks.includes(week))
                : memberWeeks
        );

        if (!await saveData()) {
            contributions = previousContributions;
            return;
        }

        receipt = {
            id: createReceiptId(),
            memberIndex,
            memberName: members[memberIndex].name,
            weeks: weeks.map(week => week + 1),
            amount: weeks.length * weeklyContribution,
            method: document.getElementById("paymentMethod").value,
            month: activeMonth,
            date: new Date().toISOString()
        };
        receipts.unshift(receipt);
        receiptSaved = await saveReceipts();
    }

    renderMembers();
    renderSummaryTable();
    updateSummary();
    renderRecentCollections();
    renderTransactions();
    closeCollection();
    showReceipt(receipt);
    if (!receiptSaved) {
        document.getElementById("receiptMessage").textContent =
            "The payment was recorded, but receipt history could not be saved. Download or print this receipt now.";
    }
}

function showReceipt(receipt) {
    activeReceipt = receipt;
    document.getElementById("receiptNumber").textContent = receipt.id;
    document.getElementById("receiptDate").textContent =
        new Intl.DateTimeFormat("en-LK", { dateStyle: "medium", timeStyle: "short" })
            .format(new Date(receipt.date));
    document.getElementById("receiptMember").textContent = receipt.memberName;
    document.getElementById("receiptContributionLabel").textContent =
        receipt.type === "additional" ? "Additional collection" : "Contribution";
    document.getElementById("receiptWeeks").textContent = receipt.type === "additional"
        ? (receipt.description || "Extra amount")
        : receipt.weeks.map(week => `Week ${week}`).join(", ");
    const receiptMonth = receipt.month || getMonthKey(new Date(receipt.date));
    document.getElementById("receiptMonth").textContent = formatMonthName(receiptMonth);
    document.getElementById("receiptMethod").textContent = receipt.method;
    document.getElementById("receiptAmount").textContent = formatCurrency(receipt.amount);
    document.getElementById("receiptMessage").textContent = "";
    receiptModal.hidden = false;
    document.body.classList.add("modal-open");
}

function closeReceipt() {
    receiptModal.hidden = true;
    document.body.classList.remove("modal-open", "printing-receipt");
    activeReceipt = null;
}

function renderRecentCollections() {
    const container = document.getElementById("recentCollections");
    container.replaceChildren();

    if (receipts.length === 0) {
        const empty = document.createElement("p");
        empty.className = "recent-empty";
        empty.textContent = "Your recorded collections and their receipts will appear here.";
        container.appendChild(empty);
        return;
    }

    receipts.slice(0, 5).forEach(receipt => {
        const item = document.createElement("div");
        item.className = "recent-item";
        const member = document.createElement("div");
        member.className = "recent-member";
        const avatar = document.createElement("span");
        avatar.className = "member-avatar";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = receipt.memberName.slice(0, 1).toUpperCase();
        const name = document.createElement("span");
        name.textContent = receipt.memberName;
        member.append(avatar, name);

        const details = document.createElement("span");
        details.className = "recent-detail";
        const receiptMonth = receipt.month || getMonthKey(new Date(receipt.date));
        const collectionDetails = receipt.type === "additional"
            ? `Additional${receipt.description ? ` · ${receipt.description}` : ""}`
            : receipt.weeks.map(week => `Week ${week}`).join(", ");
        details.textContent =
            `${collectionDetails} · ${formatMonthName(receiptMonth)} · ${receipt.method}`;
        const amount = document.createElement("strong");
        amount.className = "recent-amount";
        amount.textContent = `Rs. ${formatCurrency(receipt.amount)}`;
        const receiptButton = document.createElement("button");
        receiptButton.type = "button";
        receiptButton.className = "text-button";
        receiptButton.textContent = "View receipt";
        receiptButton.addEventListener("click", () => showReceipt(receipt));
        item.append(member, details, amount, receiptButton);
        container.appendChild(item);
    });
}

async function downloadReceiptImage() {
    if (!activeReceipt) {
        return;
    }

    try {
        await document.fonts.ready;
        const canvas = document.createElement("canvas");
        canvas.width = 1200;
        canvas.height = 840;
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Image drawing is not available in this browser.");
        }

        context.fillStyle = "#f3f5ef";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.roundRect(70, 55, 1060, 730, 26);
        context.fill();

        context.fillStyle = "#2e6856";
        context.beginPath();
        context.arc(145, 145, 39, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#ffffff";
        context.font = "700 29px 'DM Sans', sans-serif";
        context.textAlign = "center";
        context.fillText("BK", 145, 155);

        context.textAlign = "left";
        context.fillStyle = "#203b35";
        context.font = "600 31px 'Noto Sans Sinhala', sans-serif";
        context.fillText(receiptBrandName, 205, 137);
        context.fillStyle = "#78827b";
        context.font = "500 18px 'DM Sans', sans-serif";
        context.fillText(
            `${isActivitiesFund ? "BOYS’ ACTIVITIES FUND" : "BAAHIRA KRIYAAKAARAKAM"} · PAYMENT CONFIRMATION`,
            205,
            171
        );
        context.strokeStyle = "#e9ece6";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(115, 215);
        context.lineTo(1085, 215);
        context.stroke();

        context.fillStyle = "#203b35";
        context.font = "700 36px 'DM Sans', sans-serif";
        context.fillText("Payment receipt", 115, 285);
        context.fillStyle = "#4e8a64";
        context.font = "700 23px 'DM Sans', sans-serif";
        context.fillText("PAID", 990, 279);

        const details = [
            ["Receipt number", activeReceipt.id],
            ["Date", new Intl.DateTimeFormat("en-LK", { dateStyle: "medium", timeStyle: "short" })
                .format(new Date(activeReceipt.date))],
            ["Received from", activeReceipt.memberName],
            [
                activeReceipt.type === "additional" ? "Additional collection" : "Contribution",
                activeReceipt.type === "additional"
                    ? (activeReceipt.description || "Extra amount")
                    : activeReceipt.weeks.map(week => `Week ${week}`).join(", ")
            ],
            ["Collection month", formatMonthName(activeReceipt.month || getMonthKey(new Date(activeReceipt.date)))],
            ["Payment method", activeReceipt.method]
        ];
        let y = 340;
        details.forEach(([label, value]) => {
            context.fillStyle = "#78827b";
            context.font = "500 19px 'DM Sans', sans-serif";
            context.fillText(label, 120, y);
            context.fillStyle = "#203b35";
            context.font = "600 20px 'DM Sans', sans-serif";
            context.fillText(value, 475, y);
            y += 52;
        });

        context.fillStyle = "#edf4ed";
        context.beginPath();
        context.roundRect(110, 675, 980, 72, 12);
        context.fill();
        context.fillStyle = "#203b35";
        context.font = "600 22px 'DM Sans', sans-serif";
        context.fillText("Total received", 138, 721);
        context.textAlign = "right";
        context.font = "700 29px 'DM Sans', sans-serif";
        context.fillText(`Rs. ${formatCurrency(activeReceipt.amount)}`, 1060, 721);
        context.textAlign = "center";
        context.fillStyle = "#78827b";
        context.font = "500 17px 'Noto Sans Sinhala', sans-serif";
        context.fillText("ඔබගේ දායකත්වයට ස්තුතියි!", 600, 765);

        const image = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!image) {
            throw new Error("The receipt image could not be created.");
        }

        const url = URL.createObjectURL(image);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${activeReceipt.id.toLowerCase()}-receipt.png`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        console.error("Could not create receipt image.", error);
        document.getElementById("receiptMessage").textContent =
            "Could not create the image. Please use Print / Save PDF instead.";
    }
}

document.getElementById("fundPicker").hidden = shouldOpenFund;
document.getElementById("appShell").hidden = sharedBackendConfigured || !shouldOpenFund;
if (hasSelectedFund) {
    const fundName = isActivitiesFund
        ? "External Activities Fund ( Highly Confidential )"
        : "බාහිර ක්‍රියාකාරකම් අරමුදල";
    document.title = `${fundName} | ${isActivitiesFund ? "Activities ledger" : "Community fund"}`;
    document.getElementById("currentLedgerTitle").textContent =
        isActivitiesFund ? "activities ledger" : "community ledger";
    document.getElementById("transactionsLedgerTitle").textContent =
        isActivitiesFund ? "Activities transaction history" : "Transaction history";
    document.getElementById("brandCaption").textContent =
        isActivitiesFund ? "External Activities Fund" : "අපේ එකතුව";
    document.getElementById("welcomeTitle").textContent = isActivitiesFund
        ? "Good times together."
        : "A little together. A lot to celebrate.";
    document.querySelector(".welcome-kicker").textContent = isActivitiesFund
        ? "EXTERNAL ACTIVITIES FUND · HIGHLY CONFIDENTIAL"
        : "BAAHIRA COMMUNITY FUND";
    document.getElementById("memberStatCaption").textContent =
        isActivitiesFund ? "ACTIVITIES FUND" : "COMMUNITY";
    document.getElementById("memberSectionLabel").textContent =
        isActivitiesFund ? "BOYS’ ACTIVITIES" : "YOUR COMMUNITY";
    document.getElementById("receiptBrandTitle").textContent = receiptBrandName;
    document.getElementById("receiptBrandKicker").textContent =
        isActivitiesFund ? "BOYS’ ACTIVITIES FUND" : "BAAHIRA KRIYAAKAARAKAM";
    document.getElementById("heroMemberCount").textContent = String(members.length);
    document.getElementById("summaryRowCount").textContent = `${members.length} members`;
    document.getElementById("summaryNoteMembersCount").textContent = String(members.length);
    document.body.classList.toggle("no-birthdays", isActivitiesFund);
}

document.getElementById("changeFundButton").addEventListener("click", () => {
    sessionStorage.removeItem(activitiesAccessStorageKey);
    document.getElementById("appShell").hidden = true;
    document.getElementById("fundPicker").hidden = false;
    window.history.replaceState(null, "", window.location.pathname);
    document.getElementById("fundPickerTitle").focus();
});
document.querySelector('[data-fund="activities"]').addEventListener("click", event => {
    if (sessionStorage.getItem(activitiesAccessStorageKey) === "granted") {
        return;
    }
    event.preventDefault();
    openActivitiesPin();
});
document.getElementById("activitiesPinForm").addEventListener("submit", submitActivitiesPin);
document.querySelectorAll("[data-close-activities-pin]").forEach(button => {
    button.addEventListener("click", closeActivitiesPin);
});
activitiesPinModal.addEventListener("click", event => {
    if (event.target === activitiesPinModal) {
        closeActivitiesPin();
    }
});
document.getElementById("editLockButton").addEventListener("click", async () => {
    if (sharedBackendConfigured) {
        if (!authenticatedRole) {
            requestEditAccess();
            return;
        }
        try {
            const { error } = await supabaseClient.auth.signOut();
            if (error) {
                throw error;
            }
            if (sharedRefreshTimer) {
                window.clearInterval(sharedRefreshTimer);
                sharedRefreshTimer = null;
            }
            const keepUnimportedLocalData = authenticatedAdmin && localImportAvailable;
            authenticatedRole = null;
            authenticatedAdmin = false;
            sharedBackendReady = false;
            sharedRevision = 0;
            localImportAvailable = false;
            localImportData = null;
            members = [];
            monthlyContributions = {};
            contributions = createEmptyContributions();
            receipts = [];
            expenses = [];
            if (keepUnimportedLocalData) {
                clearLocalFundCache(storagePrefix === "fund" ? "activitiesFund" : "fund");
            } else {
                clearAllLocalFundCaches();
            }
            renderMemberFilters();
            renderExpenseMembers();
            renderFundData();
            document.getElementById("appShell").hidden = true;
            updateEditLockButton();
            document.querySelector(".masthead-status").textContent = "Sign in required";
            setSyncStatus("Signed out. Sign in with an approved account to view this private fund.");
            requestEditAccess();
        } catch (error) {
            console.error("Could not sign out of the shared fund.", error);
            setSyncStatus(`Could not sign out: ${error.message}`, true);
        }
        return;
    }

    requestEditAccess();
});
document.getElementById("importLocalButton").addEventListener("click", importLocalRecords);
document.getElementById("pinForm").addEventListener("submit", submitPin);
document.querySelectorAll("[data-close-pin]").forEach(button => {
    button.addEventListener("click", closePinModal);
});
pinModal.addEventListener("click", event => {
    if (event.target === pinModal) {
        closePinModal();
    }
});

monthSelector.value = activeMonth;
document.getElementById("currentMonth").textContent = formatMonthName(activeMonth);
document.getElementById("expenseMonth").textContent = formatMonthName(activeMonth);
document.getElementById("membersCount").textContent = String(members.length);
renderMemberFilters();
renderExpenseMembers();
renderMembers();
renderSummaryTable();
updateSummary();
renderBirthdays();
renderRecentCollections();
renderTransactions();

memberGrid.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const button = target.closest(".member-card-main, .collect-button, .additional-collection-button, .history-button");
    if (!button) {
        return;
    }
    const card = button.closest(".member-card");
    if (card) {
        if (button.classList.contains("additional-collection-button")) {
            openCollection(Number(card.dataset.memberIndex), "additional");
        } else if (button.classList.contains("history-button")) {
            openMemberTransactions(Number(card.dataset.memberIndex));
        } else {
            openCollection(Number(card.dataset.memberIndex));
        }
    }
});
summaryTable.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
        return;
    }

    const button = target.closest(".member-select-button, .collect-button, .additional-collection-button, .history-button");
    if (!button) {
        return;
    }
    const row = button.closest("tr");
    if (button.classList.contains("additional-collection-button")) {
        openCollection(Number(row.dataset.memberIndex), "additional");
    } else if (button.classList.contains("history-button")) {
        openMemberTransactions(Number(row.dataset.memberIndex));
    } else {
        openCollection(Number(row.dataset.memberIndex));
    }
});

searchInput.addEventListener("input", renderMembers);
statusFilter.addEventListener("change", renderMembers);
monthSelector.addEventListener("change", () => selectMonth(monthSelector.value));
transactionFilter.addEventListener("change", renderTransactions);
expenseMembers.addEventListener("change", updateExpensePreview);
document.getElementById("expenseCost").addEventListener("input", updateExpensePreview);
document.getElementById("expenseForm").addEventListener("submit", saveExpense);
document.getElementById("selectAllExpenseMembers").addEventListener("click", () => {
    expenseMembers.querySelectorAll(".expense-member-checkbox").forEach(input => {
        input.checked = true;
    });
    updateExpensePreview();
});
document.getElementById("clearExpenseMembers").addEventListener("click", () => {
    expenseMembers.querySelectorAll(".expense-member-checkbox").forEach(input => {
        input.checked = false;
    });
    updateExpensePreview();
});
document.getElementById("collectionWeeks").addEventListener("change", updateCollectionAmount);
document.getElementById("collectionModeToggle").addEventListener("click", toggleCollectionMode);
document.getElementById("additionalCollectionAmount").addEventListener("input", updateCollectionAmount);
document.getElementById("saveCollectionButton").addEventListener("click", saveCollection);
document.querySelectorAll("[data-close-collection]").forEach(button => {
    button.addEventListener("click", closeCollection);
});
document.querySelectorAll("[data-close-receipt]").forEach(button => {
    button.addEventListener("click", closeReceipt);
});
collectionModal.addEventListener("click", event => {
    if (event.target === collectionModal) {
        closeCollection();
    }
});
receiptModal.addEventListener("click", event => {
    if (event.target === receiptModal) {
        closeReceipt();
    }
});
document.getElementById("receiptPdfButton").addEventListener("click", () => {
    document.body.classList.add("printing-receipt");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-receipt"), { once: true });
    window.print();
});
document.getElementById("receiptPngButton").addEventListener("click", downloadReceiptImage);
document.getElementById("anotherCollectionButton").addEventListener("click", () => {
    closeReceipt();
    showView("members");
});
document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        if (!activitiesPinModal.hidden) {
            closeActivitiesPin();
        } else if (!pinModal.hidden) {
            closePinModal();
        } else if (!receiptModal.hidden) {
            closeReceipt();
        } else if (!collectionModal.hidden) {
            closeCollection();
        }
    }
});
document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.view));
});
document.querySelector(".brand").addEventListener("click", event => {
    event.preventDefault();
    showView("overview");
});
document.querySelectorAll("[data-open-view]").forEach(button => {
    button.addEventListener("click", () => showView(button.dataset.openView));
});
document.getElementById("printButton").addEventListener("click", () => window.print());
document.getElementById("exportButton").addEventListener("click", exportCsv);
document.getElementById("resetButton").addEventListener("click", resetRecords);
updateEditLockButton();

const loadingScreen = document.getElementById("loadingScreen");
function hideLoadingScreen() {
    loadingScreen.classList.add("is-hidden");
    loadingScreen.setAttribute("aria-hidden", "true");
}
if (shouldOpenFund) {
    initializeSharedBackend().then(hideLoadingScreen, error => {
        console.error("Could not initialize the shared fund.", error);
        setSyncStatus(`Could not initialize shared storage: ${error.message}`, true);
        hideLoadingScreen();
    });
} else {
    window.setTimeout(() => {
        hideLoadingScreen();
        if (isActivitiesFund) {
            openActivitiesPin();
        }
    }, 1800);
}
