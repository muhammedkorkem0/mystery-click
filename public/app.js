// The Mystery Click Client-Side Logic

// Sound Synthesizer via Web Audio API (No external assets required!)
class SoundManager {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playClick() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    // Crisp mechanical switch sound
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(450, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.06);

    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.06);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + 0.06);
  }

  playCoin() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    // Mario coin style double chime
    const playNote = (freq, start, duration) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(start);
      osc.stop(start + duration);
    };

    const now = this.ctx.currentTime;
    playNote(987.77, now, 0.08); // B5
    playNote(1318.51, now + 0.08, 0.25); // E6
  }

  playJackpot() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    // Triumph chord arpeggio
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
    const now = this.ctx.currentTime;
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.1);
      gain.gain.setValueAtTime(0.3, now + idx * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.1 + 0.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + idx * 0.1);
      osc.stop(now + idx * 0.1 + 0.4);
    });
  }
}

const sounds = new SoundManager();

// App State
const state = {
  user: null, // { email, nickname, balance, totalClicks }
  batchSize: 1, // 1, 5, 10
  selectedPackage: 10,
  ws: null,
  isClicking: false
};

// DOM Elements
const soundToggleBtn = document.getElementById('soundToggleBtn');
const soundIcon = document.getElementById('soundIcon');
const openLoginModalBtn = document.getElementById('openLoginModalBtn');
const userBadgeArea = document.getElementById('userBadgeArea');
const balanceContainer = document.getElementById('balanceContainer');
const userBalanceText = document.getElementById('userBalanceText');
const openBuyModalBtn = document.getElementById('openBuyModalBtn');

const theMysteryButton = document.getElementById('theMysteryButton');
const rippleLayer = document.getElementById('rippleLayer');
const liveActivityList = document.getElementById('liveActivityList');
const batchButtons = document.querySelectorAll('.batch-btn');

// Modals
const loginModal = document.getElementById('loginModal');
const loginForm = document.getElementById('loginForm');
const loginEmailInput = document.getElementById('loginEmail');
const loginNicknameInput = document.getElementById('loginNickname');
const closeLoginModalBtn = document.getElementById('closeLoginModalBtn');

const buyModal = document.getElementById('buyModal');
const closeBuyModalBtn = document.getElementById('closeBuyModalBtn');
const confirmBuyBtn = document.getElementById('confirmBuyBtn');
const buyButtonText = document.getElementById('buyButtonText');
const packageRadios = document.querySelectorAll('input[name="clickPackage"]');

const winnerModal = document.getElementById('winnerModal');
const winnerNick = document.getElementById('winnerNick');
const winnerEmail = document.getElementById('winnerEmail');
const closeWinnerModalBtn = document.getElementById('closeWinnerModalBtn');

const rulesModal = document.getElementById('rulesModal');
const openRulesBtn = document.getElementById('openRulesBtn');
const closeRulesModalBtn = document.getElementById('closeRulesModalBtn');
const openRulesBtnNav = document.getElementById('openRulesBtnNav');

// Invite Modal & Toast Elements
const inviteModal = document.getElementById('inviteModal');
const closeInviteModalBtn = document.getElementById('closeInviteModalBtn');
const openInviteBtnNav = document.getElementById('openInviteBtnNav');
const openInviteBannerBtn = document.getElementById('openInviteBannerBtn');
const inviteLinkInput = document.getElementById('inviteLinkInput');
const copyInviteLinkBtn = document.getElementById('copyInviteLinkBtn');
const copyBtnText = document.getElementById('copyBtnText');
const shareWhatsApp = document.getElementById('shareWhatsApp');
const shareTelegram = document.getElementById('shareTelegram');
const shareTwitter = document.getElementById('shareTwitter');
const inviteCountText = document.getElementById('inviteCountText');
const inviteBonusClicksText = document.getElementById('inviteBonusClicksText');
const toastContainer = document.getElementById('toastContainer');

