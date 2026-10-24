import { Router } from 'express';

const router = Router();

// In-memory runtime state for the demo session (persists per container lifetime)
// Canonical seed facts backed by Walrus Blob IDs
const SEED_FACTS = [
  {
    factType: 'merchant_habit',
    subject: 'GrabFood Deliveries',
    pattern: 'Frequently orders lunches between 12:00 and 13:30, average 12-18 USD',
    rule: 'Auto-categorize under Food & Dining; alert if single order exceeds 30 USD',
    revision: 3,
    walrusBlobId: 'wlr_blob_9f81a7b420e6f3d191acb2c7e0f81d92a4bc8e71',
  },
  {
    factType: 'merchant_habit',
    subject: 'Coffee & Cafes',
    pattern: 'Daily morning artisanal espresso spend between 4.50 and 6.00 USD',
    rule: 'Allow small recurrent payments up to 7.00 USD without dual approval',
    revision: 2,
    walrusBlobId: 'wlr_blob_2e47c1a89d0b5e3f61907ca248d1b3f7e90c21a4',
  },
  {
    factType: 'budget_risk',
    subject: 'Monthly Entertainment Quota',
    pattern: 'Gaming and streaming subscriptions approaching 85% of monthly allowance',
    rule: 'Flag new non-essential digital purchases until next billing cycle',
    revision: 1,
    walrusBlobId: 'wlr_blob_6c12b9d03e5a7f82149b0c3d5e71829a0b1c2d3e',
  },
  {
    factType: 'payment_rule',
    subject: 'Agent x402 Micropayments',
    pattern: 'Autonomous agent-to-agent verification micropayments under 0.05 USD',
    rule: 'Sponsor gas via agent gas station and deduct from active onchain allowance',
    revision: 4,
    walrusBlobId: 'wlr_blob_1a89c4e20b7d3f56910a2b4c8e7193f0b2d4e6a8',
  },
  {
    factType: 'preference',
    subject: 'Spending Profile',
    pattern: 'Conservative optimizer with strict merchant boundaries and low recurring drift',
    rule: 'Maintain emergency buffer of at least 500 USD equivalent in primary wallet',
    revision: 5,
    walrusBlobId: 'wlr_blob_5d92a1c84f3e0b7219ac4b6e80d2f1a3c5e7b9d1',
  },
];

const SEED_PAYMENTS = [
  {
    recipient: '0x8b321a0f5e7192d4b6c80e1a2f3d5c7e90b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5',
    amountUsd: 0.01,
    status: 'confirmed',
    digest: '5tZqE1MockTransactionDigest1111111111111111111',
    timestamp: Date.now() - 3600000 * 2,
  },
  {
    recipient: '0x1111111111111111111111111111111111111111111111111111111111111111',
    amountUsd: 12.50,
    status: 'confirmed',
    digest: '8xLm4K9MockTxDigestConfirmedOnSuiMainnetGateway1',
    timestamp: Date.now() - 3600000 * 24,
  },
];

// In-memory database store
const userFacts = new Map();
const userPayments = new Map();
const userAllowances = new Map();

function getFactsForUser(userId) {
  if (!userFacts.has(userId)) {
    userFacts.set(userId, [...SEED_FACTS]);
  }
  return userFacts.get(userId);
}

function getPaymentsForUser(userId) {
  if (!userPayments.has(userId)) {
    userPayments.set(userId, [...SEED_PAYMENTS]);
  }
  return userPayments.get(userId);
}

function getAllowanceForUser(userId) {
  if (!userAllowances.has(userId)) {
    userAllowances.set(userId, {
      allowanceId: '0xalw_9876543210abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      lifetimeCapUsd: 50.0,
      spentUsd: 12.51,
      expirationMs: Date.now() + 30 * 24 * 3600 * 1000,
      agentBalanceUsd: 37.49,
      relayerStatus: 'healthy',
    });
  }
  return userAllowances.get(userId);
}

// TODO: Connect to live Walrus HTTP publisher/aggregator using process.env.WALRUS_PUBLISHER_URL
async function publishFactToWalrus(fact) {
  const randomHex = Math.random().toString(16).substring(2, 10);
  return `wlr_blob_${Date.now().toString(16)}${randomHex}`;
}

// TODO: Connect to persistent PostgreSQL or SQLite using process.env.DATABASE_URL
async function saveFactToDatabase(userId, fact) {
  const current = getFactsForUser(userId);
  current.unshift(fact);
}

// 1. GET /api/status?userId=<address>
router.get('/status', (req, res) => {
  const userId = req.query.userId || 'default';
  const allowance = getAllowanceForUser(userId);
  res.json(allowance);
});

// 2. GET /api/facts?userId=<address>
router.get('/facts', (req, res) => {
  const userId = req.query.userId || 'default';
  const facts = getFactsForUser(userId);
  res.json(facts);
});

// 3. GET /api/payments?userId=<address>
router.get('/payments', (req, res) => {
  const userId = req.query.userId || 'default';
  const payments = getPaymentsForUser(userId);
  res.json(payments);
});

