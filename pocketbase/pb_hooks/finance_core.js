// Shared CommonJS core for PocketBase normalized finance collections and atomic transactions.
// Loaded inside hook/route handlers via require(__hooks + "/finance_core.js").

const DEFAULT_SYSTEM_META = {
  schemaVersion: 2,
  minSchemaVersion: 1,
  maintenanceReadonly: false,
  maintenanceMessage: "",
  financeLegacyFrozen: false,
  financeMode: "legacy",
  lastBackfillAt: null,
}

const toCents = (value) => Math.round((Number(value) || 0) * 100)
const fromCents = (value) => (Number(value) || 0) / 100

const deterministicId = (prefix, key) => {
  return $security.sha256(String(prefix) + ":" + String(key)).slice(0, 15)
}

const decodeJsonValue = (raw, fallback) => {
  if (raw === null || raw === undefined || raw === "") return fallback
  if (typeof raw === "string") {
    try { return JSON.parse(raw) } catch (_) { return fallback }
  }
  if (typeof raw === "object" && typeof raw.length === "number") {
    try {
      const text = toString(raw)
      return text ? JSON.parse(text) : fallback
    } catch (_) {
      return fallback
    }
  }
  return raw
}

const decodeJsonField = (record, fieldName, fallback) => {
  if (!record) return fallback
  return decodeJsonValue(record.get(fieldName), fallback)
}

const resolveUserRole = (app, auth) => {
  if (!auth) throw new UnauthorizedError("Faça login para acessar os dados.")
  if (auth.isSuperuser()) return "admin"
  const matches = app.findRecordsByFilter("user_roles", "user = {:userId}", "", 1, 0, {
    userId: auth.get("id"),
  })
  const role = matches[0]?.getString("role")
  if (role !== "admin" && role !== "viewer") {
    throw new ForbiddenError("Usuário sem perfil autorizado.")
  }
  return role
}

const hasCollection = (app, name) => {
  try {
    return Boolean(app.findCollectionByNameOrId(name))
  } catch (_) {
    return false
  }
}

const findByIdOrNull = (app, collectionName, id) => {
  try {
    return app.findRecordById(collectionName, id)
  } catch (_) {
    return null
  }
}

const getConfigValue = (app, key, fallback) => {
  if (!hasCollection(app, "finance_config")) return fallback
  const id = deterministicId("finance_config", key)
  const record = findByIdOrNull(app, "finance_config", id)
  if (!record) return fallback
  const decoded = decodeJsonField(record, "value_json", fallback)
  return decoded === null || decoded === undefined ? fallback : decoded
}

const setConfigValue = (txApp, key, value, schemaVersion, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_config")
  const id = deterministicId("finance_config", key)
  let record = findByIdOrNull(txApp, "finance_config", id)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Esta configuração financeira mudou em outra sessão. Atualize e tente novamente.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", id)
  }
  record.set("config_key", key)
  record.set("value_json", JSON.stringify(value === undefined ? null : value))
  record.set("schema_version", Number.isFinite(schemaVersion) ? Math.trunc(schemaVersion) : 2)
  record.set("version", (currentVersion ?? 0) + 1)
  record.set("updated_at", new Date().toISOString())
  txApp.save(record)
  return record
}

const getSystemMeta = (app) => {
  const saved = getConfigValue(app, "systemMeta", null)
  if (!saved || typeof saved !== "object") return { ...DEFAULT_SYSTEM_META }
  return { ...DEFAULT_SYSTEM_META, ...saved }
}

const enforceSchemaAndMaintenance = (app, event, isWrite) => {
  const meta = getSystemMeta(app)
  const auth = event.requestInfo().auth
  const isSuper = Boolean(auth && auth.isSuperuser())
  const headers = event.requestInfo().headers || {}
  const headerRaw = headers["x_erp_schema_version"] || headers["X-ERP-Schema-Version"] || event.request.header.get("X-ERP-Schema-Version") || ""
  const clientVersion = headerRaw ? parseInt(String(headerRaw), 10) : 1

  if (!isSuper && Number(meta.minSchemaVersion || 1) > 1 && (!Number.isFinite(clientVersion) || clientVersion < Number(meta.minSchemaVersion))) {
    throw new ApiError(426, "Uma nova versão do ERP foi publicada. Recarregue a página para continuar com segurança.")
  }
  if (isWrite && !isSuper && meta.maintenanceReadonly) {
    throw new ApiError(503, meta.maintenanceMessage || "Sistema em manutenção rápida (somente leitura). Nenhuma alteração foi descartada; aguarde alguns instantes e tente novamente.")
  }
  return meta
}

const incomePaymentWallet = (method) => {
  if (method === "cash") return "cash"
  if (method === "prepaid") return "oyo"
  if (method === "credit" || method === "debit" || method === "pix" || method === "bank_transfer") return "bank"
  return null
}

const normalizeIncomeItems = (entry) => {
  const items = entry && entry.items && typeof entry.items === "object"
    ? Object.values(entry.items).filter(Boolean)
    : []
  if (items.length > 0) return items
  const paymentMethod = entry.wallet === "cash"
    ? "cash"
    : entry.wallet === "oyo" ? "prepaid" : "bank_transfer"
  return [{ id: entry.id, description: entry.category, amount: entry.amount, paymentMethod }]
}

const isOyoFeeItem = (entry, item) => {
  return entry.category === "Taxas"
    || (entry.category === "Diária" && item.description === "Taxa")
    || (String(entry.id || "").startsWith("reservation-") && String(item.description || "").startsWith("Taxa · quarto "))
}

const financeReceiptItems = (entry) => {
  return normalizeIncomeItems(entry).filter((item) => item.paymentMethod !== "prepaid" || !isOyoFeeItem(entry, item))
}

const deriveSourceRef = (id, entry) => {
  if (entry && entry.generatedFromIncome) return "income:" + entry.generatedFromIncome
  const s = String(id || "")
  const prefixes = ["recepcao-", "room-charge-", "frigobar-", "minibar-", "stock-entry-", "caixa-", "reservation-", "card-fee-", "oyo-fee-"]
  for (const p of prefixes) {
    if (s.startsWith(p)) return p.slice(0, -1) + ":" + s.slice(p.length)
  }
  return ""
}

const deriveExpensePaymentRows = (entry) => {
  const hasExplicit = entry.payments !== undefined
  if (hasExplicit) {
    return Object.values(entry.payments || {}).filter(Boolean).map((ev) => ({
      payment_id: String(ev.id),
      parent_type: "expense",
      entry_id: String(entry.id),
      statement_id: ev.cardStatementId ? String(ev.cardStatementId) : "",
      paid_at: String(ev.date || entry.dueDate),
      wallet: String(ev.wallet || "cash"),
      amount_cents: toCents(ev.amount),
      is_refund: toCents(ev.amount) < 0,
      date_source: ev.dateSource === "legacy_due_date" ? "legacy_due_date" : "informed",
      is_explicit: true,
      note: ev.note ? String(ev.note) : "",
    }))
  }
  const informed = Boolean(entry.paidDate)
  const totals = {
    cash: toCents(entry.paidCash || 0),
    bank: toCents(entry.paidBank || 0),
    oyo: toCents(entry.paidOyo || 0),
  }
  const rows = []
  for (const wallet of ["cash", "bank", "oyo"]) {
    if (!totals[wallet]) continue
    rows.push({
      payment_id: `${entry.id}-legacy-${wallet}`,
      parent_type: "expense",
      entry_id: String(entry.id),
      statement_id: "",
      paid_at: String(entry.paidDate || entry.dueDate),
      wallet,
      amount_cents: totals[wallet],
      is_refund: totals[wallet] < 0,
      date_source: informed ? "informed" : "legacy_due_date",
      is_explicit: false,
      note: informed ? "" : "Histórico sem data de pagamento: utiliza o vencimento cadastrado.",
    })
  }
  return rows
}

const derivePayrollPaymentRows = (entry) => {
  const hasExplicit = entry.payments !== undefined
  if (hasExplicit) {
    return Object.values(entry.payments || {}).filter(Boolean).map((ev) => ({
      payment_id: String(ev.id),
      parent_type: "payroll",
      entry_id: String(entry.id),
      statement_id: "",
      paid_at: String(ev.date || entry.dueDate),
      wallet: String(ev.wallet || "bank"),
      amount_cents: toCents(ev.amount),
      is_refund: toCents(ev.amount) < 0,
      date_source: ev.dateSource === "legacy_due_date" ? "legacy_due_date" : "informed",
      is_explicit: true,
      note: ev.note ? String(ev.note) : "",
    }))
  }
  const informed = Boolean(entry.paidDate)
  const totals = {
    cash: toCents(entry.paidCash || 0),
    bank: toCents(entry.paidBank || 0),
  }
  const rows = []
  for (const wallet of ["cash", "bank"]) {
    if (!totals[wallet]) continue
    rows.push({
      payment_id: `${entry.id}-legacy-${wallet}`,
      parent_type: "payroll",
      entry_id: String(entry.id),
      statement_id: "",
      paid_at: String(entry.paidDate || entry.dueDate),
      wallet,
      amount_cents: totals[wallet],
      is_refund: totals[wallet] < 0,
      date_source: informed ? "informed" : "legacy_due_date",
      is_explicit: false,
      note: informed ? "" : "Histórico sem data de pagamento: utiliza o vencimento cadastrado.",
    })
  }
  return rows
}

