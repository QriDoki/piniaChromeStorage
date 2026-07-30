# 实现计划：chrome-storage-sync-hardening

## 概述

按「依赖对齐 → 类型层 → 规范化层 → 选项与错误出口 → 写入器 → 远端应用器 → 加载与就绪 → 生命周期 → 主流程装配 → 注释与文档 → 测试 → 收尾校验」的顺序增量改造 `src/`。

绝大多数编码任务集中在 `src/piniaChromeStoragePlugin.ts` 同一个文件上，因此编号顺序即执行顺序，不要并行改写同一文件。任务 12 之前的每一步都应保持 `npm run build` 可通过（允许中途存在尚未被调用的新函数，但不允许类型错误）。

实现语言为 TypeScript（沿用仓库现有配置，`design.md` 的参考骨架已是 TS，无需再选语言）。

## 任务

- [x] 1. 前置修复：对齐 pinia 实际安装版本
  - [x] 1.1 把 `pinia` 的实际安装版本刷新到已声明的 peer 范围 `^3.0.1`
    - 现状：`package.json` 的 `peerDependencies.pinia` 已是 `^3.0.1`，但 `package-lock.json` 中 `node_modules/pinia` 解析到 `2.3.1`，且锁文件里根包记录的 peer 仍是 `^2.0.0`（锁文件未随 `package.json` 升级刷新）
    - 执行命令：`npm install --save-dev pinia@^3.0.1`
    - **中等风险说明**：该命令会修改 `package-lock.json`、写入 `node_modules`，并把 `pinia` 加入 `devDependencies`；不要改动 `peerDependencies.pinia` 已有的 `^3.0.1` 声明，也不要回滚 `package.json` / `src/` 下本次之前就存在的未提交改动
    - 完成判定：`node_modules/pinia/package.json` 的 `version` 为 `3.x`，且 `npm run build` 仍通过
    - 理由：设计的方案 A（同步布尔守卫）依赖 Pinia v3 `$patch` 同步触发订阅这一行为，若跑在 2.3.1 上则验证不到目标版本
    - _Requirements: 1.1, 15.1, 15.3_

- [x] 2. 类型层
  - [x] 2.1 扩展 `src/types.ts` 的选项与辅助类型
    - `PiniaChromeStorageOptions` 新增可选字段：`debounce?: number | false`、`maxWait?: number`、`pick?: string[]`、`omit?: string[]`、`syncRemoval?: boolean`、`onLoadConflict?: 'local' | 'storage'`、`serializer?: StateSerializer`、`flushOnHide?: boolean`、`onError?: (error: unknown, context: StorageErrorContext) => void`
    - 新增 `StateSerializer`（`serialize` / `deserialize`）、`StorageErrorContext`（`storeId` / `storeKey` / `area` / `phase: 'load' | 'write' | 'apply' | 'serialize'`）、`Normalized`（`snapshot` / `json` / `droppedKeys`）
    - 保留 `StorageArea`、`StorageChange`、`StorageChangeEvent` 现有定义与 `storage` / `prefix` 语义不变
    - 每个新增字段的 JSDoc 写明默认值（含按区域区分的默认值）
    - _Requirements: 3.3, 3.4, 8.1, 8.2, 9.4, 10.1, 13.3_

  - [x] 2.2 添加 Pinia 类型增强
    - 在 `src/types.ts` 中 `declare module 'pinia'`，为 `PiniaCustomProperties` 增加 `$storageReady: Promise<void>`、`$flushStorage(): Promise<void>`、`$stopStorageSync(): void`
    - 确保该模块声明被 `src/index.ts` 的导出链带入（必要时在 `src/index.ts` 导出 `./types`）
    - _Requirements: 5.2, 6.1, 7.1_

- [x] 3. 序列化安全的底层支持
  - [x] 3.1 改造 `src/unpackProxy.ts`，识别不可安全序列化的值并以哨兵上报
    - 识别 `Date`、`Map`、`Set`、`RegExp`、函数、Symbol 值，返回一个模块内导出的哨兵（如 `UNSUPPORTED`），不再走 `Object.keys()` 产出 `{}`
    - 数组与嵌套对象中出现哨兵时向上传播，使调用方可判定「该顶层键含不支持类型」
    - 保持对 `null` / `undefined` / 基本类型 / 普通对象 / 数组的既有行为不变
    - _Requirements: 9.1, 9.3_