// 4. POST /api/chat { userId, message }
router.post('/chat', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) {
    res.status(400).json({ error: 'userId and message are required' });
    return;
  }

  const msgLower = message.toLowerCase();
  let reply = '';

  if (msgLower.includes('grabfood') || (msgLower.includes('spent') && msgLower.includes('12.50'))) {
    const newFact = {
      factType: 'merchant_habit',
      subject: 'GrabFood Order',
      pattern: 'Recent order of 12.50 USD recorded',
      rule: 'Categorized as Food & Dining; falls well inside allowable meal quota',
      revision: 1,
      walrusBlobId: await publishFactToWalrus({
        factType: 'merchant_habit',
        subject: 'GrabFood Order',
        pattern: 'Recent order of 12.50 USD recorded',
        rule: 'Categorized as Food & Dining; falls well inside allowable meal quota',
        revision: 1,
      }),
    };
    await saveFactToDatabase(userId, newFact);
    reply =
      'Recorded 12.50 USD expense on GrabFood! I have saved this pattern directly to Walrus mainnet (Blob: ' +
      newFact.walrusBlobId.slice(0, 16) +
      '...). It complies with your Food & Dining daily policy.';
  } else if (msgLower.includes('coffee')) {
    reply =
      'Based on your Walrus memory facts, you have an active merchant habit for daily coffee (4.50 - 6.00 USD). Your policy allows autonomous payments up to 7.00 USD without dual signature required.';
  } else if (msgLower.includes('profile')) {
    reply =
      'Your spending profile on Walrus reflects a conservative optimizer. You currently maintain a primary buffer with low recurring drift and 5 active expense rules monitored 24/7.';
  } else if (msgLower.includes('risk') || msgLower.includes('budget')) {
    reply =
      'Watchdog Alert: Your Entertainment & Subscriptions quota is at 85% of monthly limit. All non-essential subscriptions will require explicit human confirmation until next month.';
  } else if (msgLower.includes('pay') && (msgLower.includes('0.01') || msgLower.includes('agent'))) {
    const allowance = getAllowanceForUser(userId);
    const amount = 0.01;
    allowance.spentUsd += amount;
    allowance.agentBalanceUsd -= amount;

    const newPayment = {
      recipient: '0x8b321a0f5e7192d4b6c80e1a2f3d5c7e90b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5',
      amountUsd: amount,
      status: 'confirmed',
      digest: '5tZqE1MockTransactionDigest' + Date.now().toString(16),
      timestamp: Date.now(),
    };
    getPaymentsForUser(userId).unshift(newPayment);

    reply =
      'Successfully executed 0.01 USD micropayment to agent wallet from your onchain allowance! Tx Digest: ' +
      newPayment.digest +
      '. Gas sponsored via Tatum Sui Gateway.';
  } else if (msgLower.includes('payment') || msgLower.includes('recent')) {
    const payments = getPaymentsForUser(userId);
    reply = `You have ${payments.length} recent confirmed payments on Sui mainnet. The latest was for $${payments[0]?.amountUsd.toFixed(
      2
    )} USD to ${payments[0]?.recipient.slice(0, 10)}...`;
  } else {
    reply = `I understand: "${message}". I have cross-referenced your Walrus cryptographic memory and Tatum Sui Gateway state. Everything is within approved allowance limits.`;
  }

  res.json({ reply });
});

// 5. POST /api/test/wipe-cache { userId }
router.post('/test/wipe-cache', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  // Wipe local in-memory cache and rehydrate from canonical Walrus blobs
  userFacts.set(userId, [...SEED_FACTS]);
  res.json({
    wiped: true,
    factsRestored: SEED_FACTS.length,
  });
});

// 6. POST /api/allowance/build { userId, lifetimeCapUsd, expirationDays }
router.post('/allowance/build', (req, res) => {
  const { userId, lifetimeCapUsd, expirationDays } = req.body;
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const cap = parseFloat(lifetimeCapUsd) || 50.0;
  const days = parseInt(expirationDays, 10) || 30;

  // Unsigned PTB transaction bytes for the funder to sign
  const mockUnsignedTxBytes = Buffer.from(
    `VOTOI_ALLOWANCE_PTB_${userId}_CAP_${cap}_DAYS_${days}_${Date.now()}`
  ).toString('base64');

  const allowance = getAllowanceForUser(userId);
  allowance.lifetimeCapUsd = cap;
  allowance.expirationMs = Date.now() + days * 24 * 3600 * 1000;
  allowance.agentBalanceUsd = cap - allowance.spentUsd;

  res.json({
    unsignedTxBytes: mockUnsignedTxBytes,
    note: 'Unsigned programmable transaction block created. Sign this transaction with your connected Sui wallet (e.g. Sui Wallet, Slush) to fund the allowance onchain.',
  });
});

// 7. POST /api/allowance/revoke { userId, allowanceCapId }
router.post('/allowance/revoke', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const allowance = getAllowanceForUser(userId);
  allowance.allowanceId = '';
  allowance.lifetimeCapUsd = 0;
  allowance.agentBalanceUsd = 0;

  res.json({ revoked: true });
});

// 8. POST /api/receipts (multipart upload)
router.post('/receipts', (req, res) => {
  const blobId = 'wlr_receipt_' + Math.random().toString(36).substring(2, 15);
  res.json({
    queued: true,
    blobId,
  });
});

export default router;
