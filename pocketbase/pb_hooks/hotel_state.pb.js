routerAdd("GET", "/api/hotel/me", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const auth = event.requestInfo().auth
  const role = core.resolveUserRole($app, auth)
  return event.json(200, { id: auth.get("id"), role })
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/state", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)

  const query = event.requestInfo().query
  const path = String(query.path || "").replace(/^\/+|\/+$/g, "")
  const adminOnlyRead = [
    "erp_geral/estoque",
    "erp_geral/quartos/reservations",
    "erp_geral/quartos/reservationSlots",
    "erp_geral/quartos/auditLog",
    "erp_geral/quartos/cleaningLogs",
    "erp_geral/financeiro",
    "erp_geral/reservationCollections",
    "erp_geral/reservationExtras",
    "erp_geral/reservationCollectionReconciliations",
  ]
  const viewerReadable = ["erp_geral/financeiro/cardFeeSchedule"]
  const viewerAllowed = viewerReadable.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
  const denied = !viewerAllowed && adminOnlyRead.some((prefix) => path === prefix || path.startsWith(prefix + "/") || prefix.startsWith(path + "/"))
  // A revisão não expõe dados e é necessária para qualquer gravação permitida ao perfil.
  if (role !== "admin" && denied && !query.versionOnly) throw new ForbiddenError("Seu perfil não pode acessar estes dados.")

  const meta = core.enforceSchemaAndMaintenance($app, event, false)
  const useNormalizedFinance = meta.financeMode === "normalized" && core.hasCollection($app, "finance_entries")

  const root = path.split("/").slice(0, 2).join("/")
  // When normalized finance is active, targeted reads under erp_geral/financeiro serve from normalized collections.
  if (useNormalizedFinance && root === "erp_geral/financeiro") {
    if (query.versionOnly) {
      const cfg = core.getSystemMeta($app)
      return event.json(200, { value: null, versions: { "erp_geral/financeiro": Number(cfg.schemaVersion || 2) } })
    }
    const subPath = path === "erp_geral/financeiro" ? "" : path.slice("erp_geral/financeiro/".length)
    const value = core.readNormalizedFinancePath($app, subPath)
    return event.json(200, { value, versions: { "erp_geral/financeiro": Number(meta.schemaVersion || 2) } })
  }

  // Carrega só os registros necessários em vez de toda a coleção a cada requisição.
  const records = path === "erp_geral"
    ? $app.findRecordsByFilter("hotel_state", "path ~ 'erp_geral/%'", "path", 10000, 0)
    : path === ""
      ? $app.findRecordsByFilter("hotel_state", "", "path", 10000, 0)
      : $app.findRecordsByFilter("hotel_state", "path = {:root}", "", 1, 0, { root })
  if (query.versionOnly && path.split("/").length >= 2) {
    const record = records[0]
    return event.json(200, { value: null, versions: { [root]: record?.getInt("revision") ?? null } })
  }
  const decodeValue = (record) => {
    const raw = record.get("value")
    if (!raw || typeof raw === "string") return raw ? JSON.parse(raw) : {}
    if (typeof raw !== "object" || typeof raw.length !== "number") return raw
    return JSON.parse(toString(raw))
  }
  const selected = path === "erp_geral"
    ? records.filter((record) => record.getString("path").startsWith("erp_geral/"))
    : records.filter((record) => record.getString("path") === root && path !== "")
  const versions = Object.fromEntries(selected.map((record) => [record.getString("path"), record.getInt("revision")]))
  if (path === "erp_geral") {
    const value = {}
    for (const record of selected) {
      const recPath = record.getString("path")
      if (useNormalizedFinance && recPath === "erp_geral/financeiro") {
        // Serve normalized incomes & suppressed (and full finance) seamlessly for Cloudflare checkout & state readers.
        value.financeiro = core.readNormalizedFinanceData($app, { includeAudit: false, includeSummaries: false }).data
        continue
      }
      const relative = recPath.slice("erp_geral/".length).split("/")
      let target = value
      for (const part of relative.slice(0, -1)) {
        target[part] ??= {}
        target = target[part]
      }
      target[relative[relative.length - 1]] = decodeValue(record)
    }
    if (useNormalizedFinance && !value.financeiro) {
      value.financeiro = core.readNormalizedFinanceData($app, { includeAudit: false, includeSummaries: false }).data
    }
    return event.json(200, { value, versions })
  }

  if (!path) {
    if (role !== "admin") throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
    const value = Object.fromEntries(selected.map((record) => [record.getString("path"), decodeValue(record)]))
    return event.json(200, { value, versions })
  }
  if (path.split("/").length < 2) throw new BadRequestError("Caminho de dados inválido.")

  const record = selected[0]
  let value = record ? decodeValue(record) : null
  const relative = path === root ? [] : path.slice(root.length + 1).split("/")
  for (const part of relative) {
    if (value === null || typeof value !== "object") {
      value = null
      break
    }
    value = value[part] ?? null
  }
  return event.json(200, { value, versions: { [root]: record?.getInt("revision") ?? null } })
}, $apis.requireAuth())

routerAdd("POST", "/api/hotel/state/commit", (event) => {
  const core = require(__hooks + "/finance_core.js")
  const stateTx = require(__hooks + "/hotel_state_tx.js")
  const role = core.resolveUserRole($app, event.requestInfo().auth)
  const meta = core.enforceSchemaAndMaintenance($app, event, true)

  const body = event.requestInfo().body
  const updates = body.updates
  const expected = body.expected
  const roots = stateTx.validateStateUpdatesAccess(role, updates, expected, {
    financeLegacyFrozen: Boolean(meta.financeLegacyFrozen),
  })

  let result = { changed: 0, savedSizes: [] }
  try {
    $app.runInTransaction((txApp) => {
      result = stateTx.applyHotelStateUpdatesInTx(txApp, role, updates, expected, body.sourceHash, roots)
    })
  } catch (error) {
    console.error("PocketBase state commit failed", error)
    throw error
  }
  stateTx.logSavedSizes($app, result.savedSizes)
  return event.json(200, { committed: true, changed: result.changed })
}, $apis.requireAuth())
