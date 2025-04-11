import type { PiniaPluginContext, SubscriptionCallbackMutationPatchObject } from 'pinia'

import type { PiniaChromeStorageOptions, StorageArea, StorageChangeEvent } from './types'

/**
 * 用于标记状态更新是否来自Chrome存储同步
 * 这个标记用于防止循环同步：当从storage同步数据到pinia时，不应该再触发写回storage
 */
const SYNC_STORAGE_KEY = Symbol('fromChromeStorage')

/**
 * 用于批量处理存储更新
 * 当多个状态变化快速发生时，将这些更新合并到一个对象中
 */
let pendingStorageUpdate: Record<string, any> = {}

/**
 * 存储更新定时器
 * 用于延迟执行实际的storage.set操作，避免频繁的存储操作
 */
let storageUpdateTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 记录已从storage加载过的store
 * 用于实现懒加载机制，避免重复加载相同的数据
 */
const loadedKeysMap = new Map<string, boolean>()

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

/**
 * Pinia Chrome存储插件
 * 
 * 主要功能：
 * 1. 数据持久化：将Pinia store的状态自动保存到Chrome storage
 * 2. 状态同步：监听Chrome storage的变化并同步到Pinia store
 * 3. 懒加载：只在首次访问store状态时才从storage加载数据
 * 
 * 工作流程：
 * 1. 初始化时检查环境并验证配置
 * 2. 设置store变化监听器，将变化写入storage
 * 3. 设置storage变化监听器，将变化同步回store
 * 4. 通过Proxy实现懒加载机制
 * 
 * @param options 插件配置选项
 * @param options.storage 使用的存储区域，默认为'local'
 * @param options.prefix 存储键名前缀，用于避免命名冲突
 * @returns Pinia插件函数
 */
export function piniaChromeStoragePlugin(options: PiniaChromeStorageOptions = {}) {
  // 环境检查和配置验证
  checkChromeEnvironment()
  
  const storage = options.storage || 'local'
  validateStorageArea(storage)
  
  const prefix = options.prefix || ''
  const chromeStorage = chrome.storage[storage]

  return (context: PiniaPluginContext) => {
    const { store } = context
    // 构建store的存储键名
    const storeKey = `${prefix}${store.$id}`

    // 监听store变化以持久化到chrome.storage
    store.$subscribe((mutation, state) => {
      try {
        // 如果状态中有同步标记，说明是从storage同步过来的，不需要再写回
        if (mutation.type === 'patch object') {
            const m = mutation as SubscriptionCallbackMutationPatchObject<any>
            if (m.payload && m.payload[SYNC_STORAGE_KEY as any]) {
                return
            }
        }

        // 处理函数式更新
        if (mutation.type === 'patch function') {
            if (SYNC_STORAGE_KEY in state) {
                delete state[SYNC_STORAGE_KEY]
                // 如果状态中有同步标记，说明是从storage同步过来的，不需要再写回
                return
            }
        }

        // 延迟写入，避免频繁的存储操作
        pendingStorageUpdate[storeKey] = { ...state }

        // 清除之前的定时器，避免重复执行
        if (storageUpdateTimer) {
          clearTimeout(storageUpdateTimer)
        }

        // 设置新的定时器，延迟执行存储操作
        storageUpdateTimer = setTimeout(() => {
          try {
            chromeStorage.set(pendingStorageUpdate)
            pendingStorageUpdate = {}
            storageUpdateTimer = null
          } catch (error) {
            console.error('Failed to update Chrome storage:', error)
          }
        }, 50)
      } catch (error) {
        console.error('Error in store subscription:', error)
      }
    })

    /**
     * 处理Chrome storage的变化事件
     * 将storage的变化同步回Pinia store
     */
    const handleStorageChange = (changes: StorageChangeEvent['changes'], areaName: string) => {
      try {
        // 只处理指定存储区域的变化
        if (areaName !== storage) return

        // 只处理已加载的store的变化
        if (storeKey in changes && loadedKeysMap.has(storeKey)) {
          const newValue = changes[storeKey].newValue

          if (!newValue) return

          // 使用patch更新store状态，并标记为同步更新
          store.$patch((state) => {
            const rawKeys = Object.keys(state)
            Object.assign(state, { ...newValue, [SYNC_STORAGE_KEY]: true })
            const newKeys = Object.keys(newValue)
            
            // 清理不再存在于新状态中的键
            for (const key of rawKeys) {
              if (!newKeys.includes(key)) {
                delete state[key]
              }
            }
          })
        }
      } catch (error) {
        console.error('Error handling storage change:', error)
      }
    }

    // 注册storage变化监听器
    chrome.storage.onChanged.addListener(handleStorageChange)

    // 保存原始状态，用于创建代理
    const originalState = store.$state

    /**
     * 实现懒加载机制
     * 只在首次访问store状态时从storage加载数据
     */
    async function firstLoad(prop: string | symbol) {
      try {
        if (!loadedKeysMap.has(storeKey) && typeof prop === 'string' && prop !== SYNC_STORAGE_KEY as any) {
          loadedKeysMap.set(storeKey, true)

          const result = await chromeStorage.get(storeKey)
          if (storeKey in result) {
            store.$patch({
              ...result[storeKey],
              [SYNC_STORAGE_KEY]: true
            })
          }
        }
      } catch (error) {
        console.error('Error loading from storage:', error)
      }
    }

    // 创建状态访问代理，实现懒加载
    store.$state = new Proxy(originalState, {
      get(target, prop) {
        firstLoad(prop)
        return target[prop]
      }
    })

    // 返回清理函数，用于移除事件监听器
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }
} 