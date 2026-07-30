import type { PiniaPluginContext } from 'pinia'
import { getCurrentScope, onScopeDispose } from 'vue'

import type {
  Normalized,
  PiniaChromeStorageOptions,
  StateSerializer,
  StorageArea,
  StorageChange,
  StorageErrorContext,
  StorageQuotaKind,
} from './types'
import { isUnsupported, unpackProxy } from './unpackProxy'

/**
 * 检查当前环境是否支持Chrome扩展API
 * 这个检查确保插件只在Chrome扩展环境中运行
 * @throws {Error} 当不在Chrome扩展环境中时抛出错误
 */
function checkChromeEnvironment() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    throw new Error('This plugin requires Chrome extension environment')
  }
}

/**
 * 验证指定的存储区域是否有效
 * Chrome扩展支持四种存储区域：local、sync、session和managed
 * @param area 要验证的存储区域
 * @throws {Error} 当存储区域无效时抛出错误
 */
function validateStorageArea(area: StorageArea) {
  const validAreas: StorageArea[] = ['local', 'sync', 'session', 'managed']
  if (!validAreas.includes(area)) {
    throw new Error(`Invalid storage area: ${area}. Must be one of: ${validAreas.join(', ')}`)
  }
}

/** 顶层键过滤规则。两者同时给出时先 `pick` 再 `omit`；只作用于顶层键 */
export interface KeyFilter {
  pick?: string[]
  omit?: string[]
}

/**
 * 默认序列化器：`JSON.stringify` / `JSON.parse`。
 *
 * 只有 `serialize` 在数据通路上被真正调用——它产出的是用于内容级去重比较的基线字符串，
 * 写入 storage 的始终是 `Normalized.snapshot` 这个普通对象。`deserialize` 目前没有调用点，
 * 保留它是为了接口对称与未来扩展（见 `StateSerializer` 的说明）。
 *
 * 模块级只读常量，无任何可变状态，因此不违反「禁止模块级可变状态」的约束
 * （被消灭的是 `pendingStorageUpdate` / `storageUpdateTimer` 这类跨 store 共享的可变量）。
 */
export const DEFAULT_SERIALIZER: StateSerializer = {
  serialize: (snapshot: Record<string, any>) => JSON.stringify(snapshot),
  deserialize: (json: string) => JSON.parse(json),
}

/**
 * 序列化失败的可识别错误。
 *
 * 上层据此把失败归入 `phase: 'serialize'` 上报并跳过本次写入，
 * 而不会与写入失败（`phase: 'write'`）混在一起。
 */
export class SerializeError extends Error {
  /** 原始错误（自定义 `serializer.serialize` 抛出的内容，或 JSON 循环引用错误） */
  readonly reason: unknown

  constructor(reason: unknown) {
    super(`Failed to serialize state snapshot: ${reason instanceof Error ? reason.message : String(reason)}`)
    this.name = 'SerializeError'
    this.reason = reason
    // target 为 es2018 时 extends Error 的原型链正常，这里仅为跨编译目标稳妥起见显式修正
    Object.setPrototypeOf(this, SerializeError.prototype)
  }
}

/** 判断一个错误是否来自序列化阶段 */
export function isSerializeError(error: unknown): error is SerializeError {
  return error instanceof SerializeError
}

/**
 * 规范化：顶层键过滤 + 解包 Proxy + 序列化。
 *
 * 写方向（本地 `store.$state`）与读方向（远端 `onChanged` 的 `newValue`）**必须共用这一条路径**，
 * 这是 `lastSynced` 内容级比较能成立的前提（需求 8.5）：只有两侧经过完全相同的过滤与序列化，
 * 「入站 json === lastSynced」才真的意味着「这是我自己那次写入的回声」。
 * 远端值本身已是普通对象，而 `unpackProxy` 对普通对象/数组/基本类型是恒等的，
 * 所以读方向直接复用同一函数即可，无需另写一份。
 *
 * @param raw 待规范化的原始对象（响应式 state 或远端裸快照）
 * @param filter 顶层键过滤规则；先 `pick` 再 `omit`，对同一输入重复应用结果一致
 * @param serializer 序列化器，默认 `DEFAULT_SERIALIZER`
 * @throws {SerializeError} 序列化抛错时抛出，供上层以 `phase: 'serialize'` 上报并跳过本次写入
 */
export function normalize(
  raw: Record<string, any>,
  filter: KeyFilter = {},
  serializer: StateSerializer = DEFAULT_SERIALIZER
): Normalized {
  const snapshot: Record<string, any> = {}
  const droppedKeys: string[] = []

  // pick 只保留确实存在于 raw 上的键，这样对「已过滤结果」再过滤一次不会引入新键，幂等性成立
  const candidates = filter.pick
    ? filter.pick.filter((key) => Object.prototype.hasOwnProperty.call(raw, key))
    : Object.keys(raw)
  const omitted = filter.omit ? new Set(filter.omit) : null

  for (const key of candidates) {
    // 先 pick 后 omit：omit 在 pick 的结果上再剔除
    if (omitted && omitted.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) continue // pick 中的重复键只处理一次

    const unpacked = unpackProxy(raw[key])
    // 含 Date / Map / Set / RegExp / 函数 / Symbol 值的容器会向上传播为哨兵，
    // 因此顶层键只需检查解包结果本身；哨兵绝不写进 snapshot（否则会被序列化成 null/丢键）
    if (isUnsupported(unpacked)) {
      droppedKeys.push(key)
      continue
    }
    snapshot[key] = unpacked
  }

  let json: string
  try {
    json = serializer.serialize(snapshot)
  } catch (error) {
    throw new SerializeError(error)
  }

  return { snapshot, json, droppedKeys }
}

/**
 * 按存储区域区分的节流默认值。
 *
 * `local` / `session` 没有写频配额，但每次 `set` 都是跨进程 IPC + 落盘 + 向所有上下文广播
 * `onChanged`，所以仍要合并高频写，取 150 / 500ms。
 *
 * `sync` 取更大的值，是因为 `chrome.storage.sync` 有硬配额
 * `MAX_WRITE_OPERATIONS_PER_MINUTE = 120`（平均 500ms 一次）与
 * `MAX_WRITE_OPERATIONS_PER_HOUR = 1800`，超出即 reject。因此 `debounce` 必须 > 500ms，
 * 取 1000ms 把最坏写频压到约 12 次/分钟，远低于配额。
 *
 * 模块级只读常量，无可变状态，不违反「禁止模块级共享可变状态」的约束。
 */
const AREA_THROTTLE_DEFAULTS: Record<StorageArea, { debounce: number; maxWait: number }> = {
  local: { debounce: 150, maxWait: 500 },
  session: { debounce: 150, maxWait: 500 },
  sync: { debounce: 1000, maxWait: 5000 },
  // managed 是只读模式，写路径根本不注册，这两个值只为类型完整而存在，实际会被置 0
  managed: { debounce: 0, maxWait: 0 },
}

/**
 * 规范化后的内部配置。插件工厂阶段产出一份，之后所有子系统只读这里，不再碰原始 `options`，
 * 避免「同一个选项在不同地方各自兜默认值」导致的默认值漂移。
 */
export interface ResolvedOptions {
  /** 生效的存储区域 */
  area: StorageArea
  /** 存储键前缀 */
  prefix: string
  /** 只读模式（`area === 'managed'`）：只加载与监听，不注册任何写路径 */
  readOnly: boolean
  /** 生效的静默等待时长（ms）。`debounce: false` 已归一为 `0`；只读模式下为 `0` */
  wait: number
  /** 生效的写出上界（ms），保证 `maxWait >= wait`；只读模式下为 `0` */
  maxWait: number
  /** 顶层键过滤规则，交给 `normalize()` */
  filter: KeyFilter
  /** 生效的序列化器，缺省为 `DEFAULT_SERIALIZER` */
  serializer: StateSerializer
  /** 应用远端快照时是否删除远端不存在的本地顶层键 */
  syncRemoval: boolean
  /** 首次加载与本地修改冲突时的仲裁方向 */
  onLoadConflict: 'local' | 'storage'
  /** 是否在 hide 类时机 flush；只读模式下为 `false` */
  flushOnHide: boolean
  /** 调用方提供的错误出口；未提供时由上层退化为 `console.error` */
  onError?: (error: unknown, context: StorageErrorContext) => void
}

/**
 * 把 `debounce` 归一为一个非负整数毫秒数。
 *
 * 取舍说明：`NaN` / `Infinity` 这类非法数值**不静默当成 0**，而是与负数一样在工厂阶段抛错。
 * 理由是二者的静默兜底都会造成难以察觉的行为偏差——当成 0 会变成「每次 mutation 立即写」，
 * 在 `sync` 区域直接撞配额；当成默认值又会让调用方误以为自己的配置生效了。
 * 配置错误应当在启动时暴露，而不是在运行时以奇怪的写频表现出来。
 */
function resolveDebounce(debounce: number | false | undefined, fallback: number): number {
  if (debounce === false) return 0 // `false` 是「不节流」的显式写法，归一为 0
  if (debounce === undefined) return fallback

  if (typeof debounce !== 'number' || !isFinite(debounce)) {
    throw new Error(`Invalid option "debounce": expected a finite number >= 0 or false, got ${String(debounce)}`)
  }
  if (debounce < 0) {
    throw new Error(`Invalid option "debounce": must be >= 0, got ${debounce}`)
  }
  return debounce
}

/**
 * 把 `maxWait` 归一为不小于生效 `debounce` 的毫秒数。
 *
 * 非法数值同样抛错而不静默兜底：`NaN` 会让 `NaN < wait` 恒为 `false` 从而绕过下界钳制，
 * 最终把 `NaN` 交给 `setTimeout`（等价于 0ms），使「陈旧度上界」这一保证悄悄失效。
 */