const syncChildPayments = (txApp, parentType, entryId, desiredRows) => {
  const collection = txApp.findCollectionByNameOrId("finance_payments")
  const existing = txApp.findRecordsByFilter(
    "finance_payments",
    "parent_type = {:parentType} && entry_id = {:entryId}",
    "",
    0,
    0,
    { parentType, entryId: String(entryId) },
  )
  const existingByKey = new Map()
  for (const rec of existing) {
    existingByKey.set(rec.getString("payment_key"), rec)
  }
  const keptKeys = new Set()
  for (const row of desiredRows) {
    const paymentKey = `${parentType}:${entryId}:${row.payment_id}`
    keptKeys.add(paymentKey)
    const pbId = deterministicId("finance_payments", paymentKey)
    let rec = existingByKey.get(paymentKey) || findByIdOrNull(txApp, "finance_payments", pbId)
    if (!rec) {
      rec = new Record(collection)
      rec.set("id", pbId)
    }
    rec.set("payment_key", paymentKey)
    rec.set("payment_id", row.payment_id)
    rec.set("parent_type", parentType)
    rec.set("entry_id", String(entryId))
    rec.set("statement_id", row.statement_id || "")
    rec.set("paid_at", row.paid_at)
    rec.set("wallet", row.wallet)
    rec.set("amount_cents", row.amount_cents)
    rec.set("is_refund", Boolean(row.is_refund))
    rec.set("date_source", row.date_source)
    rec.set("is_explicit", Boolean(row.is_explicit))
    rec.set("note", row.note || "")
    txApp.save(rec)
  }
  for (const rec of existing) {
    if (!keptKeys.has(rec.getString("payment_key"))) {
      txApp.delete(rec)
    }
  }
}

const upsertIncome = (txApp, entry, isSuppressed, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_entries")
  const entryId = String(entry.id)
  const pbId = deterministicId("finance_entries", entryId)
  let record = findByIdOrNull(txApp, "finance_entries", pbId)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Esta entrada mudou em outra sessão. Reabra o lançamento e tente novamente.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  const amountCents = toCents(entry.amount)
  record.set("entry_id", entryId)
  record.set("type", "income")
  record.set("date", String(entry.date))
  record.set("purchase_date", "")
  record.set("paid_date", String(entry.date))
  record.set("category", String(entry.category || "Diária"))
  record.set("wallet", String(entry.wallet || "bank"))
  record.set("status", isSuppressed ? "suppressed" : "settled")
  record.set("amount_cents", amountCents)
  record.set("paid_cash_cents", 0)
  record.set("paid_bank_cents", 0)
  record.set("paid_oyo_cents", 0)
  record.set("pending_cents", 0)
  record.set("source_ref", deriveSourceRef(entryId, entry))
  record.set("generated_from_income", "")
  record.set("operational_override", Boolean(entry.operationalOverride))
  record.set("suppressed", Boolean(isSuppressed))
  record.set("has_explicit_payments", false)
  record.set("purchase_method", "")
  record.set("card_category", "")
  record.set("card_statement_id", "")
  record.set("employee", "")
  record.set("employee_id", "")
  record.set("advance_month", "")
  record.set("note", String(entry.note || ""))
  record.set("items_json", entry.items !== undefined ? JSON.stringify(entry.items) : "null")
  record.set("created_at", String(entry.createdAt || ""))
  record.set("updated_at", String(entry.updatedAt || ""))
  record.set("version", (currentVersion ?? 0) + 1)
  txApp.save(record)
  return record
}

const upsertExpense = (txApp, entry, isSuppressed, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_entries")
  const entryId = String(entry.id)
  const pbId = deterministicId("finance_entries", entryId)
  let record = findByIdOrNull(txApp, "finance_entries", pbId)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Esta despesa mudou em outra sessão. Reabra o lançamento e tente novamente.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  const plannedCents = toCents(entry.plannedAmount)
  const paidCashCents = toCents(entry.paidCash || 0)
  const paidBankCents = toCents(entry.paidBank || 0)
  const paidOyoCents = toCents(entry.paidOyo || 0)
  const paidTotalCents = paidCashCents + paidBankCents + paidOyoCents
  const pendingCents = Math.max(0, plannedCents - paidTotalCents)
  let status = "pending"
  if (isSuppressed) status = "suppressed"
  else if (pendingCents <= 0) status = "settled"
  else if (entry.purchaseMethod === "card" && !entry.cardStatementId) status = "unassigned_card"
  else if (paidTotalCents > 0) status = "partial"

  record.set("entry_id", entryId)
  record.set("type", "expense")
  record.set("date", String(entry.dueDate))
  record.set("purchase_date", entry.purchaseDate ? String(entry.purchaseDate) : "")
  record.set("paid_date", entry.paidDate ? String(entry.paidDate) : "")
  record.set("category", String(entry.category || "Outros"))
  record.set("wallet", "")
  record.set("status", status)
  record.set("amount_cents", plannedCents)
  record.set("paid_cash_cents", paidCashCents)
  record.set("paid_bank_cents", paidBankCents)
  record.set("paid_oyo_cents", paidOyoCents)
  record.set("pending_cents", pendingCents)
  record.set("source_ref", deriveSourceRef(entryId, entry))
  record.set("generated_from_income", entry.generatedFromIncome ? String(entry.generatedFromIncome) : "")
  record.set("operational_override", Boolean(entry.operationalOverride))
  record.set("suppressed", Boolean(isSuppressed))
  record.set("has_explicit_payments", entry.payments !== undefined)
  record.set("purchase_method", entry.purchaseMethod ? String(entry.purchaseMethod) : "")
  record.set("card_category", entry.cardCategory ? String(entry.cardCategory) : "")
  record.set("card_statement_id", entry.cardStatementId ? String(entry.cardStatementId) : "")
  record.set("employee", entry.employee ? String(entry.employee) : "")
  record.set("employee_id", entry.employeeId ? String(entry.employeeId) : "")
  record.set("advance_month", entry.advanceMonth ? String(entry.advanceMonth) : "")
  record.set("note", String(entry.note || ""))
  record.set("items_json", "null")
  record.set("created_at", String(entry.createdAt || ""))
  record.set("updated_at", String(entry.updatedAt || ""))
  record.set("version", (currentVersion ?? 0) + 1)
  txApp.save(record)

  const paymentRows = deriveExpensePaymentRows(entry)
  syncChildPayments(txApp, "expense", entryId, paymentRows)
  return record
}

const deleteEntry = (txApp, entryId, expectedType) => {
  const pbId = deterministicId("finance_entries", String(entryId))
  const record = findByIdOrNull(txApp, "finance_entries", pbId)
  if (record && (!expectedType || record.getString("type") === expectedType)) {
    txApp.delete(record)
  }
  syncChildPayments(txApp, "expense", String(entryId), [])
}

const upsertCardStatement = (txApp, statement, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_card_statements")
  const statementId = String(statement.id)
  const pbId = deterministicId("finance_card_statements", statementId)
  let record = findByIdOrNull(txApp, "finance_card_statements", pbId)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Esta fatura mudou em outra sessão. Atualize a consulta.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  const hasPayment = Boolean(statement.payment)
  record.set("statement_id", statementId)
  record.set("card_category", String(statement.cardCategory))
  record.set("due_date", String(statement.dueDate))
  record.set("original_due_dates_json", JSON.stringify(statement.originalDueDates || {}))
  record.set("paid", hasPayment)
  record.set("paid_date", hasPayment ? String(statement.payment.date) : "")
  record.set("paid_wallet", hasPayment ? String(statement.payment.wallet) : "")
  record.set("paid_amount_cents", hasPayment ? toCents(statement.payment.amount) : 0)
  record.set("version", (currentVersion ?? 0) + 1)
  txApp.save(record)

  const paymentRows = hasPayment ? [{
    payment_id: `statement-${statementId}`,
    parent_type: "card_statement",
    entry_id: statementId,
    statement_id: statementId,
    paid_at: String(statement.payment.date),
    wallet: String(statement.payment.wallet),
    amount_cents: toCents(statement.payment.amount),
    is_refund: toCents(statement.payment.amount) < 0,
    date_source: "informed",
    is_explicit: true,
    note: String(statement.cardCategory || ""),
  }] : []
  syncChildPayments(txApp, "card_statement", statementId, paymentRows)
  return record
}

