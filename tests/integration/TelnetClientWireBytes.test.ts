/**
 * TelnetClient 真实链路集成测试（不 mock telnet-client）
 *
 * 与 TelnetClient.test.ts（mock 库、只验证 payload 构造）互补，本文件锁定"线上字节"契约：
 * 用本地 TCP 服务端接收原始字节并逐字节断言，真实 telnet-client 全程参与，
 * 库内部对 Buffer 的任何转码/追加行为（如 send() 的 `data += ors` 强转 utf8）都会在此暴露。
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import * as iconv from 'iconv-lite'
import TelnetClient from '@/main/protocol/TelnetClient'
import type ConnectionInfo from '@/main/protocol/ConnectionInfo'

const SESSION_ID = 'wire-bytes-test'

describe('TelnetClient wire bytes (real telnet-client + local tcp server)', () => {
  let server: net.Server | undefined
  let client: TelnetClient | undefined
  const received: Buffer[] = []

  // 静默服务端:只收字节不回发,同时锁定"发送不依赖对端响应"的语义
  const startServer = async (): Promise<number> => {
    server = net.createServer((socket) => {
      socket.on('data', (d: Buffer) => received.push(d))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const startClient = async (port: number, encoding?: string): Promise<void> => {
    client = new TelnetClient()
    const info: ConnectionInfo = {
      host: '127.0.0.1',
      port,
      username: '',
      password: '',
      sessionId: SESSION_ID,
      ...(encoding ? { encoding } : {})
    }
    const r = await client.start(info, () => {}, () => {}, () => {})
    expect((r as { success: boolean }).success).toBe(true)
  }

  // 轮询等收满 expectedLength 字节,再多等 graceMs 捕获迟到多余字节(如被强加的 '\n')
  const waitReceived = async (expectedLength: number, graceMs = 150): Promise<Buffer> => {
    const deadline = Date.now() + 5000
    while (Buffer.concat(received).length < expectedLength && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, graceMs))
    return Buffer.concat(received)
  }

  afterEach(async () => {
    await client?.disconnect(SESSION_ID).catch(() => {})
    client = undefined
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve())
        server.closeAllConnections?.()
      } else {
        resolve()
      }
    })
    server = undefined
    received.length = 0
  })

  it('HEX 高字节按原始字节透传,0x80-0xFF 不被 utf8 重编码为 EF BF BD', async () => {
    const port = await startServer()
    await startClient(port)

    // 渲染层 parseHexString 的产物:charCode 0-255 的二进制字符串
    // 回归锚点:telnet-client send() 曾把 0xFF 变成 EF BF BD(U+FFFD) 落到线上
    const binary = String.fromCharCode(0xff, 0x80, 0x7f) + '\r\n'
    const r = await client.send(SESSION_ID, binary, () => {})
    expect((r as { success: boolean }).success).toBe(true)

    const wire = await waitReceived(5)
    expect(Array.from(wire)).toEqual([0xff, 0x80, 0x7f, 0x0d, 0x0a])
  })

  it('文本发送不强追加换行,CRLF 由渲染层开关决定', async () => {
    const port = await startServer()
    await startClient(port)

    const r = await client.send(SESSION_ID, 'AT', () => {})
    expect((r as { success: boolean }).success).toBe(true)

    // 回归锚点:telnet-client ors 默认 '\n' 曾给每次发送强追加 0x0A
    const wire = await waitReceived(2)
    expect(Array.from(wire)).toEqual([0x41, 0x54])
  })

  it('非 UTF-8 文本按连接编码发送(GBK 字节原样落线)', async () => {
    const port = await startServer()
    await startClient(port, 'gbk')

    const r = await client.send(SESSION_ID, '中文', () => {})
    expect((r as { success: boolean }).success).toBe(true)

    // 回归锚点:iconv 产出的 GBK 字节曾被库 toString('utf8') 破坏成替换符
    const expected = iconv.encode('中文', 'gbk')
    const wire = await waitReceived(expected.length)
    expect(wire.equals(expected)).toBe(true)
  })

  it('静默对端(不回发任何数据)下发送立即成功', async () => {
    const port = await startServer()
    await startClient(port)

    const start = Date.now()
    const r = await client.send(SESSION_ID, 'ping', () => {})
    expect((r as { success: boolean }).success).toBe(true)
    // 回归锚点:telnet-client write()/send() 需等对端响应,静默对端 2s 后误报失败
    expect(Date.now() - start).toBeLessThan(1500)

    const wire = await waitReceived(4)
    expect(Array.from(wire)).toEqual([0x70, 0x69, 0x6e, 0x67])
  })
})
