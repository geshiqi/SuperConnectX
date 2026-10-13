/**
 * 命令面板:用户自定义任务存储(electron-store)。
 * 文件落在 appDataDir/userdata/user-tasks.json,随应用数据一起备份。
 */
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { getAppDataDir } from '../utils/AppDir'
import type { UserTask } from '../../shared/tasks/UserTask'

const SAVE_DIR_NAME = 'userdata'

export default class UserTaskStorage {
  private storageData: Store<any>
  private readonly STORAGE_NAME = 'user-tasks'

  constructor() {
    this.storageData = new Store<any>({
      name: this.STORAGE_NAME,
      cwd: this.getAppUserDataPath(),
      defaults: { tasks: [] }
    })
  }

  private getAppUserDataPath(): string {
    const userDataPath = path.join(getAppDataDir(), SAVE_DIR_NAME)
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
    }
    return userDataPath
  }

  getTasks(): UserTask[] {
    return this.storageData.get('tasks') || []
  }

  getTask(id: string): UserTask | null {
    return this.getTasks().find((task) => task.id === id) || null
  }

  /** 新增或更新(按 id upsert),返回最新列表 */
  saveTask(task: UserTask): UserTask[] {
    const tasks = this.getTasks()
    const now = new Date().toISOString()
    const normalized: UserTask = {
      ...task,
      id: task.id || randomUUID(),
      name: (task.name || '').trim() || 'Untitled',
      repeat: task.repeat && task.repeat > 0 ? Math.floor(task.repeat) : 1,
      steps: Array.isArray(task.steps) ? task.steps : [],
      updatedAt: now
    }
    const index = tasks.findIndex((item) => item.id === normalized.id)
    if (index >= 0) {
      normalized.createdAt = tasks[index].createdAt || now
      tasks[index] = normalized
    } else {
      normalized.createdAt = now
      tasks.push(normalized)
    }
    this.storageData.set('tasks', tasks)
    return tasks
  }

  deleteTask(id: string): UserTask[] {
    const tasks = this.getTasks().filter((task) => task.id !== id)
    this.storageData.set('tasks', tasks)
    return tasks
  }

  /** 导入:按 id 合并,已存在的跳过,返回 {added, skipped} */
  importTasks(incoming: UserTask[]): { added: number; skipped: number } {
    const tasks = this.getTasks()
    const existing = new Set(tasks.map((task) => task.id))
    let added = 0
    let skipped = 0
    for (const task of incoming) {
      if (!task || typeof task.id !== 'string' || !Array.isArray(task.steps)) {
        skipped++
        continue
      }
      if (existing.has(task.id)) {
        skipped++
        continue
      }
      tasks.push(task)
      existing.add(task.id)
      added++
    }
    if (added > 0) this.storageData.set('tasks', tasks)
    return { added, skipped }
  }

}
