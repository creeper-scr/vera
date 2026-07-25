import type { ccv3 } from '@proj-vera/ccc'

import type { VeraCard, VeraExtension } from '../stores/modules/vera-card'

import JSZip from 'jszip'

import { exportToJSON } from '@proj-vera/ccc'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DisplayModelFormat, useDisplayModelsStore } from '../stores/display-models'
import { exportVeraCardPackage, importVeraCardPackage } from './vera-card-import-export'

describe('vera card package import/export', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
  })

  it('exports sanitized packages and restores display models', async () => {
    const displayModelsStore = useDisplayModelsStore()
    const fetch = vi.fn(async () => new Response('preset-vrm-model'))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(displayModelsStore, 'getDisplayModel').mockResolvedValue({
      id: 'preset-vrm-1',
      format: DisplayModelFormat.VRM,
      type: 'url' as const,
      url: '/assets/avatar.vrm',
      name: 'AvatarSample_A',
      importedAt: 1,
    })
    mockAddDisplayModel(displayModelsStore, 'display-model-imported')

    const exported = await exportVeraCardPackage({ card: createCard(), displayModelsStore })
    const zip = await JSZip.loadAsync(await exported.arrayBuffer())
    const cardJson = await readJson<ccv3.CharacterCardV3>(zip, 'card.json')
    const imported = await importVeraCardPackage({ file: new File([exported], 'card.zip'), displayModelsStore })
    const vera = veraFrom(cardJson)

    expect(fetch).toHaveBeenCalledWith('/assets/avatar.vrm')
    expect(await readJson(zip, 'manifest.json')).toMatchObject({ format: 'vera-character-card', version: 1, resources: { displayModel: { path: 'models/body-model.vrm', format: DisplayModelFormat.VRM, name: 'AvatarSample_A.vrm' } } })
    expect(await zip.file('models/body-model.vrm')?.async('string')).toBe('preset-vrm-model')
    expect(cardJson.data).toMatchObject({ name: 'Vera / Test Card', creator: '', tags: [], mes_example: '' })
    expect(vera.modules).toMatchObject({ consciousness: { provider: 'openai', model: 'gpt-4o' }, speech: { provider: 'elevenlabs', model: 'eleven', voice_id: 'alloy' } })
    expect(vera.modules).not.toHaveProperty('activeBackgroundId')
    expect(vera.modules.artistry).not.toHaveProperty('workflowId')
    expect(vera.agents).toEqual({})
    expect(displayModelsStore.addDisplayModel).toHaveBeenCalledWith(DisplayModelFormat.VRM, expect.objectContaining({ name: 'AvatarSample_A.vrm' }))
    expect(veraFrom(imported).modules.displayModelId).toBe('display-model-imported')
  })

  it('classifies invalid packages', async () => {
    const emptyZip = new JSZip()
    const invalidJsonZip = new JSZip()
    const displayModelsStore = useDisplayModelsStore()
    invalidJsonZip.file('manifest.json', '{')
    const cases = [
      [new File(['not zip'], 'card.zip'), { code: 'invalid-file', message: 'Invalid zip file' }],
      [new File([await emptyZip.generateAsync({ type: 'arraybuffer' })], 'empty.zip'), { code: 'missing-file' }],
      [new File([await invalidJsonZip.generateAsync({ type: 'arraybuffer' })], 'invalid-json.zip'), { cause: expect.any(SyntaxError), code: 'invalid-file' }],
      [await packageFile(exportToJSON(createCard()), { version: 2 }), { code: 'invalid-file' }],
    ] as const

    for (const [file, expected] of cases)
      await expect(importVeraCardPackage({ file, displayModelsStore })).rejects.toMatchObject(expected)
  })
})

function mockAddDisplayModel(store: ReturnType<typeof useDisplayModelsStore>, id = 'unused') {
  return vi.spyOn(store, 'addDisplayModel').mockImplementation(async (format, file) => ({
    id,
    format,
    type: 'file' as const,
    file,
    name: file.name,
    importedAt: 1,
  }))
}

function createCard(displayModelId = 'preset-vrm-1'): VeraCard {
  return {
    name: 'Vera / Test Card',
    nickname: 'Tester',
    version: '1.2.3',
    description: 'Description',
    creator: 'Hidden creator',
    messageExample: [['{{user}}: hidden']],
    tags: ['hidden'],
    extensions: {
      vera: {
        modules: {
          consciousness: { provider: 'openai', model: 'gpt-4o' },
          vision: { provider: 'ollama', model: 'llava' },
          speech: { provider: 'elevenlabs', model: 'eleven', voice_id: 'alloy', pitch: 1 },
          displayModelId,
          activeBackgroundId: 'background-secret',
          artistry: { provider: 'replicate', model: 'flux', workflowId: 'workflow-secret' },
        },
        agents: { minecraft: { prompt: 'secret', enabled: true } },
      },
    },
  }
}

async function packageFile(cardJson: ccv3.CharacterCardV3, manifestOverrides: Record<string, unknown> = {}) {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({
    format: 'vera-character-card',
    version: 1,
    card: { path: 'card.json', spec: 'chara_card_v3' },
    ...manifestOverrides,
  }))
  zip.file('card.json', JSON.stringify(cardJson))
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'card.zip')
}

async function readJson<T = Record<string, unknown>>(zip: JSZip, path: string): Promise<T> {
  return JSON.parse(await zip.file(path)!.async('string')) as T
}

function veraFrom(card: ccv3.CharacterCardV3): VeraExtension {
  return card.data.extensions.vera as VeraExtension
}
