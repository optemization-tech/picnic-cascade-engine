/**
 * Resolve Notion database property schema IDs by human-readable name.
 */
export function propertySchemaId(database, propName) {
  return database?.properties?.[propName]?.id ?? null;
}