const deleteCardStatement = (txApp, statementId) => {
  const pbId = deterministicId("finance_card_statements", String(statementId))
  const record = findByIdOrNull(txApp, "finance_card_statements", pbId)
  if (record) txApp.delete(record)
  syncChildPayments(txApp, "card_statement", String(statementId), [])
}

const upsertPayroll = (txApp, entry, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_payroll_records")
  const payrollId = String(entry.id)
  const pbId = deterministicId("finance_payroll_records", payrollId)
  let record = findByIdOrNull(txApp, "finance_payroll_records", pbId)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Esta folha mudou em outra sessão. Reabra o lançamento e tente novamente.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  const basePayCents = toCents(entry.basePay || 0)
  const additionsCents = toCents(entry.additions || 0)
  const deductionsCents = toCents(entry.deductions || 0)
  const advancesTotalCents = Object.values(entry.advances || {}).reduce((s, v) => s + toCents(v), 0)
  const netCents = Math.max(0, basePayCents + additionsCents - deductionsCents - advancesTotalCents)
  const paidCashCents = toCents(entry.paidCash || 0)
  const paidBankCents = toCents(entry.paidBank || 0)
  const paidTotalCents = paidCashCents + paidBankCents
  const pendingCents = Math.max(0, netCents - paidTotalCents)
  const status = pendingCents <= 0 ? "settled" : paidTotalCents > 0 ? "partial" : "pending"

  record.set("payroll_id", payrollId)
  record.set("month", String(entry.month))
  record.set("due_date", String(entry.dueDate))
  record.set("employee", String(entry.employee))
  record.set("employee_id", entry.employeeId ? String(entry.employeeId) : "")
  record.set("position", String(entry.position || ""))
  record.set("base_pay_cents", basePayCents)
  record.set("additions_cents", additionsCents)
  record.set("deductions_cents", deductionsCents)
  record.set("advances_total_cents", advancesTotalCents)
  record.set("net_cents", netCents)
  record.set("paid_cash_cents", paidCashCents)
  record.set("paid_bank_cents", paidBankCents)
  record.set("pending_cents", pendingCents)
  record.set("status", status)
  record.set("paid_date", entry.paidDate ? String(entry.paidDate) : "")
  record.set("advances_json", entry.advances && Object.keys(entry.advances).length > 0 ? JSON.stringify(entry.advances) : "null")
  record.set("has_explicit_payments", entry.payments !== undefined)
  record.set("note", String(entry.note || ""))
  record.set("created_at", String(entry.createdAt || ""))
  record.set("updated_at", String(entry.updatedAt || ""))
  record.set("version", (currentVersion ?? 0) + 1)
  txApp.save(record)

  const paymentRows = derivePayrollPaymentRows(entry)
  syncChildPayments(txApp, "payroll", payrollId, paymentRows)
  return record
}

const deletePayroll = (txApp, payrollId) => {
  const pbId = deterministicId("finance_payroll_records", String(payrollId))
  const record = findByIdOrNull(txApp, "finance_payroll_records", pbId)
  if (record) txApp.delete(record)
  syncChildPayments(txApp, "payroll", String(payrollId), [])
}

const upsertTransferAdjustment = (txApp, kind, recordId, fields, expectedVersion) => {
  const collection = txApp.findCollectionByNameOrId("finance_transfers_adjustments")
  const recordKey = `${kind}:${recordId}`
  const pbId = deterministicId("finance_transfers_adjustments", recordKey)
  let record = findByIdOrNull(txApp, "finance_transfers_adjustments", pbId)
  const currentVersion = record ? record.getInt("version") : null
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    throw new ApiError(409, "Este registro mudou em outra sessão. Atualize e tente novamente.")
  }
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  record.set("record_key", recordKey)
  record.set("record_id", String(recordId))
  record.set("kind", kind)
  record.set("date", String(fields.date))
  record.set("from_wallet", fields.from_wallet || "")
  record.set("to_wallet", fields.to_wallet || "")
  record.set("amount_cents", fields.amount_cents || 0)
  record.set("oyo_recom_month", fields.oyo_recom_month || "")
  record.set("note", fields.note || "")
  record.set("payload_json", fields.payload !== undefined ? JSON.stringify(fields.payload) : "null")
  record.set("created_at", fields.created_at || "")
  record.set("updated_at", fields.updated_at || "")
  record.set("version", (currentVersion ?? 0) + 1)
  txApp.save(record)
  return record
}

const deleteTransferAdjustment = (txApp, kind, recordId) => {
  const recordKey = `${kind}:${recordId}`
  const pbId = deterministicId("finance_transfers_adjustments", recordKey)
  const record = findByIdOrNull(txApp, "finance_transfers_adjustments", pbId)
  if (record) txApp.delete(record)
}

const upsertTransfer = (txApp, item, expectedVersion) => {
  return upsertTransferAdjustment(txApp, "transfer", String(item.id), {
    date: String(item.date),
    from_wallet: String(item.from),
    to_wallet: String(item.to),
    amount_cents: toCents(item.amount),
    oyo_recom_month: item.oyoRecomMonth ? String(item.oyoRecomMonth) : "",
    note: String(item.note || ""),
    created_at: String(item.createdAt || ""),
    updated_at: String(item.createdAt || ""),
  }, expectedVersion)
}

const upsertCashAdjustment = (txApp, item, expectedVersion) => {
  return upsertTransferAdjustment(txApp, "cash_adjustment", String(item.id), {
    date: String(item.date),
    from_wallet: "",
    to_wallet: "cash",
    amount_cents: toCents(item.amount),
    oyo_recom_month: "",
    note: String(item.note || ""),
    created_at: String(item.createdAt || ""),
    updated_at: String(item.updatedAt || ""),
  }, expectedVersion)
}

const upsertOyoReconciliation = (txApp, month, rec, expectedVersion) => {
  let balanceCents = 0
  if (rec && typeof rec.closingBalance === "number" && Number.isFinite(rec.closingBalance)) {
    balanceCents = toCents(rec.closingBalance)
  } else if (rec && typeof rec.reportedShare === "number") {
    const share = toCents(rec.reportedShare)
    const received = toCents(rec.collectedByHotel || 0) + toCents(rec.paidToHotel || 0) - toCents(rec.paidToOyo || 0)
    balanceCents = share - received
  }
  return upsertTransferAdjustment(txApp, "oyo_reconciliation", String(month), {
    date: `${month}-01`,
    from_wallet: "",
    to_wallet: "oyo",
    amount_cents: balanceCents,
    oyo_recom_month: String(month),
    note: "",
    payload: rec,
    created_at: String(rec?.updatedAt || ""),
    updated_at: String(rec?.updatedAt || ""),
  }, expectedVersion)
}

const upsertAuditEvent = (txApp, eventId, ev) => {
  const collection = txApp.findCollectionByNameOrId("finance_audit_logs")
  const pbId = deterministicId("finance_audit_logs", String(eventId))
  let record = findByIdOrNull(txApp, "finance_audit_logs", pbId)
  if (!record) {
    record = new Record(collection)
    record.set("id", pbId)
  }
  record.set("event_id", String(eventId))
  record.set("operation_id", String(ev.operationId || ""))
  record.set("entity_type", String(ev.entity || "finance-settings"))
  record.set("entity_id", String(ev.recordId || ""))
  const action = ev.action === "criado" || ev.action === "alterado" || ev.action === "excluido" ? ev.action : "alterado"
  record.set("action", action)
  record.set("actor_uid", String(ev.actorUid || ""))
  record.set("occurred_at", String(ev.occurredAt || new Date().toISOString()))
  const changes = {}
  if (ev.before !== undefined) changes.before = ev.before
  if (ev.after !== undefined) changes.after = ev.after
  if (ev.summary !== undefined) changes.summary = ev.summary
  record.set("changes_json", JSON.stringify(changes))
  txApp.save(record)
  return record
}

const deleteAuditEvent = (txApp, eventId) => {
  const pbId = deterministicId("finance_audit_logs", String(eventId))
  const record = findByIdOrNull(txApp, "finance_audit_logs", pbId)
  if (record) txApp.delete(record)
}

