<script setup lang="ts">
import type { HostSlot } from './split-tab'
import { providePanelDocument } from '../composables/usePanelWindow'

const props = defineProps<{ target: HTMLElement; slotName: HostSlot; termTarget: boolean }>()
providePanelDocument(() => props.target.ownerDocument)
</script>

<template>
  <Teleport :to="target">
    <section class="tab-page" :class="{ 'is-term-target': termTarget }" :data-slot="slotName">
      <slot />
    </section>
  </Teleport>
</template>
