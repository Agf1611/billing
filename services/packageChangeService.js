const db = require('../config/database');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const ACTIVE_REQUEST_STATUSES = ['pending', 'approved', 'scheduled', 'processing'];
const COOLDOWN_REQUEST_STATUSES = ['pending', 'approved', 'scheduled', 'processing', 'completed'];
const PORTAL_ALLOWED_ACTIVE_STATUSES = new Set(ACTIVE_REQUEST_STATUSES);
const PACKAGE_CHANGE_COOLDOWN_DAYS = 30;

function nowIso(date = new Date()) {
  return new Date(date).toISOString();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function maxDate(a, b) {
  const da = new Date(a);
  const dbb = new Date(b);
  return da.getTime() >= dbb.getTime() ? da : dbb;
}

function getRequestById(id) {
  return db.prepare(`
    SELECT r.*,
           c.name AS customer_name,
           c.phone AS customer_phone,
           c.package_id AS live_package_id,
           c.isolate_day,
           cp.name AS current_package_name,
           cp.price AS current_package_price,
           tp.name AS target_package_name,
           tp.price AS target_package_price
    FROM package_change_requests r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN packages cp ON cp.id = r.current_package_id
    LEFT JOIN packages tp ON tp.id = r.target_package_id
    WHERE r.id = ?
  `).get(Number(id || 0));
}

function listRequestsByStatus(status = 'pending', limit = 300) {
  return db.prepare(`
    SELECT r.*,
           c.name AS customer_name,
           c.phone AS customer_phone,
           cp.name AS current_package_name,
           tp.name AS target_package_name
    FROM package_change_requests r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN packages cp ON cp.id = r.current_package_id
    LEFT JOIN packages tp ON tp.id = r.target_package_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT ?
  `).all(String(status || 'pending').trim(), Math.max(1, Number(limit || 300)));
}

function countPendingRequests() {
  return Number(db.prepare("SELECT COUNT(1) AS c FROM package_change_requests WHERE status = 'pending'").get()?.c || 0);
}

function getChangeKind(currentPackage, targetPackage) {
  const currentPrice = Number(currentPackage?.price || 0);
  const targetPrice = Number(targetPackage?.price || 0);
  if (targetPrice > currentPrice) return 'upgrade';
  if (targetPrice < currentPrice) return 'downgrade';
  return 'lateral';
}

function getNextBillingCycleAt(customer, baseDate = new Date()) {
  const source = new Date(baseDate);
  const anchorDay = Number(customer?.isolate_day || 10) || 10;

  const currentMonth = source.getMonth() + 1;
  const currentYear = source.getFullYear();
  const currentCycleDay = billingSvc.getEffectiveBillingDay(anchorDay, currentMonth, currentYear);
  const currentCandidate = new Date(currentYear, currentMonth - 1, currentCycleDay, 0, 5, 0, 0);
  if (currentCandidate.getTime() > source.getTime()) return currentCandidate;

  const nextMonthDate = new Date(currentYear, currentMonth, 1, 0, 5, 0, 0);
  const nextMonth = nextMonthDate.getMonth() + 1;
  const nextYear = nextMonthDate.getFullYear();
  const nextCycleDay = billingSvc.getEffectiveBillingDay(anchorDay, nextMonth, nextYear);
  return new Date(nextYear, nextMonth - 1, nextCycleDay, 0, 5, 0, 0);
}

function computeEligibilityAfter(customer, baseDate = new Date()) {
  const cooldownByDays = addDays(baseDate, PACKAGE_CHANGE_COOLDOWN_DAYS);
  const cooldownByBillingCycle = getNextBillingCycleAt(customer, baseDate);
  return maxDate(cooldownByDays, cooldownByBillingCycle);
}

function getActiveRequestForCustomer(customerId) {
  return db.prepare(`
    SELECT r.*,
           cp.name AS current_package_name,
           tp.name AS target_package_name
    FROM package_change_requests r
    LEFT JOIN packages cp ON cp.id = r.current_package_id
    LEFT JOIN packages tp ON tp.id = r.target_package_id
    WHERE r.customer_id = ?
      AND r.status IN (${ACTIVE_REQUEST_STATUSES.map(() => '?').join(',')})
    ORDER BY r.id DESC
    LIMIT 1
  `).get(Number(customerId || 0), ...ACTIVE_REQUEST_STATUSES);
}

function getLatestCooldownRequestForCustomer(customerId) {
  return db.prepare(`
    SELECT r.*,
           cp.name AS current_package_name,
           tp.name AS target_package_name
    FROM package_change_requests r
    LEFT JOIN packages cp ON cp.id = r.current_package_id
    LEFT JOIN packages tp ON tp.id = r.target_package_id
    WHERE r.customer_id = ?
      AND r.status IN (${COOLDOWN_REQUEST_STATUSES.map(() => '?').join(',')})
    ORDER BY COALESCE(r.requested_at, r.created_at) DESC, r.id DESC
    LIMIT 1
  `).get(Number(customerId || 0), ...COOLDOWN_REQUEST_STATUSES);
}

function getPortalPackageChangeState(customerId) {
  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) {
    return {
      customer: null,
      activeRequest: null,
      latestRequest: null,
      nextEligibleAt: null,
      canRequestNow: false,
      reason: 'Data pelanggan tidak ditemukan.'
    };
  }

  const activeRequest = getActiveRequestForCustomer(customerId);
  const latestRequest = getLatestCooldownRequestForCustomer(customerId);
  const nextEligibleAt = latestRequest?.eligibility_after
    ? new Date(latestRequest.eligibility_after)
    : null;
  const now = new Date();
  let canRequestNow = true;
  let reason = '';

  if (activeRequest) {
    canRequestNow = false;
    reason = `Masih ada pengajuan perubahan paket yang sedang ${String(activeRequest.status || '').toLowerCase()}.`;
  } else if (nextEligibleAt && nextEligibleAt.getTime() > now.getTime()) {
    canRequestNow = false;
    reason = 'Perubahan paket berikutnya baru bisa diajukan setelah masa tunggu selesai.';
  }

  return {
    customer,
    activeRequest,
    latestRequest,
    nextEligibleAt,
    canRequestNow,
    reason
  };
}