- [x] 4. 规范化层
  - [x] 4.1 在 `src/piniaChromeStoragePlugin.ts` 中实现 `normalize()`
    - 签名按设计：`normalize(raw, filter, serializer): Normalized`
    - 顶层键过滤：先 `pick` 再 `omit`，只作用于顶层键，对同一输入重复应用结果一致
    - 过滤后调用 `unpackProxy`，把含哨兵的顶层键剔除并收集到 `droppedKeys`
    - 调用 `serializer.serialize` 得到 `json`；默认 serializer 使用 `JSON.stringify` / `JSON.parse`
    - 序列化抛错时向调用方抛出可识别的错误，供上层以 `phase: 'serialize'` 上报并跳过本次写入
    - 写方向（本地 state）与读方向（远端 `newValue`）必须共用这一条路径，不得各写一份
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.4, 9.5_

- [x] 5. 选项规范化与错误出口
  - [x] 5.1 实现选项规范化与校验
    - 保留 `checkChromeEnvironment()` 与 `validateStorageArea()` 在工厂阶段抛错的行为
    - `storage === 'managed'` 判定为只读模式（不抛错），`console.info` 提示一次，并忽略所有写相关选项
    - 按区域填默认值：`local` / `session` → `debounce: 150`、`maxWait: 500`；`sync` → `debounce: 1000`、`maxWait: 5000`
    - `debounce === false` 归一为 `0`；`maxWait < 生效 debounce` 时归一为等于 `debounce`；`debounce` 为小于 0 的数字时在工厂阶段抛错
    - `syncRemoval` 默认 `false`、`onLoadConflict` 默认 `'local'`、`flushOnHide` 默认 `true`
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 11.1, 11.2, 11.3_

  - [x] 5.2 实现统一错误出口
    - 构造 `report(error, phase)`，组装 `StorageErrorContext`（`storeId` / `storeKey` / `area` / `phase`）后交给 `options.onError`
    - 未提供 `onError` 时退化为 `console.error`，输出仅含错误对象与上下文元信息，**不得**输出 state 快照内容
    - `phase === 'write'` 且错误可判定为 `sync` 配额类（`MAX_WRITE_OPERATIONS_PER_MINUTE` / `MAX_WRITE_OPERATIONS_PER_HOUR` / `QUOTA_BYTES_PER_ITEM`）时，在上报中附带可操作提示：调大 `debounce`、用 `pick` / `omit` 缩减字段、或改用 `local`
    - _Requirements: 4.5, 4.6, 4.7_

- [x] 6. 写入器
  - [x] 6.1 实现 `createWriter()` 的排期与写出主体
    - 暴露 `schedule` / `write` / `flush` / `adopt` / `arm` / `dispose`
    - 全部状态（`waitTimer`、`maxTimer`、`firstDirtyAt`、`dirty`、`armed`、`lastSynced`、`chain`、`retryCount`、`disposed`）收进闭包，**禁止任何模块级可变状态**
    - `schedule()`：未 `armed` 时只记 dirty；`wait === 0` 时立即 `write()`；否则重置 `waitTimer`，并在 `firstDirtyAt === 0` 时设置一个独立的 `maxTimer` 作为 `maxWait` 上界（上界不依赖后续 mutation）
    - `write()`：先 `clearTimers()`，此刻才调用 `readCurrent()` 做惰性快照 + 序列化；`json === lastSynced` 时跳过 `set` 并返回已 resolve 的 Promise；`droppedKeys` 非空时告警一次并列出键名
    - `adopt(json)`：清定时器、`dirty = false`、`lastSynced = json`
    - `arm()`：置 `armed = true`，若 dirty 则立即 `schedule()`
    - `dispose()`：置 `disposed = true` 并清定时器，重复调用无副作用
    - `flush()`：返回 `write()` 派生的 `Promise<void>`
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 3.5, 3.8, 3.9, 7.4_

  - [x] 6.2 实现写入串行化、失败处理与指数退避
    - 所有 `set` 一律经 `chain = chain.then(...)` 追加，无旁路直接调用，保证至多一个未 settle 的 `set` 在飞行且发起顺序等于排期顺序
    - `set` 成功后把 `retryCount` 复位为 0
    - `set` reject 时把 `lastSynced` 置 `null`、以 `phase: 'write'` 上报，并按 1s / 2s / 4s / 8s / 16s 指数退避重新排期，最多 5 次
    - 不引入任何跨 store 的模块级速率限制器
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.8_

