<script setup>
// The delete button used in every list: a trash icon that asks nothing by
// itself. The list shows its own "are you sure" line when this is pressed.
defineProps({ label: { type: String, required: true } });
</script>

<template>
  <button class="trash" :aria-label="label" :title="label">
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5" />
    </svg>
  </button>
</template>

<style scoped>
.trash { flex: none; padding: 6px; border-color: transparent; background: transparent; color: var(--muted); line-height: 0; }
.trash:hover { color: var(--bad); border-color: var(--bad); }
</style>
