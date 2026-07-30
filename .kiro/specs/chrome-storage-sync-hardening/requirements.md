# 需求文档：chrome-storage-sync-hardening

## 简介

本需求文档由已确认的 `design.md` 反向抽取，不引入新的设计决策。目标是把「对 `src/piniaChromeStoragePlugin.ts` 做加固重写」这件事拆成可验证的行为约束：消除丢更新、跨 store 串扰、监听器泄漏、Symbol 标记残留、写失败静默丢数据这五类缺陷，并把防循环同步机制换成「闭包内同步布尔守卫 + 内容级去重」双层方案。

对外 API 向后兼容：`piniaChromeStoragePlugin(options)` 调用形态、`storage` / `prefix` 语义、storage 中的数据结构均不变；新增选项全部可选。唯一的破坏性行为变更是「远端快照缺失键」的处理默认值（见需求 10 与需求 13）。

设计中的 D1–D8 结论为本文档的前提，本文档不与其冲突。

## 术语表

- **插件**：`piniaChromeStoragePlugin(options)` 返回的 Pinia 插件函数，及其为每个 store 创建的闭包实例。
- **写入器 / Writer**：`createWriter()` 返回的对象，负责节流、去重、惰性快照、串行化写入、失败退避、flush、adopt。每个「store × 插件实例」一份。
- **storeKey**：该 store 在 `chrome.storage` 中的键，值为 `` `${prefix}${store.$id}` ``。
- **快照 / snapshot**：经字段过滤与 `unpackProxy` 处理后的普通对象，即实际写入 storage 的值。
- **json**：快照经 `serializer.serialize` 得到的字符串，用于内容级去重比较。
- **lastSynced**：写入器闭包内保存的「最近一次认定为已同步」的 json；`null` 表示「未知/需重写」。
- **applyingRemote**：写入器闭包外、插件闭包内的同步布尔守卫，仅在把远端快照应用到 store 的过程中为 `true`。
- **adopt**：应用远端值后的收尾动作，清定时器、作废待写内容、把 `lastSynced` 更新为应用后的本地快照 json。
- **arm / armed**：写入器的解锁状态；首次加载完成前为 `false`，此时只记 dirty 不写出。
- **回声 / echo**：由本插件自己的写入触发、随后被本上下文收到的 `chrome.storage.onChanged` 事件。
- **只读模式**：`storage === 'managed'` 时的运行模式，只加载与监听，不注册任何写路径。
- **规范化路径 / normalize**：字段过滤 + `unpackProxy` + 序列化的统一处理链，写方向与读方向必须共用。

## 需求

### 需求 1：防循环同步

**用户故事：** 作为扩展开发者，我希望 store 与 `chrome.storage` 的双向同步不会自我激发，这样多个上下文之间不会出现无限写入回环，也不会因为「往响应式 state 里塞标记」而让持久化永久失效。

#### 验收标准

1. WHILE 插件正在把远端快照应用到 store，THE 插件 SHALL 丢弃该过程中触发的所有 store 订阅回调，且不排期任何写入。
2. WHEN 收到 `onChanged` 且入站快照的 json 等于 `lastSynced`，THE 插件 SHALL 忽略该事件并保持 `store.$state` 不变。
3. WHEN 本地 mutation 触发的写出时刻，当前快照的 json 等于 `lastSynced`，THE 插件 SHALL 跳过该次 `chrome.storage.set` 调用。
4. THE 插件 SHALL 保证连续两次实际发起的写入所对应的 json 互不相同。
5. IF 应用远端快照期间 `store.$patch` 抛出异常，THEN THE 插件 SHALL 复位 `applyingRemote` 为 `false`，并以 `phase: 'apply'` 调用错误上报。
6. THE 插件 SHALL 仅依据闭包内的 `applyingRemote` 与 `lastSynced` 判定变更来源，不依据 `mutation.type` 或 mutation payload 的形状。

### 需求 2：不丢更新

**用户故事：** 作为扩展用户，我希望在节流窗口内到达的远端更新不会被一份过期的本地快照覆盖，这样我在另一个上下文里的修改不会凭空消失。

#### 验收标准