- [x] 7. 检查点 — 确保构建与静态检查通过
  - 运行 `npm run build` 与 `npm run lint`，确认新增的类型层、规范化层与写入器无类型错误与 lint 错误。若出现问题，先修复再继续；有疑问时询问用户。

- [x] 8. 远端应用器
  - [x] 8.1 实现 `applyRemote()` 与 `applyingRemote` 守卫
    - 入站快照先走 `normalize`；`json === lastSynced` 时直接 return（回声判定）
    - 置 `applyingRemote = true` → `store.$patch(fn)` 逐个顶层键赋值 → `finally` 复位为 `false`
    - `syncRemoval === true` 时删除远端快照中不存在的本地顶层键；为 `false` 时保留原值
    - `$patch` 抛错时守卫仍复位，并以 `phase: 'apply'` 上报
    - 应用完成后调用 `writer.adopt(应用后本地快照的 json)`，而不是入站快照的 json
    - 不向 `store.$state` 写入任何 Symbol 键或元数据键
    - _Requirements: 1.1, 1.2, 1.5, 10.2, 10.3, 10.4, 12.1, 12.2, 12.3_

  - [x] 8.2 实现 `onChanged` 分发与订阅写路径接线
    - `onChanged` 回调中：`areaName` 与本实例配置不一致时忽略；`changes` 不含 storeKey 时忽略；`newValue` 为空时忽略（远端删除事件本期不处理）
    - `store.$subscribe` 回调中只做「`applyingRemote` 或已清理 → return，否则 `writer.schedule()`」，不读取 `mutation.type`，不读取 mutation payload 形状
    - _Requirements: 1.6, 11.4, 11.5_

- [x] 9. 加载与就绪
  - [x] 9.1 实现 `load()` 与 `$storageReady`
    - `chromeStorage.get(storeKey)`；有非空值且（load 期间无本地 mutation 或 `onLoadConflict === 'storage'`）时复用 8.1 的应用逻辑并设置 `lastSynced`
    - `onLoadConflict === 'local'` 且 load 期间已有本地 mutation 时：告警一次、保留本地值、`lastSynced = null`
    - storage 中无该 storeKey 或值为空时：`lastSynced = null`
    - `get` reject 时以 `phase: 'load'` 上报，且 `$storageReady` 仍 resolve（永不 reject）
    - `finally` 中调用 `writer.arm()`，dirty 则立即排期一次写入
    - 仲裁粒度为 store 级 dirty 布尔，不做顶层键级
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

- [x] 10. 生命周期
  - [x] 10.1 实现清理路径
    - `cleanup()`：移除 `chrome.storage.onChanged` 监听器、移除已注册的 hide 类监听器、取消 `$subscribe`、`writer.dispose()`，并置内部 `disposed` 标记
    - 通过 `onScopeDispose(cleanup)` 注册（插件运行在 store 自身 effectScope 内）
    - `cleanup()` 幂等：连续调用任意多次不抛错，最终状态与调用一次相同
    - 清理后发生的本地 mutation 与 `onChanged` 事件既不发起写入也不修改 `store.$state`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 10.2 实现 flush 逃生口
    - `$flushStorage()` 直接映射到 `writer.flush()`，在对应 `set` settle 后 resolve；无待写内容或内容与 `lastSynced` 相同时不发起 `set` 并返回已 resolve 的 Promise
    - `flushOnHide !== false` 且存在 `document` 时注册 `visibilitychange`（仅 `visibilityState === 'hidden'`）与 `pagehide`，两者都调用 flush
    - 无 `document` 的上下文跳过注册且不抛错；只读模式下不注册
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 11.3_

