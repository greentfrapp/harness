import type { ViewConfig } from '@shared/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useViews = defineStore('views', () => {
  const views = ref<ViewConfig[]>([])
  const loading = ref(false)

  async function fetchViews() {
    loading.value = true
    try {
      views.value = await api.views.list()
    } finally {
      loading.value = false
    }
  }

  async function saveViews(updated: ViewConfig[]) {
    views.value = await api.views.save(updated)
  }

  async function resetToDefaults() {
    views.value = await api.views.reset()
  }

  async function addView(view: ViewConfig) {
    const updated = [...views.value, view]
    await saveViews(updated)
  }

  async function updateView(id: string, updates: Partial<ViewConfig>) {
    const updated = views.value.map((v) =>
      v.id === id ? { ...v, ...updates } : v,
    )
    await saveViews(updated)
  }

  async function removeView(id: string) {
    const updated = views.value.filter((v) => v.id !== id)
    await saveViews(updated)
  }

  return {
    views,
    loading,
    fetchViews,
    saveViews,
    resetToDefaults,
    addView,
    updateView,
    removeView,
  }
})
