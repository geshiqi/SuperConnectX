<template>
  <el-dialog v-model="visible" :title="t('mirror.title') + ' - ' + comName" width="640px" :close-on-click-modal="false">
    <!-- 开关与虚拟对选择 -->
    <div class="mirror-row">
      <el-switch v-model="active" :disabled="!connected || !exposedPort" @change="toggle" active-text="" />
      <span class="mirror-label">{{ t('mirror.enable') }}</span>
      <el-select v-model="exposedPort" size="small" style="width: 160px" :placeholder="t('mirror.pickPair')" @change="onPickPair">
        <el-option v-for="opt in pairOptions" :key="opt.exposed" :label="`${opt.exposed} ⇄ ${opt.internal}`" :value="opt.exposed" />
      </el-select>
      <span v-if="!connected" class="mirror-warn">{{ t('mirror.needConnected') }}</span>
    </div>

    <!-- 三个方向的规则编辑 -->
    <div v-for="dir in dirs" :key="dir.key" class="mirror-dir">
      <div class="mirror-row">
        <el-switch v-model="cfg[dir.key].enabled" size="small" />
        <span class="mirror-label strong">{{ t(dir.label) }}</span>
        <el-select v-model="cfg[dir.key].mode" size="small" style="width: 110px">
          <el-option :label="t('mirror.whitelist')" value="whitelist" />
          <el-option :label="t('mirror.blacklist')" value="blacklist" />
        </el-select>
        <el-button size="small" text type="primary" @click="addRule(dir.key)">+ {{ t('mirror.addRule') }}</el-button>
      </div>
      <div v-for="(r, i) in cfg[dir.key].rules" :key="r.id" class="mirror-row rule-row">
        <el-select v-model="r.target" size="small" style="width: 82px">
          <el-option label="HEX" value="hex" />
          <el-option :label="t('mirror.bytes')" value="bytes" />
        </el-select>
        <el-input v-model="r.pattern" size="small" :placeholder="r.target === 'hex' ? '^7E.*D3' : String.raw`^\x7e`" style="flex: 1" @change="save" />
        <span class="rule-hit" :class="{ ok: hitMap[r.id] === 'hit', bad: hitMap[r.id] === 'miss' }" :title="t('mirror.hitState')">
          {{ hitMap[r.id] === 'hit' ? '●' : hitMap[r.id] === 'miss' ? '○' : '' }}
        </span>
        <el-button size="small" text type="danger" @click="cfg[dir.key].rules.splice(i, 1); save()">×</el-button>
      </div>
    </div>

    <!-- 测试预览:输入 hex 或文本,点亮各行命中 -->
    <div class="mirror-row">
      <el-input v-model="testInput" size="small" :placeholder="t('mirror.testHint')" style="flex: 1" />
      <el-button size="small" @click="runTest">{{ t('mirror.test') }}</el-button>
    </div>

    <!-- 统计 -->
    <div v-if="statsText" class="mirror-stats">{{ statsText }}</div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { evaluateRules, type MirrorConfig, type MirrorRule } from '../../../../main/mirror/rules'

const props = defineProps<{ comName: string; sessionId: string; connected: boolean }>()
const visible = defineModel<boolean>({ default: false })
const { t } = useI18n()

const dirs = [
  { key: 'rx' as const, label: 'mirror.dirRx' },
  { key: 'inject' as const, label: 'mirror.dirInject' },
  { key: 'ownTx' as const, label: 'mirror.dirOwnTx' }
]

const defaultCfg = (): MirrorConfig => ({
  rx: { enabled: true, mode: 'whitelist', rules: [] },
  inject: { enabled: false, mode: 'whitelist', rules: [] },
  ownTx: { enabled: false, mode: 'blacklist', rules: [] }
})

const cfg = ref<MirrorConfig>(defaultCfg())
const exposedPort = ref('')
const internalPort = ref('')
const pairOptions = ref<Array<{ exposed: string; internal: string }>>([])
const active = ref(false)
const testInput = ref('')
const hitMap = ref<Record<string, 'hit' | 'miss'>>({})
const statsText = ref('')
const cfgKey = computed(() => `mirror-cfg-${props.comName}`)