- [x] 11. 插件主流程装配
  - [x] 11.1 装配插件主流程并移除旧机制
    - 按设计伪码组织：`storeKey` → 只读判定 → `createWriter` → 写路径订阅（非只读）→ `onChanged` 注册（始终）→ hide 类监听（非只读）→ `onScopeDispose(cleanup)` → 发起 `load()`
    - 返回属性对象 `{ $storageReady, $flushStorage, $stopStorageSync }`，不再返回清理函数
    - 彻底删除 `SYNC_STORAGE_KEY` 与模块级 `pendingStorageUpdate` / `storageUpdateTimer`，删除对 `SubscriptionCallbackMutationPatchObject` 的依赖
    - 写入内容保持裸快照结构 `{ [`${prefix}${store.$id}`]: snapshot }`，只写本实例配置区域的这一个键
    - 全仓 grep `Symbol(`、`SYNC_STORAGE_KEY`，确认无残留
    - _Requirements: 3.8, 4.8, 5.5, 11.6, 12.1, 12.2, 12.3, 13.1, 13.2, 13.3_

- [x] 12. 检查点 — 确保构建与静态检查通过
  - 运行 `npm run build` 与 `npm run lint`，确认改写后的插件主流程无类型错误与 lint 错误。若出现问题，先修复再继续；有疑问时询问用户。

- [x] 13. 注释与文档
  - [x] 13.1 修正源码注释
    - 删除「通过 Proxy 实现懒加载」「只在首次访问 store 状态时才从 storage 加载」等与实现不符的描述
    - 改写为实际加载行为：插件安装时立即发起一次异步加载，就绪信号为 `$storageReady`
    - 为 `applyingRemote` 双层防循环、`lastSynced` 去重、`maxWait` 上界补充说明性注释
    - _Requirements: 14.1, 14.2_

  - [x] 13.2 更新 `README.md`
    - 补充 `sync` 区域经 Google 账号跨设备同步、不应存放凭据与令牌的提示，并指向 `pick` / `omit` 作为排除敏感字段的手段
    - 补充新增选项说明与按区域区分的默认值
    - 记录破坏性变更与迁移信息：`syncRemoval` 默认 `false`（需要旧删除语义者显式传 `true`）、默认节流从 50ms 改为 `local` / `session` 150ms 与 `sync` 1000ms 并由 `maxWait` 提供陈旧度上界、插件返回值从清理函数改为属性对象（改用 `store.$stopStorageSync()`）、`managed` 改为只读模式
    - 记录已知局限：flush 内 `set` 仍是异步的、MV3 service worker 无可靠 suspend 钩子、关键数据应缩短 `debounce`；默认 `JSON.stringify` 的键顺序可能导致多写一次，可用 `serializer` 传入稳定序列化
    - _Requirements: 7.5, 9.6, 13.4, 13.5, 13.6, 13.7, 14.3_

- [x] 14. 测试基础设施与回归测试
  - [x]* 14.1 添加 jest 配置与 test 脚本
    - 新增 `jest.config.js`：`preset: 'ts-jest'`、`testEnvironment: 'node'`、`roots: ['<rootDir>/tests']`、`testMatch: ['**/*.test.ts']`、`clearMocks: true`
    - `package.json` 新增 `"test": "jest"`（如需本地监听可另加 `test:watch`，不在 CI 中使用）
    - 不引入 `fast-check`，不引入 `vitest`，不引入 `jest-environment-jsdom`
    - 若 ts-jest 因 `tsconfig.json` 的 `include: ["src/*.ts"]` 报 include 相关告警，则新增 `tsconfig.test.json`（`extends` 主配置、`include` 加上 `tests`）并在 jest 配置中指向它
    - _Requirements: 15.1, 15.4_

  - [x]* 14.2 实现内存版 `chrome.storage` mock
    - 新增 `tests/chromeMock.ts`，导出 `createChromeMock()` 并可赋给 `globalThis.chrome`
    - 四个区域各一份内存 `Map`，`get` / `set` / `remove` 返回 Promise
    - `onChanged.addListener` / `removeListener`，并暴露测试侧「手动广播」入口（可指定 `areaName` 与 `changes`），用于模拟另一个上下文的写入
    - 可注入失败：让下一次或后续 N 次 `set` / `get` 返回 reject
    - 可断言：记录 `set` 的调用次数、顺序与参数快照；可读取当前监听器数量
    - _Requirements: 15.2_

  - [-]* 14.3 编写 T1、T2：远端应用不触发写回
    - 新增 `tests/remote-apply.test.ts`
    - **属性 1：远端应用不触发写回**
    - T1：应用远端快照期间 `set` 调用次数为 0
    - T2：`$patch` 在应用远端值时抛错后守卫仍复位，下一次远端变更可正常处理
    - **Validates: Requirements 1.1, 1.5, 10.4**
    - _Requirements: 1.1, 1.5, 10.4, 15.3_

  - [-]* 14.4 编写 T3：回声不被重新应用
    - 新增 `tests/echo.test.ts`
    - **属性 2：回声不被重新应用**
    - T3：本插件写出后广播回声 `onChanged`，store 状态与写出前完全一致
    - **Validates: Requirements 1.2, 8.5**
    - _Requirements: 1.2, 8.5, 15.3_

  - [-]* 14.5 编写 T4、T5：远端更新不被旧快照覆盖
    - 新增 `tests/lost-update.test.ts`，使用 `jest.useFakeTimers()` 与 `jest.advanceTimersByTimeAsync()`
    - **属性 4：远端更新不被旧快照覆盖**
    - T4：本地变更已排期未写出 → 收到远端更新 → 推进定时器，storage 内容不等于收到远端更新前的本地快照
    - T5：远端更新到达后再发生一次本地变更，写出的是含远端值的新快照（`adopt` 后基线正确）
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 15.3_

  - [-]* 14.6 编写 T6、T7：写失败不被当作已同步
    - 新增 `tests/write-failure.test.ts`
    - **属性 8：写失败不被当作已同步**
    - T6：注入 `set` reject，`onError` 被调用且 `phase` 为 `'write'`，退避到点后重新发起写入
    - T7：写失败后同一内容不被去重跳过，会被重新写出
    - **Validates: Requirements 4.2, 4.3, 4.5**
    - _Requirements: 4.2, 4.3, 4.5, 15.3_

  - [x]* 14.7 编写 T8：清理幂等且彻底
    - 新增 `tests/cleanup.test.ts`
    - **属性 10：清理幂等且彻底**
    - T8：`$stopStorageSync()` 连续调用 3 次不抛错；调用后 `onChanged` 监听器数为 0、无活动定时器、后续 mutation 不产生 `set`
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 15.3_

