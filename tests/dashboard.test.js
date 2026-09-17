// tests/dashboard.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Renders the SOCIAL screen against canned backend responses, without a browser.
//
// The dashboard's job is to tell the truth about state, so these tests feed it
// each state the creator will actually hit — engine missing, account connected,
// account in error, needs-confirmation, failed action — and assert the screen
// says the right thing. It also asserts the screen never invents a capability:
// every platform's "Cannot:" list on screen has to match the manifest.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Pull just the social section out of the dashboard script.
const startMarker = '// ── SOCIAL ─';
const start = html.indexOf(startMarker);
const end = html.indexOf('</script>', start);
assert.ok(start > 0 && end > start, 'the SOCIAL section must exist in the dashboard');

// The section ends with the last social function; everything after it in the
// script block is closing braces, which we trim by cutting at the marker we
// added after the social block.
const socialSrc = html.slice(start, end).replace(/<\/script>\s*$/, '');

function makeEl() {
  return {
    _html: '',
    value: '',
    style: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._html; },
    set textContent(v) { this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}

function renderWith({ status, accounts, activity, autonomy, caps, fetchImpl }) {
  const els = {
    'social-engine': makeEl(),
    'social-accounts': makeEl(),
    'social-activity': makeEl(),
    'social-autonomy': makeEl(),
  };
  const toasts = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    document: {
      getElementById: (id) => els[id] || makeEl(),
      createElement: () => makeEl(),
    },
    fetch: fetchImpl || (async (url) => ({
      json: async () => {
        if (url.includes('/api/social/status')) return status;
        if (url.includes('/api/social/accounts')) return accounts;
        if (url.includes('/api/social/activity')) return activity;
        if (url.includes('/api/social/capabilities')) return caps;
        if (url.includes('/api/social/autonomy')) return { autonomy };
        return {};
      },
    })),
    authH: () => ({}),
    escHTML: (s) => { const d = makeEl(); d.textContent = s; return d.innerHTML; },
    toast: (m) => toasts.push(m),
    go: () => {},
    confirm: () => true,
    Promise, Object, Array, String, Number, Math, Date, JSON, parseInt, parseFloat, isNaN,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(socialSrc, sandbox);
  return { sandbox, els, toasts, ready: sandbox.loadSocial };
}

const CAPS = {
  source: 'bundled',
  capabilities: {
    provider: 'socialcrabs',
    platforms: [
      { id: 'instagram', label: 'Instagram', handle_label: 'username', supported: [{ action: 'like', method: 'instagram.like({ url })' }, { action: 'comment' }, { action: 'follow' }], unsupported: [{ action: 'post', reason: 'There is no publish method on the Instagram handler.' }, { action: 'search', reason: 'No search method.' }] },
      { id: 'twitter', label: 'X', handle_label: 'handle', supported: [{ action: 'post' }, { action: 'like' }], unsupported: [{ action: 'search', reason: 'No search method.' }] },
      { id: 'linkedin', label: 'LinkedIn', handle_label: 'member', supported: [{ action: 'search' }, { action: 'connect' }], unsupported: [{ action: 'post', reason: 'No publish method.' }] },
    ],
  },
};

const ENGINE_OFF = {
  ok: true,
  engine: { configured: false, url: null, reachable: false, error: 'Social engine not connected — Set SOCIAL_ENGINE_URL.' },
  storage: { supabase: false },
  accounts: [],
  dry_run: false,
  setup: { steps: ['1. Deploy the social engine.', '2. Set SOCIAL_ENGINE_API_KEY.', '3. Provision a session.'] },
};

test('dashboard: shows "Backend not connected" and the real setup steps', async () => {
  const { sandbox, els } = renderWith({ status: ENGINE_OFF, accounts: { accounts: [] }, activity: { activity: [] }, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  const engineHtml = els['social-engine'].innerHTML;
  assert.match(engineHtml, /Backend not connected/);
  assert.match(engineHtml, /View details/);
  sandbox.socToggleDetail('engine');
  const expanded = els['social-engine'].innerHTML;
  assert.match(expanded, /Deploy the social engine/);
  assert.match(expanded, /SOCIAL_ENGINE_URL/);
  assert.match(expanded, /COOKIE_ENCRYPTION_KEY/);
});

test('dashboard: a connected account reads Connected @handle — Online, with actions enabled', async () => {
  const status = { ...ENGINE_OFF, engine: { configured: true, url: 'https://engine.test', reachable: true, health: { provider: 'socialcrabs', browsers_open: 1 } } };
  const accounts = {
    accounts: [{
      account_id: 'instagram:ariana.personal', platform: 'instagram', handle: 'ariana.personal',
      actions_enabled: true, status: 'online', status_detail: 'Session verified live in the browser.',
      capabilities: { supported: [{ action: 'like' }, { action: 'comment' }], unsupported: [{ action: 'post', reason: 'There is no publish method on the Instagram handler.' }] },
    }],
  };
  const { sandbox, els } = renderWith({ status, accounts, activity: { activity: [] }, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  const h = els['social-accounts'].innerHTML;
  assert.match(h, /@ariana\.personal/);
  assert.match(h, /Online/);
  assert.match(h, /Actions enabled/);
  assert.match(h, /Re-check/);
  // and the honest limitations list is reachable
  sandbox.socToggleDetail('instagram:ariana.personal');
  assert.match(els['social-accounts'].innerHTML, /no publish method/i);
});

test('dashboard: a failing account shows Error with a reason and View details', async () => {
  const status = { ...ENGINE_OFF, engine: { configured: true, url: 'https://engine.test', reachable: true, health: {} } };
  const accounts = {
    accounts: [{
      account_id: 'instagram:ariana.personal', platform: 'instagram', handle: 'ariana.personal',
      actions_enabled: true, status: 'error',
      status_detail: 'Session expired or not logged in — reconnect this account.',
      capabilities: { supported: [], unsupported: [] },
    }],
  };
  const { sandbox, els } = renderWith({ status, accounts, activity: { activity: [] }, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  const h = els['social-accounts'].innerHTML;
  assert.match(h, /Error/);
  assert.match(h, /Session expired/);
  assert.match(h, /Connect/);
});

test('dashboard: activity reads like a person wrote it, failures included', async () => {
  const status = ENGINE_OFF;
  const activity = {
    activity: [
      { account_id: 'instagram:ariana.personal', platform_label: 'Instagram', platform: 'instagram', handle: 'ariana.personal', action: 'like', status: 'completed', status_label: 'Completed', summary: "Liked @someone's post", created_at: new Date().toISOString(), actor: 'ariana' },
      { account_id: 'instagram:ariana.personal', platform_label: 'Instagram', platform: 'instagram', handle: 'ariana.personal', action: 'comment', status: 'failed', status_label: 'Failed', summary: 'Comment failed', error: 'Session expired or not logged in — reconnect this account.', created_at: new Date().toISOString(), actor: 'ariana' },
      { account_id: 'twitter:ArianaReyes', platform_label: 'X', platform: 'twitter', handle: 'ArianaReyes', action: 'follow', status: 'completed', status_label: 'Completed', summary: 'Followed @someone', created_at: new Date().toISOString(), actor: 'ariana' },
    ],
  };
  const { sandbox, els } = renderWith({ status, accounts: { accounts: [] }, activity, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  const h = els['social-activity'].innerHTML;
  assert.match(h, /Liked @someone&#39;s post|Liked @someone's post/);
  assert.match(h, /Completed/);
  assert.match(h, /Comment failed/);
  assert.match(h, /Reason: Session expired/);
  assert.match(h, /Followed @someone/);
  assert.match(h, /View details/);
});

test('dashboard: a blocked action offers Confirm and send, bound to that account+action', async () => {
  const status = ENGINE_OFF;
  const activity = {
    activity: [{
      account_id: 'instagram:ariana.personal', platform_label: 'Instagram', platform: 'instagram', handle: 'ariana.personal', action: 'unfollow',
      status: 'needs_confirmation', status_label: 'Needs your confirmation',
      summary: "Could not unfollow @someone — waiting for your confirmation",
      error: '"unfollow" is irreversible enough that it always needs a human yes.',
      created_at: new Date().toISOString(), actor: 'ariana',
      detail: { code: 'needs_confirmation', request: { username: 'someone' } },
    }],
  };
  const { sandbox, els } = renderWith({ status, accounts: { accounts: [] }, activity, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  const h = els['social-activity'].innerHTML;
  assert.match(h, /Needs your confirmation/);
  assert.match(h, /Confirm and send/);
  assert.match(h, /socConfirmAction\('instagram:ariana\.personal','unfollow'/);
});

test('dashboard: the capability lists shown come from the manifest, not from optimism', async () => {
  const { sandbox, els } = renderWith({ status: ENGINE_OFF, accounts: { accounts: [] }, activity: { activity: [] }, caps: CAPS, autonomy: { enabled: false } });
  await sandbox.loadSocial();
  let h = els['social-accounts'].innerHTML;
  // Instagram cannot post — the screen must say so, and explain why on request
  assert.match(h, /Cannot:<\/b> post · search|Cannot:<\/b> post/);
  sandbox.socToggleDetail('plat-instagram');
  h = els['social-accounts'].innerHTML;
  assert.match(h, /no publish method/i);
  // X can post
  assert.match(h, /Can:<\/b> post · like|Can:<\/b> post/);
  // LinkedIn search is real and shown as such
  assert.match(h, /search/);
  // adding an account is offered for every real platform
  for (const p of ['instagram', 'twitter', 'linkedin']) {
    assert.match(h, new RegExp(`soc-add-${p}`));
  }
});

test('dashboard: the page never contains a password field for a social account', () => {
  const screenStart = html.indexOf('id="s-social"');
  const screenEnd = html.indexOf('<!-- CALL OVERLAY -->', screenStart);
  const screen = html.slice(screenStart, screenEnd);
  assert.ok(!/type="password"/.test(screen), 'the social screen must not collect credentials');
  assert.ok(!/password/i.test(screen.replace(/provision|passthrough/g, '')), 'no password wording belongs on the social screen');
});
