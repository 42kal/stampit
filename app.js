// ============================================
// STAMPIT - Digital Loyalty Card Prototype
// ============================================

// ---- UUID ----
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ---- Toast ----
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.classList.add('hidden'), 300);
    }, 2500);
}

// ---- API ----
const api = {
    async post(path, body) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return res.json();
    },
    async get(path) {
        const res = await fetch(path);
        return res.json();
    },
    registerCustomer: (c)          => api.post('/api/register-customer', c),
    registerBusiness: (b)          => api.post('/api/register-business', b),
    getBusiness:      (id)         => api.get(`/api/business/${id}`),
    getCards:         (customerId) => api.get(`/api/cards/${customerId}`),
    getMembers:       (businessId) => api.get(`/api/members/${businessId}`),
    join:  (customerId, businessId) => api.post('/api/join',  { customerId, businessId, timestamp: Date.now() }),
    stamp: (customerId, businessId, count = 1) => api.post('/api/stamp', { customerId, businessId, count, timestamp: Date.now() }),
};

// ---- Session ----
const Session = {
    get()    { try { return JSON.parse(localStorage.getItem('stampit_session')) || {}; } catch { return {}; } },
    set(d)   { localStorage.setItem('stampit_session', JSON.stringify({ ...this.get(), ...d })); },
    clear(k) { const s = this.get(); delete s[k]; localStorage.setItem('stampit_session', JSON.stringify(s)); },
};

// ---- Constants ----
const CARD_COLORS = [
    '#eb5c5c','#EF4444','#8B5CF6','#3B82F6',
    '#10B981','#f09696','#EC4899','#06B6D4',
    '#6366F1','#14B8A6'
];
const STAMP_ICONS = ['☕','🍕','🍔','🧁','💇','🛒','⭐','💎','🎯','❤️','🍩','🥤'];

// ---- App State ----
let currentTab      = 0;
let activeScanner   = null;
let selectedCardBiz = null;
let pollInterval    = null;
let prevCardState   = {}; // cardKey -> { stamps, totalVisits, rewardsEarned }
let _bizCache       = {}; // businessId -> biz object (shared across tabs)
let _lastCards      = null; // last fetched cards array (null = never loaded)

// ---- Utilities ----
const appEl = () => document.getElementById('app');

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function ordinal(n) {
    const s = ['th','st','nd','rd'], v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}
