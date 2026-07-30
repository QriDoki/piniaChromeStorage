/**
 * T1 / T2：远端应用不触发写回（任务 14.3）
 *
 * **属性 1：远端应用不触发写回**
 * *对于任意* store 状态与任意远端快照，把该远端快照应用到 store 的过程中不产生任何
 * `chrome.storage.set` 调用。
 *
 * **Validates: Requirements 1.1, 1.5, 10.4**
 *
 * ## 为什么走真实 pinia 而不是直接测 `createRemoteApplier`
 *
 * 这两条测试要验证的恰恰是「插件 + pinia」的接缝：`applyingRemote` 守卫能否覆盖 `$patch` 同步
 * 触发订阅的那个窗口（需求 1.1）、`$patch` 抛错时守卫是否真的复位（需求 1.5）。直接构造应用器
 * 并传一个假 store 会把这个接缝整个绕开——假 store 的 `$patch` 不会触发任何订阅，于是「零写入」
 * 这个断言在插件完全不工作时也成立。因此这里一律用 `createPinia()` + `pinia.use(plugin)` +
 * `defineStore`，事件从 `chrome.storage.onChanged` 进、断言落在 `set` 调用记录上。
 *
 * ## 两个时序前提
 *
 * 1. 插件给 `$subscribe` 传的是 `{ flush: 'sync' }`，因此正常 mutation 会**同步**触发订阅回调。
 * 2. `$patch` 期间 pinia 会关掉订阅通知，之后才恢复。为了不让「本地变更触发写出」这类断言
 *    落进恢复窗口里而得到假阴性，所有本地 mutation 前都先 `await nextTick()`。
 *
 * mock 内部不使用定时器（只用微任务），所以 `jest.useFakeTimers()` 推进的只有插件自己的
 * `waitTimer` / `maxTimer`，时间点是可推理的。
 */

import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick } from 'vue'

import { piniaChromeStoragePlugin } from '../src/piniaChromeStoragePlugin'
import type { StorageErrorContext } from '../src/types'

import { createChromeMock, installChromeMock, uninstallChromeMock } from './chromeMock'
import type { ChromeMock, MockControl } from './chromeMock'

const PREFIX = 'test-'
const STORE_ID = 'remote-apply'
const STORE_KEY = `${PREFIX}${STORE_ID}`

/** local 区域的生效节流参数（`AREA_THROTTLE_DEFAULTS.local`），推进定时器时按它取值 */
const LOCAL_DEBOUNCE = 150
const LOCAL_MAX_WAIT = 500
/** 推进到「任何待写内容都必须已经写出」之后 */
const PAST_MAX_WAIT = LOCAL_MAX_WAIT + 50

interface TestState {
  count: number
  name: string
  nested: { flag: boolean }
}

const useTestStore = defineStore(STORE_ID, {
  state: (): TestState => ({
    count: 0,
    name: 'local',
    nested: { flag: false },
  }),
})

let mock: ChromeMock
let control: MockControl

/**
 * 每个测试一份全新的 pinia + 插件实例；插件工厂在装好 mock 之后才调用（它会取走 `chrome.storage[area]`）。
 *
 * `app.use(pinia)` 这一步不能省：pinia v3 的 `use()` 在 pinia 尚未被安装到某个 app 上时，
 * 只把插件塞进待安装队列（`toBeInstalled`），要等 `app.use(pinia)` 才真正注册。
 * 少了它，`useStore()` 创建出来的 store 上根本不会有 `$storageReady`，测试会静默地什么都没验证。
 */
function createStore(options: { onError?: (error: unknown, context: StorageErrorContext) => void } = {}) {
  const pinia = createPinia()
  createApp({}).use(pinia)
  pinia.use(
    piniaChromeStoragePlugin({
      storage: 'local',
      prefix: PREFIX,
      onError: options.onError,
    })
  )
  return useTestStore(pinia)
}

/** 让插件的定时器与 promise chain 都跑到静止 */
async function settleAll(ms = PAST_MAX_WAIT) {
  await control.settle()
  await jest.advanceTimersByTimeAsync(ms)
  await control.settle()
}

beforeEach(() => {
  jest.useFakeTimers()
  mock = installChromeMock(createChromeMock())
  control = mock.control
})

afterEach(() => {
  control.removeAllListeners()
  uninstallChromeMock()
  jest.useRealTimers()
})