// Rebuilds finance_monthly_summaries deterministically from normalized tables inside txApp.
// Uses lightweight SQLite reads so even 15,000+ rows rebuild in milliseconds with minimal RAM.
const rebuildMonthlySummaries = (txApp) => {
  if (!hasCollection(txApp, "finance_monthly_summaries")) return 0
  const openingRaw = getConfigValue(txApp, "openingBalances", { cash: 0, bank: 0, oyo: 0 })
  const opening = {
    cash: toCents(openingRaw?.cash || 0),
    bank: toCents(openingRaw?.bank || 0),
    oyo: toCents(openingRaw?.oyo || 0),
  }
  const suppressed = getConfigValue(txApp, "suppressed", {}) || {}
  const months = new Map()
  const ensureMonth = (month) => {
    if (!/^\d{4}-\d{2}$/.test(month)) return null
    let bucket = months.get(month)
    if (!bucket) {
      bucket = {
        month,
        incomeDirectCents: 0,
        incomePrepaidCents: 0,
        expensePaidCents: 0,
        payrollPaidCents: 0,
        transfersInCents: 0,
        transfersOutCents: 0,
        adjustmentsNetCents: 0,
        incoming: { cash: 0, bank: 0, oyo: 0 },
        outgoing: { cash: 0, bank: 0, oyo: 0 },
        byCategoryIncomes: {},
        byCategoryExpenses: {},
        counts: { incomes: 0, expenses: 0, payments: 0, payroll: 0, transfers: 0, adjustments: 0 },
      }
      months.set(month, bucket)
    }
    return bucket
  }

  // 1) Incomes (finance_entries where type = 'income')
  const incomeRows = arrayOf(new DynamicModel({
    entry_id: "",
    date: "",
    category: "",
    wallet: "",
    amount_cents: 0,
    suppressed: false,
    items_json: "",
  }))
  txApp.db().newQuery("SELECT entry_id, date, category, wallet, amount_cents, suppressed, items_json FROM finance_entries WHERE type = 'income'").all(incomeRows)
  for (const row of incomeRows) {
    if (row.suppressed || suppressed[row.entry_id]) continue
    const bucket = ensureMonth(String(row.date || "").slice(0, 7))
    if (!bucket) continue
    bucket.counts.incomes += 1
    const items = decodeJsonValue(row.items_json, null)
    const entryObj = {
      id: row.entry_id,
      category: row.category,
      wallet: row.wallet,
      amount: fromCents(row.amount_cents),
      items: Array.isArray(items) && items.length ? items : undefined,
    }
    for (const item of financeReceiptItems(entryObj)) {
      const w = incomePaymentWallet(item.paymentMethod)
      if (!w) continue
      const c = toCents(item.amount)
      bucket.incoming[w] += c
      if (w === "oyo") bucket.incomePrepaidCents += c
      else bucket.incomeDirectCents += c
      bucket.byCategoryIncomes[row.category] = (bucket.byCategoryIncomes[row.category] || 0) + c
    }
  }

  // 2) Active expense IDs + categories for filtering payments cleanly
  const expMeta = new Map()
  const expRows = arrayOf(new DynamicModel({
    entry_id: "",
    date: "",
    category: "",
    suppressed: false,
  }))
  txApp.db().newQuery("SELECT entry_id, date, category, suppressed FROM finance_entries WHERE type = 'expense'").all(expRows)
  for (const row of expRows) {
    if (row.suppressed || suppressed[row.entry_id]) continue
    expMeta.set(row.entry_id, row.category)
    const b = ensureMonth(String(row.date || "").slice(0, 7))
    if (b) b.counts.expenses += 1
  }

  // 3) Payments (expense + payroll)
  const payRows = arrayOf(new DynamicModel({
    parent_type: "",
    entry_id: "",
    paid_at: "",
    wallet: "",
    amount_cents: 0,
  }))
  txApp.db().newQuery("SELECT parent_type, entry_id, paid_at, wallet, amount_cents FROM finance_payments WHERE parent_type IN ('expense', 'payroll')").all(payRows)
  for (const row of payRows) {
    if (row.parent_type === "expense" && !expMeta.has(row.entry_id)) continue
    const bucket = ensureMonth(String(row.paid_at || "").slice(0, 7))
    if (!bucket) continue
    const w = row.wallet
    if (w !== "cash" && w !== "bank" && w !== "oyo") continue
    const c = Number(row.amount_cents) || 0
    bucket.outgoing[w] += c
    bucket.counts.payments += 1
    if (row.parent_type === "expense") {
      bucket.expensePaidCents += c
      const cat = expMeta.get(row.entry_id) || "Outros"
      bucket.byCategoryExpenses[cat] = (bucket.byCategoryExpenses[cat] || 0) + c
    } else {
      bucket.payrollPaidCents += c
      bucket.byCategoryExpenses["Folha de pagamento"] = (bucket.byCategoryExpenses["Folha de pagamento"] || 0) + c
    }
  }

  // 4) Payroll competence counts
  const payrollRows = arrayOf(new DynamicModel({ month: "" }))
  txApp.db().newQuery("SELECT month FROM finance_payroll_records").all(payrollRows)
  for (const row of payrollRows) {
    const b = ensureMonth(String(row.month || ""))
    if (b) b.counts.payroll += 1
  }

  // 5) Transfers and Cash Adjustments
  const taRows = arrayOf(new DynamicModel({
    kind: "",
    date: "",
    from_wallet: "",
    to_wallet: "",
    amount_cents: 0,
  }))
  txApp.db().newQuery("SELECT kind, date, from_wallet, to_wallet, amount_cents FROM finance_transfers_adjustments WHERE kind IN ('transfer', 'cash_adjustment')").all(taRows)
  for (const row of taRows) {
    const bucket = ensureMonth(String(row.date || "").slice(0, 7))
    if (!bucket) continue
    const c = Number(row.amount_cents) || 0
    if (row.kind === "transfer") {
      bucket.counts.transfers += 1
      if (row.from_wallet in bucket.outgoing) {
        bucket.outgoing[row.from_wallet] += c
        bucket.transfersOutCents += c
      }
      if (row.to_wallet !== "oyo" && row.to_wallet in bucket.incoming) {
        bucket.incoming[row.to_wallet] += c
        bucket.transfersInCents += c
      }
    } else if (row.kind === "cash_adjustment") {
      bucket.counts.adjustments += 1
      bucket.adjustmentsNetCents += c
      if (c > 0) bucket.incoming.cash += c
      else bucket.outgoing.cash -= c
    }
  }

  const sortedMonths = [...months.keys()].sort()
  const running = { cash: opening.cash, bank: opening.bank, oyo: opening.oyo }
  const summaryCol = txApp.findCollectionByNameOrId("finance_monthly_summaries")
  const rebuiltAt = new Date().toISOString()
  const keptKeys = new Set()

  for (const month of sortedMonths) {
    const b = months.get(month)
    const openSnap = { cash: running.cash, bank: running.bank, oyo: running.oyo }
    running.cash = running.cash + b.incoming.cash - b.outgoing.cash
    running.bank = running.bank + b.incoming.bank - b.outgoing.bank
    running.oyo = running.oyo + b.incoming.oyo - b.outgoing.oyo
    const closeSnap = { cash: running.cash, bank: running.bank, oyo: running.oyo }
    const netChange = (closeSnap.cash + closeSnap.bank) - (openSnap.cash + openSnap.bank)
    const summaryKey = `month:${month}`
    keptKeys.add(summaryKey)
    const breakdownStr = JSON.stringify({
      opening: openSnap,
      incoming: b.incoming,
      outgoing: b.outgoing,
      closing: closeSnap,
      byCategory: {
        incomes: b.byCategoryIncomes,
        expenses: b.byCategoryExpenses,
      },
      counts: b.counts,
    })
    const entryCount = b.counts.incomes + b.counts.expenses + b.counts.payroll + b.counts.transfers + b.counts.adjustments
    const pbId = deterministicId("finance_monthly_summaries", summaryKey)
    let rec = findByIdOrNull(txApp, "finance_monthly_summaries", pbId)
    const unchanged = Boolean(
      rec
      && rec.getInt("income_direct_cents") === b.incomeDirectCents
      && rec.getInt("income_prepaid_cents") === b.incomePrepaidCents
      && rec.getInt("expense_paid_cents") === b.expensePaidCents
      && rec.getInt("payroll_paid_cents") === b.payrollPaidCents
      && rec.getInt("transfers_in_cents") === b.transfersInCents
      && rec.getInt("transfers_out_cents") === b.transfersOutCents
      && rec.getInt("adjustments_net_cents") === b.adjustmentsNetCents
      && rec.getInt("net_change_cents") === netChange
      && rec.getInt("closing_cash_cents") === closeSnap.cash
      && rec.getInt("closing_bank_cents") === closeSnap.bank
      && rec.getInt("closing_oyo_cents") === closeSnap.oyo
      && rec.getInt("entry_count") === entryCount
      && JSON.stringify(decodeJsonField(rec, "breakdown_json", null)) === breakdownStr,
    )
    if (unchanged) continue
    if (!rec) {
      rec = new Record(summaryCol)
      rec.set("id", pbId)
    }
    rec.set("summary_key", summaryKey)
    rec.set("month", month)
    rec.set("wallet", "all")
    rec.set("category", "__all__")
    rec.set("income_direct_cents", b.incomeDirectCents)
    rec.set("income_prepaid_cents", b.incomePrepaidCents)
    rec.set("expense_paid_cents", b.expensePaidCents)
    rec.set("payroll_paid_cents", b.payrollPaidCents)
    rec.set("transfers_in_cents", b.transfersInCents)
    rec.set("transfers_out_cents", b.transfersOutCents)
    rec.set("adjustments_net_cents", b.adjustmentsNetCents)
    rec.set("net_change_cents", netChange)
    rec.set("closing_cash_cents", closeSnap.cash)
    rec.set("closing_bank_cents", closeSnap.bank)
    rec.set("closing_oyo_cents", closeSnap.oyo)
    rec.set("entry_count", entryCount)
    rec.set("breakdown_json", breakdownStr)
    rec.set("rebuilt_at", rebuiltAt)
    txApp.save(rec)
  }

  // Delete obsolete summary rows if any month became completely empty
  const existingSummaries = txApp.findRecordsByFilter("finance_monthly_summaries", "", "", 0, 0)
  for (const rec of existingSummaries) {
    if (!keptKeys.has(rec.getString("summary_key"))) {
      txApp.delete(rec)
    }
  }
  return sortedMonths.length
}

