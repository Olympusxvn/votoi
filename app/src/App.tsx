import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Send,
  Upload,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  AlertTriangle,
  Play,
  FileText,
  DollarSign,
  Cpu,
  Database,
  Lock,
  ArrowRight,
  Info,
  X,
} from 'lucide-react';

interface FactItem {
  factType: 'merchant_habit' | 'budget_risk' | 'payment_rule' | 'preference';
  subject: string;
  pattern: string;
  rule: string;
  revision: number;
  walrusBlobId: string;
}

interface PaymentItem {
  recipient: string;
  recipients?: { address: string; amountUsd: number }[];
  amountUsd: number;
  status: string;
  digest: string;
  failureReason?: string;
  timestamp: number;
}

interface StatusResponse {
  allowanceId: string;
  lifetimeCapUsd: number | null;
  spentUsd: number;
  expirationMs: number | null;
  agentBalanceUsd: number | null;
  relayerStatus: 'healthy' | 'degraded';
  chainReadsUnavailable?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
  action?: string;
  citations?: { subject: string; blobId: string }[];
}

interface ReceiptDetail {
  status: 'queued' | 'processing' | 'done' | 'failed' | 'timeout';
  merchant: string | null;
  amountUsd: number | null;
  error: string | null;
}

interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  text: string;
}