// Sound Toggle
soundToggleBtn.addEventListener('click', () => {
  sounds.enabled = !sounds.enabled;
  if (sounds.enabled) {
    sounds.init();
    soundIcon.className = 'fa-solid fa-volume-high text-sm';
    soundToggleBtn.classList.remove('opacity-60');
  } else {
    soundIcon.className = 'fa-solid fa-volume-xmark text-sm';
    soundToggleBtn.classList.add('opacity-60');
  }
});

// Batch Click Selection
batchButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    batchButtons.forEach(b => {
      b.classList.remove('bg-amber-500', 'text-black', 'active');
      b.classList.add('text-slate-400');
    });
    btn.classList.add('bg-amber-500', 'text-black', 'active');
    btn.classList.remove('text-slate-400');
    state.batchSize = parseInt(btn.dataset.batch, 10);
  });
});

// Connect WebSocket & Polling Fallback (for Vercel support)
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'INIT_STATE') {
          if (data.recentActivity && data.recentActivity.length > 0) {
            liveActivityList.innerHTML = '';
            data.recentActivity.forEach(act => addFeedItem(act, false));
          }
          if (data.winner) {
            showWinner(data.winner);
          }
        } else if (data.type === 'CLICK_ACTIVITY') {
          addFeedItem(data.activity, true);
        } else if (data.type === 'WINNER_ANNOUNCEMENT') {
          showWinner(data.winner);
        }
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    state.ws.onerror = () => {
      // If WebSocket fails (e.g. on Vercel), start HTTP polling
      startPolling();
    };

    state.ws.onclose = () => {
      startPolling();
    };
  } catch (e) {
    startPolling();
  }
}

// Polling fallback every 1.5s for Vercel
let pollingActive = false;
function startPolling() {
  if (pollingActive) return;
  pollingActive = true;
  console.log('⚡ Canlı akış HTTP Polling moduna geçti (Vercel desteği).');

  // Initial fetch
  fetchFeed();
  setInterval(fetchFeed, 1800);
}

let lastSeenTime = 0;
async function fetchFeed() {
  try {
    const res = await fetch('/api/feed');
    if (!res.ok) return;
    const data = await res.json();
    if (data.recentActivity && data.recentActivity.length > 0) {
      const newest = data.recentActivity[0];
      if (newest.time && newest.time > lastSeenTime) {
        lastSeenTime = newest.time;
        // Only update if placeholder is still there or if new items arrived
        if (liveActivityList.querySelector('.italic')) {
          liveActivityList.innerHTML = '';
          data.recentActivity.forEach(act => addFeedItem(act, false));
        } else {
          addFeedItem(newest, true);
        }
      }
    }
    if (data.winner) {
      showWinner(data.winner);
    }
  } catch (err) {
    // Ignore transient network errors
  }
}

// Add Item to Live Activity Feed ("@kullanici X click yaptı!")
function addFeedItem(act, isNew = false) {
  // If list still has default placeholder, clear it
  if (liveActivityList.querySelector('.italic')) {
    liveActivityList.innerHTML = '';
  }

  const item = document.createElement('div');
  item.className = `feed-item flex items-center justify-between p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 text-xs ${
    isNew ? 'border-amber-500/40 bg-amber-500/5' : ''
  }`;

  const clickBadgeColor = act.clicks >= 10 ? 'text-rose-400 bg-rose-500/10 border-rose-500/30' :
                         act.clicks >= 5 ? 'text-amber-400 bg-amber-500/10 border-amber-500/30' :
                         'text-cyan-400 bg-cyan-500/10 border-cyan-500/30';

  const timeAgo = formatTimeAgo(act.time || Date.now());
  const clickLabel = act.clicks > 1 ? 'clicks' : 'click';

  item.innerHTML = `
    <div class="flex items-center gap-2.5 min-w-0">
      <div class="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-slate-300 font-black text-xs shrink-0">
        ${act.nickname.charAt(0).toUpperCase()}
      </div>
      <div class="truncate">
        <span class="font-bold text-white">@${escapeHtml(act.nickname)}</span>
        <span class="text-slate-400 ml-1">just landed</span>
        <span class="font-extrabold text-amber-300 ml-1">${act.clicks} ${clickLabel}!</span>
      </div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <span class="px-2 py-0.5 rounded-md border text-[10px] font-bold ${clickBadgeColor}">
        +${act.clicks} ${act.clicks > 1 ? 'Clicks' : 'Click'}
      </span>
      <span class="text-[10px] text-slate-400 hidden sm:inline">${timeAgo}</span>
    </div>
  `;

  liveActivityList.prepend(item);

  // Keep list max 40 items
  while (liveActivityList.children.length > 40) {
    liveActivityList.removeChild(liveActivityList.lastChild);
  }
}

