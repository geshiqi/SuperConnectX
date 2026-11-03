/**
 * Windows USB 物理拓扑路径直查(koffi FFI 直调经典 SetupAPI/CM API,免 PowerShell 进程)。
 *
 * 路径形如 "8.3.3.2.3"(对齐 finduart 口径):根 hub 口号 + 逐级 hub 口号 + 叶子口号。
 * 实现避开现代属性 API(SetupDiGetDevicePropertyW/CM_Get_DevNode_PropertyW,实测经
 * koffi 调用恒失败),全部使用已逐个验证可用的经典调用:
 *   - SetupDi 枚举 Ports 设备类,取实例 ID 与 SPDRP_LOCATION_INFORMATION(经典注册表属性)
 *   - LOCATION 为 "Port_#N.Hub_#M" 形式:叶子口 = N,再经 CM_Get_Parent 父链,
 *     各祖先实例 ID 末段 "&0&K" 即其在父节点上的口号,逐级拼链直到 USB\ROOT_HUB
 *   - LOCATION 为数值形式(J-Link 等复合设备,如 "0000.0014.0000.008.003.003.003.000.000"):
 *     跳过前 3 段 PCI 定位、去掉尾部 0 段,直接取数字链(与 finduart 可能相差最末接口层一段)
 *
 * 安全边界:纯只读、固定缓冲、无回调无内存管理责任;koffi 为 N-API 预编译。仅 win32 加载。
 */
import logger from '../ipc/IpcAppLogger'

/** 实例 ID 末段 "&0&N" → 挂在父节点上的端口号(J-Link 的 &0&0000 属接口号,由调用方按层级取舍) */
export function trailingPort(deviceId: string): number | null {
  const m = deviceId.match(/&0&(\d+)$/i)
  return m ? Number(m[1]) : null
}

/** "Port_#0003.Hub_#0007" → 3;其他形式返回 null */
export function parsePortHubLocation(location: string | null): number | null {
  const m = location?.match(/Port_#(\d+)/i)
  return m ? Number(m[1]) : null
}

/** 数值形式 location "0000.0014.0000.008.003.003.003.000.000" → "8.3.3.3";不适配返回 null */
export function parseNumericLocation(location: string | null): string | null {
  if (!location || !/^\d+(\.\d+)+$/.test(location)) return null
  const segs = location.split('.').map(Number)
  if (segs.length < 5) return null
  // 前 3 段为设备在 PCI 总线上的定位;尾部连续 0 为接口/子层占位
  const chain = segs.slice(3)
  while (chain.length > 0 && chain[chain.length - 1] === 0) chain.pop()
  return chain.length > 0 ? chain.join('.') : null
}

interface SetupApi {
  /** 枚举 Ports 设备类,返回 实例ID + DevInst + LOCATION_INFORMATION */
  enumerate: () => Array<{ instanceId: string; devInst: number; location: string | null }>
  /** DevInst → 父 DevInst;无父返回 null */
  parent: (devInst: number) => number | null
  /** DevInst → 设备实例 ID */
  deviceId: (devInst: number) => string | null
}

let setupApi: SetupApi | null = null
let initFailed = false

/** 惰性加载 koffi + DLL;失败只记一次日志,后续调用直接返回空(优雅降级) */
function getSetupApi(): SetupApi | null {
  if (setupApi) return setupApi
  if (initFailed) return null
  try {
    // 惰性 require:非 win32 平台与单测环境不加载原生模块
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')

    const GUID = koffi.struct('GUID', {
      Data1: 'uint32_t',
      Data2: 'uint16_t',
      Data3: 'uint16_t',
      Data4: koffi.array('uint8_t', 8)
    })
    const SP_DEVINFO_DATA = koffi.struct('SP_DEVINFO_DATA', {
      cbSize: 'uint32_t',
      ClassGuid: GUID,
      DevInst: 'uint32_t',
      Reserved: 'uintptr_t'
    })

    const setupapi = koffi.load('setupapi.dll')
    const cfgmgr = koffi.load('cfgmgr32.dll')
    const GetClassDevs = setupapi.func(
      'void *SetupDiGetClassDevsW(const GUID *ClassGuid, const uint16_t *Enumerator, void *hwndParent, uint32_t Flags)'
    )
    const EnumDeviceInfo = setupapi.func(
      'int SetupDiEnumDeviceInfo(void *DeviceInfoSet, uint32_t MemberIndex, SP_DEVINFO_DATA *DeviceInfoData)'
    )
    const GetInstanceId = setupapi.func(
      'int SetupDiGetDeviceInstanceIdW(void *DeviceInfoSet, SP_DEVINFO_DATA *DeviceInfoData, uint16_t *DeviceInstanceId, uint32_t DeviceInstanceIdSize, uint8_t *RequiredSize)'
    )
    // SPDRP_LOCATION_INFORMATION = 13(注意不是 12,12 是 FRIENDLYNAME)
    const GetRegProp = setupapi.func(
      'int SetupDiGetDeviceRegistryPropertyW(void *DeviceInfoSet, SP_DEVINFO_DATA *DeviceInfoData, uint32_t Property, uint8_t *PropertyRegDataType, uint8_t *PropertyBuffer, uint32_t PropertyBufferSize, uint8_t *RequiredSize)'
    )
    const DestroyList = setupapi.func('int SetupDiDestroyDeviceInfoList(void *DeviceInfoSet)')
    const CmGetParent = cfgmgr.func('int32_t CM_Get_Parent(uint32_t *ParentDevInst, uint32_t DevInst, uint32_t Flags)')
    const CmGetId = cfgmgr.func('int32_t CM_Get_Device_IDW(uint32_t DevInst, uint16_t *Buffer, uint32_t BufferLen, uint32_t Flags)')

    // Ports 设备类 GUID {4D36E978-E325-11CE-BFC1-08002BE10318};DIGCF_PRESENT(2) 仅枚举在场设备
    const portsClassGuid = {
      Data1: 0x4d36e978,
      Data2: 0xe325,
      Data3: 0x11ce,
      Data4: [0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18]
    }
    const DIGCF_PRESENT = 2
    const sizeofData = koffi.sizeof(SP_DEVINFO_DATA)
    const dataPtr = koffi.alloc('SP_DEVINFO_DATA', 1)
    const u32 = (): Buffer => Buffer.alloc(4)

    setupApi = {
      enumerate() {
        const devices: Array<{ instanceId: string; devInst: number; location: string | null }> = []
        koffi.encode(dataPtr, SP_DEVINFO_DATA, {
          cbSize: sizeofData,
          ClassGuid: { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] },
          DevInst: 0,
          Reserved: 0
        })
        const handle = GetClassDevs(portsClassGuid, null, null, DIGCF_PRESENT)
        if (!handle) return devices
        try {
          for (let index = 0; index < 64; index++) {
            koffi.encode(dataPtr, SP_DEVINFO_DATA, {
              cbSize: sizeofData,
              ClassGuid: { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] },
              DevInst: 0,
              Reserved: 0
            })
            if (!EnumDeviceInfo(handle, index, dataPtr)) break

            const idBuf = Buffer.alloc(1024)
            if (!GetInstanceId(handle, dataPtr, idBuf, 512, u32())) continue
            const instanceId = idBuf.toString('utf16le').split('\0')[0]
            if (!instanceId) continue

            const type = u32()
            const locBuf = Buffer.alloc(512)
            const location = GetRegProp(handle, dataPtr, 13, type, locBuf, locBuf.length, u32())
              ? locBuf.toString('utf16le').split('\0')[0] || null
              : null

            const info = koffi.decode(dataPtr, SP_DEVINFO_DATA) as { DevInst: number }
            devices.push({ instanceId, devInst: info.DevInst, location })
          }
        } finally {
          DestroyList(handle)
        }
        return devices
      },
      parent(devInst) {
        const buf = u32()
        if (CmGetParent(buf, devInst, 0) !== 0) return null
        const parent = buf.readUInt32LE(0)
        return parent === 0 || parent === devInst ? null : parent
      },
      deviceId(devInst) {
        const buf = Buffer.alloc(1024)
        if (CmGetId(devInst, buf, 512, 0) !== 0) return null
        return buf.toString('utf16le').split('\0')[0] || null
      }
    }
    logger.info('[WinUsbPaths] setupapi/cfgmgr loaded via koffi')
    return setupApi
  } catch (error) {
    initFailed = true
    logger.error(`[WinUsbPaths] koffi init failed: ${error}`)
    return null
  }
}

