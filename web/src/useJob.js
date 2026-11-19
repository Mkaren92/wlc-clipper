import { onUnmounted, reactive } from 'vue';
import { api } from './api.js';

const STEP_NAMES = { transcribing: 'Transcribing the speech', rendering: 'Rendering the clip', checking: 'Checking the result' };

/**
 * Follow a background job on the server until it finishes.
 * `state.text` is a line to show while waiting.
 */
export function useJob() {
  const state = reactive({ running: false, text: '', error: '' });
  let timer = null;

  /** @returns {Promise<any>} the job's result; rejects if the job fails */
  function follow(job) {
    state.running = true;
    state.error = '';
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const look = async () => {
        try {
          const now = await api.job(job.id);
          const seconds = Math.round((Date.now() - started) / 1000);
          const what = now.status === 'queued' ? 'Waiting for another clip to finish' : STEP_NAMES[now.step] ?? 'Starting';
          state.text = `${what}… ${seconds} s`;
          if (now.status === 'done') return finish(() => resolve(now.result));
          if (now.status === 'failed') return finish(() => fail(now.error, reject));
          timer = setTimeout(look, 700);
        } catch (error) {
          finish(() => fail(error.message, reject));
        }
      };
      look();
    });
  }

  function fail(message, reject) {
    state.error = message;
    reject(new Error(message));
  }

  function finish(then) {
    state.running = false;
    state.text = '';
    then();
  }

  onUnmounted(() => clearTimeout(timer));
  return { state, follow };
}
