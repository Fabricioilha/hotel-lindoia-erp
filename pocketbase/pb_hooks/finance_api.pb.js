// Transactional API endpoints for normalized finance collections.

routerAdd("GET", "/api/hotel/finance/meta", (event) => {
  const core = require(__hooks + "/finance_core.js")
  core.resolveUserRole($app, event.requestInfo().auth)
  const meta = core.getSystemMeta($app)
  return event.json(200, meta)
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/finance/snapshot", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  if (role !== "admin") throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
  core.enforceSchemaAndMaintenance($app, event, false)

  const query = event.requestInfo().query || {}
  const from = String(query.from || "")
  const to = String(query.to || "")
  const includeAudit = query.includeAudit !== "0" && query.includeAudit !== "false"
  const auditLimit = query.auditLimit !== undefined ? parseInt(String(query.auditLimit), 10) : 100
  const includeSummaries = query.includeSummaries !== "0" && query.includeSummaries !== "false"
  const includePendingOutsideRange = query.includePendingOutsideRange !== "0" && query.includePendingOutsideRange !== "false"

  const result = core.readNormalizedFinanceData($app, {
    from,
    to,
    includeAudit,
    auditLimit: Number.isFinite(auditLimit) ? auditLimit : 100,
    includeSummaries,
    includePendingOutsideRange,
  })
  return event.json(200, result)
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/finance/summaries", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  if (role !== "admin") throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
  core.enforceSchemaAndMaintenance($app, event, false)

  const query = event.requestInfo().query || {}
  const fromMonth = String(query.fromMonth || "")
  const toMonth = String(query.toMonth || "")
  let filter = ""
  const params = {}
  if (/^\d{4}-\d{2}$/.test(fromMonth) && /^\d{4}-\d{2}$/.test(toMonth)) {
    filter = "month >= {:fromMonth} && month <= {:toMonth}"
    params.fromMonth = fromMonth
    params.toMonth = toMonth
  } else if (/^\d{4}-\d{2}$/.test(fromMonth)) {
    filter = "month >= {:fromMonth}"
    params.fromMonth = fromMonth
  } else if (/^\d{4}-\d{2}$/.test(toMonth)) {
    filter = "month <= {:toMonth}"
    params.toMonth = toMonth
  }
  const recs = $app.findRecordsByFilter("finance_monthly_summaries", filter, "month", 0, 0, params)
  const items = recs.map((rec) => ({
    summaryKey: rec.getString("summary_key"),
    month: rec.getString("month"),
    wallet: rec.getString("wallet"),
    category: rec.getString("category"),
    incomeDirectCents: rec.getInt("income_direct_cents"),
    incomePrepaidCents: rec.getInt("income_prepaid_cents"),
    expensePaidCents: rec.getInt("expense_paid_cents"),
    payrollPaidCents: rec.getInt("payroll_paid_cents"),
    transfersInCents: rec.getInt("transfers_in_cents"),
    transfersOutCents: rec.getInt("transfers_out_cents"),
    adjustmentsNetCents: rec.getInt("adjustments_net_cents"),
    netChangeCents: rec.getInt("net_change_cents"),
    closingCashCents: rec.getInt("closing_cash_cents"),
    closingBankCents: rec.getInt("closing_bank_cents"),
    closingOyoCents: rec.getInt("closing_oyo_cents"),
    entryCount: rec.getInt("entry_count"),
    breakdown: core.decodeJsonField(rec, "breakdown_json", {}),
    rebuiltAt: rec.getString("rebuilt_at"),
  }))
  return event.json(200, { items })
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/finance/entries", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  if (role !== "admin") throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
  core.enforceSchemaAndMaintenance($app, event, false)

  const query = event.requestInfo().query || {}
  const page = Math.max(1, parseInt(String(query.page || "1"), 10) || 1)
  const perPage = Math.min(250, Math.max(1, parseInt(String(query.perPage || "50"), 10) || 50))
  const filters = []
  const params = {}
  if (query.type === "income" || query.type === "expense") {
    filters.push("type = {:type}")
    params.type = query.type
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ""))) {
    filters.push("date >= {:from}")
    params.from = String(query.from)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ""))) {
    filters.push("date <= {:to}")
    params.to = String(query.to)
  }
  if (query.category) {
    filters.push("category = {:category}")
    params.category = String(query.category)
  }
  if (query.status) {
    filters.push("status = {:status}")
    params.status = String(query.status)
  }
  const filterExpr = filters.join(" && ")
  const offset = (page - 1) * perPage
  const records = $app.findRecordsByFilter("finance_entries", filterExpr, "-date,-created", perPage + 1, offset, params)
  const hasMore = records.length > perPage
  const slice = hasMore ? records.slice(0, perPage) : records
  const items = slice.map((r) => ({
    id: r.getString("entry_id"),
    type: r.getString("type"),
    date: r.getString("date"),
    purchaseDate: r.getString("purchase_date") || undefined,
    paidDate: r.getString("paid_date") || undefined,
    category: r.getString("category"),
    wallet: r.getString("wallet") || undefined,
    status: r.getString("status"),
    amountCents: r.getInt("amount_cents"),
    paidCashCents: r.getInt("paid_cash_cents"),
    paidBankCents: r.getInt("paid_bank_cents"),
    paidOyoCents: r.getInt("paid_oyo_cents"),
    pendingCents: r.getInt("pending_cents"),
    note: r.getString("note"),
    version: r.getInt("version"),
  }))
  return event.json(200, { page, perPage, hasMore, items })
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/finance/path", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  const query = event.requestInfo().query || {}
  const subPath = String(query.path || "").replace(/^\/+|\/+$/g, "")
  const viewerAllowed = subPath === "cardFeeSchedule" || subPath.startsWith("cardFeeSchedule/")
  if (role !== "admin" && !viewerAllowed) {
    throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
  }
  core.enforceSchemaAndMaintenance($app, event, false)
  const res = core.readNormalizedFinancePathWithVersion($app, subPath)
  return event.json(200, res)
}, $apis.requireAuth())

