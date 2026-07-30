/**
 * 内存版 `chrome.storage` mock（任务 14.2）。
 *
 * 目标：让 T1–T8 这些测试能在 node 环境下完整驱动插件的读写双向路径，且**不引入任何人为延迟**。
 *
 * ## 两个命名空间，职责分开
 *
 * `createChromeMock()` 返回 `{ chrome, control }`：
 * - `chrome`：可以直接赋给 `globalThis.chrome` 的「宿主形状」，只包含被测代码会碰的成员
 *   （`storage.local / sync / session / managed` 的 `get` / `set` / `remove` / `clear`，以及
 *   `storage.onChanged.addListener / removeListener / hasListener`）。它上面**没有**任何测试专用入口，
 *   这样测试里不小心通过 `chrome.*` 走后门时会立刻编译失败。
 * - `control`：测试侧的控制与断言入口（手动广播、失败注入、调用记录、监听器计数、直接读写内存）。
 *
 * ## 时序：只用微任务，不用 `setTimeout`
 *
 * mock 内部**不引入任何定时器**。理由是测试全程使用 `jest.useFakeTimers()` 来推进插件自己的
 * 节流 / `maxWait` / 退避定时器；如果 mock 也往假定时器队列里塞任务，那么「推进 150ms」这个动作
 * 就同时驱动了被测逻辑与 mock 的 IPC 模拟，断言的时间点会变得难以推理（例如无法区分
 * 「写没发出」和「写发出了但 mock 还没落盘」）。
 *
 * 因此时间控制权完全留给被测代码：
 * - `set()` / `remove()` 返回的 Promise 在**下一个微任务**落盘并 resolve；
 * - `onChanged` 广播再排一个微任务，即在 `set()` 的 Promise resolve **之后**才到达监听器，
 *   模拟真实的 IPC 往返（真实 `chrome.storage` 也是先回调用方、再广播）。
 *
 * 测试里用 `await control.settle()`（或 `await jest.advanceTimersByTimeAsync(0)`）把这几个
 * 微任务跑完即可。
 *
 * ## 广播包含写入方自己
 *
 * 真实 `chrome.storage` 会把变化广播给**包括写入方在内**的所有上下文——这正是「回声」的来源。
 * mock 忠实复现这一点（`set` 之后监听器一定会收到一次事件），T3 的回声验证依赖于此。
 *
 * ## 区域隔离是真的
 *
 * 四个区域各持一份独立的 `Map`，且广播时带上正确的 `areaName`。跨区域串扰类断言（例如同时注册
 * `local` 与 `sync` 两个插件实例）可以直接依赖这一点。
 */

/** 四个存储区域名 */
export type MockAreaName = 'local' | 'sync' | 'session' | 'managed'

/** 全部区域名，便于遍历 */
export const MOCK_AREA_NAMES: readonly MockAreaName[] = ['local', 'sync', 'session', 'managed']

/** 单个键的变化，形状与 `chrome.storage.StorageChange` 一致 */
export interface MockStorageChange {
  oldValue?: any
  newValue?: any
}

/** 一次广播的 changes 载荷 */
export type MockChanges = Record<string, MockStorageChange>

/** `onChanged` 监听器签名 */
export type MockChangeListener = (changes: MockChanges, areaName: string) => void

/**
 * `get` 支持的键形态。
 *
 * 插件只用「单个字符串键」这一种；数组与对象（带默认值）形态一并支持，
 * 是为了让 mock 在被别处复用时不至于成为限制。
 */
export type MockGetKeys = string | string[] | Record<string, any> | null | undefined

