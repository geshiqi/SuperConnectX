/**
 * 命令面板组标签拖拽排序的任务数组重排。
 *
 * 组的显示顺序由"每组首个任务在数组中的出现位置"派生(无独立组序存储),
 * 故按新组顺序把各组重排为连续块(组内顺序保持)整体写回即可持久化。
 */
import type { UserTask } from '../../../shared/tasks/UserTask'

/**
 * 把 fromGroup 移动到 targetGroup 之前/之后,按新组顺序返回重排后的任务数组。
 * 无实际变化(组不存在或 from 与 target 相同)返回 null。
 */
export function reorderTasksByGroup(
  tasks: UserTask[],
  fromGroup: string,
  targetGroup: string,
  insertBefore: boolean
): UserTask[] | null {
  const names: string[] = []
  for (const task of tasks) {
    const name = task.group || ''
    if (!names.includes(name)) names.push(name)
  }
  const fromIdx = names.indexOf(fromGroup)
  const targetIdx = names.indexOf(targetGroup)
  if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return null
  names.splice(fromIdx, 1)
  const insertAt = insertBefore ? names.indexOf(targetGroup) : names.indexOf(targetGroup) + 1
  names.splice(insertAt, 0, fromGroup)
  return names.flatMap((name) => tasks.filter((task) => (task.group || '') === name))
}
