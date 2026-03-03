/* ======================================================
   VocabSnap - メインアプリケーション
   ======================================================
   【各役割からの設計判断】
   
   アーキテクト: SPA方式、画面遷移はDOM切替、状態管理はシンプルオブジェクト
   開発者: 即時実行関数でスコープ分離、イベント委譲で効率化
   QA: 空状態・エラー状態・カメラ拒否等のエッジケース対応
   セキュリティ: innerHTML使用時はエスケープ処理、外部通信なし
   UX: スムーズなアニメーション、触覚フィードバック、音声読み上げ
   ユーザー: 直感的操作、学習モチベーション維持、ストレスのない遷移
   ====================================================== */

const App = (function () {
  'use strict';

  // --- 状態管理 ---
  const state = {
    currentScreen: 'home',
    screenHistory: ['home'],
    selectedImage: null,
    parsedWords: [],
    studyWords: [],
    studyFilter: 'all',
    studyTagFilter: '__all__',
    sessionLimit: 0,
    wordlistFilter: 'all',
    wordlistTagFilter: '__all__',
    currentWordId: null,
    lastStudyMode: null,
    rawOcrText: '',
    rotationDeg: 0,

    // フラッシュカード
    fcIndex: 0,
    fcFlipped: false,
    fcCorrect: 0,
    fcIncorrect: 0,
    fcStartTime: 0,

    // 文章読解
    rdIndex: 0,
    rdFlipped: false,
    rdCorrect: 0,
    rdIncorrect: 0,
    rdStartTime: 0,

    // スペル入力
    spIndex: 0,
    spHintLevel: 0,
    spCorrect: 0,
    spIncorrect: 0,
    spAnswered: false,
    spStartTime: 0,

    // マッチング
    mtTiles: [],
    mtSelected: null,
    mtMatched: 0,
    mtTotal: 0,
    mtAttempts: 0,
    mtTimer: null,
    mtSeconds: 0,
    mtStartTime: 0,

    // 設定
    darkMode: false,
    autoSpeak: false,
    dailyGoal: 20,

    // 翻訳
    captureStream: null,
    captureTimer: null,
    captureInterval: 5000,
    isCapturing: false,
    translateOriginalSrc: null,
    translateOverlaySrc: null,
    translateOverlayBlob: null,
    showOverlay: true,
    lastOcrLines: []
  };

  // --- XSSエスケープ【セキュリティ視点】 ---
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- 初期化 ---
  async function init() {
    try {
      await VocabDB.init();
      await loadSettings();
      setupEventListeners();
      await refreshHome();
      await checkUrlImport();
      registerServiceWorker();

      // スプラッシュ非表示
      setTimeout(() => {
        document.getElementById('splash-screen').classList.add('hidden');
      }, 600);
    } catch (e) {
      console.error('初期化エラー:', e);
      document.getElementById('splash-screen').querySelector('.splash-text').textContent = 'エラーが発生しました';
    }
  }

  // --- Service Worker 登録 ---
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(e => console.log('SW登録失敗:', e));
    }
    // 【セキュリティ・ユーザー視点】永続ストレージをリクエスト
    // ブラウザがストレージ不足時に自動削除するのを防止
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(granted => {
        if (granted) console.log('永続ストレージ: 許可');
        else console.log('永続ストレージ: 未許可 (ブラウザ判断)');
      });
    }
  }

  // --- 設定読み込み ---
  async function loadSettings() {
    state.darkMode = await VocabDB.getSetting('darkMode', false);
    state.autoSpeak = await VocabDB.getSetting('autoSpeak', false);
    state.dailyGoal = await VocabDB.getSetting('dailyGoal', 20);

    if (state.darkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.getElementById('toggle-darkmode').classList.add('active');
    }
    if (state.autoSpeak) {
      document.getElementById('toggle-auto-speak').classList.add('active');
    }
    document.getElementById('daily-goal-value').textContent = state.dailyGoal;
  }

  // --- 画面遷移 ---
  function navigate(screenId, addHistory = true) {
    const prev = document.querySelector('.screen.active');
    const next = document.getElementById('screen-' + screenId);
    if (!next || (prev && prev.id === 'screen-' + screenId)) return;

    if (prev) prev.classList.remove('active');
    next.classList.add('active');
    next.classList.add('slide-in');
    setTimeout(() => next.classList.remove('slide-in'), 300);

    // ナビバー更新
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-item[data-nav="${screenId}"]`);
    if (navBtn) navBtn.classList.add('active');

    if (addHistory && state.currentScreen !== screenId) {
      state.screenHistory.push(screenId);
    }
    state.currentScreen = screenId;

    // 画面固有の初期化
    onScreenEnter(screenId);
  }

  function goBack() {
    if (state.screenHistory.length > 1) {
      state.screenHistory.pop();
      const prev = state.screenHistory[state.screenHistory.length - 1];
      navigate(prev, false);
    } else {
      navigate('home', false);
    }
  }

  async function onScreenEnter(screenId) {
    switch (screenId) {
      case 'home':
        await refreshHome();
        break;
      case 'study':
        await refreshStudy();
        break;
      case 'wordlist':
        await refreshWordlist();
        break;
    }
  }

  // ===================================================
  // ホーム画面
  // ===================================================
  async function refreshHome() {
    try {
      const [totalCount, dueWords, streak, mastered, weakWords, allWords] = await Promise.all([
        VocabDB.getWordCount(),
        VocabDB.getDueWords(),
        VocabDB.getStreak(),
        VocabDB.getMasteredWords(),
        VocabDB.getWeakWords(5),
        VocabDB.getAllWords()
      ]);

      document.getElementById('stat-total').textContent = totalCount;
      document.getElementById('stat-due').textContent = dueWords.length;
      document.getElementById('stat-streak').textContent = streak;
      document.getElementById('stat-mastered').textContent = mastered.length;

      // ナビバッジ
      const badge = document.getElementById('nav-badge-study');
      if (dueWords.length > 0) {
        badge.textContent = dueWords.length;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }

      // 最近の単語
      const recentContainer = document.getElementById('recent-words');
      const emptyRecent = document.getElementById('empty-recent');
      if (allWords.length === 0) {
        emptyRecent.classList.remove('hidden');
        recentContainer.innerHTML = '';
        recentContainer.appendChild(emptyRecent);
      } else {
        emptyRecent.classList.add('hidden');
        const recent = allWords.sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
        recentContainer.innerHTML = recent.map(w => wordCardHTML(w)).join('');
      }

      // 苦手な単語
      const weakContainer = document.getElementById('weak-words');
      const weakSection = document.getElementById('section-weak');
      if (weakWords.length > 0) {
        weakSection.classList.remove('hidden');
        weakContainer.innerHTML = weakWords.map(w => wordCardHTML(w)).join('');
      } else {
        weakSection.classList.add('hidden');
      }
    } catch (e) {
      console.error('ホーム更新エラー:', e);
    }
  }

  function wordCardHTML(word) {
    const levelColor = SRS.getLevelColor(word);
    const levelLabel = SRS.getLevelLabel(word);
    const tagsHtml = (word.tags && word.tags.length > 0)
      ? `<div class="word-tags">${word.tags.map(t => `<span class="word-tag-chip">${esc(t)}</span>`).join('')}</div>`
      : '';
    return `
      <div class="word-card" data-word-id="${esc(word.id)}">
        <div class="word-level" style="background:${levelColor}"></div>
        <div class="word-info">
          <div class="word-text">${esc(word.wordDisplay || word.word)}</div>
          <div class="word-meaning">${esc(word.meaning)}</div>
          ${tagsHtml}
        </div>
        <button class="bookmark-btn ${word.bookmarked ? 'active' : ''}" data-bookmark="${esc(word.id)}">
          ${word.bookmarked ? '⭐' : '☆'}
        </button>
      </div>
    `;
  }

  // ===================================================
  // 撮影 & OCR
  // ===================================================
  function handleImageSelected(file) {
    if (!file) return;

    // 【セキュリティ視点】ファイル型チェック
    if (!file.type.startsWith('image/')) {
      showToast('画像ファイルを選択してください');
      return;
    }

    state.selectedImage = file;
    state.rotationDeg = 0;
    const preview = document.getElementById('capture-preview');
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `<img src="${e.target.result}" alt="プレビュー" id="preview-img">`;
    };
    reader.readAsDataURL(file);

    document.getElementById('btn-ocr-start').classList.remove('hidden');
    // 回転ボタン表示
    const imageTools = document.getElementById('image-tools');
    if (imageTools) imageTools.classList.remove('hidden');
  }

  async function rotateImage(degrees) {
    if (!state.selectedImage) return;
    state.rotationDeg = (state.rotationDeg + degrees + 360) % 360;
    try {
      const rotated = await OCRProcessor.rotateImage(state.selectedImage, state.rotationDeg);
      state.selectedImage = rotated;
      const preview = document.getElementById('capture-preview');
      const reader = new FileReader();
      reader.onload = (e) => {
        preview.innerHTML = `<img src="${e.target.result}" alt="プレビュー" id="preview-img">`;
      };
      reader.readAsDataURL(rotated);
      showToast(`${state.rotationDeg}° 回転しました`);
    } catch (e) {
      console.error('回転エラー:', e);
      showToast('回転に失敗しました');
    }
  }

  async function startOCR() {
    if (!state.selectedImage) return;

    const progressOverlay = document.getElementById('ocr-progress');
    const statusEl = document.getElementById('ocr-status');
    const percentEl = document.getElementById('ocr-percent');

    progressOverlay.classList.remove('hidden');

    try {
      // 画像前処理
      statusEl.textContent = '画像を処理中...';
      percentEl.textContent = '';

      let processed;
      try {
        processed = await OCRProcessor.preprocessImage(state.selectedImage);
        console.log('[App] Preprocessed image ready');
      } catch (preErr) {
        console.warn('[App] Preprocessing failed, using raw image:', preErr);
        processed = state.selectedImage; // 前処理失敗時は元画像で試行
      }

      // OCR実行（英語 + 日本語の2パス）
      statusEl.textContent = 'OCRエンジン準備中...';
      percentEl.textContent = '';
      const text = await OCRProcessor.recognize(processed, (status, progress) => {
        statusEl.textContent = status;
        percentEl.textContent = progress + '%';
      });

      console.log('[App] OCR result length:', text.length);

      // RAWテキスト保存
      state.rawOcrText = text;

      // テキスト解析
      statusEl.textContent = 'テキストを解析中...';
      const parsed = OCRProcessor.parseSystemEitan(text);

      progressOverlay.classList.add('hidden');

      state.parsedWords = parsed;
      showParsedWords();
      navigate('edit-parsed');

      // RAWテキストをtextareaにセット
      const rawTextArea = document.getElementById('raw-ocr-text');
      if (rawTextArea) rawTextArea.value = text;

      // RAWテキストセクションを表示
      const rawSection = document.getElementById('raw-text-section');
      if (rawSection) rawSection.classList.remove('hidden');

      if (parsed.length === 0) {
        document.getElementById('empty-parsed').classList.remove('hidden');
        showToast('テキストを検出できませんでした。認識テキストを編集して再解析してください。');
      } else {
        showToast(`${parsed.length}個の単語を検出しました`);
      }
    } catch (e) {
      console.error('OCRエラー:', e);
      progressOverlay.classList.add('hidden');
      showToast('読み取りに失敗しました: ' + e.message);
    }
  }

  function showParsedWords() {
    const container = document.getElementById('parsed-words-list');
    const emptyEl = document.getElementById('empty-parsed');

    if (state.parsedWords.length === 0) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    container.innerHTML = state.parsedWords.map((w, i) => `
      <div class="parsed-word-item" data-parsed-index="${i}">
        <div class="pw-header">
          <span class="pw-word">${esc(w.word)}</span>
          <button class="pw-delete" data-delete-parsed="${i}">✕</button>
        </div>
        <div class="input-group">
          <label>英単語</label>
          <input type="text" class="input-field" data-parsed-field="word" value="${esc(w.word)}">
        </div>
        <div class="input-group">
          <label>意味</label>
          <input type="text" class="input-field" data-parsed-field="meaning" value="${esc(w.meaning)}">
        </div>
        <div class="input-group">
          <label>発音記号</label>
          <input type="text" class="input-field" data-parsed-field="phonetic" value="${esc(w.phonetic)}">
        </div>
        <div class="input-group">
          <label>品詞</label>
          <input type="text" class="input-field" data-parsed-field="pos" value="${esc(w.pos)}">
        </div>
        <div class="input-group">
          <label>例文</label>
          <input type="text" class="input-field" data-parsed-field="example" value="${esc(w.examples && w.examples[0] ? w.examples[0].en : '')}">
        </div>
        <div class="input-group">
          <label>類義語 (カンマ区切り)</label>
          <input type="text" class="input-field" data-parsed-field="synonyms" value="${esc(w.synonyms ? w.synonyms.join(', ') : '')}">
        </div>
      </div>
    `).join('');
  }

  function reparseRawText() {
    const rawTextArea = document.getElementById('raw-ocr-text');
    if (!rawTextArea) return;
    const text = rawTextArea.value.trim();
    if (!text) {
      showToast('テキストが空です');
      return;
    }
    state.rawOcrText = text;
    const parsed = OCRProcessor.parseSystemEitan(text);
    state.parsedWords = parsed;
    showParsedWords();
    if (parsed.length > 0) {
      showToast(`${parsed.length}個の単語を再検出しました`);
    } else {
      showToast('単語を検出できませんでした。テキストを修正してください。');
    }
  }

  function toggleRawTextSection() {
    const rawSection = document.getElementById('raw-text-section');
    if (!rawSection) return;
    rawSection.classList.toggle('hidden');
    // テキストが空ならstateのを入れる
    const rawTextArea = document.getElementById('raw-ocr-text');
    if (rawTextArea && !rawTextArea.value && state.rawOcrText) {
      rawTextArea.value = state.rawOcrText;
    }
  }

  async function saveParsedWords() {
    const items = document.querySelectorAll('.parsed-word-item');
    const words = [];

    items.forEach(item => {
      const word = item.querySelector('[data-parsed-field="word"]').value.trim();
      const meaning = item.querySelector('[data-parsed-field="meaning"]').value.trim();

      // 【QA視点】単語と意味の両方が必要
      if (!word || !meaning) return;

      const exampleText = item.querySelector('[data-parsed-field="example"]').value.trim();
      const synonymsText = item.querySelector('[data-parsed-field="synonyms"]').value.trim();

      words.push({
        word,
        meaning,
        phonetic: item.querySelector('[data-parsed-field="phonetic"]').value.trim(),
        pos: item.querySelector('[data-parsed-field="pos"]').value.trim(),
        examples: exampleText ? [{ en: exampleText, ja: '' }] : [],
        synonyms: synonymsText ? synonymsText.split(/[,、]/).map(s => s.trim()).filter(s => s) : []
      });
    });

    if (words.length === 0) {
      showToast('保存する単語がありません');
      return;
    }

    try {
      await VocabDB.addWords(words);
      showToast(`${words.length}個の単語を保存しました`);
      state.parsedWords = [];
      state.selectedImage = null;
      state.rawOcrText = '';
      state.rotationDeg = 0;

      // プレビューリセット
      document.getElementById('capture-preview').innerHTML = `
        <div class="capture-placeholder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <p>写真を撮影または選択</p>
        </div>`;
      document.getElementById('btn-ocr-start').classList.add('hidden');
      const imageTools = document.getElementById('image-tools');
      if (imageTools) imageTools.classList.add('hidden');
      const rawSection = document.getElementById('raw-text-section');
      if (rawSection) rawSection.classList.add('hidden');
      const rawTextArea = document.getElementById('raw-ocr-text');
      if (rawTextArea) rawTextArea.value = '';

      navigate('home');
    } catch (e) {
      showToast('保存に失敗しました');
      console.error(e);
    }
  }

  // ===================================================
  // 手動入力
  // ===================================================
  async function handleManualAdd(e) {
    e.preventDefault();

    const word = document.getElementById('manual-word').value.trim();
    const meaning = document.getElementById('manual-meaning').value.trim();

    if (!word || !meaning) {
      showToast('英単語と意味は必須です');
      return;
    }

    const exampleEn = document.getElementById('manual-example-en').value.trim();
    const exampleJa = document.getElementById('manual-example-ja').value.trim();
    const synonymsText = document.getElementById('manual-synonyms').value.trim();
    const tagsText = document.getElementById('manual-tags').value.trim();

    try {
      await VocabDB.addWord({
        word,
        meaning,
        phonetic: document.getElementById('manual-phonetic').value.trim(),
        pos: document.getElementById('manual-pos').value.trim(),
        examples: exampleEn ? [{ en: exampleEn, ja: exampleJa }] : [],
        synonyms: synonymsText ? synonymsText.split(/[,、]/).map(s => s.trim()).filter(s => s) : [],
        tags: tagsText ? tagsText.split(/[,、]/).map(s => s.trim()).filter(s => s) : []
      });

      showToast('単語を追加しました');
      e.target.reset();
      goBack();
    } catch (e2) {
      showToast('追加に失敗しました');
      console.error(e2);
    }
  }

  // ===================================================
  // 学習モード
  // ===================================================
  async function refreshStudy() {
    // タグフィルター更新
    await updateStudyTagFilter();

    let all = await VocabDB.getAllWords();

    // タグフィルター適用
    if (state.studyTagFilter && state.studyTagFilter !== '__all__') {
      all = all.filter(w => w.tags && w.tags.some(t => t === state.studyTagFilter));
    }

    const due = SRS.getDueWords(all);
    const limit = state.sessionLimit;

    const fcTotal = limit > 0 ? Math.min(all.length, limit) : all.length;
    const spTotal = limit > 0 ? Math.min(all.length, limit) : all.length;
    const mtTotal = Math.min(all.length, 6);
    const rvTotal = limit > 0 ? Math.min(due.length, limit) : due.length;

    document.getElementById('fc-count').textContent = fcTotal;
    document.getElementById('sp-count').textContent = spTotal;
    document.getElementById('mt-count').textContent = mtTotal;
    document.getElementById('rv-count').textContent = rvTotal;

    // 例文付きの単語数
    const wordsWithExamples = all.filter(w => w.examples && w.examples.length > 0 && w.examples[0].en);
    const rdTotal = limit > 0 ? Math.min(wordsWithExamples.length, limit) : wordsWithExamples.length;
    document.getElementById('rd-count').textContent = rdTotal;

    const emptyStudy = document.getElementById('empty-study');
    if (all.length === 0) {
      emptyStudy.classList.remove('hidden');
    } else {
      emptyStudy.classList.add('hidden');
    }
  }

  async function updateStudyTagFilter() {
    const tags = await VocabDB.getAllTags();
    const bar = document.getElementById('study-tag-filter-bar');
    const select = document.getElementById('study-tag-filter-select');

    if (tags.length === 0) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'block';
    const currentValue = state.studyTagFilter;

    select.innerHTML = '<option value="__all__">📚 すべての教科書</option>' +
      tags.map(t => `<option value="${esc(t)}" ${t === currentValue ? 'selected' : ''}>🏷️ ${esc(t)}</option>`).join('');
  }

  async function getStudyWords() {
    let words = [];
    switch (state.studyFilter) {
      case 'new':
        words = (await VocabDB.getAllWords()).filter(w => SRS.getLevel(w) === 'new');
        break;
      case 'bookmarked':
        words = await VocabDB.getBookmarkedWords();
        break;
      case 'weak':
        words = await VocabDB.getWeakWords(9999);
        break;
      default:
        words = await VocabDB.getAllWords();
    }

    // タグフィルター適用
    if (state.studyTagFilter && state.studyTagFilter !== '__all__') {
      words = words.filter(w => w.tags && w.tags.some(t => t === state.studyTagFilter));
    }

    words = shuffleArray(words);

    // セッション単語数制限
    if (state.sessionLimit > 0 && words.length > state.sessionLimit) {
      words = words.slice(0, state.sessionLimit);
    }

    return words;
  }

  async function startStudyMode(mode) {
    let words;

    if (mode === 'review') {
      words = await VocabDB.getDueWords();
      // タグフィルター適用
      if (state.studyTagFilter && state.studyTagFilter !== '__all__') {
        words = words.filter(w => w.tags && w.tags.some(t => t === state.studyTagFilter));
      }
      if (words.length === 0) {
        showToast('今日の復習はありません！');
        return;
      }
      words = shuffleArray(words);
      // セッション単語数制限
      if (state.sessionLimit > 0 && words.length > state.sessionLimit) {
        words = words.slice(0, state.sessionLimit);
      }
    } else {
      words = await getStudyWords();
    }

    if (words.length === 0) {
      showToast('学習する単語がありません');
      return;
    }

    state.studyWords = words;
    state.lastStudyMode = mode;

    switch (mode) {
      case 'flashcard':
      case 'review':
        startFlashcard();
        break;
      case 'spelling':
        startSpelling();
        break;
      case 'matching':
        startMatching();
        break;
      case 'reading':
        startReading();
        break;
    }
  }


  // ===================================================
  // フラッシュカード
  // ===================================================
  function startFlashcard() {
    state.fcIndex = 0;
    state.fcFlipped = false;
    state.fcCorrect = 0;
    state.fcIncorrect = 0;
    state.fcStartTime = Date.now();

    navigate('flashcard');
    showFlashcard();
  }

  function showFlashcard() {
    if (state.fcIndex >= state.studyWords.length) {
      finishStudy('flashcard', state.fcCorrect, state.fcIncorrect);
      return;
    }

    const word = state.studyWords[state.fcIndex];
    const inner = document.getElementById('flashcard-inner');
    inner.classList.remove('flipped');
    state.fcFlipped = false;

    document.getElementById('fc-word').textContent = word.wordDisplay || word.word;
    document.getElementById('fc-phonetic').textContent = word.phonetic ? `[${word.phonetic}]` : '';
    document.getElementById('fc-pos').textContent = word.pos || '';
    document.getElementById('fc-meaning').textContent = word.meaning;

    // 例文
    const exEl = document.getElementById('fc-examples');
    if (word.examples && word.examples.length > 0) {
      exEl.textContent = word.examples[0].en;
    } else {
      exEl.textContent = '';
    }

    // 類義語
    const synEl = document.getElementById('fc-synonyms');
    if (word.synonyms && word.synonyms.length > 0) {
      synEl.textContent = '≒ ' + word.synonyms.join(', ');
    } else {
      synEl.textContent = '';
    }

    // プログレス
    const progress = ((state.fcIndex) / state.studyWords.length) * 100;
    document.getElementById('fc-progress-fill').style.width = progress + '%';
    document.getElementById('fc-progress-text').textContent =
      `${state.fcIndex + 1} / ${state.studyWords.length}`;

    // 【UX視点】自動発音
    if (state.autoSpeak) {
      speak(word.word);
    }

    // カードリセットアニメーション
    const card = document.getElementById('flashcard');
    card.classList.remove('swiping-right', 'swiping-left');
  }

  function flipFlashcard() {
    const inner = document.getElementById('flashcard-inner');
    state.fcFlipped = !state.fcFlipped;
    inner.classList.toggle('flipped');
  }

  async function answerFlashcard(correct) {
    const word = state.studyWords[state.fcIndex];
    const card = document.getElementById('flashcard');
    const inner = document.getElementById('flashcard-inner');

    // スワイプアニメーション
    card.classList.add(correct ? 'swiping-right' : 'swiping-left');

    if (correct) {
      state.fcCorrect++;
      word.stats.flashcardCorrect++;
      word.srs = SRS.calculate(4, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
    } else {
      state.fcIncorrect++;
      word.stats.flashcardIncorrect++;
      word.srs = SRS.calculate(1, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
    }

    await VocabDB.updateWord(word);

    setTimeout(() => {
      // 答えが見えた状態なら、先にtransition無しで表面に戻してから内容更新
      if (state.fcFlipped) {
        inner.style.transition = 'none';
        inner.classList.remove('flipped');
        state.fcFlipped = false;
        // リフロー強制後に内容更新 & transition復元
        inner.offsetHeight; // force reflow
        inner.style.transition = '';
      }
      state.fcIndex++;
      showFlashcard();
    }, 300);
  }

  // ===================================================
  // スペル入力
  // ===================================================
  function startSpelling() {
    state.spIndex = 0;
    state.spHintLevel = 0;
    state.spCorrect = 0;
    state.spIncorrect = 0;
    state.spAnswered = false;
    state.spStartTime = Date.now();

    navigate('spelling');
    showSpellingQuestion();
  }

  function showSpellingQuestion() {
    if (state.spIndex >= state.studyWords.length) {
      finishStudy('spelling', state.spCorrect, state.spIncorrect);
      return;
    }

    const word = state.studyWords[state.spIndex];
    state.spHintLevel = 0;
    state.spAnswered = false;

    document.getElementById('sp-meaning').textContent = word.meaning;
    document.getElementById('sp-pos').textContent = word.pos || '';
    document.getElementById('sp-hint').textContent = `${word.word.length}文字`;
    document.getElementById('sp-correct-answer').textContent = '';

    const input = document.getElementById('sp-input');
    input.value = '';
    input.className = 'spelling-input';
    input.disabled = false;
    input.focus();

    document.getElementById('btn-sp-submit').classList.remove('hidden');
    document.getElementById('btn-sp-hint').classList.remove('hidden');
    document.getElementById('btn-sp-next').classList.add('hidden');

    // プログレス
    const progress = ((state.spIndex) / state.studyWords.length) * 100;
    document.getElementById('sp-progress-fill').style.width = progress + '%';
    document.getElementById('sp-progress-text').textContent =
      `${state.spIndex + 1} / ${state.studyWords.length}`;
  }

  function showSpellingHint() {
    const word = state.studyWords[state.spIndex];
    state.spHintLevel++;

    if (state.spHintLevel === 1) {
      document.getElementById('sp-hint').textContent =
        `最初の文字: ${word.word[0].toUpperCase()}__ (${word.word.length}文字)`;
    } else if (state.spHintLevel === 2) {
      const hint = word.word.split('').map((c, i) => i < 2 ? c : '_').join(' ');
      document.getElementById('sp-hint').textContent = hint;
    } else {
      const hint = word.word.split('').map((c, i) => i % 2 === 0 ? c : '_').join(' ');
      document.getElementById('sp-hint').textContent = hint;
    }
  }

  async function checkSpelling() {
    if (state.spAnswered) return;

    const word = state.studyWords[state.spIndex];
    const input = document.getElementById('sp-input');
    const answer = input.value.trim().toLowerCase();

    if (!answer) {
      showToast('入力してください');
      return;
    }

    state.spAnswered = true;
    const correct = answer === word.word.toLowerCase();

    input.classList.add(correct ? 'correct' : 'incorrect');
    input.disabled = true;

    if (correct) {
      state.spCorrect++;
      word.stats.spellingCorrect++;
      word.srs = SRS.calculate(correct ? 5 : 1, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
      speak(word.word);
    } else {
      state.spIncorrect++;
      word.stats.spellingIncorrect++;
      word.srs = SRS.calculate(1, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
      document.getElementById('sp-correct-answer').textContent = `正解: ${word.word}`;
    }

    await VocabDB.updateWord(word);

    document.getElementById('btn-sp-submit').classList.add('hidden');
    document.getElementById('btn-sp-hint').classList.add('hidden');
    document.getElementById('btn-sp-next').classList.remove('hidden');

    // 【ユーザー視点】正解時は自動で次へ
    if (correct) {
      setTimeout(() => {
        state.spIndex++;
        showSpellingQuestion();
      }, 1200);
    }
  }

  function nextSpelling() {
    state.spIndex++;
    showSpellingQuestion();
  }

  // ===================================================
  // マッチングゲーム
  // ===================================================
  function startMatching() {
    const count = Math.min(state.studyWords.length, 6);
    if (count < 2) {
      showToast('マッチングには最低2つの単語が必要です');
      return;
    }

    const words = state.studyWords.slice(0, count);
    const tiles = [];

    words.forEach(w => {
      tiles.push({ id: w.id, type: 'word', text: w.wordDisplay || w.word, pairId: w.id });
      tiles.push({ id: w.id + '-m', type: 'meaning', text: w.meaning, pairId: w.id });
    });

    state.mtTiles = shuffleArray(tiles);
    state.mtSelected = null;
    state.mtMatched = 0;
    state.mtTotal = count;
    state.mtAttempts = 0;
    state.mtSeconds = 0;
    state.mtStartTime = Date.now();

    navigate('matching');
    renderMatchingGrid();
    startMatchingTimer();
  }

  function renderMatchingGrid() {
    const grid = document.getElementById('matching-grid');
    grid.innerHTML = state.mtTiles.map((tile, i) => `
      <div class="matching-tile" data-tile-index="${i}" data-pair-id="${tile.pairId}">
        ${esc(tile.text)}
      </div>
    `).join('');

    document.getElementById('mt-matches').textContent = state.mtMatched;
    document.getElementById('mt-total').textContent = state.mtTotal;
    document.getElementById('mt-attempts').textContent = state.mtAttempts;
  }

  function startMatchingTimer() {
    if (state.mtTimer) clearInterval(state.mtTimer);
    state.mtTimer = setInterval(() => {
      state.mtSeconds++;
      const min = Math.floor(state.mtSeconds / 60);
      const sec = state.mtSeconds % 60;
      document.getElementById('mt-timer').textContent =
        `${min}:${sec.toString().padStart(2, '0')}`;
    }, 1000);
  }

  async function handleMatchingTileClick(tileEl) {
    const index = parseInt(tileEl.dataset.tileIndex);
    const tile = state.mtTiles[index];

    if (tileEl.classList.contains('matched')) return;

    if (state.mtSelected === null) {
      // 1枚目選択
      state.mtSelected = { index, tile, el: tileEl };
      tileEl.classList.add('selected');
    } else if (state.mtSelected.index === index) {
      // 同じタイル → 選択解除
      tileEl.classList.remove('selected');
      state.mtSelected = null;
    } else {
      // 2枚目選択
      state.mtAttempts++;
      document.getElementById('mt-attempts').textContent = state.mtAttempts;

      const first = state.mtSelected;

      if (first.tile.pairId === tile.pairId && first.tile.type !== tile.type) {
        // マッチ成功
        first.el.classList.remove('selected');
        first.el.classList.add('matched');
        tileEl.classList.add('matched');
        state.mtMatched++;
        document.getElementById('mt-matches').textContent = state.mtMatched;

        // SRS更新
        const word = state.studyWords.find(w => w.id === tile.pairId);
        if (word) {
          word.stats.matchingCorrect++;
          await VocabDB.updateWord(word);
        }

        if (state.mtMatched === state.mtTotal) {
          clearInterval(state.mtTimer);
          setTimeout(() => {
            finishStudy('matching', state.mtMatched, state.mtAttempts - state.mtMatched);
          }, 500);
        }
      } else {
        // マッチ失敗
        first.el.classList.remove('selected');
        tileEl.classList.add('wrong');
        first.el.classList.add('wrong');

        // SRS更新（不正解）
        const word = state.studyWords.find(w => w.id === tile.pairId);
        if (word) {
          word.stats.matchingIncorrect++;
          await VocabDB.updateWord(word);
        }

        setTimeout(() => {
          tileEl.classList.remove('wrong');
          first.el.classList.remove('wrong');
        }, 500);
      }

      state.mtSelected = null;
    }
  }

  // ===================================================
  // 文章読解
  // ===================================================
  async function startReading() {
    // 例文付きの単語のみを対象
    let words = await getStudyWords();
    words = words.filter(w => w.examples && w.examples.length > 0 && w.examples[0].en);

    if (words.length === 0) {
      showToast('例文付きの単語がありません');
      return;
    }

    state.studyWords = shuffleArray(words);
    state.rdIndex = 0;
    state.rdFlipped = false;
    state.rdCorrect = 0;
    state.rdIncorrect = 0;
    state.rdStartTime = Date.now();

    navigate('reading');
    showReadingCard();
  }

  function showReadingCard() {
    if (state.rdIndex >= state.studyWords.length) {
      finishStudy('reading', state.rdCorrect, state.rdIncorrect);
      return;
    }

    const word = state.studyWords[state.rdIndex];
    const inner = document.getElementById('reading-card-inner');
    inner.classList.remove('flipped');
    state.rdFlipped = false;

    // 単語バッジ表示
    document.getElementById('rd-word').textContent = word.wordDisplay || word.word;

    // 例文（英語）
    const exampleEn = word.examples[0].en;
    document.getElementById('rd-example-en').textContent = exampleEn;

    // 裏面: 訳と意味
    const exampleJa = word.examples[0].ja || '';
    document.getElementById('rd-example-ja').textContent = exampleJa || '（訳なし）';
    document.getElementById('rd-meaning').textContent = `${word.wordDisplay || word.word}: ${word.meaning}`;

    // プログレス
    const progress = ((state.rdIndex) / state.studyWords.length) * 100;
    document.getElementById('rd-progress-fill').style.width = progress + '%';
    document.getElementById('rd-progress-text').textContent =
      `${state.rdIndex + 1} / ${state.studyWords.length}`;

    // 自動発音
    if (state.autoSpeak) {
      speak(exampleEn);
    }

    // カードリセット
    const card = document.getElementById('reading-card');
    card.classList.remove('swiping-right', 'swiping-left');
  }

  function flipReadingCard() {
    const inner = document.getElementById('reading-card-inner');
    state.rdFlipped = !state.rdFlipped;
    inner.classList.toggle('flipped');
  }

  async function answerReading(correct) {
    const word = state.studyWords[state.rdIndex];
    const card = document.getElementById('reading-card');

    // スワイプアニメーション
    card.classList.add(correct ? 'swiping-right' : 'swiping-left');

    if (correct) {
      state.rdCorrect++;
      word.stats.flashcardCorrect++;
      word.srs = SRS.calculate(4, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
    } else {
      state.rdIncorrect++;
      word.stats.flashcardIncorrect++;
      word.srs = SRS.calculate(1, word.srs.repetitions, word.srs.easeFactor, word.srs.interval);
    }

    await VocabDB.updateWord(word);

    setTimeout(() => {
      state.rdIndex++;
      showReadingCard();
    }, 300);
  }

  // ===================================================
  // 学習完了
  // ===================================================
  async function finishStudy(type, correct, incorrect) {
    const total = correct + incorrect;
    const rate = total > 0 ? Math.round((correct / total) * 100) : 0;

    // ログ保存
    await VocabDB.addStudyLog({
      type,
      wordCount: total,
      correctCount: correct,
      duration: Date.now() - (state[type === 'flashcard' ? 'fcStartTime' : type === 'spelling' ? 'spStartTime' : 'mtStartTime'] || Date.now())
    });

    // 結果表示
    let icon = '🎉';
    let title = 'お疲れ様！';
    let subtitle = '';

    if (rate >= 90) {
      icon = '🏆';
      title = '素晴らしい！';
      subtitle = '完璧に近いスコアです！';
    } else if (rate >= 70) {
      icon = '👏';
      title = 'よくできました！';
      subtitle = 'もう少しで完璧です！';
    } else if (rate >= 50) {
      icon = '💪';
      title = 'がんばりました！';
      subtitle = '繰り返し練習しましょう！';
    } else {
      icon = '📖';
      title = 'もう少し練習しよう！';
      subtitle = '間違えた単語を復習しましょう。';
    }

    document.getElementById('results-icon').textContent = icon;
    document.getElementById('results-title').textContent = title;
    document.getElementById('results-subtitle').textContent = subtitle;
    document.getElementById('result-total').textContent = total;
    document.getElementById('result-correct').textContent = correct;
    document.getElementById('result-incorrect').textContent = incorrect;

    navigate('results');
  }

  // ===================================================
  // 単語一覧
  // ===================================================
  async function refreshWordlist() {
    // タグドロップダウンを更新
    await updateTagFilter();

    const query = document.getElementById('search-input').value.trim();
    let words = query ? await VocabDB.searchWords(query) : await VocabDB.getAllWords();

    // タグフィルター適用
    if (state.wordlistTagFilter && state.wordlistTagFilter !== '__all__') {
      words = words.filter(w =>
        w.tags && w.tags.some(t => t === state.wordlistTagFilter)
      );
    }

    // レベルフィルター適用
    switch (state.wordlistFilter) {
      case 'new':
        words = words.filter(w => SRS.getLevel(w) === 'new');
        break;
      case 'learning':
        words = words.filter(w => SRS.getLevel(w) === 'learning');
        break;
      case 'reviewing':
        words = words.filter(w => SRS.getLevel(w) === 'reviewing');
        break;
      case 'mastered':
        words = words.filter(w => SRS.getLevel(w) === 'mastered');
        break;
      case 'bookmarked':
        words = words.filter(w => w.bookmarked);
        break;
    }

    words.sort((a, b) => b.createdAt - a.createdAt);

    const container = document.getElementById('wordlist-items');
    const emptyEl = document.getElementById('empty-wordlist');

    if (words.length === 0) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      container.innerHTML = words.map(w => wordCardHTML(w)).join('');
    }
  }

  async function updateTagFilter() {
    const tags = await VocabDB.getAllTags();
    const bar = document.getElementById('tag-filter-bar');
    const select = document.getElementById('tag-filter-select');

    if (tags.length === 0) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'block';
    const currentValue = state.wordlistTagFilter;

    select.innerHTML = '<option value="__all__">📚 すべての教科書</option>' +
      tags.map(t => `<option value="${esc(t)}" ${t === currentValue ? 'selected' : ''}>🏷️ ${esc(t)}</option>`).join('');
  }

  // ===================================================
  // 単語詳細
  // ===================================================
  async function showWordDetail(wordId) {
    const word = await VocabDB.getWord(wordId);
    if (!word) {
      showToast('単語が見つかりません');
      return;
    }

    state.currentWordId = wordId;

    document.getElementById('detail-word').textContent = word.wordDisplay || word.word;
    document.getElementById('detail-phonetic').textContent = word.phonetic ? `[${word.phonetic}]` : '';
    document.getElementById('detail-pos').textContent = word.pos || '';

    document.getElementById('detail-meaning').textContent = word.meaning;

    // 例文
    const exSection = document.getElementById('detail-examples-section');
    const exEl = document.getElementById('detail-examples');
    if (word.examples && word.examples.length > 0) {
      exSection.classList.remove('hidden');
      exEl.innerHTML = word.examples.map(ex => `
        <div class="example-item">
          <div class="example-en">${esc(ex.en)}</div>
          ${ex.ja ? `<div class="example-ja">${esc(ex.ja)}</div>` : ''}
        </div>
      `).join('');
    } else {
      exSection.classList.add('hidden');
    }

    // 類義語
    const synSection = document.getElementById('detail-synonyms-section');
    const synEl = document.getElementById('detail-synonyms');
    if (word.synonyms && word.synonyms.length > 0) {
      synSection.classList.remove('hidden');
      synEl.innerHTML = word.synonyms.map(s => `<span class="detail-tag">${esc(s)}</span>`).join('');
    } else {
      synSection.classList.add('hidden');
    }

    // タグ（教科書）
    const tagSection = document.getElementById('detail-tags-section');
    const tagEl = document.getElementById('detail-tags');
    if (word.tags && word.tags.length > 0) {
      tagSection.classList.remove('hidden');
      tagEl.innerHTML = word.tags.map(t => `<span class="detail-tag" style="background:var(--primary);color:#fff;">🏷️ ${esc(t)}</span>`).join('');
    } else {
      tagSection.classList.remove('hidden');
      tagEl.innerHTML = '<span style="color:var(--text-secondary); font-size:13px;">タグなし</span>';
    }

    // SRSデータ
    const srsEl = document.getElementById('detail-srs');
    const srs = word.srs || SRS.initialData();
    const level = SRS.getLevelLabel(word);
    const totalCorrect = (word.stats.flashcardCorrect || 0) + (word.stats.spellingCorrect || 0);
    const totalIncorrect = (word.stats.flashcardIncorrect || 0) + (word.stats.spellingIncorrect || 0);

    srsEl.innerHTML = `
      <div class="detail-srs-item">
        <div class="srs-value" style="color:${SRS.getLevelColor(word)}">${level}</div>
        <div class="srs-label">レベル</div>
      </div>
      <div class="detail-srs-item">
        <div class="srs-value">${srs.repetitions}</div>
        <div class="srs-label">連続正解</div>
      </div>
      <div class="detail-srs-item">
        <div class="srs-value text-success">${totalCorrect}</div>
        <div class="srs-label">正解数</div>
      </div>
      <div class="detail-srs-item">
        <div class="srs-value text-danger">${totalIncorrect}</div>
        <div class="srs-label">不正解数</div>
      </div>
    `;

    navigate('word-detail');
  }

  async function deleteWord() {
    if (!state.currentWordId) return;

    showModal('この単語を削除しますか？', `
      <div style="display:flex; gap:12px; margin-top:16px;">
        <button class="btn btn-outline" style="flex:1" onclick="App.hideModal()">キャンセル</button>
        <button class="btn btn-danger" style="flex:1" id="btn-confirm-delete">削除</button>
      </div>
    `);

    document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
      await VocabDB.deleteWord(state.currentWordId);
      hideModal();
      showToast('単語を削除しました');
      state.currentWordId = null;
      goBack();
    });
  }

  async function toggleBookmark(wordId) {
    const word = await VocabDB.getWord(wordId);
    if (!word) return;

    word.bookmarked = !word.bookmarked;
    await VocabDB.updateWord(word);

    // UI更新
    const btn = document.querySelector(`[data-bookmark="${wordId}"]`);
    if (btn) {
      btn.classList.toggle('active');
      btn.textContent = word.bookmarked ? '⭐' : '☆';
    }
  }

  // ===================================================
  // 設定
  // ===================================================
  async function toggleDarkMode() {
    state.darkMode = !state.darkMode;
    document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : '');
    document.getElementById('toggle-darkmode').classList.toggle('active', state.darkMode);
    await VocabDB.setSetting('darkMode', state.darkMode);
  }

  async function toggleAutoSpeak() {
    state.autoSpeak = !state.autoSpeak;
    document.getElementById('toggle-auto-speak').classList.toggle('active', state.autoSpeak);
    await VocabDB.setSetting('autoSpeak', state.autoSpeak);
  }

  async function exportData(filterTags = null) {
    try {
      const json = await VocabDB.exportData(filterTags);
      const data = JSON.parse(json);
      const tagSuffix = filterTags ? `-${filterTags.join('_')}` : '-all';
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocabsnap${tagSuffix}-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`${data.words.length}語をエクスポートしました`);
    } catch (e) {
      showToast('エクスポートに失敗しました');
      console.error(e);
    }
  }

  /**
   * タグ選択ダイアログを表示してからアクションを実行
   */
  async function showTagPicker(actionName, callback) {
    const tags = await VocabDB.getAllTags();
    const totalCount = await VocabDB.getWordCount();

    let tagHTML = '';
    if (tags.length > 0) {
      tagHTML = `
        <div style="margin-bottom:12px;">
          <label style="display:flex; align-items:center; gap:8px; padding:8px 0; cursor:pointer;">
            <input type="radio" name="tag-filter" value="__all__" checked>
            <span>すべての単語 (${totalCount}語)</span>
          </label>
          ${tags.map(tag => `
            <label style="display:flex; align-items:center; gap:8px; padding:8px 0; cursor:pointer;">
              <input type="radio" name="tag-filter" value="${esc(tag)}">
              <span>🏷️ ${esc(tag)}</span>
            </label>
          `).join('')}
        </div>
      `;
    }

    showModal(actionName, `
      ${tagHTML}
      <button class="btn btn-primary btn-block" id="btn-tag-action">${actionName}</button>
    `);

    document.getElementById('btn-tag-action').addEventListener('click', () => {
      let selectedTags = null;
      if (tags.length > 0) {
        const checked = document.querySelector('input[name="tag-filter"]:checked');
        if (checked && checked.value !== '__all__') {
          selectedTags = [checked.value];
        }
      }
      hideModal();
      callback(selectedTags);
    });
  }

  /**
   * Web Share API でデータを共有（LINE, AirDrop, メール等）
   */
  async function shareData() {
    showTagPicker('共有する', async (filterTags) => {
      try {
        const json = await VocabDB.exportData(filterTags);
        const data = JSON.parse(json);
        const wordCount = data.words.length;

        if (wordCount === 0) {
          showToast('共有する単語がありません');
          return;
        }

        // 方法1: ファイル共有を試す
        if (navigator.share) {
          try {
            const filename = `vocabsnap-${new Date().toISOString().split('T')[0]}.json`;
            const file = new File([json], filename, { type: 'application/json' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
              await navigator.share({
                files: [file]
              });
              showToast('共有しました');
              return;
            }
          } catch (fileErr) {
            console.log('ファイル共有失敗、テキスト共有にフォールバック:', fileErr.name);
            if (fileErr.name === 'AbortError') return;
          }

          // 方法2: テキスト共有
          try {
            const text = await VocabDB.exportAsText(filterTags);
            await navigator.share({
              title: `VocabSnap (${wordCount}語)`,
              text: text
            });
            showToast('共有しました');
            return;
          } catch (textErr) {
            console.log('テキスト共有失敗:', textErr.name);
            if (textErr.name === 'AbortError') return;
          }
        }

        // 方法3: クリップボードにコピー
        try {
          const text = await VocabDB.exportAsText(filterTags);
          await navigator.clipboard.writeText(text);
          showToast(`${wordCount}語をクリップボードにコピーしました`);
        } catch (clipErr) {
          // 方法4: 最終手段 - ファイルダウンロード
          exportData(filterTags);
        }
      } catch (e) {
        showToast('共有に失敗しました');
        console.error(e);
      }
    });
  }

  /**
   * テキスト形式でクリップボードにコピー
   */
  async function copyAsText() {
    showTagPicker('コピーする', async (filterTags) => {
      try {
        const text = await VocabDB.exportAsText(filterTags);
        if (!text) {
          showToast('コピーする単語がありません');
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          showToast('クリップボードにコピーしました');
        } catch (e) {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
          showToast('クリップボードにコピーしました');
        }
      } catch (e) {
        showToast('コピーに失敗しました');
        console.error(e);
      }
    });
  }

  /**
   * 共有リンクを作成（URLにデータを埋め込み）
   */
  async function createShareLink() {
    showTagPicker('リンクを作成', async (filterTags) => {
      try {
        const json = await VocabDB.exportData(filterTags);
        const data = JSON.parse(json);
        const words = data.words;

        if (words.length === 0) {
          showToast('共有する単語がありません');
          return;
        }

        // 単語データを圧縮形式に変換
        const compact = words.map(w => {
          let s = w.word + ':' + w.meaning;
          if (w.phonetic) s += '|' + w.phonetic;
          if (w.pos) s += '|' + w.pos;
          return s;
        });

        const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(compact)))));
        const baseUrl = location.origin + location.pathname;
        const shareUrl = baseUrl + '?import=' + encoded;

        // URLが長すぎる場合の警告
        if (shareUrl.length > 8000) {
          showModal('データが大きすぎます', `
            <p style="margin-bottom:16px; color:var(--text-secondary);">
              ${words.length}語のデータはリンク共有には大きすぎます。<br>
              ファイル共有またはテキストコピーをお使いください。
            </p>
            <button class="btn btn-primary btn-block" onclick="App.hideModal()">OK</button>
          `);
          return;
        }

        // クリップボードにコピー
        await navigator.clipboard.writeText(shareUrl);
        showToast(`${words.length}語の共有リンクをコピーしました`);
      } catch (e) {
        showToast('リンク作成に失敗しました');
        console.error(e);
      }
    });
  }

  /**
   * URLパラメータからインポート（共有リンク受信時）
   */
  async function checkUrlImport() {
    const params = new URLSearchParams(location.search);
    const importParam = params.get('import');
    if (!importParam) return;

    try {
      const decoded = decodeURIComponent(escape(atob(decodeURIComponent(importParam))));
      const compact = JSON.parse(decoded);

      if (!Array.isArray(compact) || compact.length === 0) return;

      const words = compact.map(s => {
        const parts = s.split('|');
        const [word, meaning] = parts[0].split(':');
        return {
          word: word || '',
          meaning: meaning || '',
          phonetic: parts[1] || '',
          pos: parts[2] || ''
        };
      }).filter(w => w.word && w.meaning);

      // URLパラメータをクリア
      history.replaceState(null, '', location.pathname);

      // インポート確認ダイアログ
      showModal('単語データを受信', `
        <p style="margin-bottom:16px; color:var(--text-secondary);">
          ${words.length}個の単語データを受信しました。<br>
          どのように取り込みますか？
        </p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <button class="btn btn-primary btn-block" id="btn-import-merge-url">追加する（既存データを保持）</button>
          <button class="btn btn-outline btn-block" id="btn-import-replace-url">置き換える（既存データを削除）</button>
          <button class="btn btn-outline btn-block" onclick="App.hideModal()">キャンセル</button>
        </div>
      `);

      const json = JSON.stringify({ version: 1, words });

      document.getElementById('btn-import-merge-url').addEventListener('click', async () => {
        const count = await VocabDB.importData(json, true);
        hideModal();
        showToast(`${count}個の単語を追加しました`);
        await refreshHome();
      });

      document.getElementById('btn-import-replace-url').addEventListener('click', async () => {
        const count = await VocabDB.importData(json, false);
        hideModal();
        showToast(`${count}個の単語をインポートしました`);
        await refreshHome();
      });
    } catch (e) {
      console.error('URLインポートエラー:', e);
    }
  }

  async function importData(file) {
    if (!file) return;
    try {
      const text = await file.text();

      // マージ or 置換 選択ダイアログ
      showModal('インポート方法', `
        <p style="margin-bottom:16px; color:var(--text-secondary);">
          既存のデータをどうしますか？
        </p>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <button class="btn btn-primary btn-block" id="btn-import-merge">追加する（既存データを保持）</button>
          <button class="btn btn-outline btn-block" id="btn-import-replace">置き換える（既存データを削除）</button>
          <button class="btn btn-outline btn-block" onclick="App.hideModal()">キャンセル</button>
        </div>
      `);

      document.getElementById('btn-import-merge').addEventListener('click', async () => {
        try {
          const count = await VocabDB.importData(text, true);
          hideModal();
          showToast(`${count}個の単語を追加しました`);
          await refreshHome();
        } catch (e) { showToast(e.message); hideModal(); }
      });

      document.getElementById('btn-import-replace').addEventListener('click', async () => {
        try {
          const count = await VocabDB.importData(text, false);
          hideModal();
          showToast(`${count}個の単語をインポートしました`);
          await refreshHome();
        } catch (e) { showToast(e.message); hideModal(); }
      });
    } catch (e) {
      showToast(e.message);
    }
  }

  /**
   * テキスト貼り付けからインポート
   */
  function importFromTextModal() {
    showModal('テキストから取り込み', `
      <p style="margin-bottom:8px; color:var(--text-secondary); font-size:13px;">
        1行1単語の形式で貼り付けてください：<br>
        <code style="font-size:12px; background:var(--bg-secondary); padding:2px 4px; border-radius:4px;">word : 意味</code><br>
        <code style="font-size:12px; background:var(--bg-secondary); padding:2px 4px; border-radius:4px;">word [発音] (品詞) : 意味</code>
      </p>
      <div class="input-group">
        <textarea class="input-field" id="import-text-area" rows="8" placeholder="apple : りんご&#10;decide : 決める&#10;important [impɔ́ːrtənt] (形) : 重要な"></textarea>
      </div>
      <button class="btn btn-primary btn-block" id="btn-import-text-go">取り込む</button>
    `);

    document.getElementById('btn-import-text-go').addEventListener('click', async () => {
      const text = document.getElementById('import-text-area').value.trim();
      if (!text) { showToast('テキストを入力してください'); return; }
      try {
        const count = await VocabDB.importFromText(text, true);
        hideModal();
        showToast(`${count}個の単語を追加しました`);
        await refreshHome();
      } catch (e) {
        showToast(e.message);
      }
    });
  }

  async function clearAllData() {
    showModal('全データ削除', `
      <p style="margin-bottom:16px; color:var(--text-secondary);">
        すべての単語と学習データが削除されます。この操作は取り消せません。
      </p>
      <div style="display:flex; gap:12px;">
        <button class="btn btn-outline" style="flex:1" onclick="App.hideModal()">キャンセル</button>
        <button class="btn btn-danger" style="flex:1" id="btn-confirm-clear">削除する</button>
      </div>
    `);

    document.getElementById('btn-confirm-clear').addEventListener('click', async () => {
      await VocabDB.clearAllWords();
      hideModal();
      showToast('全データを削除しました');
      await refreshHome();
    });
  }

  // ===================================================
  // 音声読み上げ【UX視点】
  // ===================================================
  let cachedVoice = null;

  function getEnglishVoice() {
    if (cachedVoice) return cachedVoice;

    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    // 優先順位: Google > Microsoft > その他の英語音声
    const priorities = [
      v => v.lang.startsWith('en') && v.name.includes('Google'),
      v => v.lang.startsWith('en') && v.name.includes('Microsoft'),
      v => v.lang.startsWith('en') && v.name.toLowerCase().includes('natural'),
      v => v.lang.startsWith('en') && v.name.toLowerCase().includes('premium'),
      v => v.lang === 'en-US',
      v => v.lang === 'en-GB',
      v => v.lang.startsWith('en')
    ];

    for (const check of priorities) {
      const found = voices.find(check);
      if (found) {
        cachedVoice = found;
        console.log('[TTS] 使用音声:', found.name, found.lang);
        return found;
      }
    }
    return null;
  }

  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;

    const voice = getEnglishVoice();
    if (voice) {
      utterance.voice = voice;
    }

    speechSynthesis.speak(utterance);
  }

  // 音声リスト読み込み時にキャッシュ更新
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => {
      cachedVoice = null;
      getEnglishVoice();
    };
  }

  // ===================================================
  // UI ヘルパー
  // ===================================================
  function showToast(message, duration = 2500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), duration);
  }

  function showModal(title, bodyHTML) {
    document.getElementById('modal-body').innerHTML = `
      <div class="modal-title">${esc(title)}</div>
      ${bodyHTML}
    `;
    document.getElementById('modal-overlay').classList.add('visible');
  }

  function hideModal() {
    document.getElementById('modal-overlay').classList.remove('visible');
  }

  function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ===================================================
  // イベントリスナー【開発者視点: イベント委譲で効率化】
  // ===================================================
  function setupEventListeners() {
    // --- ナビゲーション ---
    document.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.nav));
    });

    document.querySelectorAll('[data-navigate]').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.navigate));
    });

    document.querySelectorAll('[data-back]').forEach(btn => {
      btn.addEventListener('click', goBack);
    });

    // --- テーマ切替 ---
    document.getElementById('btn-theme-toggle').addEventListener('click', toggleDarkMode);

    // --- 撮影 ---
    document.getElementById('btn-camera').addEventListener('click', () => {
      document.getElementById('input-camera').click();
    });
    document.getElementById('btn-gallery').addEventListener('click', () => {
      document.getElementById('input-gallery').click();
    });
    document.getElementById('input-camera').addEventListener('change', (e) => {
      handleImageSelected(e.target.files[0]);
    });
    document.getElementById('input-gallery').addEventListener('change', (e) => {
      handleImageSelected(e.target.files[0]);
    });
    document.getElementById('btn-ocr-start').addEventListener('click', startOCR);

    // --- 回転ボタン ---
    const btnRotateLeft = document.getElementById('btn-rotate-left');
    const btnRotateRight = document.getElementById('btn-rotate-right');
    if (btnRotateLeft) btnRotateLeft.addEventListener('click', () => rotateImage(-90));
    if (btnRotateRight) btnRotateRight.addEventListener('click', () => rotateImage(90));

    // --- OCR解析結果 ---
    document.getElementById('btn-save-parsed').addEventListener('click', saveParsedWords);

    // --- RAWテキスト表示・再解析 ---
    const btnShowRaw = document.getElementById('btn-show-raw');
    const btnShowRawEmpty = document.getElementById('btn-show-raw-empty');
    const btnReparse = document.getElementById('btn-reparse');
    if (btnShowRaw) btnShowRaw.addEventListener('click', toggleRawTextSection);
    if (btnShowRawEmpty) btnShowRawEmpty.addEventListener('click', toggleRawTextSection);
    if (btnReparse) btnReparse.addEventListener('click', reparseRawText);
    document.getElementById('parsed-words-list').addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-delete-parsed]');
      if (delBtn) {
        const idx = parseInt(delBtn.dataset.deleteParsed);
        state.parsedWords.splice(idx, 1);
        showParsedWords();
      }
    });

    // --- 手動入力 ---
    document.getElementById('form-manual-add').addEventListener('submit', handleManualAdd);

    // --- 学習モード ---
    document.querySelectorAll('[data-study]').forEach(card => {
      card.addEventListener('click', () => startStudyMode(card.dataset.study));
    });

    // --- 学習フィルター ---
    document.querySelectorAll('[data-filter]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.studyFilter = chip.dataset.filter;
        refreshStudy();
      });
    });

    // --- 学習タグフィルター ---
    document.getElementById('study-tag-filter-select').addEventListener('change', (e) => {
      state.studyTagFilter = e.target.value;
      refreshStudy();
    });

    // --- セッション単語数制限 ---
    document.querySelectorAll('[data-session-limit]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-session-limit]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.sessionLimit = parseInt(chip.dataset.sessionLimit);
        const infoEl = document.getElementById('session-limit-info');
        if (state.sessionLimit > 0) {
          infoEl.textContent = `1回の学習で最大${state.sessionLimit}単語まで出題します`;
        } else {
          infoEl.textContent = 'すべての単語を学習します';
        }
        refreshStudy();
      });
    });

    // --- フラッシュカード ---
    document.getElementById('flashcard').addEventListener('click', (e) => {
      if (e.target.closest('.fc-btn-speak')) return;
      flipFlashcard();
    });
    document.getElementById('btn-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      const word = state.studyWords[state.fcIndex];
      if (word) speak(word.word);
    });
    document.getElementById('btn-fc-right').addEventListener('click', () => answerFlashcard(true));
    document.getElementById('btn-fc-wrong').addEventListener('click', () => answerFlashcard(false));

    // フラッシュカード スワイプ
    setupSwipeGestures();

    // --- 文章読解 ---
    document.getElementById('reading-card').addEventListener('click', (e) => {
      if (e.target.closest('.fc-btn-speak')) return;
      flipReadingCard();
    });
    document.getElementById('btn-rd-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      const word = state.studyWords[state.rdIndex];
      if (word && word.examples && word.examples[0]) {
        speak(word.examples[0].en);
      }
    });
    document.getElementById('btn-rd-right').addEventListener('click', () => answerReading(true));
    document.getElementById('btn-rd-wrong').addEventListener('click', () => answerReading(false));

    // 文章読解 スワイプ
    setupReadingSwipeGestures();

    // --- スペル入力 ---
    document.getElementById('btn-sp-submit').addEventListener('click', checkSpelling);
    document.getElementById('btn-sp-hint').addEventListener('click', showSpellingHint);
    document.getElementById('btn-sp-next').addEventListener('click', nextSpelling);
    document.getElementById('sp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (state.spAnswered) {
          nextSpelling();
        } else {
          checkSpelling();
        }
      }
    });

    // --- マッチング ---
    document.getElementById('matching-grid').addEventListener('click', (e) => {
      const tile = e.target.closest('.matching-tile');
      if (tile) handleMatchingTileClick(tile);
    });

    // --- 結果画面 ---
    document.getElementById('btn-retry-study').addEventListener('click', () => {
      if (state.lastStudyMode) {
        startStudyMode(state.lastStudyMode);
      }
    });

    // --- 単語一覧 ---
    let searchTimeout;
    document.getElementById('search-input').addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(refreshWordlist, 300);
    });

    document.querySelectorAll('[data-wfilter]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('[data-wfilter]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.wordlistFilter = chip.dataset.wfilter;
        refreshWordlist();
      });
    });

    // タグフィルター（教科書選択）
    document.getElementById('tag-filter-select').addEventListener('change', (e) => {
      state.wordlistTagFilter = e.target.value;
      refreshWordlist();
    });

    // 単語カードクリック（イベント委譲）
    document.addEventListener('click', (e) => {
      const wordCard = e.target.closest('.word-card');
      const bookmarkBtn = e.target.closest('[data-bookmark]');

      if (bookmarkBtn) {
        e.stopPropagation();
        toggleBookmark(bookmarkBtn.dataset.bookmark);
        return;
      }

      if (wordCard && wordCard.dataset.wordId) {
        showWordDetail(wordCard.dataset.wordId);
      }
    });

    // --- 単語詳細 ---
    document.getElementById('btn-detail-speak').addEventListener('click', () => {
      const wordEl = document.getElementById('detail-word');
      if (wordEl.textContent) speak(wordEl.textContent);
    });
    document.getElementById('btn-delete-word').addEventListener('click', deleteWord);
    document.getElementById('btn-edit-word').addEventListener('click', () => {
      if (state.currentWordId) editWordModal(state.currentWordId);
    });
    document.getElementById('btn-edit-tags').addEventListener('click', () => {
      if (state.currentWordId) editTagsQuick(state.currentWordId);
    });

    // --- 設定 ---
    document.getElementById('setting-darkmode').addEventListener('click', toggleDarkMode);
    document.getElementById('setting-auto-speak').addEventListener('click', toggleAutoSpeak);
    document.getElementById('setting-export').addEventListener('click', () => {
      showTagPicker('JSONに保存', (filterTags) => exportData(filterTags));
    });
    document.getElementById('setting-share').addEventListener('click', shareData);
    document.getElementById('setting-copy-text').addEventListener('click', copyAsText);
    document.getElementById('setting-share-link').addEventListener('click', createShareLink);
    document.getElementById('setting-import').addEventListener('click', () => {
      document.getElementById('input-import').click();
    });
    document.getElementById('input-import').addEventListener('change', (e) => {
      importData(e.target.files[0]);
    });
    document.getElementById('setting-import-text').addEventListener('click', importFromTextModal);
    document.getElementById('setting-clear-data').addEventListener('click', clearAllData);
    document.getElementById('setting-daily-goal').addEventListener('click', changeDailyGoal);

    // --- モーダル ---
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-overlay')) hideModal();
    });

    // --- ソート ---
    document.getElementById('btn-sort-words').addEventListener('click', showSortModal);

    // --- 翻訳 ---
    // Screen Capture APIが使えるならセクション表示
    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
      document.getElementById('screen-capture-section').style.display = 'block';
    }
    document.getElementById('btn-start-capture').addEventListener('click', startScreenCapture);
    document.getElementById('btn-stop-capture').addEventListener('click', stopScreenCapture);
    document.getElementById('btn-manual-capture').addEventListener('click', manualCapture);
    document.getElementById('btn-translate-text').addEventListener('click', translateCurrentText);
    document.getElementById('btn-copy-ocr-text').addEventListener('click', () => {
      const text = document.getElementById('translate-ocr-text').innerText;
      if (text) { navigator.clipboard.writeText(text).then(() => showToast('コピーしました')); }
    });
    document.getElementById('btn-copy-translation').addEventListener('click', () => {
      const text = document.getElementById('translation-output').innerText;
      if (text) { navigator.clipboard.writeText(text).then(() => showToast('コピーしました')); }
    });
    document.getElementById('btn-add-from-translate').addEventListener('click', addWordsFromTranslation);
    document.getElementById('capture-interval').addEventListener('change', (e) => {
      state.captureInterval = parseInt(e.target.value);
      if (state.isCapturing && state.captureTimer) {
        clearInterval(state.captureTimer);
        if (state.captureInterval > 0) {
          state.captureTimer = setInterval(captureAndOCR, state.captureInterval);
        }
      }
    });

    // スクショ画像選択
    document.getElementById('translate-image-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) processTranslateImage(file);
      e.target.value = '';
    });

    // 画像貼り付け
    document.getElementById('btn-paste-image').addEventListener('click', pasteImageFromClipboard);

    // 翻訳画面全体でのペーストイベント (Ctrl+V)
    document.getElementById('screen-translate').addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) processTranslateImage(blob);
          return;
        }
      }
    });

    // オーバーレイ切替
    document.getElementById('btn-toggle-overlay').addEventListener('click', () => {
      const snapshot = document.getElementById('capture-snapshot');
      const btn = document.getElementById('btn-toggle-overlay');
      state.showOverlay = !state.showOverlay;
      if (state.showOverlay && state.translateOverlaySrc) {
        snapshot.src = state.translateOverlaySrc;
        btn.textContent = '🌐 翻訳表示 ON';
      } else if (state.translateOriginalSrc) {
        snapshot.src = state.translateOriginalSrc;
        btn.textContent = '🌐 翻訳表示 OFF';
      }
    });

    // オーバーレイ画像を保存/共有
    const dlBtn = document.getElementById('btn-download-overlay');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        const blob = state.translateOverlayBlob;
        if (!blob) {
          showToast('オーバーレイ画像がありません');
          return;
        }

        const file = new File([blob], 'vocabsnap-translation.png', { type: 'image/png' });

        // Web Share API対応ならシェア
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'VocabSnap 翻訳',
            });
            return;
          } catch (e) {
            if (e.name === 'AbortError') return;
          }
        }

        // フォールバック: ダウンロード
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'vocabsnap-translation.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('画像を保存しました');
      });
    }
  }

  // ===================================================
  // スワイプジェスチャー【UX視点】
  // ===================================================
  function setupSwipeGestures() {
    const card = document.getElementById('flashcard');
    let startX = 0;
    let isDragging = false;

    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      isDragging = true;
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const diff = e.touches[0].clientX - startX;
      if (diff > 40) {
        card.classList.add('swiping-right');
        card.classList.remove('swiping-left');
      } else if (diff < -40) {
        card.classList.add('swiping-left');
        card.classList.remove('swiping-right');
      } else {
        card.classList.remove('swiping-right', 'swiping-left');
      }
    }, { passive: true });

    card.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      isDragging = false;
      const endX = e.changedTouches[0].clientX;
      const diff = endX - startX;

      if (Math.abs(diff) > 80) {
        if (diff > 0) answerFlashcard(true);
        else answerFlashcard(false);
      } else {
        card.classList.remove('swiping-right', 'swiping-left');
      }
    }, { passive: true });
  }

  // ===================================================
  // 文章読解スワイプジェスチャー
  // ===================================================
  function setupReadingSwipeGestures() {
    const card = document.getElementById('reading-card');
    let startX = 0;
    let isDragging = false;

    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      isDragging = true;
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const diff = e.touches[0].clientX - startX;
      if (diff > 40) {
        card.classList.add('swiping-right');
        card.classList.remove('swiping-left');
      } else if (diff < -40) {
        card.classList.add('swiping-left');
        card.classList.remove('swiping-right');
      } else {
        card.classList.remove('swiping-right', 'swiping-left');
      }
    }, { passive: true });

    card.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      isDragging = false;
      const endX = e.changedTouches[0].clientX;
      const diff = endX - startX;

      if (Math.abs(diff) > 80) {
        if (diff > 0) answerReading(true);
        else answerReading(false);
      } else {
        card.classList.remove('swiping-right', 'swiping-left');
      }
    }, { passive: true });
  }

  // ===================================================
  // 追加モーダル
  // ===================================================
  async function editWordModal(wordId) {
    const word = await VocabDB.getWord(wordId);
    if (!word) return;

    const existingTags = await VocabDB.getAllTags();
    const tagSuggestions = existingTags.length > 0
      ? `<div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px;">
          ${existingTags.map(t => `<span class="tag-suggestion" style="font-size:12px; padding:2px 8px; background:var(--bg-secondary); border-radius:12px; cursor:pointer;" data-suggest-tag="${esc(t)}">🏷️ ${esc(t)}</span>`).join('')}
        </div>`
      : '';

    showModal('単語を編集', `
      <div class="input-group">
        <label>英単語</label>
        <input type="text" class="input-field" id="edit-word" value="${esc(word.wordDisplay || word.word)}">
      </div>
      <div class="input-group">
        <label>意味</label>
        <input type="text" class="input-field" id="edit-meaning" value="${esc(word.meaning)}">
      </div>
      <div class="input-group">
        <label>発音記号</label>
        <input type="text" class="input-field" id="edit-phonetic" value="${esc(word.phonetic)}">
      </div>
      <div class="input-group">
        <label>品詞</label>
        <input type="text" class="input-field" id="edit-pos" value="${esc(word.pos)}">
      </div>
      <div class="input-group">
        <label>類義語 (カンマ区切り)</label>
        <input type="text" class="input-field" id="edit-synonyms" value="${esc(word.synonyms ? word.synonyms.join(', ') : '')}">
      </div>
      <div class="input-group">
        <label>🏷️ 教科書・タグ (カンマ区切り)</label>
        <input type="text" class="input-field" id="edit-tags" value="${esc(word.tags ? word.tags.join(', ') : '')}" placeholder="例: シス単, Chapter1">
        ${tagSuggestions}
      </div>
      <div class="input-group">
        <label>メモ</label>
        <textarea class="input-field" id="edit-memo">${esc(word.memo)}</textarea>
      </div>
      <button class="btn btn-primary btn-block mt-16" id="btn-save-edit">保存</button>
    `);

    // タグ候補クリックで入力欄に追加
    document.querySelectorAll('[data-suggest-tag]').forEach(el => {
      el.addEventListener('click', () => {
        const tagInput = document.getElementById('edit-tags');
        const currentTags = tagInput.value.split(/[,、]/).map(s => s.trim()).filter(s => s);
        const newTag = el.dataset.suggestTag;
        if (!currentTags.includes(newTag)) {
          currentTags.push(newTag);
          tagInput.value = currentTags.join(', ');
        }
        el.style.background = 'var(--primary)';
        el.style.color = '#fff';
      });
    });

    document.getElementById('btn-save-edit').addEventListener('click', async () => {
      word.wordDisplay = document.getElementById('edit-word').value.trim();
      word.word = word.wordDisplay.toLowerCase();
      word.meaning = document.getElementById('edit-meaning').value.trim();
      word.phonetic = document.getElementById('edit-phonetic').value.trim();
      word.pos = document.getElementById('edit-pos').value.trim();
      word.memo = document.getElementById('edit-memo').value.trim();
      const synText = document.getElementById('edit-synonyms').value.trim();
      word.synonyms = synText ? synText.split(/[,、]/).map(s => s.trim()).filter(s => s) : [];
      const tagText = document.getElementById('edit-tags').value.trim();
      word.tags = tagText ? tagText.split(/[,、]/).map(s => s.trim()).filter(s => s) : [];

      await VocabDB.updateWord(word);
      hideModal();
      showToast('更新しました');
      showWordDetail(wordId);
    });
  }

  /**
   * タグのみ素早く編集するモーダル
   */
  async function editTagsQuick(wordId) {
    const word = await VocabDB.getWord(wordId);
    if (!word) return;

    const existingTags = await VocabDB.getAllTags();
    const wordTags = new Set(word.tags || []);

    let checkboxHTML = '';
    if (existingTags.length > 0) {
      checkboxHTML = `<div style="margin-bottom:12px;">
        ${existingTags.map(t => `
          <label style="display:flex; align-items:center; gap:8px; padding:8px 0; cursor:pointer; border-bottom:1px solid var(--border);">
            <input type="checkbox" class="tag-check" value="${esc(t)}" ${wordTags.has(t) ? 'checked' : ''}>
            <span>🏷️ ${esc(t)}</span>
          </label>
        `).join('')}
      </div>`;
    }

    showModal('タグを編集', `
      ${checkboxHTML}
      <div class="input-group">
        <label>新しいタグを追加 (カンマ区切り)</label>
        <input type="text" class="input-field" id="new-tags-input" placeholder="例: シス単, Chapter3">
      </div>
      <button class="btn btn-primary btn-block" id="btn-save-tags">保存</button>
    `);

    document.getElementById('btn-save-tags').addEventListener('click', async () => {
      const selectedTags = [];
      document.querySelectorAll('.tag-check:checked').forEach(el => {
        selectedTags.push(el.value);
      });
      const newTagsText = document.getElementById('new-tags-input').value.trim();
      if (newTagsText) {
        newTagsText.split(/[,、]/).map(s => s.trim()).filter(s => s).forEach(t => {
          if (!selectedTags.includes(t)) selectedTags.push(t);
        });
      }

      word.tags = selectedTags;
      await VocabDB.updateWord(word);
      hideModal();
      showToast('タグを更新しました');
      showWordDetail(wordId);
    });
  }

  function changeDailyGoal() {
    showModal('1日の目標単語数', `
      <div class="input-group">
        <input type="number" class="input-field" id="input-daily-goal" value="${state.dailyGoal}" min="5" max="100" step="5">
      </div>
      <button class="btn btn-primary btn-block" id="btn-save-goal">保存</button>
    `);

    document.getElementById('btn-save-goal').addEventListener('click', async () => {
      const val = parseInt(document.getElementById('input-daily-goal').value);
      if (val >= 5 && val <= 100) {
        state.dailyGoal = val;
        await VocabDB.setSetting('dailyGoal', val);
        document.getElementById('daily-goal-value').textContent = val;
        hideModal();
        showToast('目標を更新しました');
      }
    });
  }

  // ===================================================
  // 翻訳機能 (テスト中)
  // ===================================================

  /**
   * スクリーンショット画像を処理してOCR → 翻訳 → オーバーレイ
   */
  async function processTranslateImage(fileOrBlob) {
    const snapshot = document.getElementById('capture-snapshot');
    const loadingEl = document.getElementById('translate-ocr-loading');
    const statusEl = document.getElementById('translate-ocr-status');
    const toggleBtn = document.getElementById('btn-toggle-overlay');

    // 画像をImageオブジェクトとして読み込み
    const originalUrl = URL.createObjectURL(fileOrBlob);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('画像の読み込みに失敗'));
      i.src = originalUrl;
    });

    // プレビュー表示
    state.translateOriginalSrc = originalUrl;
    snapshot.src = originalUrl;
    snapshot.style.display = 'block';
    document.getElementById('capture-preview-area').classList.remove('hidden');

    loadingEl.classList.remove('hidden');

    try {
      // === 2パスOCR: 元画像 + 反転画像 → 信頼度の高い方を採用 ===

      // パス1: 元画像を2倍拡大のみ（明るい文字がそのまま読めるケース）
      statusEl.textContent = 'OCR パス1: 元画像解析中...';
      const scaledCanvas = scaleImage(img, 2);
      const scaledBlob = await canvasToBlob(scaledCanvas);
      const result1 = await runOCR(scaledBlob);

      // パス2: 反転画像（白文字・暗背景 → 黒文字・白背景）
      statusEl.textContent = 'OCR パス2: 反転画像解析中...';
      const invertedCanvas = preprocessInvert(img, 2);
      const invertedBlob = await canvasToBlob(invertedCanvas);
      const result2 = await runOCR(invertedBlob);

      // 両方の結果を比較して信頼度の高い方を選ぶ
      const conf1 = result1.data.confidence || 0;
      const conf2 = result2.data.confidence || 0;
      console.log(`OCR Pass1 confidence: ${conf1}, Pass2 confidence: ${conf2}`);

      const bestData = conf1 >= conf2 ? result1.data : result2.data;
      const scale = 2;

      statusEl.textContent = 'テキストをフィルタリング中...';

      console.log(`OCR raw lines: ${(bestData.lines||[]).length}, raw blocks: ${(bestData.blocks||[]).length}, raw paragraphs: ${(bestData.paragraphs||[]).length}`);
      // デバッグ: 全行のテキストをログ
      (bestData.lines || []).forEach((l, idx) => {
        console.log(`  line[${idx}] conf=${Math.round(l.confidence)} text="${l.text.trim()}"`);
      });

      // 信頼度が低い行やノイズをフィルタリング
      const lines = (bestData.lines || []).filter(l => {
        const text = l.text.trim();
        if (text.length < 2) return false;
        if (l.confidence < 30) return false;
        // アルファベットか数字を含まない行を除外
        if (!/[a-zA-Z0-9]/.test(text)) return false;
        return true;
      });

      // bboxを元画像座標に変換
      const ocrLines = lines.map(l => ({
        text: l.text.trim(),
        confidence: l.confidence,
        bbox: {
          x0: Math.round(l.bbox.x0 / scale),
          y0: Math.round(l.bbox.y0 / scale),
          x1: Math.round(l.bbox.x1 / scale),
          y1: Math.round(l.bbox.y1 / scale)
        }
      }));

      state.lastOcrLines = ocrLines;

      const fullText = ocrLines.map(l => `[${Math.round(l.confidence)}%] ${l.text}`).join('\n');

      if (ocrLines.length === 0) {
        document.getElementById('translate-ocr-text').innerText = '';
        showToast('テキストを検出できませんでした');
        loadingEl.classList.add('hidden');
        return;
      }

      document.getElementById('translate-ocr-text').innerText =
        ocrLines.map(l => l.text).join('\n');

      // 翻訳
      statusEl.textContent = `翻訳中... (${ocrLines.length}ブロック)`;
      const translations = await translateLines(ocrLines.map(l => l.text));

      // テキスト翻訳結果も表示
      const outputEl = document.getElementById('translation-output');
      const outputLines = ocrLines.map((l, i) => {
        const tr = translations[i] || '';
        return `${l.text}\n→ ${tr}`;
      });
      outputEl.innerText = outputLines.join('\n\n');

      // オーバーレイ描画
      statusEl.textContent = 'オーバーレイを描画中...';
      try {
        const overlayBlob = await renderTranslationOverlay(img, ocrLines, translations);
        if (overlayBlob && overlayBlob.size > 0) {
          // 以前のblob URLを解放
          if (state.translateOverlaySrc && state.translateOverlaySrc.startsWith('blob:')) {
            URL.revokeObjectURL(state.translateOverlaySrc);
          }
          const overlayUrl = URL.createObjectURL(overlayBlob);
          state.translateOverlaySrc = overlayUrl;
          state.translateOverlayBlob = overlayBlob;

          // 画像の読込みを待ってからUI更新
          await new Promise((resolve, reject) => {
            snapshot.onload = resolve;
            snapshot.onerror = () => { console.error('Overlay img load failed'); reject(); };
            snapshot.src = overlayUrl;
          });

          toggleBtn.classList.remove('hidden');
          const dlEl = document.getElementById('btn-download-overlay');
          if (dlEl) dlEl.classList.remove('hidden');
          state.showOverlay = true;
          toggleBtn.textContent = '🌐 翻訳表示 ON';
          console.log('Overlay displayed, blob size:', overlayBlob.size);
        } else {
          console.warn('renderTranslationOverlay returned null or empty blob');
        }
      } catch (overlayErr) {
        console.error('Overlay render error:', overlayErr);
        showToast('オーバーレイ描画に失敗: ' + overlayErr.message);
      }

      showToast(`${ocrLines.length}ブロックのテキストを翻訳しました`);

    } catch (err) {
      console.error('Translation pipeline error:', err);
      showToast('OCR/翻訳エラー: ' + err.message);
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  /** Canvas → Blob のユーティリティ */
  function canvasToBlob(canvas) {
    return new Promise(r => canvas.toBlob(r, 'image/png'));
  }

  /** 画像をN倍に拡大するだけ (前処理なし) */
  function scaleImage(img, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = (img.naturalWidth || img.width) * scale;
    canvas.height = (img.naturalHeight || img.height) * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** 白文字ゲームUI向け: グレースケール＋反転＋やさしいコントラスト (二値化しない) */
  function preprocessInvert(img, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = (img.naturalWidth || img.width) * scale;
    canvas.height = (img.naturalHeight || img.height) * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;

    for (let i = 0; i < d.length; i += 4) {
      // グレースケール
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // 反転
      const inv = 255 - gray;
      // やさしいコントラスト (中央128を基準に1.5倍)
      const c = Math.min(255, Math.max(0, ((inv - 128) * 1.5) + 128));
      d[i] = d[i + 1] = d[i + 2] = Math.round(c);
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /** Tesseract OCR実行 */
  async function runOCR(blob) {
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '11'
    });
    const result = await worker.recognize(blob);
    await worker.terminate();
    return result;
  }

  /**
   * 複数行をバッチ翻訳 (MyMemory API)
   */
  async function translateLines(lines) {
    if (lines.length === 0) return [];

    // 短い行を " ||| " で結合して一括翻訳、500文字制限ごとにチャンク
    const separator = ' ||| ';
    const chunks = [];
    let currentChunk = [];
    let currentLen = 0;

    for (const line of lines) {
      const addLen = line.length + separator.length;
      if (currentLen + addLen > 450 && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [line];
        currentLen = line.length;
      } else {
        currentChunk.push(line);
        currentLen += addLen;
      }
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allTranslations = [];

    for (const chunk of chunks) {
      const joined = chunk.join(separator);
      try {
        const encodedText = encodeURIComponent(joined);
        const response = await fetch(
          `https://api.mymemory.translated.net/get?q=${encodedText}&langpair=en|ja`
        );
        if (!response.ok) throw new Error('API error: ' + response.status);
        const data = await response.json();
        console.log('MyMemory response:', JSON.stringify(data).substring(0, 500));

        if (data.responseStatus === 200 && data.responseData) {
          const translated = data.responseData.translatedText;

          // APIが元テキストをそのまま返した場合（翻訳失敗）
          if (translated === joined || translated.toLowerCase() === joined.toLowerCase()) {
            console.warn('API returned original text, trying individual lines');
            // 個別翻訳にフォールバック
            for (const line of chunk) {
              const tr = await translateSingleLine(line);
              allTranslations.push(tr);
            }
            continue;
          }

          const parts = translated.split(/\s*\|{3}\s*|\s*\uff5c{3}\s*/);
          for (let i = 0; i < chunk.length; i++) {
            const part = parts[i] ? parts[i].trim() : null;
            const norm = s => s.toLowerCase().replace(/[\s\-_.,!?;:'"]+/g, '');
            // 翻訳結果が元テキストと同じ、またはASCIIのみなら未翻訳
            if (!part || norm(part) === norm(chunk[i]) || /^[\x00-\x7F]+$/.test(part)) {
              const tr = await translateSingleLine(chunk[i]);
              allTranslations.push(tr);
            } else {
              allTranslations.push(part);
            }
          }
        } else {
          // 個別翻訳にフォールバック
          for (const line of chunk) {
            const tr = await translateSingleLine(line);
            allTranslations.push(tr);
          }
        }
      } catch (err) {
        console.error('Chunk translation error:', err);
        chunk.forEach(() => allTranslations.push('翻訳失敗'));
      }
    }

    return allTranslations;
  }

  /** 1行だけ個別翻訳 */
  async function translateSingleLine(text) {
    try {
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`
      );
      if (!res.ok) return '翻訳失敗';
      const data = await res.json();
      console.log('Single translate:', text, '->', JSON.stringify(data.responseData?.translatedText));
      if (data.responseStatus === 200 && data.responseData) {
        const t = data.responseData.translatedText;
        if (!t) return '(翻訳なし)';
        // 翻訳結果が英語のままかチェック（正規化比較）
        const norm = s => s.toLowerCase().replace(/[\s\-_.,!?;:'“”]+/g, '');
        if (norm(t) === norm(text)) return '(翻訳なし)';
        // 全きASCII文字のまま（日本語が一切含まれていない）なら未翻訳
        if (/^[\x00-\x7F]+$/.test(t)) return '(翻訳なし)';
        return t;
      }
      return '翻訳失敗';
    } catch {
      return '翻訳失敗';
    }
  }

  /**
   * 元画像の上に翻訳テキストをオーバーレイ描画
   */
  async function renderTranslationOverlay(img, ocrLines, translations) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    if (w === 0 || h === 0) {
      console.error('Overlay: image dimensions are 0');
      return null;
    }

    // 常に通常のCanvasを使用（OffscreenCanvasの互換性問題を回避）
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // 元画像を描画
    ctx.drawImage(img, 0, 0, w, h);

    // 全体を少し暗くする
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, w, h);

    console.log(`Overlay: drawing ${ocrLines.length} lines on ${w}x${h}`);

    for (let i = 0; i < ocrLines.length; i++) {
      const line = ocrLines[i];
      const translation = translations[i];
      if (!translation) continue;

      const { x0, y0, x1, y1 } = line.bbox;
      const boxW = x1 - x0;
      const boxH = y1 - y0;

      // フォントサイズを画像解像度に合わせてスケーリング
      const baseSize = Math.max(14, Math.min(boxH * 0.8, Math.round(h / 30)));

      // 半透明黒背景
      const padding = 4;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
      const bx = x0 - padding;
      const by = y0 - padding;
      const bw = Math.max(boxW, 120) + padding * 2;
      const bh = boxH + padding * 2 + baseSize + 6;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(bx, by, bw, bh, 4);
      } else {
        ctx.rect(bx, by, bw, bh);
      }
      ctx.fill();

      // 原文 (白)
      ctx.font = `bold ${Math.max(12, boxH * 0.65)}px Arial, sans-serif`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textBaseline = 'top';
      ctx.fillText(line.text, x0, y0, bw - padding * 2);

      // 翻訳 (金色)
      ctx.font = `bold ${baseSize}px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`;
      ctx.fillStyle = '#FFD700';
      ctx.fillText(translation, x0, y0 + boxH + 3, bw - padding * 2);
    }

    // Blob化して返す
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * クリップボードから画像を貼り付け
   */
  async function pasteImageFromClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        showToast('このブラウザでは貼り付けに非対応です。\nCtrl+V で直接貼り付けてください');
        return;
      }

      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            await processTranslateImage(blob);
            return;
          }
        }
      }
      showToast('クリップボードに画像がありません。\nスクショをコピーしてから貼り付けてください');
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('クリップボードの読み取りが拒否されました。\nCtrl+V で貼り付けてください');
      } else {
        showToast('貼り付けエラー: ' + err.message);
        console.error('Paste error:', err);
      }
    }
  }

  /**
   * Screen Capture API (PC限定)
   */
  async function startScreenCapture() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('このブラウザでは画面キャプチャに対応していません');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never' },
        audio: false
      });

      state.captureStream = stream;
      state.isCapturing = true;

      const video = document.getElementById('capture-video');
      video.srcObject = stream;
      video.style.display = 'block';

      document.getElementById('capture-preview-area').classList.remove('hidden');
      document.getElementById('btn-start-capture').classList.add('hidden');
      document.getElementById('btn-stop-capture').classList.remove('hidden');
      document.getElementById('capture-live-controls').classList.remove('hidden');

      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenCapture();
      });

      showToast('画面キャプチャを開始しました');

      state.captureInterval = parseInt(document.getElementById('capture-interval').value);
      if (state.captureInterval > 0) {
        setTimeout(() => {
          if (state.isCapturing) {
            captureAndOCR();
            if (state.captureInterval > 0) {
              state.captureTimer = setInterval(captureAndOCR, state.captureInterval);
            }
          }
        }, 1500);
      }

    } catch (err) {
      if (err.name === 'NotAllowedError') {
        showToast('画面キャプチャが拒否されました');
      } else {
        showToast('キャプチャエラー: ' + err.message);
        console.error('Screen capture error:', err);
      }
    }
  }

  function stopScreenCapture() {
    if (state.captureStream) {
      state.captureStream.getTracks().forEach(t => t.stop());
      state.captureStream = null;
    }
    if (state.captureTimer) {
      clearInterval(state.captureTimer);
      state.captureTimer = null;
    }
    state.isCapturing = false;

    const video = document.getElementById('capture-video');
    video.srcObject = null;
    video.style.display = 'none';

    document.getElementById('btn-start-capture').classList.remove('hidden');
    document.getElementById('btn-stop-capture').classList.add('hidden');
    document.getElementById('capture-live-controls').classList.add('hidden');

    showToast('キャプチャを停止しました');
  }

  async function manualCapture() {
    if (!state.isCapturing) return;
    await captureAndOCR();
  }

  async function captureAndOCR() {
    if (!state.isCapturing || !state.captureStream) return;

    const video = document.getElementById('capture-video');
    const snapshot = document.getElementById('capture-snapshot');
    const loadingEl = document.getElementById('translate-ocr-loading');
    const statusEl = document.getElementById('translate-ocr-status');
    const toggleBtn = document.getElementById('btn-toggle-overlay');

    if (video.videoWidth === 0) return;

    // スナップショット取得（動的canvas作成）
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = video.videoWidth;
    frameCanvas.height = video.videoHeight;
    const frameCtx = frameCanvas.getContext('2d');
    frameCtx.drawImage(video, 0, 0);

    // 元画像をImageとして保持（オーバーレイ用）
    const frameBlob = await new Promise(r => frameCanvas.toBlob(r, 'image/png'));
    const frameUrl = URL.createObjectURL(frameBlob);
    const frameImg = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = frameUrl;
    });

    // 元画像を保存
    state.translateOriginalSrc = frameUrl;

    loadingEl.classList.remove('hidden');

    try {
      // 2パスOCR
      statusEl.textContent = 'OCR処理中...';
      const scaledCanvas = scaleImage(frameImg, 2);
      const scaledBlob = await canvasToBlob(scaledCanvas);
      const result1 = await runOCR(scaledBlob);

      const invertedCanvas = preprocessInvert(frameImg, 2);
      const invertedBlob = await canvasToBlob(invertedCanvas);
      const result2 = await runOCR(invertedBlob);

      const conf1 = result1.data.confidence || 0;
      const conf2 = result2.data.confidence || 0;
      const bestData = conf1 >= conf2 ? result1.data : result2.data;
      const scale = 2;

      const lines = (bestData.lines || []).filter(l => {
        const text = l.text.trim();
        if (text.length < 2) return false;
        if (l.confidence < 30) return false;
        if (!/[a-zA-Z0-9]/.test(text)) return false;
        return true;
      });

      const ocrLines = lines.map(l => ({
        text: l.text.trim(),
        confidence: l.confidence,
        bbox: {
          x0: Math.round(l.bbox.x0 / scale),
          y0: Math.round(l.bbox.y0 / scale),
          x1: Math.round(l.bbox.x1 / scale),
          y1: Math.round(l.bbox.y1 / scale)
        }
      }));

      state.lastOcrLines = ocrLines;

      if (ocrLines.length === 0) {
        // テキストなしでも元画像を表示
        snapshot.src = frameUrl;
        snapshot.style.display = 'block';
        document.getElementById('capture-preview-area').classList.remove('hidden');
        document.getElementById('translate-ocr-text').innerText = '';
        loadingEl.classList.add('hidden');
        return;
      }

      document.getElementById('translate-ocr-text').innerText =
        ocrLines.map(l => l.text).join('\n');

      // 翻訳
      statusEl.textContent = `翻訳中... (${ocrLines.length}ブロック)`;
      const translations = await translateLines(ocrLines.map(l => l.text));

      // テキスト翻訳結果も表示
      const outputEl = document.getElementById('translation-output');
      outputEl.innerText = ocrLines.map((l, i) =>
        `${l.text}\n→ ${translations[i] || ''}`
      ).join('\n\n');

      // オーバーレイ描画
      statusEl.textContent = 'オーバーレイを描画中...';
      try {
        const overlayBlob = await renderTranslationOverlay(frameImg, ocrLines, translations);
        if (overlayBlob && overlayBlob.size > 0) {
          if (state.translateOverlaySrc && state.translateOverlaySrc.startsWith('blob:')) {
            URL.revokeObjectURL(state.translateOverlaySrc);
          }
          const overlayUrl = URL.createObjectURL(overlayBlob);
          state.translateOverlaySrc = overlayUrl;
          state.translateOverlayBlob = overlayBlob;

          // 画像読み込みを待つ
          await new Promise((resolve, reject) => {
            snapshot.onload = resolve;
            snapshot.onerror = () => { console.error('Live overlay img load failed'); reject(); };
            snapshot.src = overlayUrl;
          });

          toggleBtn.classList.remove('hidden');
          const dlEl = document.getElementById('btn-download-overlay');
          if (dlEl) dlEl.classList.remove('hidden');
          state.showOverlay = true;
          snapshot.style.display = 'block';
          document.getElementById('capture-preview-area').classList.remove('hidden');
          toggleBtn.textContent = '🌐 翻訳表示 ON';
        }
      } catch (overlayErr) {
        console.error('Live overlay error:', overlayErr);
        snapshot.src = frameUrl;
        snapshot.style.display = 'block';
      }

    } catch (err) {
      console.error('Live OCR error:', err);
      snapshot.src = frameUrl;
      snapshot.style.display = 'block';
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  async function translateCurrentText() {
    const text = document.getElementById('translate-ocr-text').innerText.trim();
    if (!text) {
      showToast('テキストがありません');
      return;
    }
    await translateText(text);
  }

  async function translateText(text) {
    const outputEl = document.getElementById('translation-output');
    outputEl.innerHTML = '<span style="color:var(--text-hint);">翻訳中...</span>';

    try {
      // MyMemory Translation API (無料、登録不要)
      const encodedText = encodeURIComponent(text.substring(0, 2000));
      const response = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodedText}&langpair=en|ja`
      );

      if (!response.ok) throw new Error('API error');

      const data = await response.json();

      if (data.responseStatus === 200 && data.responseData) {
        let translation = data.responseData.translatedText;

        // 複数の翻訳候補がある場合
        let alternates = '';
        if (data.matches && data.matches.length > 1) {
          const uniqueTranslations = [];
          const seen = new Set();
          for (const m of data.matches.slice(0, 5)) {
            const t = m.translation;
            if (!seen.has(t) && t !== translation) {
              seen.add(t);
              uniqueTranslations.push({ text: t, quality: m.quality || 0 });
            }
          }
          if (uniqueTranslations.length > 0) {
            alternates = '\n\n--- 他の候補 ---\n' +
              uniqueTranslations.map(t => `• ${t.text}`).join('\n');
          }
        }

        outputEl.innerText = translation + alternates;
      } else {
        outputEl.innerText = '翻訳できませんでした。テキストを変えてみてください。';
      }
    } catch (err) {
      console.error('Translation error:', err);
      // フォールバック: 簡易辞書ベースの単語訳
      outputEl.innerText = '翻訳APIに接続できません。\nオフラインでは利用できません。';
    }
  }

  async function addWordsFromTranslation() {
    const text = document.getElementById('translate-ocr-text').innerText.trim();
    if (!text) {
      showToast('テキストがありません');
      return;
    }

    // 英単語を抽出 (3文字以上のアルファベット)
    const wordRegex = /\b[a-zA-Z]{3,}\b/g;
    const matches = text.match(wordRegex);
    if (!matches || matches.length === 0) {
      showToast('英単語が見つかりません');
      return;
    }

    // 重複排除 & 小文字化
    const unique = [...new Set(matches.map(w => w.toLowerCase()))];

    // 一般的すぎる単語を除外
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
      'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has',
      'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
      'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
      'use', 'this', 'that', 'with', 'have', 'from', 'they',
      'been', 'will', 'each', 'make', 'like', 'him', 'into',
      'time', 'very', 'when', 'come', 'just', 'know', 'take',
      'than', 'them', 'some', 'what', 'there', 'which', 'their',
      'would', 'about', 'could', 'other', 'these', 'then', 'also'
    ]);

    const filtered = unique.filter(w => !stopWords.has(w));
    if (filtered.length === 0) {
      showToast('追加できる単語がありません');
      return;
    }

    // 既存単語チェック
    const existingWords = await VocabDB.getAllWords();
    const existingSet = new Set(existingWords.map(w => w.word.toLowerCase()));
    const newWords = filtered.filter(w => !existingSet.has(w));

    if (newWords.length === 0) {
      showToast('すべて登録済みです');
      return;
    }

    // 確認モーダル
    showModal(`${newWords.length}個の単語を追加`, `
      <div style="max-height:300px; overflow-y:auto; margin-bottom:16px;">
        ${newWords.map(w => `
          <label style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); cursor:pointer;">
            <input type="checkbox" class="translate-word-check" value="${esc(w)}" checked>
            <span style="font-weight:600;">${esc(w)}</span>
          </label>
        `).join('')}
      </div>
      <button class="btn btn-primary btn-block" id="btn-confirm-add-translated">選択した単語を追加</button>
    `);

    document.getElementById('btn-confirm-add-translated').addEventListener('click', async () => {
      const selectedWords = [];
      document.querySelectorAll('.translate-word-check:checked').forEach(el => {
        selectedWords.push(el.value);
      });

      if (selectedWords.length === 0) {
        showToast('単語を選択してください');
        return;
      }

      let added = 0;
      for (const w of selectedWords) {
        try {
          await VocabDB.addWord(VocabDB.createWordEntry({
            word: w,
            meaning: '',
            tags: ['翻訳抽出']
          }));
          added++;
        } catch (e) {
          // 重複エラーは無視
        }
      }

      hideModal();
      showToast(`${added}個の単語を追加しました`);
    });
  }

  function showSortModal() {
    showModal('並び替え', `
      <div class="study-modes">
        <div class="settings-item" data-sort="newest" style="cursor:pointer">
          <span class="settings-label">新しい順</span>
        </div>
        <div class="settings-item" data-sort="oldest" style="cursor:pointer">
          <span class="settings-label">古い順</span>
        </div>
        <div class="settings-item" data-sort="alpha" style="cursor:pointer">
          <span class="settings-label">アルファベット順</span>
        </div>
        <div class="settings-item" data-sort="weak" style="cursor:pointer">
          <span class="settings-label">正答率が低い順</span>
        </div>
      </div>
    `);

    document.querySelectorAll('[data-sort]').forEach(item => {
      item.addEventListener('click', async () => {
        const sort = item.dataset.sort;
        let words = await VocabDB.getAllWords();

        switch (sort) {
          case 'newest':
            words.sort((a, b) => b.createdAt - a.createdAt);
            break;
          case 'oldest':
            words.sort((a, b) => a.createdAt - b.createdAt);
            break;
          case 'alpha':
            words.sort((a, b) => a.word.localeCompare(b.word));
            break;
          case 'weak':
            words.sort((a, b) => {
              const aTotal = a.stats.flashcardCorrect + a.stats.flashcardIncorrect + a.stats.spellingCorrect + a.stats.spellingIncorrect;
              const bTotal = b.stats.flashcardCorrect + b.stats.flashcardIncorrect + b.stats.spellingCorrect + b.stats.spellingIncorrect;
              const aRate = aTotal > 0 ? (a.stats.flashcardIncorrect + a.stats.spellingIncorrect) / aTotal : 0;
              const bRate = bTotal > 0 ? (b.stats.flashcardIncorrect + b.stats.spellingIncorrect) / bTotal : 0;
              return bRate - aRate;
            });
            break;
        }

        const container = document.getElementById('wordlist-items');
        container.innerHTML = words.map(w => wordCardHTML(w)).join('');
        hideModal();
      });
    });
  }

  // --- 公開API ---
  return {
    init,
    navigate,
    goBack,
    hideModal,
    showToast,
    speak,
    stopScreenCapture
  };
})();

// --- アプリ起動 ---
document.addEventListener('DOMContentLoaded', App.init);
