<script setup lang="ts">
import { useResizeObserver, useScreenSafeArea } from '@vueuse/core'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger, VisuallyHidden } from 'reka-ui'
import { DrawerContent, DrawerDescription, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger } from 'vaul-vue'
import { onMounted } from 'vue'

import HearingConfig from './hearing-config.vue'

import { useBreakpoints } from '../../../../composables/use-breakpoints'

const props = defineProps<{
  overlayDim?: boolean
  overlayBlur?: boolean
  granted?: boolean
  transcriptionReady?: boolean
  speechReady?: boolean
}>()

const emit = defineEmits<{
  configureTranscription: []
  configureSpeech: []
}>()

const showDialog = defineModel('show', { type: Boolean, default: false, required: false })
const autoSend = defineModel<boolean | undefined>('autoSend')

const { isDesktop } = useBreakpoints()
const screenSafeArea = useScreenSafeArea()

useResizeObserver(document.documentElement, () => screenSafeArea.update())
onMounted(() => screenSafeArea.update())
</script>

<template>
  <DialogRoot v-if="isDesktop" :open="showDialog" @update:open="value => showDialog = value">
    <DialogTrigger as-child>
      <slot />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay
        :class="[
          props.overlayDim ? 'bg-black/50' : '',
          props.overlayBlur ? 'backdrop-blur-sm' : '',
        ]"
        class="fixed inset-0 z-[9999] data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn"
      />
      <DialogContent class="fixed left-1/2 top-1/2 z-[9999] max-h-full max-w-5xl w-[92dvw] transform overflow-y-scroll rounded-2xl bg-white p-6 shadow-xl outline-none backdrop-blur-md scrollbar-none -translate-x-1/2 -translate-y-1/2 data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow dark:bg-neutral-900">
        <VisuallyHidden>
          <DialogTitle>Hearing Input</DialogTitle>
          <DialogDescription>
            Microphone input stays off until you explicitly enable it.
          </DialogDescription>
        </VisuallyHidden>
        <HearingConfig
          v-model:auto-send="autoSend"
          :granted="props.granted"
          :speech-ready="props.speechReady"
          :transcription-ready="props.transcriptionReady"
          @configure-speech="emit('configureSpeech')"
          @configure-transcription="emit('configureTranscription')"
        />
        <slot name="extra" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <DrawerRoot v-else :open="showDialog" should-scale-background @update:open="value => showDialog = value">
    <DrawerTrigger as-child>
      <slot />
    </DrawerTrigger>
    <DrawerPortal>
      <DrawerOverlay class="fixed inset-0 z-[9998] bg-black/20" />
      <DrawerContent
        :class="[
          'fixed bottom-0 left-0 right-0 z-[9999]',
          'mt-20 px-4 pt-4',
          'flex flex-col',
          'max-h-[calc(100dvh-1rem)] overflow-y-auto scrollbar-none',
          'rounded-t-[32px] outline-none backdrop-blur-md',
          'bg-neutral-50/85 dark:bg-neutral-900/90',
        ]"
        :style="{ paddingBottom: `${Math.max(Number.parseFloat(screenSafeArea.bottom.value.replace('px', '')), 24)}px` }"
      >
        <VisuallyHidden>
          <DrawerTitle>Hearing Input</DrawerTitle>
          <DrawerDescription>
            Microphone input stays off until you explicitly enable it.
          </DrawerDescription>
        </VisuallyHidden>
        <DrawerHandle
          :class="[
            '[div&]:bg-neutral-400 [div&]:dark:bg-neutral-600',
          ]"
        />
        <HearingConfig
          v-model:auto-send="autoSend"
          :granted="props.granted"
          :speech-ready="props.speechReady"
          :transcription-ready="props.transcriptionReady"
          @configure-speech="emit('configureSpeech')"
          @configure-transcription="emit('configureTranscription')"
        />
        <slot name="extra" />
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
</template>