1. WHEN 写出时刻到达，THE 写入器 SHALL 在该时刻才对 `store.$state` 做深拷贝与序列化，而不使用 mutation 发生时刻拍下的快照。
2. WHEN 远端快照被应用到 store 完成，THE 插件 SHALL 清除该 store 的待写定时器、把 dirty 复位，并把 `lastSynced` 设为应用后本地快照的 json。
3. WHEN 存在已排期但未写出的本地变更且此时应用了一份远端快照，THE 插件 SHALL 不把「应用该远端快照之前的本地快照」写入 storage。
4. WHEN 远端快照被应用后再次发生本地 mutation，THE 插件 SHALL 写出包含该远端快照内容的新快照。

### 需求 3：写入节流

**用户故事：** 作为扩展开发者，我希望高频 mutation 被合并为少量写入，同时任何一次变更的落盘延迟有确定上界，且不同 store 之间互不影响。

#### 验收标准

1. WHERE `debounce` 为正数，WHEN 发生本地 mutation，THE 写入器 SHALL 在最后一次 mutation 之后静默 `debounce` 毫秒时发起写出，并在静默期内到达的新 mutation 时重置该静默计时。
2. WHEN 写入器从非 dirty 进入 dirty，THE 写入器 SHALL 建立一个独立的 `maxWait` 上界定时器，使「首次 dirty → 发起写入」的间隔不超过 `maxWait` 毫秒，且该上界不依赖后续 mutation 的到来。
3. WHERE `storage` 为 `local` 或 `session` 且调用方未指定，THE 插件 SHALL 使用默认值 `debounce = 150`、`maxWait = 500`。
4. WHERE `storage` 为 `sync` 且调用方未指定，THE 插件 SHALL 使用默认值 `debounce = 1000`、`maxWait = 5000`。
5. WHERE `debounce` 为 `false` 或 `0`，WHEN 发生本地 mutation，THE 写入器 SHALL 立即发起写出而不设置静默定时器。
6. IF 传入的 `maxWait` 小于生效的 `debounce`，THEN THE 插件 SHALL 把 `maxWait` 规范化为等于 `debounce`。
7. IF 传入的 `debounce` 是小于 0 的数字，THEN THE 插件 SHALL 在工厂阶段抛出错误。
8. THE 插件 SHALL 为每个「store × 插件实例」维护独立的 `waitTimer`、`maxTimer`、`firstDirtyAt`、`dirty`、`armed`、`lastSynced`、`chain`、`retryCount`，且不使用任何模块级共享的可变状态。
9. WHILE 某个 store 持续以高于 `debounce` 的频率变更，THE 插件 SHALL 仍在其他 store 各自的 `maxWait` 内写出其他 store 的变更。

### 需求 4：写入可靠性

**用户故事：** 作为扩展开发者，我希望写入失败（尤其是 `sync` 区域的配额 rejection）可以被观测并自动重试，而不是静默丢数据。

#### 验收标准

1. THE 写入器 SHALL 把每次 `chrome.storage.set` 追加到同一条 promise chain 上，使任意时刻至多有一个未 settle 的 `set` 在飞行，且发起顺序与排期顺序一致。
2. IF `set` 返回的 Promise reject，THEN THE 写入器 SHALL 把 `lastSynced` 置为 `null`。
3. IF `set` 失败，THEN THE 写入器 SHALL 以 1s、2s、4s、8s、16s 的指数退避重新排期写入，最多重试 5 次。
4. WHEN `set` 成功 settle，THE 写入器 SHALL 把重试计数复位为 0。
5. IF 发生写入失败，THEN THE 插件 SHALL 调用 `onError` 并传入包含 `storeId`、`storeKey`、`area` 与 `phase: 'write'` 的上下文。
6. IF 调用方未提供 `onError`，THEN THE 插件 SHALL 退化为 `console.error`，且输出内容仅包含错误对象与上下文元信息，不包含 state 快照内容。
7. IF 写入失败源于 `sync` 区域配额限制（`MAX_WRITE_OPERATIONS_PER_MINUTE = 120`、`MAX_WRITE_OPERATIONS_PER_HOUR = 1800`、`QUOTA_BYTES_PER_ITEM = 8192`），THEN THE 插件 SHALL 在错误上报中附带可操作提示：调大 `debounce`、用 `pick` / `omit` 缩减持久化字段，或改用 `local` 区域。
8. THE 插件 SHALL 不引入跨 store 的模块级速率限制器，配额压力由默认节流参数与退避重试承担。

### 需求 5：生命周期与清理

**用户故事：** 作为扩展开发者，我希望 store 销毁后插件不再持有监听器与定时器，这样反复创建/销毁 store 不会造成泄漏与叠加写入。