routerAdd("POST", "/api/hotel/finance/mutate", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const stateTx = require(__hooks + "/hotel_state_tx.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  if (role !== "admin") throw new ForbiddenError("Seu perfil não pode alterar dados financeiros.")
  core.enforceSchemaAndMaintenance($app, event, true)

  const body = event.requestInfo().body || {}
  const mutation = body.mutation || {}
  const stateUpdates = body.stateUpdates
  const stateExpected = body.stateExpected || {}
  const hasStateUpdates = Boolean(stateUpdates && typeof stateUpdates === "object" && Object.keys(stateUpdates).length > 0)

  let stateRoots = []
  if (hasStateUpdates) {
    stateRoots = stateTx.validateStateUpdatesAccess(role, stateUpdates, stateExpected, { financeLegacyFrozen: true })
  }

  let financeResult = { changed: 0, summaryDirty: false }
  let stateResult = { changed: 0, savedSizes: [] }

  try {
    $app.runInTransaction((txApp) => {
      if (hasStateUpdates) {
        stateResult = stateTx.applyHotelStateUpdatesInTx(txApp, role, stateUpdates, stateExpected, body.sourceHash, stateRoots)
      }
      financeResult = core.applyFinanceMutationInTx(txApp, mutation)
    })
  } catch (error) {
    console.error("PocketBase finance mutate failed", error)
    throw error
  }

  if (stateResult.savedSizes.length > 0) {
    stateTx.logSavedSizes($app, stateResult.savedSizes)
  }

  return event.json(200, {
    committed: true,
    changed: financeResult.changed + stateResult.changed,
    financeChanged: financeResult.changed,
    stateChanged: stateResult.changed,
    summaryRebuilt: financeResult.summaryDirty && mutation.skipSummaryRebuild !== true,
  })
}, $apis.requireAuth())

routerAdd("POST", "/api/hotel/finance/summaries/rebuild", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  if (role !== "admin") throw new ForbiddenError("Somente a gerência pode reconstruir os resumos financeiros.")

  let rebuiltMonths = 0
  $app.runInTransaction((txApp) => {
    rebuiltMonths = core.rebuildMonthlySummaries(txApp)
  })
  return event.json(200, { rebuilt: true, months: rebuiltMonths })
}, $apis.requireAuth())

routerAdd("POST", "/api/hotel/finance/system-meta", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const auth = event.requestInfo().auth
  if (!auth || !auth.isSuperuser()) {
    throw new ForbiddenError("Somente o superusuário pode alterar as configurações de sistema do financeiro.")
  }
  const body = event.requestInfo().body || {}
  const allowed = [
    "schemaVersion",
    "minSchemaVersion",
    "maintenanceReadonly",
    "maintenanceMessage",
    "financeLegacyFrozen",
    "financeMode",
    "lastBackfillAt",
  ]
  let updated = null
  $app.runInTransaction((txApp) => {
    const current = core.getSystemMeta(txApp)
    const next = { ...current }
    for (const key of allowed) {
      if (Object.hasOwn(body, key)) next[key] = body[key]
    }
    if (next.financeMode !== "legacy" && next.financeMode !== "normalized") {
      throw new BadRequestError("financeMode inválido (esperado 'legacy' ou 'normalized').")
    }
    core.setConfigValue(txApp, "systemMeta", next, Number(next.schemaVersion || 2))
    updated = next
  })
  return event.json(200, updated)
}, $apis.requireAuth())
