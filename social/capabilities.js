// social/capabilities.js
// ─────────────────────────────────────────────────────────────────────────────
// What Ariana can and cannot really do on each platform — loaded from
// social/capabilities.json, which the engine service mirrors byte for byte
// (tests/social-manifest.test.js fails if the two copies drift).
//
// This file is what keeps the feature honest. The dashboard renders from it, the
// tool list is generated from it, and every refusal message comes from here, so
// a limitation is explained once and applies everywhere. Nothing in this layer
// may claim an ability that is not in the manifest.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'capabilities.json'), 'utf8'));

function manifest() {
  return MANIFEST;
}

function platformIds() {
  return Object.keys(MANIFEST.platforms);
}

function platformInfo(platform) {
  return MANIFEST.platforms[platform] || null;
}

function platformLabel(platform) {
  const info = platformInfo(platform);
  return info ? info.label : String(platform || '');
}

function actionNames() {
  return Object.keys(MANIFEST.actions);
}

// The canonical spec for an action name, independent of platform.
function actionSpec(action) {
  return MANIFEST.actions[action] || null;
}

// The per-platform entry: either { supported: true, method, ... } or
// { supported: false, reason }.
function entry(platform, action) {
  const info = platformInfo(platform);
  if (!info) return null;
  return info.actions[action] || null;
}

function supports(platform, action) {
  const e = entry(platform, action);
  return !!(e && e.supported);
}

// The human-readable reason a platform cannot do something, or null when it can.
function unsupportedReason(platform, action) {
  const info = platformInfo(platform);
  if (!info) return unsupportedPlatformReason(platform);
  const e = info.actions[action];
  if (!e) return `"${action}" is not part of this integration.`;
  if (e.supported) return null;
  return e.reason;
}

function unsupportedPlatformReason(platform) {
  const why = MANIFEST.unsupported_platforms[platform];
  if (why) return `${platform}: ${why}`;
  return `"${platform}" has no adapter in this integration. Supported platforms: ${platformIds().join(', ')}.`;
}

// The one gate every write action passes through first.
// Returns { ok: true, entry } or { ok: false, code: 'unsupported', error }.
function check(platform, action) {
  const info = platformInfo(platform);
  if (!info) {
    return { ok: false, code: 'unsupported_platform', error: unsupportedPlatformReason(platform) };
  }
  const e = info.actions[action];
  if (!e) {
    return { ok: false, code: 'unsupported', error: `"${action}" is not a capability of this integration.` };
  }
  if (!e.supported) {
    return { ok: false, code: 'unsupported', error: e.reason };
  }
  return { ok: true, entry: e };
}

function supportedActions(platform) {
  const info = platformInfo(platform);
  if (!info) return [];
  return Object.entries(info.actions)
    .filter(([, v]) => v.supported)
    .map(([action, v]) => ({ action, method: v.method || null, returns: v.returns || null, notes: v.notes || null, kind: (actionSpec(action) || {}).kind || 'write' }));
}

function unsupportedActions(platform) {
  const info = platformInfo(platform);
  if (!info) return [];
  return Object.entries(info.actions)
    .filter(([, v]) => !v.supported)
    .map(([action, v]) => ({ action, reason: v.reason || 'Not available in this integration.' }));
}

// Full picture for the dashboard. The dashboard shows exactly this — it does not
// invent, hide or soften anything.
function describe() {
  return {
    provider: MANIFEST.provider,
    provider_repo: MANIFEST.provider_repo,
    provider_version: MANIFEST.provider_version_verified,
    verified_from: MANIFEST.verified_from,
    platforms: platformIds().map((id) => ({
      id,
      label: platformLabel(id),
      handle_label: platformInfo(id).handle_label,
      env_bootstrap: !!platformInfo(id).env_bootstrap,
      env_bootstrap_vars: platformInfo(id).env_bootstrap_vars || [],
      supported: supportedActions(id),
      unsupported: unsupportedActions(id),
    })),
    unsupported_platforms: Object.entries(MANIFEST.unsupported_platforms).map(([id, reason]) => ({ id, reason })),
  };
}

// Compact text for Ariana's system prompt: only what she has accounts for, and
// only the truth about those.
function promptSummary(accountsByPlatform) {
  const lines = [];
  for (const [platform, accounts] of Object.entries(accountsByPlatform)) {
    if (!accounts.length) continue;
    const can = supportedActions(platform).map((s) => s.action);
    const cannot = unsupportedActions(platform).map((u) => u.action);
    const handles = accounts.map((a) => '@' + a.handle).join(', ');
    lines.push(`${platformLabel(platform)} (${handles}): can ${can.join(', ')}. Cannot: ${cannot.join(', ')}.`);
  }
  return lines.join('\n');
}

module.exports = {
  manifest,
  platformIds,
  platformInfo,
  platformLabel,
  actionNames,
  actionSpec,
  entry,
  supports,
  check,
  supportedActions,
  unsupportedActions,
  unsupportedReason,
  unsupportedPlatformReason,
  describe,
  promptSummary,
};