function relDate(ts) { return ts ? new Date(ts).toLocaleDateString() : 'never'; }
function loading(msg = 'Loading…') {
    return `<div style="display:flex;align-items:center;justify-content:center;padding:60px 24px;color:var(--gray-400);font-size:14px;font-weight:600">${msg}</div>`;
}
function showViewError(vc, msg) {
    if (!vc) return;
    vc.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">⚠️</div>
            <h3>Something went wrong</h3>
            <p>${msg}</p>
            <button class="btn btn-primary" onclick="renderApp()">Retry</button>
        </div>`;
}
function handleSessionExpired(key) {
    Session.clear(key);
    showToast('Session expired — server was restarted. Please set up again.');
    renderApp();
}

// ============================================
// SOUND EFFECTS (Web Audio API)
// ============================================
function getAudioContext() {
    if (!window._audioCtx) {
        window._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return window._audioCtx;
}

function playNote(ctx, freq, startTime, duration, type = 'sine', volume = 0.3) {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
}

function playStampSound() {
    try {
        const ctx = getAudioContext();
        const t = ctx.currentTime;
        // Thunk + rising ding
        playNote(ctx, 180,  t,       0.12, 'triangle', 0.25);
        playNote(ctx, 660,  t + 0.08, 0.25, 'sine',     0.25);
        playNote(ctx, 880,  t + 0.20, 0.30, 'sine',     0.20);
    } catch (e) {}
}

function playRewardSound() {
    try {
        const ctx = getAudioContext();
        const t = ctx.currentTime;
        // Triumphant ascending fanfare: C E G C
        const notes = [523, 659, 784, 1047];
        notes.forEach((freq, i) => {
            playNote(ctx, freq, t + i * 0.13, 0.4, 'sine', 0.28);
        });
        // Bass harmony
        playNote(ctx, 261, t, 0.6, 'triangle', 0.15);
    } catch (e) {}
}

// ============================================
// CONFETTI
// ============================================
function launchConfetti(stampCount = 1) {
    if (typeof confetti === 'undefined') return;
    const particles = Math.min(200, 70 + (stampCount - 1) * 40);
    confetti({
        particleCount: particles,
        spread: 55 + (stampCount - 1) * 5,
        origin: { y: 0.5 },
        colors: ['#eb5c5c', '#FFFFFF', '#fbdede', '#c83e3e'],
        scalar: 0.9,
    });
}

function launchRewardConfetti() {
    if (typeof confetti === 'undefined') return;
    const opts = { colors: ['#eb5c5c', '#FFFFFF', '#fbdede', '#f09696', '#18181B'] };
    confetti({ ...opts, particleCount: 120, spread: 80, origin: { y: 0.4 } });
    setTimeout(() => confetti({ ...opts, particleCount: 80, angle: 60,  spread: 50, origin: { x: 0, y: 0.6 } }), 250);
    setTimeout(() => confetti({ ...opts, particleCount: 80, angle: 120, spread: 50, origin: { x: 1, y: 0.6 } }), 250);
}

// ============================================
// STAMP NOTIFICATION OVERLAY
// ============================================
function showStampNotification(card, biz, rewardEarned, stampCount = 1) {
    // Remove any existing notification
    const existing = document.getElementById('stampNotif');
    if (existing) existing.remove();

    const p = biz.program;
    const el = document.createElement('div');
    el.className = 'stamp-notification';
    el.id = 'stampNotif';

    if (rewardEarned) {
        el.innerHTML = `
            <div class="stamp-notif-backdrop" onclick="dismissStampNotif()"></div>
            <div class="stamp-notif-card reward-notif">
                <div class="stamp-notif-icon-big">🏆</div>
                <div class="stamp-notif-title reward-title">Reward Earned!</div>
                <div class="stamp-notif-shop">${escHtml(biz.name)}</div>
                <div class="stamp-notif-reward-name">${p.stampIcon} ${escHtml(p.rewardName)}</div>
                <div class="stamp-notif-reward-desc">${escHtml(p.rewardDescription)}</div>
                <div class="stamp-notif-meta">Your ${card.rewardsEarned}${ordinal(card.rewardsEarned)} reward!</div>
                <button class="btn btn-primary btn-full mt-16" onclick="dismissStampNotif()">Awesome! 🎉</button>
            </div>`;
        playRewardSound();
        launchRewardConfetti();
    } else {
        // Highlight the last `stampCount` newly filled dots
        const dotsHtml = Array.from({ length: p.stampsNeeded }, (_, i) => {
            const filled = i < card.stamps;
            const isNew  = filled && i >= card.stamps - stampCount;
            return `<div class="stamp-dot-lg ${filled ? 'filled' : 'empty'} ${isNew ? 'stamp-new' : ''}"
                style="${filled ? `background:${p.cardColor}22;color:${p.cardColor}` : ''}">${filled ? p.stampIcon : ''}</div>`;
        }).join('');

        const title   = stampCount > 1 ? `×${stampCount} Stamps!` : 'Stamped!';
        const remaining = p.stampsNeeded - card.stamps;
        el.innerHTML = `
            <div class="stamp-notif-backdrop" onclick="dismissStampNotif()"></div>
            <div class="stamp-notif-card">
                <div class="stamp-notif-check">${stampCount > 1 ? `×${stampCount}` : '✓'}</div>
                <div class="stamp-notif-title">${title}</div>
                <div class="stamp-notif-shop">${p.stampIcon} ${escHtml(biz.name)}</div>
                <div class="stamp-notif-dots-wrap">${dotsHtml}</div>
                <div class="stamp-notif-count">${card.stamps} <span class="stamp-notif-total">/ ${p.stampsNeeded}</span></div>
                <div class="stamp-notif-meta">
                    ${remaining > 0
                        ? `${remaining} more stamp${remaining !== 1 ? 's' : ''} for <strong>${escHtml(p.rewardName)}</strong>`
                        : `Next stamp earns you <strong>${escHtml(p.rewardName)}</strong>!`}
                </div>
                <button class="btn btn-primary btn-full mt-16" onclick="dismissStampNotif()">Got it!</button>
            </div>`;
        playStampSound();
        launchConfetti(stampCount);
    }

    document.body.appendChild(el);
    // Auto-dismiss after 8s
    clearTimeout(window._notifTimer);
    window._notifTimer = setTimeout(dismissStampNotif, 8000);
}

function dismissStampNotif() {
    clearTimeout(window._notifTimer);
    const el = document.getElementById('stampNotif');
    if (!el) return;
    el.classList.add('notif-exit');
    setTimeout(() => el.remove(), 350);
}

// ============================================
// POLLING (customer QR screen)
// ============================================
function startPolling(customerId) {
    stopPolling();
    // First pass: just record baseline, no animations
    let isBaseline = true;
    api.getCards(customerId).then(cards => {
        if (!Array.isArray(cards)) return;
        cards.forEach(c => {
            prevCardState[`${c.customerId}_${c.businessId}`] = {
                stamps: c.stamps, totalVisits: c.totalVisits, rewardsEarned: c.rewardsEarned
            };
        });
        isBaseline = false;
    });

    pollInterval = setInterval(async () => {
        if (isBaseline) return;
        try {
            const cards = await api.getCards(customerId);
            if (!Array.isArray(cards)) return;

            let changed = null;
            let rewardEarned = false;

            for (const card of cards) {
                const key  = `${card.customerId}_${card.businessId}`;
                const prev = prevCardState[key];
                if (prev && card.totalVisits > prev.totalVisits) {
                    changed = card;
                    rewardEarned = card.rewardsEarned > prev.rewardsEarned;
                    break;
                }
            }

            // Update baseline
            cards.forEach(c => {
                prevCardState[`${c.customerId}_${c.businessId}`] = {
                    stamps: c.stamps, totalVisits: c.totalVisits, rewardsEarned: c.rewardsEarned
                };
            });

            if (changed) {
                const biz = await api.getBusiness(changed.businessId);
                if (biz && !biz.error) {
                    const key = `${changed.customerId}_${changed.businessId}`;
                    const stampCount = changed.totalVisits - (prevCardState[key]?.totalVisits || changed.totalVisits - 1);
                    _bizCache[changed.businessId] = biz;
                    _lastCards = cards;
                    currentTab = 1;
                    selectedCardBiz = null;
                    stopPolling();
                    renderCustomerApp();
                    setTimeout(() => showStampNotification(changed, biz, rewardEarned, Math.max(1, stampCount)), 300);
                }
            }
        } catch (e) {}
    }, 2000);
}

function stopPolling() {
    clearInterval(pollInterval);
    pollInterval = null;
}

// ============================================
// RENDER ROUTER
// ============================================
function renderApp() {
    stopScanner();
    stopPolling();
    const s = Session.get();
    if (!s.role)                                return renderLanding();
    if (s.role === 'customer' && !s.customerId) return renderCustomerOnboarding();
    if (s.role === 'owner'    && !s.businessId) return renderOwnerOnboarding();
    if (s.role === 'customer')                  return renderCustomerApp();
    if (s.role === 'owner')                     return renderOwnerApp();
}

function switchTab(i) { stopScanner(); stopPolling(); currentTab = i; selectedCardBiz = null; renderApp(); }
function switchRole() {
    stopScanner(); stopPolling();
    const s = Session.get();
    Session.set({ role: s.role === 'customer' ? 'owner' : 'customer' });
    currentTab = 0; selectedCardBiz = null; renderApp();
}

// ============================================
// LANDING
// ============================================
function renderLanding() {
    appEl().innerHTML = `
        <div class="landing">
            <div class="landing-logo">StampIt</div>
            <div class="landing-subtitle">Digital Loyalty</div>
            <p class="landing-tagline">Punch cards, reimagined for the digital age</p>
            <div class="role-buttons">
                <button class="role-btn" onclick="selectRole('customer')">
                    <div class="role-btn-icon">👤</div>
                    <div class="role-btn-text"><h3>I'm a Customer</h3><p>Collect stamps &amp; earn rewards</p></div>
                </button>
                <button class="role-btn" onclick="selectRole('owner')">
                    <div class="role-btn-icon">🏪</div>
                    <div class="role-btn-text"><h3>I'm a Business Owner</h3><p>Create a loyalty program</p></div>
                </button>
            </div>
            <p style="margin-top:32px;font-size:12px;color:var(--gray-400)">Prototype — data shared via server</p>
        </div>`;
}
function selectRole(role) { Session.set({ role }); currentTab = 0; renderApp(); }

// ============================================
// CUSTOMER ONBOARDING
// ============================================
function renderCustomerOnboarding() {
    appEl().innerHTML = `
        <div class="onboarding">
            <div style="font-size:40px;margin-bottom:24px">👤</div>
            <h2>Create Your Account</h2>
            <p>Just your name — no sign-up needed</p>
            <div class="form-group">
                <label class="form-label">Your Name</label>
                <input type="text" class="form-input" id="customerName"
                    placeholder="e.g. Alex Johnson" autofocus
                    onkeydown="if(event.key==='Enter') createCustomer()">
            </div>
            <button class="btn btn-primary btn-lg btn-full" onclick="createCustomer()" style="max-width:340px">
                Get My QR Code →
            </button>
            <button class="btn btn-secondary mt-16" onclick="Session.set({role:null});renderApp()">← Back</button>
        </div>`;
}
async function createCustomer() {
    const name = document.getElementById('customerName').value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const customer = { id: uuid(), name, createdAt: Date.now() };
    await api.registerCustomer(customer);
    Session.set({ customerId: customer.id, customerName: customer.name });
    currentTab = 0; renderApp();
}

// ============================================
// OWNER ONBOARDING
// ============================================
function renderOwnerOnboarding() {
    window._ob = { stampCount: 8, icon: STAMP_ICONS[0], color: CARD_COLORS[0] };
    appEl().innerHTML = `
        <div class="onboarding" style="overflow-y:auto;justify-content:flex-start;padding-top:40px">
            <div style="font-size:40px;margin-bottom:24px">🏪</div>
            <h2>Set Up Your Business</h2>
            <p>Create your loyalty program in seconds</p>

            <div class="settings-section" style="width:100%;max-width:340px">
                <h3>Business Info</h3>
                <div class="form-group">
                    <label class="form-label">Business Name</label>
                    <input type="text" class="form-input" id="obBizName" placeholder="e.g. Joe's Coffee">
                </div>
                <div class="form-group">
                    <label class="form-label">Short Description</label>
                    <textarea class="form-input" id="obBizDesc" placeholder="What does your business offer?"></textarea>
                </div>
            </div>

            <div class="settings-section" style="width:100%;max-width:340px">
                <h3>Reward Settings</h3>
                <div class="form-group">
                    <label class="form-label">Stamps Needed for Reward</label>
                    <div class="stamp-count-selector">
                        <button onclick="obAdjust(-1)">−</button>
                        <span class="count" id="obStampCount">8</span>
                        <button onclick="obAdjust(1)">+</button>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Reward Name</label>
                    <input type="text" class="form-input" id="obRewardName" placeholder="e.g. Free Coffee">
                </div>
                <div class="form-group">
                    <label class="form-label">Reward Description</label>
                    <input type="text" class="form-input" id="obRewardDesc" placeholder="e.g. Any drink, on us!">
                </div>
                <div class="form-group">
                    <label class="form-label">Stamp Quota</label>
                    <input type="text" class="form-input" id="obStampQuota" placeholder="e.g. 1 stamp per 8 CHF spent">
                    <p style="font-size:12px;color:var(--gray-400);margin-top:5px">Shown to customers so they know how to earn stamps.</p>
                </div>
            </div>

            <div class="settings-section" style="width:100%;max-width:340px">
                <h3>Appearance</h3>
                <div class="form-group">
                    <label class="form-label">Stamp Icon</label>
                    <div class="icon-picker">
                        ${STAMP_ICONS.map((icon, i) => `
                            <button class="icon-option ${i === 0 ? 'selected' : ''}"
                                onclick="obSelectIcon(this,'${icon}')">${icon}</button>
                        `).join('')}
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Card Color</label>
                    <div class="color-picker">
                        ${CARD_COLORS.map((c, i) => `
                            <div class="color-option ${i === 0 ? 'selected' : ''}"
                                style="background:${c}" onclick="obSelectColor(this,'${c}')"></div>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div style="width:100%;max-width:340px">
                <button class="btn btn-primary btn-lg btn-full" onclick="createBusiness()">Launch My Program 🚀</button>
                <button class="btn btn-secondary btn-full mt-16" onclick="Session.set({role:null});renderApp()">← Back</button>
            </div>
        </div>`;
}
function obAdjust(d) {
    window._ob.stampCount = Math.max(3, Math.min(20, window._ob.stampCount + d));
    document.getElementById('obStampCount').textContent = window._ob.stampCount;
}
function obSelectIcon(el, icon) {
    document.querySelectorAll('.icon-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected'); window._ob.icon = icon;
}
function obSelectColor(el, color) {
    document.querySelectorAll('.color-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected'); window._ob.color = color;
}
async function createBusiness() {
    const name = document.getElementById('obBizName').value.trim();
    if (!name) { showToast('Please enter a business name'); return; }
    const ob = window._ob;
    const biz = {
        id: uuid(), name,
        description: document.getElementById('obBizDesc').value.trim(),
        program: {
            stampsNeeded:       ob.stampCount,
            rewardName:         document.getElementById('obRewardName').value.trim() || 'Free Item',
            rewardDescription:  document.getElementById('obRewardDesc').value.trim() || 'Enjoy a free item on us!',
            stampQuota:         document.getElementById('obStampQuota').value.trim(),
            stampIcon:          ob.icon,
            cardColor:          ob.color
        },
        createdAt: Date.now()
    };
    await api.registerBusiness(biz);
    Session.set({ businessId: biz.id, businessName: biz.name });
    currentTab = 0; renderApp();
}

// ============================================
// APP SHELL HELPER
// ============================================
function appShell(tabs, switchLabel, content) {
    return `
        <div class="header">
            <div class="header-logo">StampIt</div>
            <button class="header-action" onclick="switchRole()">${switchLabel}</button>
        </div>
        <div class="content" id="viewContent">${content}</div>
        <nav class="bottom-nav">
            ${tabs.map((t, i) => `
                <button class="nav-item ${currentTab === i ? 'active' : ''}" onclick="switchTab(${i})">
                    <span class="nav-icon">${t.icon}</span>
                    <span class="nav-label">${t.label}</span>
                </button>`).join('')}
        </nav>`;
}

// ============================================
// CUSTOMER APP
// ============================================
function renderCustomerApp() {
    const s = Session.get();
    const tabs = [
        { icon: '⊡', label: 'My QR' },
        { icon: '💳', label: 'My Cards' },
        { icon: '📷', label: 'Join Shop' }
    ];
    appEl().innerHTML = appShell(tabs, 'Owner Mode', loading());
    const views = [
        () => renderCustomerQR(s.customerId, s.customerName),
        () => renderCustomerCards(s.customerId),
        () => renderCustomerScanJoin(s.customerId)
    ];
    views[currentTab]();
}

// ---- Customer: My QR (Card-style with live stamp dots) ----
async function renderCustomerQR(customerId, customerName) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = `
        <div class="id-card-page">
            <div class="id-card">
                <div class="id-card-top">
                    <div class="id-card-logo">StampIt</div>
                    <div class="id-card-name" id="customerNameDisplay">
                        ${escHtml(customerName)}
                        <button class="name-edit-btn" onclick="startEditName()" title="Edit name">✏️</button>
                    </div>
                    <div class="id-card-sub">Loyalty Member</div>
                </div>
                <div class="id-card-qr-section">
                    <div class="qr-wrapper" id="customerQR"></div>
                </div>
                <div class="id-card-bottom">
                    <div class="qr-id" onclick="copyCode('STAMPIT_CUSTOMER:${customerId}')" title="Tap to copy">
                        ${customerId.substring(0, 8).toUpperCase()} · tap to copy
                    </div>
                </div>
            </div>

            <div id="shopCardsArea">${loading('Loading your cards…')}</div>

            <div style="margin-top:8px;background:var(--gray-50);border-radius:var(--radius);padding:10px 14px;max-width:340px;width:100%">
                <p style="font-size:11px;color:var(--gray-400);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Full code (manual fallback)</p>
                <p style="font-size:11px;color:var(--gray-500);font-family:monospace;word-break:break-all;cursor:pointer"
                   onclick="copyCode('STAMPIT_CUSTOMER:${customerId}')">STAMPIT_CUSTOMER:${customerId}</p>
            </div>
        </div>`;

    makeQR('customerQR', `STAMPIT_CUSTOMER:${customerId}`);

    const cards = await api.getCards(customerId).catch(() => []);
    refreshShopCards(customerId, Array.isArray(cards) ? cards : []);
    startPolling(customerId);
}

// ---- Customer: Edit name inline ----
function startEditName() {
    const el = document.getElementById('customerNameDisplay');
    if (!el) return;
    const current = Session.get().customerName || '';
    el.innerHTML = `
        <div class="name-edit-row">
            <input class="name-edit-input" id="nameEditInput" type="text"
                value="${escHtml(current)}" maxlength="40"
                onkeydown="if(event.key==='Enter')saveNewName();if(event.key==='Escape')cancelEditName()">
            <button class="name-edit-confirm" onclick="saveNewName()">✓</button>
            <button class="name-edit-cancel"  onclick="cancelEditName()">✕</button>
        </div>`;
    const input = document.getElementById('nameEditInput');
    input.focus();
    input.select();
}

async function saveNewName() {
    const input = document.getElementById('nameEditInput');
    if (!input) return;
    const newName = input.value.trim();
    if (!newName) { showToast('Name cannot be empty'); return; }
    const s = Session.get();
    try {
        await api.registerCustomer({ id: s.customerId, name: newName, createdAt: Date.now() });
        Session.set({ customerName: newName });
        showToast('Name updated!');
        renderApp();
    } catch (e) {
        showToast('Could not save — is the server running?');
    }
}

function cancelEditName() {
    renderApp();
}

// Build the live stamp card list (called on first render + after each poll hit)
async function refreshShopCards(customerId, cards) {
    _lastCards = cards;
    const area = document.getElementById('shopCardsArea');
    if (!area) return;

    if (!cards.length) {
        area.innerHTML = `
            <div class="no-cards-hint">
                <p>No shops yet — scan an invite QR to join!</p>
                <button class="btn btn-outline btn-sm" onclick="switchTab(2)">Join a Shop</button>
            </div>`;
        return;
    }

    // Only fetch businesses not already cached
    await Promise.all(cards.map(async card => {
        if (!_bizCache[card.businessId]) {
            const biz = await api.getBusiness(card.businessId).catch(() => null);
            if (biz && !biz.error) _bizCache[card.businessId] = biz;
        }
    }));

    area.innerHTML = `
        <div class="shop-cards-heading">Your Active Cards</div>
        <div class="shop-cards-list">
            ${cards.map(card => {
                const biz = _bizCache[card.businessId];
                if (!biz || biz.error) return '';
                return shopCardRowHTML(card, biz);
            }).join('')}
        </div>`;
}

function shopCardRowHTML(card, biz) {
    const p = biz.program;
    const dots = Array.from({ length: p.stampsNeeded }, (_, i) => {
        const filled = i < card.stamps;
        return `<div class="sdot ${filled ? 'sdot-filled' : 'sdot-empty'}"
            style="${filled ? `background:${p.cardColor}22;color:${p.cardColor}` : ''}">${filled ? p.stampIcon : ''}</div>`;
    }).join('');

    return `
        <div class="shop-card-row" id="shopcard-${card.businessId}" style="border-left:3px solid ${p.cardColor}">
            <div class="shop-card-icon" style="background:${p.cardColor}22;color:${p.cardColor}">${p.stampIcon}</div>
            <div class="shop-card-body">
                <div class="shop-card-name">${escHtml(biz.name)}</div>
                <div class="shop-card-dots">${dots}</div>
                <div class="shop-card-meta">${card.stamps}/${p.stampsNeeded} stamps · <em>${escHtml(p.rewardName)}</em></div>
            </div>
        </div>`;
}

// ---- Customer: My Cards (stamp circles per card) ----
async function renderCustomerCards(customerId) {
    const vc = document.getElementById('viewContent');

    if (selectedCardBiz) {
        vc.innerHTML = loading();
        return renderCustomerCardDetail(customerId, selectedCardBiz);
    }

    // Render instantly from cache if available, then silently refresh
    if (_lastCards !== null) {
        renderCardsIntoVC(vc, customerId, _lastCards, _bizCache);
        // Background refresh — fetch fresh cards + any missing biz data
        api.getCards(customerId).then(async fresh => {
            if (!Array.isArray(fresh)) return;
            await Promise.all(fresh.map(async card => {
                if (!_bizCache[card.businessId]) {
                    const biz = await api.getBusiness(card.businessId).catch(() => null);
                    if (biz && !biz.error) _bizCache[card.businessId] = biz;
                }
            }));
            _lastCards = fresh;
            // Only re-render if we're still on cards tab and not drilling into a card
            if (currentTab === 1 && !selectedCardBiz) {
                renderCardsIntoVC(document.getElementById('viewContent'), customerId, fresh, _bizCache);
            }
        }).catch(() => {});
        return;
    }

    // No cache yet — full fetch with loading spinner
    vc.innerHTML = loading();
    try {
        const cards = await api.getCards(customerId);
        if (!Array.isArray(cards)) throw new Error('Bad response');
        await Promise.all(cards.map(async card => {
            if (!_bizCache[card.businessId]) {
                const biz = await api.getBusiness(card.businessId).catch(() => null);
                if (biz && !biz.error) _bizCache[card.businessId] = biz;
            }
        }));
        _lastCards = cards;
        renderCardsIntoVC(vc, customerId, cards, _bizCache);
    } catch (e) {
        showViewError(vc, 'Could not load cards. Is the server running?');
    }
}

function renderCardsIntoVC(vc, _customerId, cards, bizMap) {
    if (!vc) return;
    if (!cards.length) {
        vc.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">💳</div>
                <h3>No Cards Yet</h3>
                <p>Scan a shop's QR code to join their loyalty program and start earning stamps</p>
                <button class="btn btn-primary" onclick="switchTab(2)">Join a Shop</button>
            </div>`;
        return;
    }
    vc.innerHTML = `
        <div class="section-header"><h2>My Cards</h2><p>${cards.length} loyalty card${cards.length !== 1 ? 's' : ''}</p></div>
        <div class="cards-grid">
            ${cards.map(card => {
                const biz = bizMap[card.businessId];
                if (!biz || biz.error) return '';
                const p = biz.program;
                const dots = Array.from({ length: p.stampsNeeded }, (_, i) => {
                    const filled = i < card.stamps;
                    return `<div class="sdot ${filled ? 'sdot-filled' : 'sdot-empty'}"
                        style="${filled ? `background:${p.cardColor}22;color:${p.cardColor};font-size:14px` : 'width:22px;height:22px'}">${filled ? p.stampIcon : ''}</div>`;
                }).join('');
                return `
                    <div class="loyalty-card" onclick="selectedCardBiz='${card.businessId}';renderApp()">
                        <div class="loyalty-card-accent" style="background:${p.cardColor}"></div>
                        <div class="loyalty-card-header">
                            <div class="loyalty-card-icon" style="background:${p.cardColor}22;color:${p.cardColor}">${p.stampIcon}</div>
                            <div class="loyalty-card-info">
                                <h4>${escHtml(biz.name)}</h4>
                                <p>${escHtml(p.rewardName)} · ${p.stampsNeeded} stamps</p>
                            </div>
                            <div style="font-size:13px;font-weight:700;color:${p.cardColor};white-space:nowrap">
                                ${card.stamps}/${p.stampsNeeded}
                            </div>
                        </div>
                        <div class="stamp-dots-row">${dots}</div>
                        <div class="progress-text" style="margin-top:8px">
                            <span style="color:var(--gray-500);font-size:12px">
                                ${card.stamps >= p.stampsNeeded
                                    ? 'Next stamp earns your reward!'
                                    : `${p.stampsNeeded - card.stamps} more for ${escHtml(p.rewardName)}`}
                            </span>
                            <span style="color:var(--gray-400);font-size:12px">${card.rewardsEarned} earned</span>
                        </div>
                    </div>`;
            }).join('')}
        </div>`;
}

// ---- Customer: Card Detail ----
async function renderCustomerCardDetail(customerId, businessId) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = loading();
    try {
        const [cards, biz] = await Promise.all([
            api.getCards(customerId),
            api.getBusiness(businessId)
        ]);
        const card = cards.find(c => c.businessId === businessId);
        if (!card || !biz || biz.error) { selectedCardBiz = null; renderApp(); return; }

        const p = biz.program;
        const stamps = Array.from({ length: p.stampsNeeded }, (_, i) => {
            if (i < card.stamps)
                return `<div class="stamp filled" style="animation-delay:${i * 40}ms">${p.stampIcon}</div>`;
            if (i === p.stampsNeeded - 1)
                return `<div class="stamp reward-stamp" style="background:linear-gradient(135deg,${p.cardColor},${p.cardColor}bb)">🎁</div>`;
            return `<div class="stamp empty"></div>`;
        }).join('');

        vc.innerHTML = `
            <div class="card-detail">
                <div class="card-detail-hero" style="background:linear-gradient(135deg,${p.cardColor},${p.cardColor}cc)">
                    <button class="back-btn" onclick="selectedCardBiz=null;renderApp()"
                        style="position:absolute;left:12px;top:12px;color:white">←</button>
                    <div style="font-size:44px;margin-bottom:8px">${p.stampIcon}</div>
                    <h2>${escHtml(biz.name)}</h2>
                    <p>${escHtml(biz.description || 'Loyalty Program')}</p>
                </div>
                <div class="card-detail-body">
                    <div class="reward-banner">
                        <div class="reward-banner-icon">🎁</div>
                        <div class="reward-banner-text">
                            <h4>${escHtml(p.rewardName)}</h4>
                            <p>${escHtml(p.rewardDescription)}</p>
                        </div>
                    </div>
                    ${p.stampQuota ? `
                    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--gray-50);border-radius:var(--radius);margin-bottom:16px;border:1px solid var(--gray-200)">
                        <span style="font-size:18px">🎟️</span>
                        <div>
                            <div style="font-size:11px;font-weight:700;color:var(--gray-400);text-transform:uppercase;letter-spacing:0.5px">How to earn stamps</div>
                            <div style="font-size:13px;font-weight:600;color:var(--gray-700);margin-top:1px">${escHtml(p.stampQuota)}</div>
                        </div>
                    </div>` : ''}
                    <div style="font-size:16px;font-weight:700;margin-bottom:4px">Your Progress</div>
                    <p style="font-size:13px;color:var(--gray-500);margin-bottom:8px">
                        ${card.stamps} of ${p.stampsNeeded} stamps · ${p.stampsNeeded - card.stamps} more to reward
                    </p>
                    <div class="progress-bar mb-16">
                        <div class="progress-fill" style="width:${Math.min(100,(card.stamps/p.stampsNeeded)*100)}%;background:${p.cardColor}"></div>
                    </div>
                    <div class="stamps-grid">${stamps}</div>
                    <div class="detail-stats">
                        <div class="stat-card" style="text-align:center"><div class="stat-value">${card.totalVisits}</div><div class="stat-label">Total Visits</div></div>
                        <div class="stat-card" style="text-align:center"><div class="stat-value">${card.rewardsEarned}</div><div class="stat-label">Rewards Earned</div></div>
                        <div class="stat-card" style="text-align:center"><div class="stat-value">${card.stamps}</div><div class="stat-label">Current Stamps</div></div>
                    </div>
                    ${card.lastVisit ? `<p style="text-align:center;margin-top:16px;font-size:12px;color:var(--gray-400)">Last visit: ${relDate(card.lastVisit)}</p>` : ''}
                    ${card.joinedAt  ? `<p style="text-align:center;font-size:12px;color:var(--gray-400)">Member since ${relDate(card.joinedAt)}</p>` : ''}
                </div>
            </div>`;
    } catch (e) {
        showViewError(vc, 'Could not load card details. Is the server running?');
    }
}

// ---- Customer: Scan to Join ----
function renderCustomerScanJoin(customerId) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = `
        <div class="section-header"><h2>Join a Shop</h2><p>Scan a shop's invite QR code</p></div>
        <div class="scanner-container">
            <div class="scanner-box"><div id="qr-reader"></div></div>
            <details class="manual-entry" open>
                <summary>Enter code manually (demo fallback)</summary>
                <div class="manual-entry-form">
                    <input type="text" class="form-input" id="manualJoinCode"
                        placeholder="Paste shop code here…"
                        onkeydown="if(event.key==='Enter') manualJoin()">
                    <button class="btn btn-primary" onclick="manualJoin()">Join</button>
                </div>
            </details>
            <div id="joinResult"></div>
        </div>`;
    startScanner('qr-reader', code => handleJoinScan(code, customerId));
}

function manualJoin() {
    const code = document.getElementById('manualJoinCode').value.trim();
    if (code) handleJoinScan(code, Session.get().customerId);
}

async function handleJoinScan(code, customerId) {
    stopScanner();
    const box = document.querySelector('.scanner-box');
    if (box) box.style.display = 'none';
    const bizId = code.startsWith('STAMPIT_JOIN:') ? code.slice(13) : code;
    const resultEl = document.getElementById('joinResult');
    if (!resultEl) return;
    resultEl.innerHTML = loading('Joining…');
    try {
        const data = await api.join(customerId, bizId);
        if (data.error) {
            resultEl.innerHTML = `
                <div class="scan-result error">
                    <div class="scan-result-icon">❌</div>
                    <h3>Shop Not Found</h3>
                    <p>This code doesn't match any registered shop.</p>
                    <button class="btn btn-secondary mt-16" onclick="renderApp()">Try Again</button>
                </div>`;
            return;
        }
        const biz = await api.getBusiness(bizId);
        resultEl.innerHTML = `
            <div class="scan-result success">
                <div class="scan-result-icon">${data.alreadyMember ? '👋' : '🎉'}</div>
                <h3>${data.alreadyMember ? 'Already a Member!' : 'Welcome!'}</h3>
                <p>${data.alreadyMember
                    ? `You're already in ${escHtml(biz.name)}'s loyalty program`
                    : `You've joined <strong>${escHtml(biz.name)}</strong>!`}</p>
                <p style="margin-top:8px;font-weight:600;color:var(--orange)">
                    Earn ${biz.program.stampsNeeded} stamps → ${escHtml(biz.program.rewardName)}
                </p>
                <button class="btn btn-primary mt-16" onclick="selectedCardBiz='${biz.id}';currentTab=1;renderApp()">
                    View My Card →
                </button>
            </div>`;
    } catch (e) {
        resultEl.innerHTML = `
            <div class="scan-result error">
                <div class="scan-result-icon">⚠️</div>
                <h3>Connection Error</h3>
                <p>Could not reach the server. Is it still running?</p>
                <button class="btn btn-secondary mt-16" onclick="renderApp()">Try Again</button>
            </div>`;
    }
}

// ============================================
// OWNER APP
// ============================================
function renderOwnerApp() {
    const s = Session.get();
    const tabs = [
        { icon: '📊', label: 'Dashboard' },
        { icon: '📷', label: 'Scanner' },
        { icon: '⚙️', label: 'Program' },
        { icon: '📲', label: 'Invite' }
    ];
    appEl().innerHTML = appShell(tabs, 'Customer Mode', loading());
    const views = [
        () => renderOwnerDashboard(s.businessId),
        () => renderOwnerScanner(s.businessId),
        () => renderOwnerProgram(s.businessId),
        () => renderOwnerInviteQR(s.businessId)
    ];
    views[currentTab]();
}

// ---- Owner: Dashboard ----
async function renderOwnerDashboard(businessId) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = loading();
    try {
        const [biz, members] = await Promise.all([
            api.getBusiness(businessId),
            api.getMembers(businessId)
        ]);
        if (!biz || biz.error) { handleSessionExpired('businessId'); return; }

        const totalVisits  = members.reduce((s, c) => s + c.totalVisits, 0);
        const totalRewards = members.reduce((s, c) => s + c.rewardsEarned, 0);
        const activeToday  = members.filter(c => c.lastVisit && (Date.now() - c.lastVisit) < 86400000).length;

        vc.innerHTML = `
            <div class="dashboard">
                <div class="section-header" style="padding:0 0 16px">
                    <h2>${escHtml(biz.name)}</h2>
                    <p style="color:var(--gray-500);font-size:14px">${escHtml(biz.description || 'Loyalty Program Dashboard')}</p>
                </div>
                <div class="stats-grid">
                    <div class="stat-card highlight"><div class="stat-value">${members.length}</div><div class="stat-label">Members</div></div>
                    <div class="stat-card"><div class="stat-value">${totalVisits}</div><div class="stat-label">Total Visits</div></div>
                    <div class="stat-card"><div class="stat-value">${totalRewards}</div><div class="stat-label">Rewards Given</div></div>
                    <div class="stat-card"><div class="stat-value">${activeToday}</div><div class="stat-label">Visited Today</div></div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                    <div style="font-size:16px;font-weight:700">Members</div>
                    ${members.length ? `<span style="font-size:12px;color:var(--gray-400);font-weight:600">${members.length} enrolled</span>` : ''}
                </div>
                ${!members.length ? `
                    <div class="empty-state" style="padding:40px 0">
                        <div class="empty-state-icon">👥</div>
                        <h3>No Members Yet</h3>
                        <p>Share your invite QR code to start enrolling customers</p>
                        <button class="btn btn-primary" onclick="switchTab(3)">Show Invite QR</button>
                    </div>` : `
                    <div class="members-list">
                        ${members.map(card => `
                            <div class="member-item">
                                <div class="member-info">
                                    <div class="member-avatar">${card.customerName.charAt(0).toUpperCase()}</div>
                                    <div>
                                        <div class="member-name">${escHtml(card.customerName)}</div>
                                        <div class="member-meta">${card.totalVisits} visit${card.totalVisits !== 1 ? 's' : ''} · joined ${relDate(card.joinedAt)}</div>
                                    </div>
                                </div>
                                <div style="text-align:right">
                                    <div class="member-stamps">${card.stamps}/${biz.program.stampsNeeded}</div>
                                    <div style="font-size:11px;color:var(--gray-400)">${card.rewardsEarned} reward${card.rewardsEarned !== 1 ? 's' : ''}</div>
                                </div>
                            </div>`).join('')}
                    </div>`}
            </div>`;
    } catch (e) {
        showViewError(vc, 'Could not load dashboard. Is the server running?');
    }
}

// ---- Owner: Scanner ----
function renderOwnerScanner(businessId) {
    window._scanStampCount = 1;
    const vc = document.getElementById('viewContent');
    vc.innerHTML = `
        <div class="section-header"><h2>Stamp a Card</h2><p>Scan a customer's QR code</p></div>
        <div class="stamp-qty-bar">
            <span class="stamp-qty-label">Stamps to give</span>
            <div class="stamp-qty-controls">
                <button class="stamp-qty-btn" onclick="adjustScanCount(-1)">−</button>
                <span class="stamp-qty-val" id="scanStampCount">1</span>
                <button class="stamp-qty-btn" onclick="adjustScanCount(1)">+</button>
            </div>
        </div>
        <div class="scanner-container">
            <div class="scanner-box"><div id="qr-reader"></div></div>
            <details class="manual-entry" open>
                <summary>Enter code manually (demo fallback)</summary>
                <div class="manual-entry-form">
                    <input type="text" class="form-input" id="manualStampCode"
                        placeholder="Paste customer code here…"
                        onkeydown="if(event.key==='Enter') manualStamp()">
                    <button class="btn btn-primary" onclick="manualStamp()">Stamp</button>
                </div>
            </details>
            <div id="stampResult"></div>
        </div>`;
    startScanner('qr-reader', code => handleStampScan(code, businessId));
}

function adjustScanCount(d) {
    window._scanStampCount = Math.max(1, Math.min(20, (window._scanStampCount || 1) + d));
    const el = document.getElementById('scanStampCount');
    if (el) el.textContent = window._scanStampCount;
}

function manualStamp() {
    const code = document.getElementById('manualStampCode').value.trim();
    if (code) handleStampScan(code, Session.get().businessId);
}

async function handleStampScan(code, businessId) {
    stopScanner();
    const count = window._scanStampCount || 1;
    const box = document.querySelector('.scanner-box');
    if (box) box.style.display = 'none';
    const customerId = code.startsWith('STAMPIT_CUSTOMER:') ? code.slice(17) : code;
    const resultEl = document.getElementById('stampResult');
    if (!resultEl) return;
    resultEl.innerHTML = loading('Stamping…');
    try {
        const [data, biz] = await Promise.all([
            api.stamp(customerId, businessId, count),
            api.getBusiness(businessId)
        ]);
        if (data.error) {
            resultEl.innerHTML = `
                <div class="scan-result error">
                    <div class="scan-result-icon">❌</div>
                    <h3>Customer Not Found</h3>
                    <p>${escHtml(data.error)}</p>
                    <button class="btn btn-secondary mt-16" onclick="renderApp()">Scan Again</button>
                </div>`;
            return;
        }
        const { card, rewardEarned, rewardsCount, stampsGiven, customerName } = data;
        const isNew = card.totalVisits <= stampsGiven;
        const stampLabel = stampsGiven > 1 ? `×${stampsGiven} stamps` : '1 stamp';
        if (rewardEarned) {
            resultEl.innerHTML = `
                <div class="scan-result success">
                    <div class="scan-result-icon">🏆</div>
                    <h3>Reward${rewardsCount > 1 ? 's' : ''} Earned!</h3>
                    <p><strong>${escHtml(customerName)}</strong> · ${stampLabel} given</p>
                    <div class="stamp-count">${biz.program.stampIcon} ${escHtml(biz.program.rewardName)}</div>
                    <p style="color:var(--gray-500);margin-top:4px">${rewardsCount > 1 ? `<strong>${rewardsCount}</strong> rewards this scan!` : `Their <strong>${card.rewardsEarned}${ordinal(card.rewardsEarned)}</strong> reward`}</p>
                    <div style="margin-top:16px;padding:12px;background:var(--orange-50);border-radius:var(--radius)">
                        <p style="font-size:13px;font-weight:700;color:var(--orange-dark)">Give them their reward!</p>
                    </div>
                    <button class="btn btn-primary mt-16 btn-full" onclick="renderApp()">Scan Next Customer</button>
                </div>`;
        } else {
            const pct = (card.stamps / biz.program.stampsNeeded) * 100;
            resultEl.innerHTML = `
                <div class="scan-result success">
                    <div class="scan-result-icon">${isNew ? '🎉' : stampsGiven > 1 ? '🌟' : '✅'}</div>
                    <h3>${isNew ? 'New Member!' : stampsGiven > 1 ? `×${stampsGiven} Stamps!` : 'Stamped!'}</h3>
                    <p><strong>${escHtml(customerName)}</strong> · ${stampLabel} given</p>
                    <div class="stamp-count">${card.stamps}<span style="font-size:20px;font-weight:500;color:var(--gray-400)"> / ${biz.program.stampsNeeded}</span></div>
                    <p style="color:var(--gray-500)">stamps on card</p>
                    <div style="margin-top:12px">
                        <div class="progress-bar" style="height:10px">
                            <div class="progress-fill" style="width:${pct}%;background:${biz.program.cardColor}"></div>
                        </div>
                        <p style="font-size:12px;color:var(--gray-400);margin-top:6px;text-align:right">
                            ${biz.program.stampsNeeded - card.stamps} more for ${escHtml(biz.program.rewardName)}
                        </p>
                    </div>
                    <button class="btn btn-primary mt-16 btn-full" onclick="renderApp()">Scan Next Customer</button>
                </div>`;
        }
    } catch (e) {
        resultEl.innerHTML = `
            <div class="scan-result error">
                <div class="scan-result-icon">⚠️</div>
                <h3>Connection Error</h3>
                <p>Could not reach the server. Is it still running?</p>
                <button class="btn btn-secondary mt-16" onclick="renderApp()">Try Again</button>
            </div>`;
    }
}

// ---- Owner: Program Settings ----
async function renderOwnerProgram(businessId) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = loading();
    try {
        const biz = await api.getBusiness(businessId);
        if (!biz || biz.error) { handleSessionExpired('businessId'); return; }
        const p = biz.program;
        window._ep = { stampCount: p.stampsNeeded, icon: p.stampIcon, color: p.cardColor };

        vc.innerHTML = `
            <div class="settings-form">
                <div class="section-header" style="padding:0 0 20px"><h2>Program Settings</h2><p>Customize your loyalty program</p></div>
                <div class="settings-section">
                    <h3>Business Info</h3>
                    <div class="form-group">
                        <label class="form-label">Business Name</label>
                        <input type="text" class="form-input" id="epBizName" value="${escHtml(biz.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Description</label>
                        <textarea class="form-input" id="epBizDesc">${escHtml(biz.description || '')}</textarea>
                    </div>
                </div>
                <div class="settings-section">
                    <h3>Reward Settings</h3>
                    <div class="form-group">
                        <label class="form-label">Stamps Needed for Reward</label>
                        <div class="stamp-count-selector">
                            <button onclick="epAdjust(-1)">−</button>
                            <span class="count" id="epStampCount">${p.stampsNeeded}</span>
                            <button onclick="epAdjust(1)">+</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Reward Name</label>
                        <input type="text" class="form-input" id="epRewardName" value="${escHtml(p.rewardName)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Reward Description</label>
                        <input type="text" class="form-input" id="epRewardDesc" value="${escHtml(p.rewardDescription)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Stamp Quota</label>
                        <input type="text" class="form-input" id="epStampQuota" value="${escHtml(p.stampQuota || '')}" placeholder="e.g. 1 stamp per 8 CHF spent">
                        <p style="font-size:12px;color:var(--gray-400);margin-top:5px">Shown to customers so they know how to earn stamps.</p>
                    </div>
                </div>
                <div class="settings-section">
                    <h3>Appearance</h3>
                    <div class="form-group">
                        <label class="form-label">Stamp Icon</label>
                        <div class="icon-picker">
                            ${STAMP_ICONS.map(icon => `
                                <button class="icon-option ${icon === p.stampIcon ? 'selected' : ''}"
                                    onclick="epSelectIcon(this,'${icon}')">${icon}</button>
                            `).join('')}
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Card Color</label>
                        <div class="color-picker">
                            ${CARD_COLORS.map(c => `
                                <div class="color-option ${c === p.cardColor ? 'selected' : ''}"
                                    style="background:${c}" onclick="epSelectColor(this,'${c}')"></div>
                            `).join('')}
                        </div>
                    </div>
                </div>
                <button class="btn btn-primary btn-lg btn-full" id="saveBtn" onclick="saveProgram('${businessId}')">
                    Save Changes
                </button>
            </div>`;
    } catch (e) {
        showViewError(vc, 'Could not load settings. Is the server running?');
    }
}

function epAdjust(d) { window._ep.stampCount = Math.max(3, Math.min(20, window._ep.stampCount + d)); document.getElementById('epStampCount').textContent = window._ep.stampCount; }
function epSelectIcon(el, icon) { document.querySelectorAll('.settings-form .icon-option').forEach(e => e.classList.remove('selected')); el.classList.add('selected'); window._ep.icon = icon; }
function epSelectColor(el, color) { document.querySelectorAll('.settings-form .color-option').forEach(e => e.classList.remove('selected')); el.classList.add('selected'); window._ep.color = color; }

async function saveProgram(businessId) {
    try {
        const biz = await api.getBusiness(businessId);
        if (!biz || biz.error) { showToast('Could not load business data'); return; }
        const ep = window._ep;
        biz.name                      = document.getElementById('epBizName').value.trim() || biz.name;
        biz.description               = document.getElementById('epBizDesc').value.trim();
        biz.program.stampsNeeded      = ep.stampCount;
        biz.program.rewardName        = document.getElementById('epRewardName').value.trim() || biz.program.rewardName;
        biz.program.rewardDescription = document.getElementById('epRewardDesc').value.trim() || biz.program.rewardDescription;
        biz.program.stampQuota        = document.getElementById('epStampQuota').value.trim();
        biz.program.stampIcon         = ep.icon;
        biz.program.cardColor         = ep.color;
        await api.registerBusiness(biz);
        Session.set({ businessName: biz.name });
        const btn = document.getElementById('saveBtn');
        if (btn) { btn.textContent = '✓ Saved!'; btn.style.background = '#22C55E'; setTimeout(() => { btn.textContent = 'Save Changes'; btn.style.background = ''; }, 2000); }
        showToast('Program saved!');
    } catch (e) { showToast('Save failed — is the server running?'); }
}

// ---- Owner: Invite QR ----
async function renderOwnerInviteQR(businessId) {
    const vc = document.getElementById('viewContent');
    vc.innerHTML = loading();
    try {
        const biz = await api.getBusiness(businessId);
        if (!biz || biz.error) { handleSessionExpired('businessId'); return; }
        const p = biz.program;
        vc.innerHTML = `
            <div class="qr-container">
                <div class="qr-card" style="border-color:${p.cardColor}55">
                    <div style="font-size:36px;margin-bottom:8px">${p.stampIcon}</div>
                    <h3>${escHtml(biz.name)}</h3>
                    <p class="qr-subtitle">Customers scan once to join</p>
                    <div class="qr-wrapper" id="businessQR"></div>
                    <div class="qr-id" onclick="copyCode('STAMPIT_JOIN:${biz.id}')" title="Tap to copy">
                        ${biz.id.substring(0, 8).toUpperCase()} · tap to copy
                    </div>
                </div>
                <div style="margin-top:24px;width:100%;max-width:300px">
                    <div style="background:var(--orange-50);border-radius:var(--radius);padding:14px 16px;margin-bottom:12px">
                        <p style="font-size:13px;font-weight:700;color:var(--orange-dark);margin-bottom:2px">${p.stampIcon} ${escHtml(p.rewardName)}</p>
                        <p style="font-size:13px;color:var(--gray-500)">After ${p.stampsNeeded} stamps</p>
                    </div>
                    <p style="font-size:13px;color:var(--gray-500);text-align:center;line-height:1.5">Display this at your counter — customers scan once to join.</p>
                    <div style="margin-top:12px;background:var(--gray-50);border-radius:var(--radius);padding:12px 16px">
                        <p style="font-size:11px;color:var(--gray-400);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Full code (manual entry fallback)</p>
                        <p style="font-size:12px;color:var(--gray-600);font-family:monospace;word-break:break-all;cursor:pointer"
                           onclick="copyCode('STAMPIT_JOIN:${biz.id}')">STAMPIT_JOIN:${biz.id}</p>
                    </div>
                </div>
            </div>`;
        makeQR('businessQR', `STAMPIT_JOIN:${biz.id}`);
    } catch (e) {
        showViewError(vc, 'Could not load invite QR. Is the server running?');
    }
}

// ============================================
// QR CODE
// ============================================
function makeQR(elementId, text) {
    setTimeout(() => {
        const el = document.getElementById(elementId);
        if (!el) return;
        new QRCode(el, {
            text, width: 200, height: 200,
            colorDark: '#18181B', colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        setTimeout(() => {
            const canvas = el.querySelector('canvas');
            if (canvas) canvas.style.display = 'none';
        }, 100);
    }, 50);
}

function copyCode(code) {
    navigator.clipboard.writeText(code)
        .then(() => showToast('Code copied!'))
        .catch(() => showToast('Tap the code text to copy'));
}

// ============================================
// CAMERA SCANNER
// ============================================
function startScanner(elementId, onSuccess) {
    let fired = false;
    setTimeout(() => {
        try {
            const scanner = new Html5Qrcode(elementId);
            activeScanner = scanner;
            scanner.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 240, height: 240 } },
                text => {
                    if (fired) return;
                    fired = true;
                    onSuccess(text);
                },
                () => {}
            ).catch(() => {
                const d = document.querySelector('.manual-entry');
                if (d) d.open = true;
            });
        } catch (e) {}
    }, 120);
}

function stopScanner() {
    if (activeScanner) {
        try { activeScanner.stop().catch(() => {}); } catch (e) {}
        activeScanner = null;
    }
}

// ============================================
// INIT
// ============================================
window.addEventListener('DOMContentLoaded', renderApp);
