/* ======================================================
   VocabDB - IndexedDB データベース管理
   ======================================================
   【アーキテクト視点】
   - IndexedDB でオフラインファーストのデータ永続化
   - Promise ベースの非同期API
   - エクスポート/インポートでデータ可搬性を確保
   
   【セキュリティ視点】
   - ユーザーデータはローカルのみに保存、外部送信なし
   - インポート時にデータ構造を検証
   ====================================================== */

const VocabDB = (function () {
  'use strict';

  const DB_NAME = 'vocabsnap';
  const DB_VERSION = 1;
  let db = null;

  // --- 初期化 ---
  function init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        // 単語ストア
        if (!database.objectStoreNames.contains('words')) {
          const wordStore = database.createObjectStore('words', { keyPath: 'id' });
          wordStore.createIndex('word', 'word', { unique: false });
          wordStore.createIndex('createdAt', 'createdAt', { unique: false });
          wordStore.createIndex('bookmarked', 'bookmarked', { unique: false });
        }

        // 学習ログストア
        if (!database.objectStoreNames.contains('studyLogs')) {
          const logStore = database.createObjectStore('studyLogs', { keyPath: 'id', autoIncrement: true });
          logStore.createIndex('date', 'date', { unique: false });
          logStore.createIndex('type', 'type', { unique: false });
        }

        // 設定ストア
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        db = event.target.result;
        resolve(db);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  // --- ユーティリティ ---
  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function getStore(storeName, mode = 'readonly') {
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  // --- 単語 CRUD ---
  function createWordEntry(data) {
    return {
      id: data.id || crypto.randomUUID(),
      word: (data.word || '').trim().toLowerCase(),
      wordDisplay: (data.word || '').trim(),
      meaning: (data.meaning || '').trim(),
      phonetic: (data.phonetic || '').trim(),
      pos: (data.pos || '').trim(),
      examples: Array.isArray(data.examples) ? data.examples : [],
      synonyms: Array.isArray(data.synonyms) ? data.synonyms : [],
      antonyms: Array.isArray(data.antonyms) ? data.antonyms : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      memo: (data.memo || '').trim(),
      bookmarked: !!data.bookmarked,
      srs: data.srs || {
        repetitions: 0,
        easeFactor: 2.5,
        interval: 0,
        nextReview: null,
        lastReview: null
      },
      stats: data.stats || {
        flashcardCorrect: 0,
        flashcardIncorrect: 0,
        spellingCorrect: 0,
        spellingIncorrect: 0,
        matchingCorrect: 0,
        matchingIncorrect: 0
      },
      createdAt: data.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  async function addWord(data) {
    const word = createWordEntry(data);
    const store = getStore('words', 'readwrite');
    await promisify(store.add(word));
    return word;
  }

  async function addWords(dataArray) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('words', 'readwrite');
      const store = tx.objectStore('words');
      const results = [];

      dataArray.forEach(data => {
        const word = createWordEntry(data);
        results.push(word);
        store.add(word);
      });

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getWord(id) {
    const store = getStore('words');
    return promisify(store.get(id));
  }

  async function getAllWords() {
    const store = getStore('words');
    return promisify(store.getAll());
  }

  async function updateWord(word) {
    word.updatedAt = Date.now();
    const store = getStore('words', 'readwrite');
    await promisify(store.put(word));
    return word;
  }

  async function deleteWord(id) {
    const store = getStore('words', 'readwrite');
    return promisify(store.delete(id));
  }

  async function getBookmarkedWords() {
    const all = await getAllWords();
    return all.filter(w => w.bookmarked);
  }

  async function searchWords(query) {
    const all = await getAllWords();
    const q = query.toLowerCase().trim();
    if (!q) return all;
    return all.filter(w =>
      w.word.includes(q) ||
      w.meaning.includes(q) ||
      w.synonyms.some(s => s.toLowerCase().includes(q)) ||
      w.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  async function getDueWords() {
    const all = await getAllWords();
    const now = Date.now();
    return all.filter(w => {
      if (!w.srs.nextReview) return true; // 未学習
      return w.srs.nextReview <= now;
    });
  }

  async function getWeakWords(limit = 10) {
    const all = await getAllWords();
    return all
      .map(w => {
        const total = w.stats.flashcardCorrect + w.stats.flashcardIncorrect +
          w.stats.spellingCorrect + w.stats.spellingIncorrect;
        const incorrect = w.stats.flashcardIncorrect + w.stats.spellingIncorrect;
        const rate = total > 0 ? incorrect / total : 0;
        return { ...w, errorRate: rate, totalAttempts: total };
      })
      .filter(w => w.totalAttempts >= 2)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, limit);
  }

  async function getMasteredWords() {
    const all = await getAllWords();
    return all.filter(w => w.srs.repetitions >= 5 && w.srs.interval >= 21);
  }

  // --- 学習ログ ---
  async function addStudyLog(log) {
    const entry = {
      date: new Date().toISOString().split('T')[0],
      timestamp: Date.now(),
      type: log.type, // 'flashcard', 'spelling', 'matching'
      wordCount: log.wordCount || 0,
      correctCount: log.correctCount || 0,
      duration: log.duration || 0
    };
    const store = getStore('studyLogs', 'readwrite');
    return promisify(store.add(entry));
  }

  async function getStudyLogs(days = 30) {
    const all = await promisify(getStore('studyLogs').getAll());
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return all.filter(log => log.timestamp >= cutoff);
  }

  async function getStreak() {
    const logs = await getStudyLogs(365);
    if (logs.length === 0) return 0;

    const dates = [...new Set(logs.map(l => l.date))].sort().reverse();
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    if (dates[0] !== today && dates[0] !== yesterday) return 0;

    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const curr = new Date(dates[i]);
      const diff = (prev - curr) / 86400000;
      if (diff === 1) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  // --- 設定 ---
  async function getSetting(key, defaultValue = null) {
    try {
      const store = getStore('settings');
      const result = await promisify(store.get(key));
      return result ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
  }

  async function setSetting(key, value) {
    const store = getStore('settings', 'readwrite');
    return promisify(store.put({ key, value }));
  }

  // --- エクスポート/インポート ---
  async function exportData() {
    const words = await getAllWords();
    const logs = await getStudyLogs(9999);
    return JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      words,
      studyLogs: logs
    }, null, 2);
  }

  async function importData(jsonString, mergeMode = false) {
    try {
      const data = JSON.parse(jsonString);

      // 【セキュリティ視点】データ構造バリデーション
      if (!data.words || !Array.isArray(data.words)) {
        throw new Error('無効なデータ形式です');
      }

      let existingWords = [];
      if (mergeMode) {
        existingWords = await getAllWords();
      }

      if (!mergeMode) {
        await clearAllWords();
      }

      const tx = db.transaction(['words', 'studyLogs'], 'readwrite');
      const wordStore = tx.objectStore('words');
      const logStore = tx.objectStore('studyLogs');

      // マージ時は重複チェック
      const existingSet = new Set(existingWords.map(w => w.word.toLowerCase()));
      let addedCount = 0;

      for (const word of data.words) {
        if (mergeMode && existingSet.has((word.word || '').toLowerCase())) {
          continue; // 重複スキップ
        }
        const validated = createWordEntry(word);
        validated.createdAt = word.createdAt || Date.now();
        if (mergeMode) {
          validated.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        }
        wordStore.put(validated);
        addedCount++;
      }

      if (!mergeMode && data.studyLogs && Array.isArray(data.studyLogs)) {
        for (const log of data.studyLogs) {
          logStore.add(log);
        }
      }

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(addedCount);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      throw new Error('インポートに失敗しました: ' + e.message);
    }
  }

  /**
   * 単語をテキスト形式でエクスポート（コピー/共有用）
   */
  async function exportAsText() {
    const words = await getAllWords();
    const lines = words.map(w => {
      let line = w.word;
      if (w.phonetic) line += ` [${w.phonetic}]`;
      if (w.pos) line += ` (${w.pos})`;
      line += ` : ${w.meaning}`;
      if (w.synonyms && w.synonyms.length > 0) line += ` ≒ ${w.synonyms.join(', ')}`;
      return line;
    });
    return lines.join('\n');
  }

  /**
   * テキスト形式からインポート
   * 形式: "word : meaning" or "word [phonetic] (pos) : meaning"
   */
  async function importFromText(text, mergeMode = true) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const words = [];

    for (const line of lines) {
      // "word [phonetic] (pos) : meaning ≒ syn1, syn2" パターン
      const match = line.match(/^([a-zA-Z][\w\s-]+?)\s*(?:\[([^\]]+)\])?\s*(?:\(([^)]+)\))?\s*[:：]\s*(.+?)(?:\s*≒\s*(.+))?$/);
      if (match) {
        words.push({
          word: match[1].trim(),
          phonetic: match[2] || '',
          pos: match[3] || '',
          meaning: match[4].trim(),
          synonyms: match[5] ? match[5].split(/[,、]/).map(s => s.trim()).filter(s => s) : []
        });
      } else {
        // シンプル形式: "word meaning" or "word\tmeaning"
        const simple = line.match(/^([a-zA-Z][\w-]+)\s+(.+)$/);
        if (simple) {
          words.push({
            word: simple[1].trim(),
            meaning: simple[2].trim(),
            phonetic: '',
            pos: '',
            synonyms: []
          });
        }
      }
    }

    if (words.length === 0) {
      throw new Error('認識できる単語が見つかりませんでした');
    }

    const json = JSON.stringify({ version: 1, words });
    return importData(json, mergeMode);
  }

  async function clearAllWords() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('words', 'readwrite');
      tx.objectStore('words').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getWordCount() {
    const store = getStore('words');
    return promisify(store.count());
  }

  // --- 公開API ---
  return {
    init,
    addWord,
    addWords,
    getWord,
    getAllWords,
    updateWord,
    deleteWord,
    getBookmarkedWords,
    searchWords,
    getDueWords,
    getWeakWords,
    getMasteredWords,
    getWordCount,
    addStudyLog,
    getStudyLogs,
    getStreak,
    getSetting,
    setSetting,
    exportData,
    importData,
    exportAsText,
    importFromText,
    clearAllWords
  };
})();