/** 被测代码看得见的存储区域形状 */
export interface MockStorageArea {
  get(keys?: MockGetKeys): Promise<Record<string, any>>
  set(items: Record<string, any>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  clear(): Promise<void>
}

/** 被测代码看得见的 `chrome.storage.onChanged` 形状 */
export interface MockOnChanged {
  addListener(listener: MockChangeListener): void
  removeListener(listener: MockChangeListener): void
  hasListener(listener: MockChangeListener): boolean
}

/** 被测代码看得见的 `chrome` 形状（只含插件真正会碰的成员） */
export interface MockChrome {
  storage: {
    local: MockStorageArea
    sync: MockStorageArea
    session: MockStorageArea
    managed: MockStorageArea
    onChanged: MockOnChanged
  }
}

/** 一次 `set` 调用的记录 */
export interface MockSetCall {
  /** 全局递增序号，从 1 起，跨区域统一编号，可用于断言「顺序」 */
  order: number
  /** 目标区域 */
  area: MockAreaName
  /** 调用参数的**深拷贝**；后续对原对象的 mutation 不会污染这条历史记录 */
  items: Record<string, any>
  /** 该次调用是否因失败注入而 reject（未落盘、未广播） */
  rejected: boolean
}

/** 一次 `get` 调用的记录 */
export interface MockGetCall {
  order: number
  area: MockAreaName
  /** 原始 keys 参数的深拷贝 */
  keys: MockGetKeys
  rejected: boolean
}

/** `control.setCountSince()` / `control.setCallsSince()` 使用的调用计数标记 */
export type MockSetMark = number

/** 测试侧的控制与断言入口 */
export interface MockControl {
  // ---------------- 调用记录与断言 ----------------

  /** 至今为止的全部 `set` 调用记录（含被失败注入拒绝的那些），按发生顺序 */
  readonly setCalls: readonly MockSetCall[]
  /** `set` 总调用次数 */
  readonly setCallCount: number
  /** 至今为止的全部 `get` 调用记录 */
  readonly getCalls: readonly MockGetCall[]
  /** 当前 `onChanged` 监听器数量。清理彻底性的断言点（T8） */
  readonly listenerCount: number

  /** 指定区域的 `set` 调用次数；不传区域时等于 `setCallCount` */
  countSetCalls(area?: MockAreaName): number
  /** 最近一次 `set` 调用记录；可按区域筛选。没有则返回 `undefined` */
  lastSetCall(area?: MockAreaName): MockSetCall | undefined
  /**
   * 取一个「调用计数快照」，配合 `setCountSince()` / `setCallsSince()` 断言增量。
   *
   * 用于「某段操作期间 `set` 调用次数为 0」这类断言（T1 / T2）：
   * 直接断言总数为 0 会被 setup 阶段（首次加载后的写出）干扰，取增量才准确。
   */
  mark(): MockSetMark
  /** 自 `mark` 以来的 `set` 调用次数；可按区域筛选 */
  setCountSince(mark: MockSetMark, area?: MockAreaName): number
  /** 自 `mark` 以来的 `set` 调用记录；可按区域筛选 */
  setCallsSince(mark: MockSetMark, area?: MockAreaName): MockSetCall[]
  /** 清空 `set` / `get` 调用记录（不影响已落盘的数据与监听器） */
  clearCalls(): void

  // ---------------- 手动广播 ----------------

  /**
   * 手动广播一次 `onChanged`，模拟**另一个上下文**的写入。
   *
   * 与 `set()` 的区别：本方法**不改动**内存中的数据、**不记入** `setCalls`，纯粹派发事件。
   * 需要「另一个上下文真的写进去了」的语义时用 `emitWrite()`。
   *
   * 派发是同步的——测试里通常紧接着就要断言插件的反应，同步派发让「事件已到达」这一前提确定化。
   */
  emit(areaName: MockAreaName, changes: MockChanges): void
  /**
   * 模拟另一个上下文的写入：把值真正写进内存区域，并广播对应的 `changes`
   * （`oldValue` 取写入前的值）。同样**不记入** `setCalls`，因为它不是被测插件发起的写。
   */
  emitWrite(areaName: MockAreaName, items: Record<string, any>): void
  /**
   * 把「上一次 `set` 的参数」当作 `onChanged` 再广播一次，即人为制造一次回声（T3）。
   *
   * `set()` 本身已经会自动广播一次回声；本方法用于需要**显式、可控时机**地重放回声的场景
   * （例如先 `await` 到静止状态，再单独触发一次回声并断言 state 未变）。
   *
   * @param area 只考虑该区域的最后一次 `set`；不传则取全局最后一次
   * @returns 是否真的广播了（没有可用的 `set` 记录时返回 `false`）
   */
  emitEchoOfLastSet(area?: MockAreaName): boolean

