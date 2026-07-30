/**
 * 类型入口。
 *
 * ## 为什么这里必须用显式的具名重导出，禁止使用 `export * from '...'`
 *
 * 在 `tsconfig.json` 的 `module: "commonjs"` 下，`tsc` 会把 `export * from './foo'`
 * 编译成运行时的 `for...in` 循环，把源模块的属性动态拷贝到 `exports` 对象上；
 * 而 `export { foo } from './bar'` 这种显式写法会被编译成
 * `Object.defineProperty(exports, "foo", { enumerable: true, get: () => bar_1.foo })`
 * 这样的静态字面量赋值。
 *
 * Rollup（以及 Vite 底层用的 CJS 互操作插件）分析 CommonJS 产物时只做**静态分析**、
 * 不会执行代码，因此看不到 `export *` 编译出的运行时循环里动态赋的属性，会把真实存在的
 * 具名导出误判为「不存在」，报出 `"xxx" is not exported by "dist/index.js"`。用
 * `require()` 直接跑运行时验证不出这个问题——运行时本身完全正确，问题只出在静态分析上。
 *
 * 因此本文件必须把 `piniaChromeStoragePlugin.ts` 与 `types.ts` 的每一个顶层导出都显式列出，
 * 不要为了「简洁」改回 `export *`。新增导出时也请同步在这里补上对应的一行。
 */

export {
  DEFAULT_SERIALIZER,
  SerializeError,
  isSerializeError,
  normalize,
  resolveOptions,
  createReporter,
  createWriter,
  createRemoteApplier,
  createStorageChangeHandler,
  createSubscriptionHandler,
  createLoader,
  createLifecycle,
  registerHideFlush,
  piniaChromeStoragePlugin,
} from './piniaChromeStoragePlugin'

export type {
  KeyFilter,
  ResolvedOptions,
  StoragePhase,
  StorageReporter,
  WriterConfig,
  StorageWriter,
  ApplierStore,
  RemoteApplierConfig,
  RemoteApplier,
  StorageChangeHandler,
  StorageChangeHandlerConfig,
  SubscriptionHandler,
  SubscriptionHandlerConfig,
  LoaderConfig,
  LifecycleConfig,
  Lifecycle,
  HideFlushConfig,
} from './piniaChromeStoragePlugin'

// 同时导出 './types'：一是对外暴露选项与辅助类型，二是把其中的
// `declare module 'pinia'` 增强带入类型入口，使使用者能拿到 store 上的扩展属性类型。
// types.ts 中的顶层导出全部是类型（interface / type），因此这里全部用 `export type`。
export type {
  StorageArea,
  StateSerializer,
  StorageQuotaKind,
  StorageErrorContext,
  Normalized,
  PiniaChromeStorageOptions,
  StorageChange,
  StorageChangeEvent,
} from './types'