describe('属性 1：远端应用不触发写回', () => {
  it('T1：应用远端快照期间 set 调用次数为 0，且远端值确实被应用', async () => {
    // 预置初值，让首次加载走「有值且无本地修改 → 应用远端值」这条路径，
    // 基线因此等于「应用后的本地快照」，setup 阶段不应产生任何写出
    control.seed('local', { [STORE_KEY]: { count: 1, name: 'seeded', nested: { flag: false } } })

    const store = createStore()
    await store.$storageReady
    expect(store.count).toBe(1)
    expect(store.name).toBe('seeded')

    // 增量断言的起点：首次加载阶段的写出（如果有）不计入
    const mark = control.mark()

    // 模拟另一个上下文的写入：`emitWrite` 会真的落盘并广播，但不记入 setCalls
    control.emitWrite('local', { [STORE_KEY]: { count: 42, name: 'remote', nested: { flag: true } } })
    await settleAll()

    // 断言 1：整个应用过程（含之后的节流窗口与 maxWait 上界）没有任何一次 set
    expect(control.setCountSince(mark)).toBe(0)

    // 断言 2：远端值确实被应用了 —— 没有这一条，插件完全不工作时断言 1 也会通过
    expect(store.count).toBe(42)
    expect(store.name).toBe('remote')
    expect(store.nested).toEqual({ flag: true })

    // 需求 10.4 的轻量断言：应用之后的一次本地变更，写出的快照必须带着远端值，
    // 说明 `adopt` 的基线取自「应用后的本地快照」而不是别的东西。
    // （完整的「不被旧快照覆盖」验证在 T4 / T5，这里只确认基线方向正确）
    await nextTick()
    store.name = 'local-after-remote'
    await settleAll()

    const written = control.setCallsSince(mark, 'local')
    expect(written).toHaveLength(1)
    expect(written[0].items[STORE_KEY]).toEqual({
      count: 42,
      name: 'local-after-remote',
      nested: { flag: true },
    })
  })

  it('T2：$patch 在应用远端值时抛错后守卫仍复位，下一次远端变更可正常处理', async () => {
    control.seed('local', { [STORE_KEY]: { count: 1, name: 'seeded', nested: { flag: false } } })

    const errors: Array<{ error: unknown; context: StorageErrorContext }> = []
    const store = createStore({ onError: (error, context) => errors.push({ error, context }) })
    await store.$storageReady
    errors.length = 0

    const mark = control.mark()

    /**
     * 让 `$patch` 抛错的手段：临时替换 store 上的 `$patch`。
     *
     * 应用器持有的是 `store` 引用、每次都读 `store.$patch` 再调用，因此替换 store 上的方法一定生效。
     * 另一条思路是「在 state 上定义一个 setter 抛异常的属性」，但那条路会污染读方向——
     * `normalize()` 会遍历同一份 state 并读到那个属性，`readCurrent()` 也会跟着抛错，
     * 于是「守卫是否复位」和「快照是否算得出来」两件事混在一起，测不出想测的东西。
     * 替换 `$patch` 把故障精确地限制在「应用远端值」这一步，是这里最可靠的注入点。
     */
    const originalPatch = store.$patch
    const patchError = new Error('boom: $patch failed while applying remote snapshot')
    ;(store as any).$patch = () => {
      throw patchError
    }

    control.emitWrite('local', { [STORE_KEY]: { count: 7, name: 'remote-1', nested: { flag: true } } })
    await settleAll()

    // 断言 1：以 phase: 'apply' 上报（需求 1.5）
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toBe(patchError)
    expect(errors[0].context.phase).toBe('apply')
    expect(errors[0].context.storeId).toBe(STORE_ID)
    expect(errors[0].context.storeKey).toBe(STORE_KEY)
    expect(errors[0].context.area).toBe('local')

    // $patch 抛错 ⇒ 状态没被改动
    expect(store.count).toBe(1)

    // 恢复正常的 $patch
    ;(store as any).$patch = originalPatch

    // 断言 2：守卫已复位 —— 下一次远端变更能被正常应用。
    // 若守卫卡在 true，applyRemote 仍会执行，但它引发的 mutation 会被永久当成「来自远端」，
    // 更直接的证据见断言 3
    control.emitWrite('local', { [STORE_KEY]: { count: 8, name: 'remote-2', nested: { flag: true } } })
    await settleAll()

    expect(store.count).toBe(8)
    expect(store.name).toBe('remote-2')

    // 到这里为止全是「应用远端值」，不该有任何写出
    expect(control.setCountSince(mark)).toBe(0)

    // 断言 3：守卫没有卡死的最强证据 —— 抛错之后的本地 mutation 仍然能写出。
    // 守卫若卡在 true，订阅回调会被静默丢弃，这次 mutation 永远不会产生 set
    await nextTick()
    store.count = 99

    await control.settle()
    await jest.advanceTimersByTimeAsync(LOCAL_DEBOUNCE + 10)
    await control.settle()

    const written = control.setCallsSince(mark, 'local')
    expect(written).toHaveLength(1)
    expect(written[0].items[STORE_KEY]).toEqual({ count: 99, name: 'remote-2', nested: { flag: true } })
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 99, name: 'remote-2', nested: { flag: true } })
  })
})