  // ---------------- 失败注入 ----------------

  /**
   * 让接下来的 N 次 `set` 返回 reject（不落盘、不广播，但仍记入 `setCalls`）。
   *
   * @param times 失败次数，默认 1；用完自动恢复成功
   * @param error reject 的值，默认一个可识别的 `Error`。可传自定义错误以验证消息匹配，
   *   例如 `new Error('QUOTA_BYTES_PER_ITEM quota exceeded')`
   */
  failNextSet(times?: number, error?: unknown): void
  /** 让接下来的 N 次 `get` 返回 reject。参数语义同 `failNextSet` */
  failNextGet(times?: number, error?: unknown): void
  /** 取消尚未用完的失败注入 */
  clearFailures(): void
  /** 剩余的失败注入次数，便于断言「注入已用完」 */
  readonly pendingSetFailures: number
  /** 剩余的 `get` 失败注入次数 */
  readonly pendingGetFailures: number

  // ---------------- 直接读写内存 ----------------

  /** 读取某区域某键的当前值（深拷贝）；不存在时返回 `undefined` */
  readValue(area: MockAreaName, key: string): any
  /** 读取某区域的全部内容（深拷贝的普通对象） */
  readArea(area: MockAreaName): Record<string, any>
  /** 某区域是否存在该键 */
  hasValue(area: MockAreaName, key: string): boolean
  /**
   * 预置数据：直接写入内存，**不广播、不记入 `setCalls`**。
   * 用于构造「storage 中已有旧值」的启动场景。
   */
  seed(area: MockAreaName, items: Record<string, any>): void
  /** 清空某区域（不广播、不记入调用）；不传区域时清空全部区域 */
  resetArea(area?: MockAreaName): void
  /** 移除全部 `onChanged` 监听器（不触发被测代码的清理逻辑，仅用于测试收尾兜底） */
  removeAllListeners(): void

  // ---------------- 时序 ----------------

  /**
   * 把 mock 内部排队的微任务跑完（落盘 + 广播）。
   *
   * @param turns 让出的微任务轮数，默认 4，足够覆盖「落盘 → 广播 → 插件在监听器里再排一次微任务」
   */
  settle(turns?: number): Promise<void>
}

/** `createChromeMock()` 的返回值 */
export interface ChromeMock {
  /** 可直接赋给 `globalThis.chrome` 的宿主形状 */
  chrome: MockChrome
  /** 测试侧的控制与断言入口 */
  control: MockControl
}

/**
 * 深拷贝。
 *
 * 只处理 `chrome.storage` 能真正存下的形态（基本类型 / 数组 / 普通对象），
 * 这与插件的规范化层保持一致——`Date` / `Map` / `Set` 等在进入 storage 之前就已被剔除，
 * 因此这里无需（也不应该）为它们做特殊处理。
 *
 * 存在的意义：`setCalls` 记录的必须是**快照**。若存引用，测试里后续对 store 的 mutation
 * 会顺着引用改写历史记录，「第 1 次写的是什么」这个断言就永远成立不了。
 */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as unknown as T

  const source = value as unknown as Record<string, any>
  const out: Record<string, any> = {}
  for (const key of Object.keys(source)) {
    out[key] = deepClone(source[key])
  }
  return out as unknown as T
}

/** 失败注入的内部状态 */
interface FailureInjection {
  remaining: number
  error: unknown
}

/**
 * 创建一个内存版 `chrome.storage` mock。
 *
 * @example
 * ```ts
 * const { chrome: chromeMock, control } = createChromeMock()
 * ;(globalThis as any).chrome = chromeMock
 *
 * const mark = control.mark()
 * control.emitWrite('local', { 'my-store': { count: 1 } })
 * await control.settle()
 * expect(control.setCountSince(mark)).toBe(0)   // 远端应用不触发写回
 * ```
 */
