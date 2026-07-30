/**
 * T8：清理幂等且彻底（任务 14.7）
 *
 * **属性 10：清理幂等且彻底**
 * *对于任意* 次数的 `$stopStorageSync()` / scope dispose 调用组合，调用后不存在残留的
 * `onChanged` 监听器与活动定时器，且重复调用不抛错。
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 *
 * ## 被测缺陷的原貌
 *
 * 旧实现从插件里 `return () => chrome.storage.onChanged.removeListener(...)`。但 Pinia 应用插件时
 * 执行的是 `assign(store, scope.run(() => extender(...)))`，即把返回值当作「要挂到 store 上的
 * 属性对象」；`Object.assign(store, fn)` 只拷贝源对象的**自有可枚举属性**，而函数没有这类属性，
 * 于是那个 `removeListener` 从未被调用——监听器永久泄漏，store 每次重建都会再叠加一个。
 *
 * 新实现有两个清理入口，都走同一个幂等的 `cleanup()`：`onScopeDispose(cleanup)`（自动）与
 * 挂到 store 上的 `$stopStorageSync()`（手动）。本文件对两条入口各测一次。
 *
 * ## 为什么必须先做「清理前」的基线断言
 *
 * 本测试的主体断言全是「清理后**什么都不发生**」形态的——监听器为 0、没有 `set`、state 不变。
 * 这类断言在「插件根本没在工作」时同样成立，因此它们本身没有任何鉴别力。所以每个测试都先证明
 * 清理**之前**三条通路确实是活的：监听器已注册、本地 mutation 确实写出、远端事件确实改到 state。
 * 有了这个基线，后面的「什么都不发生」才真的指向清理生效。
 *
 * ## 两个 pinia 时序前提
 *
 * 1. 插件给 `$subscribe` 传 `{ flush: 'sync' }`，正常 mutation 会**同步**触发订阅回调。
 * 2. `$patch` 期间 pinia 关掉订阅通知，需经一个 `nextTick` 才恢复 `isListening`。因此紧接
 *    `$patch`（含首次加载的应用、远端应用）之后的直接赋值不会触发 `$subscribe`。所有本地
 *    mutation 之前一律先 `await nextTick()`，否则「清理前能写出」这条基线会得到假阴性，
 *    反而让人误以为清理已经生效。
 *
 * mock 内部不使用定时器（只排微任务），所以 `jest.advanceTimersByTimeAsync()` 推进的只有插件
 * 自己的 `waitTimer` / `maxTimer` / 退避定时器，时间点是可推理的。
 */

import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick } from 'vue'

import { piniaChromeStoragePlugin } from '../src/piniaChromeStoragePlugin'

import { createChromeMock, installChromeMock, uninstallChromeMock } from './chromeMock'
import type { ChromeMock, MockControl } from './chromeMock'

const PREFIX = 'test-'
const STORE_ID = 'cleanup'
const STORE_KEY = `${PREFIX}${STORE_ID}`

/**
 * local 区域的生效写出上界（`AREA_THROTTLE_DEFAULTS.local.maxWait`）。
 * 对应的 `debounce` 是 150ms，本文件不单独推进到那个点位，一律推到 `maxWait` 之后。
 */
const LOCAL_MAX_WAIT = 500
/** 推进到「任何待写内容都必须已经写出」之后 */
const PAST_MAX_WAIT = LOCAL_MAX_WAIT + 50
/**
 * 远超 `maxWait` 与最长退避档（16s）的推进量。
 *
 * 「无活动定时器」这一条不做直接断言，而是取它的可观测等价物：在**有待写内容已排期但尚未写出**
 * 的状态下清理，然后把时间推得比任何可能的定时器都长，若期间没有任何 `set`，就等价于
 * 「`waitTimer` / `maxTimer` / `retryTimer` 都已被清除」。
 * 直接断言 `jest.getTimerCount()` 的问题是它统计的是**全局**假定时器，pinia / vue 内部若排了
 * 定时器就会把这个数字污染成非 0，断言会变成对第三方实现细节的耦合。
 */
