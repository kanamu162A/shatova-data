// utils/remark.js
// ============================================================
// Human-friendly remarks for every transaction state
// ============================================================

function naira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function networkLabel(key) {
  const k = String(key || '').toLowerCase();
  if (k === 'mtn') return 'MTN';
  if (k === 'airtel') return 'Airtel';
  if (k === 'glo') return 'Glo';
  if (k === 't2' || k === '9mobile' || k === 'etisalat') return '9mobile';
  return k.toUpperCase();
}

/* ============================================================
   SUCCESS
   ============================================================ */
export function remarkSuccess({ service = 'airtime', network, phone, amount, discount = 0 }) {
  const label = service === 'data' ? 'Data' : 'Airtime';
  const saved = discount > 0 ? ` You saved ${naira(discount)}.` : '';
  return `${label} sent to ${phone} successfully.${saved}`;
}

/* ============================================================
   PROCESSING
   ============================================================ */
export function remarkProcessing({ network, phone, service = 'airtime' }) {
  const net = networkLabel(network);
  const label = service === 'data' ? 'data' : 'airtime';
  return `${net} is processing your ${label} request for ${phone}. This usually takes under 2 minutes. We'll update this automatically.`;
}

/* ============================================================
   FAILED
   ============================================================ */
export function remarkFailed({
  code,
  providerMessage,
  network,
  phone,
  amount,
  service = 'airtime',
  refunded = false,
}) {
  const net = networkLabel(network);
  const label = service === 'data' ? 'data' : 'airtime';
  const refundNote = refunded
    ? ` Your ${naira(amount)} has been returned to your wallet.`
    : '';

  switch (code) {
    case 'NETWORK_MISMATCH':
      return providerMessage ||
        `This phone number doesn't belong to ${net}. Please select the correct network and try again.`;
    case 'INSUFFICIENT_BALANCE':
      return providerMessage ||
        `Your wallet balance is too low for this purchase. Please fund your wallet and try again.`;
    case 'DAILY_LIMIT_EXCEEDED':
      return providerMessage ||
        `You've reached your daily spending limit. Try again tomorrow or contact support.`;
    case 'INVALID_PHONE':
      return 'Please check the phone number and try again.';
    case 'AMOUNT_TOO_LOW':
    case 'AMOUNT_TOO_HIGH':
      return providerMessage || 'The amount is outside the allowed range.';
    case 'PROVIDER_FAILED':
      return `${net} rejected the transaction.${refundNote} Please try again.`;
    case 'PROVIDER_TIMEOUT':
      return `${net}'s network was slow and didn't confirm in time.${refundNote} Please try again in a moment.`;
    case 'PROVIDER_NETWORK_ERROR':
      return `We couldn't reach ${net} right now.${refundNote} Please try again shortly.`;
  }

  if (providerMessage) {
    const msg = String(providerMessage).toLowerCase();
    if (msg.includes('insufficient')) {
      return `${net} says the receiving number has insufficient balance.${refundNote}`;
    }
    if (msg.includes('invalid') && msg.includes('number')) {
      return `The phone number doesn't look valid to ${net}. Please double-check it.${refundNote}`;
    }
    if (msg.includes('busy') || msg.includes('try again')) {
      return `${net}'s network was busy.${refundNote} Please try again in a moment.`;
    }
    if (msg.includes('timeout') || msg.includes('time out')) {
      return `${net} didn't respond in time.${refundNote} Please try again.`;
    }
    if (msg.includes('not allowed') || msg.includes('restricted')) {
      return `This transaction isn't allowed by ${net}.${refundNote}`;
    }
    if (msg.includes('network') || msg.includes('unavailable')) {
      return `${net}'s service is temporarily unavailable.${refundNote} Please try again shortly.`;
    }
  }

  return `${net} couldn't complete the ${label} request.${refundNote} Please try again or contact support.`;
}

/* ============================================================
   REFUNDED
   ============================================================ */
export function remarkRefunded({ network, amount, reason }) {
  const net = networkLabel(network);
  const base = `${net} declined the transaction.`;
  const refundLine = ` Your ${naira(amount)} has been returned to your wallet.`;
  const reasonLine = reason ? ` Reason: ${reason}` : '';
  return `${base}${refundLine}${reasonLine}`;
}

/* ============================================================
   BUILD — pick the right one automatically
   ============================================================ */
export function buildRemark({
  status,
  code,
  providerMessage,
  network,
  phone,
  amount,
  service = 'airtime',
  discount = 0,
  refunded = false,
}) {
  const s = String(status || '').toLowerCase();

  if (s === 'success' || s === 'successful') {
    return remarkSuccess({ service, network, phone, amount, discount });
  }
  if (s === 'processing' || s === 'pending') {
    return remarkProcessing({ service, network, phone });
  }
  if (s === 'refunded') {
    return remarkRefunded({ network, amount, reason: providerMessage });
  }
  return remarkFailed({ code, providerMessage, network, phone, amount, service, refunded });
}