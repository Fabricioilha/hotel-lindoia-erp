// Shared transactional hotel_state mutation logic (permissions, optimistic locking, size telemetry).
// Loaded inside hook/route handlers via require(__hooks + "/hotel_state_tx.js").

const HOTEL_STATE_WARN_BYTES = 1572864
const HOTEL_STATE_CRITICAL_BYTES = 2621440
const HOTEL_STATE_MAX_BYTES = 4194304

const utf8ByteLength = (text) => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

const ADMIN_ONLY_WRITE = [
  "erp_geral/escala",
  "erp_geral/estoque",
  "erp_geral/quartos/reservations",
  "erp_geral/quartos/reservationIndex",
  "erp_geral/quartos/reservationSlots",
  "erp_geral/quartos/auditLog",
  "erp_geral/financeiro",
  "erp_geral/reservationCollections",
  "erp_geral/reservationExtras",
  "erp_geral/reservationCollectionReconciliations",
  "erp_geral/frigobar/catalog",
  "erp_geral/frigobar/operations/catalogSyncs",
  "erp_geral/recepcao/rates",
  "erp_geral/recepcao/attendants",
  "erp_geral/limpeza/camareiras",
  "erp_geral/limpeza/camareirasConfigured",
  "erp_geral/saidas/catalog",
]

const VIEWER_WRITABLE_PREFIXES = [
  "erp_geral/stockProductLocks",
  "erp_geral/frigobar/operations/stock",
  "erp_geral/frigobar/operations/sales",
  "erp_geral/recepcao/rooms",
  "erp_geral/recepcao/floatChecks",
  "erp_geral/recepcao/shiftHandoffs",
  "erp_geral/recepcao/cashOuts",
  "erp_geral/recepcao/stays",
  "erp_geral/recepcao/roomCharges",
  "erp_geral/saidas/records",
]

const protectedWrite = (path) => ADMIN_ONLY_WRITE.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
const viewerCleaningPath = (path) => path.startsWith("erp_geral/quartos/rooms/")
  || path.startsWith("erp_geral/quartos/cleaningLogs/")
  || path.startsWith("erp_geral/limpeza/activeRooms/")
  || path.startsWith("erp_geral/limpeza/tasks/")
const viewerWritablePath = (path) => viewerCleaningPath(path)
  || VIEWER_WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix + "/"))
  || path === "erp_geral/frigobar/operations/stock"

const stateValue = (entries, path, before) => {
  const parts = path.split("/")
  const root = parts.slice(0, 2).join("/")
  const entry = entries.get(root)
  let value = before ? entry?.before : entry?.value
  for (const part of parts.slice(2)) value = value && typeof value === "object" ? value[part] : undefined
  return value
}

const courtesyFields = (stay) => {
  const fields = []
  if (stay?.courtesy) fields.push("stay")
  for (const item of ["daily", "breakfast", "tax"]) {
    if (stay?.[item + "Method"] === "courtesy") fields.push(item)
    if (stay?.[item + "Split"]?.method === "courtesy") fields.push(item + "Split")
  }
  if (Array.isArray(stay?.extras)) {
    for (const extra of stay.extras) if (extra?.method === "courtesy") fields.push("extra/" + extra.id)
  }
  for (const [id, receipt] of Object.entries(stay?.receipts ?? {})) {
    if (receipt?.method === "courtesy") fields.push("receipt/" + id)
  }
  return JSON.stringify(fields.sort())
}

