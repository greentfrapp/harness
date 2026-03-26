<script setup lang="ts">
import { ref, onBeforeUnmount, computed } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    position?: 'top' | 'bottom' | 'left' | 'right'
    delay?: number
  }>(),
  {
    position: 'top',
    delay: 400,
  },
)

const visible = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)
let showTimeout: ReturnType<typeof setTimeout> | null = null
let tooltipStyle = ref<Record<string, string>>({})

function show() {
  showTimeout = setTimeout(() => {
    if (!triggerRef.value || !props.text) return
    updatePosition()
    visible.value = true
  }, props.delay)
}

function hide() {
  if (showTimeout) {
    clearTimeout(showTimeout)
    showTimeout = null
  }
  visible.value = false
}

function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const gap = 6

  const style: Record<string, string> = { position: 'fixed' }

  switch (props.position) {
    case 'top':
      style.left = `${rect.left + rect.width / 2}px`
      style.top = `${rect.top - gap}px`
      style.transform = 'translate(-50%, -100%)'
      break
    case 'bottom':
      style.left = `${rect.left + rect.width / 2}px`
      style.top = `${rect.bottom + gap}px`
      style.transform = 'translate(-50%, 0)'
      break
    case 'left':
      style.left = `${rect.left - gap}px`
      style.top = `${rect.top + rect.height / 2}px`
      style.transform = 'translate(-100%, -50%)'
      break
    case 'right':
      style.left = `${rect.right + gap}px`
      style.top = `${rect.top + rect.height / 2}px`
      style.transform = 'translate(0, -50%)'
      break
  }

  tooltipStyle.value = style
}

const arrowPosition = computed(() => {
  switch (props.position) {
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    default:
      return 'bottom'
  }
})

onBeforeUnmount(() => {
  if (showTimeout) clearTimeout(showTimeout)
})
</script>

<template>
  <span
    ref="triggerRef"
    class="inline-flex"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="show"
    @blur="hide">
    <slot />
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-150"
        leave-active-class="transition-opacity duration-100"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0">
        <div
          v-if="visible && text"
          ref="tooltipRef"
          :style="tooltipStyle"
          class="z-[9999] pointer-events-none max-w-xs px-2.5 py-1.5 text-xs font-medium text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg whitespace-pre-line break-words">
          {{ text }}
          <span
            class="tooltip-arrow"
            :class="`arrow-${arrowPosition}`" />
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped>
.tooltip-arrow {
  position: absolute;
  width: 6px;
  height: 6px;
  background: var(--color-zinc-800);
  border: 1px solid var(--color-zinc-700);
  transform: rotate(45deg);
}

.arrow-bottom {
  bottom: -4px;
  left: 50%;
  margin-left: -3px;
  border-top: none;
  border-left: none;
}

.arrow-top {
  top: -4px;
  left: 50%;
  margin-left: -3px;
  border-bottom: none;
  border-right: none;
}

.arrow-left {
  left: -4px;
  top: 50%;
  margin-top: -3px;
  border-bottom: none;
  border-right: none;
}

.arrow-right {
  right: -4px;
  top: 50%;
  margin-top: -3px;
  border-top: none;
  border-left: none;
}
</style>