/** 由叶子 DevInst + 其 LOCATION 拼完整拓扑路径;父链最多走 8 层 */
export function buildUsbPath(api: SetupApi, devInst: number, location: string | null): string | null {
  // 数值形式(J-Link 等复合设备):链直接可读,通常比父链多一层复合设备信息
  const numeric = parseNumericLocation(location)
  const leafPort = parsePortHubLocation(location)
  if (numeric == null && leafPort == null) return null

  const ports: number[] = []
  if (leafPort != null) ports.unshift(leafPort)
  let cur = devInst
  for (let depth = 0; depth < 8; depth++) {
    const id = api.deviceId(cur)
    if (id == null) break
    const port = trailingPort(id)
    // 根 hub/接口层的 0 端口号无意义,不计入
    if (port != null && port > 0) ports.unshift(port)
    if (id.startsWith('USB\\ROOT_HUB')) break
    const parent = api.parent(cur)
    if (parent == null) break
    cur = parent
  }
  const walked = ports.join('.')
  // 取更完整的一条(数值链与父链信息量依设备而异)
  if (numeric == null) return walked || null
  if (!walked) return numeric
  return numeric.split('.').length >= walked.split('.').length ? numeric : walked
}

/**
 * 查询所有串口设备的 USB 拓扑路径,返回 实例ID(大写) -> "8.3.3.2.3"。
 * 同步执行(实测约 20ms)。任何失败返回空 Map(优雅降级,仅影响显示)。
 */
export function getWindowsUsbPaths(): Map<string, string> {
  const map = new Map<string, string>()
  if (process.platform !== 'win32') return map
  const api = getSetupApi()
  if (!api) return map
  try {
    for (const device of api.enumerate()) {
      const path = buildUsbPath(api, device.devInst, device.location)
      if (path) map.set(device.instanceId.toUpperCase(), path)
    }
  } catch (error) {
    logger.error(`[WinUsbPaths] enumerate failed: ${error}`)
    return new Map()
  }
  return map
}