function validateNewRequest(customerId, targetPackageId) {
  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) throw new Error('Data pelanggan tidak ditemukan.');

  const targetPackage = customerSvc.getPackageById(targetPackageId);
  if (!targetPackage || Number(targetPackage.is_active || 0) !== 1) {
    throw new Error('Paket tujuan tidak tersedia.');
  }
  if (Number(targetPackage.show_in_portal || 0) !== 1) {
    throw new Error('Paket tujuan belum dibuka di portal pelanggan.');
  }
  if (Number(customer.package_id || 0) === Number(targetPackageId || 0)) {
    throw new Error('Paket yang dipilih sudah menjadi paket aktif Anda.');
  }

  const currentPackage = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
  const activeRequest = getActiveRequestForCustomer(customerId);
  if (activeRequest) {
    const targetName = String(activeRequest.target_package_name || '').trim();
    throw new Error(`Masih ada pengajuan perubahan paket yang sedang ${String(activeRequest.status || '').toLowerCase()}${targetName ? ` ke ${targetName}` : ''}.`);
  }

  const latestCooldownRequest = getLatestCooldownRequestForCustomer(customerId);
  if (latestCooldownRequest?.eligibility_after) {
    const eligibilityAt = new Date(latestCooldownRequest.eligibility_after);
    if (eligibilityAt.getTime() > Date.now()) {
      throw new Error(`Perubahan paket berikutnya baru bisa diajukan lagi setelah ${eligibilityAt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}.`);
    }
  }

  return {
    customer,
    currentPackage,
    targetPackage,
    changeKind: getChangeKind(currentPackage, targetPackage)
  };
}