#### 验收标准

1. WHEN store 所属的 effect scope 被 dispose，THE 插件 SHALL 移除 `chrome.storage.onChanged` 监听器、移除已注册的 `visibilitychange` 与 `pagehide` 监听器，并清除所有活动定时器。
2. THE 插件 SHALL 在 store 上暴露 `$stopStorageSync()`，其效果与 scope dispose 时的清理一致。
3. WHEN `$stopStorageSync()` 被连续调用任意多次，THE 插件 SHALL 不抛出异常，且最终状态与调用一次相同。
4. WHEN 清理完成之后发生本地 mutation 或收到 `onChanged` 事件，THE 插件 SHALL 不发起写入且不修改 `store.$state`。
5. THE 插件 SHALL 以「返回属性对象」的方式向 store 挂载扩展，不以「返回清理函数」的方式提供清理入口。

### 需求 6：加载与就绪

**用户故事：** 作为扩展开发者，我希望知道持久化数据何时加载完成，并且首次加载不会与用户刚做出的本地修改互相覆盖。

#### 验收标准

1. THE 插件 SHALL 在 store 上暴露 `$storageReady: Promise<void>`，并在首次加载流程结束时 resolve。
2. WHILE 首次加载未完成，THE 写入器 SHALL 保持 `armed = false`，对本地 mutation 只记录 dirty 而不发起写入。
3. WHEN 首次加载流程结束，THE 插件 SHALL 解锁写入器；IF 此时 dirty 为真，THEN THE 写入器 SHALL 立即排期一次写入。
4. WHEN 加载到非空值且加载期间没有本地 mutation，THE 插件 SHALL 把该值应用到 store 并把 `lastSynced` 设为应用后本地快照的 json。
5. WHERE `onLoadConflict` 为 `'local'`（未指定时的默认值），WHEN 加载完成时存在加载期间的本地 mutation，THE 插件 SHALL 保留本地值、告警一次，并把 `lastSynced` 置为 `null`。
6. WHERE `onLoadConflict` 为 `'storage'`，WHEN 加载完成时存在加载期间的本地 mutation，THE 插件 SHALL 用加载到的远端值覆盖本地值。
7. IF storage 中不存在该 storeKey 或其值为空，THEN THE 插件 SHALL 把 `lastSynced` 置为 `null`。
8. IF `chrome.storage.get` 返回的 Promise reject，THEN THE 插件 SHALL 以 `phase: 'load'` 上报错误，并仍然 resolve `$storageReady`。
9. THE 加载仲裁 SHALL 以 store 级的 dirty 布尔为粒度，不做顶层键级仲裁。

### 需求 7：flush 逃生口

**用户故事：** 作为扩展开发者，我希望在 popup 隐藏或页面卸载这类时机能主动把待写内容推出去，并清楚地知道这个机制的边界在哪里。

#### 验收标准

1. THE 插件 SHALL 在 store 上暴露 `$flushStorage(): Promise<void>`，调用时立即发起待写内容的写出，并在对应的 `set` settle 后 resolve。
2. WHERE `flushOnHide` 为 `true`（未指定时的默认值）且当前上下文存在 `document`，WHEN `visibilitychange` 触发且 `document.visibilityState` 为 `'hidden'`，或 `pagehide` 触发，THE 插件 SHALL 立即发起 flush。
3. WHERE 当前上下文不存在 `document`，THE 插件 SHALL 跳过 hide 类监听器的注册且不抛出异常。
4. WHEN 调用 `$flushStorage()` 时没有待写内容或当前快照的 json 等于 `lastSynced`，THE 插件 SHALL 不发起 `set` 调用并返回一个已 resolve 的 Promise。
5. THE 文档 SHALL 把以下内容记录为已知局限而非承诺：flush 内部的 `set` 仍是异步的，不保证在上下文销毁前发出；MV3 service worker 没有可靠的 suspend 钩子；关键数据应缩短 `debounce` 而不是依赖 flush 兜底。

### 需求 8：字段过滤

**用户故事：** 作为扩展开发者，我希望只持久化需要的顶层字段，这样能避开 `sync` 的单项字节配额、排除敏感字段、并避免瞬时 UI 状态触发写入。

#### 验收标准

