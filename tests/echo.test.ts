/**
 * T3：回声不被重新应用（正确性属性 2）。
 *
 * **Validates: Requirements 1.2, 8.5**
 *
 * 本文件要证明的事实只有一条：**插件自己写出去的内容，被 `chrome.storage` 广播回来时，
 * 既不会被再应用一次，也不会引发第二次写。**
 *
 * ## 为什么这条测试值得单独存在
 *
 * 双向同步最容易出的错就是自我激发：写出 → `onChanged` 回声 → 被当成「远端更新」应用 →
 * 触发订阅 → 再写出 → …。插件用两层机制拦它（`applyingRemote` 守卫 + `lastSynced` 内容级去重），
 * 回声这条路径靠的是第二层：入站快照的 json 等于基线就直接丢弃（需求 1.2）。
 * 而第二层能成立的前提是**写方向与读方向共用同一条规范化路径**（需求 8.5）——
 * 两侧的过滤与序列化只要有一处不同，「入站 json === lastSynced」就永远不会成立，
 * 回声会被当成真正的远端更新处理。因此「回声被正确识别」本身就是 8.5 的直接证据。
 *
 * ## 如何避免假阳性
 *
 * 「什么都不做」的插件也能让这些断言通过（既不写，也不应用）。所以每个测试都先证明
 * **写出确实发生了**（`setCountSince` 增加 + `control.readValue()` 等于预期内容），
 * 再验证回声无副作用。第三个测试更进一步：让回声携带一份**已过时**的内容，
 * 若回声判定失效，它会把更新的本地值覆盖回旧值——这是一条可观测的回归。
 *
 * ## 时序说明
 *
 * - mock 的 `set()` 会自动把变化广播给包括写入方在内的所有监听器（真实 `chrome.storage`
 *   就是这样，这正是回声的来源），所以写出后回声本就会到达一次。
 * - `control.emitEchoOfLastSet()` 用于**显式、可控时机**地再重放一次回声，让断言的时间点确定。
 * - pinia 的 `$patch` 之后要过一个 `nextTick` 才恢复 `isListening`，因此本地变更统一放在
 *   `await nextTick()` 之后，避免「本地变更没触发订阅」造成的假阴性。
 */

import { createPinia, defineStore } from 'pinia'
import { createApp, nextTick } from 'vue'

import { piniaChromeStoragePlugin } from '../src/piniaChromeStoragePlugin'
import type { PiniaChromeStorageOptions } from '../src/types'
import { createChromeMock, installChromeMock, uninstallChromeMock } from './chromeMock'
import type { ChromeMock, MockControl } from './chromeMock'

const PREFIX = 'test-'
const STORE_ID = 'echo'
const STORE_KEY = `${PREFIX}${STORE_ID}`

/** 生效的 `local` 区域节流参数（区域默认值），测试推进定时器时按它取值 */
const LOCAL_DEBOUNCE = 150

interface EchoState {
  count: number
  name: string
  /** 用于 `omit` 场景：一个不参与持久化的瞬时字段 */
  ui: { open: boolean }
}

const useEchoStore = defineStore(STORE_ID, {
  state: (): EchoState => ({ count: 0, name: 'a', ui: { open: false } }),
})

/** 深拷贝快照：断言 state「完全一致」时必须比较值而不是引用 */
const snapshotOf = (state: Record<string, any>) => JSON.parse(JSON.stringify(state))

let mock: ChromeMock
let control: MockControl

beforeEach(() => {
  jest.useFakeTimers()
  mock = installChromeMock(createChromeMock())
  control = mock.control
})

afterEach(() => {
  uninstallChromeMock()
  jest.useRealTimers()
})

/**
 * 建一个真实的 pinia + 插件 + store。
 *
 * 两点必须注意：
 * 1. 插件工厂在调用时就会读 `chrome.storage[area]`，所以必须在 mock 装好之后再调用
 *    （由 `beforeEach` 保证）。
 * 2. **必须把 pinia 装进一个 Vue app**。pinia 的 `use()` 在实例尚未 install 到 app 时
 *    只会把插件排进 `toBeInstalled` 队列，真正的 `_p.push` 发生在 `app.use(pinia)` 时。
 *    少了这一步，插件永远不会为任何 store 执行——store 上不会有 `$storageReady`，
 *    也不会有任何读写，测试会以「什么都没发生」的形式静默通过或困惑地失败。
 */
function setupStore(options: PiniaChromeStorageOptions = {}) {
  const pinia = createPinia()
  pinia.use(piniaChromeStoragePlugin({ storage: 'local', prefix: PREFIX, ...options }))
  createApp({ render: () => null }).use(pinia)
  return useEchoStore(pinia)
}

/** 推进到节流写出完成：定时器到点 + promise chain settle + mock 的落盘与广播微任务跑完 */
async function drainWrite(extraMs = 0) {
  await jest.advanceTimersByTimeAsync(LOCAL_DEBOUNCE + extraMs)
  await control.settle()
}

