// tests/social-manifest.test.js
// ─────────────────────────────────────────────────────────────────────────────
// The capability contract is the reason this feature cannot lie to the creator,
// so it gets tested like one:
//
//   · Ariana's copy and the engine's copy are byte-identical (drift = failure);
//   · every action marked supported names the real method behind it;
//   · every action marked unsupported explains itself in a sentence a person
//     can read (no "N/A", no empty string);
//   · every platform the manifest claims has an adapter in the engine — and
//     nothing is marked supported that the engine has no handler for;
//   · the specific limitations the creator asked about (posting, search, reading
//     DMs, notifications, feed, deletes) are asserted to be exactly what they are.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const ARIANA_MANIFEST = path.join(__dirname, '..', 'social', 'capabilities.json');
const ENGINE_MANIFEST = path.join(__dirname, '..', 'socialcrabs-service', 'src', 'capabilities.json');

const caps = require('../social/capabilities');

test('manifest: the engine copy and Ariana\'s copy are identical', () => {
  const a = fs.readFileSync(ARIANA_MANIFEST, 'utf8');
  const b = fs.readFileSync(ENGINE_MANIFEST, 'utf8');
  assert.strictEqual(a, b, 'social/capabilities.json and socialcrabs-service/src/capabilities.json have drifted apart');
});

test('manifest: every supported action names a real method and what it returns', () => {
  for (const platform of caps.platformIds()) {
    for (const entry of caps.supportedActions(platform)) {
      assert.ok(entry.method, `${platform}/${entry.action} is marked supported but names no method`);
      assert.match(entry.method, /^[a-z]+\.[a-zA-Z]+\(/, `${platform}/${entry.action} method "${entry.method}" does not look like a handler call`);
    }
  }
});

test('manifest: every unsupported action explains itself properly', () => {
  for (const platform of caps.platformIds()) {
    for (const entry of caps.unsupportedActions(platform)) {
      assert.ok(entry.reason && entry.reason.length >= 30, `${platform}/${entry.action} has no usable explanation`);
      assert.ok(!/^(n\/a|not supported|unsupported|no)\.?$/i.test(entry.reason.trim()), `${platform}/${entry.action} has a placeholder reason`);
    }
  }
});

test('manifest: the engine has a handler for everything it advertises', () => {
  const { dispatchCoverage } = require('../socialcrabs-service/src/engine');
  const missing = dispatchCoverage();
  assert.deepStrictEqual(missing, [], `advertised but not dispatchable: ${missing.join(', ')}`);
});

test('manifest: exactly three platforms, and the ones without adapters say why', () => {
  assert.deepStrictEqual(caps.platformIds().sort(), ['instagram', 'linkedin', 'twitter']);
  const described = caps.describe();
  const unsupported = described.unsupported_platforms.map((u) => u.id);
  for (const p of ['facebook', 'tiktok', 'threads', 'youtube']) {
    assert.ok(unsupported.includes(p), `${p} should be listed as having no adapter`);
  }
  for (const u of described.unsupported_platforms) {
    assert.ok(u.reason.length > 20, `${u.id} needs a reason`);
  }
});

// These are the limitations the whole design is built around. If a future
// SocialCrabs release adds one of these methods, these assertions should be the
// thing that fails first — deliberately, so the manifest gets updated on purpose.
test('limits: publishing exists only where the integration really publishes', () => {
  assert.equal(caps.supports('twitter', 'post'), true, 'X can post');
  assert.equal(caps.supports('instagram', 'post'), false);
  assert.equal(caps.supports('linkedin', 'post'), false);
  assert.match(caps.unsupportedReason('instagram', 'post'), /no publish method/i);
  assert.match(caps.unsupportedReason('linkedin', 'post'), /no publish method/i);
});

test('limits: search exists only on LinkedIn, and the reason is specific', () => {
  assert.equal(caps.supports('linkedin', 'search'), true);
  assert.equal(caps.supports('instagram', 'search'), false);
  assert.equal(caps.supports('twitter', 'search'), false);
  assert.match(caps.unsupportedReason('twitter', 'search'), /no search method/i);
});

test('limits: nothing can read DMs, notifications or the home feed', () => {
  for (const platform of caps.platformIds()) {
    assert.equal(caps.supports(platform, 'read_dms'), false, `${platform} must not claim DM reading`);
    assert.equal(caps.supports(platform, 'notifications'), false, `${platform} must not claim notifications`);
    assert.equal(caps.supports(platform, 'view_feed'), false, `${platform} must not claim feed browsing`);
  }
  assert.match(caps.unsupportedReason('instagram', 'read_dms'), /no inbox reader/i);
});

test('limits: deletes are unsupported everywhere, because no method exists', () => {
  for (const platform of caps.platformIds()) {
    assert.equal(caps.supports(platform, 'delete_post'), false);
    assert.equal(caps.supports(platform, 'delete_comment'), false);
  }
});

test('limits: connection requests are LinkedIn-only, and Instagram says so', () => {
  assert.equal(caps.supports('linkedin', 'connect'), true);
  assert.equal(caps.supports('instagram', 'connect'), false);
  assert.equal(caps.supports('twitter', 'connect'), false);
});

test('limits: replying to an individual comment is not claimed anywhere it cannot work', () => {
  assert.equal(caps.supports('twitter', 'reply'), true, 'on X a reply is the tweet comment');
  assert.equal(caps.supports('instagram', 'reply'), false);
  assert.equal(caps.supports('linkedin', 'reply'), false);
});

test('check(): a refusal always carries a reason and a code', () => {
  const ig = caps.check('instagram', 'post');
  assert.equal(ig.ok, false);
  assert.equal(ig.code, 'unsupported');
  assert.ok(ig.error.length > 30);

  const unknown = caps.check('myspace', 'like');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unsupported_platform');
  assert.match(unknown.error, /Supported platforms: instagram, twitter, linkedin/);

  const ok = caps.check('instagram', 'like');
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.method, 'instagram.like({ url })');
});