const recordToIncome = (rec) => {
  const items = decodeJsonField(rec, "items_json", null)
  const out = {
    id: rec.getString("entry_id"),
    date: rec.getString("date"),
    category: rec.getString("category"),
    amount: fromCents(rec.getInt("amount_cents")),
    wallet: rec.getString("wallet") || "bank",
    note: rec.getString("note"),
    createdAt: rec.getString("created_at"),
    updatedAt: rec.getString("updated_at"),
  }
  if (Array.isArray(items) && items.length > 0) out.items = items
  if (rec.getBool("operational_override")) out.operationalOverride = true
  return out
}

const recordToPaymentEvent = (rec) => {
  const ev = {
    id: rec.getString("payment_id"),
    date: rec.getString("paid_at"),
    wallet: rec.getString("wallet"),
    amount: fromCents(rec.getInt("amount_cents")),
  }
  const note = rec.getString("note")
  if (note) ev.note = note
  const statementId = rec.getString("statement_id")
  if (statementId) ev.cardStatementId = statementId
  const ds = rec.getString("date_source")
  if (ds === "informed" || ds === "legacy_due_date") ev.dateSource = ds
  return ev
}

const recordToExpense = (rec, paymentMap) => {
  const id = rec.getString("entry_id")
  const out = {
    id,
    dueDate: rec.getString("date"),
    category: rec.getString("category"),
    plannedAmount: fromCents(rec.getInt("amount_cents")),
    paidCash: fromCents(rec.getInt("paid_cash_cents")),
    paidBank: fromCents(rec.getInt("paid_bank_cents")),
    note: rec.getString("note"),
    createdAt: rec.getString("created_at"),
    updatedAt: rec.getString("updated_at"),
  }
  const paidOyo = fromCents(rec.getInt("paid_oyo_cents"))
  if (paidOyo !== 0) out.paidOyo = paidOyo
  const paidDate = rec.getString("paid_date")
  if (paidDate) out.paidDate = paidDate
  if (rec.getBool("has_explicit_payments")) {
    out.payments = paymentMap.get(id) || {}
  }
  const purchaseMethod = rec.getString("purchase_method")
  if (purchaseMethod) out.purchaseMethod = purchaseMethod
  const purchaseDate = rec.getString("purchase_date")
  if (purchaseDate) out.purchaseDate = purchaseDate
  const cardCategory = rec.getString("card_category")
  if (cardCategory) out.cardCategory = cardCategory
  const cardStatementId = rec.getString("card_statement_id")
  if (cardStatementId) out.cardStatementId = cardStatementId
  const employee = rec.getString("employee")
  if (employee) out.employee = employee
  const employeeId = rec.getString("employee_id")
  if (employeeId) out.employeeId = employeeId
  const advanceMonth = rec.getString("advance_month")
  if (advanceMonth) out.advanceMonth = advanceMonth
  const generatedFromIncome = rec.getString("generated_from_income")
  if (generatedFromIncome) out.generatedFromIncome = generatedFromIncome
  if (rec.getBool("operational_override")) out.operationalOverride = true
  return out
}

const recordToPayroll = (rec, paymentMap) => {
  const id = rec.getString("payroll_id")
  const out = {
    id,
    month: rec.getString("month"),
    dueDate: rec.getString("due_date"),
    employee: rec.getString("employee"),
    position: rec.getString("position"),
    basePay: fromCents(rec.getInt("base_pay_cents")),
    additions: fromCents(rec.getInt("additions_cents")),
    deductions: fromCents(rec.getInt("deductions_cents")),
    paidCash: fromCents(rec.getInt("paid_cash_cents")),
    paidBank: fromCents(rec.getInt("paid_bank_cents")),
    note: rec.getString("note"),
    createdAt: rec.getString("created_at"),
    updatedAt: rec.getString("updated_at"),
  }
  const employeeId = rec.getString("employee_id")
  if (employeeId) out.employeeId = employeeId
  const paidDate = rec.getString("paid_date")
  if (paidDate) out.paidDate = paidDate
  const advances = decodeJsonField(rec, "advances_json", null)
  if (advances && typeof advances === "object" && Object.keys(advances).length > 0) {
    out.advances = advances
  }
  if (rec.getBool("has_explicit_payments")) {
    out.payments = paymentMap.get(id) || {}
  }
  return out
}

const recordToCardStatement = (rec) => {
  const out = {
    id: rec.getString("statement_id"),
    cardCategory: rec.getString("card_category"),
    dueDate: rec.getString("due_date"),
    originalDueDates: decodeJsonField(rec, "original_due_dates_json", {}) || {},
  }
  if (rec.getBool("paid")) {
    out.payment = {
      date: rec.getString("paid_date"),
      wallet: rec.getString("paid_wallet"),
      amount: fromCents(rec.getInt("paid_amount_cents")),
    }
  }
  return out
}

const recordToTransfer = (rec) => {
  const out = {
    id: rec.getString("record_id"),
    date: rec.getString("date"),
    from: rec.getString("from_wallet"),
    to: rec.getString("to_wallet"),
    amount: fromCents(rec.getInt("amount_cents")),
    note: rec.getString("note"),
    createdAt: rec.getString("created_at"),
  }
  const recom = rec.getString("oyo_recom_month")
  if (recom) out.oyoRecomMonth = recom
  return out
}

const recordToCashAdjustment = (rec) => ({
  id: rec.getString("record_id"),
  date: rec.getString("date"),
  amount: fromCents(rec.getInt("amount_cents")),
  note: rec.getString("note"),
  createdAt: rec.getString("created_at"),
  updatedAt: rec.getString("updated_at"),
})

const recordToAuditEvent = (rec) => {
  const changes = decodeJsonField(rec, "changes_json", {}) || {}
  const out = {
    id: rec.getString("event_id"),
    entity: rec.getString("entity_type"),
    recordId: rec.getString("entity_id"),
    action: rec.getString("action"),
    actorUid: rec.getString("actor_uid"),
    occurredAt: rec.getString("occurred_at"),
  }
  const opId = rec.getString("operation_id")
  if (opId) out.operationId = opId
  if (changes.before !== undefined) out.before = changes.before
  if (changes.after !== undefined) out.after = changes.after
  if (changes.summary !== undefined) out.summary = changes.summary
  return out
}

const recordToMonthlySummary = (rec) => ({
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
  breakdown: decodeJsonField(rec, "breakdown_json", {}),
  rebuiltAt: rec.getString("rebuilt_at"),
})