export function createChromeMock(): ChromeMock {
  /** 四个区域各一份独立的内存 Map —— 区域隔离由此保证 */
  const areas: Record<MockAreaName, Map<string, any>> = {
    local: new Map<string, any>(),
    sync: new Map<string, any>(),
    session: new Map<string, any>(),
    managed: new Map<string, any>(),
  }

  /**
   * `onChanged` 监听器。真实 `chrome.storage.onChanged` 是**全局**事件（不分区域），
   * 因此这里也只有一份列表，区域信息通过回调的第二个参数传递。
   */
  const listeners: MockChangeListener[] = []

  const setCalls: MockSetCall[] = []
  const getCalls: MockGetCall[] = []
  let callOrder = 0

  const setFailure: FailureInjection = { remaining: 0, error: undefined }
  const getFailure: FailureInjection = { remaining: 0, error: undefined }

  /** 取出一次失败注入；返回 `{ hit: false }` 表示本次应当成功 */
  const consumeFailure = (injection: FailureInjection): { hit: boolean; error: unknown } => {
    if (injection.remaining <= 0) return { hit: false, error: undefined }
    injection.remaining -= 1
    const error = injection.error
    // 注入用完后把错误也清掉，避免下一轮注入忘记传 error 时复用上一轮的错误对象
    if (injection.remaining === 0) injection.error = undefined
    return { hit: true, error }
  }

  /**
   * 同步派发一次广播。
   *
   * 遍历的是列表副本，并逐个校验监听器仍在册：监听器回调里完全可能调用
   * `removeListener`（插件的清理路径就会这么做），遍历原列表会漏掉或错位。
   */
  const dispatch = (areaName: MockAreaName, changes: MockChanges) => {
    if (Object.keys(changes).length === 0) return
    const pending = listeners.slice()
    for (const listener of pending) {
      if (listeners.indexOf(listener) === -1) continue // 本轮派发过程中已被移除
      listener(deepClone(changes), areaName)
    }
  }

  /**
   * 把广播排到下一个微任务。
   *
   * 刻意**晚于** `set()` 返回的 Promise 一个微任务：真实 `chrome.storage` 也是先让调用方的
   * 回调/Promise 落地，再把变化广播给所有上下文（包括写入方自己）。
   */
  const queueBroadcast = (areaName: MockAreaName, changes: MockChanges) => {
    void Promise.resolve().then(() => {
      dispatch(areaName, changes)
    })
  }

  /** 把 items 写进内存，并返回对应的 changes（`oldValue` 取写入前的值） */
  const applyWrite = (areaName: MockAreaName, items: Record<string, any>): MockChanges => {
    const store = areas[areaName]
    const changes: MockChanges = {}

    for (const key of Object.keys(items)) {
      const existed = store.has(key)
      const oldValue = store.get(key)
      const newValue = deepClone(items[key])
      store.set(key, newValue)
      // 与真实行为一致：键此前不存在时 `oldValue` 整个缺席，而不是给一个显式的 `undefined` 值
      changes[key] = existed ? { oldValue: deepClone(oldValue), newValue } : { newValue }
    }

    return changes
  }

  /** 把 keys 归一为「要读的键名列表 + 默认值表」 */
  const resolveGetKeys = (keys: MockGetKeys, areaName: MockAreaName): { names: string[]; defaults: Record<string, any> } => {
    if (keys === null || keys === undefined) {
      return { names: Array.from(areas[areaName].keys()), defaults: {} }
    }
    if (typeof keys === 'string') return { names: [keys], defaults: {} }
    if (Array.isArray(keys)) return { names: keys.slice(), defaults: {} }
    return { names: Object.keys(keys), defaults: keys }
  }

  const createArea = (areaName: MockAreaName): MockStorageArea => ({
    get(keys?: MockGetKeys): Promise<Record<string, any>> {
      callOrder += 1
      const failure = consumeFailure(getFailure)
      getCalls.push({ order: callOrder, area: areaName, keys: deepClone(keys), rejected: failure.hit })

      if (failure.hit) {
        return Promise.reject(failure.error ?? new Error(`[chromeMock] injected get failure on area "${areaName}"`))
      }

      // 读也排一个微任务，保持与真实 API 的异步性一致
      return Promise.resolve().then(() => {
        const { names, defaults } = resolveGetKeys(keys, areaName)
        const store = areas[areaName]
        const result: Record<string, any> = {}

        for (const name of names) {
          if (store.has(name)) {
            result[name] = deepClone(store.get(name))
          } else if (Object.prototype.hasOwnProperty.call(defaults, name)) {
            // 对象形态才有默认值；数组/字符串形态下键不存在就**整键缺席**，
            // 绝不返回 `{ [key]: undefined }` —— 插件的加载流程用
            // `result[storeKey] !== undefined` 判定有无值，返回显式 undefined 也能过，
            // 但真实 API 是缺席，这里如实复现
            result[name] = deepClone(defaults[name])
          }
        }

        return result
      })
    },

    set(items: Record<string, any>): Promise<void> {
      callOrder += 1
      const failure = consumeFailure(setFailure)
      // 参数深拷贝后入账：调用方后续 mutate 同一个对象也不会污染这条历史
      setCalls.push({ order: callOrder, area: areaName, items: deepClone(items), rejected: failure.hit })

      if (failure.hit) {
        // 失败注入：不落盘、不广播
        return Promise.reject(failure.error ?? new Error(`[chromeMock] injected set failure on area "${areaName}"`))
      }

      return Promise.resolve().then(() => {
        const changes = applyWrite(areaName, items)
        // 真实 `chrome.storage` 会把变化广播给**包括写入方在内**的所有上下文，
        // 这正是「回声」的来源，T3 的验证依赖这一行为
        queueBroadcast(areaName, changes)
      })
    },

    remove(keys: string | string[]): Promise<void> {
      const names = typeof keys === 'string' ? [keys] : keys.slice()
      return Promise.resolve().then(() => {
        const store = areas[areaName]
        const changes: MockChanges = {}
        for (const name of names) {
          if (!store.has(name)) continue
          const oldValue = store.get(name)
          store.delete(name)
          // 删除事件的 `newValue` 缺席（等价于 `undefined`）
          changes[name] = { oldValue: deepClone(oldValue) }
        }
        queueBroadcast(areaName, changes)
      })
    },

    clear(): Promise<void> {
      return Promise.resolve().then(() => {
        const store = areas[areaName]
        const changes: MockChanges = {}
        for (const name of Array.from(store.keys())) {
          changes[name] = { oldValue: deepClone(store.get(name)) }
        }
        store.clear()
        queueBroadcast(areaName, changes)
      })
    },
  })

  const chromeMock: MockChrome = {
    storage: {
      local: createArea('local'),
      sync: createArea('sync'),
      session: createArea('session'),
      managed: createArea('managed'),
      onChanged: {
        addListener(listener: MockChangeListener) {
          // 真实实现对同一个函数引用重复 add 只保留一份，这里保持一致，
          // 否则「监听器数量」这个断言会被重复注册的噪音干扰
          if (listeners.indexOf(listener) !== -1) return
          listeners.push(listener)
        },
        removeListener(listener: MockChangeListener) {
          const index = listeners.indexOf(listener)
          if (index === -1) return
          listeners.splice(index, 1)
        },
        hasListener(listener: MockChangeListener) {
          return listeners.indexOf(listener) !== -1
        },
      },
    },
  }

  const filterByArea = (calls: MockSetCall[], area?: MockAreaName) =>
    area ? calls.filter((call) => call.area === area) : calls.slice()

  // 下面几个查询写成独立函数而不是互相 `this.xxx` 调用：控制对象经常被解构使用
  // （`const { control } = createChromeMock()` 之后再 `const { mark, setCountSince } = control`），
  // 依赖 `this` 会在解构后静默失效
  const lastSetCall = (area?: MockAreaName): MockSetCall | undefined => {
    const candidates = filterByArea(setCalls, area)
    return candidates.length > 0 ? candidates[candidates.length - 1] : undefined
  }

  const setCallsSince = (mark: MockSetMark, area?: MockAreaName): MockSetCall[] => {
    const since = setCalls.slice(Math.max(0, mark))
    return area ? since.filter((call) => call.area === area) : since
  }

  const control: MockControl = {
    get setCalls() {
      // 返回浅拷贝：调用方无法通过 push / splice 改写内部账本；
      // 每条记录的 `items` 本身已是深拷贝，读它是安全的
      return setCalls.slice()
    },
    get setCallCount() {
      return setCalls.length
    },
    get getCalls() {
      return getCalls.slice()
    },
    get listenerCount() {
      return listeners.length
    },

    countSetCalls(area?: MockAreaName) {
      return filterByArea(setCalls, area).length
    },
    lastSetCall,
    mark() {
      return setCalls.length
    },
    setCountSince(mark: MockSetMark, area?: MockAreaName) {
      return setCallsSince(mark, area).length
    },
    setCallsSince,
    clearCalls() {
      setCalls.length = 0
      getCalls.length = 0
    },

    emit(areaName: MockAreaName, changes: MockChanges) {
      dispatch(areaName, changes)
    },
    emitWrite(areaName: MockAreaName, items: Record<string, any>) {
      // 先落盘再广播，与真实的「另一个上下文写入」顺序一致；
      // 但不记入 setCalls —— 这不是被测插件发起的写
      const changes = applyWrite(areaName, items)
      dispatch(areaName, changes)
    },
    emitEchoOfLastSet(area?: MockAreaName) {
      const call = lastSetCall(area)
      if (!call) return false

      const store = areas[call.area]
      const changes: MockChanges = {}
      for (const key of Object.keys(call.items)) {
        const newValue = deepClone(call.items[key])
        // `oldValue` 尽力还原：内存中当前值与本次写出内容相同时省略它，
        // 因为插件只读 `newValue`，`oldValue` 只为形状完整
        changes[key] = store.has(key) ? { oldValue: deepClone(store.get(key)), newValue } : { newValue }
      }
      dispatch(call.area, changes)
      return true
    },

    failNextSet(times = 1, error?: unknown) {
      setFailure.remaining = times
      setFailure.error = error
    },
    failNextGet(times = 1, error?: unknown) {
      getFailure.remaining = times
      getFailure.error = error
    },
    clearFailures() {
      setFailure.remaining = 0
      setFailure.error = undefined
      getFailure.remaining = 0
      getFailure.error = undefined
    },
    get pendingSetFailures() {
      return setFailure.remaining
    },
    get pendingGetFailures() {
      return getFailure.remaining
    },

    readValue(area: MockAreaName, key: string) {
      return deepClone(areas[area].get(key))
    },
    readArea(area: MockAreaName) {
      const out: Record<string, any> = {}
      for (const [key, value] of areas[area]) {
        out[key] = deepClone(value)
      }
      return out
    },
    hasValue(area: MockAreaName, key: string) {
      return areas[area].has(key)
    },
    seed(area: MockAreaName, items: Record<string, any>) {
      for (const key of Object.keys(items)) {
        areas[area].set(key, deepClone(items[key]))
      }
    },
    resetArea(area?: MockAreaName) {
      if (area) {
        areas[area].clear()
        return
      }
      for (const name of MOCK_AREA_NAMES) {
        areas[name].clear()
      }
    },
    removeAllListeners() {
      listeners.length = 0
    },

    async settle(turns = 4) {
      for (let i = 0; i < turns; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve()
      }
    },
  }

  return { chrome: chromeMock, control }
}

/**
 * 把 mock 装到 `globalThis.chrome` 上并返回它。
 *
 * 需要类型断言：`@types/chrome` 为全局 `chrome` 声明了完整的命名空间类型，而本 mock 只实现了
 * 插件真正会用到的那个子集（`get` / `set` / `remove` / `clear` / `onChanged` 的三个方法）。
 * 补齐 `@types/chrome` 的全部成员既无必要也无价值，所以在**赋值这一处**做窄化断言，
 * 让不安全的地方集中在一行、而不是把整个 mock 声明成 `any`。
 */
export function installChromeMock(mock: ChromeMock = createChromeMock()): ChromeMock {
  ;(globalThis as unknown as { chrome?: unknown }).chrome = mock.chrome
  return mock
}

/** 从 `globalThis` 上摘掉 mock，供 `afterEach` 收尾，避免测试之间互相串味 */
export function uninstallChromeMock(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
}
