(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let state = null;
  let skew = 0; // server clock minus this device's clock, so countdowns match the server
  let tab = 'live';
  let shownId = null;
  let revokeArm = null;
  let offline = false;
  let expiryRefreshQueued = false;

  const END_TEXT = {
    'time-up': 'Time used up',
    unredeemed: 'Never used',
    'missing-on-router': 'Removed on the router',
    revoked: 'Revoked',
  };

  // ---- helpers -------------------------------------------------------------------------

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-QRWifi': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  const serverNow = () => Date.now() + skew;

  function durLabel(min) {
    if (min % 60 === 0) {
      const hrs = min / 60;
      return hrs === 1 ? '1 hour' : `${hrs} hours`;
    }
    if (min > 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
    return `${min} minutes`;
  }

  function leftText(sec) {
    if (sec <= 0) return 'Time is up';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m left`;
    if (mins > 0) return `${mins}m left`;
    return `${sec}s left`;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
  }

  const isLive = (v) => v.status === 'unused' || v.status === 'active';

  function statusText(v) {
    if (v.status === 'unused') return 'Not used yet';
    if (v.status === 'active') return 'In use';
    return END_TEXT[v.endReason] || 'Ended';
  }

  const badgeKey = (v) => (v.status === 'expired' ? 'ended' : v.status);

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Not available on plain http pages; fall back to the old way.
    }
    const area = h('textarea', { readonly: true, class: 'offscreen', 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  // ---- header -------------------------------------------------------------------------

  function renderPill() {
    const el = $('router-pill');
    let st = 'checking';
    let text = 'Checking router…';
    let title = '';
    if (offline) {
      st = 'down';
      text = "Can't reach this page";
    } else if (state && state.router.mode === 'mock') {
      st = 'demo';
      text = 'Demo mode: no real router';
    } else if (state && state.router.ok === false) {
      st = 'down';
      text = 'Router not reachable';
      title = state.router.lastError || '';
    } else if (state && state.router.ok === true) {
      st = 'ok';
      text = 'Router connected';
    }
    el.dataset.state = st;
    el.textContent = text;
    el.title = title;
  }

  // ---- ticket -------------------------------------------------------------------------

  function qrMarkup(url, title) {
    return window.QR.toSvg(url, { ecl: 'M', title });
  }

  function buildTicket(box, v) {
    const wifi = state.branding.wifiName;
    const qr = h('div', { class: 'ticket-qr' });
    qr.innerHTML = qrMarkup(v.loginUrl, `QR code for voucher ${v.code}`);

    box.replaceChildren(
      h('div', { class: 'ticket-head' },
        h('span', { class: 'ticket-cafe', text: state.branding.cafeName }),
        h('span', { class: 'ticket-kind', text: 'Wi-Fi voucher' })),
      qr,
      h('div', { class: 'tear', 'aria-hidden': 'true' }),
      h('p', { class: 'ticket-code', text: v.code }),
      h('p', { class: 'ticket-steps', text: `Join “${wifi}”, then scan the QR code with your phone camera. Or type the code on the login page.` }),
      h('p', { class: 'ticket-status', id: 'ticket-status' }),
      h('div', { class: 'ticket-actions' },
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Print slip', onclick: () => printSlip(v.id) }),
        h('button', {
          class: 'btn btn-quiet', type: 'button', text: 'Copy link',
          onclick: async () => toast((await copyText(v.loginUrl)) ? 'Link copied' : "Couldn't copy the link"),
        }),
        h('button', { class: 'btn btn-quiet', type: 'button', text: 'Done', onclick: () => { shownId = null; renderTicket(); } })),
    );
  }

  function renderTicket() {
    const box = $('ticket');
    const empty = $('ticket-empty');
    const v = state && shownId ? state.vouchers.find((x) => x.id === shownId) : null;
    if (!v || !v.loginUrl) {
      box.hidden = true;
      box.dataset.id = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    box.hidden = false;
    if (box.dataset.id !== v.id) {
      buildTicket(box, v);
      box.dataset.id = v.id;
    }
    const status = $('ticket-status');
    if (v.status === 'active') {
      status.dataset.expires = String(v.expiresAt);
      status.dataset.prefix = 'In use. ';
      status.textContent = `In use. ${leftText(Math.floor((v.expiresAt - serverNow()) / 1000))}`;
    } else {
      delete status.dataset.expires;
      delete status.dataset.prefix;
      status.textContent = `Works for ${durLabel(v.durationMinutes)} from the first connection. Use it within ${state.voucherConfig.unusedExpiryHours} hours.`;
    }
  }

  function printSlip(id) {
    const v = state && state.vouchers.find((x) => x.id === id);
    if (!v || !v.loginUrl) return;
    const qr = h('div', { class: 'slip-qr' });
    qr.innerHTML = qrMarkup(v.loginUrl, `QR code for voucher ${v.code}`);
    $('slip').replaceChildren(
      h('p', { class: 'slip-cafe', text: state.branding.cafeName }),
      h('p', { class: 'slip-title', text: 'Free Wi-Fi voucher' }),
      qr,
      h('p', { class: 'slip-code', text: v.code }),
      h('ol', { class: 'slip-steps' },
        h('li', { text: `Join the Wi-Fi “${state.branding.wifiName}”.` }),
        h('li', { text: 'Scan the QR code with your phone camera.' }),
        h('li', { text: 'Or type the code above on the login page.' })),
      h('p', { class: 'slip-fine', text: `Good for ${durLabel(v.durationMinutes)} from your first connection, on one device at a time.` }),
    );
    window.print();
  }

  // ---- voucher list -------------------------------------------------------------------

  function rowEl(v) {
    const live = isLive(v);
    let when;
    if (v.status === 'active') {
      when = h('span', {
        class: 'row-time', 'data-expires': String(v.expiresAt),
        text: leftText(Math.floor((v.expiresAt - serverNow()) / 1000)),
      });
    } else if (v.status === 'unused') {
      when = h('span', { class: 'row-time', text: `${durLabel(v.durationMinutes)} once connected` });
    } else {
      const by = v.status === 'revoked' && v.endedBy ? ` by ${v.endedBy}` : '';
      when = h('span', { class: 'row-time', text: `Ended ${fmtTime(v.endedAt)}${by}` });
    }

    const actions = [];
    if (live) {
      const armed = revokeArm && revokeArm.id === v.id;
      actions.push(
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', 'data-key': `show:${v.id}`, text: 'Show QR', onclick: () => { shownId = v.id; renderTicket(); $('ticket').scrollIntoView({ block: 'nearest' }); } }),
        h('button', {
          class: `btn btn-small ${armed ? 'btn-danger' : 'btn-quiet'}`, type: 'button', 'data-key': `revoke:${v.id}`,
          text: armed ? 'Tap again to revoke' : 'Revoke', onclick: () => onRevoke(v.id),
        }),
      );
    }

    return h('li', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-top' },
          h('span', { class: 'row-code', text: v.code }),
          h('span', { class: 'badge', 'data-status': badgeKey(v), text: statusText(v) })),
        h('p', { class: 'row-meta' }, h('span', { text: `Made by ${v.createdBy} at ${fmtTime(v.createdAt)}` }), when)),
      actions.length ? h('div', { class: 'row-actions' }, actions) : null);
  }

  function renderList() {
    if (!state) return;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    const live = state.vouchers.filter(isLive).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return a.status === 'active' ? a.expiresAt - b.expiresAt : b.createdAt - a.createdAt;
    });
    const ended = state.vouchers.filter((v) => !isLive(v)).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    $('count-live').textContent = String(live.length);
    $('count-ended').textContent = String(ended.length);

    const rows = tab === 'live' ? live : ended;
    $('list').replaceChildren(...rows.map(rowEl));
    const empty = $('list-empty');
    empty.hidden = rows.length > 0;
    empty.textContent = tab === 'live'
      ? 'No live vouchers. Generate one when a customer orders.'
      : 'Nothing has ended yet.';

    for (const button of document.querySelectorAll('.tab')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
    if (focusKey) {
      const again = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (again) again.focus();
    }
  }

  async function onRevoke(id) {
    if (!revokeArm || revokeArm.id !== id) {
      if (revokeArm) clearTimeout(revokeArm.timer);
      revokeArm = {
        id,
        timer: setTimeout(() => { revokeArm = null; renderList(); }, 4000),
      };
      renderList();
      return;
    }
    clearTimeout(revokeArm.timer);
    revokeArm = null;
    try {
      await api('POST', `/api/vouchers/${id}/revoke`);
      if (shownId === id) shownId = null;
      toast('Voucher revoked');
    } catch (err) {
      toast(err.message);
    }
    await refresh();
  }

  // ---- loading and ticking ------------------------------------------------------------

  function render() {
    $('cafe-name').textContent = state.branding.cafeName;
    document.title = `Wi-Fi vouchers - ${state.branding.cafeName}`;
    $('who').textContent = state.user;

    const select = $('duration');
    if (select.options.length === 0) {
      for (const min of state.voucherConfig.durationOptionsMinutes) {
        select.append(h('option', { value: String(min), text: durLabel(min), selected: min === state.voucherConfig.durationMinutes }));
      }
    }
    renderPill();
    renderList();
    renderTicket();
  }

  async function refresh() {
    try {
      const data = await api('GET', '/api/vouchers');
      state = data;
      skew = data.now - Date.now();
      offline = false;
      render();
    } catch (err) {
      if (err.message === 'Signed out') return;
      offline = true;
      renderPill();
    }
  }

  function tick() {
    if (!state) return;
    let ended = false;
    for (const el of document.querySelectorAll('[data-expires]')) {
      const sec = Math.floor((Number(el.dataset.expires) - serverNow()) / 1000);
      el.textContent = (el.dataset.prefix || '') + leftText(sec);
      if (sec <= 0) ended = true;
    }
    if (ended && !expiryRefreshQueued) {
      expiryRefreshQueued = true;
      setTimeout(async () => {
        await refresh();
        expiryRefreshQueued = false;
      }, 3000);
    }
  }

  // ---- events -------------------------------------------------------------------------

  $('gen-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('gen-btn');
    const error = $('gen-error');
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      const { voucher } = await api('POST', '/api/vouchers', { durationMinutes: Number($('duration').value) });
      shownId = voucher.id;
      tab = 'live';
      await refresh();
      $('ticket').scrollIntoView({ block: 'nearest' });
    } catch (err) {
      if (err.message !== 'Signed out') {
        error.textContent = err.message === 'Failed to fetch' ? "Can't reach the server. Check the connection and try again." : err.message;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Generate voucher';
    }
  });

  $('logout').addEventListener('click', async () => {
    try {
      await api('POST', '/api/logout');
    } catch {
      // fall through to the login page either way
    }
    location.href = '/login';
  });

  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => {
      tab = button.dataset.tab;
      renderList();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  setInterval(tick, 1000);
})();
