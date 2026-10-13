import { describe, it, expect, beforeEach } from 'vitest'
import WindowStateStorage from '@/main/storage/WindowStateStorage'

describe('WindowStateStorage', () => {
  let storage: WindowStateStorage

  beforeEach(() => {
    storage = new WindowStateStorage()
  })

  it('无记录时返回 null', () => {
    expect(storage.getWindowState('main')).toBeNull()
  })

  it('保存后可读回完整状态', () => {
    storage.saveWindowState('main', { x: 100, y: 200, width: 1200, height: 800, maximized: true })
    expect(storage.getWindowState('main')).toEqual({ x: 100, y: 200, width: 1200, height: 800, maximized: true })
  })

  it('多窗口互不干扰', () => {
    storage.saveWindowState('main', { x: 0, y: 0, width: 1000, height: 600, maximized: false })
    storage.saveWindowState('palette', { x: 50, y: 50, width: 720, height: 560, maximized: true })
    expect(storage.getWindowState('main')?.width).toBe(1000)
    expect(storage.getWindowState('palette')?.maximized).toBe(true)
  })

  it('覆盖更新同一窗口', () => {
    storage.saveWindowState('palette', { x: 1, y: 2, width: 300, height: 400, maximized: false })
    storage.saveWindowState('palette', { x: 9, y: 9, width: 800, height: 600, maximized: true })
    expect(storage.getWindowState('palette')).toEqual({ x: 9, y: 9, width: 800, height: 600, maximized: true })
  })

  it('缺 x/y 的旧格式回填默认坐标', () => {
    storage.saveWindowState('legacy', { x: 0, y: 0, width: 640, height: 480, maximized: false } as never)
    const state = storage.getWindowState('legacy')
    expect(state).toMatchObject({ width: 640, height: 480 })
  })
})