export default function App() {
  const [userId, setUserId] = useState<string>(
    '0x3ca8aee71d707b54a3391eac41d622b9ad15b49e32a6bf6b6d7252d005608804'
  );
  const [isEditingUser, setIsEditingUser] = useState<boolean>(false);
  const [walletInput, setWalletInput] = useState<string>(userId);

  // Status & Allowance
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Facts
  const [facts, setFacts] = useState<FactItem[]>([]);
  const [factsLoading, setFactsLoading] = useState<boolean>(false);
  const [factsError, setFactsError] = useState<string | null>(null);

  // Payments
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState<boolean>(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'agent',
      text: "Hello! I am VOTOI, your expense watchdog agent. I store all memory cryptographically on Walrus mainnet and execute onchain payments via Tatum's Sui Gateway within the allowance limits you set.",
      timestamp: Date.now(),
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [isAgentTyping, setIsAgentTyping] = useState<boolean>(false);
  const [receiptStatus, setReceiptStatus] = useState<string | null>(null);
  const [receiptDetail, setReceiptDetail] = useState<ReceiptDetail | null>(null);
  const receiptPollId = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Issue Allowance inputs
  const [allowanceCapInput, setAllowanceCapInput] = useState<string>('50.00');
  const [allowanceDaysInput, setAllowanceDaysInput] = useState<string>('30');
  const [isBuildingAllowance, setIsBuildingAllowance] = useState<boolean>(false);
  const [allowanceTxResult, setAllowanceTxResult] = useState<{
    unsignedTxBytes: string;
    note: string;
  } | null>(null);

  // Confirm dialogs
  const [showWipeConfirm, setShowWipeConfirm] = useState<boolean>(false);
  const [isWiping, setIsWiping] = useState<boolean>(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState<boolean>(false);
  const [isRevoking, setIsRevoking] = useState<boolean>(false);

  // Toast notifications
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Demo mode
  const [demoActive, setDemoActive] = useState<boolean>(false);
  const [demoStep, setDemoStep] = useState<number>(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const addToast = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString();
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isAgentTyping]);

  const loadStatus = async (user: string) => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/status?userId=${encodeURIComponent(user)}`);
      if (!res.ok) throw new Error('Failed to load agent status');
      const data = await res.json();
      setStatus(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading status';
      setStatusError(msg);
      addToast(msg, 'error');
    } finally {
      setStatusLoading(false);
    }
  };

  const loadFacts = async (user: string) => {
    setFactsLoading(true);
    setFactsError(null);
    try {
      const res = await fetch(`/api/facts?userId=${encodeURIComponent(user)}`);
      if (!res.ok) throw new Error('Failed to load memory facts');
      const data = await res.json();
      setFacts(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading facts';
      setFactsError(msg);
      addToast(msg, 'error');
    } finally {
      setFactsLoading(false);
    }
  };

  const loadPayments = async (user: string) => {
    setPaymentsLoading(true);
    setPaymentsError(null);
    try {
      const res = await fetch(`/api/payments?userId=${encodeURIComponent(user)}`);
      if (!res.ok) throw new Error('Failed to load payments history');
      const data = await res.json();
      setPayments(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading payments';
      setPaymentsError(msg);
      addToast(msg, 'error');
    } finally {
      setPaymentsLoading(false);
    }
  };

  useEffect(() => {
    loadStatus(userId);
    loadFacts(userId);
    loadPayments(userId);
  }, [userId]);

  const handleSendChat = async (textToSend?: string) => {
    const text = textToSend ?? chatInput;
    if (!text.trim() || isAgentTyping) return;

    const userMsg: ChatMessage = {
      id: Math.random().toString(),
      role: 'user',
      text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setIsAgentTyping(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: text }),
      });
      if (!res.ok) throw new Error('Agent failed to respond');
      const data = await res.json();

      const agentMsg: ChatMessage = {
        id: Math.random().toString(),
        role: 'agent',
        text: data.reply || 'No response recorded.',
        timestamp: Date.now(),
        action: data.action,
        citations: data.citations,
      };
      setMessages((prev) => [...prev, agentMsg]);

      if (
        text.toLowerCase().includes('spent') ||
        text.toLowerCase().includes('pay') ||
        text.toLowerCase().includes('usd')
      ) {
        loadFacts(userId);
        loadPayments(userId);
        loadStatus(userId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Chat error';
      addToast(msg, 'error');
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          role: 'agent',
          text: `Error connecting to agent: ${msg}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsAgentTyping(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setReceiptStatus('Uploading receipt...');
    setReceiptDetail(null);
    const formData = new FormData();
    formData.append('receipt', file);
    formData.append('userId', userId);

    try {
      const res = await fetch('/api/receipts', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Receipt upload failed');
      const data = await res.json();
      addToast('Receipt uploaded and queued for background OCR', 'success');
      // Poll the local queue record only (not a blockchain endpoint): every
      // 3s, up to 60s. The record honestly stays "queued" until a vision
      // provider fills the OCR text, so a timeout ends in an honest
      // "still queued" state, never an invented read result.
      const pollId = ++receiptPollId.current;
      const sha = data.receiptSha256 as string;
      let terminal = false;
      for (let attempt = 0; attempt < 20 && !terminal; attempt++) {
        if (pollId !== receiptPollId.current) return;
        setReceiptStatus('Receipt queued for background OCR...');
        await new Promise((r) => setTimeout(r, 3000));
        if (pollId !== receiptPollId.current) return;
        try {
          const statusRes = await fetch(`/api/receipts/${sha}`);
          if (!statusRes.ok) throw new Error('Receipt status unavailable');
          const detail = await statusRes.json();
          if (detail.status === 'done' || detail.status === 'failed') {
            setReceiptDetail(detail);
            setReceiptStatus(null);
            terminal = true;
          } else {
            setReceiptDetail(detail);
          }
        } catch {
          setReceiptStatus(null);
          setReceiptDetail({
            status: 'failed',
            merchant: null,
            amountUsd: null,
            error: 'Receipt status unavailable.',
          });
          terminal = true;
        }
      }
      if (!terminal && pollId === receiptPollId.current) {
        setReceiptStatus(null);
        setReceiptDetail({
          status: 'timeout',
          merchant: null,
          amountUsd: null,
          error:
            'Still queued after 60s: the OCR vision provider is not configured yet, so no text was extracted. Nothing was faked.',
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload error';
      setReceiptStatus(null);
      addToast(msg, 'error');
    }
  };

  const handleWipeCache = async () => {
    setIsWiping(true);
    try {
      const res = await fetch('/api/test/wipe-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error('Wipe cache failed');
      const data = await res.json();
      setShowWipeConfirm(false);
      await loadFacts(userId);
      addToast(
        `Cache cleared! Restored ${data.factsRestored ?? 0} facts directly from Walrus.`,
        'success'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Wipe error';
      addToast(msg, 'error');
    } finally {
      setIsWiping(false);
    }
  };

  const handleBuildAllowance = async () => {
    setIsBuildingAllowance(true);
    setAllowanceTxResult(null);
    try {
      const res = await fetch('/api/allowance/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          lifetimeCapUsd: parseFloat(allowanceCapInput) || 50,
          expirationDays: parseInt(allowanceDaysInput, 10) || 30,
        }),
      });
      if (!res.ok) throw new Error('Failed to build allowance transaction');
      const data = await res.json();
      setAllowanceTxResult(data);
      addToast('Unsigned allowance transaction built successfully', 'success');
      loadStatus(userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Allowance build error';
      addToast(msg, 'error');
    } finally {
      setIsBuildingAllowance(false);
    }
  };

  const handleRevokeAllowance = async () => {
    if (!status?.allowanceId) return;
    setIsRevoking(true);
    try {
      const res = await fetch('/api/allowance/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          allowanceCapId: status.allowanceId,
        }),
      });
      if (!res.ok) throw new Error('Failed to revoke allowance');
      await res.json();
      setShowRevokeConfirm(false);
      addToast('Allowance revoked successfully onchain', 'success');
      loadStatus(userId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Revoke error';
      addToast(msg, 'error');
    } finally {
      setIsRevoking(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
    addToast('Copied to clipboard', 'info');
  };

  const spendingProfileFact = facts.find(
    (f) => f.subject.toLowerCase() === 'spending profile'
  );
  const otherFacts = facts.filter(
    (f) => f.subject.toLowerCase() !== 'spending profile'
  );
  const budgetRiskFacts = facts.filter((f) => f.factType === 'budget_risk');

  const suggestionChips = [
    'I spent 12.50 USD on GrabFood',
    'What do you know about my coffee habit?',
    'Pay 0.01 USD to the agent wallet',
    'What is my spending profile?',
    'Any budget risks this month?',
    'Show my recent agent payments',
  ];

  return (
    <div className="min-h-screen bg-primary text-primary flex flex-col font-sans selection:bg-brand-solid selection:text-primary-on-brand">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-sm max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-start gap-sm rounded-lg border border-secondary bg-primary p-lg shadow-lg text-sm text-secondary transition-all animate-in fade-in slide-in-from-top-2"
          >
            {toast.type === 'error' && (
              <AlertTriangle className="mt-xxs size-4 shrink-0 text-fg-error-primary" />
            )}
            {toast.type === 'success' && (
              <Check className="mt-xxs size-4 shrink-0 text-fg-success-primary" />
            )}
            {toast.type === 'info' && (
              <Info className="mt-xxs size-4 shrink-0 text-fg-brand-primary" />
            )}
            <p className="flex-1 text-sm text-secondary">{toast.text}</p>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-tertiary hover:text-primary p-xxs ml-xs shrink-0"
              aria-label="Dismiss toast"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* 1. Hero Header */}
      <header className="border-b border-secondary bg-secondary px-xl py-lg">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-md">
          <div>
            <div className="flex items-center gap-md">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary border border-secondary">
                <Shield className="size-5 shrink-0 text-fg-brand-primary" aria-hidden="true" />
              </span>
              <div>
                <h1 className="text-heading-sm font-bold tracking-tight text-primary">
                  VOTOI
                </h1>
                <p className="text-secondary text-sm">
                  An expense watchdog that remembers everything and can pay within limits you set onchain
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-xs mt-sm">
              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                <Database className="size-3 shrink-0" />
                Memory: Walrus Mainnet
              </span>
              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                <Cpu className="size-3 shrink-0" />
                RPC: Tatum Sui Gateway
              </span>
              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                <Lock className="size-3 shrink-0" />
                Payments: Sui allowance (x402-style)
              </span>
            </div>
          </div>

          <div className="flex items-center gap-sm">
            <button
              onClick={() => setDemoActive(!demoActive)}
              className={`inline-flex items-center gap-sm rounded-lg px-lg py-sm text-sm font-semibold shadow-xs focus-visible:ring-2 focus-visible:ring-focus-ring transition-colors ${
                demoActive
                  ? 'bg-brand-solid text-primary-on-brand border border-transparent hover:bg-brand-solid-hover'
                  : 'bg-primary text-secondary border border-primary hover:bg-primary-hover'
              }`}
            >
              <Play className="size-4 shrink-0" />
              Demo script
            </button>
          </div>
        </div>

        {/* User address settings row */}
        <div className="max-w-7xl mx-auto mt-md pt-sm border-t border-secondary flex flex-wrap items-center justify-between gap-sm text-xs">
          <div className="flex items-center gap-xs">
            <span className="text-tertiary">User Wallet:</span>
            {isEditingUser ? (
              <div className="flex items-center gap-xs">
                <input
                  type="text"
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  className="rounded-md bg-primary px-lg py-sm text-sm text-primary font-mono placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring w-80"
                />
                <button
                  onClick={() => {
                    setUserId(walletInput.trim());
                    setIsEditingUser(false);
                    addToast('User address updated', 'info');
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setWalletInput(userId);
                    setIsEditingUser(false);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-xs">
                <span className="font-mono text-primary bg-primary px-md py-xxs rounded-md border border-secondary text-xs">
                  {userId}
                </span>
                <button
                  onClick={() => setIsEditingUser(true)}
                  className="text-brand-primary hover:underline px-xs text-xs font-medium"
                >
                  Edit
                </button>
                <div className="relative group inline-block">
                  <button
                    onClick={() => copyToClipboard(userId, 'user-address')}
                    className="text-tertiary hover:text-primary p-xxs"
                    aria-label="Copy user address"
                  >
                    {copiedId === 'user-address' ? (
                      <Check className="size-3.5 text-fg-success-primary" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-xs hidden group-hover:block z-10">
                    <div className="rounded-md bg-primary-solid px-lg py-md text-xs font-semibold text-fg-white whitespace-nowrap">
                      Copy user address
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-md">
            <div className="flex items-center gap-xs text-xs">
              <span className="text-tertiary">Walrus Relayer:</span>
              <span
                className={`inline-flex items-center gap-xs rounded-full px-md py-xxs text-xs font-medium border ${
                  status?.relayerStatus === 'healthy'
                    ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                    : 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                }`}
              >
                <span
                  className={`size-2 rounded-full ${
                    status?.relayerStatus === 'healthy' ? 'bg-success-primary' : 'bg-warning-primary'
                  }`}
                />
                {status?.relayerStatus ?? 'healthy'}
              </span>
            </div>
            <button
              onClick={() => {
                loadStatus(userId);
                loadFacts(userId);
                loadPayments(userId);
                addToast('Data refreshed', 'info');
              }}
              className="inline-flex items-center gap-xs rounded-lg bg-primary px-md py-xs text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring transition-colors"
            >
              <RefreshCw className="size-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {/* 5. Demo Mode Walkthrough Bar */}
      {demoActive && (
        <section className="bg-secondary border-b border-brand px-xl py-sm transition-all animate-in fade-in">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-sm">
            <div className="flex items-center gap-sm">
              <span className="font-semibold text-brand-primary text-xs tracking-wider uppercase">
                Demo Script Beat {demoStep} of 5:
              </span>
              <span className="text-sm font-medium text-primary">
                {demoStep === 1 && '1. Tell VOTOI about an expense in chat to trigger autonomous extraction.'}
                {demoStep === 2 && '2. Inspect the newly formed memory fact and its cryptographic Walrus blob.'}
                {demoStep === 3 && '3. Wipe local application cache to prove persistence lives on Walrus.'}
                {demoStep === 4 && '4. Issue an onchain allowance and pay 0.01 USD within set limits.'}
                {demoStep === 5 && '5. Upload a receipt and follow its async OCR status.'}
              </span>
            </div>

            <div className="flex items-center gap-xs">
              {demoStep === 1 && (
                <button
                  onClick={() => {
                    handleSendChat('I spent 12.50 USD on GrabFood');
                    setDemoStep(2);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Go: Send Expense
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              {demoStep === 2 && (
                <button
                  onClick={() => {
                    loadFacts(userId);
                    setDemoStep(3);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Go: Verify Memory
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              {demoStep === 3 && (
                <button
                  onClick={() => {
                    setShowWipeConfirm(true);
                    setDemoStep(4);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Go: Open Wipe Dialog
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              {demoStep === 4 && (
                <button
                  onClick={() => {
                    handleSendChat('Pay 0.01 USD to the agent wallet');
                    setDemoStep(5);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Go: Trigger Allowance Payment
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              {demoStep === 5 && (
                <button
                  onClick={() => {
                    document
                      .getElementById('chat-panel')
                      ?.scrollIntoView({ behavior: 'smooth' });
                    setDemoStep(1);
                  }}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Go: Open Receipt Upload
                  <ArrowRight className="size-3.5" />
                </button>
              )}
              <button
                onClick={() => setDemoStep((s) => (s % 5) + 1)}
                className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Skip Beat
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Main Content Layout: Responsive 3 panels on desktop, stacked on mobile */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-lg md:p-xl grid grid-cols-1 lg:grid-cols-12 gap-lg">
        {/* Panel 1: Chat (Widest, lg:col-span-5) */}
        <section
          id="chat-panel"
          className={`lg:col-span-5 flex flex-col rounded-xl border bg-primary p-xl shadow-xs min-h-[600px] ${
            demoActive && (demoStep === 1 || demoStep === 5) ? 'border-brand ring-2 ring-focus-ring' : 'border-secondary'
          }`}
        >
          <div className="pb-md border-b border-secondary flex items-center justify-between">
            <div className="flex items-center gap-xs">
              <Shield className="size-4 shrink-0 text-fg-brand-primary" />
              <h2 className="text-sm font-semibold text-primary">Expense Watchdog Chat</h2>
            </div>
            <span className="text-xs text-tertiary">Real-time reasoning</span>
          </div>

          {/* Messages list */}
          <div className="flex-1 py-md overflow-y-auto space-y-md">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${
                  m.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[88%] rounded-lg p-lg text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-brand-solid text-primary-on-brand shadow-xs'
                      : 'bg-secondary border border-secondary text-primary'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.text}</p>
                </div>
                {m.role === 'agent' && m.action === 'payment_needs_approval' && (
                  <div className="max-w-[88%] mt-xs rounded-lg border border-utility-warning-200 bg-utility-warning-50 p-md text-xs text-utility-warning-700">
                    Over the 50.00 USD single-transaction limit — needs your
                    approval, not sent onchain. No approval action exists yet,
                    so nothing was sent.
                  </div>
                )}
                {m.role === 'agent' && m.citations && m.citations.length > 0 && (
                  <div className="max-w-[88%] mt-xs text-[11px] text-tertiary space-y-xxs">
                    <span className="font-medium text-secondary">
                      Sources (Walrus):
                    </span>
                    {m.citations.map((c, i) => (
                      <div key={i} className="flex items-center gap-xs font-mono">
                        <span className="font-sans text-secondary">{c.subject}</span>
                        <span>
                          {c.blobId ? `${c.blobId.slice(0, 10)}...` : 'no blob id'}
                        </span>
                        {c.blobId && (
                          <button
                            onClick={() =>
                              copyToClipboard(c.blobId, `cite-${m.id}-${i}`)
                            }
                            className="text-secondary hover:text-primary"
                            aria-label="Copy Walrus blob ID"
                          >
                            {copiedId === `cite-${m.id}-${i}` ? (
                              <Check className="size-3.5 text-fg-success-primary" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <span className="text-[10px] text-tertiary mt-xxs px-xs">
                  {new Date(m.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            ))}

            {isAgentTyping && (
              <div className="flex items-center gap-xs text-secondary text-xs p-md bg-secondary rounded-lg max-w-fit border border-secondary animate-pulse">
                <span className="size-1.5 bg-brand-solid rounded-full animate-bounce" />
                <span className="size-1.5 bg-brand-solid rounded-full animate-bounce [animation-delay:0.2s]" />
                <span className="size-1.5 bg-brand-solid rounded-full animate-bounce [animation-delay:0.4s]" />
                <span className="ml-xs">VOTOI is reviewing Walrus memory...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Suggestion Chips */}
          <div className="py-sm border-t border-secondary overflow-x-auto no-scrollbar">
            <div className="flex gap-xs whitespace-nowrap">
              {suggestionChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendChat(chip)}
                  disabled={isAgentTyping}
                  className="inline-flex items-center rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 hover:bg-brand-solid hover:text-primary-on-brand transition-colors shrink-0 disabled:opacity-50"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          {/* Receipt Upload Dropzone & Status */}
          <div className="py-xs border-t border-secondary flex items-center justify-between text-xs">
            <label className="inline-flex items-center gap-xs cursor-pointer text-secondary hover:text-primary transition-colors">
              <Upload className="size-3.5 shrink-0 text-fg-brand-primary" />
              <span>Drop receipt (image/PDF)</span>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
            {receiptStatus && (
              <span className="text-brand-primary font-medium flex items-center gap-xxs animate-pulse">
                <FileText className="size-3 shrink-0" />
                {receiptStatus}
              </span>
            )}
          </div>

          {/* Receipt OCR result (live queue record, never invented) */}
          {receiptDetail && (
            <div
              className={`py-xs px-md rounded-lg border text-xs ${
                receiptDetail.status === 'done'
                  ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                  : receiptDetail.status === 'failed' || receiptDetail.status === 'timeout'
                  ? 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                  : 'border-secondary bg-secondary text-secondary'
              }`}
            >
              {receiptDetail.status === 'done' && (
                <span>
                  Receipt read: {receiptDetail.merchant} — $
                  {receiptDetail.amountUsd?.toFixed(2)} USD. A fact will be
                  learned from it.
                </span>
              )}
              {(receiptDetail.status === 'queued' ||
                receiptDetail.status === 'processing') && (
                <span>Receipt in OCR queue — status updates here when text is extracted.</span>
              )}
              {(receiptDetail.status === 'failed' ||
                receiptDetail.status === 'timeout') && (
                <span>{receiptDetail.error}</span>
              )}
            </div>
          )}

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChat();
            }}
            className="pt-md border-t border-secondary flex gap-xs"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Tell VOTOI about an expense or ask about patterns..."
              disabled={isAgentTyping}
              className="flex-1 rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || isAgentTyping}
              className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            >
              <Send className="size-4 shrink-0" />
            </button>
          </form>
        </section>

        {/* Panel 2: Memory ("What VOTOI remembers", lg:col-span-4) */}
        <section
          id="memory-panel"
          className={`lg:col-span-4 flex flex-col rounded-xl border bg-primary p-xl shadow-xs ${
            demoActive && (demoStep === 2 || demoStep === 3)
              ? 'border-brand ring-2 ring-focus-ring'
              : 'border-secondary'
          }`}
        >
          <div className="pb-md border-b border-secondary flex items-center justify-between">
            <div className="flex items-center gap-xs">
              <Database className="size-4 shrink-0 text-fg-brand-primary" />
              <h2 className="text-sm font-semibold text-primary">What VOTOI remembers</h2>
            </div>
            <button
              onClick={() => setShowWipeConfirm(true)}
              disabled={isWiping}
              className="inline-flex items-center gap-sm rounded-lg bg-primary px-md py-xs text-xs font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              Wipe cache & rehydrate
            </button>
          </div>

          <div className="flex-1 py-md overflow-y-auto space-y-md">
            {/* Walrus proof strip: facts live on Walrus Memory Mainnet,
                not in the app database — the wipe button below proves it. */}
            {!factsLoading && !factsError && facts.length > 0 && (
              <div className="rounded-lg border border-secondary bg-secondary px-md py-sm text-xs text-secondary flex flex-wrap items-center gap-x-lg gap-y-xxs">
                <span>
                  <span className="font-semibold text-primary">{facts.length}</span> facts
                  {' '}· Walrus Memory Mainnet
                </span>
                <span>
                  Relayer: {status?.relayerStatus ?? 'unknown'}
                </span>
              </div>
            )}

            {/* Budget-risk summary: aggregates budget_risk facts so the
                "Any budget risks this month?" question has a visible answer. */}
            {!factsLoading && !factsError && facts.length > 0 && (
              <div className="rounded-xl border border-utility-error-200 bg-utility-error-50 p-xl shadow-xs space-y-xs">
                <span className="text-xs font-semibold uppercase tracking-wider text-utility-error-700">
                  This month&apos;s risks
                </span>
                {budgetRiskFacts.length > 0 ? (
                  <ul className="list-disc pl-md space-y-xxs">
                    {budgetRiskFacts.map((f, i) => (
                      <li key={i} className="text-xs text-primary">
                        {f.subject}
                        <span className="text-tertiary"> — {f.pattern}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-secondary">No budget risks recorded.</p>
                )}
              </div>
            )}

            {factsLoading && (
              <div className="space-y-sm">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="space-y-xs p-md rounded-lg border border-secondary bg-secondary">
                    <div className="h-4 w-1/3 animate-pulse rounded-xs bg-tertiary" />
                    <div className="h-3 w-3/4 animate-pulse rounded-xs bg-tertiary" />
                    <div className="h-3 w-1/2 animate-pulse rounded-xs bg-tertiary" />
                  </div>
                ))}
              </div>
            )}

            {factsError && (
              <div className="flex gap-lg rounded-xl bg-utility-error-50 p-xl">
                <AlertTriangle className="mt-xxs size-5 shrink-0 text-utility-error-600" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-utility-error-600">Could not load memory facts</p>
                  <p className="mt-xxs text-sm text-tertiary">{factsError}</p>
                </div>
              </div>
            )}

            {!factsLoading && !factsError && facts.length === 0 && (
              <div className="text-center py-xl space-y-xs flex flex-col items-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
                  <Database className="size-6 shrink-0 text-fg-secondary" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold text-primary mt-sm">No memory facts recorded yet</p>
                <p className="text-xs text-tertiary">
                  Send an expense in chat to teach VOTOI a new habit.
                </p>
              </div>
            )}

            {/* Highlighted Card: Spending Profile */}
            {spendingProfileFact && (
              <div className="rounded-xl border border-utility-brand-200 bg-utility-brand-50 p-xl shadow-xs space-y-xs">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-brand-solid px-md py-xxs text-xs font-semibold uppercase tracking-wider text-primary-on-brand">
                    Spending Profile
                  </span>
                  <span className="text-xs text-secondary font-mono">
                    rev #{spendingProfileFact.revision}
                  </span>
                </div>
                <p className="text-sm font-medium text-primary mt-xs">
                  {spendingProfileFact.pattern}
                </p>
                <p className="text-xs text-secondary">{spendingProfileFact.rule}</p>
                <div className="pt-xs border-t border-utility-brand-200 flex items-center justify-between text-xs font-mono text-tertiary">
                  <span>Walrus: {spendingProfileFact.walrusBlobId.slice(0, 10)}...</span>
                  <div className="relative group inline-block">
                    <button
                      onClick={() =>
                        copyToClipboard(spendingProfileFact.walrusBlobId, 'fact-profile')
                      }
                      className="text-secondary hover:text-primary"
                      aria-label="Copy Walrus blob ID"
                    >
                      {copiedId === 'fact-profile' ? (
                        <Check className="size-3.5 text-fg-success-primary" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-xs hidden group-hover:block z-10">
                      <div className="rounded-md bg-primary-solid px-lg py-md text-xs font-semibold text-fg-white whitespace-nowrap">
                        Copy Walrus blob ID
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Other Facts */}
            {otherFacts.map((fact, idx) => {
              const badgeStyle =
                fact.factType === 'budget_risk'
                  ? 'border-utility-error-200 bg-utility-error-50 text-utility-error-700'
                  : fact.factType === 'payment_rule'
                  ? 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                  : fact.factType === 'preference'
                  ? 'border-utility-gray-200 bg-utility-gray-50 text-utility-gray-700'
                  : 'border-utility-brand-200 bg-utility-brand-50 text-utility-brand-700';

              return (
                <div
                  key={idx}
                  className="rounded-xl border border-secondary bg-secondary p-xl shadow-xs space-y-xs"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium uppercase tracking-wider ${badgeStyle}`}
                    >
                      {fact.factType.replace('_', ' ')}
                    </span>
                    <span className="text-xs text-tertiary font-mono">
                      rev #{fact.revision}
                    </span>
                  </div>
                  <h3 className="text-sm font-medium text-primary">{fact.subject}</h3>
                  <p className="text-xs text-secondary">{fact.pattern}</p>
                  <p className="text-xs text-tertiary italic">{fact.rule}</p>
                  <div className="pt-xs border-t border-secondary flex items-center justify-between text-[11px] font-mono text-tertiary">
                    <span>Blob: {fact.walrusBlobId.slice(0, 10)}...</span>
                    <div className="relative group inline-block">
                      <button
                        onClick={() => copyToClipboard(fact.walrusBlobId, `fact-${idx}`)}
                        className="text-secondary hover:text-primary"
                        aria-label="Copy blob ID"
                      >
                        {copiedId === `fact-${idx}` ? (
                          <Check className="size-3.5 text-fg-success-primary" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                      </button>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-xs hidden group-hover:block z-10">
                        <div className="rounded-md bg-primary-solid px-lg py-md text-xs font-semibold text-fg-white whitespace-nowrap">
                          Copy blob ID
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Panel 3: Agent Payments (lg:col-span-3) */}
        <section
          id="payments-panel"
          className={`lg:col-span-3 flex flex-col rounded-xl border bg-primary p-xl shadow-xs ${
            demoActive && demoStep === 4
              ? 'border-brand ring-2 ring-focus-ring'
              : 'border-secondary'
          }`}
        >
          <div className="pb-md border-b border-secondary flex items-center justify-between">
            <div className="flex items-center gap-xs">
              <DollarSign className="size-4 shrink-0 text-fg-brand-primary" />
              <h2 className="text-sm font-semibold text-primary">Agent payments</h2>
            </div>
            <span className="text-xs font-mono text-tertiary">x402-style</span>
          </div>

          <div className="flex-1 py-md overflow-y-auto space-y-md">
            {/* Allowance Summary Card */}
            <div className="rounded-xl border border-secondary bg-secondary p-xl shadow-xs space-y-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-secondary uppercase tracking-wider">
                  Sui Allowance
                </span>
                {status?.allowanceId ? (
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                    Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                    None
                  </span>
                )}
              </div>

              {status?.chainReadsUnavailable && (
                <p className="text-xs text-secondary">
                  Live chain reads via the Tatum gateway are currently unavailable
                  for this key, so cap and balance show as unknown. Spent totals
                  below come from the local ledger.
                </p>
              )}
              <div className="grid grid-cols-2 gap-sm text-xs">
                <div>
                  <span className="text-tertiary block">Lifetime Cap:</span>
                  <span className="text-primary font-semibold text-sm">
                    ${status && status.lifetimeCapUsd != null ? status.lifetimeCapUsd.toFixed(2) : '—'} USD
                  </span>
                </div>
                <div>
                  <span className="text-tertiary block">Spent:</span>
                  <span className="text-primary font-semibold text-sm">
                    ${status ? status.spentUsd.toFixed(2) : '0.00'} USD
                  </span>
                </div>
                <div>
                  <span className="text-tertiary block">Agent Balance:</span>
                  <span className="text-primary font-semibold text-sm">
                    ${status && status.agentBalanceUsd != null ? status.agentBalanceUsd.toFixed(2) : '—'} USD
                  </span>
                </div>
                <div>
                  <span className="text-tertiary block">Expiration:</span>
                  <span className="text-secondary text-xs">
                    {status && status.expirationMs && status.expirationMs > 0
                      ? new Date(status.expirationMs).toLocaleDateString()
                      : 'Expired / None'}
                  </span>
                </div>
              </div>

              {status?.lifetimeCapUsd != null && (
                <div className="space-y-xs">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-tertiary">Remaining:</span>
                    <span className="text-primary font-semibold">
                      ${(status.lifetimeCapUsd - status.spentUsd).toFixed(2)} USD
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-tertiary overflow-hidden">
                    <div
                      className="h-full bg-brand-solid"
                      style={{
                        width: `${Math.min(
                          100,
                          (status.spentUsd / status.lifetimeCapUsd) * 100
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              <p className="text-[11px] text-tertiary leading-normal">
                Funds stay in your balance until a spend succeeds — no escrow,
                no pre-funding. The agent pays through your allowance,
                x402-style, and only inside its onchain limits.
              </p>

              {status?.allowanceId && (
                <button
                  onClick={() => setShowRevokeConfirm(true)}
                  disabled={isRevoking}
                  className="w-full mt-xs inline-flex items-center justify-center gap-sm rounded-lg border border-utility-error-200 bg-utility-error-50 px-lg py-sm text-sm font-semibold text-utility-error-700 hover:bg-utility-error-50 focus-visible:ring-2 focus-visible:ring-focus-ring-error transition-colors"
                >
                  Revoke allowance
                </button>
              )}
            </div>

            {/* Issue Allowance Section */}
            <div className="rounded-xl border border-secondary bg-secondary p-xl shadow-xs space-y-sm">
              <span className="text-xs font-semibold text-secondary uppercase tracking-wider block">
                Issue Allowance
              </span>
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">Cap (USD)</label>
                <input
                  type="number"
                  value={allowanceCapInput}
                  onChange={(e) => setAllowanceCapInput(e.target.value)}
                  className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  placeholder="50.00"
                />
              </div>
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">Expiration (days)</label>
                <input
                  type="number"
                  value={allowanceDaysInput}
                  onChange={(e) => setAllowanceDaysInput(e.target.value)}
                  className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  placeholder="30"
                />
              </div>
              <button
                onClick={handleBuildAllowance}
                disabled={isBuildingAllowance}
                className="w-full inline-flex items-center justify-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
              >
                {isBuildingAllowance ? 'Building...' : 'Build allowance transaction'}
              </button>

              {allowanceTxResult && (
                <div className="p-sm rounded-md bg-primary border border-brand text-[11px] space-y-xs">
                  <p className="text-secondary">{allowanceTxResult.note}</p>
                  <div className="font-mono text-tertiary break-all">
                    Bytes: {allowanceTxResult.unsignedTxBytes.slice(0, 32)}...
                  </div>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        allowanceTxResult.unsignedTxBytes,
                        'unsigned-allowance-bytes'
                      )
                    }
                    className="text-brand-primary hover:underline font-medium"
                  >
                    Copy unsigned bytes
                  </button>
                </div>
              )}
            </div>

            {/* Payment History List */}
            <div className="space-y-xs">
              <span className="text-xs font-semibold text-secondary uppercase tracking-wider block">
                Payment History
              </span>

              {paymentsLoading && (
                <div className="h-16 w-full animate-pulse rounded-xs bg-tertiary" />
              )}

              {paymentsError && (
                <div className="flex gap-lg rounded-xl bg-utility-error-50 p-md">
                  <p className="text-xs text-utility-error-600">{paymentsError}</p>
                </div>
              )}

              {!paymentsLoading && payments.length === 0 && (
                <p className="text-xs text-tertiary text-center py-md">
                  No allowance payments executed yet.
                </p>
              )}

              {payments.map((p, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-secondary bg-secondary p-md shadow-xs text-xs space-y-xxs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">
                      ${p.amountUsd.toFixed(2)} USD
                    </span>
                    <span
                      className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium uppercase ${
                        p.status === 'settled'
                          ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                          : p.status === 'awaiting_approval'
                          ? 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
                          : p.status === 'failed' || p.status === 'blocked'
                          ? 'border-utility-error-200 bg-utility-error-50 text-utility-error-700'
                          : 'border-utility-gray-200 bg-utility-gray-50 text-utility-gray-700'
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                  {p.status === 'awaiting_approval' && (
                    <p className="text-utility-warning-700">
                      Not sent onchain — awaiting your approval (over the 50.00 USD
                      single-transaction limit).
                    </p>
                  )}
                  {p.failureReason && (
                    <p className="text-utility-error-600">{p.failureReason}</p>
                  )}
                  <div className="flex items-center justify-between text-tertiary text-[11px]">
                    <span className="font-mono">
                      To: {p.recipient.slice(0, 6)}...{p.recipient.slice(-4)}
                    </span>
                    {p.digest ? (
                      <a
                        href={`https://suiscan.xyz/mainnet/tx/${p.digest}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-xxs text-brand-primary hover:underline font-medium"
                      >
                        SuiScan
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <span>No onchain digest (not sent)</span>
                    )}
                  </div>
                  {p.recipients && p.recipients.length > 1 && (
                    <div className="text-tertiary text-[11px] space-y-xxs">
                      <span>Split across {p.recipients.length} recipients:</span>
                      {p.recipients.map((r, i) => (
                        <div key={i} className="font-mono">
                          {r.address.slice(0, 6)}...{r.address.slice(-4)} — $
                          {r.amountUsd.toFixed(2)} USD
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Security Guarantee Note */}
            <div className="rounded-xl border border-secondary bg-secondary p-md text-[11px] text-tertiary leading-normal">
              <span className="font-medium text-secondary block mb-xxs">
                Guaranteed Onchain Safety:
              </span>
              The agent can only spend inside the onchain allowance limits, and never more than 50.00 USD in one transaction. Larger amounts require your approval.
            </div>
          </div>
        </section>
      </main>

      {/* Wipe Cache Confirm Dialog */}
      {showWipeConfirm && (
        <>
          <div
            className="fixed inset-0 bg-overlay opacity-70 z-40"
            onClick={() => setShowWipeConfirm(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-md pointer-events-none">
            <div className="pointer-events-auto flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-primary shadow-2xl border border-secondary">
              <header className="flex items-start justify-between gap-lg border-b border-secondary p-xl">
                <div className="flex items-center gap-sm">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-utility-warning-50 text-utility-warning-600">
                    <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
                  </span>
                  <h2 className="text-lg font-semibold text-primary">
                    Wipe cache and rehydrate from Walrus?
                  </h2>
                </div>
                <button
                  onClick={() => setShowWipeConfirm(false)}
                  className="text-tertiary hover:text-primary p-xxs"
                  aria-label="Close dialog"
                >
                  <X className="size-4" />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-xl text-sm text-secondary leading-relaxed">
                This proves memory lives permanently on Walrus, not in the local application database. The local cache will be destroyed, and all facts will be re-fetched directly from the decentralized Walrus blob store.
              </div>
              <footer className="flex justify-end gap-sm border-t border-secondary p-xl">
                <button
                  onClick={() => setShowWipeConfirm(false)}
                  disabled={isWiping}
                  className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </button>
                <button
                  onClick={handleWipeCache}
                  disabled={isWiping}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {isWiping ? 'Rehydrating from Walrus...' : 'Confirm Wipe & Rehydrate'}
                </button>
              </footer>
            </div>
          </div>
        </>
      )}

      {/* Revoke Allowance Confirm Dialog */}
      {showRevokeConfirm && (
        <>
          <div
            className="fixed inset-0 bg-overlay opacity-70 z-40"
            onClick={() => setShowRevokeConfirm(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-md pointer-events-none">
            <div className="pointer-events-auto flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-primary shadow-2xl border border-secondary">
              <header className="flex items-start justify-between gap-lg border-b border-secondary p-xl">
                <div className="flex items-center gap-sm">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-utility-error-50 text-utility-error-600">
                    <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
                  </span>
                  <h2 className="text-lg font-semibold text-primary">
                    Revoke Sui Allowance?
                  </h2>
                </div>
                <button
                  onClick={() => setShowRevokeConfirm(false)}
                  className="text-tertiary hover:text-primary p-xxs"
                  aria-label="Close dialog"
                >
                  <X className="size-4" />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-xl text-sm text-secondary leading-relaxed">
                This calls the onchain Sui smart contract to cancel the agent&apos;s spending capability immediately. Once revoked, the agent cannot execute any future automated payments for this wallet until a new allowance is issued.
                <p className="mt-sm text-utility-warning-700">
                  Note: revocation is not wired in this build yet — the Move
                  revoke entry point has not been verified live, so this
                  request currently returns an honest 501 error.
                </p>
              </div>
              <footer className="flex justify-end gap-sm border-t border-secondary p-xl">
                <button
                  onClick={() => setShowRevokeConfirm(false)}
                  disabled={isRevoking}
                  className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRevokeAllowance}
                  disabled={isRevoking}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-error-primary px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:opacity-90 focus-visible:ring-2 focus-visible:ring-focus-ring-error disabled:opacity-50"
                >
                  {isRevoking ? 'Revoking onchain...' : 'Confirm Revoke'}
                </button>
              </footer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
