# Pinia Chrome Storage 插件

这个插件为Pinia与Chrome扩展的`chrome.storage` API之间提供了无缝集成，实现了三个主要功能：

1. **实时持久化** - 当通过Pinia修改状态时，自动将数据保存到Chrome存储中
2. **双向同步** - 当Chrome存储中的数据变化时，自动更新对应的Pinia状态
3. **懒加载** - 仅在首次访问某个store时才从Chrome存储加载数据

## 安装
todo  

## 使用方法

### 基本设置

```typescript
// main.ts
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { piniaChromeStoragePlugin } from './path/to/piniaChromeStoragePlugin'

const app = createApp(App)
const pinia = createPinia()

// 使用插件
pinia.use(piniaChromeStoragePlugin({
  // 可选配置
  storage: 'local', // 'local' | 'sync' | 'session' | 'managed'
  prefix: 'myapp_'  // 可选的存储键前缀
}))

app.use(pinia)
app.mount('#app')
```

### 定义Store

插件不需要对常规的Pinia store定义进行任何修改：

```typescript
// stores/user.ts
import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', {
  state: () => ({
    name: '',
    email: '',
    preferences: {
      theme: 'light'
    }
  }),
  actions: {
    setName(name: string) {
      this.name = name
    }
  }
})
```

### 在组件中使用

在组件中使用store时，插件会自动处理与Chrome存储的同步：

```vue
<script setup>
import { useUserStore } from '@/stores/user'

// 获取store实例
const userStore = useUserStore()

// 首次访问时，会从chrome.storage懒加载数据
console.log(userStore.name)

// 修改状态时，会自动持久化到chrome.storage
function updateName() {
  userStore.setName('新名称')
}
</script>
```

## 工作原理

### 1. 实时持久化

当store中的数据被修改时，插件会监听变化并将更新后的状态保存到Chrome存储中。为避免频繁写入，插件使用了防抖机制。

```typescript
// 当store数据变化时
store.$subscribe((mutation, state) => {
  // 将数据保存到chrome.storage
  chrome.storage.local.set({ [storeKey]: state })
})
```

### 2. 双向同步

插件监听Chrome存储的变化，当存储中的数据被其他地方修改时，会自动更新Pinia状态：

```typescript
chrome.storage.onChanged.addListener((changes, areaName) => {
  // 当相关的存储键发生变化时，更新pinia状态
  if (storeKey in changes) {
    store.$patch(changes[storeKey].newValue)
  }
})
```

### 3. 懒加载

插件使用JavaScript的Proxy拦截对store状态的访问，首次访问时才从Chrome存储加载数据：

```typescript
// 拦截对store.$state的访问
store.$state = new Proxy(store.$state, {
  get(target, prop) {
    // 首次访问时，从storage加载数据
    if (首次访问) {
      chrome.storage.local.get(storeKey).then(result => {
        // 更新store状态
      })
    }
    return target[prop]
  }
})
```

## 防止循环同步
插件使用特殊标记，确保从Chrome存储同步到Pinia时，不会再次触发Pinia到Chrome存储的写回。

## 注意事项

1. Chrome存储有大小限制：
   - `chrome.storage.local`: ~5MB
   - `chrome.storage.sync`: ~100KB (每项)
   
2. 插件自动处理JSON序列化/反序列化，但不支持存储复杂类型如Map, Function, Symbol等。

3. 当store状态非常大时，应考虑只持久化必要的部分，或使用其他存储方式。 