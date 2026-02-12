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
    wordlistFilter: 'all',
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
    dailyGoal: 20
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
    return `
      <div class="word-card" data-word-id="${esc(word.id)}">
        <div class="word-level" style="background:${levelColor}"></div>
        <div class="word-info">
          <div class="word-text">${esc(word.wordDisplay || word.word)}</div>
          <div class="word-meaning">${esc(word.meaning)}</div>
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
    const all = await VocabDB.getAllWords();
    const due = SRS.getDueWords(all);

    document.getElementById('fc-count').textContent = all.length;
    document.getElementById('sp-count').textContent = all.length;
    document.getElementById('mt-count').textContent = Math.min(all.length, 6);
    document.getElementById('rv-count').textContent = due.length;

    const emptyStudy = document.getElementById('empty-study');
    if (all.length === 0) {
      emptyStudy.classList.remove('hidden');
    } else {
      emptyStudy.classList.add('hidden');
    }
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
        words = await VocabDB.getWeakWords(20);
        break;
      default:
        words = await VocabDB.getAllWords();
    }
    return shuffleArray(words);
  }

  async function startStudyMode(mode) {
    let words;

    if (mode === 'review') {
      words = await VocabDB.getDueWords();
      if (words.length === 0) {
        showToast('今日の復習はありません！');
        return;
      }
      words = shuffleArray(words);
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
    const query = document.getElementById('search-input').value.trim();
    let words = query ? await VocabDB.searchWords(query) : await VocabDB.getAllWords();

    // フィルター適用
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

  async function exportData() {
    try {
      const json = await VocabDB.exportData();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocabsnap-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('エクスポートしました');
    } catch (e) {
      showToast('エクスポートに失敗しました');
      console.error(e);
    }
  }

  async function importData(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const count = await VocabDB.importData(text);
      showToast(`${count}個の単語をインポートしました`);
      await refreshHome();
    } catch (e) {
      showToast(e.message);
    }
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
  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    speechSynthesis.speak(utterance);
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

    // --- 設定 ---
    document.getElementById('setting-darkmode').addEventListener('click', toggleDarkMode);
    document.getElementById('setting-auto-speak').addEventListener('click', toggleAutoSpeak);
    document.getElementById('setting-export').addEventListener('click', exportData);
    document.getElementById('setting-import').addEventListener('click', () => {
      document.getElementById('input-import').click();
    });
    document.getElementById('input-import').addEventListener('change', (e) => {
      importData(e.target.files[0]);
    });
    document.getElementById('setting-clear-data').addEventListener('click', clearAllData);
    document.getElementById('setting-daily-goal').addEventListener('click', changeDailyGoal);

    // --- モーダル ---
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('modal-overlay')) hideModal();
    });

    // --- ソート ---
    document.getElementById('btn-sort-words').addEventListener('click', showSortModal);
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
  // 追加モーダル
  // ===================================================
  async function editWordModal(wordId) {
    const word = await VocabDB.getWord(wordId);
    if (!word) return;

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
        <label>メモ</label>
        <textarea class="input-field" id="edit-memo">${esc(word.memo)}</textarea>
      </div>
      <button class="btn btn-primary btn-block mt-16" id="btn-save-edit">保存</button>
    `);

    document.getElementById('btn-save-edit').addEventListener('click', async () => {
      word.wordDisplay = document.getElementById('edit-word').value.trim();
      word.word = word.wordDisplay.toLowerCase();
      word.meaning = document.getElementById('edit-meaning').value.trim();
      word.phonetic = document.getElementById('edit-phonetic').value.trim();
      word.pos = document.getElementById('edit-pos').value.trim();
      word.memo = document.getElementById('edit-memo').value.trim();
      const synText = document.getElementById('edit-synonyms').value.trim();
      word.synonyms = synText ? synText.split(/[,、]/).map(s => s.trim()).filter(s => s) : [];

      await VocabDB.updateWord(word);
      hideModal();
      showToast('更新しました');
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
    speak
  };
})();

// --- アプリ起動 ---
document.addEventListener('DOMContentLoaded', App.init);
