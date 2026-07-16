<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowLeft, CheckCircle2, Code2, Download, RefreshCw } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { getIdeIntegrationStatus, installIdePlugin, type BundledIdePlugin, type IdeIntegrationStatus, type IdeTarget } from '../services/desktop-library'

const router = useRouter()
const status = ref<IdeIntegrationStatus>()
const loading = ref(true)
const busyTarget = ref('')
const error = ref('')
const message = ref('')
const availableCount = computed(() => status.value?.plugins.filter(plugin => plugin.available).length ?? 0)

function pluginFor(target: IdeTarget): BundledIdePlugin | undefined {
  return status.value?.plugins.find(plugin => plugin.kind === target.kind)
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    status.value = await getIdeIntegrationStatus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function install(target: IdeTarget) {
  const plugin = pluginFor(target)
  if (!plugin?.available) return
  busyTarget.value = target.id
  error.value = ''
  message.value = ''
  try {
    const result = await installIdePlugin(target.id, plugin.id)
    message.value = `${result.plugin} 已安装到 ${result.target}。${result.message}`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busyTarget.value = ''
  }
}

onMounted(refresh)
</script>

<template>
  <section class="workspace-view ide-integration-view">
    <header class="workspace-header">
      <div><p>IDE INTEGRATION</p><h1>IDE 插件</h1></div>
      <button type="button" class="icon-button" title="重新检测 IDE" :disabled="loading" @click="refresh"><RefreshCw :size="18" /></button>
    </header>
    <button type="button" class="text-command" @click="router.push('/tools')"><ArrowLeft :size="16" />返回工具库</button>
    <div v-if="loading" class="view-status">正在检测本机 IDE 和随包插件...</div>
    <div v-else-if="error" class="inline-error">{{ error }}</div>
    <template v-else-if="status">
      <section class="ide-plugin-summary"><Code2 :size="20" /><div><strong>随桌面版提供的插件</strong><span>{{ availableCount }} / {{ status.plugins.length }} 个插件包可用</span></div></section>
      <div v-if="!status.targets.length" class="empty-library"><Code2 :size="32" /><h2>未检测到支持的 IDE</h2></div>
      <div v-else class="ide-target-list">
        <article v-for="target in status.targets" :key="target.id">
          <span class="ide-target-icon"><Code2 :size="20" /></span>
          <div><strong>{{ target.label }}</strong><small>{{ target.path }}</small><span v-if="pluginFor(target)">插件 {{ pluginFor(target)?.version }} · {{ pluginFor(target)?.available ? '已随桌面版提供' : '安装包缺少插件产物' }}</span></div>
          <button type="button" class="primary-command" :disabled="busyTarget === target.id || !pluginFor(target)?.available" @click="install(target)"><Download :size="16" />{{ busyTarget === target.id ? '正在安装' : '安装' }}</button>
        </article>
      </div>
      <p v-if="message" class="settings-message"><CheckCircle2 :size="15" />{{ message }}</p>
      <p v-if="error" class="inline-error">{{ error }}</p>
    </template>
  </section>
</template>
