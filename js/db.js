// db.js — opens IndexedDB and runs versioned, additive migrations.
// The database is NEVER deleted to change the schema. To change it, add migrations[N+1]
// and bump DB_VERSION; existing data stays in place.
import { AppError, toAppError } from './models.js';

export const DB_NAME = 'visualvault';
export const DB_VERSION = 1;

export const STORE_NAMES = Object.freeze([
  'products', 'images', 'customFieldDefinitions', 'customFieldValues',
  'categories', 'tags', 'productCategories', 'productTags', 'settings',
]);

const migrations = {
  1(db) {
    let s = db.createObjectStore('products', { keyPath: 'id' });
    s.createIndex('nameLower', 'nameLower');
    s.createIndex('createdAt', 'createdAt');
    s.createIndex('updatedAt', 'updatedAt');
    s.createIndex('sku', 'sku');

    s = db.createObjectStore('images', { keyPath: 'id' });
    s.createIndex('productId', 'productId');
    s.createIndex('productPosition', ['productId', 'position']);

    s = db.createObjectStore('customFieldDefinitions', { keyPath: 'id' });
    s.createIndex('scope', 'scope');
    s.createIndex('scopeName', ['scope', 'nameLower'], { unique: true });

    s = db.createObjectStore('customFieldValues', { keyPath: 'id' });
    s.createIndex('ownerId', 'ownerId');
    s.createIndex('fieldId', 'fieldId');
    s.createIndex('fieldOwner', ['fieldId', 'ownerId'], { unique: true });
    s.createIndex('fieldNumeric', ['fieldId', 'numeric']);

    for (const name of ['categories', 'tags']) {
      s = db.createObjectStore(name, { keyPath: 'id' });
      s.createIndex('nameLower', 'nameLower', { unique: true });
    }

    s = db.createObjectStore('productCategories', { keyPath: ['productId', 'categoryId'] });
    s.createIndex('productId', 'productId');
    s.createIndex('categoryId', 'categoryId');

    s = db.createObjectStore('productTags', { keyPath: ['productId', 'tagId'] });
    s.createIndex('productId', 'productId');
    s.createIndex('tagId', 'tagId');

    db.createObjectStore('settings', { keyPath: 'key' });
  },
};

/** Open (and migrate) the database. `factory` is injectable for testing storage failures. */
export function openDatabase(name = DB_NAME, factory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(new AppError('UNAVAILABLE', 'This browser does not support local database storage.'));
    let req;
    try { req = factory.open(name, DB_VERSION); } catch (e) { return reject(toAppError(e)); }
    req.onupgradeneeded = (ev) => {
      try {
        for (let v = ev.oldVersion + 1; v <= ev.newVersion; v++) {
          if (!migrations[v]) throw new Error(`Missing migration for version ${v}`);
          migrations[v](req.result, req.transaction);
        }
      } catch (e) {
        try { req.transaction.abort(); } catch { /* already aborted */ }
        reject(toAppError(e));
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // let another tab upgrade
      resolve(db);
    };
    req.onerror = () => reject(toAppError(req.error));
  });
}

export function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(toAppError(req.error));
    req.onblocked = () => resolve();
  });
}

/** Ask the browser to keep data. Returns true/false/null(unsupported). Never a guarantee. */
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  try { return await navigator.storage.persist(); } catch { return null; }
}

export async function getStorageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
    return { usage, quota, persisted };
  } catch { return null; }
}
