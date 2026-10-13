// ============================================================
// FILE STORE — supporting-document attachments in IndexedDB
//
// Why: attachments used to be saved as base64 data: URLs inside the
// 'procurement_records' localStorage entry. localStorage is only ~5 MB for
// the whole site, so a few PDFs filled it. IndexedDB holds the raw file
// (Blob, no base64 overhead) and has a far larger quota. The record now
// keeps only a small reference:
//
//     { name, size, type, fileId }
//
// Records saved by older versions still carry `dataUrl`; those keep working
// (docBlob() understands both) and are moved into IndexedDB in the
// background by migrateLegacy() the first time a page loads.
//
// Load this file BEFORE dashboard-logic.js and request-modal.js.
// ============================================================

const FileStore = (function () {
    'use strict';

    const DB_NAME = 'dict_procurement_files';
    const STORE = 'files';
    const RECORDS_KEY = 'procurement_records';
    // Files not referenced by any record are only deleted once they are older
    // than this, so an attachment added to a draft that is still being edited
    // (possibly in another tab) is never swept away.
    const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB is not available in this browser.'));
                return;
            }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
        dbPromise.catch(function () { dbPromise = null; });   // allow a retry later
        return dbPromise;
    }

    // Runs one request inside a transaction and resolves when the transaction
    // has actually committed (so a put() that resolves is really on disk).
    function run(mode, work) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(STORE, mode);
                const store = tx.objectStore(STORE);
                let result;
                const req = work(store);
                if (req) req.onsuccess = function () { result = req.result; };
                tx.oncomplete = function () { resolve(result); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error || new Error('Storage transaction aborted.')); };
            });
        });
    }

    // Ids start with a base-36 timestamp so gc() can tell how old a file is.
    function newId() {
        return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function idTimestamp(id) {
        const m = /^f([0-9a-z]+?)([0-9a-z]{6})$/.exec(String(id || ''));
        if (!m) return 0;
        const t = parseInt(m[1], 36);
        return isNaN(t) ? 0 : t;
    }

    function put(id, blob) { return run('readwrite', function (s) { return s.put(blob, id); }); }
    function get(id)       { return run('readonly',  function (s) { return s.get(id); }); }
    function remove(id)    { return run('readwrite', function (s) { return s.delete(id); }).catch(function () {}); }
    function keys()        { return run('readonly',  function (s) { return s.getAllKeys(); }); }

    // ---------- legacy data: URLs ----------

    function dataUrlToBlob(dataUrl) {
        try {
            const text = String(dataUrl || '');
            const comma = text.indexOf(',');
            if (comma === -1) return null;
            const header = text.slice(0, comma);
            const mimeMatch = header.match(/^data:([^;,]*)/);
            const mime = (mimeMatch && mimeMatch[1]) || 'application/octet-stream';
            const payload = text.slice(comma + 1);
            let bytes;
            if (/;base64/i.test(header)) {
                const binary = atob(payload);
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            } else {
                bytes = new TextEncoder().encode(decodeURIComponent(payload));
            }
            return new Blob([bytes], { type: mime });
        } catch (err) {
            return null;
        }
    }

    // True when the document has stored contents (new fileId or legacy dataUrl).
    function hasContent(doc) {
        return !!(doc && (doc.fileId || doc.dataUrl));
    }

    // Resolves to the document's Blob, or null if its contents are missing.
    function docBlob(doc) {
        if (!doc) return Promise.resolve(null);
        if (doc.fileId) {
            return get(doc.fileId).then(function (blob) { return blob || null; });
        }
        if (doc.dataUrl) return Promise.resolve(dataUrlToBlob(doc.dataUrl));
        return Promise.resolve(null);
    }

    // ---------- record scanning ----------

    function readRecords() {
        try {
            const parsed = JSON.parse(localStorage.getItem(RECORDS_KEY));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    // Every supporting_documents array in a record: one per item, plus the
    // pre-multi-item layout where the array sits on the record itself.
    function docLists(record) {
        const lists = [];
        if (Array.isArray(record.items)) {
            record.items.forEach(function (item) {
                if (item && Array.isArray(item.supporting_documents)) {
                    lists.push({ ownerId: String(item.id), docs: item.supporting_documents });
                }
            });
        }
        if (Array.isArray(record.supporting_documents)) {
            lists.push({ ownerId: 'record', docs: record.supporting_documents });
        }
        return lists;
    }

    function docKey(record, ownerId, doc) {
        return [record.id, ownerId, doc.name, doc.size].join('|');
    }

    // Moves every inline dataUrl into IndexedDB and replaces it with a fileId.
    // The final read-modify-write of localStorage happens synchronously, so it
    // cannot overwrite a change the user made while the files were copying.
    function migrateLegacy() {
        const snapshot = readRecords();
        const pending = [];

        snapshot.forEach(function (record) {
            docLists(record).forEach(function (list) {
                list.docs.forEach(function (doc) {
                    if (doc && doc.dataUrl && !doc.fileId) {
                        pending.push({ key: docKey(record, list.ownerId, doc), doc: doc });
                    }
                });
            });
        });

        if (pending.length === 0) return Promise.resolve(0);

        const moved = {};   // docKey -> { fileId, type }
        let chain = Promise.resolve();
        pending.forEach(function (p) {
            chain = chain.then(function () {
                const blob = dataUrlToBlob(p.doc.dataUrl);
                if (!blob) return null;                       // unreadable: leave as is
                const id = newId();
                return put(id, blob).then(function () {
                    moved[p.key] = { fileId: id, type: blob.type || '' };
                });
            });
        });

        return chain.then(function () {
            const keysMoved = Object.keys(moved);
            if (keysMoved.length === 0) return 0;

            const fresh = readRecords();
            let changed = 0;
            fresh.forEach(function (record) {
                docLists(record).forEach(function (list) {
                    list.docs.forEach(function (doc) {
                        if (!doc || !doc.dataUrl || doc.fileId) return;
                        const hit = moved[docKey(record, list.ownerId, doc)];
                        if (!hit) return;
                        doc.fileId = hit.fileId;
                        if (!doc.type) doc.type = hit.type;
                        delete doc.dataUrl;
                        changed++;
                    });
                });
            });

            if (changed > 0) {
                try {
                    localStorage.setItem(RECORDS_KEY, JSON.stringify(fresh));
                } catch (err) {
                    console.warn('FileStore: could not save migrated records', err);
                    return 0;
                }
            }
            return changed;
        });
    }

    // Deletes stored files that no record points to any more (deleted records
    // or items, removed or discarded attachments).
    function gc() {
        const referenced = {};
        readRecords().forEach(function (record) {
            docLists(record).forEach(function (list) {
                list.docs.forEach(function (doc) {
                    if (doc && doc.fileId) referenced[doc.fileId] = true;
                });
            });
        });

        return keys().then(function (all) {
            const cutoff = Date.now() - ORPHAN_GRACE_MS;
            const stale = (all || []).filter(function (id) {
                return !referenced[id] && idTimestamp(id) < cutoff;
            });
            return Promise.all(stale.map(remove)).then(function () { return stale.length; });
        });
    }

    // Ask the browser not to evict our data under storage pressure.
    function requestPersistence() {
        try {
            if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
        } catch (e) { /* best effort */ }
    }

    // Runs once per page load, after the page is up. Never throws.
    function startup() {
        requestPersistence();
        migrateLegacy()
            .then(function () { return gc(); })
            .catch(function (err) { console.warn('FileStore startup skipped:', err); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startup);
    } else {
        startup();
    }

    return {
        newId: newId,
        put: put,
        get: get,
        remove: remove,
        docBlob: docBlob,
        hasContent: hasContent,
        dataUrlToBlob: dataUrlToBlob,
        migrateLegacy: migrateLegacy,
        gc: gc
    };
})();