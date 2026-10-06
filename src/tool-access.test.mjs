import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  identityAllows,
  legacyPaidAccess,
  signedInIdentity,
  traderSimRequirement,
} from './tool-access.js';

describe('TraderSim centralized tool access', () => {
  test('signed-in identity follows visitor/member/VIP normalization', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    assert.equal(signedInIdentity(null, now), 'member');
    assert.equal(signedInIdentity({ tier: 'starter', expires_at: null }, now), 'member');
    assert.equal(signedInIdentity({ tier: 'vip', expires_at: null }, now), 'vip');
    assert.equal(signedInIdentity({ tier: 'pro', expires_at: null }, now), 'vip');
    assert.equal(signedInIdentity({ tier: 'private', expires_at: null }, now), 'vip');
    assert.equal(
      signedInIdentity({ tier: 'vip', expires_at: '2026-10-05T00:00:00Z' }, now),
      'member',
    );
  });

  test('legacy fallback preserves the old active paid-membership gate', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    assert.equal(legacyPaidAccess(null, now), false);
    assert.equal(legacyPaidAccess({ tier: 'starter', expires_at: null }, now), true);
    assert.equal(legacyPaidAccess({ tier: 'vip', expires_at: null }, now), true);
    assert.equal(
      legacyPaidAccess({ tier: 'vip', expires_at: '2026-10-05T00:00:00Z' }, now),
      false,
    );
  });

  test('formal snapshot reads only external/trader-sim', () => {
    assert.equal(
      traderSimRequirement({
        revision: 3,
        settings: [
          { surface: 'stats', toolKey: 'today', minIdentity: 'member' },
          { surface: 'external', toolKey: 'trader-sim', minIdentity: 'vip' },
        ],
      }),
      'vip',
    );
    assert.equal(traderSimRequirement({ revision: 2, settings: [] }), null);
    assert.equal(
      traderSimRequirement({
        settings: [{ surface: 'external', toolKey: 'trader-sim', minIdentity: 'legacy' }],
      }),
      null,
    );
  });

  test('identity comparator is monotonic', () => {
    assert.equal(identityAllows('visitor', 'visitor'), true);
    assert.equal(identityAllows('visitor', 'member'), false);
    assert.equal(identityAllows('member', 'member'), true);
    assert.equal(identityAllows('member', 'vip'), false);
    assert.equal(identityAllows('vip', 'vip'), true);
    assert.equal(identityAllows('vip', 'member'), true);
  });
});
