# pinia-chrome-storage

[![npm version](https://badge.fury.io/js/pinia-chrome-storage.svg)](https://www.npmjs.com/package/pinia-chrome-storage)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个用于在 Chrome 扩展中同步 Pinia store 状态的插件。支持数据持久化、状态同步和懒加载。

## 特性

- 🔄 自动同步 Pinia store 状态到 Chrome storage
- ⚡ 支持懒加载，优化性能
- 🔒 防止循环同步
- 🛠️ 支持多种存储区域（local、sync、session、managed）
- 📦 轻量级，无额外依赖
- 🎯 完整的 TypeScript 支持

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

## 配置选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| storage | 'local' \| 'sync' \| 'session' \| 'managed' | 'local' | 使用的存储区域 |
| prefix | string | '' | 存储键名前缀 |

## 工作原理

1. **数据持久化**：当 Pinia store 状态发生变化时，自动保存到 Chrome storage
2. **状态同步**：监听 Chrome storage 的变化并同步到 Pinia store
3. **懒加载**：只在首次访问 store 状态时才从 storage 加载数据
4. **循环同步防护**：通过特殊标记防止循环同步

## 注意事项

- 确保在 Chrome 扩展环境中使用
- 需要在 manifest.json 中声明适当的 storage 权限
- 建议只同步必要的数据，避免存储过大的数据
- 使用 prefix 避免与其他扩展的存储键名冲突

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