<script setup>
// The delete button used in every list: a trash icon that asks nothing by
// itself. The list shows its own "are you sure" line when this is pressed.
defineProps({ label: { type: String, required: true } });
</script>

<template>
  <button class="trash quiet icon-only" :aria-label="label" :title="label">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
    </svg>
  </button>
</template>

<style scoped>
.trash { flex: none; min-height: 32px; min-width: 32px; padding: 6px; color: var(--muted); }
.trash:hover:not(:disabled) { color: var(--bad); border-color: var(--bad); background: var(--bad-bg); }
</style>
