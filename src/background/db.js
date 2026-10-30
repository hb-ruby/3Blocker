/**
 * 3Blocker Storage & IndexedDB Manager
 * Provides atomic persistence for large domain blocklists and user rules.
 */
(function (global) {
  "use strict";

  const DB_NAME = "3BlockerDB";
  const DB_VERSION = 1;
  const STORE_META = "meta";
  const STORE_CHUNKS = "chunks";
  const META_KEY = "blocklist_meta";
  const CHUNK_SIZE = 20000;

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      // In environments where indexedDB is not available (e.g. headless tests), fallback cleanly
      if (typeof indexedDB === "undefined") {
        resolve(createMockDatabase());
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const chunkStore = db.createObjectStore(STORE_CHUNKS, { keyPath: "chunkId" });
          chunkStore.createIndex("by_version", "version", { unique: false });
        }
      };

      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) => reject(event.target.error);
    });

    return dbPromise;
  }

  /**
   * Read blocklist metadata.
   */
  async function getMetadata() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, "readonly");
      const store = tx.objectStore(STORE_META);
      const req = store.get(META_KEY);

      req.onsuccess = () => {
        resolve(req.result || {
          id: META_KEY,
          etag: null,
          lastModified: null,
          domainCount: 0,
          fetchedAt: null,
          activeVersion: null,
          status: "idle",
          lastError: null,
          retryCount: 0,
          nextRetryAt: null
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Update blocklist metadata.
   */
  async function setMetadata(newFields) {
    const current = await getMetadata();
    const updated = Object.assign({}, current, newFields, { id: META_KEY });
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, "readwrite");
      const store = tx.objectStore(STORE_META);
      const req = store.put(updated);
      req.onsuccess = () => resolve(updated);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Save a blocklist atomically:
   * 1. Generates new version tag.
   * 2. Writes all chunk records for the new version.
   * 3. Atomically updates metadata pointer to new version.
   * 4. Cleans up old version chunks.
   *
   * @param {string[]} domains - Flat array of valid deduplicated domain strings.
   * @param {object} metaInfo - { etag, lastModified, fetchedAt }
   */
  async function saveBlocklistAtomic(domains, metaInfo = {}) {
    if (!Array.isArray(domains)) {
      throw new TypeError("domains must be an array of strings");
    }

    const db = await openDatabase();
    const newVersion = "v_" + Date.now();
    const chunks = [];

    for (let i = 0; i < domains.length; i += CHUNK_SIZE) {
      chunks.push({
        chunkId: `${newVersion}_${Math.floor(i / CHUNK_SIZE)}`,
        version: newVersion,
        domains: domains.slice(i, i + CHUNK_SIZE)
      });
    }

    // 1. Write all new chunks in a readwrite transaction
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, "readwrite");
      const store = tx.objectStore(STORE_CHUNKS);

      chunks.forEach((chunk) => store.put(chunk));

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });

    // 2. Atomically update metadata pointer
    const currentMeta = await getMetadata();
    const oldVersion = currentMeta.activeVersion;

    const newMeta = {
      id: META_KEY,
      activeVersion: newVersion,
      domainCount: domains.length,
      etag: metaInfo.etag !== undefined ? metaInfo.etag : currentMeta.etag,
      lastModified: metaInfo.lastModified !== undefined ? metaInfo.lastModified : currentMeta.lastModified,
      fetchedAt: metaInfo.fetchedAt || new Date().toISOString(),
      status: "idle",
      lastError: null,
      retryCount: 0,
      nextRetryAt: null
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, "readwrite");
      const store = tx.objectStore(STORE_META);
      const req = store.put(newMeta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    // 3. Clean up obsolete chunks from old versions in background
    if (oldVersion && oldVersion !== newVersion) {
      deleteOldVersionChunks(db, oldVersion).catch((err) => {
        console.warn("Could not delete old chunks:", err);
      });
    }

    return newMeta;
  }

  async function deleteOldVersionChunks(db, versionToDelete) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, "readwrite");
      const store = tx.objectStore(STORE_CHUNKS);
      const index = store.index("by_version");
      const req = index.openKeyCursor(IDBKeyRange.only(versionToDelete));

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Load active blocklist from IndexedDB into memory.
   * Returns { domains: Set<string>, meta: object }
   */
  async function loadActiveBlocklist() {
    const meta = await getMetadata();
    if (!meta || !meta.activeVersion) {
      return { domains: new Set(), meta };
    }

    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, "readonly");
      const store = tx.objectStore(STORE_CHUNKS);
      const index = store.index("by_version");
      const req = index.openCursor(IDBKeyRange.only(meta.activeVersion));
      const domainSet = new Set();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const chunkData = cursor.value;
          if (chunkData && Array.isArray(chunkData.domains)) {
            for (let i = 0; i < chunkData.domains.length; i++) {
              domainSet.add(chunkData.domains[i]);
            }
          }
          cursor.continue();
        } else {
          resolve({ domains: domainSet, meta });
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * In-memory mock database for headless testing environments without IndexedDB.
   */
  function createMockDatabase() {
    let mockMeta = {
      id: META_KEY,
      etag: null,
      lastModified: null,
      domainCount: 0,
      fetchedAt: null,
      activeVersion: null,
      status: "idle",
      lastError: null,
      retryCount: 0,
      nextRetryAt: null
    };
    const mockChunks = new Map();

    return {
      transaction: (stores, mode) => ({
        objectStore: (storeName) => {
          if (storeName === STORE_META) {
            return {
              get: () => ({ onsuccess: null, result: mockMeta, set oncomplete(fn) { fn(); } }),
              put: (val) => {
                mockMeta = Object.assign({}, val);
                return { onsuccess: null };
              }
            };
          }
          if (storeName === STORE_CHUNKS) {
            return {
              put: (chunk) => {
                mockChunks.set(chunk.chunkId, chunk);
                return { onsuccess: null };
              },
              index: () => ({
                openCursor: (range) => {
                  const version = range ? range.lower || range : null;
                  const matching = Array.from(mockChunks.values()).filter((c) => !version || c.version === version);
                  let idx = 0;
                  const req = { onsuccess: null };
                  setTimeout(() => {
                    const next = () => {
                      if (idx < matching.length) {
                        const cur = {
                          value: matching[idx++],
                          continue: next
                        };
                        req.onsuccess({ target: { result: cur } });
                      } else {
                        req.onsuccess({ target: { result: null } });
                      }
                    };
                    next();
                  }, 0);
                  return req;
                },
                openKeyCursor: () => ({ onsuccess: (e) => e.target.onsuccess({ target: { result: null } }) })
              })
            };
          }
        },
        set oncomplete(fn) { setTimeout(fn, 0); },
        set onerror(fn) {},
        set onabort(fn) {}
      })
    };
  }

  /**
   * User Allowlist and Custom Blocklist Storage Helpers
   * Backed by browser.storage.local (with fallback to memory)
   */
  async function getUserRules() {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        const data = await browser.storage.local.get(["user_allowlist", "user_custom_blocks"]);
        return {
          allowlist: new Set(data.user_allowlist || []),
          customBlocks: new Set(data.user_custom_blocks || [])
        };
      }
    } catch (e) {
      console.warn("Storage access failed:", e);
    }
    return { allowlist: new Set(), customBlocks: new Set() };
  }

  async function setUserRules(allowlistSet, customBlocksSet) {
    const payload = {
      user_allowlist: Array.from(allowlistSet || []),
      user_custom_blocks: Array.from(customBlocksSet || [])
    };
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        await browser.storage.local.set(payload);
      }
    } catch (e) {
      console.warn("Storage set failed:", e);
    }
    return payload;
  }

  const StorageModule = {
    openDatabase,
    getMetadata,
    setMetadata,
    saveBlocklistAtomic,
    loadActiveBlocklist,
    getUserRules,
    setUserRules,
    CHUNK_SIZE
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = StorageModule;
  }
  if (typeof global !== "undefined") {
    global.BlocklistDB = StorageModule;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