function resolveMaxWait(maxWait: number | undefined, fallback: number, wait: number): number {
  if (maxWait === undefined) {
    // 显式传了很大的 debounce 但没传 maxWait 时，区域默认的 maxWait 可能小于 debounce，仍需钳制
    return Math.max(fallback, wait)
  }

  if (typeof maxWait !== 'number' || !isFinite(maxWait)) {
    throw new Error(`Invalid option "maxWait": expected a finite number, got ${String(maxWait)}`)
  }
  // maxWait < 生效 debounce 时归一为等于 debounce（负值也在此被抬到 >= 0）
  return maxWait < wait ? wait : maxWait
}

/**
 * 选项规范化与校验。**必须在插件工厂阶段调用**（即 `piniaChromeStoragePlugin(options)` 内，
 * 而不是返回的插件函数内），这样环境缺失与非法区域会在注册插件时就抛错，而不是等到第一个
 * store 被创建才暴露。
 *
 * 校验类错误一律抛出（属调用方配置错误，无法自动恢复）；
 * `managed` 只读**不抛错**，而是降级为只读模式并提示一次。
 *
 * @throws {Error} 非扩展环境、非法存储区域、非法 `debounce` / `maxWait`
 */
export function resolveOptions(options: PiniaChromeStorageOptions = {}): ResolvedOptions {
  // 与改造前完全一致的工厂阶段校验与时机，保证向后兼容
  checkChromeEnvironment()

  const area = options.storage || 'local'
  validateStorageArea(area)

  // managed 区域由企业策略下发，写入必然失败，因此降级为只读模式而不是抛错。
  // 这里每个插件实例只走一次（工厂阶段），所以提示也只打一条，不会每个 store 刷一遍。
  const readOnly = area === 'managed'
  if (readOnly) {
    console.info(
      '[pinia-chrome-storage] storage area "managed" is read-only: the plugin will only load and watch changes, and will never write. Write-related options (debounce / maxWait / flushOnHide / syncRemoval) are ignored.'
    )
  }

  const defaults = AREA_THROTTLE_DEFAULTS[area]
  // 先归一 debounce，再用其结果钳制 maxWait —— 顺序不能反，否则下界取的是未归一的值
  const wait = resolveDebounce(options.debounce, defaults.debounce)
  const maxWait = resolveMaxWait(options.maxWait, defaults.maxWait, wait)

  return {
    area,
    prefix: options.prefix || '',
    readOnly,
    // 只读模式下没有写路径，节流参数失去意义，统一置 0 以免被误读为「会在 150ms 后写出」
    wait: readOnly ? 0 : wait,
    maxWait: readOnly ? 0 : maxWait,
    filter: { pick: options.pick, omit: options.omit },
    serializer: options.serializer || DEFAULT_SERIALIZER,
    // 只读模式下按需求 11.3 忽略写相关选项：managed 快照缺键时删本地键，而本地又无法写回，
    // 属于单向数据丢失，因此强制回到合并语义
    syncRemoval: readOnly ? false : options.syncRemoval === true,
    onLoadConflict: options.onLoadConflict === 'storage' ? 'storage' : 'local',
    // 默认为 true，所以必须用 `!== false` 判定：显式传 undefined 时应当仍得到 true
    flushOnHide: readOnly ? false : options.flushOnHide !== false,
    onError: options.onError,
  }
}

/** 上报阶段，与 `StorageErrorContext['phase']` 保持一致的四个取值 */
export type StoragePhase = StorageErrorContext['phase']

/** 统一错误出口：把一次失败连同上下文元信息交给 `onError`（或默认的 `console.error`） */
export type StorageReporter = (error: unknown, phase: StoragePhase) => void

/**
 * 字节配额类错误的消息特征（小写比较）。
 *
 * `QUOTA_BYTES_PER_ITEM` 必须排在 `QUOTA_BYTES` 之前：后者是前者的子串，
 * 顺序反了会把「单项超限」误判成「总量超限」，提示的措辞就会跑偏。
 */
const BYTES_QUOTA_MARKERS = ['quota_bytes_per_item', 'quota_bytes'] as const

/** 写频配额类错误的消息特征（小写比较） */
const WRITE_RATE_QUOTA_MARKERS = [
  'max_write_operations_per_minute',
  'max_write_operations_per_hour',
  // Chrome 早期版本用的措辞，一并兜住
  'max_sustained_write_operations_per_minute',
] as const

/**
 * 从任意 rejection 里取出可用于匹配的消息文本。
 *
 * `chrome.storage.set` 的 rejection 在 MV3 下通常是 `Error`，但也可能是字符串
 * （旧版把 `chrome.runtime.lastError.message` 直接抛出），所以两种都要认。
 * 其余形态（对象、`undefined`）一律返回空串，交由保守判定当成普通错误。
 */
function readErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * 判定一次写入失败是否属于配额类，并区分字节 / 写频两类。
 *
 * 只做「大小写不敏感的包含式匹配」，并且**保守**：匹配不上就返回 `null`，
 * 由调用方当成普通写入错误处理。宁可漏报也不误报——把一次网络/IO 抖动
 * 说成「配额超限，请缩减字段」会把使用者引到完全错误的方向上。
 */
function detectQuotaKind(error: unknown): StorageQuotaKind | null {
  const message = readErrorMessage(error).toLowerCase()
  if (!message) return null

  // 先判写频：写频类消息里不含 QUOTA_BYTES 字样，两组特征互不重叠，顺序只影响可读性
  for (const marker of WRITE_RATE_QUOTA_MARKERS) {
    if (message.includes(marker)) return 'write-rate'
  }
  for (const marker of BYTES_QUOTA_MARKERS) {
    if (message.includes(marker)) return 'bytes'
  }
  // 只出现 "quota" 字样（措辞未知）时，无法区分字节还是写频，因此不给带方向的提示。
  // 归入写频类会诱导「调大 debounce」，归入字节类会诱导「缩减字段」，两者都可能是错的，
  // 所以这里返回 null，交给通用写入错误路径。
  return null
}

/**
 * 生成与配额类别匹配的可操作提示（需求 4.7）。
 *
 * 提示按类别裁剪而不是笼统罗列三条建议：字节配额类错误重试无益，必须明确告知；
 * 写频配额类退避重试有效，主要解法是调大 `debounce`。
 */
function buildQuotaHint(kind: StorageQuotaKind, area: StorageArea): string {
  // 「改用 local」只对 sync 有意义；已经在 local 上再这么建议是噪音
  const switchArea = area === 'sync' ? '，或改用 "local" 区域（无写频配额、容量上限高得多）' : ''

  if (kind === 'bytes') {
    return (
      '字节配额超限：内容不变时重试永远失败，退避重试无益。' +
      '请用 pick / omit 缩减持久化的顶层字段（sync 单项上限 QUOTA_BYTES_PER_ITEM = 8192 字节）' +
      (area === 'sync' ? '，或改用 "local" 区域' : '') +
      '。调大 debounce 不能解决字节超限。'
    )
  }
  return (
    '写频配额超限：指数退避重试通常可以恢复。' +
    '长期解法是调大 debounce / maxWait 降低写频（sync 上限为每分钟 120 次、每小时 1800 次），' +
    '也可用 pick / omit 缩减持久化字段以减少变更引发的写入' +
    switchArea +
    '。'
  )
}

/**
 * 创建该 store 的统一错误出口。
 *
 * 做成工厂是因为上下文的四个字段来源不同：`storeId` / `storeKey` 是 per-store 的，
 * `area` / `onError` 来自插件实例的 `ResolvedOptions`。工厂把两者合起来固定住，
 * 调用点只需给出 `error` 与 `phase`。
 *
 * **不输出 state 快照内容**（需求 4.6）：默认出口只把「标识前缀 + 上下文元信息 + 错误对象」
 * 交给 `console.error`。错误日志经常被用户复制到 issue 里或直接截图，而 state 中可能有
 * 令牌、个人信息等敏感数据；一旦打进控制台就等于把它交给了插件控制不到的地方。
 * 因此这里绝不接受、也绝不打印 snapshot / json / lastSynced 等任何 state 派生数据。
 */
export function createReporter(config: {
  /** store 的 `$id` */
  storeId: string
  /** 该 store 在 storage 中的键 */
  storeKey: string
  /** 本实例配置的存储区域 */
  area: StorageArea
  /** 调用方提供的错误出口；缺省时退化为 `console.error` */
  onError?: (error: unknown, context: StorageErrorContext) => void
}): StorageReporter {
  const { storeId, storeKey, area, onError } = config

  return (error: unknown, phase: StoragePhase) => {
    const context: StorageErrorContext = { storeId, storeKey, area, phase }

    // 只有写入阶段才可能撞配额；其他阶段即使消息里带 quota 字样也不做判定
    if (phase === 'write') {
      const quotaKind = detectQuotaKind(error)
      if (quotaKind) {
        // 提示挂在 context 上（两个字段都是可选的、向后兼容的扩展），
        // 这样自定义 onError 的调用方也能拿到，而不是只有 console 里看得见
        context.quotaKind = quotaKind
        context.hint = buildQuotaHint(quotaKind, area)
      }
    }

    // 上报本身绝不能抛错：report 出现在写入 chain 的 catch 与 load 的 catch 里，
    // 若调用方的 onError 自己抛异常并冒泡，就会污染 promise chain（产生未处理 rejection）
    // 甚至中断后续的退避重试。这里一律捕获并降级。
    try {
      if (onError) {
        onError(error, context)
        return
      }
      console.error('[pinia-chrome-storage] storage sync failed', context, error)
    } catch (reportError) {
      // 降级路径本身也可能失败（例如 console 被改写过），再兜一层，保证 report 永远静默返回
      try {
        console.error('[pinia-chrome-storage] onError callback threw and was ignored', reportError)
      } catch (_ignored) {
        /* 无处可报，只能放弃这条日志 —— 但绝不向调用栈抛出 */
      }
    }
  }
}

/**
 * 写入失败后的最大重试次数（需求 4.3）。
 *
 * 与 `RETRY_BASE_DELAY_MS` 一起决定退避序列 1s / 2s / 4s / 8s / 16s。
 * 模块级只读常量，无可变状态，不构成跨 store 的共享状态。
 */
const RETRY_MAX_ATTEMPTS = 5

