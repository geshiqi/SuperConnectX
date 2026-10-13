/**
 * 命令面板:任务 CRUD / 运行控制 IPC + 面板窗口管理。
 * 面板 = 独立无边框 BrowserWindow,尺寸/位置记忆,单例,toggle 显隐。
 */
import { BrowserWindow, ipcMain, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { is } from '@electron-toolkit/utils'
import UserTaskStorage from '../storage/UserTaskStorage'
import WindowStateStorage, { isBoundsVisible } from '../storage/WindowStateStorage'
import { TaskRunner, type TaskConnector } from '../tasks/TaskRunner'
import IpcConnector from './IpcConnector'
import logger from './IpcAppLogger'
import type { UserTask, TaskRunEvent } from '../../shared/tasks/UserTask'

const DEFAULT_PALETTE_BOUNDS = { width: 720, height: 560 }
const PALETTE_MIN_SIZE = { width: 420, height: 320 }

export default class IpcTasks {
  private static sInstance: IpcTasks
  private storage = new UserTaskStorage()
  private windowState = new WindowStateStorage()
  private runner = new TaskRunner()
  private paletteWindow: BrowserWindow | null = null
  private activeSessionId: string | null = null
  private currentRunId: string | null = null
  private currentTheme: 'dark' | 'light' = 'dark'
  private paletteMinimal = false
  private palettePreMinimalBounds: Electron.Rectangle | null = null
  private palettePreMinimalMaximized = false

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

    ipcMain.handle('tasks:reorder', (_, { ids, groups }: { ids: string[]; groups: Record<string, string> }) => {
      if (!Array.isArray(ids)) return { success: false, message: 'invalid ids' }
      const tasks = this.storage.reorderTasks(ids, groups || {})
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

    // 后台常驻进程管理
    ipcMain.handle('task:list-background', () => this.runner.listBackground())
    ipcMain.handle('task:stop-background', () => {
      const stopped = this.runner.stopBackgroundAll()
      return { success: true, stopped }
    })

    // 主窗口上报当前激活的终端会话(target: 'active' 的解析来源)
    ipcMain.on('task:set-active-session', (_, sessionId: string | null) => {
      this.activeSessionId = sessionId || null
    })

    // 标题栏按钮唤起
    ipcMain.on('palette:toggle', () => this.togglePalette())

    // 面板窗口标准控件:最小化/最大化还原/关闭
    ipcMain.handle('palette:minimize', () => {
      this.paletteWindow?.minimize()
      return { success: true }
    })
    ipcMain.handle('palette:toggle-maximize', () => {
      const win = this.paletteWindow
      if (!win || win.isDestroyed()) return { success: false }
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return { success: true, maximized: win.isMaximized() }
    })
    ipcMain.handle('palette:close', () => {
      this.paletteWindow?.close()
      return { success: true }
    })
    ipcMain.handle('palette:is-maximized', () => this.paletteWindow?.isMaximized() ?? false)

    // 主题中继:主窗口上报 data-theme,转发给面板窗口(打包后 file:// 两窗口 localStorage 不互通)
    ipcMain.on('palette:set-theme', (_, theme: string) => {
      this.currentTheme = theme === 'light' ? 'light' : 'dark'
      const win = this.paletteWindow
      if (win && !win.isDestroyed()) {
        win.webContents.send('palette:theme', this.currentTheme)
      }
    })
    ipcMain.handle('palette:get-theme', () => this.currentTheme)

    // 极简模式:收缩为置顶小条(默认与最小尺寸 = 命令条内容宽 + 两行输出高),退出恢复原样
    ipcMain.handle('palette:set-minimal', (_, minimal: boolean, contentWidth?: number) => {
      const win = this.paletteWindow
      if (!win || win.isDestroyed()) return { success: false }
      this.paletteMinimal = minimal === true
      if (this.paletteMinimal) {
        // 先取消最大化:setBounds 对最大化窗口不生效,会导致小条悬浮在满屏窗口中央
        this.palettePreMinimalMaximized = win.isMaximized()
        if (this.palettePreMinimalMaximized) win.unmaximize()
        this.palettePreMinimalBounds = win.getNormalBounds()
        // 宽度取渲染层实测的命令条内容宽;高度 = 36 命令条 + 两行输出
        const measured = Number(contentWidth)
        const width = Number.isFinite(measured) && measured > 0 ? Math.ceil(measured) : this.palettePreMinimalBounds.width
        const MINIMAL_BAR_HEIGHT = 36
        const MINIMAL_OUTPUT_LINES = 2
        const height = MINIMAL_BAR_HEIGHT + MINIMAL_OUTPUT_LINES * 19 + 4
        // 窗口创建时的 minHeight 320 会钳制 setBounds,先放开最小尺寸;极简下仍可拖边缘调整大小
        win.setMinimumSize(width, height)
        win.setBounds({ x: this.palettePreMinimalBounds.x, y: this.palettePreMinimalBounds.y, width, height })
        win.setAlwaysOnTop(true)
      } else {
        win.setAlwaysOnTop(false)
        if (this.palettePreMinimalBounds) {
          win.setBounds(this.palettePreMinimalBounds)
        }
        if (this.palettePreMinimalMaximized) win.maximize()
        win.setMinimumSize(PALETTE_MIN_SIZE.width, PALETTE_MIN_SIZE.height)
      }
      return { success: true }
    })

    // 应用退出前停掉运行中的任务与后台常驻进程(否则孤儿进程会继续占用 J-Link 等)
    app.on('before-quit', () => {
      this.runner.stop()
      this.runner.stopBackgroundAll()
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
    // 窗口状态记忆:首次默认尺寸 + 最大化;之后按上次的大小/位置/是否最大化恢复
    const saved = this.windowState.getWindowState('palette')
    const useSaved = !!saved && isBoundsVisible(saved)
    const win = new BrowserWindow({
      width: useSaved && saved ? saved.width : DEFAULT_PALETTE_BOUNDS.width,
      height: useSaved && saved ? saved.height : DEFAULT_PALETTE_BOUNDS.height,
      minWidth: PALETTE_MIN_SIZE.width,
      minHeight: PALETTE_MIN_SIZE.height,
      ...(useSaved && saved ? { x: saved.x, y: saved.y } : {}),
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

    // 无记忆(首次)或上次就是最大化:打开时最大化
    if (!useSaved || saved!.maximized) {
      win.maximize()
    }

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
    win.on('closed', () => {
      if (this.paletteWindow === win) this.paletteWindow = null
    })

    // 窗口状态记忆:防抖保存,close 时立即保存(最大化时记录还原基准 bounds + 标志)
    let saveStateTimer: NodeJS.Timeout | null = null
    const persistWindowState = (): void => {
      if (win.isDestroyed() || win.isMinimized() || this.paletteMinimal) return
      const normal = win.getNormalBounds()
      this.windowState.saveWindowState('palette', {
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: win.isMaximized()
      })
    }
    const schedulePersistWindowState = (): void => {
      if (saveStateTimer) clearTimeout(saveStateTimer)
      saveStateTimer = setTimeout(() => {
        saveStateTimer = null
        persistWindowState()
      }, 500)
    }
    win.on('resize', schedulePersistWindowState)
    win.on('move', schedulePersistWindowState)
    win.on('maximize', schedulePersistWindowState)
    win.on('unmaximize', schedulePersistWindowState)
    win.on('close', persistWindowState)

    // 最大化状态变化通知面板渲染层(切换按钮图标/提示)
    const notifyMaximized = (): void => {
      if (win.isDestroyed()) return
      win.webContents.send('palette:maximized-changed', win.isMaximized())
    }
    win.on('maximize', notifyMaximized)
    win.on('unmaximize', notifyMaximized)
  }
}