const save = (): void => {
  try {
    localStorage.setItem(cfgKey.value, JSON.stringify({ cfg: cfg.value, exposed: exposedPort.value }))
  } catch { /* ignore */ }
}

const load = (): void => {
  try {
    const raw = localStorage.getItem(cfgKey.value)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.cfg) cfg.value = { ...defaultCfg(), ...parsed.cfg }
      if (parsed?.exposed) exposedPort.value = parsed.exposed
    }
  } catch { /* ignore */ }
}

const addRule = (key: 'rx' | 'inject' | 'ownTx'): void => {
  cfg.value[key].rules.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, target: 'hex', pattern: '' })
  save()
}

const onPickPair = (): void => {
  const opt = pairOptions.value.find((o) => o.exposed === exposedPort.value)
  internalPort.value = opt?.internal ?? ''
  if (active.value) void toggle(true) // 切换对:重启镜像
  save()
}

const refreshStatus = async (): Promise<void> => {
  const list = (await window.mirrorApi.status()) as Array<{ sessionId: string; exposedPort: string; internalPort: string; stats: Record<string, number> }>
  const mine = list.find((x) => x.sessionId === props.sessionId)
  active.value = !!mine
  if (mine) {
    exposedPort.value = mine.exposedPort
    internalPort.value = mine.internalPort
    statsText.value = t('mirror.stats', mine.stats)
  } else {
    statsText.value = ''
  }
}

const toggle = async (on: boolean): Promise<void> => {
  if (on) {
    if (!exposedPort.value || !internalPort.value) {
      active.value = false
      ElMessage.warning(t('mirror.needPair'))
      return
    }
    const r = await window.mirrorApi.start({
      sessionId: props.sessionId,
      comName: props.comName,
      internalPort: internalPort.value,
      exposedPort: exposedPort.value,
      config: cfg.value
    })
    if (!r.success) {
      active.value = false
      ElMessage.error(r.message || t('mirror.startFail'))
      return
    }
  } else {
    await window.mirrorApi.stop(props.sessionId)
  }
  save()
  void refreshStatus()
}

// 规则变化热更新到运行中的镜像
watch(cfg, () => { if (active.value) void window.mirrorApi.updateConfig(props.sessionId, cfg.value) }, { deep: true })

const runTest = (): void => {
  const raw = testInput.value.trim()
  if (!raw) return
  // 输入全为偶数位十六进制则按 hex 解析为字节,否则按文本
  const isHex = /^[0-9A-Fa-f\s]+$/.test(raw) && raw.replace(/\s/g, '').length % 2 === 0
  const buf = isHex ? Buffer.from(raw.replace(/\s/g, ''), 'hex') : Buffer.from(raw, 'latin1')
  const map: Record<string, 'hit' | 'miss'> = {}
  for (const dir of dirs) {
    for (const row of evaluateRules(cfg.value[dir.key].rules as MirrorRule[], buf)) {
      if (row.valid) map[row.id] = row.matched ? 'hit' : 'miss'
    }
  }
  hitMap.value = map
}

let removeEventListener: (() => void) | null = null
watch(visible, async (open) => {
  if (open) {
    load()
    // 虚拟对:相邻两条为一对
    const ports = (await window.virtualPortApi.listPorts()) as Array<{ ID: string; Name: string }>
    pairOptions.value = []
    for (let i = 0; i + 1 < ports.length; i += 2) {
      pairOptions.value.push({ exposed: ports[i].Name, internal: ports[i + 1].Name })
    }
    await refreshStatus()
    removeEventListener = window.mirrorApi.onMirrorEvent(() => void refreshStatus())
  } else {
    removeEventListener?.()
    removeEventListener = null
    save()
  }
})
</script>

<style scoped>
.mirror-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.mirror-label { font-size: 13px; }
.mirror-label.strong { font-weight: 600; }
.mirror-warn { color: #e6a23c; font-size: 12px; }
.mirror-dir { border-top: 1px solid var(--border-secondary, #404040); padding-top: 6px; margin-top: 6px; }
.rule-row { padding-left: 16px; }
.rule-hit { width: 14px; text-align: center; font-size: 12px; }
.rule-hit.ok { color: #67c23a; }
.rule-hit.bad { color: #909399; }
.mirror-stats { margin-top: 8px; font-size: 12px; color: var(--text-secondary, #888); }
</style>