/** 退避基准延迟（ms）。第 n 次重试（n 从 0 起）延迟为 `RETRY_BASE_DELAY_MS * 2 ** n` */
const RETRY_BASE_DELAY_MS = 1000

/** `createWriter()` 的配置。全部由「store × 插件实例」的闭包提供，写入器自身不读任何全局状态 */
export interface WriterConfig {
  /** 该 store 在 storage 中的键，即 `` `${prefix}${store.$id}` ``；写入器只写这一个键 */
  storeKey: string
  /** 实际写入动作，通常是 `chrome.storage[area].set`；返回的 Promise 在落地或失败后 settle */
  set: (data: Record<string, any>) => Promise<void>
  /**
   * 读取「调用这一刻」的规范化快照。
   *
   * 必须无副作用，且每次调用都返回最新状态——写入器依赖这一点实现惰性快照（需求 2.1）。
   * 允许抛出 `SerializeError`，写入器会以 `phase: 'serialize'` 上报并跳过本次写入（需求 9.5）。
   */
  readCurrent: () => Normalized
  /** 生效的静默等待时长（ms）。为 `0` 时不设静默定时器，每次排期立即写出（需求 3.5） */
  wait: number
  /** 生效的写出上界（ms），调用方已保证 `maxWait >= wait` */
  maxWait: number
  /** 统一错误出口，见 `createReporter()` */
  report: StorageReporter
  /**
   * 告警出口（非错误），目前只用于「跳过了含不支持类型的顶层键」。
   *
   * 与 `report` 分开是因为二者语义不同：`report` 是失败上报，会交给调用方的 `onError`；
   * 而跳过键是一次**成功**的写入里的降级提示（需求 9.2），不该混进错误回调把使用者的
   * 告警管道污染成「持续报错」。缺省为 `console.warn`。
   */
  warn?: (message: string) => void
}

/** 写入器对外接口。每个「store × 插件实例」一份，彼此完全隔离 */
export interface StorageWriter {
  /** 标记 dirty 并按节流策略排期；`armed === false` 时只记 dirty（需求 6.2） */
  schedule(): void
  /** 立即写出（跳过节流）。返回的 Promise 在本次 `set` settle 后 resolve */
  write(): Promise<void>
  /** `write()` 的语义别名，供 `$flushStorage()` 与 hide 类时机使用 */
  flush(): Promise<void>
  /** 应用远端值后调用：清定时器、作废待写内容、把基线更新为 `json`（`null` 表示基线未知，下次必写） */
  adopt(json: string | null): void
  /**
   * 只读地告知「当前存在尚未写出的本地内容」。
   *
   * 存在的唯一目的是让加载流程判定「首次加载完成前是否发生过本地 mutation」（需求 6.5、6.6）：
   * 加载未完成时 `armed === false`，订阅回调调用的 `schedule()` 只会置 dirty 而不写出，
   * 因此这个布尔就是仲裁所需的信号。
   *
   * 暴露的是**只读取值函数**而不是可写标记，也没有把 `dirty` 提到闭包之外：
   * 调用方只能观察，不能改写，因此不存在「外部把 dirty 清掉导致本地修改不被写出」的通道。
   * 仲裁粒度也因此天然是 store 级布尔（需求 6.9）。
   */
  isDirty(): boolean
  /**
   * 把基线置为未知（`lastSynced = null`），**不改动 dirty，也不清除定时器**。
   *
   * 与 `adopt(null)` 的区别正在于此，两者不可互换：`adopt` 的语义是「远端值已经取代了待写内容」，
   * 因此它必须清掉 dirty 与定时器；而加载流程里有两条路径需要「基线未知 + 保留待写内容」——
   * 「storage 无值」（需求 6.7）与「`onLoadConflict: 'local'` 且加载期间有本地修改」（需求 6.5）。
   * 这两条路径上若用 `adopt(null)`，dirty 会被清掉，随后的 `arm()` 就不再补排，
   * 加载期间那次本地修改会被永久丢弃——这是一条真实的丢更新路径。
   */
  invalidateBaseline(): void
  /**
   * 只读地判断给定 json 是否等于当前基线 `lastSynced`，供远端应用器做回声判定（需求 1.2）。
   *
   * 之所以暴露一个**判定方法**而不是 `getLastSynced()` 或把 `lastSynced` 提到外层：
   * 基线是写入器的私有状态（失败时置 `null`、`adopt` 时改写、去重时比较），一旦被外部读到裸值，
   * 调用方就有可能自己缓存、自己比较，从而出现两份不同步的基线认知。只暴露布尔判定则调用方
   * 拿不到也存不下基线，隔离性不被破坏，也没有任何外部写入通道。
   *
   * `lastSynced === null`（基线未知）时恒为 `false`：此时不能把任何入站快照当成自己的回声，
   * 否则会把一份真正来自远端的更新当成回声丢弃。
   */
  isSynced(json: string): boolean
  /** 首次加载结束后解锁写路径；若此时已 dirty 则立即排期 */
  arm(): void
  /** 清理定时器并永久停用写入器；幂等 */
  dispose(): void
}

/**
 * 创建一个 store 的写入器。
 *
 * **所有状态都在本函数的闭包内**（`waitTimer` / `maxTimer` / `retryTimer` / `firstDirtyAt` / `dirty` /
 * `armed` / `lastSynced` / `chain` / `retryCount` / `disposed`），没有任何模块级可变状态。
 * 这正是改造前缺陷 2 的修法：旧实现的 `pendingStorageUpdate` / `storageUpdateTimer` 是模块级共享的，
 * 同时注册 `local` + `sync` 两个实例时会把快照写进错误的区域，且一个高频 store 会让其他 store 饥饿。
 * 现在两个维度都被闭包隔离（需求 3.8、3.9、4.8）。
 *
 * 两条关键机制：
 * - **惰性快照**：`readCurrent()` 只在 `write()` 真正执行的那一刻调用，绝不在 `schedule()` 时提前拍照。
 *   否则节流窗口内到达的远端更新会被一份过期快照覆盖并广播回去（需求 2.1，缺陷 1）。
 * - **内容级去重**：`json === lastSynced` 时跳过 `set`，使「写 → onChanged 回声 → 判定相同 → 丢弃」
 *   的链条最多传播一轮，与框架行为无关（需求 1.3、1.4）。
 *
 * 失败路径同样收在闭包内：`set` reject 时把基线置 `null` 并以 1s / 2s / 4s / 8s / 16s 重排，最多 5 次
 * （需求 4.2、4.3）。这里**不存在**任何跨 store 的速率限制器（需求 4.8）——配额压力由按区域调优的
 * 节流默认值加上这条退避链承担，退避本身就起到限流作用。
 */
