import type * as Monaco from 'monaco-editor'

let instance: typeof Monaco | undefined

const cancelable = <T,>(promise: Promise<T>): Promise<T> & { cancel(): void } =>
  Object.assign(promise, { cancel() { /* local module loading cannot be cancelled */ } })

const localMonacoLoader = {
  config(config: { monaco?: typeof Monaco }) { if (config.monaco) instance = config.monaco },
  init() {
    if (!instance) return cancelable(Promise.reject(new Error('Local Monaco is not configured')))
    return cancelable(Promise.resolve(instance))
  },
  __getMonacoInstance: () => instance,
}

export default localMonacoLoader
