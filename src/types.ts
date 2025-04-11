export type StorageArea = 'local' | 'sync' | 'session' | 'managed'

export interface PiniaChromeStorageOptions {
  storage?: StorageArea
  prefix?: string
}

export interface StorageChange {
  oldValue?: any
  newValue?: any
}

export interface StorageChangeEvent {
  changes: { [key: string]: StorageChange }
  areaName: string
} 