export function createWriter(cfg: WriterConfig): StorageWriter {
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 退避重试的定时器句柄。
   *
   * **必须与 `waitTimer` 分开**，不能复用后者：`schedule()` 每次都会 `clearTimeout(waitTimer)`
   * 再重设，若退避挂在 `waitTimer` 上，则退避期间任何一次正常 mutation 都会把「16s 后重试」
   * 悄悄改写成「150ms 后写出」——退避的限流作用被一次普通排期抹掉，而配额压力恰恰要靠它承担
   * （设计 D6：不引入跨 store 限流器，改由默认节流 + 指数退避兜住）。分开之后两个定时器互不干扰，
   * 谁先到点谁写出，另一个会被 `write()` 开头的 `clearTimers()` 收走，既不丢重试也不会重复写入。
   */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 首次 dirty 的时间戳；`0` 表示当前不存在待写窗口。不变式：`firstDirtyAt !== 0 ⟺ maxTimer !== null` */
  let firstDirtyAt = 0
  let dirty = false
  /** 首次加载完成前为 `false`：本地 mutation 只记 dirty，不写出（需求 6.2） */
  let armed = false
  let disposed = false
  /** 最近一次认定为已同步的 json；`null` 表示基线未知，下次排期必定写出 */
  let lastSynced: string | null = null
  /**
   * 串行化写入链：所有 `set` 一律经 `chain = chain.then(...)` 追加，没有任何旁路直接调用 `set`。
   * 因此任意时刻至多有一个未 settle 的 `set` 在飞行，且发起顺序 == 排期顺序（需求 4.1、不变式 I1）。
   */
  let chain: Promise<unknown> = Promise.resolve()
  /**
   * 连续失败次数，用于选择退避档位（`RETRY_BASE_DELAY_MS * 2 ** retryCount`）并判定是否已达上限。
   * 成功一次即复位为 0（需求 4.4），使偶发失败后恢复正常的写入不继承旧的退避档位。
   */
  let retryCount = 0
  /**
   * 上一次已告警过的「被跳过键」集合的指纹。
   *
   * 需求 9.2 的「告警一次」指的是**同一组被跳过的键只提示一次**，而不是每次写出都刷一条日志——
   * 含 `Date` 的字段通常会持续存在，每次写都告警会把控制台淹掉。这里用「排序后拼接」做指纹：
   * 键集合不变则静默，集合发生变化（新增/减少了被跳过的键）时再告警一次。
   * `null` 表示还没有告警过任何集合。
   */
  let lastDroppedFingerprint: string | null = null

  const warn = cfg.warn || ((message: string) => console.warn(message))

  /**
   * 清除全部三个定时器（静默、上界、退避重试）并复位待写窗口。
   *
   * `firstDirtyAt` 必须与 `maxTimer` 一起复位，否则下一轮 dirty 会因为 `firstDirtyAt !== 0`
   * 而不再建立 `maxWait` 上界定时器，陈旧度上界（需求 3.2）就悄悄失效了。
   *
   * 把 `retryTimer` 也收在这里，是为了让「一次真实写出」与「一次 `adopt()`」都能作废待触发的重试：
   * 前者已经带着最新内容写出去了（失败后 `lastSynced === null`，不会被去重跳过），后者的远端值
   * 已经取代了那份失败的内容，两种情况下再补一次重试都只是重复写。`dispose()` 同样经由这里，
   * 因此 dispose 之后绝不会再有退避回调触发（需求 5.1、5.4）。
   */
  const clearTimers = () => {
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
      waitTimer = null
    }
    if (maxTimer !== null) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    firstDirtyAt = 0
  }

  /** 同一组被跳过的键只告警一次（见 `lastDroppedFingerprint`） */
  const warnDroppedOnce = (droppedKeys: string[]) => {
    const fingerprint = droppedKeys.slice().sort().join(',')
    if (fingerprint === lastDroppedFingerprint) return
    lastDroppedFingerprint = fingerprint
    warn(
      `[pinia-chrome-storage] 以下顶层键含无法安全序列化的值（Date / Map / Set / RegExp / 函数 / Symbol），` +
        `本次写入已跳过它们：${droppedKeys.join(', ')}。` +
        `这些键的剔除发生在序列化之前，因此自定义 serializer 也无法改变；` +
        `如需持久化这些字段，请在 store 中改存可 JSON 化的形式（例如 Date 存时间戳、Map / Set 存数组）。`
    )
  }

  /**
   * 写入失败后按指数退避重新排期（需求 4.3）。
   *
   * 延迟序列严格为 1s / 2s / 4s / 8s / 16s，最多重试 5 次；达到上限后**停止排期**。
   * 注意「放弃重试」不等于「认定已同步」：此时 `lastSynced` 保持为 `null`，`dirty` 保持为 `true`，
   * 因此之后任何一次真实的 `schedule()`（新的本地 mutation、`arm()`、`flush()`）都会重新写出这份内容，
   * 不会因为内容级去重被跳过。放弃的只是「自动定时重试」，数据本身没有被丢掉（需求 4.2、属性 8）。
   *
   * 退避只覆盖「自动重试」这一条路径。退避待触发期间到来的正常排期仍会按 `wait` 写出——
   * 抑制用户主动变更引发的写入需要跨 store 的速率限制器，而那正是需求 4.8 明确排除的东西。
   */
  const scheduleRetry = () => {
    if (disposed) return
    // 已用满 5 次：不再排期。lastSynced 仍为 null，后续真实排期会重新尝试
    if (retryCount >= RETRY_MAX_ATTEMPTS) return

    const delay = RETRY_BASE_DELAY_MS * 2 ** retryCount
    retryCount += 1
    // 内容仍未落地，保持 dirty，使 arm() 等路径知道还有待写内容
    dirty = true

    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void write()
    }, delay)
  }

  const write = (): Promise<void> => {
    // 立即写出意味着当前的排期作废：先清定时器，避免 flush 之后 waitTimer 再触发一次空写
    clearTimers()
    if (disposed) return Promise.resolve()
    dirty = false

    let normalized: Normalized
    try {
      // 惰性快照：此刻才解包 + 序列化。放到 schedule() 里提前取会导致用过期快照覆盖远端更新
      normalized = cfg.readCurrent()
    } catch (error) {
      // 只有真正来自序列化的失败才归入 `phase: 'serialize'`（需求 9.5）。
      // `readCurrent()` 还可能因别的原因抛错——最典型的是读 `store.$state` 的某个 getter 自己抛异常。
      // 那类失败与序列化无关，若一律报成 'serialize'，会把使用者引向「换个 serializer」这个错误方向；
      // 归为 'write' 更准确：本次写入没能发出。两种情况都跳过本次写入。
      cfg.report(error, isSerializeError(error) ? 'serialize' : 'write')
      return Promise.resolve()
    }

    if (normalized.droppedKeys.length > 0) {
      warnDroppedOnce(normalized.droppedKeys)
    }

    // 内容级去重：内容与基线相同就不发起 set。
    // 判定必须在给 lastSynced 赋值之前做，否则去重永远命中不了（属性 3 的关键点）。
    // 此处返回已 resolve 的 Promise，使 $flushStorage() 在无待写内容时不产生任何 IPC（需求 7.4）。
    if (normalized.json === lastSynced) return Promise.resolve()
    lastSynced = normalized.json

    const snapshot = normalized.snapshot
    // 所有 set 一律经 chain 追加，没有旁路直接调用，因此发起顺序 == 排期顺序（需求 4.1）
    chain = chain
      .then(() => cfg.set({ [cfg.storeKey]: snapshot }))
      .then(() => {
        // 成功即复位重试计数（需求 4.4）：一次偶发失败之后恢复正常的写入不该继承旧的退避档位，
        // 否则下一次失败会直接从 16s 起跳，甚至因为计数已满而完全不再重试
        retryCount = 0
      })
      .catch((error) => {
        // 失败 ≠ 已同步：把基线置 null，使这份内容在下一次写出时不被内容级去重跳过（需求 4.2、属性 8）
        lastSynced = null
        cfg.report(error, 'write')
        // 指数退避重排：1s / 2s / 4s / 8s / 16s，最多 5 次（需求 4.3）
        scheduleRetry()
      })

    return chain.then(() => undefined)
  }

  const schedule = () => {
    if (disposed) return
    dirty = true
    // 首次加载未完成：只记 dirty，等 arm() 解锁，避免本地半成品先写出去覆盖远端（需求 6.2）
    if (!armed) return

    // debounce: false / 0 —— 不设静默定时器，立即写出（需求 3.5）
    if (cfg.wait === 0) {
      void write()
      return
    }

    // maxWait 是一个**独立**的上界定时器，只在进入待写窗口时设置一次。
    // 不做「在 schedule() 入口惰性检查 now - firstDirtyAt >= maxWait」，因为那样的上界要靠
    // 「下一次 mutation 到来」才生效；持续高频变更时 waitTimer 会被无限重置，写出被无限推迟（饥饿）。
    // 用独立定时器后，「首次 dirty → 发起写入 <= maxWait」无条件成立（需求 3.2）。
    if (firstDirtyAt === 0) {
      firstDirtyAt = Date.now()
      maxTimer = setTimeout(() => {
        void write()
      }, cfg.maxWait)
    }

    // 静默计时在每次 mutation 时重置（需求 3.1）
    if (waitTimer !== null) clearTimeout(waitTimer)
    waitTimer = setTimeout(() => {
      void write()
    }, cfg.wait)
  }

  return {
    schedule,
    write,
    flush: () => write(),
    /**
     * 应用远端值后的收尾（需求 2.2）：清定时器 + 作废待写内容 + 更新基线。
     * 清定时器这一步是「远端更新不被旧快照覆盖」的关键——待写的那份变更已经被
     * `$patch` 合并进 state 了，旧排期若仍然触发，写出的就是「合并前」的内容。
     * 传 `null` 表示基线未知（例如 load 时仲裁保留本地值），下一次排期必定写出。
     */
    adopt: (json: string | null) => {
      clearTimers()
      dirty = false
      lastSynced = json
    },
    isSynced: (json: string) => lastSynced !== null && json === lastSynced,
    isDirty: () => dirty,
    /** 只改基线，不动 dirty 与定时器；与 `adopt(null)` 的差别见接口上的说明 */
    invalidateBaseline: () => {
      lastSynced = null
    },
    arm: () => {
      armed = true
      // load 期间累积的 dirty 在解锁的这一刻补排一次（需求 6.3）
      if (dirty) schedule()
    },
    dispose: () => {
      // 幂等：重复调用只是再清一次已经为 null 的定时器，无副作用
      disposed = true
      clearTimers()
    },
  }
}

/**
 * 远端应用器需要的 store 能力，只取实际用到的两项。
 *
 * 写成结构化最小接口而不是直接依赖 `Store`，是为了让职责边界显式：应用器只读 `$state`
 * 的顶层键、只通过 `$patch(fn)` 改状态，不碰 `$subscribe` / `$reset` 等任何其他入口。
 */
export interface ApplierStore {
  $state: Record<string, any>
  $patch(stateMutator: (state: Record<string, any>) => void): void
}

/** `createRemoteApplier()` 的配置 */
export interface RemoteApplierConfig {
  /** 目标 store */
  store: ApplierStore
  /** 该 store 的写入器；应用完成后经 `adopt()` 作废待写内容并更新基线，回声判定读它的 `isSynced()` */
  writer: StorageWriter
  /**
   * 读取「调用这一刻」本地 state 的规范化快照。
   *
   * 必须与写入器使用的是**同一个**函数（同一套 filter + serializer），否则 `adopt` 写进去的基线
   * 与写方向算出的 json 不可比，内容级去重会永远命中不了。
   */
  readCurrent: () => Normalized
  /** 顶层键过滤规则，用于规范化入站快照，并界定 `syncRemoval` 的删除范围 */
  filter: KeyFilter
  /** 序列化器，与写方向共用 */
  serializer: StateSerializer
  /** 是否删除远端快照中不存在的本地顶层键（需求 10.2、10.3） */
  syncRemoval: boolean
  /** 统一错误出口，见 `createReporter()` */
  report: StorageReporter
}

/** 远端应用器对外接口 */
export interface RemoteApplier {
  /** 把一份远端裸快照应用到 store（含回声判定）；本次调用不产生任何 storage 写入 */
  applyRemote(raw: Record<string, any>): void
  /**
   * 当前是否正在应用远端快照。
   *
   * `store.$subscribe` 的回调只需要「读到 `true` 就 return」，因此这里暴露的是一个**只读取值函数**
   * 而不是可写的标记：守卫的置位与复位只发生在 `applyRemote` 内部的 `try/finally` 里，
   * 外部没有任何写入通道，从而不可能出现「标记被置上却没人复位」的残留状态。
   */
  isApplying(): boolean
}

/**
 * 由顶层键过滤规则派生「该键是否参与持久化」的判定。
 *
 * `syncRemoval === true` 的删除范围必须限定在**参与持久化的键**上：被 `omit` 掉（或未被 `pick` 选中）
 * 的键根本不会出现在任何远端快照里，若按「远端没有就删」处理，等于每次远端更新都把瞬时 UI 状态
 * 之类的本地字段清空一次——那是纯粹的数据破坏，与 `syncRemoval` 想表达的「远端为唯一真相」无关。
 */
