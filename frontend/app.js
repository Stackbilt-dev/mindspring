/* MindSpring — Frontend Application */

(() => {
  'use strict';

  // ── Config ──────────────────────────────────

  const API_BASE = localStorage.getItem('ms_api_url') || '';
  const STORE_KEY = 'ms_api_key';

  function getApiKey() { return localStorage.getItem(STORE_KEY) || ''; }
  function setApiKey(key) { localStorage.setItem(STORE_KEY, key); }

  async function api(path, opts = {}) {
    const key = getApiKey();
    if (!key && !path.startsWith('/')) throw new Error('API key not configured');

    const url = API_BASE + path;
    const headers = { ...opts.headers };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(url, { ...opts, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Icons (inline SVGs) ─────────────────────

  const icons = {
    search: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    upload: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
    back: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>`,
    file: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    cloud: `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
    logo: `<svg width="28" height="28" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" stroke="#CE9D73" stroke-width="1.5"/><circle cx="16" cy="16" r="6" fill="#A86CFB" opacity="0.8"/><circle cx="16" cy="16" r="2" fill="#E8E0D6"/><line x1="16" y1="2" x2="16" y2="10" stroke="#26C6DA" stroke-width="1" opacity="0.5"/><line x1="16" y1="22" x2="16" y2="30" stroke="#26C6DA" stroke-width="1" opacity="0.5"/><line x1="2" y1="16" x2="10" y2="16" stroke="#26C6DA" stroke-width="1" opacity="0.5"/><line x1="22" y1="16" x2="30" y2="16" stroke="#26C6DA" stroke-width="1" opacity="0.5"/></svg>`,
    empty: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6" opacity="0.4"/></svg>`,
  };

  // ── State ───────────────────────────────────

  let currentPage = 'search';
  let searchResults = [];
  let currentConversation = null;
  let uploadStatus = null;
  let chatHistory = [];
  let chatLoading = false;

  // ── Router ──────────────────────────────────

  function navigate(page, data) {
    currentPage = page;
    if (data) {
      if (page === 'detail') currentConversation = data;
    }
    render();
  }

  // ── Rendering ───────────────────────────────

  let lastRenderedPage = null;

  function render() {
    const main = document.getElementById('app-main');
    const navBtns = document.querySelectorAll('.nav-btn');
    navBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === currentPage);
    });

    // For search: update results without destroying the input
    if (currentPage === 'search' && lastRenderedPage === 'search') {
      const container = document.getElementById('search-results');
      if (container) {
        container.innerHTML = renderSearchResults();
        bindResultCardClicks();
        lastRenderedPage = currentPage;
        return;
      }
    }

    lastRenderedPage = currentPage;
    switch (currentPage) {
      case 'search': main.innerHTML = renderSearchPage(); bindSearchEvents(); break;
      case 'chat': main.innerHTML = renderChatPage(); bindChatEvents(); break;
      case 'upload': main.innerHTML = renderUploadPage(); bindUploadEvents(); break;
      case 'settings': main.innerHTML = renderSettingsPage(); bindSettingsEvents(); break;
      case 'detail': main.innerHTML = renderDetailPage(); bindDetailEvents(); break;
    }
  }

  // ── Search Page ─────────────────────────────

  function renderSearchResults() {
    if (searchResults.length > 0) {
      return `<div class="search-meta">
           <span class="search-count"><strong>${searchResults.length}</strong> conversations found</span>
         </div>
         <div class="results-list">${searchResults.map(renderResultCard).join('')}</div>`;
    }
    if (searchResults._searched) {
      return `<div class="empty-state"><p>No conversations matched your query.</p><p class="hint">Try different keywords or lower the similarity threshold.</p></div>`;
    }
    return `<div class="empty-state">${icons.empty}<p>Search your conversation history</p><p class="hint">Upload a ChatGPT or Claude export to get started</p></div>`;
  }

  function renderSearchPage() {
    return `
      <div class="search-hero">
        <h1>Navigate your <span class="accent">mind</span></h1>
        <p>Semantic search across your AI conversation history</p>
        <div class="search-container">
          <input type="text" class="search-input" id="search-input"
                 placeholder="What were we talking about..."
                 value="${escapeAttr(searchResults._query || '')}" />
          <span class="search-icon">${icons.search}</span>
        </div>
      </div>
      <div id="search-results">${renderSearchResults()}</div>`;
  }

  function renderResultCard(r, i) {
    const scorePercent = Math.round(r.score * 100);
    const preview = stripPrefix(r.text).slice(0, 280);
    const date = formatDate(r.create_time);

    return `
      <div class="result-card" data-id="${escapeAttr(r.id)}" style="animation-delay: ${i * 60}ms">
        <div class="result-header">
          <div class="result-title">${escapeHTML(r.title)}</div>
          <div class="result-score">
            <div class="score-bar"><div class="score-bar-fill" style="width: ${scorePercent}%"></div></div>
            <span class="score-value">.${String(scorePercent).padStart(2, '0')}</span>
          </div>
        </div>
        <div class="result-preview">${escapeHTML(preview)}</div>
        <div class="result-meta">
          <span class="meta-badge ${r.source || 'gpt'}">${r.source || 'gpt'}</span>
          <span class="meta-date">${date}</span>
        </div>
      </div>`;
  }

  function bindResultCardClicks() {
    document.querySelectorAll('.result-card').forEach(card => {
      card.addEventListener('click', () => openConversation(card.dataset.id));
    });
  }

  function bindSearchEvents() {
    const input = document.getElementById('search-input');
    if (!input) return;

    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => doSearch(input.value), 400);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(debounce); doSearch(input.value); }
    });

    // Focus on load
    setTimeout(() => input.focus(), 100);

    bindResultCardClicks();
  }

  async function doSearch(query) {
    if (!query.trim()) {
      searchResults = [];
      searchResults._query = '';
      render();
      return;
    }

    if (!getApiKey()) { toast('Configure your API key in Settings', 'error'); return; }

    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&limit=20&threshold=0.2`);
      searchResults = data.results;
      searchResults._searched = true;
      searchResults._query = query;
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openConversation(id) {
    try {
      const data = await api(`/api/conversations/${id}`);
      navigate('detail', data);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ── Chat Page (RAG) ────────────────────────

  function renderChatMessage(msg) {
    const isUser = msg.role === 'user';
    const sourcesHTML = msg.sources?.length
      ? `<div class="chat-sources">
           <span class="chat-sources-label">Sources:</span>
           ${msg.sources.map(s =>
             `<a href="#" class="chat-source-link" data-id="${escapeAttr(s.id)}">${escapeHTML(s.title)} <span class="score-value">.${String(Math.round(s.score * 100)).padStart(2, '0')}</span></a>`
           ).join('')}
         </div>`
      : '';

    const formattedContent = isUser
      ? escapeHTML(msg.content)
      : formatAssistantContent(msg.content);

    return `
      <div class="chat-message ${isUser ? 'chat-user' : 'chat-assistant'}">
        <div class="chat-message-role">${isUser ? 'You' : 'MindSpring'}</div>
        <div class="chat-message-content">${formattedContent}</div>
        ${sourcesHTML}
      </div>`;
  }

  function renderChatPage() {
    const messagesHTML = chatHistory.length > 0
      ? chatHistory.map(renderChatMessage).join('')
      : `<div class="chat-empty">
           <div class="chat-empty-icon">${icons.logo}</div>
           <h3>Ask your conversation history</h3>
           <p>MindSpring uses reasoning to analyze patterns across your conversations and surface insights you might have missed.</p>
           <div class="chat-suggestions">
             <button class="chat-suggestion" data-q="What recurring themes appear across my conversations?">Recurring themes</button>
             <button class="chat-suggestion" data-q="How has my thinking evolved over time?">Thinking evolution</button>
             <button class="chat-suggestion" data-q="What are the most important decisions I've discussed?">Key decisions</button>
             <button class="chat-suggestion" data-q="What topics do I keep coming back to?">Recurring topics</button>
           </div>
         </div>`;

    const loadingHTML = chatLoading
      ? `<div class="chat-message chat-assistant chat-loading">
           <div class="chat-message-role">MindSpring</div>
           <div class="chat-message-content"><span class="chat-thinking">Reasoning across your conversations...</span></div>
         </div>`
      : '';

    return `
      <div class="chat-page">
        <div class="chat-messages" id="chat-messages">
          ${messagesHTML}
          ${loadingHTML}
        </div>
        <div class="chat-input-area">
          <div class="chat-input-container">
            <textarea class="chat-input" id="chat-input"
                      placeholder="Ask about your conversation history..."
                      rows="1"
                      ${chatLoading ? 'disabled' : ''}></textarea>
            <button class="chat-send-btn" id="chat-send" ${chatLoading ? 'disabled' : ''}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
          <div class="chat-input-hint">DeepSeek R1 reasoning model — analyzes across all your indexed conversations</div>
        </div>
      </div>`;
  }

  function bindChatEvents() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    if (!input || !sendBtn) return;

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(input.value);
      }
    });

    sendBtn.addEventListener('click', () => sendChatMessage(input.value));

    // Suggestion buttons
    document.querySelectorAll('.chat-suggestion').forEach(btn => {
      btn.addEventListener('click', () => sendChatMessage(btn.dataset.q));
    });

    // Source links
    document.querySelectorAll('.chat-source-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        openConversation(link.dataset.id);
      });
    });

    // Scroll to bottom
    const messages = document.getElementById('chat-messages');
    if (messages) messages.scrollTop = messages.scrollHeight;

    // Focus input
    setTimeout(() => input.focus(), 100);
  }

  async function sendChatMessage(text) {
    if (!text?.trim() || chatLoading) return;
    if (!getApiKey()) { toast('Configure your API key in Settings first', 'error'); return; }

    const question = text.trim();

    // Add user message to history
    chatHistory.push({ role: 'user', content: question });
    chatLoading = true;
    lastRenderedPage = null; // Force full re-render
    render();

    try {
      const apiHistory = chatHistory
        .filter(m => !m.sources)
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question, history: apiHistory.slice(0, -1) }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Chat failed (HTTP ${res.status})`);

      chatHistory.push({
        role: 'assistant',
        content: data.answer,
        sources: data.sources || [],
      });
    } catch (err) {
      chatHistory.push({
        role: 'assistant',
        content: `Error: ${err.message}`,
        sources: [],
      });
      toast(err.message, 'error');
    }

    chatLoading = false;
    lastRenderedPage = null;
    render();
  }

  // ── Detail Page ─────────────────────────────

  function renderDetailPage() {
    if (!currentConversation) return '<p>No conversation selected.</p>';
    const c = currentConversation;
    const messages = parseMessages(c.text);
    const date = formatDate(c.create_time);

    return `
      <div class="detail-page">
        <button class="detail-back" id="detail-back">${icons.back} Back to search</button>
        <h1 class="detail-title">${escapeHTML(c.title)}</h1>
        <div class="detail-meta-bar">
          <span class="meta-badge ${c.source || 'gpt'}">${c.source || 'gpt'}</span>
          <span class="meta-date">${date}</span>
        </div>
        <div class="detail-content">
          ${messages.map(m => `
            <div class="message-block ${m.role === 'assistant' ? 'assistant' : 'user'}">
              <span class="message-role">${escapeHTML(m.role)}</span>
              ${escapeHTML(m.content)}
            </div>
          `).join('')}
        </div>
        <div class="similar-section">
          <h3>Similar Conversations</h3>
          <div id="similar-list"><div class="loading-spinner"></div></div>
        </div>
      </div>`;
  }

  function bindDetailEvents() {
    document.getElementById('detail-back')?.addEventListener('click', () => navigate('search'));
    loadSimilar();
  }

  async function loadSimilar() {
    if (!currentConversation) return;
    try {
      const data = await api(`/api/conversations/${currentConversation.id}/similar?limit=4`);
      const container = document.getElementById('similar-list');
      if (!container) return;

      if (data.results.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No similar conversations found.</p></div>';
        return;
      }

      container.innerHTML = `<div class="results-list">${data.results.map(renderResultCard).join('')}</div>`;
      container.querySelectorAll('.result-card').forEach(card => {
        card.addEventListener('click', () => openConversation(card.dataset.id));
      });
    } catch {
      document.getElementById('similar-list').innerHTML = '';
    }
  }

  // ── Upload Page ─────────────────────────────

  function renderUploadPage() {
    const progressHTML = uploadStatus ? renderUploadProgress() : '';
    const hasKey = !!getApiKey();
    const keyWarning = hasKey ? '' : `
      <div style="background: var(--danger-dim); border: 1px solid var(--danger); border-radius: var(--radius-md); padding: var(--space-md) var(--space-lg); margin-bottom: var(--space-lg); color: var(--danger); font-size: 0.9rem;">
        <strong>API key required.</strong> Go to <a href="#" onclick="event.preventDefault(); window._msNavigate('settings');" style="color: var(--tan); text-decoration: underline;">Settings</a> and enter your API key before uploading.
      </div>`;

    return `
      <div class="upload-page">
        <h2>Upload Conversations</h2>
        <p>Import your ChatGPT or Claude conversation export. Supports JSON arrays and objects up to 1GB.</p>
        ${keyWarning}
        <div class="upload-zone ${hasKey ? '' : 'disabled'}" id="upload-zone">
          <input type="file" accept=".json" class="upload-file-input" id="upload-input" />
          <div class="upload-zone-icon">${icons.cloud}</div>
          <div class="upload-zone-text">
            <strong>Drop your file here</strong> or click to browse
          </div>
          <div class="upload-zone-hint">conversations.json / claude_export.json</div>
        </div>
        ${progressHTML}
      </div>`;
  }

  function renderUploadProgress() {
    const s = uploadStatus;
    const uploadPct = s.uploadProgress || 0;
    const pct = s.status === 'uploading' ? uploadPct
      : s.totalConversations
        ? Math.round((s.processedConversations / s.totalConversations) * 100)
        : s.status === 'completed' ? 100 : 0;
    const indeterminate = s.status === 'processing' && !s.totalConversations;

    const statusColor = s.status === 'completed' ? 'completed'
      : s.status === 'failed' ? 'failed'
      : s.status === 'uploading' ? 'processing' : 'processing';

    const statusText = s.status === 'uploading'
      ? `Uploading ${escapeHTML(s.fileName)}... ${uploadPct}%`
      : s.status === 'completed'
        ? `Indexed ${s.totalConversations ?? s.processedConversations} conversations`
        : s.status === 'failed'
          ? `Failed: ${s.errorMessage || 'Unknown error'}`
          : `Processing... ${s.processedConversations} conversations`;

    return `
      <div class="upload-progress">
        <div class="progress-file">
          <span class="progress-file-icon">${icons.file}</span>
          <div class="progress-file-info">
            <div class="progress-file-name">${escapeHTML(s.fileName)}</div>
            <div class="progress-file-size">${formatBytes(s.fileSize)}</div>
          </div>
        </div>
        <div class="progress-bar-container">
          <div class="progress-bar-fill ${indeterminate ? 'indeterminate' : ''}" style="width: ${indeterminate ? '100%' : pct + '%'}"></div>
        </div>
        <div class="progress-status">
          <span class="status-dot ${statusColor}"></span>
          <span>${statusText}</span>
        </div>
      </div>`;
  }

  function bindUploadEvents() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('upload-input');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]);
    });

    input.addEventListener('change', () => {
      if (input.files[0]) handleUpload(input.files[0]);
    });
  }

  const SIMPLE_MAX = 5 * 1024 * 1024;       // 5MB — simple upload limit
  const CHUNK_SIZE  = 50 * 1024 * 1024;      // 50MB per part (well under CF 100MB body limit)

  async function handleUpload(file) {
    if (!getApiKey()) { toast('Configure your API key in Settings first', 'error'); return; }
    if (!file.name.endsWith('.json')) { toast('Please upload a .json file', 'error'); return; }

    // Show immediate uploading state
    uploadStatus = {
      uploadId: null,
      fileName: file.name,
      fileSize: file.size,
      status: 'uploading',
      processedConversations: 0,
      totalConversations: null,
      uploadProgress: 0,
    };
    render();

    try {
      if (file.size <= SIMPLE_MAX) {
        await handleSimpleUpload(file);
      } else {
        await handleMultipartUpload(file);
      }
    } catch (err) {
      uploadStatus = { ...uploadStatus, status: 'failed', errorMessage: err.message };
      render();
      toast(err.message, 'error');
    }
  }

  async function handleSimpleUpload(file) {
    const key = getApiKey();
    toast(`Uploading ${file.name} (${formatBytes(file.size)})...`, 'info');

    const res = await fetch(API_BASE + '/api/uploads/simple', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': file.name,
      },
      body: file,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);

    toast('Upload complete — ingestion started', 'success');
    uploadStatus = {
      ...uploadStatus,
      uploadId: data.uploadId,
      status: 'processing',
      uploadProgress: 100,
    };
    render();
    pollIngestion(data.uploadId);
  }

  async function handleMultipartUpload(file) {
    const key = getApiKey();
    const totalParts = Math.ceil(file.size / CHUNK_SIZE);
    toast(`Uploading ${file.name} (${formatBytes(file.size)}) in ${totalParts} parts...`, 'info');

    // 1. Initiate multipart upload
    const initRes = await fetch(API_BASE + '/api/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
    });

    const initData = await initRes.json();
    if (!initRes.ok) throw new Error(initData.error || 'Failed to initiate upload');

    const { uploadId, multipartUploadId } = initData;
    uploadStatus.uploadId = uploadId;

    // 2. Upload parts sequentially
    const uploadedParts = [];
    for (let i = 0; i < totalParts; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const partNumber = i + 1;

      const partRes = await fetch(
        API_BASE + `/api/uploads/${uploadId}/part?partNumber=${partNumber}&multipartUploadId=${encodeURIComponent(multipartUploadId)}`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}` },
          body: chunk,
        }
      );

      const partData = await partRes.json();
      if (!partRes.ok) throw new Error(partData.error || `Part ${partNumber} failed`);

      uploadedParts.push({ partNumber, etag: partData.etag });

      // Update progress
      uploadStatus.uploadProgress = Math.round((partNumber / totalParts) * 100);
      render();
    }

    // 3. Complete multipart upload
    const completeRes = await fetch(API_BASE + `/api/uploads/${uploadId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ multipartUploadId, parts: uploadedParts }),
    });

    const completeData = await completeRes.json();
    if (!completeRes.ok) throw new Error(completeData.error || 'Failed to finalize upload');

    toast('Upload complete — ingestion started', 'success');
    uploadStatus = {
      ...uploadStatus,
      status: 'processing',
      uploadProgress: 100,
    };
    render();
    pollIngestion(uploadId);
  }

  async function pollIngestion(uploadId) {
    const poll = async () => {
      try {
        const data = await api(`/api/uploads/${uploadId}/status`);
        uploadStatus = { ...uploadStatus, ...data };
        render();

        if (data.status === 'processing' || data.status === 'uploading') {
          setTimeout(poll, 5000);
        } else if (data.status === 'completed') {
          toast(`Indexed ${data.totalConversations ?? data.processedConversations} conversations`, 'success');
        } else if (data.status === 'failed') {
          toast(`Ingestion failed: ${data.errorMessage || 'Unknown error'}`, 'error');
        }
      } catch {
        setTimeout(poll, 10000);
      }
    };

    setTimeout(poll, 3000);
  }

  // ── Settings Page ───────────────────────────

  function renderSettingsPage() {
    const key = getApiKey();
    const masked = key ? key.slice(0, 10) + '...' + key.slice(-4) : '';

    return `
      <div class="settings-page">
        <div class="settings-section">
          <h2>API Connection</h2>
          <p>Enter your MindSpring API key to connect. Keys are stored locally in your browser.</p>
          <div class="api-key-input-row">
            <input type="password" class="input-field" id="api-key-input"
                   placeholder="ms_..." value="${escapeAttr(key)}" />
            <button class="btn btn-primary" id="save-key-btn">Save</button>
          </div>
          ${key ? `<p style="color: var(--text-muted); font-family: var(--font-mono); font-size: 0.8rem;">Active: ${masked}</p>` : ''}
        </div>

        <div class="settings-section">
          <h2>API Endpoint</h2>
          <p>Base URL for the MindSpring Worker. Leave empty for same-origin deployment.</p>
          <div class="api-key-input-row">
            <input type="text" class="input-field" id="api-url-input"
                   placeholder="https://mindspring.example.workers.dev"
                   value="${escapeAttr(localStorage.getItem('ms_api_url') || '')}" />
            <button class="btn btn-ghost" id="save-url-btn">Save</button>
          </div>
        </div>

        <div class="settings-section">
          <h2>System</h2>
          <div id="health-status"><div class="loading-spinner"></div></div>
        </div>
      </div>`;
  }

  function bindSettingsEvents() {
    document.getElementById('save-key-btn')?.addEventListener('click', () => {
      const val = document.getElementById('api-key-input').value.trim();
      if (val) {
        setApiKey(val);
        toast('API key saved', 'success');
        render();
      }
    });

    document.getElementById('save-url-btn')?.addEventListener('click', () => {
      const val = document.getElementById('api-url-input').value.trim();
      localStorage.setItem('ms_api_url', val);
      toast('API endpoint saved', 'success');
      // Reload so API_BASE updates
      window.location.reload();
    });

    loadHealth();
  }

  async function loadHealth() {
    const container = document.getElementById('health-status');
    if (!container) return;

    if (!getApiKey()) {
      container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem;">Configure API key to check system health.</p>';
      return;
    }

    try {
      const data = await api('/api/health');
      const stats = await api('/api/stats');

      container.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: var(--space-sm);">
          ${Object.entries(data.checks).map(([name, status]) => `
            <div class="key-card">
              <span class="status-dot ${status === 'ok' ? 'completed' : 'failed'}"></span>
              <div class="key-info">
                <div class="key-name" style="text-transform: capitalize;">${name}</div>
                <div class="key-detail">${status === 'ok' ? 'Connected' : 'Unavailable'}</div>
              </div>
            </div>
          `).join('')}
          <div class="key-card">
            <div class="key-info">
              <div class="key-name">Vectors Indexed</div>
              <div class="key-detail" style="color: var(--cyan);">${stats.description?.vectorCount ?? 0}</div>
            </div>
          </div>
        </div>`;
    } catch (err) {
      container.innerHTML = `<p style="color: var(--danger); font-size: 0.9rem;">${escapeHTML(err.message)}</p>`;
    }
  }

  // ── Chat Formatting ────────────────────────

  function formatAssistantContent(text) {
    if (!text) return '';

    // Extract <think> blocks and format separately
    let output = '';
    let remaining = text;
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    let match;
    let lastIndex = 0;

    while ((match = thinkRegex.exec(text)) !== null) {
      // Format text before this think block
      const before = text.slice(lastIndex, match.index);
      if (before.trim()) output += formatMarkdownLight(escapeHTML(before));

      // Format the think block as a collapsible section
      const thinkContent = escapeHTML(match[1].trim());
      output += `<details class="chat-think"><summary class="chat-think-toggle">Reasoning</summary><div class="chat-think-content">${formatMarkdownLight(thinkContent)}</div></details>`;

      lastIndex = match.index + match[0].length;
    }

    // Any remaining text after the last think block
    const after = text.slice(lastIndex);
    if (after.trim()) output += formatMarkdownLight(escapeHTML(after));

    return output || formatMarkdownLight(escapeHTML(text));
  }

  function formatMarkdownLight(html) {
    return html
      // Bold: **text**
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      // Italic: *text*
      .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
      // Inline code: `text`
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Headers: ### text
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      // Bullet lists: - text
      .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      // Numbered lists: 1. text
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Paragraphs: double newlines
      .replace(/\n\n/g, '</p><p>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>')
      // Clean up empty paragraphs
      .replace(/<p>\s*<\/p>/g, '')
      // Single newlines to <br> within paragraphs
      .replace(/(?<!<\/li>|<\/ul>|<\/h[34]>|<\/details>)\n(?!<)/g, '<br>');
  }

  // ── Utilities ───────────────────────────────

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return escapeHTML(str);
  }

  function stripPrefix(text) {
    return (text || '').replace(/^Title:.*\n\n?/, '');
  }

  function parseMessages(text) {
    if (!text) return [];
    const lines = stripPrefix(text).split('\n');
    const messages = [];
    let current = null;

    for (const line of lines) {
      const match = line.match(/^(user|assistant|system|human):\s*(.*)/i);
      if (match) {
        if (current) messages.push(current);
        current = { role: match[1].toLowerCase(), content: match[2] };
      } else if (current) {
        current.content += '\n' + line;
      }
    }
    if (current) messages.push(current);
    return messages;
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  // ── Toast ───────────────────────────────────

  function toast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${escapeHTML(message)}</span>`;
    container.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(12px)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // ── Boot ────────────────────────────────────

  // Expose navigate for inline onclick handlers
  window._msNavigate = navigate;

  document.addEventListener('DOMContentLoaded', () => {
    // Prevent browser from opening dropped files outside the upload zone
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    // Nav clicks
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.page));
    });

    // Keyboard shortcut: / focuses search
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        navigate('search');
        setTimeout(() => document.getElementById('search-input')?.focus(), 50);
      }
    });

    render();
  });
})();
