import type { Ref } from 'vue';
import type { Task, TaskStatus } from '@shared/types';

/**
 * Upsert a task into the array if its status is valid, or remove it otherwise.
 */
export function upsertOrRemove(
  array: Ref<Task[]>,
  task: Task,
  validStatuses: readonly TaskStatus[],
): void {
  if (validStatuses.includes(task.status as TaskStatus)) {
    const idx = array.value.findIndex((t) => t.id === task.id);
    if (idx === -1) array.value.push(task);
    else array.value[idx] = task;
  } else {
    array.value = array.value.filter((t) => t.id !== task.id);
  }
}
