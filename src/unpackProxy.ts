/**
 * 无法安全序列化的值的哨兵。
 *
 * `Date` / `Map` / `Set` / `RegExp` / 函数 / Symbol 值经 `JSON.stringify` 处理后
 * 会被静默毁坏（`Date` 变字符串、`Map` / `Set` / `RegExp` 变 `{}`、函数与 Symbol 被整键丢弃），
 * 因此 `unpackProxy` 不再对它们走 `Object.keys()`，而是返回本哨兵，
 * 由上层的 `normalize()` 据此剔除对应顶层键并告警（设计决策 D5：告警 + 跳过，不做自动转换）。
 *
 * 用 Symbol 而非某个对象常量，是为了保证它不可能与用户 state 中的任何值相等。
 */
export const UNSUPPORTED = Symbol('pinia-chrome-storage:unsupported')

/** 哨兵的类型 */
export type Unsupported = typeof UNSUPPORTED

/** 判断解包结果是否为哨兵（即该值/容器内含不可安全序列化的类型） */
export function isUnsupported(value: unknown): value is Unsupported {
    return value === UNSUPPORTED
}

/**
 * 借 `Object.prototype.toString` 的内部标签识别内置类型，
 * 比 `instanceof` 更稳：跨 realm（iframe / 扩展的不同上下文）时 `instanceof` 会失效。
 */
function isUnsupportedBuiltin(obj: object): boolean {
    switch (Object.prototype.toString.call(obj)) {
        case '[object Date]':
        case '[object Map]':
        case '[object Set]':
        case '[object RegExp]':
            return true
        default:
            return false
    }
}

/**
 * 解包 Pinia 响应式 Proxy，得到可写入 chrome.storage 的普通值。
 *
 * 行为约定：
 * - `null` / `undefined` / 基本类型 / 普通对象 / 数组：与改造前完全一致；
 * - 不可安全序列化的值（`Date` / `Map` / `Set` / `RegExp` / 函数 / Symbol 值）：返回 `UNSUPPORTED`；
 * - 数组元素或对象属性中任一解包结果为 `UNSUPPORTED` 时，整个容器解包为 `UNSUPPORTED`（向上传播）。
 *   这样调用方只需检查顶层键的解包结果是否为哨兵，即可判定「该顶层键含不支持类型」。
 */
export function unpackProxy(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj
    }

    // 函数与 Symbol 值无法序列化，直接上报哨兵
    if (typeof obj === "function" || typeof obj === "symbol") {
        return UNSUPPORTED
    }

    if (Array.isArray(obj)) {
        const unpacked = []
        for (const child of obj) {
            const unpackedChild = unpackProxy(child)
            // 任一元素不支持则整个数组不支持：数组无法「跳过某一项」而不改变语义（索引会错位）
            if (isUnsupported(unpackedChild)) {
                return UNSUPPORTED
            }
            unpacked.push(unpackedChild)
        }
        return unpacked
    }

    if (typeof obj === "object") {
        // 先于 Object.keys() 判定，避免 Date / Map / Set / RegExp 因自有可枚举键为空而变成 {}
        if (isUnsupportedBuiltin(obj)) {
            return UNSUPPORTED
        }

        const unpacked: {[key: string|number|symbol]: any} = {}
        for (const key of Object.keys(obj)) {
            const unpackedValue = unpackProxy(obj[key])
            // 嵌套属性不支持则整个对象不支持，继续向上传播到顶层键
            if (isUnsupported(unpackedValue)) {
                return UNSUPPORTED
            }
            unpacked[key] = unpackedValue
        }
        return unpacked
    }

    return obj
}
