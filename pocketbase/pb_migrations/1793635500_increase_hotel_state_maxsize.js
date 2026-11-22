/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("hotel_state")
  const field = collection.fields.getByName("value")
  if (!field) {
    throw new Error("Campo 'value' não encontrado na coleção hotel_state.")
  }
  field.maxSize = 4194304
  app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("hotel_state")
  const field = collection.fields.getByName("value")
  if (!field) return
  field.maxSize = 0
  app.save(collection)
})
