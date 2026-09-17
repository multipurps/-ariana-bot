// socialcrabs-service/src/capabilities.js
// ─────────────────────────────────────────────────────────────────────────────
// The engine's copy of the capability contract.
//
// The engine is the side that actually touches the platforms, so it holds the
// authoritative view of what is possible: the HTTP API answers 422 with the
// manifest's own reason for anything it cannot do, and the dispatch table in
// ./engine.js is checked against this file at boot (a supported action with no
// handler is a bug, and the engine says so instead of failing at runtime).
//
// social/capabilities.json in Ariana's tree is a byte-identical copy — the test
// suite fails if the two drift, so neither side can quietly widen what it
// claims.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'capabilities.json'), 'utf8'));

function manifest() { return MANIFEST; }
function platformIds() { return Object.keys(MANIFEST.platforms); }
function platformInfo(platform) { return MANIFEST.platforms[platform] || null; }
function actionSpec(action) { return MANIFEST.actions[action] || null; }

function entry(platform, action) {
  const info = platformInfo(platform);
  if (!info) return null;
  return info.actions[action] || null;
}

function supports(platform, action) {
  const e = entry(platform, action);
  return !!(e && e.supported);
}

// { ok: true } or { ok: false, code, error } with a reason a human can act on.
function check(platform, action) {
  const info = platformInfo(platform);
  if (!info) {
    const why = MANIFEST.unsupported_platforms[platform];
    return {
      ok: false,
      code: 'unsupported_platform',
      error: why ? `${platform}: ${why}` : `No adapter for "${platform}". Supported: ${platformIds().join(', ')}.`,
    };
  }
  const e = info.actions[action];
  if (!e) return { ok: false, code: 'unsupported', error: `"${action}" is not part of this integration.` };
  if (!e.supported) return { ok: false, code: 'unsupported', error: e.reason };
  return { ok: true, entry: e };
}

// Everything the dashboard should render for a platform.
function describe() {
  return {
    provider: MANIFEST.provider,
    provider_repo: MANIFEST.provider_repo,
    provider_version: MANIFEST.provider_version_verified,
    verified_from: MANIFEST.verified_from,
    platforms: platformIds().map((id) => ({
      id,
      label: platformInfo(id).label,
      handle_label: platformInfo(id).handle_label,
      session_cookie: platformInfo(id).session_cookie,
      env_bootstrap: !!platformInfo(id).env_bootstrap,
      env_bootstrap_vars: platformInfo(id).env_bootstrap_vars || [],
      supported: Object.entries(platformInfo(id).actions)
        .filter(([, v]) => v.supported)
        .map(([action, v]) => ({ action, method: v.method || null, returns: v.returns || null, notes: v.notes || null })),
      unsupported: Object.entries(platformInfo(id).actions)
        .filter(([, v]) => !v.supported)
        .map(([action, v]) => ({ action, reason: v.reason || 'Not available in this integration.' })),
    })),
    unsupported_platforms: Object.entries(MANIFEST.unsupported_platforms).map(([id, reason]) => ({ id, reason })),
  };
}

module.exports = {
  manifest,
  platformIds,
  platformInfo,
  actionSpec,
  entry,
  supports,
  check,
  describe,
};
