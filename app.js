(() => {
  "use strict";

  const PROGRESS_KEY = "nablyudatel-progress-v1";
  const THEME_KEY = "nablyudatel-theme";
  const SOUND_KEY = "nablyudatel-sound";
  const DIRECTION_KEY = "nablyudatel-direction";
  const MAX_MISSED = 150;
  const REVISION_SIZE = 20;
  const ADVANCE_DELAY_CORRECT = 900;
  const ADVANCE_DELAY_WRONG = 5000;

  const screenEl = document.getElementById("screen");
  const streakEl = document.getElementById("streakCount");
  const xpEl = document.getElementById("xpCount");
  const wordsEl = document.getElementById("wordsCount");
  const wordsStatEl = document.getElementById("wordsStat");
  const mistakesEl = document.getElementById("mistakesCount");
  const mistakesStatEl = document.getElementById("mistakesStat");
  const practiceEl = document.getElementById("practiceCount");
  const practiceStatEl = document.getElementById("practiceStat");
  const themeToggleEl = document.getElementById("themeToggle");
  const soundToggleEl = document.getElementById("soundToggle");
  const directionToggleEl = document.getElementById("directionToggle");
  const mobileMenuEl = document.getElementById("mobileMenu");
  const menuToggleBtnEl = document.getElementById("menuToggleBtn");
  const mobileMenuPanelEl = document.getElementById("mobileMenuPanel");
  const hoardModal = document.getElementById("hoardModal");

  let course = null;
  let flatLessons = [];
  let exerciseIndex = new Map();
  let progress = null;
  let session = null;
  let advanceTimer = null;
  let soundMuted = false;
  let direction = "ru-en"; // "ru-en" = Russian shown, answer in English; "en-ru" = reverse
  let currentLevelId = null;

  // ---------- theme ----------
  function initTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  }
  function currentEffectiveTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function toggleTheme() {
    const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }

  // ---------- practice direction ----------
  function initDirection() {
    const stored = localStorage.getItem(DIRECTION_KEY);
    direction = stored === "en-ru" ? "en-ru" : "ru-en";
    updateDirectionToggleUI();
  }
  function updateDirectionToggleUI() {
    directionToggleEl.textContent = direction === "ru-en" ? "RU → EN" : "EN → RU";
    directionToggleEl.setAttribute(
      "aria-label",
      direction === "ru-en"
        ? "Practicing Russian to English — click to switch to English to Russian"
        : "Practicing English to Russian — click to switch to Russian to English"
    );
  }
  function toggleDirection() {
    direction = direction === "ru-en" ? "en-ru" : "ru-en";
    localStorage.setItem(DIRECTION_KEY, direction);
    updateDirectionToggleUI();
    if (session && session.queue.length) {
      cancelAdvance();
      renderExercise();
    }
  }

  // ---------- sound ----------
  function initSound() {
    soundMuted = localStorage.getItem(SOUND_KEY) === "muted";
    updateSoundToggleUI();
  }
  function updateSoundToggleUI() {
    soundToggleEl.classList.toggle("muted", soundMuted);
  }
  function toggleSound() {
    soundMuted = !soundMuted;
    localStorage.setItem(SOUND_KEY, soundMuted ? "muted" : "on");
    updateSoundToggleUI();
  }
  function beep(freq, dur) {
    if (soundMuted) return;
    try {
      const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch (e) { /* audio unavailable */ }
  }
  function playCorrectSound() { beep(880, 0.15); }
  function playIncorrectSound() { beep(220, 0.25); }
  // Mobile browsers suspend AudioContext until a genuine user gesture
  // unlocks it; warm it up on the very first tap anywhere on the page so
  // the first real beep (an answer tap) isn't the one that gets dropped.
  function warmAudio() {
    try {
      const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === "suspended") ctx.resume();
    } catch (e) { /* audio unavailable */ }
  }
  document.addEventListener("pointerdown", warmAudio, { once: true, passive: true });

  // ---------- text-to-speech ----------
  // Ranked by how natural/pleasant they sound among voices that ship free
  // with the browser/OS (no paid API, no extra download): Chrome's Google
  // voices and Edge's neural voices lead, then other common system voices
  // before falling back to anything in that language.
  const VOICE_RANK_EN = [
    /Google US English/i,
    /Microsoft (Aria|Jenny|Emma).*(Natural|Online)/i,
    /Samantha/i,
    /Microsoft Zira/i,
    /Ava|Nicky|Zoe/i,
    /Microsoft (David|Mark)/i,
  ];
  const VOICE_RANK_RU = [
    /Google русский/i,
    /Microsoft (Svetlana|Dariya).*(Natural|Online)/i,
    /Milena/i,
    /Microsoft (Irina|Pavel)/i,
    /Yuri/i,
  ];
  let _voices = [];
  let _preferredVoiceEn = null;
  let _preferredVoiceRu = null;
  function pickVoice(lang, rankList) {
    const pool = _voices.filter(v => v.lang === lang || v.lang.startsWith(lang.slice(0, 2)));
    for (const pattern of rankList) {
      const match = pool.find(v => pattern.test(v.name));
      if (match) return match;
    }
    return pool[0] || null;
  }
  function refreshVoices() {
    if (!("speechSynthesis" in window)) return;
    _voices = window.speechSynthesis.getVoices() || [];
    _preferredVoiceEn = pickVoice("en-US", VOICE_RANK_EN);
    _preferredVoiceRu = pickVoice("ru-RU", VOICE_RANK_RU);
  }
  if ("speechSynthesis" in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }
  const SPEECH_RATE = 0.85;
  function speak(text, lang, onEnd) {
    if (soundMuted || !("speechSynthesis" in window)) { if (onEnd) onEnd(); return; }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      u.rate = SPEECH_RATE;
      const voice = lang === "ru-RU" ? _preferredVoiceRu : _preferredVoiceEn;
      if (voice) u.voice = voice;
      if (onEnd) { u.onend = onEnd; u.onerror = onEnd; }
      window.speechSynthesis.speak(u);
    } catch (e) { if (onEnd) onEnd(); }
  }
  function speakAnswer(text, onEnd) {
    speak(text, direction === "ru-en" ? "en-US" : "ru-RU", onEnd);
  }
  // Estimate for the feedback timer bar's animation-duration only (cosmetic;
  // the actual advance is driven by the real TTS "end" event below).
  function speechDurationMs(text) {
    if (!text) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return (words / (2.3 * SPEECH_RATE)) * 1000 + 1000;
  }
  function visualDelay(correct, text) {
    const base = correct ? ADVANCE_DELAY_CORRECT : ADVANCE_DELAY_WRONG;
    return Math.max(base, speechDurationMs(text));
  }
  // Advance the instant the spoken answer finishes playing — no estimate, no
  // added pause, synced exactly to the real TTS "end" event. Falls back to
  // the fixed delay only when there's nothing to speak or audio is off, so
  // the learner still gets a moment to read.
  function advanceAfterSpeech(text, fallbackDelay) {
    if (!text || soundMuted || !("speechSynthesis" in window)) {
      scheduleAdvance(fallbackDelay);
      return;
    }
    speakAnswer(text, () => scheduleAdvance(0));
  }

  // ---------- persistence ----------
  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* corrupt storage, fall through to defaults */ }
    return { xp: 0, streak: 0, lastActiveDate: null, completedLessons: [], missedBank: [], wordHoard: [] };
  }
  function saveProgress() {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    if (window.CloudSync && window.CloudSync.user) {
      window.CloudSync.pushProgress(progress);
    }
  }
  function updateStreakOnCompletion() {
    const today = new Date().toDateString();
    if (progress.lastActiveDate !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      progress.streak = progress.lastActiveDate === yesterday ? progress.streak + 1 : 1;
      progress.lastActiveDate = today;
    }
    saveProgress();
  }
  function revisionPool() {
    const completedLessons = flatLessons.filter(l => progress.completedLessons.includes(l.id));
    const pool = [];
    completedLessons.forEach(lesson => {
      lesson.exercises.forEach((ex, i) => pool.push({ gid: `${lesson.id}:${i}`, lesson }));
    });
    return pool;
  }
  function refreshTopStats() {
    streakEl.textContent = progress.streak;
    xpEl.textContent = progress.xp;
    wordsEl.textContent = progress.wordHoard.length;
    mistakesEl.textContent = progress.missedBank.length;
    mistakesStatEl.classList.toggle("hidden", progress.missedBank.length === 0);
    const poolSize = revisionPool().length;
    practiceEl.textContent = poolSize;
    practiceStatEl.classList.toggle("hidden", poolSize === 0);
  }

  // ---------- helpers ----------
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function ruTokens(s) {
    return s.trim().replace(/[.,!?;:«»"—–]/g, "").split(/\s+/).filter(Boolean);
  }
  function enTokens(s) {
    return s.trim().replace(/[.,!?;:«»"—–]/g, "").split(/\s+/).filter(Boolean);
  }
  function isLessonUnlocked(flatIndex) {
    if (flatIndex === 0) return true;
    return progress.completedLessons.includes(flatLessons[flatIndex - 1].id);
  }
  function harvestWords(ex) {
    // Always collect the Russian side — this is a Russian term bank regardless of practice direction.
    const words = ruTokens(ex.ru);
    let added = 0;
    words.forEach(w => {
      if (!progress.wordHoard.includes(w)) { progress.wordHoard.push(w); added++; }
    });
    if (added) refreshTopStats();
  }

  // ---------- boot ----------
  async function loadCourseData() {
    const res = await fetch("data/course.json");
    if (!res.ok) throw new Error("Failed to load course data");
    const data = await res.json();
    course = data.course;

    flatLessons = [];
    exerciseIndex = new Map();
    course.levels.forEach(level => {
      level.lessons.forEach(lesson => {
        flatLessons.push({ ...lesson, levelId: level.id });
        lesson.exercises.forEach((ex, i) => {
          exerciseIndex.set(`${lesson.id}:${i}`, { lesson, exercise: ex });
        });
      });
    });
  }

  async function boot() {
    initTheme();
    initSound();
    initDirection();
    await loadCourseData();
    progress = loadProgress();
    if (window.CloudSync && window.CloudSync.user) {
      try {
        const remote = await window.CloudSync.pullProgress();
        if (remote) {
          progress = remote;
          saveProgress();
        } else {
          window.CloudSync.pushProgress(progress);
        }
      } catch (e) { /* offline — continue with local progress */ }
    }
    refreshTopStats();
    renderHome();
    wireGlobalUi();
  }

  function wireGlobalUi() {
    themeToggleEl.addEventListener("click", toggleTheme);
    soundToggleEl.addEventListener("click", toggleSound);
    directionToggleEl.addEventListener("click", toggleDirection);

    wordsStatEl.addEventListener("click", () => {
      renderHoard();
      hoardModal.classList.remove("hidden");
    });
    mistakesStatEl.addEventListener("click", () => {
      if (progress.missedBank.length === 0) return;
      cancelAdvance();
      startReview();
    });
    practiceStatEl.addEventListener("click", () => {
      cancelAdvance();
      startRevision();
    });

    document.getElementById("hoardClose").addEventListener("click", () => {
      hoardModal.classList.add("hidden");
    });
    hoardModal.addEventListener("click", e => {
      if (e.target === hoardModal) hoardModal.classList.add("hidden");
    });

    function closeMobileMenu() {
      mobileMenuPanelEl.classList.remove("open");
      menuToggleBtnEl.setAttribute("aria-expanded", "false");
    }
    menuToggleBtnEl.addEventListener("click", () => {
      const nowOpen = mobileMenuPanelEl.classList.toggle("open");
      menuToggleBtnEl.setAttribute("aria-expanded", String(nowOpen));
    });
    mobileMenuPanelEl.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", closeMobileMenu);
    });
    document.addEventListener("click", e => {
      if (mobileMenuPanelEl.classList.contains("open") && !mobileMenuEl.contains(e.target)) {
        closeMobileMenu();
      }
    });

    document.addEventListener("keydown", e => {
      if (advanceTimer && e.key === "Enter") { e.preventDefault(); cancelAdvance(); renderExercise(); return; }
      if (/^[1-4]$/.test(e.key)) {
        const opts = Array.from(document.querySelectorAll(".options .option:not(:disabled)"));
        const opt = opts[Number(e.key) - 1];
        if (opt) opt.click();
      }
    });
  }

  function renderHoard() {
    const list = document.getElementById("hoardList");
    if (progress.wordHoard.length === 0) {
      list.innerHTML = `<p class="hoard-empty">No terms collected yet — get exercises right to build your bank.</p>`;
      return;
    }
    list.innerHTML = progress.wordHoard.slice().reverse()
      .map(w => `<span class="hoard-word">${w}</span>`).join("");
  }

  // ---------- HOME ----------
  function waveformBars(pct, count = 14) {
    const filled = Math.round((pct / 100) * count);
    let html = "";
    for (let i = 0; i < count; i++) {
      const h = 8 + Math.round(Math.sin((i / count) * Math.PI) * 22);
      html += `<div class="bar${i < filled ? " filled" : ""}" style="height:${h}px"></div>`;
    }
    return html;
  }

  // Traces an actual road through the zigzagged lesson nodes — measured
  // from real layout rather than guessed from CSS, since the left/center/
  // right offsets are percentage-based and shift with container width.
  function drawRoadmapPath() {
    const roadmapEl = document.getElementById("roadmapEl");
    if (!roadmapEl) return;
    const nodes = Array.from(roadmapEl.querySelectorAll(".roadmap-node, .roadmap-next-node"));
    if (nodes.length < 2) return;
    const containerRect = roadmapEl.getBoundingClientRect();
    const points = nodes.map(n => {
      const r = n.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - containerRect.left + roadmapEl.scrollLeft,
        y: r.top + r.height / 2 - containerRect.top + roadmapEl.scrollTop,
      };
    });
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1], curr = points[i];
      const midY = (prev.y + curr.y) / 2;
      d += ` C ${prev.x} ${midY}, ${curr.x} ${midY}, ${curr.x} ${curr.y}`;
    }
    let svg = roadmapEl.querySelector(".roadmap-path-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "roadmap-path-svg");
      roadmapEl.insertBefore(svg, roadmapEl.firstChild);
    }
    svg.setAttribute("width", roadmapEl.scrollWidth);
    svg.setAttribute("height", roadmapEl.scrollHeight);
    svg.innerHTML = `<path d="${d}" fill="none" stroke="var(--paper-deep)" stroke-width="4" stroke-linecap="round" stroke-dasharray="1 15"/>`;
  }
  let _roadmapResizeQueued = false;
  window.addEventListener("resize", () => {
    if (_roadmapResizeQueued || !document.getElementById("roadmapEl")) return;
    _roadmapResizeQueued = true;
    requestAnimationFrame(() => { _roadmapResizeQueued = false; drawRoadmapPath(); });
  });

  // The level whose roadmap should show by default: the one containing the
  // first unlocked-but-not-yet-completed lesson (i.e. "where the user is"),
  // falling back to the first level with lessons.
  function pickDefaultLevel() {
    for (const level of course.levels) {
      const levelLessons = flatLessons.filter(l => l.levelId === level.id);
      if (!levelLessons.length) continue;
      const hasCurrent = levelLessons.some(l => !progress.completedLessons.includes(l.id) && isLessonUnlocked(flatLessons.indexOf(l)));
      if (hasCurrent) return level.id;
    }
    const firstBuilt = course.levels.find(lv => flatLessons.some(l => l.levelId === lv.id));
    return firstBuilt ? firstBuilt.id : course.levels[0].id;
  }

  function renderHome() {
    if (!currentLevelId || !course.levels.some(l => l.id === currentLevelId)) {
      currentLevelId = pickDefaultLevel();
    }
    renderLevelRoadmap();
  }

  // Each level gets its own roadmap: lessons as round nodes running bottom
  // (lesson 1) to top (last lesson), like climbing toward the level's peak.
  // Completing the level unlocks a "next level" node above the last lesson.
  function renderLevelRoadmap() {
    const totalLessons = flatLessons.length;
    const doneLessons = flatLessons.filter(l => progress.completedLessons.includes(l.id)).length;
    const overallPct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;

    const level = course.levels.find(l => l.id === currentLevelId);
    const builtLevels = course.levels.filter(lv => lv.lessons.length > 0);
    const builtIdx = builtLevels.findIndex(lv => lv.id === currentLevelId);
    const prevLevel = builtIdx > 0 ? builtLevels[builtIdx - 1] : null;
    const nextLevel = builtIdx >= 0 && builtIdx < builtLevels.length - 1 ? builtLevels[builtIdx + 1] : null;

    const levelLessons = flatLessons.filter(l => l.levelId === level.id);
    const levelDone = levelLessons.filter(l => progress.completedLessons.includes(l.id)).length;
    const levelComplete = levelLessons.length > 0 && levelDone === levelLessons.length;

    let nodesHtml = "";
    levelLessons.forEach((lesson, i) => {
      const flatIndex = flatLessons.indexOf(lesson);
      const unlocked = isLessonUnlocked(flatIndex);
      const done = progress.completedLessons.includes(lesson.id);
      const isCurrent = unlocked && !done;
      const offset = ["center", "left", "right"][i % 3];
      nodesHtml += `
        <div class="roadmap-row ${offset}">
          <button class="roadmap-node ${done ? "done" : unlocked ? "unlocked" : "locked"} ${isCurrent ? "current" : ""}" data-lesson="${lesson.id}" ${unlocked ? "" : "disabled"} aria-label="${lesson.title}">
            ${done ? "✓" : unlocked ? lesson.number : "🔒"}
          </button>
          <div class="roadmap-label"><span class="roadmap-label-en">${lesson.title}</span><span class="roadmap-label-native">${lesson.titleNative || ""}</span></div>
        </div>
      `;
    });
    if (levelComplete && nextLevel) {
      nodesHtml += `
        <div class="roadmap-row center">
          <button class="roadmap-next-node" id="nextLevelBtn" aria-label="Next level">🏁</button>
          <div class="roadmap-label"><span class="roadmap-label-en">Level complete!</span><span class="roadmap-label-native">Next: ${nextLevel.badge}</span></div>
        </div>
      `;
    }

    screenEl.innerHTML = `
      <div class="level-progress-card">
        <div class="waveform">${waveformBars(overallPct)}</div>
        <div class="level-progress-info">
          <div class="pct">${overallPct}%</div>
          <div class="label">Overall progress</div>
          <div class="count">${doneLessons} / ${totalLessons} lessons</div>
        </div>
      </div>
      <div class="roadmap-header">
        <button class="roadmap-arrow" id="prevLevelBtn" ${prevLevel ? "" : "disabled"} aria-label="Previous level">‹</button>
        <div class="roadmap-level-info">
          <span class="level-badge">${level.badge}</span>
          <h2>${level.label}${level.labelNative ? ` &middot; ${level.labelNative}` : ""}</h2>
          <span class="level-count">${levelLessons.length ? `${levelDone}/${levelLessons.length}` : "coming soon"}</span>
        </div>
        <button class="roadmap-arrow" id="nextLevelNavBtn" ${nextLevel ? "" : "disabled"} aria-label="Next level">›</button>
      </div>
      ${!levelLessons.length
        ? `<div class="level-locked-note">Lessons for ${level.badge} are still being prepared and will appear here soon.</div>`
        : `<div class="roadmap" id="roadmapEl">${nodesHtml}</div>`
      }
    `;

    document.getElementById("prevLevelBtn").addEventListener("click", () => {
      if (!prevLevel) return;
      currentLevelId = prevLevel.id;
      renderLevelRoadmap();
    });
    document.getElementById("nextLevelNavBtn").addEventListener("click", () => {
      if (!nextLevel) return;
      currentLevelId = nextLevel.id;
      renderLevelRoadmap();
    });
    const nextLevelBtn = document.getElementById("nextLevelBtn");
    if (nextLevelBtn) {
      nextLevelBtn.addEventListener("click", () => {
        if (!nextLevel) return;
        currentLevelId = nextLevel.id;
        renderLevelRoadmap();
      });
    }
    screenEl.querySelectorAll(".roadmap-node:not(.locked)").forEach(node => {
      node.addEventListener("click", () => {
        const lesson = flatLessons.find(l => l.id === node.dataset.lesson);
        if (lesson) startLesson(lesson);
      });
    });

    const target = screenEl.querySelector(".roadmap-node.current") || screenEl.querySelector(".roadmap-node.unlocked");
    requestAnimationFrame(() => {
      drawRoadmapPath();
      if (target) target.scrollIntoView({ block: "center", behavior: "auto" });
    });
  }

  // ---------- LESSON / REVIEW ----------
  function buildQueueItem(ex, gid, idx, sourceLesson) {
    return { ...ex, _idx: idx, _gid: gid, _sourceLesson: sourceLesson };
  }

  function startLesson(lesson) {
    session = {
      lesson,
      mode: "lesson",
      queue: lesson.exercises.map((ex, i) => buildQueueItem(ex, `${lesson.id}:${i}`, i, lesson)),
      total: lesson.exercises.length,
      solved: new Set(),
      mistakes: 0,
      combo: 0,
    };
    renderExercise();
  }

  function startReview() {
    const gids = progress.missedBank.filter(gid => exerciseIndex.has(gid));
    if (gids.length === 0) return;
    session = {
      lesson: { id: "__review__", title: "Review Session" },
      mode: "mistakes",
      queue: gids.map((gid, i) => buildQueueItem(exerciseIndex.get(gid).exercise, gid, i, exerciseIndex.get(gid).lesson)),
      total: gids.length,
      solved: new Set(),
      mistakes: 0,
      combo: 0,
    };
    renderExercise();
  }

  function startRevision() {
    const pool = revisionPool();
    if (pool.length === 0) return;
    const picked = shuffled(pool).slice(0, Math.min(REVISION_SIZE, pool.length));
    session = {
      lesson: { id: "__revision__", title: "Practice" },
      mode: "revision",
      queue: picked.map((item, i) => buildQueueItem(exerciseIndex.get(item.gid).exercise, item.gid, i, item.lesson)),
      total: picked.length,
      solved: new Set(),
      mistakes: 0,
      combo: 0,
    };
    renderExercise();
  }

  function currentExercise() {
    return session.queue[0];
  }

  function renderLessonChrome(bodyHtml) {
    const pct = Math.round((session.solved.size / session.total) * 100);
    const combo = session.combo >= 2 ? `<span class="combo-badge">&times;${session.combo}</span>` : "";

    screenEl.innerHTML = `
      <div class="lesson-bar">
        <button class="exit-btn" id="exitBtn" aria-label="Exit lesson">&times;</button>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        ${combo}
        <span class="infinity-badge" title="Unlimited lives — wrong answers just come back around">&infin;</span>
      </div>
      ${bodyHtml}
    `;
    document.getElementById("exitBtn").addEventListener("click", () => {
      cancelAdvance();
      session = null;
      renderHome();
    });
  }

  function renderExercise() {
    if (!session.queue.length) { finishSession(); return; }
    const ex = currentExercise();
    if (ex.type === "multiple-choice") renderMultipleChoice(ex);
    else if (ex.type === "word-bank") renderWordBank(ex);
  }

  function renderFeedback(correct, correctText, delay) {
    return `
      <div class="feedback ${correct ? "correct" : "incorrect"}" role="status">
        <button class="speak-btn" id="feedbackSpeakBtn" title="Play pronunciation" aria-label="Play pronunciation">🔊</button>
        <div class="feedback-text">
          <div class="title">${correct ? "Correct" : "Not quite"}</div>
          ${correct ? "" : `<div class="detail">${correctText}</div>`}
        </div>
        <div class="feedback-timer" style="animation-duration:${delay}ms"></div>
      </div>
    `;
  }
  function wireFeedbackReplay(text) {
    const btn = document.getElementById("feedbackSpeakBtn");
    if (btn) btn.addEventListener("click", () => speakAnswer(text));
  }

  function afterAnswer(correct) {
    const ex = currentExercise();
    correct ? playCorrectSound() : playIncorrectSound();
    if (correct) {
      session.solved.add(ex._idx);
      session.combo++;
      session.queue.shift();
      harvestWords(ex);
      const pos = progress.missedBank.indexOf(ex._gid);
      if (pos !== -1) progress.missedBank.splice(pos, 1);
    } else {
      session.mistakes++;
      session.combo = 0;
      if (!progress.missedBank.includes(ex._gid)) {
        progress.missedBank.push(ex._gid);
        if (progress.missedBank.length > MAX_MISSED) progress.missedBank.shift();
      }
      const [wrong] = session.queue.splice(0, 1);
      session.queue.push(wrong);
    }
    saveProgress();
    refreshTopStats();
  }

  function cancelAdvance() {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
  }

  function scheduleAdvance(delay) {
    cancelAdvance();
    advanceTimer = setTimeout(() => { advanceTimer = null; renderExercise(); }, delay);
  }

  // ---- multiple choice ----
  function renderMultipleChoice(ex) {
    const srcText = direction === "ru-en" ? ex.ru : ex.en;
    const correctText = direction === "ru-en" ? ex.en : ex.ru;
    const siblingTexts = (ex._sourceLesson.exercises || [])
      .filter(e => !(e.ru === ex.ru && e.en === ex.en))
      .map(e => direction === "ru-en" ? e.en : e.ru);
    const pool = Array.from(new Set(siblingTexts.filter(t => t !== correctText)));
    const distractors = shuffled(pool).slice(0, 3);
    const options = shuffled([correctText, ...distractors]);
    const answerIndex = options.indexOf(correctText);

    const optionsHtml = options.map((opt, i) =>
      `<button class="option" data-i="${i}">${opt}</button>`
    ).join("");
    const kicker = direction === "ru-en" ? "Translate to English" : "Translate to Russian";
    const promptClass = direction === "ru-en" ? "prompt-native" : "prompt-en";

    renderLessonChrome(`
      <div class="card">
        <div class="prompt-kicker">${kicker}</div>
        <div class="${promptClass}">${srcText}</div>
        <div class="options">${optionsHtml}</div>
      </div>
    `);

    const buttons = screenEl.querySelectorAll(".option");
    buttons.forEach(btn => {
      btn.addEventListener("click", () => {
        buttons.forEach(b => b.disabled = true);
        const i = Number(btn.dataset.i);
        const correct = i === answerIndex;
        btn.classList.add(correct ? "correct" : "incorrect");
        if (!correct) buttons[answerIndex].classList.add("correct");
        afterAnswer(correct);
        const fallback = correct ? ADVANCE_DELAY_CORRECT : ADVANCE_DELAY_WRONG;
        screenEl.insertAdjacentHTML("beforeend", renderFeedback(correct, correctText, visualDelay(correct, correctText)));
        wireFeedbackReplay(correctText);
        advanceAfterSpeech(correctText, fallback);
      });
    });
  }

  // ---- word bank ----
  function renderWordBank(ex) {
    const srcText = direction === "ru-en" ? ex.ru : ex.en;
    const tgtText = direction === "ru-en" ? ex.en : ex.ru;
    const tgtTokens = direction === "ru-en" ? enTokens(tgtText) : ruTokens(tgtText);
    const bank = shuffled(tgtTokens);
    let placed = [];
    const kicker = direction === "ru-en" ? "Translate to English" : "Translate to Russian";
    const promptClass = direction === "ru-en" ? "prompt-native" : "prompt-en";

    renderLessonChrome(`
      <div class="card">
        <div class="prompt-kicker">${kicker}</div>
        <div class="${promptClass}">${srcText}</div>
        <div class="bank-target" id="bankTarget"></div>
        <div class="bank-pool" id="bankPool"></div>
      </div>
    `);

    const targetEl = document.getElementById("bankTarget");
    const poolEl = document.getElementById("bankPool");
    let submitted = false;

    function submit() {
      if (submitted) return;
      submitted = true;
      poolEl.querySelectorAll(".bank-tile").forEach(b => b.disabled = true);
      targetEl.querySelectorAll(".bank-tile").forEach(b => b.disabled = true);
      const correct = placed.length === tgtTokens.length && placed.every((w, i) => w === tgtTokens[i]);
      afterAnswer(correct);
      const answerText = tgtTokens.join(" ");
      const fallback = correct ? ADVANCE_DELAY_CORRECT : ADVANCE_DELAY_WRONG;
      screenEl.insertAdjacentHTML("beforeend", renderFeedback(correct, answerText, visualDelay(correct, answerText)));
      wireFeedbackReplay(answerText);
      advanceAfterSpeech(answerText, fallback);
    }

    function renderTiles() {
      targetEl.innerHTML = placed.map((w, i) => `<button class="bank-tile" data-target-i="${i}">${w}</button>`).join("");
      // Track which bank indices are currently placed (handles duplicate words correctly).
      const usedIdx = new Set();
      placed.forEach(w => {
        const idx = bank.findIndex((b, i) => b === w && !usedIdx.has(i));
        if (idx !== -1) usedIdx.add(idx);
      });
      poolEl.innerHTML = bank.map((w, i) =>
        `<button class="bank-tile ${usedIdx.has(i) ? "placed" : ""}" data-pool-i="${i}" ${usedIdx.has(i) ? "disabled" : ""}>${w}</button>`
      ).join("");

      poolEl.querySelectorAll(".bank-tile:not(.placed)").forEach(btn => {
        btn.addEventListener("click", () => {
          placed.push(btn.textContent);
          renderTiles();
          // Auto-submit the moment every slot is filled — no separate
          // Check tap needed, matching the one-tap feel of multiple choice.
          if (placed.length === tgtTokens.length) setTimeout(submit, 150);
        });
      });
      targetEl.querySelectorAll(".bank-tile").forEach(btn => {
        btn.addEventListener("click", () => {
          if (submitted) return;
          const i = Number(btn.dataset.targetI);
          placed.splice(i, 1);
          renderTiles();
        });
      });
    }
    renderTiles();
  }

  // ---------- SESSION COMPLETE ----------
  function finishSession() {
    const perfect = session.mistakes === 0;
    if (session.mode === "lesson") {
      if (!progress.completedLessons.includes(session.lesson.id)) {
        progress.completedLessons.push(session.lesson.id);
      }
      progress.xp += perfect ? 15 : 10;
      updateStreakOnCompletion();
    } else {
      progress.xp += 5;
      saveProgress();
    }
    refreshTopStats();

    const title = session.mode === "lesson" ? "Lesson complete"
      : session.mode === "mistakes" ? "Review complete"
      : "Practice complete";

    screenEl.innerHTML = `
      <div class="summary">
        <h2>${title}</h2>
        <p>${perfect ? "Perfect run — no mistakes." : `You made ${session.mistakes} mistake${session.mistakes === 1 ? "" : "s"} along the way.`}</p>
        <div class="summary-stats">
          <div class="stat-block"><span class="num">${session.total}</span><span class="lbl">Terms</span></div>
          <div class="stat-block"><span class="num">${session.mistakes}</span><span class="lbl">Mistakes</span></div>
        </div>
        <button class="continue-btn" id="continueBtn">Continue</button>
      </div>
    `;
    document.getElementById("continueBtn").addEventListener("click", () => {
      session = null;
      renderHome();
    });
  }

  window.__appReady = boot;
})();
