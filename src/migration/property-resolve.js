/**
 * Resolve Notion database property schema IDs by human-readable name.
 */
export function propertySchemaId(database, propName) {
  return database?.properties?.[propName]?.id ?? null;
}

/** First matching property id among candidates (for renamed Notion columns). */
export function propertySchemaIdFirst(database, propNames) {
  for (const propName of propNames) {
    const id = propertySchemaId(database, propName);
    if (id) return id;
  }
  return null;
}
