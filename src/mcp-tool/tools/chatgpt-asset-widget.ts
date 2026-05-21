import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMcpPublicBaseUrl } from '../../utils/image-upload-ticket.js';

export const CHATGPT_ASSET_WIDGET_URI = 'ui://wechat/chatgpt-asset-upload-v6.html';

function getChatGPTAssetWidgetHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      padding: 16px;
      background: Canvas;
      color: CanvasText;
    }
    .layout {
      display: grid;
      gap: 14px;
      max-width: 760px;
    }
    .panel {
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 8px;
      padding: 14px;
      background: color-mix(in srgb, Canvas 94%, CanvasText 6%);
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    input, select, button {
      font: inherit;
      box-sizing: border-box;
    }
    input, select {
      width: 100%;
      border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-radius: 6px;
      padding: 8px 10px;
      background: Canvas;
      color: CanvasText;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 9px 12px;
      background: #0f766e;
      color: white;
      cursor: pointer;
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .muted {
      color: color-mix(in srgb, CanvasText 62%, transparent);
      font-size: 12px;
      line-height: 1.5;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 150px;
      gap: 10px;
      margin-top: 12px;
    }
    .asset-workbench {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      margin-top: 10px;
    }
    .asset-list {
      display: grid;
      gap: 6px;
      margin: 8px 0 0;
      max-height: 420px;
      overflow: auto;
      padding-right: 2px;
    }
    .asset-row {
      display: grid;
      gap: 4px;
      width: 100%;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 8px;
      padding: 9px 10px;
      background: Canvas;
      color: CanvasText;
      text-align: left;
    }
    .asset-row:hover,
    .asset-row.is-selected {
      border-color: #0f766e;
      background: color-mix(in srgb, #0f766e 8%, Canvas);
    }
    .asset-head,
    .asset-row-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .asset-title {
      font-weight: 700;
      line-height: 1.35;
    }
    .asset-tag {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      background: color-mix(in srgb, #0f766e 14%, Canvas);
      color: #0f766e;
    }
    .asset-detail {
      display: grid;
      gap: 10px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 8px;
      padding: 12px;
      background: Canvas;
      min-height: 260px;
    }
    .detail-grid {
      display: grid;
      gap: 6px;
      font-size: 12px;
      line-height: 1.5;
    }
    .detail-grid div {
      overflow-wrap: anywhere;
    }
    .asset-meta {
      display: grid;
      gap: 3px;
      color: color-mix(in srgb, CanvasText 72%, transparent);
      font-size: 12px;
      line-height: 1.45;
    }
    .asset-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    details.panel > summary {
      cursor: pointer;
      font-weight: 700;
      margin-bottom: 10px;
    }
    pre {
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border-radius: 6px;
      padding: 10px;
      background: color-mix(in srgb, CanvasText 8%, transparent);
      font-size: 12px;
      max-height: 280px;
    }
    @media (max-width: 640px) {
      .row,
      .toolbar,
      .asset-workbench {
        grid-template-columns: 1fr;
      }
      .asset-actions {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="panel">
      <div class="row">
        <label>
          directoryId
          <input id="directoryId" placeholder="首次上传可留空，后续自动复用" />
        </label>
        <label>
          topicSlug
          <input id="topicSlug" placeholder="例如 ai-agent-wechat-article" />
        </label>
      </div>
      <label>
        已有草稿 ID（更新原草稿时可填；创建新草稿可留空）
        <input id="draftMediaId" placeholder="例如 wechat_draft 返回的 media_id" />
      </label>
      <p class="muted">同一篇文章后续重传 ZIP 或替换单图时，请复用 MCP 返回的 directoryId。</p>
    </section>

    <section class="panel">
      <div class="button-row">
        <button id="refreshButton">查看当前工作区</button>
        <button id="createDraftButton">让 ChatGPT 创建新草稿</button>
        <button id="updateDraftButton">让 ChatGPT 更新原草稿</button>
      </div>
      <div class="toolbar">
        <label>
          搜索图片
          <input id="assetSearch" placeholder="按图几、说明、assetId、文件名搜索" />
        </label>
        <label>
          类型
          <select id="assetRoleFilter">
            <option value="all">全部图片</option>
            <option value="cover">封面图</option>
            <option value="inline">正文图</option>
          </select>
        </label>
      </div>
      <div class="asset-workbench">
        <div>
          <div id="assetSummary" class="muted">暂无图片列表。</div>
          <div id="assetList" class="asset-list"></div>
        </div>
        <div id="assetDetail" class="asset-detail">
          <p class="muted">处理素材包后，先在左侧选择图片，再在这里替换。</p>
        </div>
      </div>
      <p class="muted">列表按“封面图 / 正文图 1 / 正文图 2...”排序。正文图会优先显示 manifest 里的 label、caption 和 alt，便于确认替换的是哪一张。</p>
    </section>

    <section class="panel">
      <label>
        上传文章素材 ZIP
        <input id="bundleFile" type="file" accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" />
      </label>
      <div class="button-row">
        <button id="bundleButton">处理本地 ZIP</button>
        <button id="bundleLibraryButton">从 ChatGPT 文件库选择 ZIP</button>
      </div>
      <p class="muted">ZIP 根目录需要包含 manifest.json、article.md 或 article.html，以及 images/ 下的图片。正文图片引用必须使用 asset://image/&lt;assetId&gt;。如果 ChatGPT 文件库选择器可用，可直接从文件库选择 ChatGPT 生成的 ZIP，不需要先下载到本地。</p>
    </section>

    <details class="panel">
      <summary>手动 assetId 替换（备用）</summary>
      <div class="row">
        <label>
          assetId
          <input id="assetId" placeholder="例如 cover 或 process-diagram" />
        </label>
        <label>
          role
          <select id="role">
            <option value="inline">inline 正文图</option>
            <option value="cover">cover 封面图</option>
          </select>
        </label>
      </div>
      <label>
        上传单张替换图片
        <input id="imageFile" type="file" accept="image/png,image/jpeg" />
      </label>
      <div class="button-row">
        <button id="imageButton">上传/替换本地单图</button>
        <button id="imageLibraryButton">从 ChatGPT 文件库选图替换</button>
      </div>
    </details>

    <section class="panel">
      <pre id="output">等待操作...</pre>
    </section>
  </main>

  <script>
    const output = document.getElementById('output');
    const assetList = document.getElementById('assetList');
    const assetDetail = document.getElementById('assetDetail');
    const assetSummary = document.getElementById('assetSummary');
    const assetSearchInput = document.getElementById('assetSearch');
    const assetRoleFilter = document.getElementById('assetRoleFilter');
    const directoryIdInput = document.getElementById('directoryId');
    const topicSlugInput = document.getElementById('topicSlug');
    const draftMediaIdInput = document.getElementById('draftMediaId');
    const toolInput = window.openai?.toolInput || {};
    let currentAssets = [];
    let selectedAssetId = '';

    if (toolInput.directoryId) directoryIdInput.value = toolInput.directoryId;
    if (toolInput.topicSlug) topicSlugInput.value = toolInput.topicSlug;
    if (toolInput.draftMediaId || toolInput.mediaId) draftMediaIdInput.value = toolInput.draftMediaId || toolInput.mediaId;

    function setOutput(value) {
      output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function sortAssetsForDisplay(assets) {
      return [...assets].sort((left, right) => {
        if (left.role !== right.role) {
          return left.role === 'cover' ? -1 : 1;
        }

        const leftIndex = Number.isFinite(left.figureIndex) ? left.figureIndex : 9999;
        const rightIndex = Number.isFinite(right.figureIndex) ? right.figureIndex : 9999;
        return leftIndex - rightIndex || String(left.id).localeCompare(String(right.id));
      });
    }

    function getAssetTitle(asset) {
      if (asset.displayName) return asset.displayName;
      if (asset.label) return asset.label;
      if (asset.role === 'cover') return '封面图';
      if (asset.figureIndex) return '正文图 ' + asset.figureIndex;
      return '正文图：' + asset.id;
    }

    function getAssetStatusText(asset) {
      if (asset.status === 'replaced') return '已替换';
      if (asset.status === 'reused') return '已复用';
      return asset.wechatUrl || asset.mediaId ? '已上传' : '待上传';
    }

    function getAssetRoleText(asset) {
      return asset.role === 'cover' ? '封面' : '正文图';
    }

    function getAssetFigureText(asset) {
      if (asset.role === 'cover') return '封面图';
      return asset.figureIndex ? '正文图 ' + asset.figureIndex : '正文图';
    }

    function getAssetDescription(asset) {
      return [asset.caption, asset.alt].filter(Boolean).join(' / ');
    }

    function getAssetSearchText(asset) {
      return [
        asset.id,
        asset.displayName,
        asset.label,
        asset.alt,
        asset.caption,
        asset.sourcePath,
        asset.fileName,
        getAssetFigureText(asset),
        getAssetRoleText(asset),
        getAssetStatusText(asset)
      ].filter(Boolean).join(' ').toLowerCase();
    }

    function getFilteredAssets() {
      const query = assetSearchInput.value.trim().toLowerCase();
      const role = assetRoleFilter.value;
      return currentAssets.filter(asset => {
        if (role !== 'all' && asset.role !== role) return false;
        if (!query) return true;
        return getAssetSearchText(asset).includes(query);
      });
    }

    function syncManualFields(asset) {
      const assetIdInput = document.getElementById('assetId');
      const roleInput = document.getElementById('role');
      if (assetIdInput) assetIdInput.value = asset.id;
      if (roleInput) roleInput.value = asset.role;
    }

    function renderSelectedAssetDetail() {
      const asset = currentAssets.find(item => item.id === selectedAssetId);
      if (!asset) {
        assetDetail.innerHTML = '<p class="muted">没有匹配的图片。可以调整搜索或筛选条件。</p>';
        return;
      }

      syncManualFields(asset);
      const title = escapeHtml(getAssetTitle(asset));
      const description = getAssetDescription(asset);
      const currentValue = asset.wechatUrl || asset.mediaId || '暂无';
      const referenceText = asset.referenceCount ? '引用次数：' + asset.referenceCount : '';

      assetDetail.innerHTML = [
        '<div class="asset-head">',
        '  <div>',
        '    <div class="asset-title">' + title + '</div>',
        '    <div class="muted">' + escapeHtml([getAssetFigureText(asset), asset.id].filter(Boolean).join(' · ')) + '</div>',
        '  </div>',
        '  <span class="asset-tag">' + escapeHtml(getAssetRoleText(asset)) + '</span>',
        '</div>',
        '<div class="detail-grid">',
        description ? '  <div><strong>说明：</strong>' + escapeHtml(description) + '</div>' : '',
        referenceText ? '  <div><strong>引用：</strong>' + escapeHtml(referenceText) + '</div>' : '',
        '  <div><strong>原路径：</strong>' + escapeHtml(asset.sourcePath || asset.fileName || '') + '</div>',
        '  <div><strong>当前值：</strong>' + escapeHtml(currentValue) + '</div>',
        '  <div><strong>状态：</strong>' + escapeHtml(getAssetStatusText(asset)) + '</div>',
        '</div>',
        '<div class="asset-actions">',
        '  <input id="selectedAssetFile" type="file" accept="image/png,image/jpeg" aria-label="替换 ' + title + '" />',
        '  <button type="button" data-replace-selected="local">替换当前选中图片</button>',
        '</div>',
        '<div class="button-row">',
        '  <button type="button" data-replace-selected="library">从 ChatGPT 文件库选图替换</button>',
        '</div>'
      ].filter(Boolean).join('');
    }

    function renderCompactAssetList() {
      const filteredAssets = getFilteredAssets();

      if (!filteredAssets.some(asset => asset.id === selectedAssetId)) {
        selectedAssetId = filteredAssets[0]?.id || '';
      }

      const coverCount = currentAssets.filter(asset => asset.role === 'cover').length;
      const inlineCount = currentAssets.filter(asset => asset.role === 'inline').length;
      assetSummary.textContent = currentAssets.length
        ? '共 ' + currentAssets.length + ' 张图片：封面 ' + coverCount + ' 张，正文图 ' + inlineCount + ' 张。'
        : '暂无图片列表。';

      if (!filteredAssets.length) {
        assetList.innerHTML = '<p class="muted">没有符合条件的图片。</p>';
        renderSelectedAssetDetail();
        return;
      }

      assetList.innerHTML = filteredAssets.map(asset => {
        const title = escapeHtml(getAssetTitle(asset));
        const description = getAssetDescription(asset) || asset.sourcePath || asset.fileName || '';
        const isSelected = asset.id === selectedAssetId ? ' is-selected' : '';
        const subtitle = [getAssetFigureText(asset), asset.id, getAssetStatusText(asset)].filter(Boolean).join(' · ');

        return [
          '<button type="button" class="asset-row' + isSelected + '" data-select-asset-id="' + escapeHtml(asset.id) + '">',
          '  <span class="asset-row-head">',
          '    <span class="asset-title">' + title + '</span>',
          '    <span class="asset-tag">' + escapeHtml(getAssetRoleText(asset)) + '</span>',
          '  </span>',
          '  <span class="muted">' + escapeHtml(subtitle) + '</span>',
          description ? '  <span class="muted">' + escapeHtml(description) + '</span>' : '',
          '</button>'
        ].filter(Boolean).join('');
      }).join('');
      renderSelectedAssetDetail();
    }

    function renderAssetList(structured) {
      const payload = structured?.structuredContent || structured;
      currentAssets = Array.isArray(payload?.assets) ? sortAssetsForDisplay(payload.assets) : [];

      if (!currentAssets.length) {
        selectedAssetId = '';
        assetSummary.textContent = '暂无图片列表。';
        assetList.innerHTML = '<p class="muted">暂无 asset 列表。处理素材包或填写 directoryId 后点击“查看当前工作区”。</p>';
        assetDetail.innerHTML = '<p class="muted">处理素材包后，先在左侧选择图片，再在这里替换。</p>';
        return;
      }

      if (!currentAssets.some(asset => asset.id === selectedAssetId)) {
        selectedAssetId = currentAssets[0].id;
      }
      renderCompactAssetList();
    }

    function normalizeFileRef(uploaded, originalFile) {
      return {
        file_id: uploaded.file_id || uploaded.fileId || uploaded.id,
        download_url: uploaded.download_url || uploaded.downloadUrl,
        file_name: uploaded.file_name || uploaded.fileName || originalFile?.name || originalFile?.fileName,
        mime_type: uploaded.mime_type || uploaded.mimeType || originalFile?.type || originalFile?.mimeType
      };
    }

    function getFileRefName(fileRef) {
      return fileRef.file_name || fileRef.fileName || fileRef.filename || fileRef.name || '';
    }

    function getFileRefMimeType(fileRef) {
      return fileRef.mime_type || fileRef.mimeType || fileRef.type || '';
    }

    function getFileRefId(fileRef) {
      return fileRef.file_id || fileRef.fileId || fileRef.id || '';
    }

    function isZipFileRef(fileRef) {
      const name = getFileRefName(fileRef).toLowerCase();
      const mimeType = getFileRefMimeType(fileRef).toLowerCase();
      return name.endsWith('.zip')
        || mimeType === 'application/zip'
        || mimeType === 'application/x-zip-compressed'
        || mimeType === 'application/octet-stream'
        || mimeType.includes('zip');
    }

    function isImageFileRef(fileRef) {
      const name = getFileRefName(fileRef).toLowerCase();
      const mimeType = getFileRefMimeType(fileRef).toLowerCase();
      return /^image\\/(png|jpeg|jpg)$/.test(mimeType) || /\\.(png|jpe?g)$/.test(name);
    }

    function findCompatibleLibraryFile(files, kind) {
      if (kind === 'zip') {
        return files.find(isZipFileRef) || files[0];
      }

      const matcher = kind === 'zip' ? isZipFileRef : isImageFileRef;
      return files.find(matcher);
    }

    function getLibraryFileName(fileRef, kind) {
      const rawName = getFileRefName(fileRef).trim();
      const mimeType = getFileRefMimeType(fileRef).toLowerCase();

      if (kind === 'zip') {
        return rawName || 'chatgpt-article-bundle.zip';
      }

      if (/\\.(png|jpe?g)$/i.test(rawName)) {
        return rawName;
      }

      if (mimeType === 'image/png') {
        return (rawName || 'chatgpt-library-image') + '.png';
      }

      if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
        return (rawName || 'chatgpt-library-image') + '.jpg';
      }

      return rawName || 'chatgpt-library-image';
    }

    async function normalizeLibraryFileRef(fileRef, kind) {
      const fileId = getFileRefId(fileRef);
      if (!fileId) {
        throw new Error('ChatGPT 文件库返回的文件缺少 fileId');
      }

      const alreadyHasDownloadUrl = fileRef.download_url || fileRef.downloadUrl;
      const download = alreadyHasDownloadUrl
        ? fileRef
        : await window.openai.getFileDownloadUrl({ fileId });
      const downloadUrl = download.download_url || download.downloadUrl || download.url;

      if (!downloadUrl) {
        throw new Error('已选择文件，但未获得临时 download_url');
      }

      const normalized = {
        file_id: fileId,
        download_url: downloadUrl,
        file_name: getLibraryFileName(fileRef, kind),
        mime_type: getFileRefMimeType(fileRef)
      };

      if (kind === 'image' && !isImageFileRef(normalized)) {
        throw new Error('请选择 JPG/JPEG/PNG 图片。当前文件: ' + JSON.stringify({
          fileName: normalized.file_name,
          mimeType: normalized.mime_type
        }));
      }

      return normalized;
    }

    async function selectFileFromChatGPTLibrary(kind) {
      if (!window.openai?.selectFiles) {
        throw new Error('当前 ChatGPT 环境不支持文件库选择器，请使用本地上传。');
      }

      if (!window.openai?.getFileDownloadUrl) {
        throw new Error('当前 ChatGPT 环境不支持获取文件下载地址，请使用本地上传。');
      }

      const files = await window.openai.selectFiles();
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('未选择文件');
      }

      const compatible = findCompatibleLibraryFile(files, kind);
      if (!compatible) {
        throw new Error(kind === 'zip' ? '请选择 .zip 素材包' : '请选择 JPG/JPEG/PNG 图片');
      }

      return normalizeLibraryFileRef(compatible, kind);
    }

    function getBundleUploadConfig() {
      return window.openai?.toolResponseMetadata?.chatgptBundleUpload;
    }

    async function uploadBundleDirectlyToMcp(file, config) {
      if (!config?.uploadUrl) {
        throw new Error('缺少 MCP ZIP 上传地址，请重新打开上传界面');
      }

      if (!/\\.zip$/i.test(file.name)) {
        throw new Error('请选择 .zip 素材包');
      }

      if (config.maxBytes && file.size > config.maxBytes) {
        throw new Error('ZIP 文件过大，当前最大允许 ' + config.maxBytes + ' 字节');
      }

      const formData = new FormData();
      formData.append(config.formField || 'file', file, file.name);

      const response = await fetch(config.uploadUrl, {
        method: config.method || 'POST',
        body: formData
      });
      const text = await response.text();
      let payload;

      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('MCP ZIP 上传返回了非 JSON 响应: ' + text.slice(0, 200));
      }

      if (!response.ok || !payload.ok || !payload.bundle) {
        throw new Error(payload.error || 'MCP ZIP 上传失败');
      }

      return payload.bundle;
    }

    async function uploadBundleFile(file) {
      const directUploadConfig = getBundleUploadConfig();

      if (directUploadConfig?.uploadUrl) {
        setOutput('正在直接上传 ZIP 到 MCP...');
        return uploadBundleDirectlyToMcp(file, directUploadConfig);
      }

      throw new Error('MCP 未返回 ZIP 直传地址，请重新调用 wechat_open_asset_bundle_upload 打开上传界面');
    }

    async function uploadToChatGPT(file) {
      if (!window.openai?.uploadFile) {
        throw new Error('当前环境不支持 window.openai.uploadFile');
      }

      const uploaded = await window.openai.uploadFile(file);
      const ref = normalizeFileRef(uploaded || {}, file);

      if (!ref.download_url && ref.file_id && window.openai.getFileDownloadUrl) {
        const download = await window.openai.getFileDownloadUrl({ fileId: ref.file_id });
        ref.download_url = download.download_url || download.downloadUrl || download.url;
      }

      if (!ref.download_url) {
        throw new Error('上传成功但未获得 download_url');
      }

      return ref;
    }

    async function processBundleRef(bundle, sourceText) {
      setOutput('正在调用 MCP 处理' + sourceText + '素材包...');
      await callTool('wechat_process_article_bundle_from_chatgpt_file', {
        directoryId: directoryIdInput.value.trim() || undefined,
        topicSlug: topicSlugInput.value.trim() || undefined,
        bundle
      });
    }

    async function replaceManualAssetWithFileRef(fileRef, sourceText) {
      const directoryId = directoryIdInput.value.trim();
      const assetId = document.getElementById('assetId').value.trim();
      const role = document.getElementById('role').value;
      if (!directoryId) throw new Error('请先填写已有 directoryId');
      if (!assetId) throw new Error('请填写 assetId');

      setOutput('正在用' + sourceText + '替换单图...');
      await callTool('wechat_upload_workspace_image_from_chatgpt_file', {
        directoryId,
        assetId,
        role,
        file: fileRef
      });
    }

    async function replaceSelectedAssetWithFileRef(fileRef, sourceText) {
      const directoryId = directoryIdInput.value.trim();
      const asset = currentAssets.find(item => item.id === selectedAssetId);

      if (!directoryId) throw new Error('请先填写已有 directoryId');
      if (!asset) throw new Error('请先在左侧选择要替换的图片');

      syncManualFields(asset);
      setOutput('正在用' + sourceText + '替换当前工作区里的“' + asset.id + '”...');
      await callTool('wechat_upload_workspace_image_from_chatgpt_file', {
        directoryId,
        assetId: asset.id,
        role: asset.role,
        file: fileRef
      });
    }

    async function callTool(name, args) {
      if (!window.openai?.callTool) {
        throw new Error('当前环境不支持 window.openai.callTool');
      }

      const result = await window.openai.callTool(name, args);
      const structured = result?.structuredContent || result;

      if (structured?.directoryId) {
        directoryIdInput.value = structured.directoryId;
      }

      renderAssetList(structured);
      setOutput(structured || result);
      return result;
    }

    async function askChatGPTToContinue(mode) {
      if (!window.openai?.sendFollowUpMessage) {
        throw new Error('当前环境不支持 window.openai.sendFollowUpMessage');
      }

      const directoryId = directoryIdInput.value.trim();
      if (!directoryId) {
        throw new Error('请先处理素材包或填写 directoryId');
      }

      const draftMediaId = draftMediaIdInput.value.trim();
      const modeText = mode === 'update' ? '更新原草稿' : '创建新草稿';
      const modeInstructions = mode === 'update'
        ? [
            '本次目标：更新原来的公众号草稿，不要创建新草稿。',
            draftMediaId
              ? '原草稿 mediaId: ' + draftMediaId
              : '如果你在当前对话上下文中知道之前创建草稿返回的 mediaId，请使用那个 mediaId；如果不知道，请先询问我原草稿 ID，不要创建新草稿。',
            '拿到最新工作区后，使用 wechat_draft action=update，mediaId 使用原草稿 mediaId，index 默认 0，article 使用最新 draftArticle。'
          ]
        : [
            '本次目标：创建一个新的公众号草稿。',
            '拿到最新工作区后，使用 wechat_draft action=add，articles 使用最新 draftArticle。',
            '即使之前已经有旧草稿，本次也创建新草稿，不要覆盖旧草稿。'
          ];
      const prompt = [
        '我已经在微信公众号素材 Widget 中完成图片检查或替换。',
        '请继续执行下一步公众号草稿流程：' + modeText + '。',
        '',
        'directoryId: ' + directoryId,
        '',
        ...modeInstructions,
        '',
        '请先调用 wechat_get_chatgpt_article_workflow 读取当前流程规范，再调用 wechat_get_article_workspace 查看该 directoryId 的最新工作区。',
        '确认正文图片已经是微信图床 URL，封面图已经有 mediaId，然后按 MCP 返回的规范创建公众号草稿。',
        '不要调用 wechat_publish。',
        '不要使用旧的分片上传、prepare upload 或 base64 上传流程。',
        '如果信息不足，请先说明缺少什么。'
      ].join('\\n');

      await window.openai.sendFollowUpMessage({
        prompt,
        scrollToBottom: true
      });
      setOutput('已让 ChatGPT 继续执行下一步。');
    }

    async function runWithButton(button, task) {
      button.disabled = true;
      try {
        await task();
      } catch (error) {
        setOutput(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
      }
    }

    document.getElementById('bundleButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const file = document.getElementById('bundleFile').files?.[0];
        if (!file) throw new Error('请先选择 ZIP 素材包');
        const bundle = await uploadBundleFile(file);
        await processBundleRef(bundle, '本地 ZIP ');
      });
    });

    document.getElementById('bundleLibraryButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        setOutput('正在打开 ChatGPT 文件库选择 ZIP...');
        const bundle = await selectFileFromChatGPTLibrary('zip');
        await processBundleRef(bundle, 'ChatGPT 文件库 ZIP ');
      });
    });

    document.getElementById('imageButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const file = document.getElementById('imageFile').files?.[0];
        if (!file) throw new Error('请先选择图片');
        setOutput('正在上传图片到 ChatGPT...');
        const uploadedFile = await uploadToChatGPT(file);
        await replaceManualAssetWithFileRef(uploadedFile, '本地图片');
      });
    });

    document.getElementById('imageLibraryButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        setOutput('正在打开 ChatGPT 文件库选择图片...');
        const selectedFile = await selectFileFromChatGPTLibrary('image');
        await replaceManualAssetWithFileRef(selectedFile, 'ChatGPT 文件库图片');
      });
    });

    assetSearchInput.addEventListener('input', () => {
      renderCompactAssetList();
    });

    assetRoleFilter.addEventListener('change', () => {
      renderCompactAssetList();
    });

    assetList.addEventListener('click', event => {
      const row = event.target?.closest?.('[data-select-asset-id]');
      if (!row) return;

      selectedAssetId = row.dataset.selectAssetId;
      renderCompactAssetList();
    });

    assetDetail.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-replace-selected]');
      if (!button) return;

      runWithButton(button, async () => {
        if (button.dataset.replaceSelected === 'library') {
          setOutput('正在打开 ChatGPT 文件库选择图片...');
          const selectedFile = await selectFileFromChatGPTLibrary('image');
          await replaceSelectedAssetWithFileRef(selectedFile, 'ChatGPT 文件库图片');
          return;
        }

        const file = document.getElementById('selectedAssetFile')?.files?.[0];
        if (!file) throw new Error('请先选择新图片');

        setOutput('正在上传图片到 ChatGPT...');
        const uploadedFile = await uploadToChatGPT(file);
        await replaceSelectedAssetWithFileRef(uploadedFile, '本地图片');
      });
    });

    document.getElementById('refreshButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, async () => {
        const directoryId = directoryIdInput.value.trim();
        if (!directoryId) throw new Error('请先填写 directoryId');
        await callTool('wechat_get_article_workspace', { directoryId });
      });
    });

    document.getElementById('createDraftButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, () => askChatGPTToContinue('create'));
    });

    document.getElementById('updateDraftButton').addEventListener('click', event => {
      runWithButton(event.currentTarget, () => askChatGPTToContinue('update'));
    });

    renderAssetList(window.openai?.toolOutput);
  </script>
</body>
</html>`;
}

export function registerChatGPTAssetWidgetResource(server: McpServer): void {
  const publicBaseUrl = getMcpPublicBaseUrl();
  const connectDomains = publicBaseUrl ? [publicBaseUrl] : [];

  server.registerResource(
    'wechat-chatgpt-asset-upload-widget',
    CHATGPT_ASSET_WIDGET_URI,
    {
      title: '微信公众号素材包上传',
      description: '在 ChatGPT 中上传公众号文章 ZIP 素材包或替换单张图片。',
      mimeType: 'text/html',
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains,
            resourceDomains: [],
          },
        },
        'openai/widgetDescription': '从本地或 ChatGPT 文件库选择微信公众号文章素材包，并把图片批量上传到微信公众号。',
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': {
          connect_domains: connectDomains,
          resource_domains: [],
        },
      },
    },
    async () => ({
      contents: [{
        uri: CHATGPT_ASSET_WIDGET_URI,
        mimeType: 'text/html',
        text: getChatGPTAssetWidgetHtml(),
      }],
    }),
  );
}
