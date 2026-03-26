import { describe, expect, it } from 'vitest'
import { useTaskSelection } from '../src/composables/useTaskSelection'

describe('useTaskSelection', () => {
  it('starts with empty selection', () => {
    const { selectedCount, hasSelection } = useTaskSelection()
    expect(selectedCount.value).toBe(0)
    expect(hasSelection.value).toBe(false)
  })

  it('toggle adds and removes an id', () => {
    const { toggle, isSelected, selectedCount } = useTaskSelection()
    toggle('a')
    expect(isSelected('a')).toBe(true)
    expect(selectedCount.value).toBe(1)

    toggle('a')
    expect(isSelected('a')).toBe(false)
    expect(selectedCount.value).toBe(0)
  })

  it('selectAll replaces the entire set', () => {
    const { toggle, selectAll, isSelected, selectedCount } = useTaskSelection()
    toggle('a')
    selectAll(['b', 'c'])
    expect(isSelected('a')).toBe(false)
    expect(isSelected('b')).toBe(true)
    expect(isSelected('c')).toBe(true)
    expect(selectedCount.value).toBe(2)
  })

  it('clearSelection empties the set', () => {
    const { toggle, clearSelection, hasSelection } = useTaskSelection()
    toggle('a')
    toggle('b')
    expect(hasSelection.value).toBe(true)

    clearSelection()
    expect(hasSelection.value).toBe(false)
  })
})
