routerAdd("GET", "/api/hotel/me", (event) => {
  const auth = event.requestInfo().auth
  if (!auth) throw new UnauthorizedError("Faça login para acessar os dados.")
  if (auth.isSuperuser()) return event.json(200, { id: auth.get("id"), role: "admin" })

  const matches = $app.findRecordsByFilter("user_roles", "user = {:userId}", "", 1, 0, {
    userId: auth.get("id"),
  })
  const role = matches[0]?.getString("role")
  if (role !== "admin" && role !== "viewer") {
    throw new ForbiddenError("Usuário sem perfil autorizado.")
  }
  return event.json(200, { id: auth.get("id"), role })
}, $apis.requireAuth())

routerAdd("GET", "/api/hotel/state", (event) => {
  const auth = event.requestInfo().auth
  if (!auth) throw new UnauthorizedError("Faça login para acessar os dados.")
  let role = "admin"
  if (!auth.isSuperuser()) {
    const matches = $app.findRecordsByFilter("user_roles", "user = {:userId}", "", 1, 0, {
      userId: auth.get("id"),
    })
    role = matches[0]?.getString("role")
    if (role !== "admin" && role !== "viewer") throw new ForbiddenError("Usuário sem perfil autorizado.")
  }

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
  const denied = adminOnlyRead.some((prefix) => path === prefix || path.startsWith(prefix + "/") || prefix.startsWith(path + "/"))
  if (role !== "admin" && denied) throw new ForbiddenError("Seu perfil não pode acessar estes dados.")

  const records = $app.findRecordsByFilter("hotel_state", "", "path", 10000, 0)
  const decodeValue = (record) => {
    const raw = record.get("value")
    if (!raw || typeof raw === "string") return raw ? JSON.parse(raw) : {}
    if (typeof raw !== "object" || typeof raw.length !== "number") return raw
    return JSON.parse(toString(raw))
  }
  const selected = path === "erp_geral"
    ? records.filter((record) => record.getString("path").startsWith("erp_geral/"))
    : records.filter((record) => {
      const root = path.split("/").slice(0, 2).join("/")
      return record.getString("path") === root && path !== ""
    })
  const versions = Object.fromEntries(selected.map((record) => [record.getString("path"), record.getInt("revision")]))
  if (path === "erp_geral") {
    const value = {}
    for (const record of selected) {
      const relative = record.getString("path").slice("erp_geral/".length).split("/")
      let target = value
      for (const part of relative.slice(0, -1)) {
        target[part] ??= {}
        target = target[part]
      }
      target[relative[relative.length - 1]] = decodeValue(record)
    }
    return event.json(200, { value, versions })
  }

  if (!path) {
    if (role !== "admin") throw new ForbiddenError("Seu perfil não pode acessar estes dados.")
    const value = Object.fromEntries(selected.map((record) => [record.getString("path"), decodeValue(record)]))
    return event.json(200, { value, versions })
  }
  if (path.split("/").length < 2) throw new BadRequestError("Caminho de dados inválido.")

  const root = path.split("/").slice(0, 2).join("/")
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
  const auth = event.requestInfo().auth
  if (!auth) throw new UnauthorizedError("Faça login para alterar os dados.")
  let role = "admin"
  if (!auth.isSuperuser()) {
    const matches = $app.findRecordsByFilter("user_roles", "user = {:userId}", "", 1, 0, {
      userId: auth.get("id"),
    })
    role = matches[0]?.getString("role")
    if (role !== "admin" && role !== "viewer") throw new ForbiddenError("Usuário sem perfil autorizado.")
  }

  const body = event.requestInfo().body
  const updates = body.updates
  const expected = body.expected
  if (!updates || typeof updates !== "object" || Array.isArray(updates) || !expected || typeof expected !== "object") {
    throw new BadRequestError("Atualização inválida.")
  }
  const adminOnlyWrite = [
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
  const protectedWrite = (path) => adminOnlyWrite.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
  const viewerCleaningPath = (path) => path.startsWith("erp_geral/quartos/rooms/")
    || path.startsWith("erp_geral/quartos/cleaningLogs/")
    || path.startsWith("erp_geral/limpeza/activeRooms/")
    || path.startsWith("erp_geral/limpeza/tasks/")
  const viewerWritablePrefixes = [
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
  const viewerWritablePath = (path) => viewerCleaningPath(path)
    || viewerWritablePrefixes.some((prefix) => path.startsWith(prefix + "/"))
  const stateValue = (entries, path, before) => {
    const parts = path.split("/")
    const root = parts.slice(0, 2).join("/")
    const entry = entries.get(root)
    let value = before ? entry?.before : entry?.value
    for (const part of parts.slice(2)) value = value && typeof value === "object" ? value[part] : undefined
    return value
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
  const roots = [...new Set(Object.keys(updates).map((path) => {
    const parts = String(path).replace(/^\/+|\/+$/g, "").split("/")
    if (parts.length < 2) throw new BadRequestError("Caminho de dados inválido.")
    return parts.slice(0, 2).join("/")
  }))]
  for (const path of Object.keys(updates)) {
    const normalized = String(path).replace(/^\/+|\/+$/g, "")
    if (!normalized.startsWith("erp_geral/")) throw new ForbiddenError("Seu perfil não pode alterar estes dados.")
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

  let changed = 0
  try {
  $app.runInTransaction((txApp) => {
    const entries = new Map()
    const storedValue = (record) => {
      if (!record) return {}
      const raw = record.get("value")
      if (typeof raw === "string") return JSON.parse(raw)
      if (raw && typeof raw === "object" && typeof raw.length === "number") {
        return JSON.parse(toString(raw))
      }
      return raw ?? {}
    }
    for (const root of roots) {
        const current = txApp.findRecordsByFilter("hotel_state", "path = {:path}", "", 1, 0, { path: root })[0]
        const version = current?.getInt("revision") ?? null
      if (version !== (expected[root] ?? null)) throw new ApiError(409, "Os dados mudaram. Atualize e tente novamente.")
      if (body.sourceHash && current?.getString("source_hash") && current.getString("source_hash") !== body.sourceHash) {
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
      }
    }

    for (const root of roots) {
      const entry = entries.get(root)
      const record = entry.record || new Record(txApp.findCollectionByNameOrId("hotel_state"))
      record.set("path", root)
      record.set("value", JSON.stringify(entry.value ?? {}))
      record.set("revision", (entry.record?.getInt("revision") ?? 0) + 1)
      if (body.sourceHash) record.set("source_hash", body.sourceHash)
      txApp.save(record)
    }
  })
  } catch (error) {
    console.error("PocketBase state commit failed", error)
    throw error
  }
  return event.json(200, { committed: true, changed })
}, $apis.requireAuth())
