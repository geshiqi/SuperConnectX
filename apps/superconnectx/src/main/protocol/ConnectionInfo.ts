export default interface ConnectionInfo {
  host: string
  port: number
  username: string
  password: string
  sessionId: string
  // 串口参数
  comName?: string
  baudRate?: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 1.5 | 2
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  // 扩展参数
  encoding?: string
  readTimeout?: number
  writeTimeout?: number
  // 流控制参数
  flowControl?: 'none' | 'hardware' | 'software'
  rts?: boolean
  dtr?: boolean
  // 数据接收格式
  receiveHex?: boolean
  // 分包超时（接收合并窗口，ms）：窗口内陆续到达的分片合并为一帧处理，对应 SuperCom 的 SubcontractingTimeout
  receiveBatchMs?: number
  // FTP 参数
  ftpMode?: 'server' | 'client'
  ftpDirectory?: string
  ftpPermissions?: string[]
}
