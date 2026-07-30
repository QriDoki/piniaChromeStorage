export type StorageArea = 'local' | 'sync' | 'session' | 'managed'

/**
 * 自定义序列化器。默认路径使用 `JSON.stringify` / `JSON.parse`。
 *
 * ## 它影响什么，不影响什么
 *
 * `serialize` 的产物**不是**写入 storage 的内容。写入 storage 的始终是 `Normalized.snapshot`
 * 这个普通对象（`chrome.storage` 本身存的就是对象，不是字符串）。`serialize` 的唯一用途是
 * 产出用于**内容级去重比较**的基线字符串 `Normalized.json`。
 *
 * 因此自定义 `serializer` 的真实用途只有一个：**提供稳定键序**。默认 `JSON.stringify` 的键顺序
 * 取决于对象的属性插入顺序（且整数样式的键会被引擎重排），于是「内容相同而 json 不同」是可能的，
 * 其后果是多写一次，不是数据错误。需要严格判等的场景可传入递归排序键的实现来消掉这次多写。
 *
 * ## 自定义 serializer 救不了 `Date` / `Map` / `Set`
 *
 * 含 `Date` / `Map` / `Set` / `RegExp` / 函数 / Symbol 值的**顶层键**会被整键跳过，
 * 且这一剔除发生在调用 `serialize` **之前**（`normalize()` 先用哨兵识别并剔除，再序列化剩下的快照）。
 * 所以无论传入什么 serializer，这些键都不会进入快照、也不会被持久化——本期不做这些类型的
 * 完整往返（设计 D5：告警 + 跳过，不做自动转换）。需要持久化这类值，只能在 store 里自行
 * 存成可 JSON 化的形式（例如把 `Date` 存成时间戳、把 `Map` 存成数组）。
 */
export interface StateSerializer {
  /**
   * 把快照序列化为字符串。
   *
   * 该字符串**只**用于内容级去重比较（`lastSynced`），不作为写入 storage 的内容。
   * 抛错时插件以 `phase: 'serialize'` 上报并跳过本次写入。
   */
  serialize(snapshot: Record<string, any>): string
  /**
   * 把字符串反序列化为快照。
   *
   * **当前没有调用点**：数据通路上不存在「字符串 → 对象」这一步，因为 `chrome.storage`
   * 读回来的已经是对象。保留该成员是为了接口对称与未来扩展（例如日后改为写入信封字符串），
   * 实现它可以直接返回 `JSON.parse(json)`。
   */
  deserialize(json: string): Record<string, any>
}

/**
 * 配额类写入失败的细分。
 *
 * 区分的意义在于「该怎么办」完全不同：
 * - `'bytes'`：单项/总量字节超限（`QUOTA_BYTES_PER_ITEM` / `QUOTA_BYTES`）。
 *   内容不变则重试永远失败，必须缩减持久化字段或换更大的区域。
 * - `'write-rate'`：写频超限（`MAX_WRITE_OPERATIONS_PER_MINUTE` / `_PER_HOUR`）。
 *   指数退避重试通常可恢复，长期解法是调大 `debounce`。
 */
export type StorageQuotaKind = 'bytes' | 'write-rate'

/** 错误上报的上下文元信息；不包含任何 state 快照内容 */
export interface StorageErrorContext {
  /** 出错 store 的 `$id` */
  storeId: string
  /** 该 store 在 `chrome.storage` 中的键，即 `` `${prefix}${store.$id}` `` */
  storeKey: string
  /** 出错时该实例配置的存储区域 */
  area: StorageArea
  /** 出错阶段：加载 / 写入 / 应用远端快照 / 序列化 */
  phase: 'load' | 'write' | 'apply' | 'serialize'
  /**
   * 可选：`phase === 'write'` 且错误消息可判定为配额类时给出的配额类别。
   * 判定基于错误消息的包含式匹配，故取保守策略——匹配不上时该字段缺席，
   * 调用方应把它当成普通写入错误处理。
   */
  quotaKind?: StorageQuotaKind
  /**
   * 可选：与 `quotaKind` 配套的人类可读可操作提示（调大 `debounce`、
   * 用 `pick` / `omit` 缩减字段、或改用 `local`）。
   * 仅在判定出配额类错误时存在；不含任何 state 内容。
   */
  hint?: string
}

/**
 * 规范化结果：字段过滤 + 解包 Proxy 后的普通对象，及其序列化字符串。
 *
 * 写方向（本地 state）与读方向（远端 `newValue`）共用同一条规范化路径，
 * 否则 `json` 之间的比较不成立。
 */
