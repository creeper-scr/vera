import { WOOD_TYPES } from '../../utils/mcdata'

const BLOCK_ALIAS_GROUPS: string[][] = [
  ['torch', 'wall_torch'],
]

const aliasLookup = new Map<string, Set<string>>()

for (const group of BLOCK_ALIAS_GROUPS) {
  const normalizedGroup = [...new Set(group.map(item => item.toLowerCase()))]
  const groupSet = new Set(normalizedGroup)
  for (const name of normalizedGroup)
    aliasLookup.set(name, groupSet)
}

const ORE_BASE_TYPES = new Set([
  'coal',
  'diamond',
  'emerald',
  'iron',
  'gold',
  'lapis_lazuli',
  'redstone',
  'copper',
])

/** Spoken / LLM collect targets that mean "any nearby tree log". */
const WOOD_COLLECT_ALIASES = new Set([
  'wood',
  'tree',
  'log',
  'logs',
  '木头',
  '木材',
  '原木',
  '树',
])

/**
 * Concrete log / stem ids expanded from wood aliases.
 * Unknown names for the connected version are skipped by {@link getNearestBlocks}.
 */
const WOOD_LOG_BLOCK_NAMES = [
  ...WOOD_TYPES.map(type => `${type}_log`),
  'mangrove_log',
  'cherry_log',
  'pale_oak_log',
  'crimson_stem',
  'warped_stem',
]

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

function expandStrictBlockAliases(name: string): string[] {
  if (typeof name !== 'string')
    return []

  const normalized = normalize(name)
  if (!normalized)
    return []

  const result = new Set<string>()

  const aliases = aliasLookup.get(normalized)
  if (aliases) {
    for (const a of aliases)
      result.add(a)
  }
  else {
    result.add(normalized)
  }

  return [...result]
}

/**
 * Expands a collect target into concrete Minecraft block ids.
 *
 * Wood/tree/log aliases become every common log/stem so chop-tree requests do
 * not require guessing `oak_log` when spruce is nearby.
 */
export function expandCollectibleBlockAliases(name: string): string[] {
  const normalized = normalize(name)
  if (!normalized)
    return []

  if (WOOD_COLLECT_ALIASES.has(normalized))
    return [...WOOD_LOG_BLOCK_NAMES]

  const strictAliases = expandStrictBlockAliases(name)
  if (strictAliases.length === 0)
    return []

  const result = new Set(strictAliases)

  if (ORE_BASE_TYPES.has(normalized)) {
    result.add(`${normalized}_ore`)
    result.add(`deepslate_${normalized}_ore`)
  }

  if (normalized.endsWith('_ore') && !normalized.startsWith('deepslate_')) {
    result.add(`deepslate_${normalized}`)
  }

  if (normalized === 'dirt') {
    result.add('grass_block')
  }

  return [...result]
}

export function matchesBlockAlias(expected: string, actual: string): boolean {
  const expectedAliases = expandStrictBlockAliases(expected)
  if (expectedAliases.length === 0)
    return false

  const actualNormalized = normalize(actual)
  return expectedAliases.includes(actualNormalized)
}
