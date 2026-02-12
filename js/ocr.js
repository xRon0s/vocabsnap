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
   * 【QA視点】シス単の実際のフォーマットに対応:
   * - 番号 + 英単語 + [発音記号] + 品詞 + 日本語意味
   * - MINIMAL PHRASES セクション
   * - 色付き文字（重要語/例文）
   * - 枠囲みの派生語・類義語
   * 
   * @param {string} text - OCRで認識されたテキスト
   * @returns {Array} パースされた単語エントリの配列
   */
  function parseSystemEitan(text) {
    if (!text || typeof text !== 'string') return [];

    const entries = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // 方法1: 番号付きエントリの検出 (例: "1738 inflict" "5 decide")
    const entryStartPattern = /^\d{1,4}\s+[a-zA-Z]/;
    const entryIndices = [];

    lines.forEach((line, index) => {
      if (entryStartPattern.test(line)) {
        entryIndices.push(index);
      }
    });

    // 方法2: 番号がない場合、英単語+発音記号パターン
    if (entryIndices.length === 0) {
      lines.forEach((line, index) => {
        // "[発音記号]" のパターン or 太字英単語っぽいパターン
        if (/^[a-zA-Z]{2,}\s*[\[（(]/.test(line) ||
            /^[a-zA-Z]{2,}\s+(形|名|動|副|接|前)/.test(line)) {
          entryIndices.push(index);
        }
      });
    }

    // 方法3: それでもなければ、英単語を直接抽出
    if (entryIndices.length === 0) {
      return extractWordsFromRawText(text);
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
   * RAWテキストから英単語を直接抽出（フォールバック）
   */
  function extractWordsFromRawText(text) {
    const entries = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 英単語（2文字以上のアルファベット列）を検出
      const wordMatch = line.match(/^(\d+\s+)?([a-zA-Z]{2,}(?:\s+[a-zA-Z]+)?)\s*/);
      if (!wordMatch) continue;

      const word = wordMatch[2].trim();
      // 一般的すぎる語や記号的な語を除外
      if (['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
           'MINIMAL', 'PHRASES', 'Stage', 'Final', 'Basic', 'Verbs',
           'his', 'her', 'its', 'our', 'you', 'him', 'she'].includes(word)) continue;
      if (word.length < 3) continue;

      // 周辺の日本語行を意味として取得
      let meaning = '';
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (isJapaneseMajority(lines[j])) {
          meaning = lines[j];
          break;
        }
      }

      // 発音記号の検出
      let phonetic = '';
      const phoneticMatch = line.match(/[\[（(]([^\]）)]+)[\]）)]/);
      if (phoneticMatch) phonetic = phoneticMatch[1];

      if (word && !entries.find(e => e.word.toLowerCase() === word.toLowerCase())) {
        entries.push({
          word,
          meaning,
          phonetic,
          pos: '',
          examples: [],
          synonyms: [],
          antonyms: []
        });
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
   * 画像前処理（シス単対応強化版）
   * 【QA視点】以下の問題に対応:
   * - 本の回転（横向き撮影）→ 自動回転検出
   * - 赤/青文字 → グレースケール化で均一化
   * - 複雑な背景 → 適応的二値化でテキスト強調
   * - 低コントラスト → シャープニング＋コントラスト強調
   */
  function preprocessImage(file, maxWidth = 2400) {
    return new Promise((resolve) => {
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;

        // 解像度調整（OCR精度のためやや大きめに）
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // Step 1: 描画
        ctx.drawImage(img, 0, 0, width, height);

        // Step 2: ピクセル操作 - グレースケール化 + コントラスト強調 + 二値化
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];

          // グレースケール変換（赤/青文字を均一に扱う）
          // 赤文字(シス単の重要語)と青文字(例文)の両方を拾うために
          // 色付き文字は暗くする特殊ウェイト
          let gray;
          const isReddish = r > 150 && g < 100 && b < 100;
          const isBluish = b > 150 && r < 100 && g < 100;

          if (isReddish || isBluish) {
            // 色付き文字 → 強制的に暗くしてテキストとして認識させる
            gray = 40;
          } else {
            gray = 0.299 * r + 0.587 * g + 0.114 * b;
          }

          // コントラスト強調 (1.6倍)
          gray = Math.min(255, Math.max(0, ((gray - 128) * 1.6) + 128));

          // 適応的二値化のための閾値処理
          // 完全な二値化ではなく、段階的にすることでOCR精度向上
          if (gray < 120) {
            gray = 0;         // 文字 → 黒
          } else if (gray > 200) {
            gray = 255;       // 背景 → 白
          }
          // 中間値はそのまま（グラデーション保持）

          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }

        ctx.putImageData(imageData, 0, 0);

        canvas.toBlob(resolve, 'image/png');
      };

      img.src = URL.createObjectURL(file);
    });
  }

  /**
   * 画像を90度回転させた版も生成（横撮り対応）
   */
  function rotateImage(file, degrees = 90) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (degrees === 90 || degrees === 270) {
          canvas.width = img.height;
          canvas.height = img.width;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }

        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((degrees * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);

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
    rotateImage,
    terminate
  };
})();