const validViewerCleaningWrite = (path, entries) => {
  const parts = path.split("/")
  if (parts[0] !== "erp_geral") return false
  if (parts[1] === "quartos" && parts[2] === "rooms" && parts.length === 5) {
    const field = parts[4]
    const value = stateValue(entries, path, false)
    if (field === "maintenanceStatus") return value === "em_manutencao" || value === "normal"
    if (field !== "cleaningStatus") return false
    if (value === "sujo") return true

    const roomId = parts[3]
    const room = stateValue(entries, `erp_geral/quartos/rooms/${roomId}`, false)
    if (value === "em_limpeza") {
      const lock = stateValue(entries, `erp_geral/limpeza/activeRooms/${roomId}`, false)
      if (!lock || typeof lock !== "object") return false
      const task = stateValue(entries, `erp_geral/limpeza/tasks/${lock.taskId}`, false)
      return lock.phase === "assigning" && task?.status === "em_limpeza"
        && task.roomId === roomId && task.roomNumber === room?.number
        && room?.maintenanceStatus !== "em_manutencao"
    }
    if (value === "limpo") {
      const finishingLock = stateValue(entries, `erp_geral/limpeza/activeRooms/${roomId}`, true)
      const task = stateValue(entries, `erp_geral/limpeza/tasks/${finishingLock?.taskId}`, false)
      const log = task?.cleaningLogId
        ? stateValue(entries, `erp_geral/quartos/cleaningLogs/${task.cleaningLogId}`, false)
        : undefined
      return finishingLock?.phase === "finishing" && finishingLock.taskId === task?.id
        && task?.status === "concluido" && log?.roomId === roomId
        && room?.maintenanceStatus !== "em_manutencao"
    }
    return false
  }

  if (parts[1] === "limpeza" && parts[2] === "activeRooms" && parts.length === 4) {
    const roomId = parts[3]
    const lock = stateValue(entries, path, false)
    if (lock === undefined) return true
    if (!lock || typeof lock !== "object" || typeof lock.taskId !== "string"
      || !Number.isFinite(lock.expiresAt)) return false
    const room = stateValue(entries, `erp_geral/quartos/rooms/${roomId}`, false)
    const task = stateValue(entries, `erp_geral/limpeza/tasks/${lock.taskId}`, false)
    if (lock.phase === "assigning") {
      return Boolean(room) && room.maintenanceStatus !== "em_manutencao"
        && (!task || (task.status === "em_limpeza" && task.roomId === roomId))
    }
    if (lock.phase === "finishing") {
      return task?.status === "em_limpeza" && task.roomId === roomId
        && task.roomNumber === room.number
    }
    return false
  }

  if (parts[1] === "limpeza" && parts[2] === "tasks" && parts.length >= 4) {
    const taskId = parts[3]
    const previous = stateValue(entries, `erp_geral/limpeza/tasks/${taskId}`, true)
    const next = stateValue(entries, `erp_geral/limpeza/tasks/${taskId}`, false)
    const lock = stateValue(entries, `erp_geral/limpeza/activeRooms/${next?.roomId || previous?.roomId}`, false)
    if (!previous) {
      const room = stateValue(entries, `erp_geral/quartos/rooms/${next?.roomId}`, false)
      return next?.id === taskId && next?.status === "em_limpeza"
        && lock?.taskId === taskId && lock.phase === "assigning"
        && room?.number === next.roomNumber && room?.maintenanceStatus !== "em_manutencao"
    }
    const immutable = ["id", "roomNumber", "camareira", "assignedBy", "assignedAt", "date"]
    return previous.status === "em_limpeza" && next?.id === taskId
      && (next.status === "concluido" || next.status === "cancelado")
      && immutable.every((key) => previous[key] === next[key])
  }

  if (parts[1] === "quartos" && parts[2] === "cleaningLogs" && parts.length === 4) {
    const logId = parts[3]
    const log = stateValue(entries, path, false)
    const previousLog = stateValue(entries, path, true)
    if (previousLog || !log || typeof log.roomId !== "string") return false
    const roomId = log.roomId
    const lock = stateValue(entries, `erp_geral/limpeza/activeRooms/${roomId}`, true)
    const task = stateValue(entries, `erp_geral/limpeza/tasks/${lock?.taskId}`, true)
    const nextTask = stateValue(entries, `erp_geral/limpeza/tasks/${lock?.taskId}`, false)
    return log.id === `task-${lock?.taskId}` && logId === log.id && lock?.phase === "finishing"
      && task?.status === "em_limpeza" && nextTask?.status === "concluido"
      && nextTask.cleaningLogId === log.id && task.roomNumber === log.roomNumber
      && task.camareira === log.attendant
  }
  return false
}

const storedValue = (record) => {
  if (!record) return {}
  const raw = record.get("value")
  if (typeof raw === "string") return JSON.parse(raw)
  if (raw && typeof raw === "object" && typeof raw.length === "number") {
    return JSON.parse(toString(raw))
  }
  return raw ?? {}
}

const validateStateUpdatesAccess = (role, updates, expected, options) => {
  const opts = options || {}
  if (!updates || typeof updates !== "object" || Array.isArray(updates) || !expected || typeof expected !== "object") {
    throw new BadRequestError("Atualização inválida.")
  }
  const roots = [...new Set(Object.keys(updates).map((path) => {
    const parts = String(path).replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length < 2) throw new BadRequestError("Caminho de dados inválido.")
    return parts.slice(0, 2).join("/")
  }))]
  for (const path of Object.keys(updates)) {
    const normalized = String(path).replace(/^\/+|\/+$/g, "")
    if (!normalized.startsWith("erp_geral/")) throw new ForbiddenError("Seu perfil não pode alterar estes dados.")
    if (opts.financeLegacyFrozen && (normalized === "erp_geral/financeiro" || normalized.startsWith("erp_geral/financeiro/"))) {
      throw new ApiError(426, "O ramo financeiro legado está congelado em modo somente leitura. Recarregue o sistema para gravar na estrutura normalizada.")
    }
    if (role !== "admin" && protectedWrite(normalized)) {
      throw new ForbiddenError("Seu perfil não pode alterar estes dados.")
    }
    if (role !== "admin" && !viewerWritablePath(normalized)) {
      throw new ForbiddenError("Seu perfil não pode alterar estes dados.")
    }
  }
  if (roots.some((path) => !Object.hasOwn(expected, path))) {
    throw new BadRequestError("A versão dos dados não foi informada.")
  }
  return roots
}