const FAR_BEYOND_ANY_TIMER = 60_000

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
 * 每个测试一份全新的 pinia + 插件实例。
 *
 * 两处不能省的细节：
 * 1. 插件工厂必须在装好 mock 之后调用——它在工厂阶段就会取走 `chrome.storage[area]` 并做环境检查。
 * 2. **必须把 pinia 装进一个 app**（`app.use(pinia)`）。`pinia.use(plugin)` 在 pinia 尚未 install
 *    到 app 上时只把插件推进内部的 `toBeInstalled` 队列，真正搬进 `_p`（即「创建 store 时会执行的
 *    插件列表」）发生在 `install(app)` 里。少了这一步，store 能正常创建、`await store.$storageReady`
 *    也不会报错（`await undefined` 直接通过），但插件根本没运行过——监听器为 0、`get` 一次都没调，
 *    整个测试变成对「什么都没装」的断言。`createApp({})` 不需要 mount，因此在 node 环境下可用。
 */
function createStore() {
  const pinia = createPinia()
  pinia.use(piniaChromeStoragePlugin({ storage: 'local', prefix: PREFIX }))
  createApp({}).use(pinia)
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
  // 兜底：即使某个测试因断言失败提前退出，也不把监听器留给下一个测试
  control.removeAllListeners()
  uninstallChromeMock()
  jest.useRealTimers()
})