describe('T3：回声不被重新应用（属性 2）', () => {
  it('写出后广播的回声既不改变 state 也不引发新的写入', async () => {
    const store = setupStore()
    await store.$storageReady
    await nextTick()

    /**
     * 独立的观察者：回声若被当成远端更新处理，`applyRemote` 的 `$patch` 会**无条件**触发
     * 一次 `patch function` 订阅通知（即使赋的值与原值相同，也就是说光看 state 看不出区别）。
     * 因此这个计数器是「回声被应用了」的直接可观测信号，用来给下面的 state 断言补上灵敏度。
     */
    let mutations = 0
    store.$subscribe(
      () => {
        mutations += 1
      },
      { flush: 'sync' }
    )

    // ---- 先证明写出确实发生了（避免假阳性）----
    const beforeWrite = control.mark()
    store.count = 1
    store.name = 'b'
    await drainWrite()
    expect(mutations).toBeGreaterThan(0)

    expect(control.setCountSince(beforeWrite, 'local')).toBe(1)
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 1, name: 'b', ui: { open: false } })

    // ---- 记录写出后的稳定状态 ----
    const stateAfterWrite = snapshotOf(store.$state)
    const storageAfterWrite = control.readValue('local', STORE_KEY)
    const afterWrite = control.mark()
    mutations = 0

    // ---- 显式重放一次回声（set 自带的那次广播已在 drainWrite 中到达）----
    expect(control.emitEchoOfLastSet('local')).toBe(true)
    await control.settle()
    // 若回声引发了排期，节流窗口 + maxWait 上界都会在这段时间内到点
    await jest.advanceTimersByTimeAsync(1000)
    await control.settle()

    // 断言 A：state 与回声到达前完全一致，且回声期间根本没有发生过 mutation
    expect(snapshotOf(store.$state)).toEqual(stateAfterWrite)
    expect(mutations).toBe(0)
    // 断言 B：回声没有引发任何新的写入
    expect(control.setCountSince(afterWrite, 'local')).toBe(0)
    // 断言 C：storage 内容也没有被回声改动
    expect(control.readValue('local', STORE_KEY)).toEqual(storageAfterWrite)
  })

  it('连续多次回声仍然幂等：state 不变、写入次数为 0', async () => {
    const store = setupStore()
    await store.$storageReady
    await nextTick()

    const beforeWrite = control.mark()
    store.count = 7
    await drainWrite()
    expect(control.setCountSince(beforeWrite, 'local')).toBe(1)
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 7, name: 'a', ui: { open: false } })

    const stateAfterWrite = snapshotOf(store.$state)
    const afterWrite = control.mark()

    for (let i = 0; i < 3; i += 1) {
      expect(control.emitEchoOfLastSet('local')).toBe(true)
      // eslint-disable-next-line no-await-in-loop
      await control.settle()
    }
    await jest.advanceTimersByTimeAsync(1000)
    await control.settle()

    expect(snapshotOf(store.$state)).toEqual(stateAfterWrite)
    expect(control.setCountSince(afterWrite, 'local')).toBe(0)
  })

  /**
   * 需求 8.5 的直接断言：读写共用同一条规范化路径（含 `omit` 过滤），使 `lastSynced` 比较成立。
   *
   * 观测手段是让回声携带一份**已过时**的内容：写出 `{ count: 1 }` 之后本地又改成 `count: 2`，
   * 此时才重放那条旧回声。回声判定成立 ⇒ 该事件被丢弃，`count` 保持 2；
   * 判定失效 ⇒ 它会被当成远端更新应用，把 `count` 打回 1——一条可观测的回归。
   *
   * 配了 `omit: ['ui']`，因此基线 json 来自「本地 state 过滤掉 ui 之后」的快照，
   * 而入站回声本身也要经过同一条过滤 + 序列化才能与它比较。两侧路径若有一处不同，
   * 这个测试就会以「count 被打回 1」的形式失败。
   */
  it('配置 omit 时回声仍被正确识别，不会用过时内容覆盖更新的本地值', async () => {
    const store = setupStore({ omit: ['ui'] })
    await store.$storageReady
    await nextTick()

    // ---- 第一次写出：ui 被过滤掉，storage 中只有 count / name ----
    const beforeWrite = control.mark()
    store.count = 1
    await drainWrite()

    expect(control.setCountSince(beforeWrite, 'local')).toBe(1)
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 1, name: 'a' })
    expect(Object.keys(control.readValue('local', STORE_KEY))).not.toContain('ui')

    // ---- 本地推进到 count: 2，暂不推进定时器（写入仍在排期中）----
    await nextTick()
    store.count = 2
    store.ui.open = true

    // ---- 此刻才重放那条内容为 { count: 1, name: 'a' } 的旧回声 ----
    expect(control.emitEchoOfLastSet('local')).toBe(true)
    await control.settle()

    // 回声被识别 ⇒ 未被应用 ⇒ 更新的本地值没有被打回
    expect(store.count).toBe(2)
    expect(store.ui.open).toBe(true)

    // ---- 排期中的本地变更照常写出，且写出的是 count: 2、依旧不含 ui ----
    const beforeSecondWrite = control.mark()
    await drainWrite()

    expect(control.setCountSince(beforeSecondWrite, 'local')).toBe(1)
    expect(control.readValue('local', STORE_KEY)).toEqual({ count: 2, name: 'a' })

    // ---- 第二次写出的回声同样无副作用 ----
    const stateAfterSecondWrite = snapshotOf(store.$state)
    const afterSecondWrite = control.mark()
    expect(control.emitEchoOfLastSet('local')).toBe(true)
    await control.settle()
    await jest.advanceTimersByTimeAsync(1000)
    await control.settle()

    expect(snapshotOf(store.$state)).toEqual(stateAfterSecondWrite)
    expect(control.setCountSince(afterSecondWrite, 'local')).toBe(0)
  })
})