const applyHotelStateUpdatesInTx = (txApp, role, updates, expected, sourceHash, roots) => {
  let changed = 0
  const savedSizes = []
  const entries = new Map()
  for (const root of roots) {
    const current = txApp.findRecordsByFilter("hotel_state", "path = {:path}", "", 1, 0, { path: root })[0]
    const version = current?.getInt("revision") ?? null
    if (version !== (expected[root] ?? null)) {
      throw new ApiError(409, "Os dados mudaram. Atualize e tente novamente.")
    }
    if (sourceHash && current?.getString("source_hash") && current.getString("source_hash") !== sourceHash) {
      throw new ApiError(409, "O ramo contém dados de outra origem.")
    }
    const value = storedValue(current)
    entries.set(root, { record: current, value, before: JSON.parse(JSON.stringify(value ?? {})) })
  }
  if (role !== "admin") {
    for (const root of ["erp_geral/quartos", "erp_geral/limpeza"]) {
      if (entries.has(root)) continue
      const current = txApp.findRecordsByFilter("hotel_state", "path = {:path}", "", 1, 0, { path: root })[0]
      const value = storedValue(current)
      entries.set(root, { record: current, value, before: JSON.parse(JSON.stringify(value ?? {})) })
    }
  }

  for (const [path, value] of Object.entries(updates)) {
    const normalized = String(path).replace(/^\/+|\/+$/g, "")
    const root = normalized.split("/").slice(0, 2).join("/")
    const entry = entries.get(root)
    const parts = normalized === root ? [] : normalized.slice(root.length + 1).split("/")
    if (parts.length === 0) {
      entry.value = value === null ? {} : value
      changed++
      continue
    }
    let target = entry.value
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {}
      target = target[part]
    }
    const last = parts[parts.length - 1]
    let next = value
    if (value && typeof value === "object" && Object.keys(value).length === 1 && Number.isFinite(value.__pocketbaseIncrement)) {
      next = (Number(target[last]) || 0) + value.__pocketbaseIncrement
    }
    if (value === null) delete target[last]
    else target[last] = next
    changed++
  }

  if (role !== "admin") {
    for (const path of Object.keys(updates)) {
      const normalized = String(path).replace(/^\/+|\/+$/g, "")
      if (viewerCleaningPath(normalized) && !validViewerCleaningWrite(normalized, entries)) {
        throw new ForbiddenError("A transição de limpeza não é válida para este perfil.")
      }
      if (normalized.startsWith("erp_geral/recepcao/stays/")) {
        const stayPath = normalized.split("/").slice(0, 4).join("/")
        if (courtesyFields(stateValue(entries, stayPath, true)) !== courtesyFields(stateValue(entries, stayPath, false))) {
          throw new ForbiddenError("Somente a gerência pode alterar cortesias na hospedagem.")
        }
      }
    }
  }

  for (const root of roots) {
    const entry = entries.get(root)
    const record = entry.record || new Record(txApp.findCollectionByNameOrId("hotel_state"))
    const serialized = JSON.stringify(entry.value ?? {})
    const nextRevision = (entry.record?.getInt("revision") ?? 0) + 1
    record.set("path", root)
    record.set("value", serialized)
    record.set("revision", nextRevision)
    if (sourceHash) record.set("source_hash", sourceHash)
    txApp.save(record)
    savedSizes.push({ path: root, bytes: utf8ByteLength(serialized), revision: nextRevision })
  }
  return { changed, savedSizes }
}

const logSavedSizes = (app, savedSizes) => {
  for (const item of savedSizes) {
    if (item.bytes >= HOTEL_STATE_CRITICAL_BYTES) {
      const mb = (item.bytes / 1048576).toFixed(2)
      console.error(`[hotel_state][SIZE_CRITICAL] path=${item.path} bytes=${item.bytes} (${mb} MiB) limit=${HOTEL_STATE_MAX_BYTES} revision=${item.revision}`)
      app.logger().error("hotel_state branch size critical", "path", item.path, "bytes", item.bytes, "limitBytes", HOTEL_STATE_MAX_BYTES, "revision", item.revision)
    } else if (item.bytes >= HOTEL_STATE_WARN_BYTES) {
      const mb = (item.bytes / 1048576).toFixed(2)
      console.warn(`[hotel_state][SIZE_WARN] path=${item.path} bytes=${item.bytes} (${mb} MiB) limit=${HOTEL_STATE_MAX_BYTES} revision=${item.revision}`)
      app.logger().warn("hotel_state branch size warning", "path", item.path, "bytes", item.bytes, "limitBytes", HOTEL_STATE_MAX_BYTES, "revision", item.revision)
    }
  }
}

module.exports = {
  HOTEL_STATE_WARN_BYTES,
  HOTEL_STATE_CRITICAL_BYTES,
  HOTEL_STATE_MAX_BYTES,
  utf8ByteLength,
  validateStateUpdatesAccess,
  applyHotelStateUpdatesInTx,
  logSavedSizes,
}
