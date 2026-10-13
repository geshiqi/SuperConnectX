<template>
  <el-dialog
    :model-value="modelValue"
    :title="isCreate ? t('palette.editorCreate') : t('palette.editorEdit')"
    width="640px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-form label-width="90px" label-position="left" @submit.prevent>
      <el-form-item :label="t('palette.fieldName')">
        <el-input v-model="draft.name" :placeholder="t('palette.fieldNamePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('palette.fieldGroup')">
        <div class="inline-row">
          <el-input v-model="draft.group" :placeholder="t('palette.fieldGroupPlaceholder')" />
          <span class="inline-label">{{ t('palette.fieldRepeat') }}</span>
          <el-input-number v-model="draft.repeat" :min="1" :max="999" size="small" :controls="false" style="width: 72px" />
        </div>
      </el-form-item>
    </el-form>

    <div class="steps-header">
      <span>{{ t('palette.stepsTitle') }} ({{ draft.steps.length }})</span>
      <div class="add-buttons">
        <el-button size="small" @click="addStep('shell')">+ {{ t('palette.stepShell') }}</el-button>
        <el-button size="small" @click="addStep('delay')">+ {{ t('palette.stepDelay') }}</el-button>
        <el-button size="small" @click="addStep('builtin')">+ {{ t('palette.stepBuiltin') }}</el-button>
      </div>
    </div>

    <div class="steps-list">
      <div v-if="draft.steps.length === 0" class="empty-hint">{{ t('palette.stepsEmpty') }}</div>
      <div v-for="(step, i) in draft.steps" :key="i" class="step-card">
        <div class="step-head">
          <span class="step-index">#{{ i + 1 }}</span>
          <el-tag size="small" :type="step.type === 'shell' ? 'primary' : step.type === 'delay' ? 'warning' : 'success'">
            {{ stepTypeLabel(step.type) }}
          </el-tag>
          <div class="step-ops">
            <el-button size="small" text :disabled="i === 0" @click="moveStep(i, -1)"><el-icon><ArrowUp /></el-icon></el-button>
            <el-button size="small" text :disabled="i === draft.steps.length - 1" @click="moveStep(i, 1)"><el-icon><ArrowDown /></el-icon></el-button>
            <el-button size="small" text type="danger" @click="draft.steps.splice(i, 1)"><el-icon><Delete /></el-icon></el-button>
          </div>
        </div>

        <!-- shell 步骤 -->
        <template v-if="step.type === 'shell'">
          <el-input v-model="step.command" type="textarea" :rows="2" :placeholder="t('palette.shellCommandPlaceholder')" />
          <div class="field-grid">
            <div class="field">
              <span class="field-label">{{ t('palette.fieldCwd') }}</span>
              <el-input v-model="step.cwd" placeholder="D:\project" />
            </div>
            <div class="field">
              <span class="field-label">{{ t('palette.fieldShell') }}</span>
              <el-select v-model="step.shell">
                <el-option label="cmd" value="cmd" />
                <el-option label="powershell" value="powershell" />
                <el-option label="bash" value="bash" />
              </el-select>
            </div>
            <div class="field">
              <span class="field-label">{{ t('palette.fieldEncoding') }}</span>
              <el-select v-model="step.encoding">
                <el-option label="utf8" value="utf8" />
                <el-option label="gbk" value="gbk" />
                <el-option label="gb2312" value="gb2312" />
                <el-option label="big5" value="big5" />
                <el-option label="shift-jis" value="shift-jis" />
              </el-select>
            </div>
            <div class="field">
              <span class="field-label">{{ t('palette.fieldTimeout') }}(ms)</span>
              <el-input-number v-model="step.timeoutMs" :min="0" :step="1000" size="small" :controls="false" style="width: 100%" />
            </div>
          </div>
          <div class="target-row">
            <span class="field-label">{{ t('palette.fieldBackground') }}</span>
            <el-switch v-model="step.background" />
            <span class="hint">{{ t('palette.backgroundHint') }}</span>
          </div>
        </template>

        <!-- 延时步骤 -->
        <template v-else-if="step.type === 'delay'">
          <div class="field-grid">
            <div class="field">
              <span class="field-label">{{ t('palette.fieldDelayMs') }}</span>
              <el-input-number v-model="step.ms" :min="0" :step="100" size="small" :controls="false" style="width: 100%" />
            </div>
          </div>
        </template>

        <!-- 内置动作步骤 -->
        <template v-else>
          <el-select v-model="step.action" style="width: 200px">
            <el-option :label="t('palette.actionSendData')" value="sendData" />
            <el-option :label="t('palette.actionConnect')" value="connect" />
            <el-option :label="t('palette.actionDisconnect')" value="disconnect" />
          </el-select>

          <template v-if="step.action === 'sendData'">
            <div class="target-row">
              <span class="field-label">{{ t('palette.fieldTarget') }}</span>
              <el-select v-model="step.targetMode" style="width: 160px">
                <el-option :label="t('palette.targetActive')" value="active" />
                <el-option :label="t('palette.targetLast')" value="last" />
                <el-option :label="t('palette.targetCustom')" value="custom" />
              </el-select>
              <el-input v-if="step.targetMode === 'custom'" v-model="step.customTarget" placeholder="COM20" style="width: 140px" />
            </div>
            <el-input v-model="step.data" type="textarea" :rows="2" :placeholder="t('palette.sendDataPlaceholder')" />
            <div class="target-row">
              <span class="field-label">CRLF</span>
              <el-switch v-model="step.appendCrlf" />
            </div>
          </template>

          <template v-else-if="step.action === 'connect'">
            <div class="target-row">
              <span class="field-label">{{ t('palette.fieldConnId') }}</span>
              <el-input-number v-model="step.connectionId" :min="0" size="small" :controls="false" style="width: 110px" placeholder="-" />
              <span class="field-label" style="margin-left: 12px">{{ t('palette.fieldComName') }}</span>
              <el-input v-model="step.comName" placeholder="COM20" style="width: 120px" />
              <span class="field-label" style="margin-left: 12px">{{ t('palette.fieldBaud') }}</span>
              <el-input-number v-model="step.baudRate" :min="1" size="small" :controls="false" style="width: 100px" />
            </div>
            <div class="hint">{{ t('palette.connectHint') }}</div>
          </template>

          <template v-else>
            <div class="target-row">
              <span class="field-label">{{ t('palette.fieldTarget') }}</span>
              <el-select v-model="step.targetMode" style="width: 160px">
                <el-option :label="t('palette.targetLast')" value="last" />
                <el-option :label="t('palette.targetActive')" value="active" />
                <el-option :label="t('palette.targetCustom')" value="custom" />
              </el-select>
              <el-input v-if="step.targetMode === 'custom'" v-model="step.customTarget" placeholder="COM20" style="width: 140px" />
            </div>
          </template>
        </template>

        <!-- shell / 内置动作的失败策略 -->
        <div v-if="step.type !== 'delay'" class="target-row">
          <span class="field-label">{{ t('palette.fieldStopOnFail') }}</span>
          <el-switch v-model="step.stopOnFail" />
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('palette.cancel') }}</el-button>
      <el-button type="primary" :disabled="!draft.name.trim() || draft.steps.length === 0" @click="save">
        {{ t('palette.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UserTask, TaskStep, TaskShellStep, TaskBuiltinStep } from '../../../shared/tasks/UserTask'

const props = defineProps<{
  modelValue: boolean
  task: UserTask | null
  /** 新建任务时预填的分组(通常为面板当前选中组) */
  defaultGroup?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', tasks: UserTask[]): void
}>()

const { t } = useI18n()

/** 编辑态:内置动作目标用 targetMode(active/last/custom)简化输入,保存时折回 target 字段 */
interface EditShellStep extends TaskShellStep { }
interface EditBuiltinStep extends TaskBuiltinStep {
  targetMode: 'active' | 'last' | 'custom'
  customTarget: string
}
interface TaskDelayStepLike { type: 'delay'; ms: number }

interface Draft {
  id: string
  name: string
  group: string
  repeat: number
  steps: Array<EditShellStep | TaskDelayStepLike | EditBuiltinStep>
}

const draft = reactive<Draft>({
  id: '',
  name: '',
  group: '',
  repeat: 1,
  steps: []
})

const isCreate = computed(() => !props.task)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    const source = props.task
    draft.id = source?.id ?? ''
    draft.name = source?.name ?? ''
    draft.group = source?.group ?? props.defaultGroup ?? ''
    draft.repeat = source?.repeat ?? 1
    draft.steps = (source?.steps ?? []).map((step) => {
      if (step.type === 'builtin') {
        const target = step.target || (step.action === 'disconnect' ? 'last' : 'active')
        const mode = target === 'active' || target === 'last' ? target : 'custom'
        return {
          ...step,
          targetMode: mode,
          customTarget: mode === 'custom' ? target : ''
        } as EditBuiltinStep
      }
      return { ...step } as EditShellStep | TaskDelayStepLike
    })
  }
)

const stepTypeLabel = (type: string): string =>
  type === 'shell' ? t('palette.stepShell') : type === 'delay' ? t('palette.stepDelay') : t('palette.stepBuiltin')

const addStep = (type: 'shell' | 'delay' | 'builtin'): void => {
  if (type === 'shell') {
    draft.steps.push({ type: 'shell', command: '', shell: 'cmd', encoding: 'utf8', stopOnFail: true } as EditShellStep)
  } else if (type === 'delay') {
    draft.steps.push({ type: 'delay', ms: 500 })
  } else {
    draft.steps.push({
      type: 'builtin', action: 'sendData', targetMode: 'active', customTarget: '', data: '', appendCrlf: true, stopOnFail: true
    } as EditBuiltinStep)
  }
}

const moveStep = (index: number, delta: number): void => {
  const target = index + delta
  if (target < 0 || target >= draft.steps.length) return
  const [step] = draft.steps.splice(index, 1)
  draft.steps.splice(target, 0, step)
}

const save = async (): Promise<void> => {
  const steps: TaskStep[] = draft.steps.map((step) => {
    if (step.type === 'builtin') {
      const builtin: TaskBuiltinStep = {
        type: 'builtin',
        action: step.action,
        target: step.targetMode === 'custom' ? step.customTarget : step.targetMode,
        stopOnFail: step.stopOnFail
      }
      if (step.action === 'sendData') {
        builtin.data = step.data
        builtin.appendCrlf = step.appendCrlf
      }
      if (step.action === 'connect') {
        if (step.connectionId != null && step.connectionId > 0) builtin.connectionId = step.connectionId
        if (step.comName) builtin.comName = step.comName
        if (step.baudRate) builtin.baudRate = step.baudRate
      }
      return builtin
    }
    return { ...step } as TaskStep
  })

  const task: UserTask = {
    id: draft.id || '',
    name: draft.name.trim(),
    group: draft.group.trim() || undefined,
    repeat: draft.repeat,
    steps
  }
  const result = await window.taskApi.save(task)
  if (result.success) {
    if (result.tasks) emit('saved', result.tasks)
    emit('update:modelValue', false)
  }
}
</script>

<style scoped>
.inline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.inline-label {
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.steps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 0;
  font-weight: 600;
}

.add-buttons {
  display: flex;
  gap: 6px;
}

.steps-list {
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-hint {
  color: var(--text-secondary, #888);
  text-align: center;
  padding: 16px 0;
}

.step-card {
  border: 1px solid var(--border-secondary, #404040);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-index {
  font-weight: 700;
  color: var(--text-secondary, #888);
}

.step-ops {
  margin-left: auto;
  display: flex;
}

.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field-label {
  font-size: 12px;
  color: var(--text-secondary, #888);
  white-space: nowrap;
}

.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
}
</style>
