/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const staging = app.findCollectionByNameOrId("firebase_backup_nodes")
  staging.name = "migration_staging"
  app.save(staging)

  const collection = new Collection({
    type: "base",
    name: "hotel_state",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "path", required: true, max: 255 },
      { type: "json", name: "value", required: true },
      { type: "text", name: "source_hash", required: false, max: 64 },
      { type: "number", name: "revision", required: false, min: 0 },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_hotel_state_path ON hotel_state (path)",
    ],
  })
  app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("hotel_state")
  app.delete(collection)

  const staging = app.findCollectionByNameOrId("migration_staging")
  staging.name = "firebase_backup_nodes"
  app.save(staging)
})
