<script setup lang="ts">
import { AlertTriangle, CheckCircle2, CircleAlert, Info, X } from 'lucide-vue-next'
import { dismissGlobalMessage, globalMessage } from '../services/global-message'
</script>

<template>
  <Teleport to="body">
    <Transition name="global-message">
      <div
        v-if="globalMessage"
        :key="globalMessage.id"
        class="global-message"
        :class="`global-message--${globalMessage.type}`"
        :role="globalMessage.type === 'error' ? 'alert' : 'status'"
        aria-live="polite"
      >
        <span class="global-message__icon" aria-hidden="true">
          <CheckCircle2 v-if="globalMessage.type === 'success'" :size="17" />
          <AlertTriangle v-else-if="globalMessage.type === 'warning'" :size="17" />
          <CircleAlert v-else-if="globalMessage.type === 'error'" :size="17" />
          <Info v-else :size="17" />
        </span>
        <span class="global-message__content">{{ globalMessage.text }}</span>
        <button type="button" aria-label="关闭提示" title="关闭" @click="dismissGlobalMessage(globalMessage.id)">
          <X :size="16" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.global-message {
  --message-accent: var(--ui-accent, #315f5a);
  position: fixed;
  z-index: 2400;
  top: 18px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  width: max-content;
  max-width: min(600px, calc(100vw - 32px));
  min-height: 48px;
  padding: 9px 10px 9px 11px;
  color: var(--ui-text, #202624);
  border: 1px solid color-mix(in srgb, var(--message-accent) 18%, var(--ui-border, #d8ddda));
  border-radius: 12px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--message-accent) 5%, var(--ui-surface, #fff)), var(--ui-surface, #fff) 58%);
  box-shadow: 0 18px 48px rgb(20 31 27 / 16%), 0 3px 10px rgb(20 31 27 / 7%);
  backdrop-filter: blur(18px) saturate(1.08);
  transform: translateX(-50%);
}

.global-message__icon {
  flex: 0 0 auto;
  display: grid;
  width: 20px;
  height: 20px;
  color: var(--message-accent);
  border: 0;
  background: transparent;
  place-items: center;
}

.global-message__content {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ui-text, #202624);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: .005em;
}

.global-message--success { --message-accent: var(--ui-success, #287868); }
.global-message--info { --message-accent: var(--ui-accent, #315f5a); }
.global-message--warning { --message-accent: var(--ui-warning, #9a651d); }
.global-message--error { --message-accent: var(--ui-danger, #b64a45); }

.global-message button {
  flex: 0 0 auto;
  display: grid;
  width: 28px;
  height: 28px;
  margin-left: 4px;
  padding: 0;
  place-items: center;
  color: var(--ui-muted, #6b7470);
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.global-message button:hover {
  color: var(--ui-text, #202624);
  background: color-mix(in srgb, var(--ui-text, #202624) 7%, transparent);
}

.global-message-enter-active { transition: opacity 180ms ease, transform 220ms cubic-bezier(.2, .8, .2, 1); }
.global-message-leave-active { transition: opacity 130ms ease, transform 150ms ease; }
.global-message-enter-from { opacity: 0; transform: translate(-50%, -12px) scale(.98); }
.global-message-leave-to { opacity: 0; transform: translate(-50%, -6px) scale(.99); }
</style>