describe('属性 10：清理幂等且彻底', () => {
  it('T8：$stopStorageSync() 连续调用 3 次不抛错，监听器归零，后续 mutation 不写、后续远端事件不改 state', async () => {
    const store = createStore()
    await store.$storageReady

    // ---------- 基线：证明清理之前三条通路都是活的 ----------

    // 基线 1：`onChanged` 监听器已注册，且只有一个
    expect(control.listenerCount).toBe(1)

    // 基线 2：本地 mutation 确实写出。放在 `nextTick` 之后，避开首次加载 `$patch` 的订阅静默窗口
    await nextTick()
    const markBeforeBaselineWrite = control.mark()
    store.count = 1
    await settleAll()

    const baselineWrites = control.setCallsSince(markBeforeBaselineWrite, 'local')
    expect(baselineWrites.length).toBeGreaterThan(0)
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 1, name: 'local', nested: { flag: false } })

    // 基线 3：远端事件确实改到 state
    control.emitWrite('local', { [STORE_KEY]: { count: 2, name: 'remote', nested: { flag: true } } })
    await settleAll()
    expect(store.count).toBe(2)
    expect(store.name).toBe('remote')

    // ---------- 幂等：连续调用 3 次不抛错 ----------

    expect(() => {
      store.$stopStorageSync()
      store.$stopStorageSync()
      store.$stopStorageSync()
    }).not.toThrow()

    // ---------- 监听器归零（需求 5.1） ----------

    expect(control.listenerCount).toBe(0)

    // ---------- 后续 mutation 不产生 set（需求 5.4） ----------

    const markAfterCleanup = control.mark()
    await nextTick()
    store.count = 100
    store.name = 'after-cleanup'
    // 推进到远超 maxWait，确认既没有立即写、也没有延迟写
    await settleAll(FAR_BEYOND_ANY_TIMER)

    expect(control.setCountSince(markAfterCleanup)).toBe(0)
    // storage 中仍是清理前那次远端写入的内容，本地的两次 mutation 没有落盘
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 2, name: 'remote', nested: { flag: true } })

    // ---------- 后续远端事件不修改 state（需求 5.4） ----------

    // 快照取在上面那两次本地 mutation **之后**：本地赋值当然会改 state（那是使用者自己的行为，
    // 插件管不着也不该管），这里要断言的是「远端事件不再引起改动」
    const snapshot = { count: store.count, name: store.name, nested: { ...store.nested } }

    control.emit('local', {
      [STORE_KEY]: { newValue: { count: -999, name: 'should-never-be-applied', nested: { flag: true } } },
    })
    await control.settle()

    expect(store.count).toBe(snapshot.count)
    expect(store.name).toBe(snapshot.name)
    expect(store.nested).toEqual(snapshot.nested)

    // 监听器已被移除，所以这个事件根本到不了插件；这同时说明「双保险」中的 `removeListener`
    // 那一层确实生效（另一层是接线件里的 `isDisposed()` 守卫）
    expect(control.listenerCount).toBe(0)
  })

  it('T8：清理时存在已排期未写出的内容 → 定时器已被清除，之后不会再写出', async () => {
    const store = createStore()
    await store.$storageReady

    expect(control.listenerCount).toBe(1)

    // 制造「有待写内容、已排期、尚未写出」的状态：mutation 之后**不推进定时器**。
    // local 的 debounce 是 150ms，因此此刻 waitTimer 与 maxTimer 都挂着
    await nextTick()
    const mark = control.mark()
    store.count = 7
    // 只跑微任务，不推进时间 —— 确认此刻确实还没写出（否则下面的断言就不是在测定时器清除）
    await control.settle()
    expect(control.setCountSince(mark)).toBe(0)

    // 补充性的直接观察：此刻确实挂着定时器（`waitTimer` + `maxTimer`）。
    // 这一条只作为「下面的等价断言不是在空转」的证据，主断言仍是「推进很久也不写」——
    // `getTimerCount()` 统计的是全局假定时器，若 pinia / vue 将来在某条路径上排了定时器，
    // 这个数字就会被污染，因此不把它当作唯一依据
    expect(jest.getTimerCount()).toBeGreaterThan(0)

    store.$stopStorageSync()

    expect(jest.getTimerCount()).toBe(0)

    // 把时间推得比 maxWait（500ms）与最长退避档（16s）都长。没有任何 set ⟺ 三个定时器都已清除
    await jest.advanceTimersByTimeAsync(FAR_BEYOND_ANY_TIMER)
    await control.settle()

    expect(control.setCountSince(mark)).toBe(0)
    // storage 中始终没出现过这个键：那份待写内容被彻底作废了
    expect(control.hasValue('local', STORE_KEY)).toBe(false)
    expect(control.listenerCount).toBe(0)
  })

  it('自动清理路径：store.$dispose() 停掉 store 的 effect scope，onScopeDispose 触发同一个 cleanup', async () => {
    const store = createStore()
    await store.$storageReady

    // 基线 1：监听器已注册
    expect(control.listenerCount).toBe(1)

    // 基线 2：本地 mutation 确实写出
    await nextTick()
    const markBeforeBaselineWrite = control.mark()
    store.count = 3
    await settleAll()
    expect(control.setCountSince(markBeforeBaselineWrite, 'local')).toBeGreaterThan(0)

    // 再排一次待写内容，用来顺带验证自动清理同样清掉了定时器
    await nextTick()
    store.count = 4
    await control.settle()

    const mark = control.mark()

    /**
     * `store.$dispose()` 是这里唯一可靠的自动清理触发点。
     *
     * 用外层 `effectScope()` 包住 store 的创建**不起作用**：pinia 的 store scope 是
     * `pinia._e.run(() => effectScope())` 创建的，即挂在 pinia 实例自己的 scope 下，
     * 而不是调用 `useStore()` 时的活动 scope。因此外层 scope 停止时 store 的 scope 不受影响，
     * `onScopeDispose(cleanup)` 也不会触发。
     * `$dispose()` 内部第一件事就是 `scope.stop()`，正是插件注册 `onScopeDispose` 的那个 scope。
     */
    store.$dispose()

    // 自动清理与手动入口效果一致：监听器归零
    expect(control.listenerCount).toBe(0)

    // 定时器也被清掉了：刚才排期的那次写出不会再发生
    await jest.advanceTimersByTimeAsync(FAR_BEYOND_ANY_TIMER)
    await control.settle()
    expect(control.setCountSince(mark)).toBe(0)
    // storage 中仍是 count: 3，count: 4 那次排期被作废
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 3, name: 'local', nested: { flag: false } })

    // 远端事件同样不再改 state
    const before = { count: store.count, name: store.name }
    control.emit('local', {
      [STORE_KEY]: { newValue: { count: -1, name: 'never', nested: { flag: true } } },
    })
    await control.settle()
    expect(store.count).toBe(before.count)
    expect(store.name).toBe(before.name)

    // 自动清理之后再手动调用 `$stopStorageSync()` 仍然安全（需求 5.3 的组合调用形态）
    expect(() => {
      store.$stopStorageSync()
      store.$stopStorageSync()
    }).not.toThrow()
    expect(control.listenerCount).toBe(0)
  })
})