function createPersistedKeyPredicate(filter: KeyFilter): (key: string) => boolean {
  const picked = filter.pick ? new Set(filter.pick) : null
  const omitted = filter.omit ? new Set(filter.omit) : null

  return (key: string) => {
    if (picked && !picked.has(key)) return false
    if (omitted && omitted.has(key)) return false
    return true
  }
}

/**
 * 创建一个 store 的远端应用器，并持有 `applyingRemote` 守卫。
 *
 * **守卫是闭包内的同步布尔量，绝不写入 state**（需求 12.1–12.3）。这是替换旧实现
 * `SYNC_STORAGE_KEY` Symbol 的关键：旧方案把 Symbol 塞进响应式 state，再靠订阅回调
 * `delete` 掉它，一旦某次清理漏跑，标记就永久残留，之后所有 `patch function`（包含 `$reset`）
 * 都会被误判成「来自 storage」，持久化静默失效且没有任何报错。
 *
 * 守卫可靠性的依据（设计「依据的 Pinia v3 内部行为」结论 1）：Pinia v3 的 `$patch` 会先置
 * `isListening = isSyncListening = false`，应用变更，然后**同步**调用 `triggerSubscriptions`。
 * 也就是说订阅回调的执行窗口完整落在 `$patch` 的调用栈内，因此
 * `applyingRemote = true` → `$patch(...)` → `finally { applyingRemote = false }`
 * 能可靠地覆盖这个窗口，不需要任何异步栅栏。
 *
 * **这是本插件对框架内部行为的唯一依赖**，升级 Pinia 大版本时应回归验证这一条；
 * 即便它失效，内容级去重（`lastSynced`）仍会兜住，最坏结果是多写一轮而不是回环。
 */
export function createRemoteApplier(cfg: RemoteApplierConfig): RemoteApplier {
  const { store, writer, readCurrent, filter, serializer, syncRemoval, report } = cfg
  const isPersistedKey = createPersistedKeyPredicate(filter)

  /** 同步布尔守卫：仅在 `applyRemote` 的 `$patch` 调用期间为 `true` */
  let applyingRemote = false

  /**
   * 应用完成后的收尾：把基线更新为**应用后本地快照**的 json（需求 10.4）。
   *
   * 传本地快照而不是入站快照的 json，原因在 `syncRemoval === false` 时会显现：此时本地可能存在
   * 远端没有的顶层键（schema 演进后新加的字段），应用后的本地快照因而是「远端内容 + 本地独有键」，
   * 与入站 json 不同。若拿入站 json 当基线，下一次排期就会发现「当前内容 ≠ 基线」而立刻把补全后的
   * 快照写回 storage，对端收到后同样补全再写回——形成一轮多余的乒乓写。以本地快照为基线则本次
   * 应用之后内容与基线一致，写路径自然静默；代价是 storage 中保持旧 schema，直到下一次真实的本地变更。
   */
  const adoptLocalBaseline = () => {
    try {
      writer.adopt(readCurrent().json)
    } catch (error) {
      // 应用后的本地快照算不出 json：基线无从得知，置 `null` 让下一次排期必定重新写出，
      // 同时 adopt 仍清掉了旧的待写定时器（需求 2.2）。
      // 阶段按错误来源区分：序列化失败归 'serialize'，其余（例如某个 state getter 抛异常）
      // 属于本次「应用远端快照」流程的收尾失败，归 'apply' 才不会误导使用者去改 serializer。
      report(error, isSerializeError(error) ? 'serialize' : 'apply')
      writer.adopt(null)
    }
  }

  const applyRemote = (raw: Record<string, any>) => {
    let incoming: Normalized
    try {
      // 入站快照走与写方向**完全相同**的规范化路径（需求 8.5），否则下一行的回声判定不成立
      incoming = normalize(raw, filter, serializer)
    } catch (error) {
      // 算不出 json 就无法判定这是不是自己的回声；此时应用它有把回声当远端更新处理的风险，
      // 因此上报并跳过本次事件，保持 state 不变。
      // 同样只把真正的序列化失败归入 'serialize'，其余归入 'apply'（本次远端应用未能进行）
      report(error, isSerializeError(error) ? 'serialize' : 'apply')
      return
    }

    // 回声判定（需求 1.2）：内容等于当前基线 ⇒ 这就是自己那次写入被广播回来的事件，state 不动
    if (writer.isSynced(incoming.json)) return

    const snapshot = incoming.snapshot
    // 只取字符串键：`Object.keys` 天然不含 Symbol，因此不存在把 Symbol 键写进 state 的路径（需求 12.1）
    const incomingKeys = Object.keys(snapshot)

    let patchError: unknown
    let patchFailed = false

    applyingRemote = true
    try {
      store.$patch((state) => {
        // 循环不变式：每次迭代结束后，已处理的键在 state 中的值与入站快照一致，未处理键保持原值
        for (const key of incomingKeys) {
          state[key] = snapshot[key]
        }

        if (syncRemoval) {
          // 先取键列表快照再删，避免在遍历过程中改动被遍历的对象
          for (const key of Object.keys(state)) {
            if (incomingKeys.indexOf(key) !== -1) continue
            // 不参与持久化的键（未被 pick / 已被 omit）不在删除范围内，见 createPersistedKeyPredicate
            if (!isPersistedKey(key)) continue
            delete state[key]
          }
        }
      })
    } catch (error) {
      patchFailed = true
      patchError = error
    } finally {
      // 真正的 try/finally：`$patch` 抛错时守卫也必须复位，否则它会永久卡在 `true`，
      // 之后所有本地 mutation 都被当成「来自远端」丢弃，持久化静默失效（需求 1.5）
      applyingRemote = false
    }

    if (patchFailed) {
      // 上报刻意放在 finally 之后：`onError` 回调里完全可能再触发一次 mutation，
      // 那时守卫必须已经是 `false`，否则用户在错误处理里做的修改会被静默丢弃
      report(patchError, 'apply')
      // 应用失败时状态可能只被部分改写，「storage 已持有当前内容」不再成立，
      // 因此不把它当作基线，只清掉旧的待写排期并把基线置为未知，让下一次变更重新写出
      writer.adopt(null)
      return
    }

    adoptLocalBaseline()
  }

  return {
    applyRemote,
    isApplying: () => applyingRemote,
  }
}

/**
 * `chrome.storage.onChanged` 监听器的签名。
 *
 * 与 `chrome.storage.onChanged.addListener` 期望的回调形状一致，因此本工厂的返回值
 * 可以直接交给它注册（注册与移除的时机属于生命周期部分，不在本层）。
 */
export type StorageChangeHandler = (changes: Record<string, StorageChange>, areaName: string) => void

/** `createStorageChangeHandler()` 的配置 */
export interface StorageChangeHandlerConfig {
  /** 本实例配置的存储区域；只有 `areaName` 与它一致的事件才会被处理 */
  area: StorageArea
  /** 该 store 在 storage 中的键，即 `` `${prefix}${store.$id}` `` */
  storeKey: string
  /** 远端应用器，见 `createRemoteApplier()` */
  applier: RemoteApplier
  /** 是否已清理。读取式守卫，保证清理后回调彻底静默（需求 5.4） */
  isDisposed: () => boolean
  /**
   * 统一错误出口。仅用于兜住「异常冒泡到 Chrome 事件派发器」这一路径，
   * 正常的失败上报由 `applyRemote` 内部完成。
   */
  report: StorageReporter
}

/**
 * 创建 `onChanged` 的分发回调。
 *
 * 这一层只做**过滤与分发**，不含任何状态：三层过滤全部命中后才把 `newValue` 交给
 * `applier.applyRemote()`，回声判定、守卫、`syncRemoval`、基线更新都在应用器内部。
 *
 * 三层过滤（需求 11.4、11.5）：
 * 1. `areaName !== area` → 忽略。`chrome.storage.onChanged` 是**全局**事件，一次注册会收到
 *    `local` / `sync` / `session` / `managed` 全部区域的变化。少了这一层，同时注册 `local` 与
 *    `sync` 两个插件实例时，任一区域的写入都会被两个实例同时应用，造成跨区域串扰。
 * 2. `storeKey` 不在 `changes` 里 → 忽略。同一区域内所有 store（以及扩展里其他代码写的键）
 *    共享同一个事件流，只有本 store 的键才与本实例有关。
 * 3. `newValue` 为空（`undefined` / `null`）→ 忽略。
 *
 * 第 3 层对应远端删除事件（`chrome.storage[area].remove(key)` / `clear()`），设计 D8 明确
 * **本期不处理**，理由是：把 store 重置成什么状态没有唯一正确答案（清空？回默认值？），
 * 而「有人清了 storage」通常是卸载/重置流程的一部分，此时把 store 也清掉反而会立刻被写回去。
 * 需要这一行为的使用者可以自行监听并调用 `$reset()`。**这是有意为之，不是疏漏。**
 */
export function createStorageChangeHandler(cfg: StorageChangeHandlerConfig): StorageChangeHandler {
  const { area, storeKey, applier, isDisposed, report } = cfg

  return (changes: Record<string, StorageChange>, areaName: string) => {
    // 清理之后什么都不做。与生命周期里的 `removeListener` 构成双保险：即使事件已经在
    // 派发队列里、或移除动作稍晚一步，回调也不会再改 state、不会再引发写入（需求 5.4）
    if (isDisposed()) return

    // 第 1 层：区域过滤
    if (areaName !== area) return
    // 第 2 层：键过滤
    if (!changes || !Object.prototype.hasOwnProperty.call(changes, storeKey)) return

    const newValue = changes[storeKey]?.newValue
    // 第 3 层：远端删除事件本期不处理（设计 D8，理由见上方注释）
    if (newValue === undefined || newValue === null) return

    try {
      applier.applyRemote(newValue)
    } catch (error) {
      // 这里**只**兜「不让异常冒泡到 Chrome 的事件派发器」这一件事，且一律经 `report` 上报，
      // 绝不 `console.error` 后静默——旧实现用一个笼统 catch 包住整个回调，把本该到达 `onError`
      // 的失败全吃掉了。`applyRemote` 内部已对序列化失败与 `$patch` 抛错做了各自的 `report`，
      // 因此走到这里的只可能是应用器自身的意外缺陷，属于「不该发生但也不该静默」的情况。
      report(error, 'apply')
    }
  }
}

