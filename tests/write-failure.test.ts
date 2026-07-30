/**
 * T6、T7：写失败不被当作已同步（设计文档「属性 8」）。
 *
 * **Validates: Requirements 4.2, 4.3, 4.5**
 *
 * 被测机制集中在 `createWriter().write()` 的 `.catch()` 里，一次 `set` reject 会做三件事：
 * 1. `lastSynced = null` —— 失败 ≠ 已同步。基线置为未知，使**同一份内容**在下一次写出时
 *    不被内容级去重跳过（T7 的验证点，需求 4.2）；
 * 2. `report(error, 'write')` —— 以 `phase: 'write'` 上报（T6 的断言点，需求 4.5）；
 * 3. `scheduleRetry()` —— 按 1s / 2s / 4s / 8s / 16s 指数退避重排，最多 5 次，
 *    且用独立的 `retryTimer` 句柄（需求 4.3）。
 *
 * ## 时序约定
 *
 * 全程 `jest.useFakeTimers()`：时间控制权在被测代码的定时器上，用
 * `jest.advanceTimersByTimeAsync(ms)` 推进。`tests/chromeMock.ts` 内部只用微任务、不排定时器，
 * 因此「推进 100ms」这个动作只驱动插件自己的节流 / 退避定时器，断言点是确定的。
 *
 * 每次推进之后再 `await control.settle()`，把 mock 的落盘与广播微任务跑完，
 * 保证断言看到的是稳定状态。
 */

import { createPinia, defineStore, setActivePinia } from 'pinia'
import { createApp } from 'vue'

import { piniaChromeStoragePlugin } from '../src/piniaChromeStoragePlugin'
import type { StorageErrorContext } from '../src/types'

import type { ChromeMock, MockControl } from './chromeMock'
import { createChromeMock, installChromeMock, uninstallChromeMock } from './chromeMock'

/** 显式给出节流参数，让每一次推进的时间点都可精确断言，不依赖按区域的默认值 */
const DEBOUNCE = 100
const MAX_WAIT = 500
const PREFIX = 'wf-'

/** 被测 store 的 state 形状 */
interface CounterState {
  count: number
  label: string
}

let mock: ChromeMock
let control: MockControl

/**
 * 装配一份「真实 pinia + 真实 store + 插件」的测试夹具。
 *
 * 每个测试用独立的 `id`，这样 storeKey 互不相同，即使 mock 之间有残留也不会串味。
 *
 * **必须把 pinia 安装到一个 app 上**（`app.use(pinia)`）。Pinia 的 `pinia.use(plugin)` 在
 * 尚未 install 到 app 时只把插件排进 `toBeInstalled` 队列，真正下发要等 `install()` 执行；
 * 少了 `app.use(pinia)` 这一步，store 会被正常创建但**插件从未运行**——既没有 `$storageReady`
 * 也没有任何监听器，所有断言都会以「没发生任何写入」的形式假阴性通过/失败。
 * 不需要 `mount`，一个 `render: () => null` 的空组件足够。
 */
function setup(id: string) {
  const onError = jest.fn<void, [unknown, StorageErrorContext]>()

  const app = createApp({ render: () => null })
  const pinia = createPinia()
  pinia.use(
    piniaChromeStoragePlugin({
      storage: 'local',
      prefix: PREFIX,
      debounce: DEBOUNCE,
      maxWait: MAX_WAIT,
      onError,
    })
  )
  app.use(pinia)
  setActivePinia(pinia)

  const useCounter = defineStore(id, {
    state: (): CounterState => ({ count: 0, label: 'init' }),
  })

  const store = useCounter()

  return { store, onError, storeKey: `${PREFIX}${id}` }
}

beforeEach(() => {
  mock = createChromeMock()
  installChromeMock(mock)
  control = mock.control
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  uninstallChromeMock()
})

