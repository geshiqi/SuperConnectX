import { describe, it, expect, beforeEach } from 'vitest'
import UserTaskStorage from '@/main/storage/UserTaskStorage'
import type { UserTask } from '@/shared/tasks/UserTask'

const makeTask = (overrides: Partial<UserTask> = {}): UserTask => ({
  id: '',
  name: '编译',
  steps: [
    { type: 'shell', command: 'make -j8', stopOnFail: true },
    { type: 'delay', ms: 100 },
    { type: 'builtin', action: 'sendData', target: 'active', data: 'reset', appendCrlf: true }
  ],
  ...overrides
})

describe('UserTaskStorage', () => {
  let storage: UserTaskStorage

  beforeEach(() => {
    storage = new UserTaskStorage()
  })

  it('新建任务自动生成 id 与时间戳', () => {
    const tasks = storage.saveTask(makeTask())
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).not.toBe('')
    expect(tasks[0].createdAt).toBeTruthy()
    expect(tasks[0].updatedAt).toBeTruthy()
    expect(tasks[0].repeat).toBe(1)
  })

  it('按 id upsert 更新而非新增', () => {
    let tasks = storage.saveTask(makeTask())
    const id = tasks[0].id
    tasks = storage.saveTask({ ...tasks[0], name: '编译并烧录' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].name).toBe('编译并烧录')
    expect(tasks[0].id).toBe(id)
    expect(storage.getTask(id)?.name).toBe('编译并烧录')
  })

  it('空名称被规范化为 Untitled', () => {
    const tasks = storage.saveTask(makeTask({ name: '  ' }))
    expect(tasks[0].name).toBe('Untitled')
  })

  it('删除任务', () => {
    let tasks = storage.saveTask(makeTask())
    const id = tasks[0].id
    tasks = storage.deleteTask(id)
    expect(tasks).toHaveLength(0)
    expect(storage.getTask(id)).toBeNull()
  })

  it('导入按 id 去重', () => {
    const created = storage.saveTask(makeTask({ name: 'A' }))
    const existing = created[0]
    // 同 id 跳过
    let result = storage.importTasks([{ ...existing, name: 'A-dup' }])
    expect(result).toEqual({ added: 0, skipped: 1 })
    // 新 id 添加
    result = storage.importTasks([makeTask({ id: 'new-1', name: 'B' })])
    expect(result).toEqual({ added: 1, skipped: 0 })
    expect(storage.getTasks()).toHaveLength(2)
    // 非法条目跳过
    result = storage.importTasks([{ name: 'no-id' } as unknown as UserTask])
    expect(result).toEqual({ added: 0, skipped: 1 })
  })
})
