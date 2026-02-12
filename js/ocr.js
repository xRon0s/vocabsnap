/* ======================================================
   OCRProcessor - 画像テキスト認識 & パーサー
   ======================================================
   【アーキテクト視点】
   - Tesseract.js (CDN) でクライアントサイドOCR
   - 日本語+英語の混合テキスト対応
   - システム英単語フォーマットのヒューリスティック解析
   
   【QA視点】
   - OCR精度が低い場合の手動編集を前提とした設計
   - プログレス表示でユーザー体験を向上
   
   【セキュリティ視点】
   - 画像はローカル処理のみ、外部サーバーへの送信なし
   ====================================================== */

const OCRProcessor = (function () {
  'use strict';

  let worker = null;
  let isInitialized = false;

  /**
   * Tesseract.js ワーカーを初期化
   * @param {Function} onProgress - 進捗コールバック (status, progress)
   */
  async function init(onProgress) {
    if (isInitialized && worker) return;

    try {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract.js が読み込まれていません');
      }

      worker = await Tesseract.createWorker('eng+jpn', 1, {
        logger: (m) => {
          if (onProgress && m.progress !== undefined) {
            let status = 'テキスト認識中...';
            if (m.status === 'loading tesseract core') status = 'OCRエンジン読み込み中...';
            else if (m.status === 'initializing tesseract') status = '初期化中...';
            else if (m.status === 'loading language traineddata') status = '言語データ読み込み中...';
            else if (m.status === 'initializing api') status = 'API初期化中...';
            else if (m.status === 'recognizing text') status = 'テキスト認識中...';
            onProgress(status, Math.round(m.progress * 100));
          }
        }
      });

      isInitialized = true;
    } catch (e) {
      console.error('Tesseract初期化エラー:', e);
      throw e;
    }
  }

  /**
   * 画像からテキストを認識
   * @param {string|Blob|File} image - 画像ソース
   * @param {Function} onProgress - 進捗コールバック
   * @returns {string} 認識されたテキスト
   */
  async function recognize(image, onProgress) {
    if (!isInitialized) {
      await init(onProgress);
    }

    if (onProgress) onProgress('テキスト認識中...', 0);

    const result = await worker.recognize(image);
    return result.data.text;
  }

  /**
   * 認識テキストをシステム英単語フォーマットで解析
   * 
   * 【QA視点】複数のパターンに対応:
   * - 番号 + 英単語 + [発音記号] + 品詞 + 日本語意味
   * - 例文（英語行 → 日本語訳行）
   * - 類義語（≒, 類, 同 で始まる行）
   * - 反意語（⇔, 反 で始まる行）
   * 
   * @param {string} text - OCRで認識されたテキスト
   * @returns {Array} パースされた単語エントリの配列
   */
  function parseSystemEitan(text) {
    if (!text || typeof text !== 'string') return [];

    const entries = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // エントリの開始位置を検出
    // パターン: 数字 + 英単語 (例: "56 abundant" or "056 abundant")
    const entryStartPattern = /^\d{1,4}\s+[a-zA-Z]/;
    const entryIndices = [];

    lines.forEach((line, index) => {
      if (entryStartPattern.test(line)) {
        entryIndices.push(index);
      }
    });

    // エントリがない場合はフリーテキストとして解析
    if (entryIndices.length === 0) {
      return parseFreeText(text);
    }

    // 各エントリをパース
    for (let i = 0; i < entryIndices.length; i++) {
      const startIdx = entryIndices[i];
      const endIdx = i + 1 < entryIndices.length ? entryIndices[i + 1] : lines.length;
      const entryLines = lines.slice(startIdx, endIdx);

      const entry = parseEntry(entryLines);
      if (entry && entry.word) {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * 単一エントリのパース
   */
  function parseEntry(lines) {
    if (lines.length === 0) return null;

    const entry = {
      word: '',
      meaning: '',
      phonetic: '',
      pos: '',
      examples: [],
      synonyms: [],
      antonyms: []
    };

    // 1行目: 番号 + 英単語 + [発音] + 品詞
    const firstLine = lines[0];

    // 英単語抽出
    const wordMatch = firstLine.match(/\d+\s+([a-zA-Z][\w\s-]*?)(?:\s*[\[（(]|$|\s+[形名動副接前])/);
    if (wordMatch) {
      entry.word = wordMatch[1].trim();
    } else {
      // フォールバック: 数字の後の最初の英単語
      const simpleMatch = firstLine.match(/\d+\s+([a-zA-Z][\w-]+)/);
      if (simpleMatch) entry.word = simpleMatch[1].trim();
    }

    // 発音記号抽出
    const phoneticMatch = firstLine.match(/[\[（(]([^）)\]]+)[\]）)]/);
    if (phoneticMatch) entry.phonetic = phoneticMatch[1];

    // 品詞抽出（日本語の品詞表記）
    const posMatch = firstLine.match(/(形|名|動|副|接|前|助|間|代)/);
    if (posMatch) entry.pos = posMatch[1];

    // 残りの行を分類
    let currentExample = { en: '', ja: '' };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1行目はすでに処理済みだが、品詞の後に意味がある場合
      if (i === 0) {
        // 1行目から日本語意味を抽出
        const meaningInFirst = extractJapanesePart(line, entry.word);
        if (meaningInFirst) entry.meaning = meaningInFirst;
        continue;
      }

      // 類義語行
      if (/^[≒≈~～類同]/.test(line)) {
        const syns = extractSynonyms(line);
        entry.synonyms.push(...syns);
        continue;
      }

      // 反意語行
      if (/^[⇔↔反]/.test(line)) {
        const ants = extractSynonyms(line);
        entry.antonyms.push(...ants);
        continue;
      }

      // 日本語が主体の行
      if (isJapaneseMajority(line)) {
        if (!entry.meaning) {
          entry.meaning = line;
        } else if (currentExample.en) {
          // 例文の和訳
          currentExample.ja = line;
          entry.examples.push({ ...currentExample });
          currentExample = { en: '', ja: '' };
        }
        continue;
      }

      // 英語が主体の行 → 例文
      if (isEnglishMajority(line) && i > 0) {
        if (currentExample.en) {
          // 前の例文を保存
          entry.examples.push({ ...currentExample });
        }
        currentExample = { en: line, ja: '' };
        continue;
      }
    }

    // 未保存の例文
    if (currentExample.en) {
      entry.examples.push(currentExample);
    }

    return entry;
  }

  /**
   * フリーテキスト（番号なし）の解析
   */
  function parseFreeText(text) {
    const entries = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    let currentEntry = null;

    for (const line of lines) {
      // 英単語で始まる行 → 新しいエントリ
      if (/^[a-zA-Z][\w-]+/.test(line) && !isEnglishSentence(line)) {
        if (currentEntry && currentEntry.word) {
          entries.push(currentEntry);
        }
        currentEntry = {
          word: line.match(/^([a-zA-Z][\w-]+)/)[1],
          meaning: '',
          phonetic: '',
          pos: '',
          examples: [],
          synonyms: [],
          antonyms: []
        };

        // 同じ行に意味がある場合
        const rest = line.replace(/^[a-zA-Z][\w-]+\s*/, '');
        if (rest && isJapaneseMajority(rest)) {
          currentEntry.meaning = rest;
        }
      } else if (currentEntry) {
        if (isJapaneseMajority(line) && !currentEntry.meaning) {
          currentEntry.meaning = line;
        } else if (/^[≒≈~～類同]/.test(line)) {
          currentEntry.synonyms.push(...extractSynonyms(line));
        }
      }
    }

    if (currentEntry && currentEntry.word) {
      entries.push(currentEntry);
    }

    return entries;
  }

  // --- ヘルパー関数 ---

  function isJapaneseMajority(text) {
    const japaneseChars = (text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && japaneseChars / totalChars > 0.3;
  }

  function isEnglishMajority(text) {
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && englishChars / totalChars > 0.5;
  }

  function isEnglishSentence(text) {
    return text.split(/\s+/).length > 3 && isEnglishMajority(text);
  }

  function extractJapanesePart(line, word) {
    // 品詞表記の後の日本語部分を抽出
    const patterns = [
      /(?:形|名|動|副|接|前|助|間|代)\s*([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF].+)/,
      /[\]）)]\s*([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF].+)/
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
    return '';
  }

  function extractSynonyms(line) {
    // 先頭のマーカーを除去して英単語を抽出
    const cleaned = line.replace(/^[≒≈~～⇔↔類同反\s]+/, '');
    return cleaned.split(/[,、\s]+/)
      .map(s => s.trim())
      .filter(s => /^[a-zA-Z]/.test(s) && s.length > 1);
  }

  /**
   * 画像をリサイズ（メモリ効率化・OCR精度向上）
   * 【UX視点】大きな画像はリサイズしてOCR速度を改善
   */
  function preprocessImage(file, maxWidth = 2000) {
    return new Promise((resolve) => {
      const img = new Image();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      img.onload = () => {
        let { width, height } = img;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        // コントラスト強調（OCR精度向上）
        ctx.filter = 'contrast(1.3) brightness(1.1)';
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(resolve, 'image/png');
      };

      img.src = URL.createObjectURL(file);
    });
  }

  /**
   * 終了処理
   */
  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      isInitialized = false;
    }
  }

  return {
    init,
    recognize,
    parseSystemEitan,
    preprocessImage,
    terminate
  };
})();