export interface Normalized {
  /** 实际写入 storage 的普通对象快照 */
  snapshot: Record<string, any>
  /** `snapshot` 经 `serializer.serialize` 得到的字符串，用于内容级去重 */
  json: string
  /** 因含不可安全序列化的值而被跳过的顶层键名 */
  droppedKeys: string[]
}

export interface PiniaChromeStorageOptions {
  /** 存储区域，默认 `'local'`。`'managed'` 为只读模式（只读取与监听，不写入） */
  storage?: StorageArea
  /** 存储键前缀，默认 `''` */
  prefix?: string

  /**
   * 节流的静默等待时长（ms）。最后一次 mutation 之后静默该时长时写出。
   * `false` 或 `0` 表示不节流，每次 mutation 立即写出。
   *
   * 默认值按区域区分：`local` / `session` 为 `150`，`sync` 为 `1000`。
   * 为小于 0 的数字时在工厂阶段抛错。
   */
  debounce?: number | false
  /**
   * 从首次 dirty 起的写出上界（ms），消除饥饿并给陈旧度确定边界。
   *
   * 默认值按区域区分：`local` / `session` 为 `500`，`sync` 为 `5000`。
   * 小于生效的 `debounce` 时会被规范化为等于 `debounce`。
   */
  maxWait?: number

  /** 只持久化这些顶层键。默认不限制（持久化全部顶层键） */
  pick?: string[]
  /** 排除这些顶层键。默认不排除。与 `pick` 同时给出时，先 `pick` 再 `omit` */
  omit?: string[]

  /**
   * 远端快照缺少某顶层键时，是否删除本地对应键。
   *
   * 默认 `false`（合并语义，保留本地键以保护 schema 演进）。
   * 需要「远端为唯一真相」的旧删除语义时显式传 `true`。
   */
  syncRemoval?: boolean

  /**
   * 首次加载完成时若已存在本地修改，如何仲裁：
   * `'local'` 保留本地值，`'storage'` 用远端值覆盖。
   *
   * 默认 `'local'`。仲裁粒度为 store 级，不做顶层键级。
   */
  onLoadConflict?: 'local' | 'storage'

  /**
   * 自定义序列化，默认使用 `JSON.stringify` / `JSON.parse`。
   *
   * 只影响用于内容级去重比较的基线字符串，**不改变写入 storage 的内容**（始终是普通对象快照），
   * 也**不能**让 `Date` / `Map` / `Set` 被持久化。详见 `StateSerializer`。
   */
  serializer?: StateSerializer

  /**
   * 是否在 `visibilitychange`（`hidden`）/ `pagehide` 时 flush 待写内容。
   *
   * 默认 `true`。仅在存在 `document` 的上下文生效；只读模式下不注册。
   */
  flushOnHide?: boolean

  /**
   * 统一错误出口。
   *
   * 默认未提供时退化为 `console.error`，且只输出错误对象与上下文元信息，
   * 不输出 state 快照内容。
   */
  onError?: (error: unknown, context: StorageErrorContext) => void
}

export interface StorageChange {
  oldValue?: any
  newValue?: any
}

export interface StorageChangeEvent {
  changes: { [key: string]: StorageChange }
  areaName: string
} 

/**
 * Pinia 类型增强：把插件挂到 store 上的三个属性并入 `PiniaCustomProperties`，
 * 使使用者在 `import` 本包后可直接得到 `store.$storageReady` 等属性的类型。
 *
 * 该增强依赖本文件是一个模块（已有 top-level `export`），并依赖它被最终类型入口
 * （`dist/index.d.ts` ← `src/index.ts`）的导出链带入类型图。
 */
declare module 'pinia' {
  export interface PiniaCustomProperties {
    /**
     * storage 首次加载完成的信号。
     *
     * 插件安装时立即发起一次异步加载，该 Promise 在首次加载流程结束时 resolve。
     * **永不 reject**：加载失败也会 resolve，错误经 `onError` 上报。
     */
    $storageReady: Promise<void>
    /**
     * 立即写出待写内容，返回的 Promise 在对应的 `chrome.storage.set` settle 后 resolve。
     *
     * 没有待写内容、或当前快照与最近一次已同步内容相同时，不发起 `set` 调用，
     * 直接返回一个已 resolve 的 Promise。
     */
    $flushStorage(): Promise<void>
    /**
     * 手动停止同步：移除 `chrome.storage.onChanged` 与 hide 类监听器、取消 store 订阅、
     * 清除所有活动定时器。效果与所属 effect scope dispose 时的清理一致。
     *
     * **幂等**：连续调用任意多次都不抛错，最终状态与调用一次相同。
     */
    $stopStorageSync(): void
  }
}