describe('属性 8：写失败不被当作已同步', () => {
  /**
   * T6（前半）：写失败以 `phase: 'write'` 上报，且退避到点后重新发起写入。
   *
   * **Validates: Requirements 4.2, 4.3, 4.5**
   */
  it('T6：set reject 时以 phase "write" 上报，第一档退避（1s）到点后重新写出', async () => {
    const { store, onError, storeKey } = setup('t6-report-and-retry')

    // storage 为空 → 加载不应用任何值、不产生写入；此后的 set 全部来自本测试的 mutation
    await store.$storageReady
    await control.settle()
    expect(control.setCallCount).toBe(0)

    const mark = control.mark()
    control.failNextSet(1, new Error('boom'))

    store.count = 1

    // 静默期到点 → 发起第一次写入 → 被注入的失败拒绝
    await jest.advanceTimersByTimeAsync(DEBOUNCE)
    await control.settle()

    // 断言 1：确实发起了一次 set，且该次调用被拒绝（未落盘）
    const failed = control.setCallsSince(mark)
    expect(failed).toHaveLength(1)
    expect(failed[0].rejected).toBe(true)
    expect(failed[0].area).toBe('local')
    expect(control.hasValue('local', storeKey)).toBe(false)

    // 断言 2：onError 被调用一次，phase 为 'write'
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, context] = onError.mock.calls[0]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('boom')
    expect(context.phase).toBe('write')
    expect(context.storeId).toBe('t6-report-and-retry')
    expect(context.storeKey).toBe(storeKey)
    expect(context.area).toBe('local')

    // 失败注入已用完，下一次 set 会成功
    expect(control.pendingSetFailures).toBe(0)

    // 断言 3：退避第一档为 1000ms —— 到点前不重试
    await jest.advanceTimersByTimeAsync(999)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(1)

    // 断言 4：到点后重新发起写入，且内容正确落盘
    await jest.advanceTimersByTimeAsync(1)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(2)
    expect(control.readValue('local', storeKey)).toEqual({ count: 1, label: 'init' })

    // 重试成功后不应再有额外写入
    await jest.advanceTimersByTimeAsync(20_000)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(2)

    store.$stopStorageSync()
  })

  /**
   * T6（后半，加强）：验证退避**档位**而不只是「有重试」。
   *
   * 连续注入 3 次失败，逐档断言「推进不足时不重试、到点才重试」，
   * 覆盖 1000 / 2000 / 4000 三档，直接对应需求 4.3 的指数退避序列。
   *
   * **Validates: Requirements 4.3**
   */
  it('T6：连续失败时退避档位依次为 1s / 2s / 4s，未到点不重试', async () => {
    const { store, onError, storeKey } = setup('t6-backoff-tiers')

    await store.$storageReady
    await control.settle()

    const mark = control.mark()
    // 前 3 次写入全部失败，第 4 次（第三档退避到点后的那次）成功
    control.failNextSet(3, new Error('boom'))

    store.count = 7

    // 第 1 次写入：静默期到点后发起，失败
    await jest.advanceTimersByTimeAsync(DEBOUNCE)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(1)

    // 第一档 1000ms
    await jest.advanceTimersByTimeAsync(999)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(1)
    await jest.advanceTimersByTimeAsync(1)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(2)

    // 第二档 2000ms
    await jest.advanceTimersByTimeAsync(1999)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(2)
    await jest.advanceTimersByTimeAsync(1)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(3)

    // 第三档 4000ms
    await jest.advanceTimersByTimeAsync(3999)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(3)
    await jest.advanceTimersByTimeAsync(1)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(4)

    // 前 3 次失败各上报一次；第 4 次成功后不再上报
    expect(onError).toHaveBeenCalledTimes(3)
    for (const [, context] of onError.mock.calls) {
      expect(context.phase).toBe('write')
    }

    // 每一次失败的 set 都真的没落盘，最后成功的那次才写进去
    const calls = control.setCallsSince(mark)
    expect(calls.map((call) => call.rejected)).toEqual([true, true, true, false])
    expect(control.readValue('local', storeKey)).toEqual({ count: 7, label: 'init' })

    store.$stopStorageSync()
  })

  /**
   * 顺带覆盖需求 4.7：字节配额类错误的可操作提示。
   *
   * 这一条不属于属性 8，但与写失败上报同一条代码路径（`createReporter` 在 `phase === 'write'`
   * 时判定 `quotaKind` 并附 `hint`），在这里顺手断言成本极低。
   *
   * **Validates: Requirements 4.5**
   */
  it('T6：配额类写失败在上报中附带 quotaKind 与可操作提示', async () => {
    const { store, onError } = setup('t6-quota-hint')

    await store.$storageReady
    await control.settle()

    control.failNextSet(1, new Error('QUOTA_BYTES_PER_ITEM quota exceeded'))

    store.count = 2
    await jest.advanceTimersByTimeAsync(DEBOUNCE)
    await control.settle()

    expect(onError).toHaveBeenCalledTimes(1)
    const [, context] = onError.mock.calls[0]
    expect(context.phase).toBe('write')
    expect(context.quotaKind).toBe('bytes')
    expect(typeof context.hint).toBe('string')
    expect((context.hint as string).length).toBeGreaterThan(0)

    store.$stopStorageSync()
  })

  /**
   * T7：写失败后同一份内容不被内容级去重跳过。
   *
   * 去重规则是「当前内容的 json 等于 `lastSynced` 就跳过 `set`」。写成功后 `lastSynced` 等于
   * 该内容，因此再 flush 同样内容不会写；而写失败后 `lastSynced` 被置 `null`，
   * 所以同一份内容必须能被重新写出。
   *
   * 第二段是**对照断言**：写成功之后、state 未变时再 flush 一次不产生 `set`。
   * 有了它，第一段才能说明「重写是因为基线被置空，而不是因为去重坏了」。
   *
   * **Validates: Requirements 4.2**
   */
  it('T7：失败后同内容会被重新写出；成功后同内容被去重跳过', async () => {
    const { store, storeKey } = setup('t7-no-false-dedupe')

    await store.$storageReady
    await control.settle()

    control.failNextSet(1, new Error('boom'))

    store.count = 42
    store.label = 'dirty'

    await jest.advanceTimersByTimeAsync(DEBOUNCE)
    await control.settle()

    const failedCall = control.lastSetCall('local')
    expect(failedCall).toBeDefined()
    expect(failedCall!.rejected).toBe(true)
    expect(failedCall!.items).toEqual({ [storeKey]: { count: 42, label: 'dirty' } })

    // ---- 第一段：state 未变，flush 仍然重新写出同一份内容 ----
    const markAfterFailure = control.mark()
    await store.$flushStorage()
    await control.settle()

    const retried = control.setCallsSince(markAfterFailure, 'local')
    expect(retried).toHaveLength(1)
    expect(retried[0].rejected).toBe(false)
    // 内容与失败那次完全相同 —— 去重没有误跳过
    expect(retried[0].items).toEqual(failedCall!.items)
    expect(control.readValue('local', storeKey)).toEqual({ count: 42, label: 'dirty' })

    // ---- 第二段（对照）：写成功后 state 未变，flush 不产生任何 set ----
    const markAfterSuccess = control.mark()
    await store.$flushStorage()
    await control.settle()
    expect(control.setCountSince(markAfterSuccess)).toBe(0)

    // 退避重试也不该再补一次写：上面的 flush 已把内容写出并清掉了 retryTimer
    await jest.advanceTimersByTimeAsync(20_000)
    await control.settle()
    expect(control.setCountSince(markAfterSuccess)).toBe(0)

    store.$stopStorageSync()
  })
})