function formatTimeAgo(ts) {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ago`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

// Check stored login session
function checkStoredUser() {
  const stored = localStorage.getItem('mystery_user');
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      loginUser(parsed.email, parsed.nickname, false);
    } catch (e) {
      localStorage.removeItem('mystery_user');
    }
  }
}

// User Login Request
async function loginUser(email, nickname, showNotice = true) {
  try {
    const ref = localStorage.getItem('mystery_ref') || '';
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nickname, ref })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Sign in failed.', 'error');
      return;
    }

    state.user = data.user;
    localStorage.setItem('mystery_user', JSON.stringify({
      email: state.user.email,
      nickname: state.user.nickname,
      token: state.user.token
    }));

    updateUserUI();
    loginModal.classList.add('hidden');

    // Free Welcome Clicks & Viral Referral Rewards Handling
    if (data.user && data.user.isNewUser) {
      localStorage.removeItem('mystery_ref'); // Ref consumed
      if (data.user.referredBy) {
        sounds.playJackpot();
        confetti({ particleCount: 75, spread: 70, origin: { y: 0.6 } });
        showToast(`🎉 Welcome @${state.user.nickname}! You earned 2 FREE CLICKS for using @${data.user.referredBy}'s invite link!`, 'gift', 6000);
      } else {
        sounds.playCoin();
        confetti({ particleCount: 45, spread: 55, origin: { y: 0.6 } });
        showToast(`🎁 Welcome @${state.user.nickname}! You received 1 FREE CLICK to test the Mystery Button!`, 'gift', 5000);
      }
    } else if (showNotice && state.user.balance === 0) {
      // Prompt to buy clicks
      openBuyModal();
    }
  } catch (err) {
    console.error('Login error:', err);
    showToast('Connection error occurred. Please try again.', 'error');
  }
}

// Update Header User UI
function updateUserUI() {
  if (state.user) {
    userBadgeArea.innerHTML = `
      <div class="flex items-center gap-2 bg-slate-800/80 border border-slate-700/80 pl-3 pr-1.5 py-1.5 rounded-xl">
        <div class="text-left">
          <div class="text-xs font-bold text-white flex items-center gap-1">
            <i class="fa-solid fa-user-check text-[10px] text-emerald-400"></i>
            @${escapeHtml(state.user.nickname)}
          </div>
          <div class="text-[10px] text-slate-400 truncate max-w-[110px]">${state.user.email}</div>
        </div>
        <button id="logoutBtn" class="p-1.5 text-slate-400 hover:text-rose-400 transition-colors" title="Sign Out">
          <i class="fa-solid fa-arrow-right-from-bracket text-xs"></i>
        </button>
      </div>
    `;

    document.getElementById('logoutBtn').addEventListener('click', () => {
      localStorage.removeItem('mystery_user');
      state.user = null;
      updateUserUI();
    });

    balanceContainer.classList.remove('hidden');
    userBalanceText.textContent = state.user.balance;

    if (inviteCountText && state.user.referralCount !== undefined) {
      inviteCountText.textContent = state.user.referralCount;
    }
    if (inviteBonusClicksText && state.user.referralCount !== undefined) {
      inviteBonusClicksText.textContent = state.user.referralCount * 2;
    }
  } else {
    userBadgeArea.innerHTML = `
      <button id="openLoginModalBtn" class="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-2 active:scale-95">
        <i class="fa-brands fa-google"></i>
        <span>Sign In</span>
      </button>
    `;
    document.getElementById('openLoginModalBtn').addEventListener('click', () => {
      loginModal.classList.remove('hidden');
    });

    balanceContainer.classList.add('hidden');
  }
}

