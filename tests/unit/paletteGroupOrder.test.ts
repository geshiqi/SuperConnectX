/**
 * 命令面板组标签拖拽排序的重排纯函数单测
 */
import { describe, it, expect } from 'vitest'
import { reorderTasksByGroup } from '@/renderer/src/palette/groupOrder'
import type { UserTask } from '../../apps/superconnectx/src/shared/tasks/UserTask'

const task = (id: string, group: string): UserTask =>
  ({ id, name: id, group, steps: [] }) as UserTask

describe('reorderTasksByGroup', () => {
  // 存储顺序:A1 A2 B1 B2 C1 -> 组顺序 A B C
  const tasks = [task('a1', 'A'), task('a2', 'A'), task('b1', 'B'), task('b2', 'B'), task('c1', 'C')]

  it('把后面的组拖到前面组之前(前移)', () => {
    const next = reorderTasksByGroup(tasks, 'B', 'A', true)
    expect(next!.map((t) => t.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'c1'])
  })

  it('把前面的组拖到后面组之后(后移)', () => {
    const next = reorderTasksByGroup(tasks, 'A', 'B', false)
    expect(next!.map((t) => t.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'c1'])
  })

  it('拖到目标之后(insertBefore=false 且目标在前)', () => {
    const next = reorderTasksByGroup(tasks, 'C', 'A', false)
    expect(next!.map((t) => t.id)).toEqual(['a1', 'a2', 'c1', 'b1', 'b2'])
  })

  it('组内顺序保持不变', () => {
    const next = reorderTasksByGroup(tasks, 'C', 'A', true)
    expect(next!.slice(0, 2).map((t) => t.id)).toEqual(['c1', 'a1'])
  })

  it('同组/未知组返回 null(无操作)', () => {
    expect(reorderTasksByGroup(tasks, 'A', 'A', true)).toBeNull()
    expect(reorderTasksByGroup(tasks, 'X', 'A', true)).toBeNull()
    expect(reorderTasksByGroup(tasks, 'A', 'X', true)).toBeNull()
  })

  it('未分组任务(空组名)参与排序', () => {
    const mixed = [task('a1', 'A'), task('u1', ''), task('b1', 'B')]
    const next = reorderTasksByGroup(mixed, '', 'A', true)
    expect(next!.map((t) => t.id)).toEqual(['u1', 'a1', 'b1'])
  })

  it('组间交错的存储重排为连续块且各组成员完整', () => {
    const interleaved = [task('a1', 'A'), task('b1', 'B'), task('a2', 'A'), task('b2', 'B')]
    const next = reorderTasksByGroup(interleaved, 'B', 'A', true)
    expect(next!.map((t) => t.id)).toEqual(['b1', 'b2', 'a1', 'a2'])
    expect(next!.map((t) => t.group)).toEqual(['B', 'B', 'A', 'A'])
  })

  it('不修改原数组', () => {
    const copy = [...tasks]
    reorderTasksByGroup(tasks, 'B', 'A', true)
    expect(tasks).toEqual(copy)
  })
})