/**
 * `store.$subscribe` 回调的形状。
 *
 * 刻意声明为**无参数**函数：它与 Pinia 的 `SubscriptionCallback`（会被传入 `mutation` 与 `state`）
 * 类型兼容——JS/TS 里少声明参数总是可赋值的——同时从类型层面就断掉「读 mutation」的可能，
 * 也不会留下未使用的参数变量。
 */
export type SubscriptionHandler = () => void

/** `createSubscriptionHandler()` 的配置 */
export interface SubscriptionHandlerConfig {
  /** 远端应用器；只读取它的 `isApplying()` 作为守卫 */
  applier: RemoteApplier
  /** 该 store 的写入器 */
  writer: StorageWriter
  /** 是否已清理。清理后不再排期任何写入（需求 5.4） */
  isDisposed: () => boolean
}

/**
 * 创建 `store.$subscribe` 的回调。
 *
 * **本函数刻意不接收、也无法读取 `mutation`**（需求 1.6）。这是本次加固的核心变更之一：
 * 旧实现靠 `mutation.type === 'patch object'` 去 payload 里找 Symbol 标记、靠
 * `'patch function'` 去 state 上找同一个 Symbol，两条路径都很脆弱——
 * - `$patch(fn)` 的 payload 是个函数，mutation 里看不到任何被改动的键，判断只能退化成猜测；
 * - Symbol 标记真的落在响应式 state 上，靠订阅回调 `delete` 掉它。一旦某次清理漏跑，
 *   标记就永久残留，之后每一次 `patch function`（包括 `$reset`）都会被误判成「来自 storage」，
 *   持久化**静默永久失效**且没有任何报错。
 *
 * 新实现只看闭包内的两个布尔守卫，与 mutation 的类型和 payload 形状完全无关，
 * 也不往 state 写任何东西（需求 12.1–12.3）。
 */
export function createSubscriptionHandler(cfg: SubscriptionHandlerConfig): SubscriptionHandler {
  const { applier, writer, isDisposed } = cfg

  return () => {
    // 清理之后不再排期写入；与取消订阅构成双保险（需求 5.4）
    if (isDisposed()) return
    // 本次变更来自 `applyRemote` 的 `$patch`：丢弃，不排期任何写入（需求 1.1）。
    // 依据 Pinia v3 的 `$patch` 同步触发订阅这一行为，守卫的置位窗口完整覆盖本回调的执行；
    // 即便该行为在未来版本失效，写入器的内容级去重（`lastSynced`）仍会兜住，最坏多写一轮。
    if (applier.isApplying()) return
    writer.schedule()
  }
}

/** `createLoader()` 的配置 */
export interface LoaderConfig {
  /** 该 store 在 storage 中的键，即 `` `${prefix}${store.$id}` ``；加载只读这一个键 */
  storeKey: string
  /** 实际读取动作，通常是 `chrome.storage[area].get`；reject 时以 `phase: 'load'` 上报 */
  get: (key: string) => Promise<Record<string, any>>
  /** 该 store 的写入器；加载结束时经 `arm()` 解锁写路径 */
  writer: StorageWriter
  /** 远端应用器。加载到的值走**同一条**应用逻辑，不另写一份 */
  applier: RemoteApplier
  /** 加载完成时若已有本地修改，仲裁方向 */
  onLoadConflict: 'local' | 'storage'
  /** 统一错误出口，见 `createReporter()` */
  report: StorageReporter
  /**
   * 告警出口（非错误）。仅用于「保留本地值、跳过 storage 中的值」这一条提示。
   *
   * 与 `report` 分开的理由同 `WriterConfig.warn`：这是一次**正常**的仲裁结果，
   * 不该混进错误回调把使用者的告警管道污染成「启动即报错」。缺省为 `console.warn`。
   */
  warn?: (message: string) => void
  /**
   * 是否已清理。可选；未提供时视为始终未清理。
   *
   * `get` 是异步的，其间 store 所属的 scope 完全可能已被 dispose。此时再把远端值
   * `$patch` 进 state 就违反了「清理后不修改 `store.$state`」（需求 5.4），因此在
   * 应用之前再查一次。`arm()` 仍会照常调用——写入器 dispose 之后 `schedule()` 自身会短路，
   * 因此这一步无副作用。
   */
  isDisposed?: () => boolean
}

/**
 * 创建首次加载流程，返回一个 `load(): Promise<void>`，其返回值即 `$storageReady`（需求 6.1）。
 *
 * **返回的 Promise 永不 reject**：`get` 失败、应用远端值失败都只经 `report` 上报，Promise 仍 resolve。
 * 这样使用者忘记 `.catch()` 也不会产生未处理 rejection——而 `$storageReady` 恰恰是最容易被
 * 「只 `await` 一次就不管了」的那种 Promise。
 *
 * 门控（需求 6.2）由写入器的初始状态承担：`armed` 天生为 `false`，加载期间的本地 mutation
 * 只会置 dirty 而不写出，因此本流程无需额外加锁，只需在结束时解锁。
 *
 * 解锁**必须在 `finally` 里**（需求 6.3）：即使 `get` reject 或应用远端值抛错，写路径也一定要被打开。
 * 否则该 store 的持久化会永久静默失效——正是本次加固要消灭的那类失败模式。
 *
 * 仲裁（需求 6.4–6.6）以**store 级 dirty 布尔**为粒度，不做顶层键级（需求 6.9）。
 * 理由：`$subscribe` 的 mutation 形状无法可靠推导出「哪些顶层键被本地改过」——`patch function`
 * 路径的 payload 是个函数，被改动的键完全不可见；直接赋值路径虽有 `events`，但形状随 Vue 版本
 * 与嵌套深度变化。键级仲裁只能建立在这类不可靠的启发式上，一旦推导错误就是静默的数据覆盖，
 * 比「整个 store 保留本地值」这种可预测的粗粒度行为更糟。
 */
export function createLoader(cfg: LoaderConfig): () => Promise<void> {
  const { storeKey, get, writer, applier, onLoadConflict, report } = cfg
  const warn = cfg.warn || ((message: string) => console.warn(message))
  const isDisposed = cfg.isDisposed || (() => false)

  return async () => {
    try {
      const result = await get(storeKey)

      // get 是异步的，其间 scope 可能已被 dispose：此时不再改动 state（需求 5.4）
      if (isDisposed()) return

      const value = result ? result[storeKey] : undefined
      // 「值为空」的判定与 `onChanged` 分发保持一致（只认 `undefined` / `null`）：
      // 空对象 `{}` 是一份合法快照（例如所有顶层键都被 pick / omit 过滤掉），不该被当成缺失。
      const hasValue = value !== undefined && value !== null

      // dirty 必须在 `await` **之后**读取：加载期间的本地 mutation 正是发生在这段等待里，
      // 提前读到的只会是发起 get 那一刻的状态，仲裁就永远命中不到冲突分支。
      const dirtyBeforeReady = writer.isDirty()

      if (hasValue && (!dirtyBeforeReady || onLoadConflict === 'storage')) {
        // 复用远端应用器的同一条应用逻辑：回声判定、`applyingRemote` 守卫、`syncRemoval`、
        // 以及「基线 = 应用后本地快照的 json」（需求 6.4）都已在应用器内部处理
        applier.applyRemote(value)
      } else {
        if (hasValue) {
          // 每个 store 的加载只发生一次，因此这条告警天然只会出现一次，无需额外去重（需求 6.5）
          warn(
            `[pinia-chrome-storage] store "${storeKey}" 在首次加载完成前已有本地修改，` +
              `已保留本地值并跳过 storage 中的值，本地值随后会被写出。` +
              `如需让 storage 中的值覆盖本地修改，请设置 onLoadConflict: 'storage'。`
          )
        }
        // 基线未知 → 本地内容在下一次写出时不会被内容级去重跳过（需求 6.5、6.7）。
        // 这里刻意**不用** `adopt(null)`：那会连带清掉 dirty，使下面的 `arm()` 不再补排，
        // 加载期间那次本地修改就被永久丢弃了。
        writer.invalidateBaseline()
      }
    } catch (error) {
      // `$storageReady` 仍会 resolve（需求 6.8）
      report(error, 'load')
    } finally {
      // 解锁写路径；若加载期间已 dirty，`arm()` 内部会立即补排一次写入（需求 6.3）
      try {
        writer.arm()
      } catch (error) {
        // `arm()` 会同步走到 `write()`（`debounce: 0` 时），理论上其中的失败都已被内部消化；
        // 这里只是最后一道保险，确保任何意外都不会让 `$storageReady` 变成 rejected
        report(error, 'write')
      }
    }
  }
}

/** `createLifecycle()` 的配置 */
export interface LifecycleConfig {
  /**
   * 拆卸动作抛错时的告警出口。
   *
   * **刻意不用 `report` / `onError`**：清理阶段的失败对使用者没有可操作性——store 已经在销毁，
   * 无论 `removeListener` 是否成功，调用方都无事可做。把它送进 `onError` 只会让「组件卸载」
   * 这种正常流程在遥测里表现为一串错误。但也不能完全静默：拆卸失败意味着某个监听器可能仍然挂着，
   * 这是排查泄漏时唯一的线索，因此降级为一条告警。缺省为 `console.warn`。
   */
  warn?: (message: string, error: unknown) => void
}

