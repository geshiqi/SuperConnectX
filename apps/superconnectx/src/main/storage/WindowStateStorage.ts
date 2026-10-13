/**
 * 窗口状态记忆(electron-store):按窗口 id 保存位置尺寸与最大化标志。
 * 首次(无记忆)由使用方给默认值;之后按上次状态恢复。
 */
import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
import { screen } from 'electron'
import { getAppDataDir } from '../utils/AppDir'

const SAVE_DIR_NAME = 'userdata'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** 坐标是否仍落在任一显示器工作区内(显示器拔掉/换布局后的离屏防护) */
export function isBoundsVisible(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    )
  })
}

export default class WindowStateStorage {
  private storageData: Store<any>
  private readonly STORAGE_NAME = 'window-state'

  constructor() {
    this.storageData = new Store<any>({
      name: this.STORAGE_NAME,
      cwd: this.getAppUserDataPath(),
      defaults: { windows: {} }
    })
  }

  private getAppUserDataPath(): string {
    const userDataPath = path.join(getAppDataDir(), SAVE_DIR_NAME)
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
    }
    return userDataPath
  }

  getWindowState(id: string): WindowState | null {
    const windows = this.storageData.get('windows') || {}
    const state = windows[id]
    if (!state || typeof state.width !== 'number' || typeof state.height !== 'number') return null
    return {
      x: typeof state.x === 'number' ? state.x : 0,
      y: typeof state.y === 'number' ? state.y : 0,
      width: state.width,
      height: state.height,
      maximized: state.maximized === true
    }
  }

  saveWindowState(id: string, state: WindowState): void {
    const windows = this.storageData.get('windows') || {}
    windows[id] = state
    this.storageData.set('windows', windows)
  }
}