- [ ] 15. 收尾校验
  - [~] 15.1 运行构建、静态检查与测试
    - 运行 `npm run build`（tsc）确认通过
    - 运行 `npm run lint` 确认通过
    - 若任务 14 已执行，运行 `npm test` 确认全部测试通过
    - 提醒（不作为可勾选项，也不由编码代理执行）：`design.md` 的「未被自动化测试覆盖的属性」表列出属性 3、5、6、7、9、11、12 需要代码审查与在扩展中手工验证；需求 6 的三种启动路径（清空 storage / 预置旧值 / 注入 `get` reject）与需求 7.2 的 hide 类 flush 同样依赖手工验证
    - _Requirements: 13.1, 15.1_

## 说明

- 标记 `*` 的子任务为可选（14.1–14.7，即全部测试基础设施与测试任务），可跳过以更快得到 MVP；对应需求 15.6。
- 每条叶子任务末尾的 `_Requirements: X.Y_` 指向 `requirements.md` 中真实存在的验收标准编号。
- 任务 4、5、6、8、9、10、11、13.1 都在 `src/piniaChromeStoragePlugin.ts` 上作业，必须按编号串行执行。
- 需求 15.5（列出未被自动化覆盖的属性）已由 `design.md` 的「未被自动化测试覆盖的属性」表满足，无需额外编码任务。
- 本计划不引入 `design.md` 之外的新决策；`design.md` 的「超出范围」条目（信封结构、嵌套路径过滤、跨浏览器兼容、完整往返序列化、远端删除事件、独立限流器、字段级增量、属性化测试）不在任务范围内。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["2.2", "4.1"] },
    { "id": 2, "tasks": ["5.1"] },
    { "id": 3, "tasks": ["5.2"] },
    { "id": 4, "tasks": ["6.1"] },
    { "id": 5, "tasks": ["6.2"] },
    { "id": 6, "tasks": ["8.1"] },
    { "id": 7, "tasks": ["8.2"] },
    { "id": 8, "tasks": ["9.1"] },
    { "id": 9, "tasks": ["10.1"] },
    { "id": 10, "tasks": ["10.2"] },
    { "id": 11, "tasks": ["11.1", "14.1"] },
    { "id": 12, "tasks": ["13.1", "14.2"] },
    { "id": 13, "tasks": ["13.2", "14.3", "14.4", "14.5", "14.6", "14.7"] },
    { "id": 14, "tasks": ["15.1"] }
  ]
}
```