/** 生命周期管理件对外接口。每个「store × 插件实例」一份 */
export interface Lifecycle {
  /**
   * 是否已清理。
   *
   * 这就是 `StorageChangeHandlerConfig.isDisposed` / `SubscriptionHandlerConfig.isDisposed` /
   * `LoaderConfig.isDisposed` 所消费的那个读取函数。暴露的是**只读取值函数**而不是可写标记：
   * 置位只能经 `cleanup()` 发生，接线件拿不到写入通道，因此不存在「外部把 disposed 清掉
   * 导致清理后的回调又活过来」的路径。
   */
  isDisposed(): boolean
  /**
   * 注册一个拆卸动作。按注册顺序在 `cleanup()` 中各执行一次。
   *
   * 做成「收集回调」而不是把 `onChanged` / `$subscribe` / `writer` 等具体资源写死在本组件里，
   * 是因为这些资源的注册时机分散在主流程各处（`onChanged` 始终注册、`$subscribe` 与 hide 类
   * 监听器只在非只读模式注册），谁注册谁把自己的拆卸动作挂上来，本组件不需要知道它们存在。
   *
   * 已清理之后再注册：**立即执行**该动作而不是丢弃。这条路径真实存在——`load()` 是异步的，
   * 其 `await` 期间 scope 可能已 dispose，若此时还有代码去注册监听器，把拆卸动作静默丢掉
   * 就等于泄漏一个监听器。立即执行使「注册即被清理」，不变式「cleanup 后无残留资源」始终成立。
   */
  onTeardown(teardown: () => void): void
  /**
   * 执行全部拆卸动作并置 `disposed`。幂等：连续调用任意多次不抛错，最终状态与调用一次相同。
   *
   * 同时也是 `$stopStorageSync()` 的实现（需求 5.2）。
   */
  cleanup(): void
}

/**
 * 创建生命周期管理件：持有 `disposed` 标记、收集拆卸动作、并在所属 effect scope 结束时自动清理。
 *
 * **这是缺陷 3 的修法。** 旧实现从插件里 `return () => chrome.storage.onChanged.removeListener(...)`，
 * 看起来是个清理函数，实际从未被调用：Pinia 应用插件时执行的是
 * `assign(store, scope.run(() => extender(...)))`，即把插件返回值当作「要挂到 store 上的属性对象」。
 * `Object.assign(store, fn)` 只拷贝源对象的自有可枚举属性，而函数没有这类属性，于是那个
 * `removeListener` 被整个丢弃——`chrome.storage.onChanged` 监听器永久泄漏，store 每次重建
 * 都会再叠加一个，旧监听器仍持有已销毁 store 的引用并继续 `$patch` 它。
 * 正确的清理入口有两个：`onScopeDispose()`（自动）与挂到 store 上的 `$stopStorageSync()`
 * （手动，由插件主流程装配），二者都走同一个 `cleanup()`。
 *
 * 依据（设计「依据的 Pinia v3 内部行为」结论 3）：插件是在 store 自己的 effectScope 内被调用的
 * （`scope.run(() => extender(...))`），因此插件内可以直接使用 `onScopeDispose`，拿到的正是
 * 「该 store 被 `$dispose()` / pinia 实例销毁」这一时机。同一结论也意味着 `store.$subscribe`
 * 不加 `detached` 也不会随某个组件卸载而失效——它挂在 store 的 scope 上，而不是调用它的组件上。
 *
 * `getCurrentScope()` 的判断不是多余的防御：`onScopeDispose` 在没有活动 scope 时会
 * `warn` 一条「onScopeDispose() is called when there is no active effect scope」。
 * 本组件在单元测试里、以及任何脱离 store 直接构造的场景下都会遇到这种情况，
 * 跳过注册比让 Vue 打一条无意义的警告更合适（手动 `cleanup()` 仍然可用）。
 */
export function createLifecycle(cfg: LifecycleConfig = {}): Lifecycle {
  const warn = cfg.warn || ((message: string, error: unknown) => console.warn(message, error))

  let disposed = false
  /** 待执行的拆卸动作，按注册顺序。`cleanup()` 会把它整体取走并清空，保证每个动作只执行一次 */
  let teardowns: Array<() => void> = []

  /**
   * 逐个执行时都要兜住异常：一个 `removeListener` 在某些环境下抛错（例如事件对象已被宿主回收）
   * 不能阻断其余动作——否则排在它后面的 `writer.dispose()` 不会执行，定时器就留下来了。
   */
  const runTeardown = (teardown: () => void) => {
    try {
      teardown()
    } catch (error) {
      warn('[pinia-chrome-storage] 清理过程中的某个拆卸动作抛出异常，已跳过并继续清理其余资源', error)
    }
  }

  const cleanup = () => {
    // 幂等的第一道保证：重复调用直接短路，拆卸动作不会被执行第二次
    if (disposed) return

    // **必须先置位，再执行拆卸动作。** 拆卸动作本身可能同步触发回调：
    // `writer.dispose()` 之外，`removeListener` 之前已经进入派发队列的 `onChanged`、
    // 以及取消订阅时 Pinia 内部可能触发的回调，都会走到接线件的 `isDisposed()` 守卫上。
    // 顺序反了的话，这些回调会读到 `disposed === false` 从而继续排期写入或改 state，
    // 违反「清理后既不写入也不改 state」（需求 5.4）。
    disposed = true

    // 先取走再清空：执行期间若某个拆卸动作又调用了 onTeardown，新动作会走「已 disposed → 立即执行」
    // 分支，不会被追加进这个正在遍历的列表里
    const pending = teardowns
    teardowns = []

    for (const teardown of pending) {
      runTeardown(teardown)
    }
  }

  const onTeardown = (teardown: () => void) => {
    // 已清理：立即执行，避免静默丢弃一个刚注册的资源（理由见接口注释）
    if (disposed) {
      runTeardown(teardown)
      return
    }
    teardowns.push(teardown)
  }

  // 无活动 scope 时跳过注册，避免 Vue 打出「no active effect scope」告警
  if (getCurrentScope()) {
    onScopeDispose(cleanup)
  }

  return {
    isDisposed: () => disposed,
    onTeardown,
    cleanup,
  }
}

/** `registerHideFlush()` 的配置 */
export interface HideFlushConfig {
  /**
   * flush 动作，通常直接是 `writer.flush`。
   *
   * 约定它自身消化写入失败（`createWriter` 的 `chain` 内部已 `catch` 并上报），
   * 因此本层对返回的 Promise 只做「防未处理 rejection」的兜底，不做业务处理。
   */
  flush: () => Promise<void>
  /** 生命周期管理件；两个监听器的 `removeEventListener` 都经它的 `onTeardown()` 注册（需求 5.1） */
  lifecycle: Pick<Lifecycle, 'onTeardown'>
  /**
   * 是否启用。取 `ResolvedOptions.flushOnHide`，该字段已在选项规范化阶段归一为布尔
   * （只读模式下已被强制为 `false`，因此本层无需再判断 `readOnly`，需求 11.3）。
   */
  enabled: boolean
  /**
   * 意外情况的告警出口。缺省为 `console.warn`。
   *
   * 正常路径下永远不会被调用：`flush()` 的失败已在写入器内部经 `report` 上报并转入退避重试。
   * 走到这里说明 flush 抛出了不该抛出的异常，属于「不该发生但也不该静默」的情况。
   */
  warn?: (message: string, error: unknown) => void
}

/**
 * 注册 hide 类时机的 flush 监听器（需求 7.2、7.3）。
 *
 * 只做「注册 + 把移除动作挂到 lifecycle 上」这一件事。`$flushStorage()` 到 `writer.flush()` 的
 * 映射属于插件主流程的装配，不在本层。
 *
 * ## 环境判断
 *
 * 判断的是 `typeof document !== 'undefined'` 而**不是** `window`：MV3 的 service worker 里
 * 全局对象是 `ServiceWorkerGlobalScope`，既没有 `document` 也没有 `window`；而某些环境
 * （测试用的最小宿主、部分打包器注入的 shim）可能只有 `document`。因此两者分别判断：
 * - 没有 `document` → 整体跳过注册，且不抛错（需求 7.3）。`visibilitychange` 必须挂在
 *   `document` 上，没有它就没有任何可用的 hide 信号。
 * - 有 `document` 但没有 `window`（或其 `addEventListener` 不可用）→ 只跳过 `pagehide`，
 *   仍然注册 `visibilitychange`。少注册一个监听器好过整体放弃 flush 兜底。
 *
 * ## 已知局限（需求 7.5：这是承诺边界，不是实现细节）
 *
 * 1. **flush 不保证送达。** `flush()` 内部的 `chrome.storage.set` 仍是**异步**的：hide 类事件
 *    的回调是同步的，能保证的只是「在上下文销毁前**发起**了写入」，无法保证浏览器在销毁
 *    页面/popup 之前把这次 IPC 真正完成。popup 关闭是最典型的场景——它的销毁非常快。
 * 2. **MV3 service worker 没有可靠的 suspend 钩子。** 那里既没有 `document` 也没有
 *    `pagehide`；`chrome.runtime.onSuspend` 不保证触发（worker 可能被直接终止），因此
 *    service worker 上下文里根本不存在等价的兜底时机。
 * 3. **结论：关键数据应缩短 `debounce`（甚至设 `debounce: false`），而不是依赖 flush 兜底。**
 *    hide 类 flush 只是一层「尽力而为」的补救，把它当成持久化保证会在上述两种情况下丢数据。
 */