const readNormalizedFinanceData = (app, options) => {
  const opts = options || {}
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : ""
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : ""
  const includeAudit = opts.includeAudit !== false
  const auditLimit = Number.isFinite(opts.auditLimit) ? Math.max(0, Math.trunc(opts.auditLimit)) : 100
  const includePendingOutsideRange = opts.includePendingOutsideRange !== false

  const versions = {}

  // Load config keys in one lightweight query
  const configRecords = app.findRecordsByFilter("finance_config", "", "", 0, 0)
  const configMap = {}
  for (const rec of configRecords) {
    configMap[rec.getString("config_key")] = decodeJsonField(rec, "value_json", null)
  }

  // Load finance_entries + explicit payment rows (indexed & scoped when period from/to is specified!)
  const expPaymentMap = new Map()
  const payPaymentMap = new Map()
  const addPaymentRecord = (rec) => {
    const parentType = rec.getString("parent_type")
    const entryId = rec.getString("entry_id")
    const target = parentType === "payroll" ? payPaymentMap : expPaymentMap
    let map = target.get(entryId)
    if (!map) {
      map = {}
      target.set(entryId, map)
    }
    const ev = recordToPaymentEvent(rec)
    map[ev.id] = ev
  }

  const incomes = {}
  const expenses = {}
  let entryRecords = []
  let payrollRecords = []
  let priorPersistedIds = undefined
  if (from && to) {
    // 1) Fetch only payments whose paid_at falls in [from, to] (uses idx_finance_payments_paid_wallet!)
    const periodPayments = app.findRecordsByFilter(
      "finance_payments",
      "(parent_type = 'expense' || parent_type = 'payroll') && is_explicit = true && paid_at >= {:from} && paid_at <= {:to}",
      "",
      0,
      0,
      { from, to },
    )
    const paymentEntryIdsInRange = new Set()
    for (const rec of periodPayments) {
      paymentEntryIdsInRange.add(`${rec.getString("parent_type")}:${rec.getString("entry_id")}`)
      addPaymentRecord(rec)
    }

    // 2) Fetch period entries (+ pending outside range if requested)
    const filterParts = [
      "(type = 'income' && date >= {:from} && date <= {:to})",
      "(type = 'expense' && ((date >= {:from} && date <= {:to}) || (purchase_date >= {:from} && purchase_date <= {:to}) || (paid_date >= {:from} && paid_date <= {:to})))",
    ]
    if (includePendingOutsideRange) {
      filterParts.push("(type = 'expense' && (status = 'pending' || status = 'partial' || status = 'unassigned_card'))")
    }
    entryRecords = app.findRecordsByFilter("finance_entries", filterParts.join(" || "), "", 0, 0, { from, to })
    const seenIds = new Set(entryRecords.map((r) => r.getString("entry_id")))
    for (const key of paymentEntryIdsInRange) {
      if (!key.startsWith("expense:")) continue
      const eid = key.slice("expense:".length)
      if (seenIds.has(eid)) continue
      const extra = findByIdOrNull(app, "finance_entries", deterministicId("finance_entries", eid))
      if (extra) {
        entryRecords.push(extra)
        seenIds.add(eid)
      }
    }

    // 3) Fetch period payroll records (+ any payroll paid inside [from, to])
    const payrollFilter = "(due_date >= {:from} && due_date <= {:to}) || (month >= {:fromMonth} && month <= {:toMonth}) || status = 'pending' || status = 'partial'"
    payrollRecords = app.findRecordsByFilter("finance_payroll_records", payrollFilter, "", 0, 0, { from, to, fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7) })
    const seenPayrollIds = new Set(payrollRecords.map((r) => r.getString("payroll_id")))
    for (const key of paymentEntryIdsInRange) {
      if (!key.startsWith("payroll:")) continue
      const pid = key.slice("payroll:".length)
      if (seenPayrollIds.has(pid)) continue
      const extra = findByIdOrNull(app, "finance_payroll_records", deterministicId("finance_payroll_records", pid))
      if (extra) {
        payrollRecords.push(extra)
        seenPayrollIds.add(pid)
      }
    }

    // 4) Fetch remaining explicit payments ONLY for the returned expenses & payroll records (e.g. partial payments in other months)
    const expIdsNeedPayments = entryRecords
      .filter((r) => r.getString("type") === "expense" && r.getBool("has_explicit_payments"))
      .map((r) => r.getString("entry_id"))
    for (let i = 0; i < expIdsNeedPayments.length; i += 80) {
      const chunk = expIdsNeedPayments.slice(i, i + 80)
      const params = {}
      const clauses = chunk.map((id, idx) => {
        const p = `e${idx}`
        params[p] = id
        return `entry_id = {:${p}}`
      })
      const recs = app.findRecordsByFilter(
        "finance_payments",
        `parent_type = 'expense' && is_explicit = true && (${clauses.join(" || ")})`,
        "",
        0,
        0,
        params,
      )
      for (const rec of recs) addPaymentRecord(rec)
    }
    const prIdsNeedPayments = payrollRecords
      .filter((r) => r.getBool("has_explicit_payments"))
      .map((r) => r.getString("payroll_id"))
    for (let i = 0; i < prIdsNeedPayments.length; i += 80) {
      const chunk = prIdsNeedPayments.slice(i, i + 80)
      const params = {}
      const clauses = chunk.map((id, idx) => {
        const p = `p${idx}`
        params[p] = id
        return `entry_id = {:${p}}`
      })
      const recs = app.findRecordsByFilter(
        "finance_payments",
        `parent_type = 'payroll' && is_explicit = true && (${clauses.join(" || ")})`,
        "",
        0,
        0,
        params,
      )
      for (const rec of recs) addPaymentRecord(rec)
    }

    // 5) Collect IDs of prior persisted operational entries (< from) so the client never double-counts them against finance_monthly_summaries
    const priorOpRows = arrayOf(new DynamicModel({ entry_id: "" }))
    app.db().newQuery("SELECT entry_id FROM finance_entries WHERE source_ref != '' AND date < {:from}").bind({ from }).all(priorOpRows)
    priorPersistedIds = priorOpRows.map((r) => r.entry_id).filter((eid) => !seenIds.has(eid))
  } else {
    const paymentFilter = "(parent_type = 'expense' || parent_type = 'payroll') && is_explicit = true"
    const paymentRecords = app.findRecordsByFilter("finance_payments", paymentFilter, "", 0, 0)
    for (const rec of paymentRecords) addPaymentRecord(rec)
    entryRecords = app.findRecordsByFilter("finance_entries", "", "", 0, 0)
    payrollRecords = app.findRecordsByFilter("finance_payroll_records", "", "", 0, 0)
  }

  for (const rec of entryRecords) {
    const id = rec.getString("entry_id")
    const type = rec.getString("type")
    versions[`${type}:${id}`] = rec.getInt("version")
    if (type === "income") {
      incomes[id] = recordToIncome(rec)
    } else if (type === "expense") {
      expenses[id] = recordToExpense(rec, expPaymentMap)
    }
  }

  // Card statements
  const cardStatements = {}
  const stmtRecords = app.findRecordsByFilter("finance_card_statements", "", "", 0, 0)
  for (const rec of stmtRecords) {
    const st = recordToCardStatement(rec)
    cardStatements[st.id] = st
    versions[`card_statement:${st.id}`] = rec.getInt("version")
  }

  // Payroll
  const payroll = {}
  for (const rec of payrollRecords) {
    const pr = recordToPayroll(rec, payPaymentMap)
    payroll[pr.id] = pr
    versions[`payroll:${pr.id}`] = rec.getInt("version")
  }

  // Transfers, Cash Adjustments, OYO Reconciliations
  const transfers = {}
  const cashAdjustments = {}
  const oyoReconciliations = {}
  const taFilter = from && to
    ? "kind = 'oyo_reconciliation' || (date >= {:from} && date <= {:to})"
    : ""
  const taRecords = from && to
    ? app.findRecordsByFilter("finance_transfers_adjustments", taFilter, "", 0, 0, { from, to })
    : app.findRecordsByFilter("finance_transfers_adjustments", "", "", 0, 0)
  for (const rec of taRecords) {
    const kind = rec.getString("kind")
    const recordId = rec.getString("record_id")
    versions[`${kind}:${recordId}`] = rec.getInt("version")
    if (kind === "transfer") transfers[recordId] = recordToTransfer(rec)
    else if (kind === "cash_adjustment") cashAdjustments[recordId] = recordToCashAdjustment(rec)
    else if (kind === "oyo_reconciliation") oyoReconciliations[recordId] = decodeJsonField(rec, "payload_json", {})
  }

  // Audit log (paginated / bounded)
  const auditLog = {}
  if (includeAudit) {
    const auditRecords = app.findRecordsByFilter("finance_audit_logs", "", "-occurred_at", auditLimit, 0)
    for (const rec of auditRecords) {
      const ev = recordToAuditEvent(rec)
      auditLog[ev.id] = ev
    }
  }

  // Monthly summaries
  const summaries = {}
  if (opts.includeSummaries !== false) {
    const summaryRecords = app.findRecordsByFilter("finance_monthly_summaries", "", "month", 0, 0)
    for (const rec of summaryRecords) {
      const s = recordToMonthlySummary(rec)
      summaries[s.month] = s
    }
  }

  const financeData = {
    cardStatements,
    cardFeeSchedule: configMap.cardFeeSchedule || {},
    cashAdjustments,
    incomes,
    expenses,
    transfers,
    payroll,
    openingBalances: configMap.openingBalances || { cash: 0, bank: 0, oyo: 0 },
    incomeCategories: Array.isArray(configMap.incomeCategories) ? configMap.incomeCategories : [],
    expenseCategories: Array.isArray(configMap.expenseCategories) ? configMap.expenseCategories : [],
    auditLog,
    suppressed: configMap.suppressed || {},
    deletions: configMap.deletions || {},
    categoryAliases: configMap.categoryAliases || { income: {}, expense: {} },
    oyoReconciliations,
    cashCollectionAcks: configMap.cashCollectionAcks || {},
    cleaningConcernAcks: configMap.cleaningConcernAcks || {},
    reportDashboards: configMap.reportDashboards ?? null,
  }

  return {
    data: financeData,
    summaries,
    versions,
    filtered: Boolean(from && to),
    ...(priorPersistedIds ? { priorPersistedIds } : {}),
  }
}