1. WHERE 提供了 `pick`，THE 插件 SHALL 只把 `pick` 中列出的顶层键纳入快照。
2. WHERE 提供了 `omit`，THE 插件 SHALL 把 `omit` 中列出的顶层键从快照中排除。
3. WHERE 同时提供 `pick` 与 `omit`，THE 插件 SHALL 先应用 `pick` 再应用 `omit`。
4. THE 字段过滤 SHALL 只作用于顶层键，且对同一输入重复应用产生相同结果。
5. THE 插件 SHALL 对写方向的本地状态与读方向的远端快照使用同一条规范化路径（含字段过滤与序列化），使 `lastSynced` 的比较在两个方向上成立。

### 需求 9：序列化安全

**用户故事：** 作为扩展开发者，我希望包含 `Date` / `Map` / `Set` 等类型的字段要么被正确持久化，要么明确告诉我它没被持久化，而不是被静默毁坏成 `{}`。

#### 验收标准

1. WHEN 某个顶层键的值中包含 `Date`、`Map`、`Set`、`RegExp`、函数或 Symbol 值，THE 插件 SHALL 把该顶层键从快照中跳过。
2. WHEN 本次规范化存在被跳过的顶层键，THE 插件 SHALL 告警一次并列出被跳过的键名。
3. THE 插件 SHALL 不把上述不支持的类型序列化为 `{}` 后写入 storage。
4. WHERE 提供了 `serializer`，THE 插件 SHALL 使用其 `serialize` / `deserialize` 取代默认的 JSON 序列化路径。
5. IF 序列化过程抛出异常，THEN THE 插件 SHALL 以 `phase: 'serialize'` 上报错误并跳过该次写入。
6. THE 文档 SHALL 记录已知局限：默认 `JSON.stringify` 的键顺序（含整数样式键被引擎重排）可能导致「内容相同而 json 不同」，其后果是多写一次而非数据错误，需要严格判等的用户可通过 `serializer` 传入稳定序列化。

### 需求 10：合并语义与 `syncRemoval`

**用户故事：** 作为扩展开发者，我希望 store 新增字段后，来自旧上下文的同步事件不会把新字段抹掉。

#### 验收标准

1. WHERE 调用方未提供 `syncRemoval`，THE 插件 SHALL 采用默认值 `false`。
2. WHERE `syncRemoval` 为 `false`，WHEN 应用远端快照，THE 插件 SHALL 保留远端快照中不存在的本地顶层键及其原值。
3. WHERE `syncRemoval` 为 `true`，WHEN 应用远端快照，THE 插件 SHALL 删除远端快照中不存在的本地顶层键。
4. WHEN 远端快照应用完成，THE 插件 SHALL 以「应用后的本地快照 json」而非「入站远端快照的 json」作为 `lastSynced` 基线。

### 需求 11：存储区域

**用户故事：** 作为扩展开发者，我希望非法配置在启动时就被拒绝，`managed` 这种只读区域不会产生必然失败的写入，且不同区域之间不会串扰。

#### 验收标准

1. IF `storage` 的取值不在 `'local'`、`'sync'`、`'session'`、`'managed'` 之内，THEN THE 插件 SHALL 在工厂阶段抛出错误。
2. IF `chrome` 或 `chrome.storage` 不可用，THEN THE 插件 SHALL 在工厂阶段抛出错误。
3. WHERE `storage` 为 `'managed'`，THE 插件 SHALL 进入只读模式：注册加载与 `onChanged` 监听，不注册 store 订阅写路径与 hide 类 flush 监听器，并 `console.info` 提示一次；同时忽略所有写相关选项。
4. WHEN `onChanged` 回调的 `areaName` 与本实例配置的 `storage` 不一致，THE 插件 SHALL 忽略该事件。
5. WHEN `onChanged` 回调的 `changes` 不包含本 store 的 storeKey，THE 插件 SHALL 忽略该事件。
6. THE 插件 SHALL 只把本 store 的快照写入本实例配置的区域中的 `` `${prefix}${store.$id}` `` 这一个键。

### 需求 12：state 无污染

**用户故事：** 作为扩展开发者，我希望插件不往我的 state 里写任何东西，这样不存在「标记残留导致持久化永久失效」的失败模式。

#### 验收标准

1. THE 插件 SHALL 不向 `store.$state` 写入任何 Symbol 键。
2. THE 插件 SHALL 不向 `store.$state` 写入任何插件自身的元数据键。
3. THE 插件 SHALL 以闭包内的布尔守卫承载「变更来源」信息，不以写入 state 的标记承载该信息。

### 需求 13：向后兼容与迁移记录

