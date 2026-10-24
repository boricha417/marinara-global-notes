(() => {
  "use strict";

  // ─────────────────────────────────────────────
  // 글로벌 노트 v1.2.3
  // 전용 로어북("🗒️ 글로벌 노트")에 노트를 저장하고,
  // 방마다 원하는 노트만 골라 연결하는 확장.
  //
  // v1.3.1 변경점
  //  - roomy 모드에서 콘텐츠 위 휠/터치 스크롤이 막히던 문제 수정
  //    (overscroll-behavior: contain이 스크롤 전달을 삼키던 것 제거)
  //  - 패널 전체 높이 상한 620px 복원
  //  - 새 노트 버튼을 스크롤 밖 하단 고정 바로 이동 — 목록/편집이
  //    아무리 길어도 항상 보인다
  // ─────────────────────────────────────────────

  const LB_NAME = "🗒️ 글로벌 노트";
  const LB_ID_KEY = "gnx-lorebook-id";
  const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
  const POLL_MS = 800;
  const SCAN_MS = 1200;

  const AUTHOR_BTN_SEL = 'button[aria-label="작가노트"], button[aria-label="Author\'s Notes"]';
  const CTX_BTN_SEL = 'button[aria-label="활성 컨텍스트"], button[aria-label="Active Context"]';
  // 2.5.0+: 채팅 설정(슬라이더) 버블과 앱의 버블 공통 클래스
  const SETTINGS_BUBBLE_SEL = "[data-chat-settings-button]";
  const BUBBLE_SEL = ".mari-window-bubble";
  const BUBBLE_GAP = 8; // 앱의 버블 간격(BUBBLE_SNAP_GAP_PX)

  const SVG_LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`;
  const SVG_X = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const SVG_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
  const SVG_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.6-3.6"/></svg>`;
  const SVG_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  const SVG_GRIP = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>`;
  const SVG_EXPAND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></svg>`;

  const state = {
    lbId: null,
    notes: [], // [{id, name, content, constant, keys, depth}]
    chatId: null,
    attachedIds: new Set(),
    panelOpen: false,
    expandedIds: new Set(), // 펼쳐진 노트 id들 (동시에 여러 개 가능)
    composing: false, // 새 노트 작성 중
    searchOpen: false,
    search: "",
    busy: false,
    buttonActive: false, // 현재 방에 연결된 노트가 있는지 (메뉴 버튼 눌림 표시)
  };

  const cleanupFns = [];
  let panel = null, listBox = null, subtitleEl = null, searchRow = null, searchInput = null, addBar = null;
  let lastAnchorEl = null; // 패널을 연 메뉴 버튼 (리사이즈 시 재배치 기준)

  // ---------- API ----------
  async function api(method, path, body) {
    // 본문이 없는 요청(DELETE 등)에 JSON Content-Type을 붙이면
    // 서버가 "빈 JSON 본문"으로 간주해 400을 돌려준다.
    const headers = { "x-marinara-csrf": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} 실패 (${res.status})`);
    if (res.status === 204) return null;
    return res.json();
  }

  // ---------- 로어북/노트 ----------
  async function ensureLorebook() {
    const books = await api("GET", "/lorebooks");
    const cachedId = localStorage.getItem(LB_ID_KEY);
    let book = (cachedId && books.find((b) => b.id === cachedId)) || books.find((b) => b.name === LB_NAME);
    if (!book) {
      book = await api("POST", "/lorebooks", {
        name: LB_NAME,
        description:
          "글로벌 노트 확장이 관리하는 로어북입니다. 노트 하나 = 엔트리 하나. 이름을 바꾸거나 삭제하면 확장이 로어북을 새로 만듭니다.",
        scanDepth: 5,
        tokenBudget: 8192,
        excludeFromVectorization: true,
      });
    }
    localStorage.setItem(LB_ID_KEY, book.id);
    state.lbId = book.id;
  }

  async function loadNotes() {
    const entries = await api("GET", `/lorebooks/${state.lbId}/entries`);
    state.notes = entries.map((e) => ({
      id: e.id,
      name: e.name,
      content: e.content || "",
      constant: !!e.constant,
      keys: Array.isArray(e.keys) ? e.keys : [],
      depth: Number.isFinite(e.depth) ? e.depth : 4,
    }));
  }

  function readActiveChatId() {
    try { return localStorage.getItem(ACTIVE_CHAT_KEY) || null; } catch { return null; }
  }

  async function loadChatAttachment() {
    state.attachedIds = new Set();
    if (state.chatId) {
      const chat = await api("GET", `/chats/${state.chatId}`);
      const meta = chat && typeof chat.metadata === "object" && chat.metadata ? chat.metadata : {};
      const active = Array.isArray(meta.activeLorebookIds) ? meta.activeLorebookIds : [];
      if (active.includes(state.lbId)) {
        const overrides =
          meta.entryStateOverrides && typeof meta.entryStateOverrides === "object" ? meta.entryStateOverrides : {};
        for (const note of state.notes) {
          const ov = overrides[note.id];
          if (!(ov && ov.enabled === false)) state.attachedIds.add(note.id);
        }
      }
    }
    state.buttonActive = state.attachedIds.size > 0;
    applyButtonActiveState();
  }

  /** 현재 방의 연결 상태를 desired 집합으로 맞춘다. */
  async function applyAttachment(desiredSet) {
    if (!state.chatId) throw new Error("활성 채팅방이 없습니다");
    const chat = await api("GET", `/chats/${state.chatId}`);
    const meta = chat && typeof chat.metadata === "object" && chat.metadata ? chat.metadata : {};
    const overrides = { ...(meta.entryStateOverrides && typeof meta.entryStateOverrides === "object" ? meta.entryStateOverrides : {}) };
    for (const note of state.notes) {
      const cur = overrides[note.id] && typeof overrides[note.id] === "object" ? { ...overrides[note.id] } : {};
      if (desiredSet.has(note.id)) {
        delete cur.enabled;
        if (Object.keys(cur).length > 0) overrides[note.id] = cur;
        else delete overrides[note.id];
      } else {
        cur.enabled = false;
        overrides[note.id] = cur;
      }
    }
    let active = Array.isArray(meta.activeLorebookIds) ? [...meta.activeLorebookIds] : [];
    if (desiredSet.size > 0 && !active.includes(state.lbId)) active.push(state.lbId);
    if (desiredSet.size === 0) active = active.filter((id) => id !== state.lbId);
    await api("PATCH", `/chats/${state.chatId}/metadata`, {
      activeLorebookIds: active,
      entryStateOverrides: overrides,
    });
    state.attachedIds = new Set(desiredSet);
    state.buttonActive = desiredSet.size > 0;
    applyButtonActiveState();
  }

  /** 새 노트가 이 로어북을 쓰는 다른 방에 자동 적용되지 않도록 끄기 오버라이드를 심는다. */
  async function quarantineNewEntry(entryId, exceptChatId) {
    let chats = [];
    try { chats = await api("GET", "/chats"); } catch { return; }
    if (!Array.isArray(chats)) return;
    for (const chat of chats) {
      try {
        if (!chat || chat.id === exceptChatId) continue;
        const meta = chat.metadata && typeof chat.metadata === "object" ? chat.metadata : {};
        const active = Array.isArray(meta.activeLorebookIds) ? meta.activeLorebookIds : [];
        if (!active.includes(state.lbId)) continue;
        const overrides = { ...(meta.entryStateOverrides && typeof meta.entryStateOverrides === "object" ? meta.entryStateOverrides : {}) };
        const cur = overrides[entryId] && typeof overrides[entryId] === "object" ? { ...overrides[entryId] } : {};
        cur.enabled = false;
        overrides[entryId] = cur;
        await api("PATCH", `/chats/${chat.id}/metadata`, { entryStateOverrides: overrides });
      } catch (err) {
        console.warn("[글로벌 노트] 다른 방 격리 실패:", chat && chat.id, err);
      }
    }
  }

  function parseKeywords(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || "").split(/\r?\n|,/)) {
      const k = raw.trim();
      if (!k) continue;
      const dk = k.toLowerCase();
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push(k);
    }
    return out;
  }

  /** 주입 깊이 입력값 → 정수. 0도 유효한 값("마지막 메시지 뒤")이라 `|| 4`로 처리하면 안 된다. 빈 칸은 기본 4. */
  function parseDepth(raw) {
    if (raw == null || String(raw).trim() === "") return 4;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : 4;
  }

  async function saveNote({ id, name, content, mode, keywordsText, depth }) {
    const payload = {
      name,
      content,
      constant: mode === "always",
      keys: parseKeywords(keywordsText),
      enabled: true,
      position: 2, // At Depth — 작가노트와 같은 방식으로 주입
      depth: parseDepth(depth),
      role: "system",
      preventRecursion: true,
      excludeFromVectorization: true,
    };
    if (id) {
      await api("PATCH", `/lorebooks/${state.lbId}/entries/${id}`, payload);
      return id;
    }
    const created = await api("POST", `/lorebooks/${state.lbId}/entries`, payload);
    await quarantineNewEntry(created.id, state.chatId);
    return created.id;
  }

  async function deleteNote(id) {
    await api("DELETE", `/lorebooks/${state.lbId}/entries/${id}`);
  }

  async function reorderNotes(orderedIds) {
    await api("PUT", `/lorebooks/${state.lbId}/entries/reorder`, { entryIds: orderedIds });
    const byId = new Map(state.notes.map((n) => [n.id, n]));
    state.notes = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  }

  // ---------- UI 유틸 ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(message, isError = false) {
    let node = document.querySelector(".gnx-toast");
    if (!node) {
      node = el("div", "gnx-toast");
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.toggle("gnx-toast--error", isError);
    node.classList.add("gnx-toast--show");
    clearTimeout(node._t);
    node._t = setTimeout(() => node.classList.remove("gnx-toast--show"), 2200);
  }

  function estTokens(text) {
    return Math.ceil(String(text || "").length / 4);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // ---------- 렌더 ----------
  function renderSubtitle() {
    if (!subtitleEl) return;
    if (!state.chatId) subtitleEl.textContent = "채팅방을 열면 노트를 연결할 수 있어요";
    else if (state.attachedIds.size > 0) subtitleEl.textContent = `이 방에 ${state.attachedIds.size}개 연결됨`;
    else subtitleEl.textContent = "체크하면 이 방에 연결됩니다";
  }

  function visibleNotes() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.notes;
    return state.notes.filter(
      (n) => n.name.toLowerCase().includes(term) || n.content.toLowerCase().includes(term),
    );
  }

  function render() {
    renderSubtitle();
    searchRow.style.display = state.searchOpen ? "" : "none";
    listBox.replaceChildren();

    const notes = visibleNotes();
    const filtering = !!state.search.trim();

    // 노트 행들은 자체 스크롤 영역에 담는다 — 목록이 8개를 넘으면 여기만 스크롤되고,
    // 새 노트 에디터는 그 아래에 그대로 보인다.
    // 단, 새 노트 "작성 중"에는 목록을 접는다: 모바일에서 목록 스크롤과 패널
    // 스크롤이 겹쳐 에디터로 가려면 두 번 스크롤해야 하던 문제를 없앤다.
    const composing = state.composing;
    if (composing) {
      if (state.notes.length > 0) {
        listBox.append(el("div", "gnx-collapsed", `노트 ${state.notes.length}개 접힘 — 작성을 마치면 다시 보여요`));
      }
    } else {
      const rowsBox = el("div", "gnx-rows");
      // 아코디언이 하나라도 열려 있으면 8행 제한을 풀어 편집/비교 공간을 넓힌다
      if (state.expandedIds.size > 0) rowsBox.classList.add("gnx-rows--roomy");
      if (state.notes.length === 0) {
        rowsBox.append(el("div", "gnx-empty", "아직 노트가 없어요.\n아래에서 첫 노트를 만들어 보세요."));
      } else if (notes.length === 0) {
        rowsBox.append(el("div", "gnx-empty", "검색 결과가 없어요."));
      }
      for (const note of notes) {
        rowsBox.append(buildItem(note, filtering));
      }
      listBox.append(rowsBox);
    }

    if (state.composing) {
      const item = el("div", "gnx-item gnx-item--new");
      item.append(buildEditor(null));
      listBox.append(item);
    }
    // 새 노트 버튼은 스크롤 밖 하단 고정 바에 있다 — 작성 중에만 숨긴다
    if (addBar) addBar.style.display = state.composing ? "none" : "";
  }

  function buildItem(note, filtering) {
    const item = el("div", "gnx-item");
    item.dataset.id = note.id;
    const expanded = state.expandedIds.has(note.id);

    const row = el("div", "gnx-row");

    const grip = el("span", "gnx-grip");
    grip.innerHTML = SVG_GRIP;
    grip.title = filtering ? "검색 중에는 순서를 바꿀 수 없어요" : "드래그해서 순서 변경";
    grip.classList.toggle("gnx-grip--off", filtering || state.busy);
    if (!filtering) grip.addEventListener("pointerdown", (e) => startRowDrag(e, item));

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "gnx-check";
    checkbox.checked = state.attachedIds.has(note.id);
    checkbox.disabled = !state.chatId || state.busy;
    checkbox.title = state.chatId ? "이 채팅방에 연결" : "채팅방을 먼저 열어주세요";
    checkbox.addEventListener("change", async () => {
      const desired = new Set(state.attachedIds);
      if (checkbox.checked) desired.add(note.id);
      else desired.delete(note.id);
      state.busy = true;
      try {
        await applyAttachment(desired);
        toast(checkbox.checked ? `"${note.name}" 연결됨` : `"${note.name}" 해제됨`);
      } catch (err) {
        console.error("[글로벌 노트]", err);
        toast("연결 변경에 실패했어요", true);
      } finally {
        state.busy = false;
        render();
      }
    });

    const titleBtn = el("button", "gnx-row-main");
    titleBtn.type = "button";
    titleBtn.append(el("span", "gnx-row-name", note.name));
    const tag = el("span", note.constant ? "gnx-tag gnx-tag--always" : "gnx-tag gnx-tag--kw", note.constant ? "항상" : "키워드");
    if (!note.constant && note.keys.length > 0) tag.title = note.keys.join(", ");
    titleBtn.append(tag);
    titleBtn.append(el("span", "gnx-row-tokens", `~${estTokens(note.content)}`));
    const chevron = el("span", "gnx-chevron" + (expanded ? " gnx-chevron--open" : ""));
    chevron.innerHTML = SVG_CHEVRON;
    titleBtn.append(chevron);
    titleBtn.addEventListener("click", () => {
      if (expanded) state.expandedIds.delete(note.id);
      else state.expandedIds.add(note.id);
      render();
    });

    row.append(grip, checkbox, titleBtn);
    item.append(row);
    if (expanded) item.append(buildEditor(note));
    return item;
  }

  function buildEditor(note) {
    const box = el("div", "gnx-editor");

    // 한 줄짜리 textarea — 삼성 키보드 등이 일반 input을 자동완성(주소/지갑/비번)
    // 대상으로 판단해 키보드 위에 흰 바를 띄우는 것을 원천 차단한다.
    const nameInput = document.createElement("textarea");
    nameInput.className = "gnx-input gnx-name-input";
    nameInput.rows = 1;
    nameInput.placeholder = "노트 이름";
    nameInput.maxLength = 200;
    nameInput.value = note ? note.name : "";
    nameInput.setAttribute("autocomplete", "off");
    nameInput.setAttribute("autocapitalize", "off");
    nameInput.spellcheck = false;
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
    nameInput.addEventListener("input", () => {
      if (/\r|\n/.test(nameInput.value)) nameInput.value = nameInput.value.replace(/\r?\n/g, " ");
    });

    const contentWrap = el("div", "gnx-content-wrap");
    const contentInput = document.createElement("textarea");
    contentInput.className = "gnx-input gnx-textarea";
    contentInput.rows = 6;
    contentInput.placeholder = "내용";
    contentInput.value = note ? note.content : "";

    const expandBtn = el("button", "gnx-expand-btn");
    expandBtn.type = "button";
    expandBtn.title = "편집기 펼치기";
    expandBtn.setAttribute("aria-label", "편집기 펼치기");
    expandBtn.innerHTML = SVG_EXPAND;
    expandBtn.addEventListener("click", () => {
      openExpandedEditor(nameInput.value.trim() || "글로벌 노트", contentInput);
    });
    contentWrap.append(contentInput, expandBtn);

    // 토큰 수는 주입 깊이 줄 오른쪽에 표시한다 (별도 줄로 공백을 만들지 않음)
    const tokenInfo = el("span", "gnx-token-inline", `~${estTokens(contentInput.value)} 토큰`);
    contentInput.addEventListener("input", () => {
      tokenInfo.textContent = `~${estTokens(contentInput.value)} 토큰`;
    });

    let mode = note ? (note.constant ? "always" : "keyword") : "always";
    const modeBox = el("div", "gnx-seg");
    const alwaysBtn = el("button", "gnx-seg-btn", "항상");
    const kwBtn = el("button", "gnx-seg-btn", "조건부 (키워드)");
    alwaysBtn.type = "button";
    kwBtn.type = "button";

    const kwWrap = el("div", "gnx-kw-wrap");
    const kwInput = document.createElement("textarea");
    kwInput.className = "gnx-input gnx-kw-input";
    kwInput.rows = 2;
    kwInput.placeholder = "키워드 입력 — 쉼표/줄바꿈으로 여러 개 등록. 최근 대화에 나타날 때만 주입됩니다.";
    kwInput.value = note ? note.keys.join(", ") : "";
    kwWrap.append(kwInput);

    function syncMode() {
      alwaysBtn.classList.toggle("gnx-seg-btn--on", mode === "always");
      kwBtn.classList.toggle("gnx-seg-btn--on", mode === "keyword");
      kwWrap.style.display = mode === "keyword" ? "" : "none";
    }
    alwaysBtn.addEventListener("click", () => { mode = "always"; syncMode(); });
    kwBtn.addEventListener("click", () => { mode = "keyword"; syncMode(); });
    modeBox.append(alwaysBtn, kwBtn);
    syncMode();

    const depthRow = el("div", "gnx-depth-row");
    depthRow.append(el("span", "gnx-hint", "주입 깊이"));
    const depthInput = document.createElement("input");
    depthInput.type = "text";
    depthInput.inputMode = "numeric";
    depthInput.className = "gnx-input gnx-depth-input";
    depthInput.setAttribute("autocomplete", "off");
    depthInput.value = String(note ? note.depth : 4);
    depthInput.addEventListener("input", () => {
      depthInput.value = depthInput.value.replace(/[^0-9]/g, "");
    });
    depthRow.append(depthInput, el("span", "gnx-hint", "0 = 마지막 메시지 뒤 · 기본 4"), tokenInfo);

    const btnRow = el("div", "gnx-btn-row");
    const saveBtn = el("button", "gnx-btn gnx-btn--primary", note ? "저장" : "만들기");
    const cancelBtn = el("button", "gnx-btn", "닫기");
    saveBtn.type = "button";
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => {
      if (note) state.expandedIds.delete(note.id);
      else state.composing = false;
      render();
    });

    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("이름을 입력해주세요", true); nameInput.focus(); return; }
      state.busy = true;
      saveBtn.disabled = true;
      try {
        const savedId = await saveNote({
          id: note ? note.id : null,
          name,
          content: contentInput.value,
          mode,
          keywordsText: kwInput.value,
          depth: depthInput.value,
        });
        await loadNotes();
        if (!note && state.chatId) {
          const desired = new Set(state.attachedIds);
          desired.add(savedId);
          await applyAttachment(desired);
          toast("노트를 만들고 이 방에 연결했어요");
        } else {
          await loadChatAttachment();
          toast(note ? "저장했어요" : "노트를 만들었어요");
        }
        // busy를 먼저 풀고 렌더해야 체크박스가 활성 상태로 그려진다
        state.busy = false;
        if (note) state.expandedIds.delete(note.id);
        else state.composing = false;
        render();
      } catch (err) {
        console.error("[글로벌 노트]", err);
        toast("저장에 실패했어요", true);
      } finally {
        state.busy = false;
        saveBtn.disabled = false;
      }
    });

    btnRow.append(cancelBtn, saveBtn);

    if (note) {
      const delBtn = el("button", "gnx-btn gnx-btn--danger", "삭제");
      delBtn.type = "button";
      delBtn.addEventListener("click", async () => {
        if (!window.confirm(`"${note.name}" 노트를 삭제할까요?\n모든 채팅방에서 사라집니다.`)) return;
        state.busy = true;
        try {
          await deleteNote(note.id);
          await loadNotes();
          await loadChatAttachment();
          // busy를 먼저 풀고 렌더해야 체크박스가 활성 상태로 그려진다
          state.busy = false;
          state.expandedIds.delete(note.id);
          toast("삭제했어요");
          render();
        } catch (err) {
          console.error("[글로벌 노트]", err);
          toast("삭제에 실패했어요", true);
        } finally {
          state.busy = false;
        }
      });
      btnRow.prepend(delBtn);
    }

    box.append(nameInput, contentWrap, modeBox, kwWrap, depthRow, btnRow);
    return box;
  }

  // ---------- 편집기 펼치기 ----------
  function openExpandedEditor(title, sourceTextarea) {
    const overlay = el("div", "gnx-expand-overlay");
    // 점 세개 메뉴가 오버레이 안 클릭을 "바깥"으로 오인해 닫히지 않도록 (패널과 동일)
    overlay.setAttribute("data-chat-floating-panel", "");
    const card = el("div", "gnx-expand-card");

    const head = el("div", "gnx-expand-head");
    head.append(el("div", "gnx-expand-title", title));
    const closeBtn = el("button", "gnx-icon-btn");
    closeBtn.type = "button";
    closeBtn.title = "닫기";
    closeBtn.setAttribute("aria-label", "편집기 닫기");
    closeBtn.innerHTML = SVG_X;
    head.append(closeBtn);

    const bigInput = document.createElement("textarea");
    bigInput.className = "gnx-input gnx-expand-textarea";
    bigInput.placeholder = "내용";
    bigInput.value = sourceTextarea.value;
    bigInput.addEventListener("input", () => {
      sourceTextarea.value = bigInput.value;
      sourceTextarea.dispatchEvent(new Event("input", { bubbles: false }));
    });

    const foot = el("div", "gnx-expand-foot");
    const tokenInfo = el("span", "gnx-token-line", `~${estTokens(bigInput.value)} 토큰`);
    bigInput.addEventListener("input", () => {
      tokenInfo.textContent = `~${estTokens(bigInput.value)} 토큰`;
    });
    const doneBtn = el("button", "gnx-btn gnx-btn--primary", "완료");
    doneBtn.type = "button";
    foot.append(tokenInfo, doneBtn);

    card.append(head, bigInput, foot);
    overlay.append(card);
    document.body.append(overlay);
    bigInput.focus();
    bigInput.setSelectionRange(bigInput.value.length, bigInput.value.length);

    const close = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    closeBtn.addEventListener("click", close);
    doneBtn.addEventListener("click", close);
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
  }

  // ---------- 노트 순서 드래그 ----------
  function startRowDrag(e, item) {
    if (state.busy || state.search.trim()) return;
    e.preventDefault();
    const list = item.parentElement; // .gnx-rows
    if (!list) return;
    const startOrder = [...list.querySelectorAll(".gnx-item[data-id]")].map((n) => n.dataset.id);
    item.classList.add("gnx-item--drag");

    const move = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = target && target.closest ? target.closest(".gnx-item[data-id]") : null;
      if (!over || over === item || over.parentElement !== list) return;
      const rect = over.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      list.insertBefore(item, before ? over : over.nextSibling);
    };
    const up = async () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      item.classList.remove("gnx-item--drag");
      const nextOrder = [...list.querySelectorAll(".gnx-item[data-id]")].map((n) => n.dataset.id);
      if (nextOrder.join("|") === startOrder.join("|")) return;
      state.busy = true;
      try {
        await reorderNotes(nextOrder);
        toast("순서를 저장했어요");
      } catch (err) {
        console.error("[글로벌 노트]", err);
        toast("순서 저장에 실패했어요", true);
        await loadNotes().catch(() => {});
      } finally {
        state.busy = false;
        render();
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ---------- 패널 ----------
  function positionPanel(anchorEl) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < 120 || vh < 120) return; // 창 크기를 아직 알 수 없는 상태
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    const width = Math.min(isMobile ? 300 : 340, vw - 24);
    panel.style.width = `${width}px`;
    let left, top, maxH;
    if (anchorEl && document.contains(anchorEl) && isMobile) {
      // 작가노트 모바일 패널과 같은 프레임: 점 세개 메뉴 왼쪽, 메뉴 상단 높이에서 시작
      const pad = 8;
      const rect = anchorEl.getBoundingClientRect();
      const overflowMenu = anchorEl.closest("[data-chat-toolbar-overflow-menu]");
      const menuRect = overflowMenu ? overflowMenu.getBoundingClientRect() : null;
      const rightEdge = menuRect ? menuRect.left - pad : rect.right;
      const mobileWidth = Math.min(300, vw - pad * 2, Math.max(160, rightEdge - pad));
      panel.style.width = `${mobileWidth}px`;
      left = clamp(rightEdge - mobileWidth, pad, vw - mobileWidth - pad);
      top = Math.max(pad, menuRect ? menuRect.top : rect.bottom + pad);
      maxH = Math.max(160, vh - top - pad);
    } else if (anchorEl && document.contains(anchorEl)) {
      const r = anchorEl.getBoundingClientRect();
      left = clamp(r.right - width, 12, vw - width - 12);
      top = clamp(r.bottom + 8, 12, vh - 220);
      maxH = vh - top - 16;
    } else {
      // 앵커를 잃었을 때의 안전 위치 (우상단)
      left = vw - width - 12;
      top = 64;
      maxH = vh - top - 16;
    }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    // 패널 전체 높이 상한: 화면이 아무리 커도 620px을 넘지 않는다
    panel.style.maxHeight = `${Math.min(620, Math.max(200, maxH))}px`;
  }

  async function openPanel(anchorEl) {
    state.panelOpen = true;
    lastAnchorEl = anchorEl || null;
    positionPanel(anchorEl || null);
    panel.classList.add("gnx-panel--open");
    listBox.replaceChildren(el("div", "gnx-empty", "불러오는 중…"));
    try {
      await ensureLorebook();
      await loadNotes();
      state.chatId = readActiveChatId();
      await loadChatAttachment();
      render();
    } catch (err) {
      console.error("[글로벌 노트]", err);
      listBox.replaceChildren(el("div", "gnx-empty", "불러오기에 실패했어요.\n콘솔을 확인해주세요."));
    }
  }

  function closePanel() {
    state.panelOpen = false;
    state.expandedIds.clear();
    state.composing = false;
    state.searchOpen = false;
    state.search = "";
    if (searchInput) searchInput.value = "";
    panel.classList.remove("gnx-panel--open");
  }

  /**
   * 모바일 키보드가 올라오면 "보이는 화면"(visualViewport)이 줄어든다.
   * 패널 높이를 보이는 화면 안으로 접어서, 가려진 입력칸을 내부 스크롤로
   * 볼 수 있게 한다. 키보드가 내려가면 원래 높이로 돌아온다.
   */
  function adjustPanelToViewport() {
    if (!state.panelOpen) return;
    const vv = window.visualViewport;
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const rect = panel.getBoundingClientRect();
    if (rect.height <= 0) return;
    const maxH = Math.min(620, Math.max(140, viewportBottom - rect.top - 8));
    panel.style.maxHeight = `${maxH}px`;
  }

  // ---------- 채팅방 메뉴 버튼 ----------
  /**
   * 앵커 버튼의 클래스를 복사하되 "눌린 상태" 표시는 세탁한다.
   * (작가노트에 내용이 있으면 그 버튼이 active 클래스를 달고 있는데,
   *  그대로 복사하면 우리 버튼도 항상 눌린 것처럼 보인다)
   */
  function cleanToolbarClass(className) {
    return className
      .replace(/marinara-chat-toolbar-button--(?:active|open)/g, "")
      .replace(
        /(?<!:)(border|bg|text)-\[var\(--marinara-chat-chrome-button-(border|bg|text)-(?:active|hover)\)\]/g,
        "$1-[var(--marinara-chat-chrome-button-$2)]",
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 현재 방에 연결된 노트가 있을 때만 버튼을 눌린 상태로 보여준다 (작가노트와 같은 규칙). */
  function applyButtonActiveState() {
    const on = state.buttonActive;
    document.querySelectorAll("[data-gnx-btn]").forEach((b) => {
      if (b.classList.contains("gnx-bubble")) {
        // 2.5.0+ 버블: 기본 채팅 버블과 똑같이 — 활성 표시 없음, 열림 여부만 접근성 속성으로
        b.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
        return;
      }
      // 2.4.x 이하 툴바 버튼
      b.classList.toggle("marinara-chat-toolbar-button--active", on);
      if (on) {
        b.style.background = "var(--marinara-chat-chrome-button-bg-active)";
        b.style.borderColor = "var(--marinara-chat-chrome-button-border-active)";
        b.style.color = "var(--marinara-chat-chrome-button-text-active)";
      } else {
        b.style.background = "";
        b.style.borderColor = "";
        b.style.color = "";
      }
    });
  }

  /** 패널을 열지 않고도 버튼 활성 상태를 알 수 있게, 방 메타의 로어북 연결 여부만 가볍게 조회 */
  async function refreshButtonActive() {
    // 2.5.0+ 버블은 활성 표시가 없으므로 방 메타를 조회할 필요가 없다
    if (findSettingsBubble()) {
      applyButtonActiveState();
      return;
    }
    const chatId = readActiveChatId();
    const lbId = state.lbId || localStorage.getItem(LB_ID_KEY);
    let on = false;
    if (chatId && lbId) {
      try {
        const chat = await api("GET", `/chats/${chatId}`);
        const meta = chat && typeof chat.metadata === "object" && chat.metadata ? chat.metadata : {};
        const active = Array.isArray(meta.activeLorebookIds) ? meta.activeLorebookIds : [];
        on = active.includes(lbId);
      } catch { /* 다음 기회에 */ }
    }
    state.buttonActive = on;
    applyButtonActiveState();
  }

  function makeToolbarButton(anchorBtn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cleanToolbarClass(anchorBtn.className); // 앱 툴바 버튼 스타일 상속 (눌림 상태 제외)
    btn.dataset.gnxBtn = "1";
    btn.title = "글로벌 노트";
    btn.setAttribute("aria-label", "글로벌 노트");
    btn.innerHTML = `<span class="gnx-tb-icon">${SVG_LOGO}</span>`;
    // 모바일 점 세개 메뉴가 우리 버튼 탭을 "메뉴 밖 클릭"으로 오인해 닫히지 않도록
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.panelOpen) closePanel();
      else void openPanel(btn);
    });
    return btn;
  }

  function removeToolbarButtons() {
    document.querySelectorAll("[data-gnx-btn]").forEach((b) => b.remove());
    bubbleEl = null;
    bubblePos = "";
  }

  /**
   * 앵커 버튼이 자체 래퍼 div에 감싸여 있으면 (작가노트/활성 컨텍스트 버튼이 그렇다)
   * 래퍼 안이 아니라 래퍼의 "형제"로 넣어야 툴바 가로줄에 나란히 선다.
   */
  function resolveInsertPoint(anchorBtn) {
    let ref = anchorBtn;
    let parent = anchorBtn.parentElement;
    if (parent && parent.parentElement && parent.childElementCount <= 2) {
      ref = parent;
      parent = parent.parentElement;
    }
    return { parent, ref };
  }

  function rowHasGnxButton(parent) {
    return [...parent.children].some((c) => c instanceof HTMLElement && c.dataset.gnxBtn === "1");
  }

  // ---------- 2.5.0+ 버블 버튼 ----------
  // 2.5.0부터 채팅 상단 버튼들이 "버블"(드래그 가능한 작은 버튼)로 바뀌고,
  // 작가노트·활성 컨텍스트는 "채팅 설정" 창 안의 섹션이 되어 앵커로 쓰던 버튼이 사라졌다.
  // 그래서 채팅 설정 버블([data-chat-settings-button]) 옆 빈 칸에 같은 모양의 버블을 둔다.
  // 앱 버블처럼 끌어서 옮길 수 있고, 놓은 자리는 기기별(데스크톱/폰)로 기억한다.
  // 채팅 설정 버블 위에 다시 올려놓으면 저장을 지우고 "자동 자리"(설정 버블 옆)로 돌아간다.
  const BUBBLE_POS_KEY = "gnx-bubble-pos";
  const BUBBLE_POS_PHONE_KEY = "gnx-bubble-pos-phone";
  let bubbleEl = null;
  let bubbleWatch = null; // 다른 버블들이 움직이면(style 변경) 우리 자리도 다시 계산
  const watchedBubbles = new WeakSet();
  let bubblePos = "";
  let bubbleDrag = null; // 드래그 중 상태
  let suppressBubbleClick = false; // 드래그를 끝내는 click이 패널을 열지 않도록

  function isVisible(node) {
    if (!(node instanceof HTMLElement) || !node.isConnected) return false;
    const r = node.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function findSettingsBubble() {
    return [...document.querySelectorAll(SETTINGS_BUBBLE_SEL)].find(isVisible) || null;
  }

  /** 저장 키: 방마다 따로 (활성 방 ID를 붙임). 방을 알 수 없으면 공통 키. */
  function bubblePosKey(phone) {
    const base = phone ? BUBBLE_POS_PHONE_KEY : BUBBLE_POS_KEY;
    const chatId = readActiveChatId();
    return chatId ? `${base}:${chatId}` : base;
  }

  function readSavedBubblePos(phone) {
    try {
      const v = JSON.parse(localStorage.getItem(bubblePosKey(phone)) || "null");
      return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
    } catch {
      return null;
    }
  }

  function saveBubblePos(phone, pos) {
    const key = bubblePosKey(phone);
    try {
      if (pos) localStorage.setItem(key, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
      else localStorage.removeItem(key);
    } catch {}
  }

  /** 버블이 다닐 수 있는 범위: 채팅 영역 안, 탑바 아래, 입력창·키보드 위 (앱의 버블 bounds와 같은 취지) */
  function readBubbleBounds() {
    const M = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const chatRoot = [...document.querySelectorAll("[data-chat-mode]")].find(isVisible);
    const area = chatRoot ? chatRoot.getBoundingClientRect() : { left: 0, right: vw, top: 0, bottom: vh };
    const topbar = document.querySelector('[data-component="TopBar"]');
    const composer = chatRoot ? chatRoot.querySelector("[data-chat-composer]") : null;
    const composerBox = composer
      ? composer.closest(".chat-input-container") || composer.closest("[data-chat-resource-drop-exclude]") || composer
      : null;
    const vv = window.visualViewport;
    const visibleBottom = vv ? vv.offsetTop + vv.height : vh;
    return {
      left: Math.max(0, area.left) + M,
      top: Math.max(0, topbar ? topbar.getBoundingClientRect().bottom : 0, area.top) + M,
      right: Math.min(vw, area.right) - M,
      bottom:
        Math.min(vh, visibleBottom, area.bottom, composerBox ? composerBox.getBoundingClientRect().top : Infinity) -
        M,
    };
  }

  function clampBubblePoint(x, y, b, size) {
    return {
      x: Math.min(Math.max(x, b.left), Math.max(b.left, b.right - size)),
      y: Math.min(Math.max(y, b.top), Math.max(b.top, b.bottom - size)),
    };
  }

  /** 화면에 보이는 다른 버블들의 rect (폰 점 세개 메뉴 안의 버튼은 제외) */
  function otherBubbleRects(self) {
    return [...document.querySelectorAll(BUBBLE_SEL)]
      .filter((node) => node !== self && !node.closest("[data-chat-tools-menu]") && isVisible(node))
      .map((node) => node.getBoundingClientRect());
  }

  const overlapsAny = (x, y, size, rects) =>
    rects.some((r) => x < r.right && x + size > r.left && y < r.bottom && y + size > r.top);

  /**
   * 드래그를 놓은 자리 정리: 가까운 버블과 줄·열을 맞추고(8px 안), 겹치면 그 버블 옆 빈 칸으로 비킨다.
   * 앱의 dropWindowBubble을 단순화한 것.
   */
  function dropBubblePoint(raw, size, others, bounds) {
    const S = 8;
    let { x, y } = raw;
    for (const r of others) {
      if (Math.abs(r.top - y) <= S) y = r.top;
      if (Math.abs(r.left - x) <= S) x = r.left;
      if (Math.abs(r.right + BUBBLE_GAP - x) <= S) x = r.right + BUBBLE_GAP;
      if (Math.abs(r.left - BUBBLE_GAP - size - x) <= S) x = r.left - BUBBLE_GAP - size;
    }
    ({ x, y } = clampBubblePoint(x, y, bounds, size));
    if (!overlapsAny(x, y, size, others)) return { x, y };
    // 겹치면: 겹친 버블의 왼쪽/오른쪽/아래 중 가장 가까운 빈 칸
    const hit = others.find((r) => x < r.right && x + size > r.left && y < r.bottom && y + size > r.top);
    const options = [
      { x: hit.left - BUBBLE_GAP - size, y: hit.top },
      { x: hit.right + BUBBLE_GAP, y: hit.top },
      { x: hit.left, y: hit.bottom + BUBBLE_GAP },
    ]
      .map((p) => clampBubblePoint(p.x, p.y, bounds, size))
      .filter((p) => !overlapsAny(p.x, p.y, size, others))
      .sort((a, b) => Math.hypot(a.x - raw.x, a.y - raw.y) - Math.hypot(b.x - raw.x, b.y - raw.y));
    return options[0] || { x, y };
  }

  function setBubbleStyle(btn, x, y) {
    btn.style.left = `${Math.round(x)}px`;
    btn.style.top = `${Math.round(y)}px`;
  }

  function makeBubble() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mari-window-bubble gnx-bubble";
    btn.dataset.gnxBtn = "1";
    btn.title = "글로벌 노트 (끌어서 옮기기)";
    btn.setAttribute("aria-label", "글로벌 노트");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      `<span class="mari-window-bubble__paint pointer-events-none" aria-hidden="true"></span>` +
      `<span class="mari-window-bubble__icon gnx-tb-icon">${SVG_LOGO}</span>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (suppressBubbleClick) {
        suppressBubbleClick = false;
        return;
      }
      if (state.panelOpen) closePanel();
      else void openPanel(btn);
    });

    // ── 드래그로 옮기기 (앱 WindowBubble과 같은 규칙: 조금 움직이면 드래그, 아니면 클릭) ──
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || bubbleDrag) return;
      const r = btn.getBoundingClientRect();
      bubbleDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: r.left,
        originY: r.top,
        size: Math.round(Math.max(r.width, r.height)) || 32,
        threshold: e.pointerType === "mouse" ? 4 : 10,
        moved: false,
        bounds: readBubbleBounds(),
        others: otherBubbleRects(btn),
      };
      try { btn.setPointerCapture(e.pointerId); } catch {}
    });
    btn.addEventListener("pointermove", (e) => {
      const d = bubbleDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < d.threshold) return;
      if (!d.moved) {
        d.moved = true;
        btn.dataset.dragging = "true";
        if (state.panelOpen) closePanel(); // 끌기 시작하면 패널은 접는다 (놓은 뒤 다시 열면 새 자리에 뜸)
      }
      const p = clampBubblePoint(d.originX + dx, d.originY + dy, d.bounds, d.size);
      setBubbleStyle(btn, p.x, p.y);
    });
    const endDrag = (e) => {
      const d = bubbleDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      bubbleDrag = null;
      delete btn.dataset.dragging;
      try { btn.releasePointerCapture(e.pointerId); } catch {}
      if (!d.moved) return; // 짧은 누름 → 이어지는 click이 패널을 토글
      // 드래그를 끝내는 click(터치는 조금 늦게 옴)은 무시
      suppressBubbleClick = true;
      setTimeout(() => { suppressBubbleClick = false; }, 400);
      if (e.type === "pointercancel") {
        scheduleScan();
        return;
      }
      const raw = clampBubblePoint(d.originX + e.clientX - d.startX, d.originY + e.clientY - d.startY, d.bounds, d.size);
      const phone = btn.dataset.presentation === "sheet";
      const settings = findSettingsBubble();
      if (settings) {
        // 채팅 설정 버블 위에 올려놓으면 "자동 자리"로 복귀
        const s = settings.getBoundingClientRect();
        const near =
          raw.x < s.right + BUBBLE_GAP && raw.x + d.size > s.left - BUBBLE_GAP &&
          raw.y < s.bottom + BUBBLE_GAP && raw.y + d.size > s.top - BUBBLE_GAP;
        if (near) {
          saveBubblePos(phone, null);
          toast("채팅 설정 옆 자리로 되돌렸어요");
          scanToolbars();
          return;
        }
      }
      saveBubblePos(phone, dropBubblePoint(raw, d.size, d.others, d.bounds));
      scanToolbars();
    };
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);
    btn.addEventListener("touchend", (e) => {
      // 터치 드래그 뒤 브라우저가 만들어 내는 click 차단 (앱 버블과 같은 처리)
      if (suppressBubbleClick && e.cancelable) e.preventDefault();
    });

    // 방향키로 옮기기 (Shift = 크게)
    btn.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 32 : 8;
      const delta =
        e.key === "ArrowLeft" ? [-step, 0] :
        e.key === "ArrowRight" ? [step, 0] :
        e.key === "ArrowUp" ? [0, -step] :
        e.key === "ArrowDown" ? [0, step] : null;
      if (!delta) return;
      e.preventDefault();
      const r = btn.getBoundingClientRect();
      const size = Math.round(Math.max(r.width, r.height)) || 32;
      const p = clampBubblePoint(r.left + delta[0], r.top + delta[1], readBubbleBounds(), size);
      saveBubblePos(btn.dataset.presentation === "sheet", p);
      scanToolbars();
    });
    return btn;
  }

  function watchBubbles() {
    if (!bubbleWatch) {
      bubbleWatch = new MutationObserver(() => scheduleScan());
      cleanupFns.push(() => bubbleWatch.disconnect());
    }
    for (const node of document.querySelectorAll(BUBBLE_SEL)) {
      if (node === bubbleEl || watchedBubbles.has(node)) continue;
      watchedBubbles.add(node);
      bubbleWatch.observe(node, { attributes: true, attributeFilter: ["style", "data-presentation", "hidden"] });
    }
  }

  /**
   * 채팅 설정 버블 옆의 빈 칸을 찾아 우리 버블을 놓는다.
   * 후보 순서: 설정 버블 왼쪽으로 한 칸씩 → 오른쪽 한 칸 → 아랫줄.
   * 앱과 같은 규칙으로 가로줄은 채팅 영역의 오른쪽 절반만 쓴다(게임 지도 자리 보호).
   * @returns {boolean} 2.5.0+ UI를 찾았는지
   */
  function placeBubble() {
    const settings = findSettingsBubble();
    if (!settings) {
      if (bubbleEl) bubbleEl.style.display = "none";
      return false;
    }
    if (!bubbleEl) bubbleEl = makeBubble();
    const btn = bubbleEl;
    if (!btn.isConnected) document.body.append(btn);
    const phone = settings.dataset.presentation === "sheet";
    if (phone) btn.dataset.presentation = "sheet";
    else delete btn.dataset.presentation;
    btn.style.display = "";
    const z = getComputedStyle(settings).zIndex;
    btn.style.zIndex = z && z !== "auto" ? z : phone ? "44" : "70";

    watchBubbles();
    if (bubbleDrag) return true; // 끌고 있는 동안은 자리를 건드리지 않는다

    const sRect = settings.getBoundingClientRect();
    const size = Math.round(Math.max(sRect.width, sRect.height)) || (phone ? 36 : 32);
    const bounds = readBubbleBounds();
    const saved = readSavedBubblePos(phone);
    let pos;
    if (saved) {
      // 사용자가 옮겨 둔 자리 (화면 밖으로 나가지 않게만 조정)
      const p = clampBubblePoint(saved.x, saved.y, bounds, size);
      pos = [p.x, p.y];
    } else {
      // 자동 자리: 채팅 설정 버블 옆 빈 칸
      const step = size + BUBBLE_GAP;
      const vw = window.innerWidth;
      const chatRoot = [...document.querySelectorAll("[data-chat-mode]")].find(isVisible);
      const area = chatRoot ? chatRoot.getBoundingClientRect() : { left: 0, right: vw };
      const areaLeft = Math.max(0, area.left);
      const areaRight = Math.min(vw, area.right);
      const leftLimit = Math.round((areaLeft + areaRight - size) / 2) + size + BUBBLE_GAP;
      const others = otherBubbleRects(btn);
      const inBounds = (x, y) => x >= areaLeft && x + size <= areaRight && y >= 0 && y + size <= window.innerHeight;
      const free = (x, y) => inBounds(x, y) && !overlapsAny(x, y, size, others);
      const candidates = [];
      for (let k = 1; k <= 8; k++) candidates.push([sRect.left - k * step, sRect.top]);
      candidates.push([sRect.left + step, sRect.top]);
      for (let k = 0; k <= 8; k++) candidates.push([sRect.left - k * step, sRect.top + step]);
      pos =
        candidates.find(([x, y]) => (x >= leftLimit || y > sRect.top) && free(x, y)) ||
        candidates.find(([x, y]) => free(x, y)) ||
        [Math.max(areaLeft, sRect.left - step), sRect.top];
    }

    const left = `${Math.round(pos[0])}px`;
    const top = `${Math.round(pos[1])}px`;
    const moved = bubblePos !== `${left}|${top}`;
    bubblePos = `${left}|${top}`;
    btn.style.left = left;
    btn.style.top = top;

    // 버튼이 옮겨졌고 패널이 그 버튼에 매달려 있으면 패널도 따라간다 (입력 중엔 제외)
    if (moved && state.panelOpen && lastAnchorEl === btn) {
      const active = document.activeElement;
      if (!(active && panel.contains(active))) positionPanel(btn);
    }
    return true;
  }

  // 메뉴 버튼 주입 감시 (50ms 디바운스) — MutationObserver·버블 이동·리사이즈가 모두 여기로 모인다
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanToolbars();
    }, 50);
  }

  function scanToolbars() {
    if (placeBubble()) {
      // 2.5.0+: 혹시 남아 있는 구형 툴바 버튼 정리
      document.querySelectorAll("[data-gnx-btn]:not(.gnx-bubble)").forEach((b) => b.remove());
    } else {
      scanLegacyToolbars();
    }
    applyButtonActiveState();
  }

  /** 2.4.x 이하: 작가노트 버튼 왼쪽(롤플레이) / 활성 컨텍스트 오른쪽(대화)에 툴바 버튼 주입 */
  function scanLegacyToolbars() {
    // 화면 전환으로 규칙이 바뀌었을 때 잘못된 자리에 남은 버튼 정리
    if (document.querySelector(AUTHOR_BTN_SEL)) {
      document.querySelectorAll("[data-gnx-btn]").forEach((b) => {
        if (!b.parentElement || !b.parentElement.querySelector(AUTHOR_BTN_SEL)) b.remove();
      });
    }
    // 롤플레이: 작가노트 버튼 왼쪽
    for (const authorBtn of document.querySelectorAll(AUTHOR_BTN_SEL)) {
      const { parent, ref } = resolveInsertPoint(authorBtn);
      if (!parent || rowHasGnxButton(parent)) continue;
      parent.insertBefore(makeToolbarButton(authorBtn), ref);
    }
    // 대화(콘보): 작가노트 버튼이 화면에 없을 때만 활성 컨텍스트 오른쪽에 넣는다.
    // (롤플레이 화면에는 둘 다 있어서, 여기서도 넣으면 중복이 된다)
    if (document.querySelector(AUTHOR_BTN_SEL) === null) {
      for (const ctxBtn of document.querySelectorAll(CTX_BTN_SEL)) {
        const { parent, ref } = resolveInsertPoint(ctxBtn);
        if (!parent || rowHasGnxButton(parent)) continue;
        parent.insertBefore(makeToolbarButton(ctxBtn), ref.nextSibling);
      }
    }
  }

  // ---------- 마운트 ----------
  function mount() {
    // 패널 — data-chat-floating-panel: 앱(점 세개 메뉴 등)이 이 패널 안 클릭을
    // "바깥 클릭"으로 오인해 닫아버리지 않도록 하는 표식 (작가노트 패널과 같은 방식)
    panel = el("div", "gnx-panel");
    panel.setAttribute("data-chat-floating-panel", "");

    const header = el("div", "gnx-header");
    const titleWrap = el("div", "gnx-title-wrap");
    const title = el("div", "gnx-title");
    title.innerHTML = `${SVG_LOGO}<span>글로벌 노트</span>`;
    subtitleEl = el("div", "gnx-subtitle", "");
    titleWrap.append(title, subtitleEl);

    const searchBtn = el("button", "gnx-icon-btn");
    searchBtn.type = "button";
    searchBtn.title = "노트 검색";
    searchBtn.setAttribute("aria-label", "노트 검색");
    searchBtn.innerHTML = SVG_SEARCH;
    searchBtn.addEventListener("click", () => {
      state.searchOpen = !state.searchOpen;
      if (!state.searchOpen) {
        state.search = "";
        searchInput.value = "";
      }
      render();
      if (state.searchOpen) searchInput.focus();
    });

    const closeBtn = el("button", "gnx-icon-btn");
    closeBtn.type = "button";
    closeBtn.title = "닫기";
    closeBtn.setAttribute("aria-label", "닫기");
    closeBtn.innerHTML = SVG_X;
    closeBtn.addEventListener("click", closePanel);

    header.append(titleWrap, searchBtn, closeBtn);

    searchRow = el("div", "gnx-search-row");
    searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "gnx-input gnx-search-input";
    searchInput.placeholder = "이름이나 내용으로 검색…";
    searchInput.setAttribute("autocomplete", "off");
    searchInput.addEventListener("input", () => {
      state.search = searchInput.value;
      render();
    });
    searchRow.append(searchInput);
    searchRow.style.display = "none";

    listBox = el("div", "gnx-list");

    // 새 노트 버튼: 목록이 길어도 항상 보이도록 스크롤 밖 하단에 고정
    addBar = el("div", "gnx-add-bar");
    const addBtn = el("button", "gnx-add");
    addBtn.type = "button";
    addBtn.innerHTML = `${SVG_PLUS}<span>새 노트</span>`;
    addBtn.addEventListener("click", () => {
      state.composing = true;
      render();
      // 자동 포커스는 하지 않는다 — 모바일에서 키보드가 바로 튀어나와 불편함.
      // 대신 새 에디터가 화면에 들어오도록만 스크롤한다.
      const item = listBox.querySelector(".gnx-item--new");
      if (item) { try { item.scrollIntoView({ block: "nearest" }); } catch {} }
    });
    addBar.append(addBtn);

    panel.append(header, searchRow, listBox, addBar);
    document.body.append(panel);

    // 바깥 클릭으로 닫기
    const onPointerDown = (e) => {
      if (!state.panelOpen) return;
      if (panel.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-gnx-btn], .gnx-expand-overlay")) return;
      closePanel();
    };
    document.addEventListener("pointerdown", onPointerDown);
    cleanupFns.push(() => document.removeEventListener("pointerdown", onPointerDown));

    const onResize = () => {
      scheduleScan(); // 버블 자리 다시 계산
      if (!state.panelOpen) return;
      // 모바일 키보드가 열리면 리사이즈가 발생하는데, 이때 재배치하면 입력 중에
      // 패널이 점프한다. 패널 안에 포커스가 있는 동안은 "위치"는 고정하고
      // "높이"만 보이는 화면에 맞춘다.
      const active = document.activeElement;
      const focusInside = !!active && panel.contains(active);
      if (!focusInside && !(lastAnchorEl && !document.contains(lastAnchorEl))) {
        positionPanel(lastAnchorEl);
      }
      adjustPanelToViewport();
    };
    window.addEventListener("resize", onResize);
    cleanupFns.push(() => window.removeEventListener("resize", onResize));

    // 키보드 개폐는 window resize 없이 visualViewport만 변할 때도 있다.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      vv.addEventListener("resize", adjustPanelToViewport);
      vv.addEventListener("scroll", adjustPanelToViewport);
      cleanupFns.push(() => {
        vv.removeEventListener("resize", adjustPanelToViewport);
        vv.removeEventListener("scroll", adjustPanelToViewport);
      });
    }

    // 입력칸에 포커스가 가면 (키보드 애니메이션 후) 그 칸이 보이도록 스크롤
    const onFocusIn = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      setTimeout(() => {
        adjustPanelToViewport();
        try { target.scrollIntoView({ block: "nearest" }); } catch {}
      }, 300);
    };
    panel.addEventListener("focusin", onFocusIn);
    cleanupFns.push(() => panel.removeEventListener("focusin", onFocusIn));

    // 활성 채팅방 변경 감시
    const pollTimer = setInterval(async () => {
      const nextChatId = readActiveChatId();
      if (nextChatId === state.chatId) return;
      state.chatId = nextChatId;
      scheduleScan(); // 방마다 기억한 버블 자리로 옮기기
      if (state.panelOpen && !state.busy && state.expandedIds.size === 0 && !state.composing) {
        try {
          await loadChatAttachment();
          render();
        } catch { /* 다음 폴링에서 재시도 */ }
      } else {
        void refreshButtonActive();
      }
    }, POLL_MS);
    cleanupFns.push(() => clearInterval(pollTimer));

    // 메뉴 버튼 주입 감시
    //  - MutationObserver: 점 세개 메뉴가 열리는 "순간" DOM에 생기므로 즉시 주입 (모바일 딜레이 제거)
    //  - 백업 타이머: 혹시 옵저버가 놓친 경우를 위한 안전망
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 우리 버튼 자신의 삽입으로 인한 재귀 스캔은 건너뛴다
          if (node instanceof HTMLElement && node.dataset.gnxBtn === "1") continue;
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    cleanupFns.push(() => observer.disconnect());
    const scanTimer = setInterval(scanToolbars, SCAN_MS);
    cleanupFns.push(() => clearInterval(scanTimer));
    scanToolbars();
    state.chatId = readActiveChatId();
    void refreshButtonActive();

    cleanupFns.push(() => {
      removeToolbarButtons();
      panel.remove();
      document.querySelectorAll(".gnx-toast, .gnx-expand-overlay").forEach((n) => n.remove());
    });
  }

  function cleanupAll() {
    for (const fn of cleanupFns.splice(0).reverse()) {
      try { fn(); } catch {}
    }
  }

  try {
    if (typeof marinara !== "undefined" && marinara && typeof marinara.onCleanup === "function") {
      marinara.onCleanup(cleanupAll);
    }
  } catch {}

  mount();
  console.info("[글로벌 노트] v1.4.5 로드 완료");
})();