function createRequest(customerId, targetPackageId, options = {}) {
  const { customer, currentPackage, targetPackage, changeKind } = validateNewRequest(customerId, targetPackageId);
  const requestedAt = new Date();
  const eligibilityAfter = computeEligibilityAfter(customer, requestedAt);
  const effectiveAt = changeKind === 'downgrade' ? getNextBillingCycleAt(customer, requestedAt) : requestedAt;
  const requestNote = String(options.requestNote || '').trim()
    || `Pengajuan perubahan paket via portal dari ${currentPackage?.name || '-'} ke ${targetPackage.name}`;
  const requestSource = String(options.requestSource || 'portal').trim() || 'portal';

  const result = db.prepare(`
    INSERT INTO package_change_requests (
      customer_id,
      current_package_id,
      target_package_id,
      change_kind,
      request_source,
      status,
      request_note,
      eligibility_after,
      effective_at,
      requested_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    Number(customerId),
    currentPackage?.id ? Number(currentPackage.id) : null,
    Number(targetPackageId),
    changeKind,
    requestSource,
    requestNote,
    nowIso(eligibilityAfter),
    nowIso(effectiveAt),
    nowIso(requestedAt)
  );

  return getRequestById(result.lastInsertRowid);
}

function appendReviewNote(base, extra) {
  const left = String(base || '').trim();
  const right = String(extra || '').trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n${right}`;
}

async function processRequestExecution(requestId, options = {}) {
  const request = getRequestById(requestId);
  if (!request) throw new Error('Request perubahan paket tidak ditemukan.');
  const status = String(request.status || '').toLowerCase();
  if (!['approved', 'scheduled', 'processing'].includes(status)) {
    throw new Error('Request ini belum siap diproses.');
  }

  const now = new Date();
  const effectiveAt = request.effective_at ? new Date(request.effective_at) : now;
  const force = options.force === true;
  if (status === 'scheduled' && !force && effectiveAt.getTime() > now.getTime()) {
    return {
      request,
      stage: 'scheduled',
      scheduledWaiting: true
    };
  }

  db.prepare(`
    UPDATE package_change_requests
    SET status = 'processing',
        processing_at = COALESCE(processing_at, CURRENT_TIMESTAMP),
        reviewed_by_name = COALESCE(NULLIF(?, ''), reviewed_by_name),
        review_note = COALESCE(NULLIF(?, ''), review_note)
    WHERE id = ?
  `).run(
    String(options.actorName || '').trim(),
    String(options.reviewNote || '').trim(),
    Number(requestId)
  );

  const effectiveMonth = effectiveAt.getMonth() + 1;
  const effectiveYear = effectiveAt.getFullYear();
  const invoiceAdjustmentMode = request.change_kind === 'downgrade' ? 'from_effective_period' : 'all_unpaid';

  try {
    const result = await customerSvc.applyCustomerPackageChange(request.customer_id, request.target_package_id, {
      requirePortalVisibility: false,
      invoiceAdjustmentMode,
      effectiveMonth,
      effectiveYear,
      changeNote: `Perubahan paket ${request.change_kind} dari ${request.current_package_name || '-'} ke ${request.target_package_name || '-'}`,
      resetActiveSession: true
    });

    db.prepare(`
      UPDATE package_change_requests
      SET status = 'completed',
          applied_at = CURRENT_TIMESTAMP,
          completed_at = CURRENT_TIMESTAMP,
          reviewed_by_name = COALESCE(NULLIF(?, ''), reviewed_by_name),
          review_note = COALESCE(NULLIF(?, ''), review_note)
      WHERE id = ?
    `).run(
      String(options.actorName || '').trim(),
      String(options.reviewNote || '').trim(),
      Number(requestId)
    );

    return {
      request: getRequestById(requestId),
      stage: 'completed',
      ...result
    };
  } catch (error) {
    const fallbackStatus = status === 'scheduled' ? 'scheduled' : 'approved';
    db.prepare(`
      UPDATE package_change_requests
      SET status = ?,
          review_note = ?,
          reviewed_by_name = COALESCE(NULLIF(?, ''), reviewed_by_name)
      WHERE id = ?
    `).run(
      fallbackStatus,
      appendReviewNote(request.review_note, `Gagal proses otomatis: ${error.message || 'Unknown error'}`),
      String(options.actorName || '').trim(),
      Number(requestId)
    );
    throw error;
  }
}

async function approveRequest(requestId, options = {}) {
  const request = getRequestById(requestId);
  if (!request) throw new Error('Request perubahan paket tidak ditemukan.');
  if (String(request.status || '').toLowerCase() !== 'pending') {
    throw new Error('Request ini sudah diproses sebelumnya.');
  }

  const actorName = String(options.actorName || '').trim();
  const reviewNote = String(options.reviewNote || '').trim();

  db.prepare(`
    UPDATE package_change_requests
    SET status = 'approved',
        review_note = ?,
        reviewed_by_name = ?,
        approved_at = CURRENT_TIMESTAMP,
        reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reviewNote, actorName, Number(requestId));

  const refreshed = getRequestById(requestId);
  if (refreshed.change_kind === 'downgrade') {
    const customer = customerSvc.getCustomerById(refreshed.customer_id);
    const effectiveAt = refreshed.effective_at
      ? new Date(refreshed.effective_at)
      : getNextBillingCycleAt(customer, new Date());
    db.prepare(`
      UPDATE package_change_requests
      SET status = 'scheduled',
          scheduled_at = CURRENT_TIMESTAMP,
          effective_at = ?
      WHERE id = ?
    `).run(nowIso(effectiveAt), Number(requestId));
    return {
      request: getRequestById(requestId),
      stage: 'scheduled',
      effectiveAt
    };
  }

  return processRequestExecution(requestId, { actorName, reviewNote, force: true });
}

function rejectRequest(requestId, options = {}) {
  const request = getRequestById(requestId);
  if (!request) throw new Error('Request perubahan paket tidak ditemukan.');
  if (String(request.status || '').toLowerCase() !== 'pending') {
    throw new Error('Request ini sudah diproses sebelumnya.');
  }

  db.prepare(`
    UPDATE package_change_requests
    SET status = 'rejected',
        review_note = ?,
        reviewed_by_name = ?,
        rejected_at = CURRENT_TIMESTAMP,
        reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    String(options.reviewNote || '').trim(),
    String(options.actorName || '').trim(),
    Number(requestId)
  );

  return getRequestById(requestId);
}

function cancelRequest(requestId, options = {}) {
  const request = getRequestById(requestId);
  if (!request) throw new Error('Request perubahan paket tidak ditemukan.');
  if (!PORTAL_ALLOWED_ACTIVE_STATUSES.has(String(request.status || '').toLowerCase())) {
    throw new Error('Request ini tidak bisa dibatalkan lagi.');
  }

  db.prepare(`
    UPDATE package_change_requests
    SET status = 'cancelled',
        review_note = ?,
        reviewed_by_name = COALESCE(NULLIF(?, ''), reviewed_by_name),
        cancelled_at = CURRENT_TIMESTAMP,
        reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    appendReviewNote(request.review_note, String(options.reviewNote || '').trim()),
    String(options.actorName || '').trim(),
    Number(requestId)
  );

  return getRequestById(requestId);
}

async function completeRequest(requestId, options = {}) {
  const request = getRequestById(requestId);
  if (!request) throw new Error('Request perubahan paket tidak ditemukan.');
  if (!['approved', 'scheduled', 'processing'].includes(String(request.status || '').toLowerCase())) {
    throw new Error('Request ini belum bisa ditandai selesai.');
  }
  return processRequestExecution(requestId, {
    actorName: String(options.actorName || '').trim(),
    reviewNote: String(options.reviewNote || '').trim(),
    force: true
  });
}

async function processDueScheduledRequests(limit = 50) {
  const rows = db.prepare(`
    SELECT id
    FROM package_change_requests
    WHERE status = 'scheduled'
      AND effective_at IS NOT NULL
      AND datetime(effective_at) <= datetime('now')
    ORDER BY datetime(effective_at) ASC, id ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit || 50)));

  let completed = 0;
  for (const row of rows) {
    try {
      const result = await processRequestExecution(row.id, {
        actorName: 'System Scheduler',
        reviewNote: 'Diproses otomatis saat masuk siklus tagihan berikutnya.'
      });
      if (result?.stage === 'completed') completed += 1;
    } catch (error) {
      logger.warn(`[packageChangeService] Gagal memproses request terjadwal #${row.id}: ${error.message}`);
    }
  }
  return completed;
}

module.exports = {
  ACTIVE_REQUEST_STATUSES,
  PACKAGE_CHANGE_COOLDOWN_DAYS,
  countPendingRequests,
  getRequestById,
  listRequestsByStatus,
  getPortalPackageChangeState,
  createRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  completeRequest,
  processDueScheduledRequests
};