// Fast indexed read for targeted erp_geral/financeiro/<subPath> queries
const readNormalizedFinancePath = (app, subPath) => {
  const parts = String(subPath || "").split("/").filter(Boolean)
  if (parts.length === 0) {
    return readNormalizedFinanceData(app, { includeAudit: true, auditLimit: 0, includeSummaries: false }).data
  }
  const section = parts[0]
  const id = parts[1]
  const configKeys = new Set([
    "openingBalances",
    "incomeCategories",
    "expenseCategories",
    "categoryAliases",
    "cardFeeSchedule",
    "suppressed",
    "deletions",
    "cashCollectionAcks",
    "cleaningConcernAcks",
    "reportDashboards",
    "managerWriteLock",
  ])
  if (configKeys.has(section)) {
    const val = getConfigValue(app, section, section === "reportDashboards" ? null : section.endsWith("Categories") ? [] : {})
    let node = val
    for (const part of parts.slice(1)) {
      if (node === null || node === undefined || typeof node !== "object") { node = null; break }
      node = node[part] ?? null
    }
    return node
  }
  if (section === "incomes") {
    if (id) {
      const rec = findByIdOrNull(app, "finance_entries", deterministicId("finance_entries", id))
      if (!rec || rec.getString("type") !== "income") return null
      let node = recordToIncome(rec)
      for (const part of parts.slice(2)) node = node && typeof node === "object" ? (node[part] ?? null) : null
      return node
    }
    const recs = app.findRecordsByFilter("finance_entries", "type = 'income'", "", 0, 0)
    const out = {}
    for (const r of recs) out[r.getString("entry_id")] = recordToIncome(r)
    return out
  }
  if (section === "expenses") {
    if (id) {
      const rec = findByIdOrNull(app, "finance_entries", deterministicId("finance_entries", id))
      if (!rec || rec.getString("type") !== "expense") return null
      const payRecs = app.findRecordsByFilter("finance_payments", "parent_type = 'expense' && entry_id = {:id} && is_explicit = true", "", 0, 0, { id })
      const pMap = new Map()
      if (rec.getBool("has_explicit_payments")) {
        const obj = {}
        for (const pr of payRecs) {
          const ev = recordToPaymentEvent(pr)
          obj[ev.id] = ev
        }
        pMap.set(id, obj)
      }
      let node = recordToExpense(rec, pMap)
      for (const part of parts.slice(2)) node = node && typeof node === "object" ? (node[part] ?? null) : null
      return node
    }
    const payRecs = app.findRecordsByFilter("finance_payments", "parent_type = 'expense' && is_explicit = true", "", 0, 0)
    const pMap = new Map()
    for (const pr of payRecs) {
      const eid = pr.getString("entry_id")
      let obj = pMap.get(eid)
      if (!obj) { obj = {}; pMap.set(eid, obj) }
      const ev = recordToPaymentEvent(pr)
      obj[ev.id] = ev
    }
    const recs = app.findRecordsByFilter("finance_entries", "type = 'expense'", "", 0, 0)
    const out = {}
    for (const r of recs) out[r.getString("entry_id")] = recordToExpense(r, pMap)
    return out
  }
  if (section === "payroll") {
    const payRecs = app.findRecordsByFilter("finance_payments", "parent_type = 'payroll' && is_explicit = true", "", 0, 0)
    const pMap = new Map()
    for (const pr of payRecs) {
      const pid = pr.getString("entry_id")
      let obj = pMap.get(pid)
      if (!obj) { obj = {}; pMap.set(pid, obj) }
      const ev = recordToPaymentEvent(pr)
      obj[ev.id] = ev
    }
    if (id) {
      const rec = findByIdOrNull(app, "finance_payroll_records", deterministicId("finance_payroll_records", id))
      return rec ? recordToPayroll(rec, pMap) : null
    }
    const recs = app.findRecordsByFilter("finance_payroll_records", "", "", 0, 0)
    const out = {}
    for (const r of recs) out[r.getString("payroll_id")] = recordToPayroll(r, pMap)
    return out
  }
  if (section === "cardStatements") {
    if (id) {
      const rec = findByIdOrNull(app, "finance_card_statements", deterministicId("finance_card_statements", id))
      return rec ? recordToCardStatement(rec) : null
    }
    const recs = app.findRecordsByFilter("finance_card_statements", "", "", 0, 0)
    const out = {}
    for (const r of recs) out[r.getString("statement_id")] = recordToCardStatement(r)
    return out
  }
  if (section === "transfers" || section === "cashAdjustments" || section === "oyoReconciliations") {
    const kind = section === "transfers" ? "transfer" : section === "cashAdjustments" ? "cash_adjustment" : "oyo_reconciliation"
    if (id) {
      const rec = findByIdOrNull(app, "finance_transfers_adjustments", deterministicId("finance_transfers_adjustments", `${kind}:${id}`))
      if (!rec) return null
      return kind === "transfer" ? recordToTransfer(rec) : kind === "cash_adjustment" ? recordToCashAdjustment(rec) : decodeJsonField(rec, "payload_json", {})
    }
    const recs = app.findRecordsByFilter("finance_transfers_adjustments", "kind = {:kind}", "", 0, 0, { kind })
    const out = {}
    for (const r of recs) {
      const rid = r.getString("record_id")
      out[rid] = kind === "transfer" ? recordToTransfer(r) : kind === "cash_adjustment" ? recordToCashAdjustment(r) : decodeJsonField(r, "payload_json", {})
    }
    return out
  }
  if (section === "auditLog") {
    if (id) {
      const rec = findByIdOrNull(app, "finance_audit_logs", deterministicId("finance_audit_logs", id))
      return rec ? recordToAuditEvent(rec) : null
    }
    const recs = app.findRecordsByFilter("finance_audit_logs", "", "-occurred_at", 100, 0)
    const out = {}
    for (const r of recs) out[r.getString("event_id")] = recordToAuditEvent(r)
    return out
  }
  return null
}

const readNormalizedFinancePathWithVersion = (app, subPath) => {
  const parts = String(subPath || "").split("/").filter(Boolean)
  const value = readNormalizedFinancePath(app, subPath)
  if (parts.length === 0) return { value, versionKey: null, version: null }
  const section = parts[0]
  const id = parts[1]
  const configKeys = new Set([
    "openingBalances",
    "incomeCategories",
    "expenseCategories",
    "categoryAliases",
    "cardFeeSchedule",
    "suppressed",
    "deletions",
    "cashCollectionAcks",
    "cleaningConcernAcks",
    "reportDashboards",
    "managerWriteLock",
  ])
  if (configKeys.has(section)) {
    const rec = findByIdOrNull(app, "finance_config", deterministicId("finance_config", section))
    return { value, versionKey: `config:${section}`, version: rec ? rec.getInt("version") : null }
  }
  if ((section === "incomes" || section === "expenses") && id) {
    const rec = findByIdOrNull(app, "finance_entries", deterministicId("finance_entries", id))
    const kind = section === "incomes" ? "income" : "expense"
    return { value, versionKey: `${kind}:${id}`, version: rec && rec.getString("type") === kind ? rec.getInt("version") : null }
  }
  if (section === "cardStatements" && id) {
    const rec = findByIdOrNull(app, "finance_card_statements", deterministicId("finance_card_statements", id))
    return { value, versionKey: `card_statement:${id}`, version: rec ? rec.getInt("version") : null }
  }
  if (section === "payroll" && id) {
    const rec = findByIdOrNull(app, "finance_payroll_records", deterministicId("finance_payroll_records", id))
    return { value, versionKey: `payroll:${id}`, version: rec ? rec.getInt("version") : null }
  }
  if ((section === "transfers" || section === "cashAdjustments" || section === "oyoReconciliations") && id) {
    const kind = section === "transfers" ? "transfer" : section === "cashAdjustments" ? "cash_adjustment" : "oyo_reconciliation"
    const rec = findByIdOrNull(app, "finance_transfers_adjustments", deterministicId("finance_transfers_adjustments", `${kind}:${id}`))
    return { value, versionKey: `${kind}:${id}`, version: rec ? rec.getInt("version") : null }
  }
  return { value, versionKey: null, version: null }
}

