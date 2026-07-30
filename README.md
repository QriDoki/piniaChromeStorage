# pinia-chrome-storage

[![npm version](https://badge.fury.io/js/pinia-chrome-storage.svg)](https://www.npmjs.com/package/pinia-chrome-storage)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个用于在 Chrome 扩展中同步 Pinia store 状态的插件。把 store 状态持久化到 `chrome.storage`，并在多个扩展上下文（popup、options、content script、service worker）之间双向同步。

## 特性

- 🔄 自动把 Pinia store 状态同步到 `chrome.storage`，并监听远端变化回填 store
- 🚦 就绪信号 `$storageReady`：插件安装时立即发起一次异步加载，加载完成前不会写出半成品状态
- 🔒 双层防循环同步：应用远端快照期间的同步布尔守卫 + 内容级去重，不往 state 里写任何标记
- ⏱️ 带上界的节流：`debounce` 合并高频写入，`maxWait` 给陈旧度一个确定上界
- 🎛️ `pick` / `omit` 顶层字段过滤，用于避开 `sync` 配额、排除敏感字段、跳过瞬时 UI 状态
- ♻️ 写失败可观测并自动指数退避重试，不静默丢数据
- 🧹 store 所属 effect scope 销毁时自动移除监听器与定时器，也可手动 `$stopStorageSync()`
- 🛠️ 支持多种存储区域（local、sync、session、managed；`managed` 为只读模式）
- 📦 无运行时依赖（仅依赖已有的 `pinia`，以及经 pinia 间接可用的 `vue`）
- 🎯 完整的 TypeScript 支持（含 store 扩展属性的类型增强）

## 安装

```bash
npm install pinia-chrome-storage
# 或
yarn add pinia-chrome-storage
# 或
pnpm add pinia-chrome-storage
```

## 快速开始

```typescript
import { createPinia } from 'pinia'
import { piniaChromeStoragePlugin } from 'pinia-chrome-storage'

const pinia = createPinia()
pinia.use(piniaChromeStoragePlugin({
  storage: 'local', // 可选：'local' | 'sync' | 'session' | 'managed'，默认为 'local'
  prefix: 'my-app-' // 可选：存储键名前缀，用于避免命名冲突
}))
```

## 使用示例

```typescript
import { defineStore } from 'pinia'

export const useCounterStore = defineStore('counter', {
  state: () => ({
    count: 0
  }),
  actions: {
    increment() {
      this.count++
    }
  }
})
```

等待首次加载完成后再渲染依赖持久化数据的界面：

```typescript
const settings = useSettingsStore()

// 插件安装时就已发起加载，这里只是等它结束；该 Promise 永不 reject
await settings.$storageReady

// 之后再挂载依赖持久化数据的组件
app.mount('#app')
```

`sync` 区域的典型配置（更长的节流 + 字段过滤 + 错误上报）：

```typescript
pinia.use(piniaChromeStoragePlugin({
  storage: 'sync',
  prefix: 'my-app-',
  omit: ['transientUiState', 'accessToken'],
  onError: (err, ctx) => {
    // ctx: { storeId, storeKey, area, phase, quotaKind?, hint? }
    console.warn(`[${ctx.phase}] ${ctx.storeId}`, ctx.hint, err)
  }
}))
```

## 配置选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `storage` | `'local' \| 'sync' \| 'session' \| 'managed'` | `'local'` | 使用的存储区域。取值非法或 `chrome.storage` 不可用时，在插件工厂阶段抛错。`'managed'` 为只读模式 |
| `prefix` | `string` | `''` | 存储键名前缀，实际键为 `` `${prefix}${store.$id}` `` |
| `debounce` | `number \| false` | `local` / `session`：`150`；`sync`：`1000` | 节流的静默等待时长（ms）。最后一次 mutation 之后静默该时长时写出。`false` 或 `0` 表示每次 mutation 立即写出。传入负数时在工厂阶段抛错 |
| `maxWait` | `number` | `local` / `session`：`500`；`sync`：`5000` | 从首次 dirty 起的写出上界（ms），消除饥饿并给陈旧度确定边界。小于生效的 `debounce` 时被规范化为等于 `debounce` |
| `pick` | `string[]` | 不限制 | 只持久化这些顶层键 |
| `omit` | `string[]` | 不排除 | 排除这些顶层键。与 `pick` 同时给出时，先 `pick` 再 `omit` |
| `syncRemoval` | `boolean` | `false` | 远端快照缺少某顶层键时，是否删除本地对应键。默认 `false` 为合并语义（保留本地键） |
| `onLoadConflict` | `'local' \| 'storage'` | `'local'` | 首次加载完成时若加载期间已有本地修改，如何仲裁。`'local'` 保留本地值，`'storage'` 用远端值覆盖。仲裁粒度为 store 级 |
| `serializer` | `{ serialize, deserialize }` | 默认 `JSON.stringify` / `JSON.parse` | 自定义序列化。**只影响用于内容级去重的比较基线，不改变写入 storage 的内容**，也不能让 `Date` / `Map` / `Set` 被持久化。详见「已知局限」 |
| `flushOnHide` | `boolean` | `true` | 是否在 `visibilitychange`（`hidden`）/ `pagehide` 时 flush 待写内容。仅在存在 `document` 的上下文生效；只读模式下不注册 |
| `onError` | `(error, context) => void` | 缺省退化为 `console.error` | 统一错误出口。`context` 含 `storeId` / `storeKey` / `area` / `phase`（`'load' \| 'write' \| 'apply' \| 'serialize'`），配额类写入失败时还带 `quotaKind` 与可操作的 `hint`。默认输出只含错误对象与上下文元信息，不含 state 快照 |

字段过滤只作用于**顶层键**，不支持嵌套路径。

## store 上新增的属性

插件会给每个 store 挂上三个属性（已通过 `declare module 'pinia'` 提供类型）：

| 属性 | 类型 | 说明 |
|------|------|------|
| `$storageReady` | `Promise<void>` | 首次加载完成的信号。**永不 reject**，加载失败也会 resolve，错误经 `onError` 上报 |
| `$flushStorage()` | `() => Promise<void>` | 立即写出待写内容，在对应的 `chrome.storage.set` settle 后 resolve。没有待写内容或内容与上次已同步的相同时，不发起 `set`，直接返回已 resolve 的 Promise |
| `$stopStorageSync()` | `() => void` | 手动停止同步：移除 `onChanged` 与 hide 类监听器、取消 store 订阅、清除所有定时器。**幂等**，连续调用任意多次都不抛错 |

```typescript
const settings = useSettingsStore()

await settings.$storageReady   // 首次加载完成
await settings.$flushStorage() // 敏感时机主动落盘
settings.$stopStorageSync()    // 需要提前停止同步时（scope 销毁时会自动做一次）
```

## 工作原理

1. **数据持久化**：store 状态变化时按 `debounce` / `maxWait` 节流合并，在写出时刻才对 `$state` 做快照并写入 `chrome.storage`
2. **状态同步**：监听 `chrome.storage.onChanged`，区域与键匹配的变化会被应用回 store
3. **立即加载 + 就绪信号**：插件安装时立即发起一次异步加载（没有懒加载）。加载完成前只记录 dirty 不写出，就绪信号是 `store.$storageReady`
4. **循环同步防护**：两层机制。第一层是闭包内的同步布尔守卫，应用远端快照期间产生的 store 订阅回调会被丢弃；第二层是内容级去重，写出与应用前都拿当前内容与「最近一次已同步内容」比较，相同则跳过。两层都不往 `$state` 里写任何标记
5. **写入串行化与重试**：所有 `set` 追加到同一条 promise chain，任意时刻至多一个写入在飞行；失败时以 1s / 2s / 4s / 8s / 16s 指数退避重试，最多 5 次，并经 `onError` 上报

## `sync` 区域的安全与配额

`sync` 区域的数据会经用户的 Google 账号跨设备同步。**不要在 `sync` 里存放凭据、令牌、密钥等敏感数据。**

需要把敏感字段排除在持久化之外，用 `pick` 或 `omit`：

```typescript
pinia.use(piniaChromeStoragePlugin({
  storage: 'sync',
  omit: ['accessToken', 'refreshToken'] // 这些顶层键不会被写入 storage
}))
// 或者反过来只白名单需要同步的键
pinia.use(piniaChromeStoragePlugin({
  storage: 'sync',
  pick: ['theme', 'language']
}))
```

`sync` 还有硬配额，超出即写入失败（会经 `onError` 上报并附带提示）：

| 限制 | 值 |
|------|-----|
| `QUOTA_BYTES_PER_ITEM` | 8192 字节（单个键的值） |
| `MAX_WRITE_OPERATIONS_PER_MINUTE` | 120 |
| `MAX_WRITE_OPERATIONS_PER_HOUR` | 1800 |

字节类超限重试无益，必须用 `pick` / `omit` 缩减字段或改用 `local`；写频类超限可由退避重试恢复，长期解法是调大 `debounce`。

## 破坏性变更与迁移

存储中的**数据结构没有变化**（仍是裸快照 `` { [`${prefix}${store.$id}`]: snapshot } ``），现有用户数据可直接读取，无需迁移。`piniaChromeStoragePlugin(options)` 的调用形态、`storage` 与 `prefix` 的语义也保持不变，新增选项全部可选。

以下四项行为发生了变化：

### 1. `syncRemoval` 默认 `false`（唯一的破坏性行为变更）

- **原来**：应用远端快照时，会删除「远端快照里没有的本地顶层键」。这导致 store 新增字段后，任何一次来自旧上下文的 `onChanged` 都会把新字段抹掉——schema 演进时的真实数据丢失路径。
- **现在**：默认合并语义，远端快照中不存在的本地顶层键保持原值。
- **需要做什么**：确实需要「远端为唯一真相」的旧删除语义，显式传 `syncRemoval: true`。

### 2. 默认节流从 50ms 改为按区域区分

- **原来**：固定 50ms debounce。对 `local` 几乎起不到合并作用，对 `sync` 会踩写频配额。
- **现在**：`local` / `session` 为 `debounce: 150`、`maxWait: 500`；`sync` 为 `debounce: 1000`、`maxWait: 5000`。`maxWait` 给「从首次变更到发起写入」提供确定上界，所以持久化稍晚但陈旧度有界。
- **需要做什么**：一般无需处理。对延迟敏感的数据可自行调小 `debounce`。

### 3. 插件返回值从清理函数改为属性对象

- **原来**：插件返回一个清理函数。Pinia 会把插件返回值当作「要挂到 store 上的属性对象」处理（`Object.assign(store, fn)` 对函数是空操作），所以那个清理函数从未被调用，监听器永久泄漏。
- **现在**：返回属性对象 `{ $storageReady, $flushStorage, $stopStorageSync }`。清理由 store 所属 effect scope 的 `onScopeDispose` 自动完成，手动入口是 `store.$stopStorageSync()`。
- **需要做什么**：若有代码接住插件返回值当函数调用（此前调用也不会生效），改用 `store.$stopStorageSync()`。

### 4. `managed` 从「写入必然失败」改为只读模式

- **原来**：`managed` 被放行为普通区域，但它由企业策略下发且只读，因此每次写入都必然失败。
- **现在**：进入只读模式——只加载与监听 `onChanged`，不注册写路径与 hide 类 flush 监听器，并在插件工厂阶段 `console.info` 提示一次。所有写相关选项被忽略。
- **需要做什么**：无。不再产生无意义的失败写。

## 已知局限

以下都是本版本的真实边界，不是承诺。

### flush 不保证送达

`flushOnHide` 会在 `visibilitychange`（`hidden`）与 `pagehide` 时发起 flush，但内部的 `chrome.storage.set` 仍然是异步的。它只保证「在上下文销毁前**发起**写入」，不保证写入**完成**——popup 关闭尤其快。

MV3 service worker 里没有可靠的 suspend 钩子：那里既没有 `document` 也没有 `pagehide`，`chrome.runtime.onSuspend` 也不保证触发，因此不存在等价的兜底时机。

**结论**：关键数据应缩短 `debounce`（必要时 `debounce: false` 每次变更立即写），而不是依赖 flush 兜底。

### `serializer` 的作用范围很窄

`serialize` 的产物**只**用于内容级去重比较，**不是**写入 storage 的内容——写入的始终是普通对象快照（`chrome.storage` 本身存的就是对象）。所以自定义 `serializer` 的真实用途只有一个：**提供稳定的键序**。

默认 `JSON.stringify` 的键顺序取决于属性插入顺序（且整数样式的键会被引擎重排到前面并升序排列），因此可能出现「内容相同而 json 不同」。其后果是**多写一次，不是数据错误**——写出后基线立即更新，回声会被正确识别。需要严格判等可以传入递归排序键的实现：

```typescript
const stableStringify = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

pinia.use(piniaChromeStoragePlugin({
  serializer: {
    serialize: (snapshot) => stableStringify(snapshot),
    deserialize: (json) => JSON.parse(json)
  }
}))
```

`deserialize` 当前没有调用点（数据通路上不存在「字符串 → 对象」这一步），保留它是为了接口对称。

### `Date` / `Map` / `Set` 不会被持久化，`serializer` 也救不了

含 `Date`、`Map`、`Set`、`RegExp`、函数或 Symbol 值的**顶层键会被整键跳过**，插件会告警一次并列出被跳过的键名。这一剔除发生在调用 `serialize` **之前**，所以**任何 serializer 都无法让这些键被持久化**。

要持久化这类值，只能在 store 里自行存成可 JSON 化的形式：

```typescript
state: () => ({
  updatedAt: Date.now(),        // 时间戳，不是 Date
  tagsByIdEntries: [] as [string, string][] // 数组，不是 Map
})
```

设计上选择「告警 + 跳过」而不是自动转换，是为了避免类型漂移：写出去是字符串、读回来变成字符串塞进 state，会让 `state.someDate.getTime()` 在离插件很远的地方崩掉。

### 远端删除事件不处理

`chrome.storage[area].remove()` / `clear()` 触发的 `newValue === undefined` 事件本版本被忽略，store 不会被重置。原因是「该重置成什么状态没有唯一正确答案」，而清 storage 通常是卸载/重置流程的一部分，此时把 store 也清掉反而会立刻被写回去。需要这个行为可以自行监听 `chrome.storage.onChanged` 并调用 `store.$reset()`。

### 多上下文并发写是 last-write-wins

本版本不给存储值加写入方身份与版本号信封。两个上下文同时写同一个 store 时，最后落地的那次会全量覆盖另一次，顺序由 IPC 决定。

## 注意事项

- 确保在 Chrome 扩展环境中使用；`chrome.storage` 不可用时插件在工厂阶段抛错
- 需要在 `manifest.json` 中声明适当的 `storage` 权限（`session` 区域还需注意其默认访问级别只对扩展页面可见）
- 建议只同步必要的数据，用 `pick` / `omit` 排除瞬时 UI 状态与敏感字段
- 使用 `prefix` 避免与其他扩展或同扩展内其他用途的存储键名冲突
- 同时注册多个插件实例（例如一个写 `local`、一个写 `sync`）是安全的：每个「store × 插件实例」持有独立的写入器状态

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 代码检查
npm run lint
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT
