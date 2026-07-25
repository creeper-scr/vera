import type { JsonValue } from '@proj-vera/game-coop-core'

export type JsonObject = Record<string, JsonValue>

export function parseJsonObject(raw: string): JsonObject {
  const value: unknown = JSON.parse(raw)
  if (!isJsonObject(value))
    throw new Error('Game bridge snapshot must be a JSON object')
  return value
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object'
    && value != null
    && !Array.isArray(value)
    && Object.values(value).every(isJsonValue)
}

export function objectValue(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null
}

export function arrayValue(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

export function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value == null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (Array.isArray(value))
    return value.every(isJsonValue)
  return isJsonObject(value)
}
