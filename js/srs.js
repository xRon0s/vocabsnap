/* ======================================================
   SRS - 間隔反復アルゴリズム (SM-2ベース)
   ======================================================
   【アーキテクト視点】
   - SM-2 アルゴリズムを採用: 学術的に実証済みの手法
   - 品質(quality)は 0-5 の6段階で評価
   - 0-2: 不正解(リセット), 3: ギリギリ, 4: 正解, 5: 完璧
   
   【ユーザー視点】
   - 苦手な単語は高頻度、得意な単語は低頻度で出題
   - 学習効率の最大化
   ====================================================== */

const SRS = (function () {
  'use strict';

  // SM-2 アルゴリズムの定数
  const MIN_EASE_FACTOR = 1.3;
  const DEFAULT_EASE_FACTOR = 2.5;

  /**
   * SM-2 に基づいて次回復習パラメータを計算
   * @param {number} quality - 回答品質 (0-5)
   * @param {number} repetitions - 連続正解回数
   * @param {number} easeFactor - 容易度 (≥ 1.3)
   * @param {number} interval - 現在のインターバル（日）
   * @returns {{ repetitions, easeFactor, interval, nextReview }}
   */
  function calculate(quality, repetitions, easeFactor, interval) {
    let newRepetitions = repetitions;
    let newEaseFactor = easeFactor;
    let newInterval = interval;

    if (quality >= 3) {
      // 正解
      switch (newRepetitions) {
        case 0:
          newInterval = 1;
          break;
        case 1:
          newInterval = 6;
          break;
        default:
          newInterval = Math.round(interval * easeFactor);
          break;
      }
      newRepetitions++;
    } else {
      // 不正解: リセット
      newRepetitions = 0;
      newInterval = 1;
    }

    // 容易度の更新
    newEaseFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (newEaseFactor < MIN_EASE_FACTOR) {
      newEaseFactor = MIN_EASE_FACTOR;
    }

    // 次回復習日時
    const nextReview = Date.now() + (newInterval * 24 * 60 * 60 * 1000);

    return {
      repetitions: newRepetitions,
      easeFactor: Math.round(newEaseFactor * 100) / 100,
      interval: newInterval,
      nextReview: nextReview,
      lastReview: Date.now()
    };
  }

  /**
   * 単語のSRSデータを更新
   * @param {Object} word - 単語オブジェクト
   * @param {number} quality - 回答品質 (0-5)
   * @returns {Object} 更新された単語オブジェクト
   */
  function reviewWord(word, quality) {
    const srs = word.srs || initialData();
    const newSRS = calculate(quality, srs.repetitions, srs.easeFactor, srs.interval);
    return { ...word, srs: newSRS };
  }

  /**
   * SRS初期データを生成
   */
  function initialData() {
    return {
      repetitions: 0,
      easeFactor: DEFAULT_EASE_FACTOR,
      interval: 0,
      nextReview: null,
      lastReview: null
    };
  }

  /**
   * 復習が必要な単語をフィルタリング
   * @param {Array} words - 単語配列
   * @returns {Array} 復習対象の単語配列 (優先度順)
   */
  function getDueWords(words) {
    const now = Date.now();
    return words
      .filter(w => {
        if (!w.srs || !w.srs.nextReview) return true; // 未学習
        return w.srs.nextReview <= now;
      })
      .sort((a, b) => {
        // 未学習を先に、その後は期限の古い順
        const aNext = (a.srs && a.srs.nextReview) || 0;
        const bNext = (b.srs && b.srs.nextReview) || 0;
        return aNext - bNext;
      });
  }

  /**
   * 単語の習得レベルを判定
   * @param {Object} word - 単語オブジェクト
   * @returns {string} 'new' | 'learning' | 'reviewing' | 'mastered'
   */
  function getLevel(word) {
    const srs = word.srs || initialData();
    if (srs.repetitions === 0 && !srs.lastReview) return 'new';
    if (srs.repetitions < 2) return 'learning';
    if (srs.interval >= 21) return 'mastered';
    return 'reviewing';
  }

  /**
   * レベルに応じた色を返す
   */
  function getLevelColor(word) {
    const level = getLevel(word);
    switch (level) {
      case 'new': return '#9E9E9E';
      case 'learning': return '#FF9800';
      case 'reviewing': return '#2196F3';
      case 'mastered': return '#4CAF50';
      default: return '#9E9E9E';
    }
  }

  /**
   * レベルに応じたラベルを返す
   */
  function getLevelLabel(word) {
    const level = getLevel(word);
    switch (level) {
      case 'new': return '新規';
      case 'learning': return '学習中';
      case 'reviewing': return '復習中';
      case 'mastered': return '習得済';
      default: return '新規';
    }
  }

  return {
    calculate,
    reviewWord,
    initialData,
    getDueWords,
    getLevel,
    getLevelColor,
    getLevelLabel
  };
})();