**用户故事：** 作为现有使用者，我希望升级后现有调用与现有数据继续可用，并且被清楚告知哪些默认行为发生了变化。

#### 验收标准

1. THE 插件 SHALL 保持 `piniaChromeStoragePlugin(options)` 的调用形态不变，并保持 `storage` 与 `prefix` 的语义不变。
2. THE 插件 SHALL 保持 storage 中的数据结构为裸快照 `` { [`${prefix}${store.$id}`]: snapshot } ``，使现有用户数据可直接读取而无需迁移。
3. THE 新增选项 SHALL 全部可选，并在省略时使用按区域区分的默认值。
4. THE 文档 SHALL 把「远端快照缺失键的处理从『删除本地键』改为『保留本地键』（`syncRemoval` 默认 `false`）」明确记录为破坏性行为变更，并说明需要旧语义的使用者应显式传入 `syncRemoval: true`。
5. THE 文档 SHALL 记录默认节流时长从 50ms 改为 `local` / `session` 150ms、`sync` 1000ms，以及由 `maxWait` 提供的陈旧度上界。
6. THE 文档 SHALL 记录插件返回值从（此前从未被调用的）清理函数改为属性对象，替代的清理入口是 `store.$stopStorageSync()`。
7. THE 文档 SHALL 记录 `managed` 区域从「写入必然失败」改为只读模式。

### 需求 14：文档与注释修正

**用户故事：** 作为阅读源码的开发者，我希望注释描述的机制与实现一致，不会被不存在的「Proxy 懒加载」误导。

#### 验收标准

1. THE 源码注释 SHALL 不包含「通过 Proxy 实现懒加载」或「只在首次访问 store 状态时才从 storage 加载」等与实现不符的描述。
2. THE 源码注释 SHALL 描述实际的加载行为：插件安装时立即发起一次异步加载，就绪信号为 `$storageReady`。
3. THE README SHALL 提示 `sync` 区域经 Google 账号跨设备同步、不应存放凭据与令牌，并指向 `pick` / `omit` 作为排除敏感字段的手段。

### 需求 15：自动化测试覆盖（方案 B 范围）

**用户故事：** 作为维护者，我希望关键的时序缺陷有回归测试兜住，同时清楚地知道哪些属性本期没有自动化覆盖。

#### 验收标准

1. THE 仓库 SHALL 提供可运行的 jest + ts-jest 测试配置（`jest.config.js`，`testEnvironment: 'node'`）与 `npm test` 脚本。
2. THE 测试套件 SHALL 使用 jest 的 modern 假定时器与一个内存版 `chrome.storage` mock，该 mock 支持按区域读写、可控的 `onChanged` 广播、可注入的 `set` / `get` reject，以及 `set` 调用次数与监听器数量的断言。
3. THE 测试套件 SHALL 包含 6 至 8 个示例化单元测试，覆盖设计文档中的正确性属性 1、2、4、8、10。
4. THE 测试套件 SHALL 不引入 `fast-check`，且不包含属性化测试。
5. THE 设计文档 SHALL 列出本期未被自动化测试覆盖的正确性属性（属性 3、5、6、7、9、11、12）及其人工验证方式。
6. THE 测试任务 SHALL 在实现计划中被标记为可选子任务。

---

## 超出范围（本期不做）

以下条目已在设计中讨论并明确排除，不作为本期需求，也不应在实现或测试中被当作待办：

1. **方案 C 信封结构**（`{ __v, writerId, rev, data }`）与多上下文并发写的乱序/冲突消解（设计 D1）。本期保持裸快照，last-write-wins。
2. **嵌套路径级字段过滤**。`pick` / `omit` 只做顶层键（设计 D4）。
3. **跨浏览器兼容层**（`browser.*` / WebExtension polyfill）。
4. **`Date` / `Map` / `Set` 的完整往返序列化**。本期只做「告警 + 跳过该顶层键」，完整往返交由用户提供的 `serializer`（设计 D5）。
5. **远端删除事件的处理**（`onChanged` 中 `newValue === undefined`，来自 `remove()` / `clear()`）。本期忽略（设计 D8）。
6. **独立的 `sync` 速率限制器 / 令牌桶**。靠默认节流参数与指数退避承担（设计 D6）。
7. **字段级增量同步**。仍是整 store 快照写入。
8. **属性化测试与属性 3、5、6、7、9、11、12 的自动化覆盖**（测试策略采用方案 B）。