// Click Mystery Button
theMysteryButton.addEventListener('click', async (e) => {
  if (!state.user) {
    loginModal.classList.remove('hidden');
    return;
  }

  const clicksToUse = state.batchSize;

  if (state.user.balance < clicksToUse) {
    openBuyModal();
    return;
  }

  if (state.isClicking) return;
  state.isClicking = true;

  // Sound and Visual Ripple Effect
  sounds.playClick();
  createRipple(e);

  // Button pressed styling
  theMysteryButton.classList.add('pressed');
  setTimeout(() => theMysteryButton.classList.remove('pressed'), 120);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.user.token) {
      headers['Authorization'] = `Bearer ${state.user.token}`;
    }

    const res = await fetch('/api/click', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: state.user.email,
        count: clicksToUse,
        token: state.user.token
      })
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        alert('Your session has expired or is invalid. For your security, please sign in again.');
        localStorage.removeItem('mystery_user');
        state.user = null;
        updateUserUI();
        loginModal.classList.remove('hidden');
        return;
      }
      alert(data.error || 'Action could not be completed.');
      return;
    }

    state.user.balance = data.remainingBalance;
    state.user.totalClicks = data.totalUserClicks;
    userBalanceText.textContent = state.user.balance;

    if (data.winner) {
      showWinner(data.winner);
    }
  } catch (err) {
    console.error('Click error:', err);
  } finally {
    state.isClicking = false;
  }
});

// Ripple Effect Generator
function createRipple(e) {
  const rect = theMysteryButton.getBoundingClientRect();
  const circle = document.createElement('span');
  const diameter = Math.max(rect.width, rect.height);
  const radius = diameter / 2;

  const clientX = e.clientX || rect.left + radius;
  const clientY = e.clientY || rect.top + radius;

  circle.style.width = circle.style.height = `${diameter}px`;
  circle.style.left = `${clientX - rect.left - radius}px`;
  circle.style.top = `${clientY - rect.top - radius}px`;
  circle.classList.add('ripple');

  rippleLayer.appendChild(circle);
  setTimeout(() => circle.remove(), 600);
}

// Buy Clicks
function openBuyModal() {
  buyModal.classList.remove('hidden');
}

packageRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    state.selectedPackage = parseInt(e.target.value, 10);
    const price = (state.selectedPackage * 0.10).toFixed(2);
    buyButtonText.textContent = `Buy ${state.selectedPackage} Clicks ($${price})`;
  });
});

confirmBuyBtn.addEventListener('click', async () => {
  if (!state.user) {
    buyModal.classList.add('hidden');
    loginModal.classList.remove('hidden');
    return;
  }

  confirmBuyBtn.disabled = true;
  confirmBuyBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing Checkout...`;

  try {
    const res = await fetch('/api/clicks/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: state.user.email,
        packageAmount: state.selectedPackage
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to initiate checkout.');
      return;
    }

    // 1. If Crypto Checkout URL is returned
    if (data.checkoutUrl) {
      buyModal.classList.add('hidden');
      window.location.href = data.checkoutUrl;
      return;
    }

    // 2. If running in simulation / demo mode (before API keys are set)
    state.user.balance = data.newBalance;
    userBalanceText.textContent = state.user.balance;

    sounds.playCoin();
    buyModal.classList.add('hidden');

    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.7 }
    });

  } catch (err) {
    console.error('Buy error:', err);
    alert('An error occurred during payment.');
  } finally {
    confirmBuyBtn.disabled = false;
    const price = (state.selectedPackage * 0.10).toFixed(2);
    confirmBuyBtn.innerHTML = `<i class="fa-solid fa-check"></i> <span id="buyButtonText">Buy ${state.selectedPackage} Clicks ($${price})</span>`;
  }
});

// Winner Celebration Screen (5 Millionth Click Reached!)
function showWinner(winner) {
  sounds.playJackpot();
  winnerNick.textContent = `@${winner.nickname}`;
  winnerEmail.textContent = winner.email;
  winnerModal.classList.remove('hidden');

  // Devasa Konfeti Yağmuru
  const duration = 5 * 1000;
  const animationEnd = Date.now() + duration;

  const frame = () => {
    confetti({
      particleCount: 5,
      angle: 60,
      spread: 55,
      origin: { x: 0 }
    });
    confetti({
      particleCount: 5,
      angle: 120,
      spread: 55,
      origin: { x: 1 }
    });

    if (Date.now() < animationEnd) {
      requestAnimationFrame(frame);
    }
  };
  frame();
}

// Form Submit & Modal Buttons
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = loginEmailInput.value;
  const nick = loginNicknameInput.value;
  loginUser(email, nick, true);
});

closeLoginModalBtn.addEventListener('click', () => loginModal.classList.add('hidden'));
closeBuyModalBtn.addEventListener('click', () => buyModal.classList.add('hidden'));
openBuyModalBtn.addEventListener('click', openBuyModal);
closeWinnerModalBtn.addEventListener('click', () => winnerModal.classList.add('hidden'));

openRulesBtn.addEventListener('click', () => rulesModal.classList.remove('hidden'));
closeRulesModalBtn.addEventListener('click', () => rulesModal.classList.add('hidden'));
if (openRulesBtnNav) {
  openRulesBtnNav.addEventListener('click', () => rulesModal.classList.remove('hidden'));
}

// Floating Toast Notification
function showToast(message, type = 'info', duration = 4500) {
  if (!toastContainer) return;

  const toast = document.createElement('div');
  const borderColors = {
    success: 'border-emerald-500/50 bg-slate-900/95 text-emerald-300 shadow-emerald-500/20',
    gift: 'border-purple-500/50 bg-slate-900/95 text-purple-200 shadow-purple-500/20',
    info: 'border-cyan-500/50 bg-slate-900/95 text-cyan-300 shadow-cyan-500/20',
    error: 'border-rose-500/50 bg-slate-900/95 text-rose-300 shadow-rose-500/20'
  };
  const icons = {
    success: 'fa-solid fa-circle-check text-emerald-400',
    gift: 'fa-solid fa-gift text-pink-400',
    info: 'fa-solid fa-circle-info text-cyan-400',
    error: 'fa-solid fa-circle-exclamation text-rose-400'
  };

  const theme = borderColors[type] || borderColors.info;
  const icon = icons[type] || icons.info;

  toast.className = `flex items-center gap-2.5 px-4 py-3 rounded-2xl border shadow-xl backdrop-blur-md text-xs font-semibold pointer-events-auto transform transition-all duration-300 translate-y-[-10px] opacity-0 ${theme}`;
  toast.innerHTML = `
    <i class="${icon} text-base shrink-0"></i>
    <span class="leading-snug">${message}</span>
  `;

  toastContainer.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-[-10px]', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
  });

  // Auto remove
  setTimeout(() => {
    toast.classList.remove('translate-y-0', 'opacity-100');
    toast.classList.add('translate-y-[-10px]', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Check & Save Referral Code from URL
function captureReferralCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const refParam = params.get('ref');
    if (refParam) {
      const cleanRef = refParam.trim().slice(0, 30);
      localStorage.setItem('mystery_ref', cleanRef);

      // If user is not logged in, announce invite reward with a toast!
      const stored = localStorage.getItem('mystery_user');
      if (!stored && !state.user) {
        setTimeout(() => {
          showToast(`🎁 You were invited by @${escapeHtml(cleanRef)}! Sign in now to receive 2 FREE CLICKS!`, 'gift', 7000);
        }, 800);
      }
    }
  } catch (err) {
    console.warn('Could not parse referral param:', err);
  }
}

// Open Invite Modal & Generate Personal Links
function openInviteModal() {
  if (!state.user) {
    loginModal.classList.remove('hidden');
    showToast('Please sign in first to access your personal invite link!', 'info', 4000);
    return;
  }

  const origin = window.location.origin;
  const inviteUrl = `${origin}/?ref=${encodeURIComponent(state.user.nickname)}`;
  if (inviteLinkInput) inviteLinkInput.value = inviteUrl;

  const shareText = `Try "The Mystery Click" — 5,000,000 secret clicks. One lucky clicker wins everything! Join with my link to get +2 FREE CLICKS:`;
  if (shareWhatsApp) {
    shareWhatsApp.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText + ' ' + inviteUrl)}`;
  }
  if (shareTelegram) {
    shareTelegram.href = `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(shareText)}`;
  }
  if (shareTwitter) {
    shareTwitter.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(inviteUrl)}`;
  }

  if (inviteCountText) inviteCountText.textContent = state.user.referralCount || 0;
  if (inviteBonusClicksText) inviteBonusClicksText.textContent = (state.user.referralCount || 0) * 2;

  if (inviteModal) inviteModal.classList.remove('hidden');
}

// Copy Invite Link Button Logic
if (copyInviteLinkBtn) {
  copyInviteLinkBtn.addEventListener('click', async () => {
    if (!inviteLinkInput) return;
    try {
      await navigator.clipboard.writeText(inviteLinkInput.value);
    } catch (e) {
      inviteLinkInput.select();
      document.execCommand('copy');
    }
    if (copyBtnText) copyBtnText.textContent = 'Copied!';
    copyInviteLinkBtn.classList.remove('bg-purple-600', 'hover:bg-purple-500');
    copyInviteLinkBtn.classList.add('bg-emerald-600', 'hover:bg-emerald-500');
    showToast('Invite link copied to clipboard! Share it with your friends.', 'success', 3000);

    setTimeout(() => {
      if (copyBtnText) copyBtnText.textContent = 'Copy';
      copyInviteLinkBtn.classList.remove('bg-emerald-600', 'hover:bg-emerald-500');
      copyInviteLinkBtn.classList.add('bg-purple-600', 'hover:bg-purple-500');
    }, 2000);
  });
}

// Wire Invite Modal Buttons
if (openInviteBtnNav) openInviteBtnNav.addEventListener('click', openInviteModal);
if (openInviteBannerBtn) openInviteBannerBtn.addEventListener('click', openInviteModal);
if (closeInviteModalBtn) closeInviteModalBtn.addEventListener('click', () => inviteModal.classList.add('hidden'));

// Open Login Modal (Delegated so it works on initial load and after re-renders)
document.addEventListener('click', (e) => {
  const loginTrigger = e.target.closest('#openLoginModalBtn');
  if (loginTrigger) {
    loginModal.classList.remove('hidden');
    if (loginEmailInput) loginEmailInput.focus();
  }
});

// Close modals when clicking backdrop
[loginModal, buyModal, rulesModal, winnerModal, inviteModal].forEach(modal => {
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }
});

// Live Elapsed Time Counter (Starts 11 Months 3 Days ago)
function initElapsedTimeCounter() {
  const el = document.getElementById('elapsedTimeText');
  if (!el) return;

  const startDate = new Date('2025-10-01T08:14:22');

  function tick() {
    const now = new Date();
    let years = now.getFullYear() - startDate.getFullYear();
    let months = now.getMonth() - startDate.getMonth() + (years * 12);
    let days = now.getDate() - startDate.getDate();
    let hours = now.getHours() - startDate.getHours();
    let minutes = now.getMinutes() - startDate.getMinutes();
    let seconds = now.getSeconds() - startDate.getSeconds();

    if (seconds < 0) { seconds += 60; minutes--; }
    if (minutes < 0) { minutes += 60; hours--; }
    if (hours < 0) { hours += 24; days--; }
    if (days < 0) {
      const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      days += prevMonth.getDate();
      months--;
    }

    el.textContent = `${months} Months ${days} Days ${hours}h ${minutes}m ${seconds}s`;
  }

  tick();
  setInterval(tick, 1000);
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  initElapsedTimeCounter();
  initWebSocket();
  checkStoredUser();
  updateUserUI();
  captureReferralCode();
});
