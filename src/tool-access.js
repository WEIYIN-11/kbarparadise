const TOOL_ACCESS_SURFACE = 'external';
const TRADER_SIM_TOOL_KEY = 'trader-sim';

const IDENTITY_RANK = Object.freeze({
  visitor: 0,
  member: 1,
  vip: 2,
});

const LEGACY_PAID_TIERS = new Set(['starter', 'vip', 'pro', 'private']);
const VIP_TIERS = new Set(['vip', 'pro', 'private']);

function activeTier(memberRow, now = Date.now()) {
  if (!memberRow || typeof memberRow.tier !== 'string') return null;
  if (memberRow.expires_at) {
    const expiresAt = new Date(memberRow.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt < now) return null;
  }
  return memberRow.tier;
}

function signedInIdentity(memberRow, now = Date.now()) {
  const tier = activeTier(memberRow, now);
  return tier && VIP_TIERS.has(tier) ? 'vip' : 'member';
}

function legacyPaidAccess(memberRow, now = Date.now()) {
  const tier = activeTier(memberRow, now);
  return !!tier && LEGACY_PAID_TIERS.has(tier);
}

function traderSimRequirement(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.settings)) return null;
  const row = snapshot.settings.find(
    (item) =>
      item &&
      item.surface === TOOL_ACCESS_SURFACE &&
      item.toolKey === TRADER_SIM_TOOL_KEY,
  );
  if (!row) return null;
  return row.minIdentity === 'visitor' ||
    row.minIdentity === 'member' ||
    row.minIdentity === 'vip'
    ? row.minIdentity
    : null;
}

function identityAllows(identity, required) {
  if (!(identity in IDENTITY_RANK) || !(required in IDENTITY_RANK)) return false;
  return IDENTITY_RANK[identity] >= IDENTITY_RANK[required];
}

export {
  TOOL_ACCESS_SURFACE,
  TRADER_SIM_TOOL_KEY,
  identityAllows,
  legacyPaidAccess,
  signedInIdentity,
  traderSimRequirement,
};