// Applies a structured finance mutation inside an active PocketBase transaction (txApp).
const applyFinanceMutationInTx = (txApp, mutation) => {
  const m = mutation || {}
  const expected = m.expectedVersions || {}
  let changed = 0
  let summaryDirty = false

  // 1) Config updates first so suppressed / openingBalances are up-to-date before upserts/summary rebuild
  const suppressedMap = { ...(getConfigValue(txApp, "suppressed", {}) || {}) }
  let suppressedChanged = false
  if (m.suppressed && typeof m.suppressed === "object") {
    for (const [id, val] of Object.entries(m.suppressed)) {
      if (val === null || val === false) {
        if (Object.hasOwn(suppressedMap, id)) { delete suppressedMap[id]; suppressedChanged = true; changed++ }
      } else {
        if (suppressedMap[id] !== true) { suppressedMap[id] = true; suppressedChanged = true; changed++ }
      }
      // Keep suppressed flag synchronized on existing finance_entries row if present
      const rec = findByIdOrNull(txApp, "finance_entries", deterministicId("finance_entries", id))
      if (rec) {
        const sup = Boolean(val)
        rec.set("suppressed", sup)
        if (sup) rec.set("status", "suppressed")
        txApp.save(rec)
      }
    }
  }
  if (suppressedChanged || Object.hasOwn(expected, "config:suppressed")) {
    setConfigValue(txApp, "suppressed", suppressedMap, 2, expected["config:suppressed"])
    if (suppressedChanged) summaryDirty = true
  }

  // Merge map-style config keys (deletions, cashCollectionAcks, cleaningConcernAcks, cardFeeSchedule, categoryAliases)
  const mapConfigKeys = ["deletions", "cashCollectionAcks", "cleaningConcernAcks", "cardFeeSchedule"]
  for (const key of mapConfigKeys) {
    if (m[key] && typeof m[key] === "object") {
      const current = { ...(getConfigValue(txApp, key, {}) || {}) }
      for (const [k, v] of Object.entries(m[key])) {
        if (v === null) delete current[k]
        else current[k] = v
        changed++
      }
      setConfigValue(txApp, key, current, 2, expected[`config:${key}`])
    } else if (Object.hasOwn(expected, `config:${key}`)) {
      const current = { ...(getConfigValue(txApp, key, {}) || {}) }
      setConfigValue(txApp, key, current, 2, expected[`config:${key}`])
    }
  }
  if (m.config && typeof m.config === "object") {
    for (const [key, value] of Object.entries(m.config)) {
      if (key === "systemMeta") continue // systemMeta only changed via admin control endpoint
      if (key === "categoryAliases" && value && typeof value === "object") {
        const current = getConfigValue(txApp, "categoryAliases", { income: {}, expense: {} }) || { income: {}, expense: {} }
        const merged = {
          income: { ...(current.income || {}) },
          expense: { ...(current.expense || {}) },
        }
        for (const kind of ["income", "expense"]) {
          if (value[kind] && typeof value[kind] === "object") {
            for (const [ak, av] of Object.entries(value[kind])) {
              if (av === null) delete merged[kind][ak]
              else merged[kind][ak] = av
            }
          }
        }
        setConfigValue(txApp, "categoryAliases", merged, 2, expected["config:categoryAliases"])
      } else {
        setConfigValue(txApp, key, value, 2, expected[`config:${key}`])
      }
      changed++
      if (key === "openingBalances") summaryDirty = true
    }
  }

  // 2) Incomes
  if (m.incomes && typeof m.incomes === "object") {
    for (const [id, entry] of Object.entries(m.incomes)) {
      if (entry === null) {
        deleteEntry(txApp, id, "income")
      } else {
        upsertIncome(txApp, { ...entry, id }, Boolean(suppressedMap[id]), expected[`income:${id}`])
      }
      changed++
      summaryDirty = true
    }
  }

  // 3) Expenses (+ child payments)
  if (m.expenses && typeof m.expenses === "object") {
    for (const [id, entry] of Object.entries(m.expenses)) {
      if (entry === null) {
        deleteEntry(txApp, id, "expense")
      } else {
        upsertExpense(txApp, { ...entry, id }, Boolean(suppressedMap[id]), expected[`expense:${id}`])
      }
      changed++
      summaryDirty = true
    }
  }

  // 4) Card Statements
  if (m.cardStatements && typeof m.cardStatements === "object") {
    for (const [id, st] of Object.entries(m.cardStatements)) {
      if (st === null) deleteCardStatement(txApp, id)
      else upsertCardStatement(txApp, { ...st, id }, expected[`card_statement:${id}`])
      changed++
      summaryDirty = true
    }
  }

  // 5) Payroll (+ child payments)
  if (m.payroll && typeof m.payroll === "object") {
    for (const [id, pr] of Object.entries(m.payroll)) {
      if (pr === null) deletePayroll(txApp, id)
      else upsertPayroll(txApp, { ...pr, id }, expected[`payroll:${id}`])
      changed++
      summaryDirty = true
    }
  }

  // 6) Transfers, Cash Adjustments, OYO Reconciliations
  if (m.transfers && typeof m.transfers === "object") {
    for (const [id, tr] of Object.entries(m.transfers)) {
      if (tr === null) deleteTransferAdjustment(txApp, "transfer", id)
      else upsertTransfer(txApp, { ...tr, id }, expected[`transfer:${id}`])
      changed++
      summaryDirty = true
    }
  }
  if (m.cashAdjustments && typeof m.cashAdjustments === "object") {
    for (const [id, adj] of Object.entries(m.cashAdjustments)) {
      if (adj === null) deleteTransferAdjustment(txApp, "cash_adjustment", id)
      else upsertCashAdjustment(txApp, { ...adj, id }, expected[`cash_adjustment:${id}`])
      changed++
      summaryDirty = true
    }
  }
  if (m.oyoReconciliations && typeof m.oyoReconciliations === "object") {
    for (const [month, rec] of Object.entries(m.oyoReconciliations)) {
      if (rec === null) deleteTransferAdjustment(txApp, "oyo_reconciliation", month)
      else upsertOyoReconciliation(txApp, month, rec, expected[`oyo_reconciliation:${month}`])
      changed++
    }
  }

  // 7) Audit logs (append-only, or explicit manager deletion)
  if (m.auditLog && typeof m.auditLog === "object") {
    for (const [eventId, ev] of Object.entries(m.auditLog)) {
      if (ev === null) deleteAuditEvent(txApp, eventId)
      else upsertAuditEvent(txApp, eventId, { ...ev, id: eventId })
      changed++
    }
  }

  // 8) Rebuild summaries inside the SAME atomic transaction if any monetary entity changed
  if (summaryDirty && m.skipSummaryRebuild !== true) {
    rebuildMonthlySummaries(txApp)
  }

  return { changed, summaryDirty }
}

module.exports = {
  DEFAULT_SYSTEM_META,
  toCents,
  fromCents,
  deterministicId,
  decodeJsonValue,
  decodeJsonField,
  resolveUserRole,
  hasCollection,
  findByIdOrNull,
  getConfigValue,
  setConfigValue,
  getSystemMeta,
  enforceSchemaAndMaintenance,
  incomePaymentWallet,
  normalizeIncomeItems,
  isOyoFeeItem,
  financeReceiptItems,
  deriveSourceRef,
  deriveExpensePaymentRows,
  derivePayrollPaymentRows,
  upsertIncome,
  upsertExpense,
  deleteEntry,
  upsertCardStatement,
  deleteCardStatement,
  upsertPayroll,
  deletePayroll,
  upsertTransfer,
  upsertCashAdjustment,
  upsertOyoReconciliation,
  deleteTransferAdjustment,
  upsertAuditEvent,
  deleteAuditEvent,
  rebuildMonthlySummaries,
  readNormalizedFinanceData,
  readNormalizedFinancePath,
  readNormalizedFinancePathWithVersion,
  applyFinanceMutationInTx,
}
