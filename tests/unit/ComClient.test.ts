/**
 * ComClient 测试
 * 使用 mock 的 serialport 库测试 ComClient 核心逻辑
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock serialport（原生模块，测试中无法加载）
vi.mock('serialport', () => {
  class MockSerialPort {
    private listeners: Map<string, Function[]> = new Map()
    path: string
    baudRate: number
    isOpen = true

    constructor(opts: any) {
      this.path = opts.path
      this.baudRate = opts.baudRate
    }

    on(event: string, callback: Function): void {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, [])
      }
      this.listeners.get(event)!.push(callback)
    }

    once(event: string, callback: Function): void {
      this.on(event, callback)
    }

    removeAllListeners(event?: string): void {
      if (event) {
        this.listeners.delete(event)
      } else {
        this.listeners.clear()
      }
    }

    open(callback: (err: Error | null) => void): void {
      setImmediate(() => {
        this.emit('open')
        callback(null)
      })
    }

    write(_data: any, _encoding: any, callback: (err: Error | null) => void): void {
      callback(null)
    }

    close(callback?: (err: Error | null) => void): void {
      this.isOpen = false
      callback?.(null)
    }

    // Helper for tests
    emit(event: string, ...args: any[]): void {
      const cbs = this.listeners.get(event) || []
      cbs.forEach(cb => cb(...args))
    }
  }

  return { SerialPort: MockSerialPort }
})

import ComClient from '@/main/protocol/ComClient'

describe('ComClient', () => {
  let client: ComClient

  beforeEach(() => {
    client = new ComClient()
  })

  const startConnection = async (sessionId: string, onData = vi.fn(), onLog = vi.fn()) => {
    const result = await client.start(
      { comName: 'COM1', sessionId, host: '', port: 0, username: '', password: '' },
      onData, vi.fn(), onLog
    )
    return { result, onData, onLog }
  }

  describe('start()', () => {
    it('should return success on open', async () => {
      const { result } = await startConnection('s1')
      expect((result as any).success).toBe(true)
      expect(client.serialConnections.has('s1')).toBe(true)
    })

    it('should fail without comName', async () => {
      const result = await client.start(
        { comName: '', sessionId: 's2', host: '', port: 0, username: '', password: '' },
        vi.fn(), vi.fn(), vi.fn()
      )
      expect((result as any).success).toBe(false)
    })
  })

  describe('receive buffer cap', () => {
    it('should force-flush buffer exceeding 1MB when no newline arrives', async () => {
      const onData = vi.fn()
      const onLog = vi.fn()
      await startConnection('cap-1', onData, onLog)

      const connection = client.serialConnections.get('cap-1')!
      // 模拟设备持续发送不带换行符的内容（split 会一直保留 remainder，
      // 且持续有数据时空闲刷新 checkFlushBuffer 不会触发）
      connection.buffer = Buffer.alloc(1024 * 1024 + 1, 'a')
      ;(client as any).processBuffer(connection)

      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData.mock.calls[0][0].data.length).toBe(1024 * 1024 + 1)
      expect(onLog).toHaveBeenCalledTimes(1)
      expect(connection.buffer.length).toBe(0)
    })

    it('should keep buffer below the cap for the next chunk', async () => {
      const onData = vi.fn()
      await startConnection('cap-2', onData)

      const connection = client.serialConnections.get('cap-2')!
      connection.buffer = Buffer.from('no newline yet')
      ;(client as any).processBuffer(connection)

      expect(onData).not.toHaveBeenCalled()
      expect(connection.buffer.toString()).toBe('no newline yet')
    })
  })

  describe('updateConfig() reopen', () => {
    it('should notify onClose when the reopened port closes (unplug after config change)', async () => {
      const onClose = vi.fn()
      await client.start(
        { comName: 'COM1', sessionId: 'upd-close', host: '', port: 0, username: '', password: '' },
        vi.fn(),
        onClose,
        vi.fn()
      )

      const result = await client.updateConfig('upd-close', { baudRate: 115200 })
      expect((result as any).success).toBe(true)
      expect(client.serialConnections.has('upd-close')).toBe(true)

      // 配置变更重开后拔出端口：close 事件应通知上层（状态清理/渲染进程/镜像联动）
      const connection = client.serialConnections.get('upd-close')!
      connection.port.emit('close')

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(client.serialConnections.has('upd-close')).toBe(false)
    })

    it('should flush remaining buffer before notifying onClose', async () => {
      const onData = vi.fn()
      const onClose = vi.fn()
      await client.start(
        { comName: 'COM1', sessionId: 'upd-flush', host: '', port: 0, username: '', password: '' },
        onData, onClose, vi.fn()
      )

      await client.updateConfig('upd-flush', { baudRate: 115200 })
      const connection = client.serialConnections.get('upd-flush')!
      connection.buffer = Buffer.from('remaining')
      connection.port.emit('close')

      expect(onData).toHaveBeenCalledWith(
        expect.objectContaining({ data: 'remaining', timestamp: expect.any(String) })
      )
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('disconnect()', () => {
    it('waits for the serial port close callback before resolving', async () => {
      await startConnection('close-1')
      const connection = client.serialConnections.get('close-1')!
      let finishClose: ((err: Error | null) => void) | undefined
      connection.port.close = vi.fn((callback) => {
        finishClose = callback
      })

      let settled = false
      const disconnectPromise = client.disconnect('close-1').then((result) => {
        settled = true
        return result
      })
      await Promise.resolve()

      expect(settled).toBe(false)
      expect(client.serialConnections.has('close-1')).toBe(true)

      finishClose?.(null)
      await expect(disconnectPromise).resolves.toMatchObject({ success: true })
      expect(client.serialConnections.has('close-1')).toBe(false)
    })

    it('notifies onClose after a successful disconnect (savedOnClose)', async () => {
      const onClose = vi.fn()
      await client.start(
        { comName: 'COM1', sessionId: 'close-cb', host: '', port: 0, username: '', password: '' },
        vi.fn(),
        onClose,
        vi.fn()
      )

      await expect(client.disconnect('close-cb')).resolves.toMatchObject({ success: true })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(client.serialConnections.has('close-cb')).toBe(false)
    })

    it('keeps the connection when closing the serial port fails', async () => {
      await startConnection('close-error')
      const connection = client.serialConnections.get('close-error')!
      connection.port.close = vi.fn((callback) => callback(new Error('close failed')))

      await expect(client.disconnect('close-error')).resolves.toMatchObject({
        success: false,
        message: 'close failed'
      })
      expect(client.serialConnections.has('close-error')).toBe(true)
    })

    it('times out and keeps the connection when close never completes', async () => {
      await startConnection('close-timeout')
      const connection = client.serialConnections.get('close-timeout')!
      connection.port.close = vi.fn()
      vi.useFakeTimers()

      try {
        const disconnectPromise = client.disconnect('close-timeout')
        await vi.advanceTimersByTimeAsync(5000)

        await expect(disconnectPromise).resolves.toMatchObject({
          success: false,
          message: 'Timed out closing serial port after 5000ms'
        })
        expect(client.serialConnections.has('close-timeout')).toBe(true)

        connection.port.emit('close')
        expect(client.serialConnections.has('close-timeout')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
