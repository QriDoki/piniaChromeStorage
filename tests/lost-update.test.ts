/**
 * T4 / T5：**远端更新不被旧快照覆盖**（设计文档「正确性属性 4」）。
 *
 * 这是本次加固要消灭的最严重缺陷的回归测试。改造前的实现在 mutation 发生的那一刻就把 state
 * 深拷贝进模块级的 `pendingStorageUpdate`，50ms 后才写出，于是存在这样一条丢更新时序：
 *
 * ```
 * t=0    本地改 state  → pending = 快照A（旧），启动定时器
 * t=20   另一个上下文的 onChanged 到达 → 应用到 state，订阅回调被跳过
 * t=50   定时器触发    → 把快照A（旧）写进 storage，并广播回所有上下文
 * ```
 *
 * 远端在 t=20 写入的新值被 t=50 的旧快照静默覆盖。加固后的两道修法：
 *
 * 1. **惰性快照**（需求 2.1）：`readCurrent()` 只在 `write()` 真正执行的那一刻被调用，
 *    排期时不提前拍照，因此即使旧排期触发，写出的也是「已合并远端值」的最新快照。
 * 2. **`adopt` 作废待写内容**（需求 2.2）：应用远端值后清掉 wait / max 定时器、把 dirty 复位、
 *    并把基线 `lastSynced` 更新为**应用后本地快照**的 json，于是那次排期根本不会触发。
 *
 * 两道修法互为兜底：任一条成立都不会写出旧快照，但只有 `adopt` 能做到「一次写入都不发生」。
 * 下面的 T4 因此既断言「storage 里不是旧快照」，也断言「自本地变更以来插件一次 `set` 都没发过」——
 * 后者更严格：即使最终值被后续写入盖回正确值，中途写出过一次旧快照也已经把错误内容广播给了
 * 其他上下文，属于真实的数据事故。
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
 *
 * ## 时序控制约定
 *
 * `tests/chromeMock.ts` 内部**不使用任何定时器**，只用微任务模拟 IPC 往返。因此假定时器队列里
 * 只有被测代码自己的节流 / 上界 / 退避定时器，`jest.advanceTimersByTimeAsync(ms)` 推进的就是且
 * 仅是插件的排期。mock 侧排队的落盘与广播用 `await control.settle()` 跑完。
 *
 * `debounce` / `maxWait` 一律显式传入（100 / 500），不依赖按区域区分的默认值，
 * 这样「推进多少毫秒」在断言里是确定的，也不会因为将来调整默认常量而让本文件的时序假设失效。
 */

import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick } from 'vue'

import { piniaChromeStoragePlugin } from '../src/piniaChromeStoragePlugin'
import type { StorageErrorContext } from '../src/types'

import {
  createChromeMock,
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
  type MockControl,
} from './chromeMock'

/** 存储键前缀。带上前缀是为了顺带确认写入落在 `${prefix}${store.$id}` 这一个键上 */
const PREFIX = 'lost-update-test-'
/** 显式的静默等待时长；本文件所有「推进定时器」都以它为基准 */
const DEBOUNCE = 100
/** 显式的写出上界。取 5 倍 debounce，使「只推进 debounce」与「推进到上界」两种时序可区分 */
const MAX_WAIT = 500

/** store 的初始状态。两个字段：`count` 由远端改写，`name` 留给 T5 做本地改写 */
interface TestState {
  count: number
  name: string
}

const initialState = (): TestState => ({ count: 0, name: 'init' })

let mock: ChromeMock
let control: MockControl
/** 显式接住错误出口：任何被上报的失败都会让断言失败，避免测试在「静默出错」的状态下通过 */
let onError: jest.Mock<void, [unknown, StorageErrorContext]>

/**
 * 取一份与 storage 中形态一致的普通对象快照。
 *
 * 必须**深拷贝**：`store.$state` 是响应式代理，直接存引用的话后续 mutation 会顺着引用改写
 * 这份「旧快照」，「写出的内容不等于旧快照」这个断言就永远成立、测试也就永远抓不到 bug。
 */
function snapshotOf(state: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(state))
}

/**
 * 装配一个真实的 pinia + 插件 + store，并等到首次加载完成。
 *
 * **必须经 `app.use(pinia)` 安装**：pinia 的 `use()` 在 `pinia._a` 还没有 app 时只是把插件
 * 推进内部的 `toBeInstalled` 队列，直到 `install(app)` 才转入真正生效的 `_p`。少了这一步，
 * `pinia.use(...)` 注册的插件永远不会被调用——store 能正常创建、`$storageReady` 却是
 * `undefined`（`await undefined` 静默通过），于是所有断言都在「插件根本没装上」的前提下
 * 变成假阳性/假阴性。`install()` 内部也会 `setActivePinia`，因此无需再单独调用。
 *
 * `$storageReady` 的 resolve 只依赖 `get` 的微任务（mock 不用定时器），所以在假定时器下
 * 直接 `await` 即可，不需要推进时间。之后再 `settle()` 一次，把加载路径上可能排下的
 * 微任务（本例中 storage 为空，实际没有写出）跑干净，让测试的起点是一个静止状态。
 */
async function setupStore(storeId: string) {
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
  // 空组件足够：只需要一个 app 实例来触发 pinia 的 install，从而让插件真正生效
  createApp({ render: () => null }).use(pinia)

  const useTestStore = defineStore(storeId, { state: initialState })
  const store = useTestStore(pinia)

  await store.$storageReady
  await control.settle()

  return { store, storeKey: `${PREFIX}${storeId}` }
}

beforeEach(() => {
  mock = installChromeMock(createChromeMock())
  control = mock.control
  onError = jest.fn()
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  uninstallChromeMock()
})

