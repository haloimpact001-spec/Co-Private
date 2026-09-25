// lib/redis.ts
import { Redis } from '@upstash/redis';

// MOCKED in-memory fallback store when Upstash Redis credentials are not provided
interface StoredItem {
  value: unknown;
  expiresAt?: number;
}

export interface RedisClientInterface {
  set(key: string, value: unknown, options?: { ex?: number }): Promise<string | unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

class InMemoryRedis implements RedisClientInterface {
  private kv = new Map<string, StoredItem>();
  private sets = new Map<string, { members: Set<string>; expiresAt?: number }>();

  async set(key: string, value: unknown, options?: { ex?: number }) {
    const expiresAt = options?.ex ? Date.now() + options.ex * 1000 : undefined;
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
    }
    this.kv.set(key, { value: parsed, expiresAt });
    return 'OK';
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const item = this.kv.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.kv.delete(key);
      return null;
    }
    return item.value as T;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let setObj = this.sets.get(key);
    if (!setObj || (setObj.expiresAt && Date.now() > setObj.expiresAt)) {
      setObj = { members: new Set<string>() };
      this.sets.set(key, setObj);
    }
    let added = 0;
    for (const m of members) {
      if (!setObj.members.has(m)) {
        setObj.members.add(m);
        added++;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const setObj = this.sets.get(key);
    if (!setObj) return [];
    if (setObj.expiresAt && Date.now() > setObj.expiresAt) {
      this.sets.delete(key);
      return [];
    }
    return Array.from(setObj.members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const setObj = this.sets.get(key);
    if (!setObj) return 0;
    let removed = 0;
    for (const m of members) {
      if (setObj.members.delete(m)) removed++;
    }
    return removed;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const expiresAt = Date.now() + seconds * 1000;
    let found = false;
    const item = this.kv.get(key);
    if (item) {
      item.expiresAt = expiresAt;
      found = true;
    }
    const setObj = this.sets.get(key);
    if (setObj) {
      setObj.expiresAt = expiresAt;
      found = true;
    }
    return found ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    const d1 = this.kv.delete(key);
    const d2 = this.sets.delete(key);
    return d1 || d2 ? 1 : 0;
  }
}

// Preserve in-memory store across Next.js reloads
const globalForRedis = globalThis as unknown as { inMemoryRedis?: InMemoryRedis };
const inMemoryStore = globalForRedis.inMemoryRedis || new InMemoryRedis();
if (process.env.NODE_ENV !== 'production') {
  globalForRedis.inMemoryRedis = inMemoryStore;
}

let redisClient: RedisClientInterface;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    }) as unknown as RedisClientInterface;
  } catch (err) {
    console.warn('[AI Studio] Failed to initialize Upstash Redis, falling back to in-memory store:', err);
    redisClient = inMemoryStore;
  }
} else {
  redisClient = inMemoryStore;
}

export const redis = redisClient;
