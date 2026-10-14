import { ChatMessage, Conversation } from "../types";

export interface IConversationStore {
  init(): Promise<void>;
  getAll(): Promise<Conversation[]>;
  get(id: string): Promise<Conversation | undefined>;
  put(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

class IndexedDBStore implements IConversationStore {
  private dbName = "cypher_db";
  private storeName = "conversations";
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  public async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = (event) => {
        const err = (event.target as IDBOpenDBRequest).error;
        console.error("[Cypher] IndexedDB open error:", err);
        reject(err);
      };
    });
  }

  public async getAll(): Promise<Conversation[]> {
    if (!this.db) {
      await this.init();
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return resolve([]);
      }
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const index = store.index("updatedAt");
      const request = index.openCursor(null, "prev");
      const results: Conversation[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };

      request.onerror = (event) => {
        reject((event.target as IDBRequest).error);
      };
    });
  }

  public async get(id: string): Promise<Conversation | undefined> {
    if (!this.db) {
      await this.init();
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return resolve(undefined);
      }
      const transaction = this.db.transaction([this.storeName], "readonly");
      const store = transaction.objectStore(this.storeName);
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result as Conversation | undefined);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public async put(conversation: Conversation): Promise<void> {
    if (!this.db) {
      await this.init();
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return reject(new Error("Database not initialized"));
      }
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.put(conversation);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public async delete(id: string): Promise<boolean> {
    if (!this.db) {
      await this.init();
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return resolve(false);
      }
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);

      request.onsuccess = () => {
        resolve(true);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  public async clear(): Promise<void> {
    if (!this.db) {
      await this.init();
    }
    return new Promise((resolve, reject) => {
      if (!this.db) {
        return resolve();
      }
      const transaction = this.db.transaction([this.storeName], "readwrite");
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }
}

class InMemoryStore implements IConversationStore {
  private map: Map<string, Conversation> = new Map();

  public async init(): Promise<void> {}

  public async getAll(): Promise<Conversation[]> {
    const list = Array.from(this.map.values());
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async get(id: string): Promise<Conversation | undefined> {
    const found = this.map.get(id);
    return found ? { ...found } : undefined;
  }

  public async put(conversation: Conversation): Promise<void> {
    this.map.set(conversation.id, { ...conversation });
  }

  public async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }

  public async clear(): Promise<void> {
    this.map.clear();
  }
}

export class ConversationService {
  private store: IConversationStore;

  constructor(customStore?: IConversationStore) {
    if (customStore) {
      this.store = customStore;
    } else if (typeof indexedDB !== "undefined") {
      this.store = new IndexedDBStore();
    } else {
      this.store = new InMemoryStore();
    }
  }

  public async init(): Promise<void> {
    await this.store.init();
  }

  public async getAll(): Promise<Conversation[]> {
    return this.store.getAll();
  }

  public async get(id: string): Promise<Conversation | undefined> {
    return this.store.get(id);
  }

  public async create(
    title = "New Chat",
    initialMessages: ChatMessage[] = []
  ): Promise<Conversation> {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [...initialMessages],
    };

    await this.store.put(conversation);
    return conversation;
  }

  public async save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = Date.now();
    await this.store.put(conversation);
  }

  public async rename(id: string, newTitle: string): Promise<boolean> {
    const conv = await this.store.get(id);
    if (!conv) return false;
    conv.title = newTitle.trim() || "Untitled Chat";
    conv.updatedAt = Date.now();
    await this.store.put(conv);
    return true;
  }

  public async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  public async clearAll(): Promise<void> {
    await this.store.clear();
  }

  public generateTitleFromContent(content: string): string {
    const cleaned = content.replace(/[#*`_[\]()]/g, "").trim().replace(/\s+/g, " ");
    if (!cleaned) return "New Chat";
    if (cleaned.length <= 40) return cleaned;
    const truncated = cleaned.slice(0, 38);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 20) {
      return truncated.slice(0, lastSpace) + "...";
    }
    return truncated + "...";
  }
}