describe('属性 4：远端更新不被旧快照覆盖', () => {
  it('T4：本地变更已排期未写出时收到远端更新，推进定时器后 storage 不是那份旧快照', async () => {
    const { store, storeKey } = await setupStore('t4-stale-snapshot')

    // 起点：storage 为空（`seed` 未调用），加载后 dirty 为 false，因此没有任何写出排期
    expect(control.hasValue('local', storeKey)).toBe(false)

    const mark = control.mark()

    // ---- 构造「已排期但未写出」的中间态 ----
    // 订阅是 `flush: 'sync'` 的，赋值这一行同步走完 `schedule()`：dirty 置位、
    // waitTimer(100ms) 与 maxTimer(500ms) 挂上，但**一个定时器都还没到点**，
    // 所以此刻还没有发生任何 `chrome.storage.set`。
    store.count = 1

    const staleSnapshot = snapshotOf(store.$state)
    expect(staleSnapshot).toEqual({ count: 1, name: 'init' })
    // 中间态的两条确认：写已排期（下面推进定时器才有意义）、但确实还没写出
    expect(control.setCountSince(mark)).toBe(0)
    expect(control.hasValue('local', storeKey)).toBe(false)

    // ---- 注入另一个上下文的写入 ----
    // `emitWrite` 会真正落盘并广播，但不记入 `setCalls`，因此它不是被测插件发起的写——
    // 这正是「远端更新」需要的注入手段。派发是同步的，插件的 onChanged 处理在这一行内跑完：
    // 回声判定不命中（基线为 null）→ `applyingRemote` 守卫下 `$patch` → `adopt(应用后本地快照)`。
    const remoteSnapshot = { count: 99, name: 'remote-edit' }
    control.emitWrite('local', { [storeKey]: remoteSnapshot })
    await control.settle()

    // 中间态断言：远端值已经进入 state（否则后面的「不覆盖」无从谈起）
    expect(snapshotOf(store.$state)).toEqual(remoteSnapshot)

    // ---- 推进到超过 maxWait ----
    // 旧实现会在这里用 t=0 拍下的快照 A 覆盖远端值；新实现里这两个定时器已被 `adopt` 清掉
    await jest.advanceTimersByTimeAsync(MAX_WAIT + DEBOUNCE + 50)
    await control.settle()

    // 核心断言：storage 里不是收到远端更新之前的那份本地快照（需求 2.3）
    expect(control.readValue('local', storeKey)).not.toEqual(staleSnapshot)
    // 更强的形式：`adopt` 作废了待写内容，远端值原样留在 storage 里
    expect(control.readValue('local', storeKey)).toEqual(remoteSnapshot)

    // 比只看最终值更严格：中途也不允许写出过旧快照。
    // 即使最终值被后续写入盖回正确值，那一次错误写入也已经广播给了其他上下文。
    for (const call of control.setCallsSince(mark)) {
      expect(call.items[storeKey]).not.toEqual(staleSnapshot)
    }
    // `adopt` 清掉定时器 + 复位 dirty 的直接后果：这段时序里插件一次 `set` 都不该发出（需求 2.2）
    expect(control.setCountSince(mark)).toBe(0)

    expect(onError).not.toHaveBeenCalled()
    store.$stopStorageSync()
  })

  it('T5：远端更新到达后再发生本地变更，写出的是「远端值 + 本次本地修改」的新快照', async () => {
    const { store, storeKey } = await setupStore('t5-adopt-baseline')

    const mark = control.mark()

    // 与 T4 相同的中间态：本地变更已排期未写出
    store.count = 1
    expect(control.setCountSince(mark)).toBe(0)

    const remoteSnapshot = { count: 99, name: 'remote-edit' }
    control.emitWrite('local', { [storeKey]: remoteSnapshot })
    await control.settle()
    expect(store.count).toBe(99)

    // `$patch` 会把 `isListening` 置 false 并在一个 nextTick 之后才恢复（`isSyncListening` 虽然是
    // 同步恢复的，但那属于 Pinia 的内部实现细节）。跨过一个 nextTick 再做本地变更，
    // 使「订阅回调一定会触发」这个前提不依赖上述细节——否则一旦订阅没被触发，
    // 后面的断言会因为「根本没写出」而变成假阴性。
    await nextTick()

    const markBeforeLocalEdit = control.mark()

    // 只改一个字段，保留远端写入的 `count`：这样写出的快照必须同时含两侧的值才算正确
    store.name = 'local-edit'

    await jest.advanceTimersByTimeAsync(DEBOUNCE + 50)
    await control.settle()

    const expectedSnapshot = { count: 99, name: 'local-edit' }

    // 补充断言先行：确认写出确实发生了，避免「没写出」被下面的相等断言当成通过
    expect(control.setCountSince(markBeforeLocalEdit)).toBe(1)

    // 核心断言：写出的快照同时包含远端值与本次本地修改。
    // 这证明 `adopt` 把基线更新成了「应用后的本地快照」——既不是入站快照（那样 `count` 对但
    // 基线比较会在 syncRemoval=false 下失准），更不是 `store.count = 1` 时的旧本地快照
    // （那样写出的会是 `count: 1`，远端更新就丢了）。
    expect(control.lastSetCall('local')?.items[storeKey]).toEqual(expectedSnapshot)
    expect(control.readValue('local', storeKey)).toEqual(expectedSnapshot)

    // 整段时序里插件只发起了这一次写：说明 `adopt` 之后基线与内容一致，
    // 既没有把旧快照写出去，也没有出现「补全字段 → 对端写回」的乒乓写
    expect(control.setCountSince(mark)).toBe(1)

    expect(onError).not.toHaveBeenCalled()
    store.$stopStorageSync()
  })
})