export function registerHideFlush(cfg: HideFlushConfig): void {
  const { flush, lifecycle, enabled } = cfg
  const warn = cfg.warn || ((message: string, error: unknown) => console.warn(message, error))

  // 只读模式与显式关闭都在这一步被拦下（`enabled` 已由 resolveOptions 归一为布尔）
  if (!enabled) return
  // 无 `document` 的上下文（MV3 service worker、node 测试环境）：跳过注册且不抛错（需求 7.3）
  if (typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') return

  /**
   * 事件回调是**同步**的，而 `flush()` 返回 Promise —— 必须显式处理它。
   *
   * 不处理会有两个后果：其一，某些环境把未处理 rejection 升级为进程级错误
   * （node 的 `--unhandled-rejections=throw`、测试运行器的失败断言）；其二，浏览器控制台会
   * 在页面卸载时打出一条无人负责的 `Unhandled promise rejection`，把使用者引向错误的方向。
   *
   * 选择「吞掉并降级为告警」而不是上报到 `onError`：写入失败已经由写入器内部 `report` 上报过
   * 一次并进入退避重试，再报一次会让同一次失败在遥测里出现两条。因此这里只兜住
   * 「flush 本身抛出了不该抛出的异常」这一意外，且不向调用栈抛出——异常冒泡到事件派发器
   * 会污染宿主的其他监听器。
   */
  const runFlush = () => {
    try {
      const result = flush()
      // 防御式判断：flush 的实现若返回非 Promise（自定义注入 / 未来改动），不能在这里崩掉
      if (result && typeof result.then === 'function') {
        void result.catch((error: unknown) => {
          warn('[pinia-chrome-storage] hide 时机的 flush 失败，已忽略', error)
        })
      }
    } catch (error) {
      warn('[pinia-chrome-storage] hide 时机的 flush 同步抛出异常，已忽略', error)
    }
  }

  // `visibilitychange` 在「隐藏 → 可见」时同样会触发，只有转为隐藏才需要 flush（需求 7.2）。
  // 变为可见时 flush 没有意义：内容级去重会让它变成一次空转，而在 `debounce: 0` 的配置下
  // 还会白白多发一次 IPC。
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden') return
    runFlush()
  }

  // `pagehide` 是无条件 flush：它本身就意味着页面正在被卸载或进入 back/forward cache，
  // 不存在「其实还留在前台」的情况，因此不需要额外的状态判断。
  const onPageHide = () => {
    runFlush()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  // 移除时传入的必须是**同一个函数引用**，且 options 与添加时一致（这里两侧都不传，
  // 即都用默认的 `capture: false`）；否则 `removeEventListener` 会静默失配，监听器留下来
  lifecycle.onTeardown(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  // `pagehide` 只能挂在 `window` 上。有 `document` 却没有 `window` 时只跳过这一个监听器，
  // 不影响上面已经注册好的 `visibilitychange`
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    const target = window
    target.addEventListener('pagehide', onPageHide)
    lifecycle.onTeardown(() => {
      target.removeEventListener('pagehide', onPageHide)
    })
  }
}


/**
 * Pinia Chrome 存储插件。
 *
 * 把 store 的状态双向同步到 `chrome.storage`：本地变更经节流写出，其他上下文的写入经
 * `chrome.storage.onChanged` 应用回本地。
 *
 * ## 实际行为（不是懒加载）
 *
 * 插件在每个 store 安装时**立即发起一次异步加载**（`chrome.storage[area].get(storeKey)`），
 * 并不等待首次访问 state，也没有任何 Proxy 拦截。就绪信号是挂到 store 上的
 * `$storageReady: Promise<void>`（永不 reject）。首次加载完成前写路径处于未解锁状态：
 * 本地变更只被记为「待写」而不写出，加载结束时再按 `onLoadConflict` 仲裁并解锁。
 *
 * ## 装配顺序（每个 store 一份闭包，彼此完全隔离）
 *
 * `storeKey` → 生命周期 → 错误出口 → 写入器 → 远端应用器 → 写路径订阅（非只读）→
 * `onChanged` 注册（始终）→ hide 类 flush（非只读）→ 发起加载。
 * 所有可变状态都在闭包内，没有任何模块级共享的可变量（需求 3.8、4.8）。
 *
 * ## 防循环同步（双层，均不写 state）
 *
 * 1. `applyingRemote`：应用远端快照期间为 `true`，其间触发的订阅回调全部丢弃（需求 1.1）。
 * 2. `lastSynced`：内容级去重。入站内容等于基线即判为自己那次写入的回声并忽略；
 *    写出时内容等于基线则跳过 `set`（需求 1.2–1.4）。
 *
 * 第 1 层依赖 Pinia v3「`$patch` 同步触发订阅」这一行为，第 2 层与框架无关，
 * 因此即使第 1 层失效也只会多写一轮，不会出现回环，更不存在旧实现那种
 * 「Symbol 标记残留 → 持久化永久静默失效」的失败模式（需求 12.1–12.3）。
 *
 * ## 存储结构
 *
 * 只写本实例配置区域中的一个键：`` { [`${prefix}${store.$id}`]: 裸快照 } ``（需求 11.6、13.2）。
 *
 * @param options 插件配置选项，全部可选；新增选项的默认值按存储区域区分
 * @returns Pinia 插件函数。它为每个 store 返回 `{ $storageReady, $flushStorage, $stopStorageSync }`
 *   这一**属性对象**（需求 5.5）——Pinia 会把它 `assign` 到 store 上。清理入口是
 *   `store.$stopStorageSync()`，不再是（旧实现里从未被调用的）返回值清理函数
 * @throws {Error} 工厂阶段：非扩展环境、非法存储区域、非法 `debounce` / `maxWait`
 */
export function piniaChromeStoragePlugin(options: PiniaChromeStorageOptions = {}) {
  // 环境检查、区域校验、`managed` 只读判定与按区域默认值全部在这里完成。
  // 抛错时机与改造前一致（注册插件时，而不是第一个 store 创建时）
  const resolved = resolveOptions(options)
  // 区域对象在工厂阶段取一次即可：它自身无状态，多个 store 共用同一个引用没有副作用。
  // 标注为最小的 `StorageArea` 接口，避免按联合类型索引后落到 `LocalStorageArea | SyncStorageArea | ...`
  // 这种重载联合上（四者都继承自 `StorageArea`，`get` / `set` 的签名取自同一处）
  const chromeStorage: chrome.storage.StorageArea = chrome.storage[resolved.area]

  return (context: PiniaPluginContext) => {
    const { store } = context
    // 本 store 在 storage 中的唯一键；写入与读取都只碰这一个键
    const storeKey = `${resolved.prefix}${store.$id}`

    // 先建生命周期：它在构造时就把 `cleanup` 注册到当前 effect scope（插件运行在 store 自身的
    // scope 内），因此后续任何一步注册的资源都能通过 `onTeardown` 被同一条清理路径收走。
    // 放在最前面还有一个作用：`writer` / `applier` 的接线件需要它的 `isDisposed` 读取函数
    const lifecycle = createLifecycle()

    const report = createReporter({
      storeId: store.$id,
      storeKey,
      area: resolved.area,
      onError: resolved.onError,
    })

    /**
     * 惰性快照读取。**写入器与远端应用器必须共用同一个函数实例**：
     * 两者算出的 json 要能直接比较，共用一份 filter + serializer 是前提（需求 8.5）。
     * 分别构造两个等价函数也能工作，但一旦将来有人只改其中一处，基线比较就会静默失效。
     */
    const readCurrent = () => normalize(store.$state, resolved.filter, resolved.serializer)

    const writer = createWriter({
      storeKey,
      // 只写本实例配置区域中的这一个键；写入内容是裸快照（需求 11.6、13.2）
      set: (data) => chromeStorage.set(data),
      readCurrent,
      wait: resolved.wait,
      maxWait: resolved.maxWait,
      report,
    })

    const applier = createRemoteApplier({
      store,
      writer,
      readCurrent,
      filter: resolved.filter,
      serializer: resolved.serializer,
      syncRemoval: resolved.syncRemoval,
      report,
    })

    // 写路径：只读模式（`managed`）下完全不注册，避免产生必然失败的写入（需求 11.3）
    if (!resolved.readOnly) {
      const unsubscribe = store.$subscribe(
        createSubscriptionHandler({ applier, writer, isDisposed: lifecycle.isDisposed }),
        // **必须是 `flush: 'sync'`**。Pinia 默认 `flush: 'pre'`，回调会被推迟到 nextTick，
        // 而加载仲裁读的是 `writer.isDirty()`：延迟记账会让「加载期间的本地修改」在仲裁那一刻
        // 还没被记下，仲裁于是误判为「无本地修改」并用远端值覆盖它（需求 6.5 的丢更新路径）。
        // 同步 flush 让 dirty 追踪确定化，开销可忽略——回调只做两次布尔读加一次排期，
        // 真正昂贵的解包与序列化是惰性的，发生在 `write()` 里
        { flush: 'sync' }
      )
      lifecycle.onTeardown(unsubscribe)
    }

    // 读路径：**始终**注册，只读模式同样需要接收其他上下文/企业策略的变更
    const onStorageChanged = createStorageChangeHandler({
      area: resolved.area,
      storeKey,
      applier,
      isDisposed: lifecycle.isDisposed,
      report,
    })
    chrome.storage.onChanged.addListener(onStorageChanged)
    // 这就是缺陷 3 的修法：移除动作挂在生命周期上，由 scope dispose 或 `$stopStorageSync()` 触发，
    // 而不是指望「插件返回的清理函数」被调用（那个返回值会被 Pinia 当成属性对象处理，函数无效）
    lifecycle.onTeardown(() => {
      chrome.storage.onChanged.removeListener(onStorageChanged)
    })

    // hide 类 flush 逃生口：只读模式下 `flushOnHide` 已被 resolveOptions 归一为 false，
    // 这里的 `readOnly` 判断只是让「不注册写路径」这一意图在主流程里读起来是显式的
    if (!resolved.readOnly) {
      registerHideFlush({
        flush: () => writer.flush(),
        lifecycle,
        enabled: resolved.flushOnHide,
      })
    }

    // 写入器的定时器也经同一条清理路径收走，保证清理后不残留任何活动定时器（需求 5.1）
    lifecycle.onTeardown(() => {
      writer.dispose()
    })

    // 立即发起首次加载，**不 await**：插件安装必须是同步返回的。
    // 返回的 Promise 永不 reject，直接作为 `$storageReady` 暴露（需求 6.1、6.8）
    const ready = createLoader({
      storeKey,
      get: (key) => chromeStorage.get(key),
      writer,
      applier,
      onLoadConflict: resolved.onLoadConflict,
      report,
      isDisposed: lifecycle.isDisposed,
    })()

    // 返回属性对象而非清理函数（需求 5.5）；三个属性与 `types.ts` 中对
    // `PiniaCustomProperties` 的增强一一对应
    return {
      $storageReady: ready,
      $flushStorage: () => writer.flush(),
      // `lifecycle.cleanup` 自身幂等，连续调用任意多次都安全（需求 5.3）
      $stopStorageSync: lifecycle.cleanup,
    }
  }
}
