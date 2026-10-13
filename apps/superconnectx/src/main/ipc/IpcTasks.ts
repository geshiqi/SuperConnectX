/**
 * 命令面板:任务 CRUD / 运行控制 IPC + 面板窗口管理。
 * 面板 = 独立无边框 BrowserWindow,尺寸/位置记忆,单例,toggle 显隐。
 */
import { BrowserWindow, ipcMain, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { is } from '@electron-toolkit/utils'
import UserTaskStorage from '../storage/UserTaskStorage'
import { TaskRunner, type TaskConnector } from '../tasks/TaskRunner'
import IpcConnector from './IpcConnector'
import logger from './IpcAppLogger'
import type { UserTask, TaskRunEvent } from '../../shared/tasks/UserTask'

const DEFAULT_PALETTE_BOUNDS = { width: 720, height: 560 }
const PALETTE_MIN_SIZE = { width: 420, height: 320 }

export default class IpcTasks {
  private static sInstance: IpcTasks
  private storage = new UserTaskStorage()
  private runner = new TaskRunner()
  private paletteWindow: BrowserWindow | null = null
  private activeSessionId: string | null = null
  private currentRunId: string | null = null

  static getInstance(): IpcTasks {
    if (IpcTasks.sInstance == null) {
      IpcTasks.sInstance = new IpcTasks()
    }
    return IpcTasks.sInstance
  }

  private get connector(): TaskConnector {
    return IpcConnector.getInstance()
  }

  init(): void {
    ipcMain.handle('task:list', () => this.storage.getTasks())

    ipcMain.handle('task:save', (_, task: UserTask) => {
      if (!task || typeof task !== 'object') return { success: false, message: 'invalid task' }
      const tasks = this.storage.saveTask(task)
      return { success: true, tasks }
    })

    ipcMain.handle('task:delete', (_, id: string) => {
      const tasks = this.storage.deleteTask(id)
      return { success: true, tasks }
    })

    ipcMain.handle('task:run', async (_, { taskId, external }: { taskId: string; external?: boolean }) => {
      const task = this.storage.getTask(taskId)
      if (!task) return { success: false, message: '任务不存在' }
      if (this.runner.isRunning()) return { success: false, message: '已有任务在运行中' }
      const runId = randomUUID()
      this.currentRunId = runId
      this.runner
        .run(task, {
          activeSessionId: this.activeSessionId,
          connector: this.connector,
          external: external === true,
          taskName: task.name,
          emit: (event) => this.emitToPalette({ ...event, runId })
        })
        .catch((error) => {
          logger.error(`[IpcTasks] run failed: ${(error as Error).message}`)
          this.emitToPalette({ kind: 'run-end', runId, success: false, aborted: false, durationMs: 0 })
        })
        .finally(() => {
          if (this.currentRunId === runId) this.currentRunId = null
        })
      return { success: true, runId }
    })

    ipcMain.handle('task:stop', () => {
      this.runner.stop()
      return { success: true }
    })

    ipcMain.handle('task:is-running', () => this.runner.isRunning())

    // 主窗口上报当前激活的终端会话(target: 'active' 的解析来源)
    ipcMain.on('task:set-active-session', (_, sessionId: string | null) => {
      this.activeSessionId = sessionId || null
    })

    // 标题栏按钮唤起
    ipcMain.on('palette:toggle', () => this.togglePalette())

    // 应用退出前停掉运行中的任务(杀 shell 子进程)
    app.on('before-quit', () => {
      this.runner.stop()
    })
  }

  private emitToPalette(event: TaskRunEvent): void {
    const win = this.paletteWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send('task:event', event)
    }
  }

  // ===== 面板窗口 =====

  togglePalette(): void {
    if (this.paletteWindow && !this.paletteWindow.isDestroyed()) {
      if (this.paletteWindow.isVisible() && this.paletteWindow.isFocused()) {
        this.paletteWindow.hide()
      } else {
        this.paletteWindow.show()
        this.paletteWindow.focus()
      }
      return
    }
    this.createPaletteWindow()
  }

  private createPaletteWindow(): void {
    const saved = this.storage.getPaletteBounds()
    const win = new BrowserWindow({
      width: saved?.width || DEFAULT_PALETTE_BOUNDS.width,
      height: saved?.height || DEFAULT_PALETTE_BOUNDS.height,
      minWidth: PALETTE_MIN_SIZE.width,
      minHeight: PALETTE_MIN_SIZE.height,
      ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
      title: 'Command Palette',
      frame: false,
      resizable: true,
      show: false,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    this.paletteWindow = win

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/palette.html`)
    } else {
      win.loadFile(join(__dirname, '../../out/renderer/palette.html'))
    }

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
    win.on('closed', () => {
      if (this.paletteWindow === win) this.paletteWindow = null
    })

    // 尺寸/位置记忆(仅保存正常状态,最大化/最小化不覆盖)
    const saveBounds = (): void => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
      const bounds = win.getBounds()
      this.storage.savePaletteBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)
  }
}
