
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// Make JSZip available. It's loaded from CDN.
declare var JSZip: any;

interface ToolDefinition {
  id: string;
  title: string;
  icon: string; 
  description: string;
  component: React.FC<ToolProps>;
}

interface ToolProps {
  showToast: (message: string, isError?: boolean) => void;
  toggleAppSpinner: (show: boolean) => void;
}

interface Scene {
  code: string;
  title: string;
  text: string; 
  ranking: number;
  status: string;
}

interface Section {
  code: string;
  title: string;
  synopsis: string;
  ranking: number;
  section_scenes: [{ code: string, ranking: number }];
}
interface Revision {
  number: number;
  date: number;
  book_progresses: Array<{ year: number, month: number, day: number, word_count: number }>;
  statuses: Array<{ code: string, title: string, color: number, ranking: number }>;
  scenes: Scene[];
  sections: Section[];
}
interface BackupData {
  version: number;
  code: string;
  title: string;
  description: string;
  show_table_of_contents: boolean;
  apply_automatic_indentation: boolean;
  last_update_date: number;
  last_backup_date: number;
  revisions: Revision[];
}

interface FindReplaceMatch {
  sceneIndex: number;
  blockIndex: number;
  matchIndex: number;
  matchLength: number;
  chapterTitle: string;
  matchLine: string;
}

interface FindReplacePointer {
  scene: number;
  block: number;
  offset: number;
}


// --- UI Helper Components ---
const Spinner: React.FC<{ visible: boolean; className?: string }> = ({ visible, className }) => {
  if (!visible) return null;
  return <div className={`spinner ${className || ''}`} role="status" aria-busy="true"></div>;
};

interface ToastMessage {
  id: number;
  message: string;
  isError: boolean;
}

const AppToast: React.FC<{ messages: ToastMessage[] }> = ({ messages }) => {
  if (messages.length === 0) return null;
  const latestMessage = messages[messages.length - 1]; 
  return (
    <div
      id="toast"
      className={`status-toast show ${latestMessage.isError ? 'toast-error' : 'toast-success'}`}
      role="alert"
    >
      {latestMessage.message}
    </div>
  );
};

const OfflineIndicatorToast: React.FC<{ isOffline: boolean }> = ({ isOffline }) => {
  if (!isOffline) return null;
  return (
    <div
      className="status-toast show toast-error persistent-toast"
      role="status"
      aria-live="assertive"
    >
      You are currently offline.
    </div>
  );
};

const UpdateAvailableToast: React.FC<{ onReload: () => void }> = ({ onReload }) => {
  return (
    <div
      className="status-toast show toast-success persistent-toast update-toast" // Use success style for update
      role="status"
      aria-live="assertive"
    >
      A new version is available!
      <button onClick={onReload} className="btn-toast-reload">Reload</button>
    </div>
  );
};


// --- Helper Functions ---
const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
};

const triggerBrowserDownload = (blob: Blob, filename: string) => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const sanitizeForXML = (str: string | undefined): string => {
  if (!str) return '';
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const escapeHTML = (str: string | undefined): string => {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, (match) => {
    const escapes: { [key: string]: string } = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    };
    return escapes[match];
  });
};

const generateUUID = (): string => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

const textToXHTML = (text: string, chapterTitle: string, language: string = "en"): string => {
    let bodyContent = `<h2>${escapeHTML(chapterTitle)}</h2>\n`;
    const paragraphs = text.replace(/\r\n/g, '\n').split(/\n\n+/); 
    paragraphs.forEach(p => {
        const trimmedP = p.trim();
        if (trimmedP) {
            bodyContent += `    <p>${escapeHTML(trimmedP)}</p>\n`;
        }
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}">
<head>
  <title>${escapeHTML(chapterTitle)}</title>
  <link rel="stylesheet" type="text/css" href="../css/style.css" /> 
</head>
<body>
  <section epub:type="chapter" aria-label="${escapeHTML(chapterTitle)}">\n${bodyContent}  </section>
</body>
</html>`;
};

const extractTextFromHtml = (htmlString: string): string => {
    try {
        const PARA_BREAK_MARKER = " \uE000P\uE000 "; 
        const LINE_BREAK_MARKER = " \uE000L\uE000 ";
        let processedHtml = htmlString;
        processedHtml = processedHtml.replace(/<\/(p|h[1-6]|div|li|blockquote|pre|section|article|aside|header|footer|nav|figure|figcaption|table|tr|th|td)>\s*/gi, '$&' + PARA_BREAK_MARKER);
        processedHtml = processedHtml.replace(/<br\s*\/?>/gi, LINE_BREAK_MARKER);

        const parser = new DOMParser();
        const doc = parser.parseFromString(processedHtml, 'text/html');
        const body = doc.body;

        if (!body) {
            let fallbackText = doc.documentElement?.innerText || doc.documentElement?.textContent || '';
            return fallbackText.trim();
        }
        body.querySelectorAll('script, style').forEach(el => el.remove());
        let text = body.textContent || "";
        text = text.replace(new RegExp(PARA_BREAK_MARKER.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '\n\n');
        text = text.replace(new RegExp(LINE_BREAK_MARKER.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), '\n');
        text = text.replace(/[ \t]+/g, ' ');
        text = text.replace(/ *\n */g, '\n');
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
    } catch (e) {
        console.error("Error extracting text from HTML:", e);
        return ''; 
    }
};

const sanitizeFilenameForZip = (name: string): string => {
    if (!name) return 'download';
    let sanitized = name.replace(/[^\p{L}\p{N}._-]+/gu, '_');
    sanitized = sanitized.replace(/__+/g, '_');
    sanitized = sanitized.replace(/^[_.-]+|[_.-]+$/g, '');
    sanitized = sanitized.substring(0, 100); 
    return sanitized || 'file';
};

const domParserInstance = new DOMParser();
const parseXml = (xmlString: string, sourceFileName: string = 'XML'): Document | null => {
    try {
        const doc = domParserInstance.parseFromString(xmlString, 'application/xml');
        const errorNode = doc.querySelector('parsererror');
        if (errorNode) {
            console.error(`XML Parsing Error in ${sourceFileName}:`, errorNode.textContent);
            return null;
        }
        return doc;
    } catch (e) {
        console.error(`Exception during XML parsing of ${sourceFileName}:`, e);
        return null;
    }
};

const parseHtml = (htmlString: string, sourceFileName: string = 'HTML'): Document | null => {
    try {
        const doc = domParserInstance.parseFromString(htmlString, 'text/html');
        if (!doc || (!doc.body && !doc.documentElement)) {
            console.warn(`Parsed HTML for ${sourceFileName} seems empty or invalid.`);
        }
        return doc;
    } catch (e) {
        console.error(`Exception during HTML parsing of ${sourceFileName}:`, e);
        return null;
    }
};

// --- PWA Logic ---
const usePwa = (
  showToastFn: (message: string, isError?: boolean) => void
) => {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js')
        .then(reg => {
          console.log('SW registered, scope:', reg.scope);
          showToastFn('App is ready for offline use.');

          // Check for an existing waiting worker
          if (reg.waiting) {
            setWaitingWorker(reg.waiting);
            setUpdateAvailable(true);
            console.log('SW update: A new version is already waiting.');
            return; // Don't proceed to onupdatefound if already waiting
          }

          // Listen for new worker installing
          reg.onupdatefound = () => {
            const newWorker = reg.installing;
            if (newWorker) {
              console.log('SW update: New worker found and installing.');
              newWorker.onstatechange = () => {
                if (newWorker.state === 'installed') {
                  console.log('SW update: New worker installed.');
                  if (navigator.serviceWorker.controller) {
                    // If there's an active SW, an update is available
                    setWaitingWorker(newWorker); // or reg.waiting, should be the same
                    setUpdateAvailable(true);
                    console.log('SW update: New version is available and waiting to activate.');
                  } else {
                    // No active SW, this is the first SW, it will activate.
                    console.log('SW update: First service worker installed and will activate.');
                  }
                }
              };
            }
          };
        })
        .catch(err => {
          console.error('SW registration failed:', err);
          showToastFn('Service worker registration failed.', true);
        });
    } else {
      console.log('Service Worker not supported in this browser.');
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, [showToastFn]);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        showToastFn('App installed successfully!');
      } else {
        showToastFn('App installation dismissed.');
      }
      setDeferredPrompt(null);
      setCanInstall(false);
    }
  };

  const handleUpdateAndReload = () => {
    if (waitingWorker) {
      waitingWorker.postMessage({ action: 'SKIP_WAITING' });
      // Reload only after the new worker has taken control
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    }
  };

  return { canInstall, handleInstallClick, updateAvailable, handleUpdateAndReload };
};


// --- Tool Components ---
const EpubSplitterTool: React.FC<ToolProps> = ({ showToast, toggleAppSpinner }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('single');
  const [chapterPattern, setChapterPattern] = useState('test');
  const [startNumber, setStartNumber] = useState(1);
  const [offsetNumber, setOffsetNumber] = useState(0);
  const [groupSize, setGroupSize] = useState(4);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setFileName(`Selected: ${file.name}`);
      setStatusMessage(null);
      setDownloadUrl(null);
    }
  };

  const handleSplit = async () => {
    if (!selectedFile) {
      showToast("No file selected for EPUB splitting.", true);
      return;
    }
    toggleAppSpinner(true);
    setStatusMessage(null);
    setDownloadUrl(null);
    try {
      const buffer = await readFileAsArrayBuffer(selectedFile);
      const epub = await JSZip.loadAsync(buffer);
      const structure: any = {};
      const promises: Promise<any>[] = [];
      epub.forEach((path: string, file: any) => {
        structure[path] = { dir: file.dir, contentType: file.options.contentType };
        if (!file.dir && (path.endsWith('.xhtml') || path.endsWith('.html') || path.includes('content.opf') || path.includes('toc.ncx'))) {
          promises.push(file.async('text').then((c: string) => structure[path].content = c));
        }
      });
      await Promise.all(promises);
      const chapters: string[] = [];
      for (let path in structure) {
        const info = structure[path];
        if (!info.dir && info.content) {
          const localParser = new DOMParser(); 
          let doc = localParser.parseFromString(info.content, 'text/xml');
          if (doc.querySelector('parsererror')) {
            doc = localParser.parseFromString(info.content, 'text/html');
          }
          const sections = doc.querySelectorAll(
            'section[epub\\:type="chapter"], div[epub\\:type="chapter"], ' +
            'section.chapter, div.chapter, section[role="chapter"], div[role="chapter"]'
          );
          if (sections.length) {
            sections.forEach(sec => {
              sec.querySelectorAll('h1,h2,h3,.title,.chapter-title').forEach(el => el.remove());
              const paras = sec.querySelectorAll('p');
              const text = paras.length ?
                Array.from(paras).map(p => p.textContent?.trim()).filter(t => t).join('\n') :
                sec.textContent?.replace(/\s*\n\s*/g, '\n').trim();
              if (text) chapters.push(text);
            });
          } else {
            const headings = doc.querySelectorAll('h1,h2,h3');
            if (headings.length > 1) {
              for (let i = 0; i < headings.length; i++) {
                let node = headings[i].nextSibling;
                let contentAcc = '';
                while (node && !(node.nodeType === 1 && /H[1-3]/.test((node as Element).tagName))) {
                  contentAcc += node.nodeType === 1 ? (node as Element).textContent + '\n' : node.textContent;
                  node = node.nextSibling;
                }
                contentAcc = contentAcc.replace(/\n{3,}/g, '\n').trim();
                if (contentAcc) chapters.push(contentAcc);
              }
            }
          }
        }
      }
      if (!chapters.length) throw new Error('No chapters found. Check EPUB structure.');
      const usableChaps = chapters.slice(offsetNumber);
      const effectiveStart = startNumber + offsetNumber;
      const zip = new JSZip();
      if (mode === 'single') {
        usableChaps.forEach((text, i) => {
          const chapNum = String(effectiveStart + i).padStart(2, '0');
          zip.file(`${chapterPattern}${chapNum}.txt`, text);
        });
      } else { 
        const currentGroupSize = parseInt(String(groupSize), 10) || 1;
        for (let i = 0; i < usableChaps.length; i += currentGroupSize) {
          const groupStartNum = effectiveStart + i;
          const groupEndNum = Math.min(effectiveStart + i + currentGroupSize - 1, effectiveStart + usableChaps.length - 1);
          const name = groupStartNum === groupEndNum ?
            `${chapterPattern} C${String(groupStartNum).padStart(2, '0')}.txt` :
            `${chapterPattern} C${String(groupStartNum).padStart(2, '0')}-${String(groupEndNum).padStart(2, '0')}.txt`;
          let content = '';
          for (let j = 0; j < currentGroupSize && (i + j) < usableChaps.length; j++) {
            if (j > 0) content += '\n\n\n---------------- END ----------------\n\n\n';
            content += usableChaps[i + j];
          }
          zip.file(name, content);
        }
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const newDownloadUrl = URL.createObjectURL(blob);
      setDownloadUrl(newDownloadUrl);
      setDownloadFilename(`${chapterPattern || 'chapter'}_chapters.zip`);
      setStatusMessage({ text: `Extracted ${usableChaps.length} chapters (skipped ${offsetNumber})`, type: 'success' });
      showToast(`Extracted ${usableChaps.length} chapters.`);
    } catch (err: any) {
      console.error("EPUB Splitter Error:", err);
      setStatusMessage({ text: `Error: ${err.message}`, type: 'error' });
      showToast(`Error: ${err.message}`, true);
    } finally {
      toggleAppSpinner(false);
    }
  };

  return (
    <div id="splitterApp" className="card tool-section">
      <h1>EPUB Chapter Splitter</h1>
      <div className="upload-section">
        <label htmlFor="epubUploadSplitter" className="btn upload-btn">Upload EPUB File</label>
        <input type="file" id="epubUploadSplitter" accept=".epub" style={{ display: 'none' }} onChange={handleFileChange} ref={fileInputRef} />
        <div className="file-name-display" aria-live="polite">{fileName}</div>
      </div>
      <div className="mode-section">
        <label htmlFor="modeSelect">Output Mode:</label>
        <select id="modeSelect" value={mode} onChange={e => setMode(e.target.value)}>
          <option value="single">Single Chapter per File</option>
          <option value="grouped">Grouped Chapters per File</option>
        </select>
      </div>
      <div className="options-section">
        <div className="option-group">
          <label htmlFor="chapterPattern">Chapter Prefix:</label>
          <input type="text" id="chapterPattern" placeholder="e.g., test" value={chapterPattern} onChange={e => setChapterPattern(e.target.value)} />
        </div>
        <div className="option-group">
          <label htmlFor="startNumber">Start Number:</label>
          <input type="number" id="startNumber" min="1" value={startNumber} onChange={e => setStartNumber(parseInt(e.target.value,10) || 1)} />
        </div>
        <div className="option-group">
          <label htmlFor="offsetNumber">Offset (skip chapters):</label>
          <input type="number" id="offsetNumber" min="0" value={offsetNumber} onChange={e => setOffsetNumber(parseInt(e.target.value,10) || 0)} />
        </div>
        {mode === 'grouped' && (
          <div className="option-group" id="groupSizeGroup">
            <label htmlFor="groupSize">Chapters per File:</label>
            <input type="number" id="groupSize" min="1" value={groupSize} onChange={e => setGroupSize(parseInt(e.target.value,10) || 1)} />
          </div>
        )}
      </div>
      <button className="btn split-btn" onClick={handleSplit} disabled={!selectedFile}>Split EPUB</button>
      {statusMessage && (
        <div className={`status-message ${statusMessage.type}`} role="status">{statusMessage.text}</div>
      )}
      {downloadUrl && (
        <div className="download-section">
          <a href={downloadUrl} download={downloadFilename} className="btn download-btn">Download Chapters</a>
        </div>
      )}
    </div>
  );
};

const BackupUtilityTool: React.FC<ToolProps> = ({ showToast, toggleAppSpinner }) => {
    const [operation, setOperation] = useState('create');
    const [createProjectTitle, setCreateProjectTitle] = useState('');
    const [createDescription, setCreateDescription] = useState('');
    const [createUniqueCode, setCreateUniqueCode] = useState('');
    const [createChapters, setCreateChapters] = useState(3);
    const [createPrefix, setCreatePrefix] = useState('');
    const [createTOC, setCreateTOC] = useState('true');
    const [createIndentation, setCreateIndentation] = useState('true');
    const [zipBackupFile, setZipBackupFile] = useState<File | null>(null);
    const [zipBackupFileName, setZipBackupFileName] = useState('');
    const [zipProjectTitle, setZipProjectTitle] = useState('');
    const [zipDescription, setZipDescription] = useState('');
    const [zipUniqueCode, setZipUniqueCode] = useState('');
    const [zipCreateTOC, setZipCreateTOC] = useState('true');
    const [zipCreateIndentation, setZipCreateIndentation] = useState('true');
    const [extendBackupFile, setExtendBackupFile] = useState<File | null>(null);
    const [extendBackupFileName, setExtendBackupFileName] = useState('');
    const [extendExtraChapters, setExtendExtraChapters] = useState(10);
    const [extendPrefix, setExtendPrefix] = useState('');
    const [mergeProjectTitle, setMergeProjectTitle] = useState('');
    const [mergeDescription, setMergeDescription] = useState('');
    const [mergeBackupFiles, setMergeBackupFiles] = useState<FileList | null>(null);
    const [mergeBackupFileNames, setMergeBackupFileNames] = useState('');
    const [mergePrefix, setMergePrefix] = useState('');
    const [frBackupFile, setFrBackupFile] = useState<File | null>(null);
    const [frBackupFileName, setFrBackupFileName] = useState('');
    const [findPattern, setFindPattern] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [useRegexBackup, setUseRegexBackup] = useState(false);
    const [currentMatchDisplay, setCurrentMatchDisplay] = useState('Load a backup file and enter a pattern to find.');
    const [frData, setFrData] = useState<BackupData | null>(null);

    const frPtrRef = useRef<FindReplacePointer>({ scene: 0, block: 0, offset: 0 });
    const frMatchRef = useRef<FindReplaceMatch | null>(null);

    const zipBackupFileInputRef = useRef<HTMLInputElement>(null);
    const frBackupFileInputRef = useRef<HTMLInputElement>(null);
    const extendBackupFileInputRef = useRef<HTMLInputElement>(null);
    const mergeBackupFilesInputRef = useRef<HTMLInputElement>(null);


    const handleCreateNewBackup = () => {
        toggleAppSpinner(true);
        try {
            if (!createProjectTitle || createChapters < 1) {
                showToast('Project Title and at least 1 chapter are required.', true);
                throw new Error('Validation failed for create new backup.');
            }
            const uniqueCode = createUniqueCode || Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
            const now = Date.now();
            const scenes: Scene[] = [];
            const sections: Section[] = [];
            for (let i = 1; i <= createChapters; i++) {
                const chapTitle = createPrefix ? createPrefix + i : i.toString();
                const sceneCode = 'scene' + i;
                scenes.push({
                    code: sceneCode, title: chapTitle,
                    text: JSON.stringify({ blocks: [{ type: 'text', align: 'left', text: '' }] }),
                    ranking: i, status: '1'
                });
                sections.push({
                    code: 'section' + i, title: chapTitle, synopsis: '', ranking: i,
                    section_scenes: [{ code: sceneCode, ranking: 1 }]
                });
            }
            const backup: BackupData = {
                version: 4, code: uniqueCode, title: createProjectTitle, description: createDescription,
                show_table_of_contents: createTOC === 'true',
                apply_automatic_indentation: createIndentation === 'true',
                last_update_date: now, last_backup_date: now,
                revisions: [{
                    number: 1, date: now,
                    book_progresses: [{ year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate(), word_count: 0 }],
                    statuses: [{ code: '1', title: 'Todo', color: -2697255, ranking: 1 }],
                    scenes, sections
                }]
            };
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            triggerBrowserDownload(blob, `${sanitizeFilenameForZip(createProjectTitle) || 'new_backup'}_file.json`);
            showToast('Backup file created successfully.');
        } catch (err: any) {
            if (err.message !== 'Validation failed for create new backup.') {
                showToast(err.message || 'Error creating backup.', true);
            }
        } finally {
            toggleAppSpinner(false);
        }
    };

    const handleCreateFromZip = async () => {
        if (!zipBackupFile) { showToast('Please upload a ZIP file.', true); return; }
        if (!zipProjectTitle) { showToast('Project Title is required.', true); return; }
        toggleAppSpinner(true);
        try {
            const zip = await JSZip.loadAsync(zipBackupFile);
            const scenes: Scene[] = [];
            const sections: Section[] = [];
            let chapterCounter = 0;
            const chapterFilePromises: Promise<{name: string, text: string}>[] = [];

            zip.forEach((relativePath: string, zipEntry: any) => {
                if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.txt')) {
                    chapterFilePromises.push(zipEntry.async('string').then((text: string) => ({ name: zipEntry.name, text })));
                }
            });
            const chapterFiles = await Promise.all(chapterFilePromises);
            chapterFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

            for (const chapterFile of chapterFiles) {
                chapterCounter++;
                const chapterTitle = chapterFile.name.replace(/\.txt$/i, '');
                const rawChapterText = chapterFile.text;
                const normalizedText = rawChapterText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                const contentSegments = normalizedText.split(/\n{2,}/).map(s => s.trim()).filter(s => s !== '');
                const blocks: any[] = [];
                for (let i = 0; i < contentSegments.length; i++) {
                    blocks.push({ type: 'text', align: 'left', text: contentSegments[i] });
                    if (i < contentSegments.length -1) blocks.push({ type: 'text', align: 'left', text: '' });
                }
                if (contentSegments.length === 0) {
                     if (rawChapterText.trim() === '' && rawChapterText.length > 0) { blocks.push({ type: 'text', align: 'left', text: '' }); }
                     else if (rawChapterText.trim() === '') { blocks.push({ type: 'text', align: 'left', text: '' });}
                }
                if (blocks.length === 0) { blocks.push({ type: 'text', align: 'left', text: '' });}

                const sceneText = JSON.stringify({ blocks });
                const sceneCode = `scene${chapterCounter}`;
                scenes.push({ code: sceneCode, title: chapterTitle, text: sceneText, ranking: chapterCounter, status: '1' });
                sections.push({ code: `section${chapterCounter}`, title: chapterTitle, synopsis: '', ranking: chapterCounter, section_scenes: [{ code: sceneCode, ranking: 1 }]});
            }
            if (scenes.length === 0) throw new Error('No .txt files found in the ZIP archive.');
            const uniqueCode = zipUniqueCode || Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
            const now = Date.now();
            let totalWordCount = 0;
            scenes.forEach(scene => { try { const c = JSON.parse(scene.text); c.blocks.forEach((b:any) => { if (b.type==='text'&&typeof b.text==='string'&&b.text.trim()){totalWordCount+=b.text.trim().split(/\s+/).length;}}); } catch(e){}});
            const backupData: BackupData = {
                version: 4, code: uniqueCode, title: zipProjectTitle, description: zipDescription,
                show_table_of_contents: zipCreateTOC === 'true', apply_automatic_indentation: zipCreateIndentation === 'true',
                last_update_date: now, last_backup_date: now,
                revisions: [{ number: 1, date: now, book_progresses: [{ year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate(), word_count: totalWordCount }], statuses: [{ code: '1', title: 'Todo', color: -2697255, ranking: 1 }], scenes, sections }]
            };
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            const safeFileName = sanitizeFilenameForZip(zipProjectTitle);
            triggerBrowserDownload(blob, `${safeFileName || 'backup_from_zip'}.json`);
            showToast(`Backup file created with ${scenes.length} chapter(s).`);
        } catch (err: any) { showToast(`Error: ${err.message}`, true);
        } finally { toggleAppSpinner(false); }
    };

    const handleExtendBackup = async () => {
        if (!extendBackupFile) {
            showToast('Please upload a backup file to extend.', true);
            return;
        }
        toggleAppSpinner(true);
        try {
            const fileContent = await extendBackupFile.text();
            const backup = JSON.parse(fileContent) as BackupData;
            const rev = backup.revisions?.[0];
            if (!rev || !rev.scenes || !rev.sections) {
                throw new Error('Invalid backup file structure for extending.');
            }

            const existingSceneCount = rev.scenes.length;
            const existingSectionCount = rev.sections.length; 

            for (let i = 1; i <= extendExtraChapters; i++) {
                const newSceneNum = existingSceneCount + i;
                const newSectionNum = existingSectionCount + i;

                const chapTitle = extendPrefix ? `${extendPrefix}${newSceneNum}` : `Chapter ${newSceneNum}`;
                const sceneCode = `scene${newSceneNum}`;
                
                rev.scenes.push({
                    code: sceneCode,
                    title: chapTitle,
                    text: JSON.stringify({ blocks: [{ type: 'text', align: 'left', text: '' }] }),
                    ranking: newSceneNum,
                    status: '1'
                });
                rev.sections.push({
                    code: `section${newSectionNum}`,
                    title: chapTitle,
                    synopsis: '',
                    ranking: newSectionNum,
                    section_scenes: [{ code: sceneCode, ranking: 1 }]
                });
            }
            const now = Date.now();
            backup.last_update_date = now;
            backup.last_backup_date = now;
            rev.date = now;

            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            triggerBrowserDownload(blob, `${sanitizeFilenameForZip(backup.title) || 'extended_backup'}.json`);
            showToast(`Backup extended with ${extendExtraChapters} chapters successfully.`);
        } catch (err: any) {
            showToast(`Error extending backup: ${err.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };

    const handleMergeBackups = async () => {
        if (!mergeBackupFiles || mergeBackupFiles.length < 1) { 
            showToast('Please select at least one backup file to merge/process.', true);
            return;
        }
        if (!mergeProjectTitle) {
            showToast('New Project Title is required for merging.', true);
            return;
        }
        toggleAppSpinner(true);
        try {
            let combinedScenes: Scene[] = [];
            let combinedSections: Section[] = [];
            let baseStatuses = [{ code: '1', title: 'Todo', color: -2697255, ranking: 1 }];
            let firstFileProcessed = false;

            for (const file of Array.from(mergeBackupFiles)) {
                try {
                    const fileContent = await file.text();
                    const data = JSON.parse(fileContent) as BackupData;
                    const rev = data.revisions?.[0];
                    if (rev) {
                        if (rev.scenes) combinedScenes.push(...rev.scenes);
                        if (rev.sections) combinedSections.push(...rev.sections);
                        if (!firstFileProcessed && rev.statuses && rev.statuses.length > 0) {
                            baseStatuses = rev.statuses;
                            firstFileProcessed = true;
                        }
                    }
                } catch (e: any) {
                    showToast(`Skipping file ${file.name} during merge (parse error: ${e.message}).`, true);
                }
            }

            combinedScenes.forEach((s, i) => {
                const n = i + 1;
                s.code = `scene${n}`;
                s.title = mergePrefix ? `${mergePrefix}${n}` : (s.title || `Chapter ${n}`);
                s.ranking = n;
            });
            combinedSections.forEach((s, i) => {
                const n = i + 1;
                s.code = `section${n}`;
                s.title = mergePrefix ? `${mergePrefix}${n}` : (s.title || `Chapter ${n}`);
                s.ranking = n;
                if (s.section_scenes && s.section_scenes[0]) {
                    s.section_scenes[0].code = `scene${n}`;
                    s.section_scenes[0].ranking = 1;
                } else if (s.section_scenes) { 
                    s.section_scenes = [{ code: `scene${n}`, ranking: 1}];
                }

            });

            if (combinedScenes.length === 0) {
                 throw new Error('No valid chapters found in the selected files to merge.');
            }

            const now = Date.now();
            let totalWordCount = 0;
            combinedScenes.forEach(scene => {
                try {
                    const sceneContent = JSON.parse(scene.text);
                    sceneContent.blocks.forEach((block: any) => {
                        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                            totalWordCount += block.text.trim().split(/\s+/).length;
                        }
                    });
                } catch (e) { /* ignore word count error */ }
            });

            const mergedBackup: BackupData = {
                version: 4,
                code: generateUUID().substring(0, 8), 
                title: mergeProjectTitle,
                description: mergeDescription,
                show_table_of_contents: true, 
                apply_automatic_indentation: true, 
                last_update_date: now,
                last_backup_date: now,
                revisions: [{
                    number: 1, date: now,
                    book_progresses: [{ year: new Date().getFullYear(), month: new Date().getMonth() + 1, day: new Date().getDate(), word_count: totalWordCount }],
                    statuses: baseStatuses,
                    scenes: combinedScenes,
                    sections: combinedSections
                }]
            };
            const blob = new Blob([JSON.stringify(mergedBackup, null, 2)], { type: 'application/json' });
            triggerBrowserDownload(blob, `${sanitizeFilenameForZip(mergeProjectTitle) || 'merged_backup'}.json`);
            showToast('Backup files merged successfully.');

        } catch (err: any) {
            showToast(`Error merging backups: ${err.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };
    
    const findNextMatchInternal = (pattern: string, useRegex: boolean, currentFrData: BackupData, currentFrPtr: FindReplacePointer): FindReplaceMatch | null => {
        if (!currentFrData?.revisions?.[0]?.scenes) return null;
        const scenes = currentFrData.revisions[0].scenes;
        let tempPtr = { ...currentFrPtr };

        if (typeof tempPtr.scene !== 'number' || tempPtr.scene < 0 || isNaN(tempPtr.scene)) tempPtr = { scene: 0, block: 0, offset: 0 };
        if (tempPtr.scene >= scenes.length) return null;

        for (let i = tempPtr.scene; i < scenes.length; i++) {
            const sceneObj = scenes[i];
            if (!sceneObj || typeof sceneObj.text !== 'string' || sceneObj.text.trim() === '') {
                if (i === tempPtr.scene) { tempPtr.block = 0; tempPtr.offset = 0; }
                continue;
            }
            let blocks;
            try {
                const parsedText = JSON.parse(sceneObj.text);
                blocks = parsedText.blocks;
                if (!Array.isArray(blocks)) blocks = [];
            } catch (e) {
                if (i === tempPtr.scene) { tempPtr.block = 0; tempPtr.offset = 0; }
                continue;
            }

            for (let j = (i === tempPtr.scene ? tempPtr.block : 0); j < blocks.length; j++) {
                const block = blocks[j];
                if (!block || block.type !== 'text' || typeof block.text !== 'string') {
                    if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = 0; }
                    continue;
                }
                const blockText = block.text;
                let searchStart = (i === tempPtr.scene && j === tempPtr.block ? tempPtr.offset : 0);
                if (isNaN(searchStart) || searchStart < 0) searchStart = 0;


                if (searchStart >= blockText.length && blockText.length > 0) {
                    if (i === tempPtr.scene && j === tempPtr.block) tempPtr.offset = 0;
                    continue; 
                }
                 if (!pattern && !useRegex) { 
                    if (i === tempPtr.scene && j === tempPtr.block) tempPtr.offset = 0; 
                    continue;
                }
                let matchResult: RegExpExecArray | null = null;
                let matchIndex = -1;
                let matchLength = 0;

                try {
                    if (useRegex) {
                        const regex = new RegExp(pattern, 'g');
                        regex.lastIndex = searchStart;
                        matchResult = regex.exec(blockText);
                        if (matchResult) { 
                            matchIndex = matchResult.index;
                            matchLength = matchResult[0].length;
                            if (matchLength === 0 && regex.lastIndex === searchStart) {
                                regex.lastIndex++; 
                            }
                        }
                    } else {
                        matchIndex = blockText.indexOf(pattern, searchStart);
                        if (matchIndex !== -1) {
                            matchLength = pattern.length;
                        }
                    }
                } catch (e: any) {
                    showToast(`Regex Error: ${e.message}`, true);
                    return null; 
                }

                if (matchIndex !== -1) { 
                    const lines = blockText.split('\n');
                    let charCount = 0;
                    let matchLine = '';
                    for (const line of lines) {
                        if (matchIndex >= charCount && matchIndex <= charCount + line.length) { 
                            matchLine = line;
                            break;
                        }
                        charCount += line.length + 1;
                    }
                    frPtrRef.current = { scene: i, block: j, offset: matchIndex + (matchLength > 0 ? matchLength : 1) }; 
                    return {
                        sceneIndex: i, blockIndex: j, matchIndex: matchIndex, matchLength: matchLength,
                        chapterTitle: sceneObj.title || `Scene ${i + 1}`, matchLine: matchLine,
                    };
                }
                if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = 0; }
            }
            if (i === tempPtr.scene) { tempPtr.block = 0; tempPtr.offset = 0; }
        }
        return null;
    };
    
    const findPreviousMatchInternal = (pattern: string, useRegex: boolean, currentFrData: BackupData, currentFrPtr: FindReplacePointer): FindReplaceMatch | null => {
        if (!currentFrData?.revisions?.[0]?.scenes) return null;
        const scenes = currentFrData.revisions[0].scenes;
        let tempPtr = { ...currentFrPtr };

        if (typeof tempPtr.scene !== 'number' || isNaN(tempPtr.scene) || tempPtr.scene >= scenes.length) {
             tempPtr = { scene: scenes.length - 1, block: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER };
        }
        if(tempPtr.scene < 0) return null;


        for (let i = tempPtr.scene; i >= 0; i--) {
            const sceneObj = scenes[i];
             if (!sceneObj || typeof sceneObj.text !== 'string' || sceneObj.text.trim() === '') {
                if (i === tempPtr.scene) { tempPtr.block = Number.MAX_SAFE_INTEGER; tempPtr.offset = Number.MAX_SAFE_INTEGER; }
                continue;
            }
            let blocks;
            try {
                const parsedText = JSON.parse(sceneObj.text);
                blocks = parsedText.blocks;
                if (!Array.isArray(blocks)) blocks = [];
            } catch (e) {
                if (i === tempPtr.scene) { tempPtr.block = Number.MAX_SAFE_INTEGER; tempPtr.offset = Number.MAX_SAFE_INTEGER; }
                continue;
            }

            const startBlock = (i === tempPtr.scene ? Math.min(tempPtr.block, blocks.length - 1) : blocks.length - 1);

            for (let j = startBlock; j >= 0; j--) {
                const block = blocks[j];
                 if (!block || block.type !== 'text' || typeof block.text !== 'string') {
                    if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = Number.MAX_SAFE_INTEGER; }
                    continue;
                }
                const blockText = block.text;
                const searchEnd = (i === tempPtr.scene && j === tempPtr.block ? tempPtr.offset : blockText.length);
                
                if (searchEnd <= 0 && blockText.length > 0) {
                    if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = Number.MAX_SAFE_INTEGER; }
                    continue;
                }
                if (!pattern && !useRegex) {
                    if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = Number.MAX_SAFE_INTEGER; }
                     continue;
                }

                let matchesInBlock: {index: number, length: number}[] = [];
                try {
                    if (useRegex) {
                        const regex = new RegExp(pattern, 'g');
                        let match;
                        while ((match = regex.exec(blockText)) !== null) {
                            if (match.index < searchEnd) {
                                matchesInBlock.push({ index: match.index, length: match[0].length });
                            } else {
                                break; 
                            }
                            if (regex.lastIndex === match.index && match[0].length === 0) regex.lastIndex++; 
                        }
                    } else {
                        let currentIdx = -1;
                        while ((currentIdx = blockText.indexOf(pattern, currentIdx + 1)) !== -1 && currentIdx < searchEnd) {
                            matchesInBlock.push({ index: currentIdx, length: pattern.length });
                        }
                    }
                } catch (e: any) {
                    showToast(`Regex Error: ${e.message}`, true);
                    return null;
                }


                if (matchesInBlock.length > 0) {
                    const lastMatch = matchesInBlock[matchesInBlock.length - 1];
                    const lines = blockText.split('\n');
                    let charCount = 0;
                    let matchLine = '';
                    for (const line of lines) {
                        if (lastMatch.index >= charCount && lastMatch.index <= charCount + line.length) {
                            matchLine = line;
                            break;
                        }
                        charCount += line.length + 1;
                    }
                    frPtrRef.current = { scene: i, block: j, offset: lastMatch.index }; 
                    return {
                        sceneIndex: i, blockIndex: j, matchIndex: lastMatch.index, matchLength: lastMatch.length,
                        chapterTitle: sceneObj.title || `Scene ${i + 1}`, matchLine: matchLine,
                    };
                }
                if (i === tempPtr.scene && j === tempPtr.block) { tempPtr.offset = Number.MAX_SAFE_INTEGER; }
            }
            if (i === tempPtr.scene) { tempPtr.block = Number.MAX_SAFE_INTEGER; tempPtr.offset = Number.MAX_SAFE_INTEGER; }
        }
        return null;
    };


    const handleZipBackupFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setZipBackupFile(file);
            setZipBackupFileName(file.name);
        } else {
            setZipBackupFile(null);
            setZipBackupFileName('');
        }
    };
    
    const handleFrBackupFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setFrBackupFile(file);
            setFrBackupFileName(file.name);
            toggleAppSpinner(true);
            try {
                const fileContent = await file.text();
                const parsedData = JSON.parse(fileContent) as BackupData;
                if (parsedData && parsedData.revisions && parsedData.revisions[0] && parsedData.revisions[0].scenes) {
                     setFrData(parsedData);
                     frPtrRef.current = { scene: 0, block: 0, offset: 0 }; 
                     frMatchRef.current = null;
                     setCurrentMatchDisplay('Backup loaded. Enter pattern and find.');
                     showToast("Backup file loaded for Find/Replace.", false);
                } else {
                    throw new Error("Invalid backup file structure.");
                }
            } catch (err: any) {
                showToast(`Error loading backup: ${err.message}`, true);
                setFrData(null);
                setFrBackupFile(null);
                setFrBackupFileName('');
                setCurrentMatchDisplay('Error loading backup file.');
            } finally {
                toggleAppSpinner(false);
            }
        } else {
            setFrBackupFile(null);
            setFrBackupFileName('');
            setFrData(null);
            setCurrentMatchDisplay('Load a backup file and enter a pattern to find.');
        }
    };

    const handleExtendBackupFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setExtendBackupFile(file);
            setExtendBackupFileName(file.name);
        } else {
            setExtendBackupFile(null);
            setExtendBackupFileName('');
        }
    };

    const handleMergeBackupFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            setMergeBackupFiles(e.target.files);
            setMergeBackupFileNames(Array.from(e.target.files).map(f => f.name).join(', '));
        } else {
            setMergeBackupFiles(null);
            setMergeBackupFileNames('');
        }
    };

    const handleFindNextMatch = () => {
        if (!frData) { showToast("No backup data loaded.", true); return; }
        if (!findPattern && !useRegexBackup) { showToast("Find pattern cannot be empty for plain text search.", true); return; }
        toggleAppSpinner(true);
        const match = findNextMatchInternal(findPattern, useRegexBackup, frData, frPtrRef.current);
        frMatchRef.current = match;
        if (match) {
            setCurrentMatchDisplay(`Match found in: "${match.chapterTitle}"\nLine: "${match.matchLine}"`);
        } else {
            setCurrentMatchDisplay(`No more matches found for "${findPattern}". Searched from current position.`);
        }
        toggleAppSpinner(false);
    };
    
    const handleFindPreviousMatch = () => {
        if (!frData) { showToast("No backup data loaded.", true); return; }
        if (!findPattern && !useRegexBackup) { showToast("Find pattern cannot be empty for plain text search.", true); return; }
        toggleAppSpinner(true);
        const match = findPreviousMatchInternal(findPattern, useRegexBackup, frData, frPtrRef.current);
        frMatchRef.current = match;
        if (match) {
            setCurrentMatchDisplay(`Match found in: "${match.chapterTitle}"\nLine: "${match.matchLine}"`);
        } else {
            setCurrentMatchDisplay(`No previous matches found for "${findPattern}". Searched from current position.`);
        }
        toggleAppSpinner(false);
    };


    const handleReplaceMatch = () => {
        if (!frData || !frMatchRef.current) {
            showToast("No current match to replace. Use \"Find Next\" first.", true);
            return;
        }
        toggleAppSpinner(true);
        try {
            const match = frMatchRef.current;
            const newFrData = JSON.parse(JSON.stringify(frData)) as BackupData; 
            const scene = newFrData.revisions[0].scenes[match.sceneIndex];
            const blocks = JSON.parse(scene.text).blocks;
            const blockToChange = blocks[match.blockIndex];
            const oldText = blockToChange.text as string;
            blockToChange.text = oldText.substring(0, match.matchIndex) + replaceText + oldText.substring(match.matchIndex + match.matchLength);
            scene.text = JSON.stringify({ blocks });
            setFrData(newFrData);
            showToast("Match replaced. Find next or save.", false);
            frPtrRef.current = { 
                scene: match.sceneIndex, 
                block: match.blockIndex, 
                offset: match.matchIndex + replaceText.length 
            };
            frMatchRef.current = null; 
            setCurrentMatchDisplay("Match replaced. Find next to continue.");
            // Optionally auto-find next after replace
            // handleFindNextMatch(); 
        } catch (e: any) {
            showToast(`Error replacing text: ${e.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };

    const handleReplaceAllMatches = async () => {
        if (!frData) { showToast("No backup data loaded.", true); return; }
        if (!findPattern && !useRegexBackup) { showToast("Find pattern cannot be empty for plain text search.", true); return; }
        toggleAppSpinner(true);
        let replacementsCount = 0;
        const tempFrData = JSON.parse(JSON.stringify(frData)) as BackupData; 
        const scenes = tempFrData.revisions[0].scenes;

        for (const scene of scenes) {
            try {
                let sceneModified = false;
                const sceneContent = JSON.parse(scene.text);
                for (const block of sceneContent.blocks) {
                    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                        let originalBlockText = block.text;
                        let newBlockText = "";
                        let lastIndex = 0;
                        if (useRegexBackup) {
                            const regex = new RegExp(findPattern, 'g');
                            newBlockText = originalBlockText.replace(regex, (match) => {
                                replacementsCount++;
                                sceneModified = true;
                                return replaceText;
                            });
                        } else {
                            let foundIndex = originalBlockText.indexOf(findPattern, lastIndex);
                            while (foundIndex !== -1) {
                                newBlockText += originalBlockText.substring(lastIndex, foundIndex) + replaceText;
                                lastIndex = foundIndex + findPattern.length;
                                replacementsCount++;
                                sceneModified = true;
                                foundIndex = originalBlockText.indexOf(findPattern, lastIndex);
                            }
                            newBlockText += originalBlockText.substring(lastIndex);
                        }
                        if (sceneModified) block.text = newBlockText;
                    }
                }
                if (sceneModified) scene.text = JSON.stringify(sceneContent);
            } catch (e: any) {
                 showToast(`Error processing scene "${scene.title}" during Replace All: ${e.message}`, true);
            }
        }
        
        if (replacementsCount > 0) {
            const now = Date.now();
            tempFrData.last_update_date = now;
            tempFrData.last_backup_date = now;
            if(tempFrData.revisions[0]) tempFrData.revisions[0].date = now;
            setFrData(tempFrData);
        }
        
        frPtrRef.current = { scene: 0, block: 0, offset: 0 }; 
        frMatchRef.current = null;
        setCurrentMatchDisplay(`${replacementsCount} match(es) replaced. Save the backup if needed.`);
        showToast(`${replacementsCount} replacement(s) made.`, false);
        toggleAppSpinner(false);
    };
    
    const handleSaveFrChanges = () => {
        if (!frData || !frBackupFile) {
            showToast("No data or original file to save changes to.", true);
            return;
        }
        toggleAppSpinner(true);
        try {
            const blob = new Blob([JSON.stringify(frData, null, 2)], { type: 'application/json' });
            triggerBrowserDownload(blob, frBackupFileName || "updated_backup.json");
            showToast("Changes saved. Download initiated.", false);
        } catch (e: any) {
            showToast(`Error saving changes: ${e.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };

    return (
        <div id="backupUtilityApp" className="card tool-section">
            <h1>Backup Utility</h1>
            <div className="mode-section">
                <label htmlFor="backupOperationSelect">Operation:</label>
                <select id="backupOperationSelect" value={operation} onChange={e => setOperation(e.target.value)}>
                    <option value="create">Create New Backup</option>
                    <option value="createFromZip">Create from ZIP</option>
                    <option value="extend">Extend Backup</option>
                    <option value="merge">Merge Backups</option>
                    <option value="findReplace">Find & Replace in Backup</option>
                </select>
            </div>

            {operation === 'create' && (
                <div className="options-section">
                    <h2>Create New Backup</h2>
                    <div className="option-group">
                        <label htmlFor="createProjectTitle">Project Title:</label>
                        <input type="text" id="createProjectTitle" value={createProjectTitle} onChange={e => setCreateProjectTitle(e.target.value)} placeholder="My Awesome Novel" />
                    </div>
                    <div className="option-group">
                        <label htmlFor="createDescription">Description:</label>
                        <textarea id="createDescription" value={createDescription} onChange={e => setCreateDescription(e.target.value)} placeholder="A short description..." />
                    </div>
                    <div className="option-group">
                        <label htmlFor="createUniqueCode">Unique Code (optional):</label>
                        <input type="text" id="createUniqueCode" value={createUniqueCode} onChange={e => setCreateUniqueCode(e.target.value)} placeholder="Auto-generated if blank" />
                    </div>
                    <div className="option-group">
                        <label htmlFor="createChapters">Number of Chapters:</label>
                        <input type="number" id="createChapters" min="1" value={createChapters} onChange={e => setCreateChapters(parseInt(e.target.value, 10) || 1)} />
                    </div>
                    <div className="option-group">
                        <label htmlFor="createPrefix">Chapter Prefix (optional):</label>
                        <input type="text" id="createPrefix" value={createPrefix} onChange={e => setCreatePrefix(e.target.value)} placeholder="Chapter " />
                    </div>
                    <div className="option-group">
                        <label htmlFor="createTOC">Show Table of Contents:</label>
                        <select id="createTOC" value={createTOC} onChange={e => setCreateTOC(e.target.value)}>
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <div className="option-group">
                        <label htmlFor="createIndentation">Apply Automatic Indentation:</label>
                        <select id="createIndentation" value={createIndentation} onChange={e => setCreateIndentation(e.target.value)}>
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <button className="btn btn-primary" onClick={handleCreateNewBackup}>Create New Backup File</button>
                </div>
            )}

            {operation === 'createFromZip' && (
                <div className="options-section">
                    <h2>Create Backup from ZIP (.txt files)</h2>
                    <div className="upload-section">
                        <label htmlFor="zipBackupFileUpload" className="btn upload-btn">Upload ZIP File</label>
                        <input type="file" id="zipBackupFileUpload" accept=".zip" style={{ display: 'none' }} onChange={handleZipBackupFileChange} ref={zipBackupFileInputRef} />
                        <div className="file-name-display" aria-live="polite">{zipBackupFileName}</div>
                    </div>
                    <div className="option-group">
                        <label htmlFor="zipProjectTitle">Project Title:</label>
                        <input type="text" id="zipProjectTitle" value={zipProjectTitle} onChange={e => setZipProjectTitle(e.target.value)} placeholder="Novel from Texts" />
                    </div>
                     <div className="option-group">
                        <label htmlFor="zipDescription">Description:</label>
                        <textarea id="zipDescription" value={zipDescription} onChange={e => setZipDescription(e.target.value)} placeholder="A short description..." />
                    </div>
                    <div className="option-group">
                        <label htmlFor="zipUniqueCode">Unique Code (optional):</label>
                        <input type="text" id="zipUniqueCode" value={zipUniqueCode} onChange={e => setZipUniqueCode(e.target.value)} placeholder="Auto-generated if blank" />
                    </div>
                    <div className="option-group">
                        <label htmlFor="zipCreateTOC">Show Table of Contents:</label>
                        <select id="zipCreateTOC" value={zipCreateTOC} onChange={e => setZipCreateTOC(e.target.value)}>
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <div className="option-group">
                        <label htmlFor="zipCreateIndentation">Apply Automatic Indentation:</label>
                        <select id="zipCreateIndentation" value={zipCreateIndentation} onChange={e => setZipCreateIndentation(e.target.value)}>
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                        </select>
                    </div>
                    <button className="btn btn-primary" onClick={handleCreateFromZip} disabled={!zipBackupFile || !zipProjectTitle}>Create Backup from ZIP</button>
                </div>
            )}

            {operation === 'extend' && (
                 <div className="options-section">
                    <h2>Extend Existing Backup</h2>
                     <div className="upload-section">
                        <label htmlFor="extendBackupFileUpload" className="btn upload-btn">Upload Backup File (.json)</label>
                        <input type="file" id="extendBackupFileUpload" accept=".json" style={{ display: 'none' }} onChange={handleExtendBackupFileChange} ref={extendBackupFileInputRef} />
                        <div className="file-name-display" aria-live="polite">{extendBackupFileName}</div>
                    </div>
                    <div className="option-group">
                        <label htmlFor="extendExtraChapters">Extra Chapters to Add:</label>
                        <input type="number" id="extendExtraChapters" min="1" value={extendExtraChapters} onChange={e => setExtendExtraChapters(parseInt(e.target.value, 10) || 1)} />
                    </div>
                    <div className="option-group">
                        <label htmlFor="extendPrefix">New Chapter Prefix (optional):</label>
                        <input type="text" id="extendPrefix" value={extendPrefix} onChange={e => setExtendPrefix(e.target.value)} placeholder="Appendix " />
                    </div>
                    <button className="btn btn-primary" onClick={handleExtendBackup} disabled={!extendBackupFile}>Extend Backup</button>
                 </div>
            )}
            
            {operation === 'merge' && (
                 <div className="options-section">
                    <h2>Merge Backup Files</h2>
                    <div className="upload-section">
                        <label htmlFor="mergeBackupFilesUpload" className="btn upload-btn">Upload Backup Files (.json)</label>
                        <input type="file" id="mergeBackupFilesUpload" accept=".json" multiple style={{ display: 'none' }} onChange={handleMergeBackupFilesChange} ref={mergeBackupFilesInputRef} />
                        <div className="file-name-display" aria-live="polite">{mergeBackupFileNames}</div>
                    </div>
                     <div className="option-group">
                        <label htmlFor="mergeProjectTitle">New Project Title:</label>
                        <input type="text" id="mergeProjectTitle" value={mergeProjectTitle} onChange={e => setMergeProjectTitle(e.target.value)} placeholder="Merged Novel" />
                    </div>
                    <div className="option-group">
                        <label htmlFor="mergeDescription">New Description:</label>
                        <textarea id="mergeDescription" value={mergeDescription} onChange={e => setMergeDescription(e.target.value)} placeholder="Combined from multiple sources." />
                    </div>
                    <div className="option-group">
                        <label htmlFor="mergePrefix">Chapter Prefix for Merged Sections (optional):</label>
                        <input type="text" id="mergePrefix" value={mergePrefix} onChange={e => setMergePrefix(e.target.value)} placeholder="BookX-" />
                    </div>
                    <button className="btn btn-primary" onClick={handleMergeBackups} disabled={!mergeBackupFiles || mergeBackupFiles.length < 1}>Merge Backups</button>
                 </div>
            )}

            {operation === 'findReplace' && (
                <div className="options-section" id="findReplaceSection">
                    <h2>Find & Replace in Backup</h2>
                    <div className="upload-section">
                        <label htmlFor="frBackupFileUpload" className="btn upload-btn">Upload Backup File (.json)</label>
                        <input type="file" id="frBackupFileUpload" accept=".json" style={{ display: 'none' }} onChange={handleFrBackupFileChange} ref={frBackupFileInputRef} />
                        <div className="file-name-display" aria-live="polite">{frBackupFileName}</div>
                    </div>
                    <div className="option-group">
                        <label htmlFor="findPatternFR">Find:</label>
                        <input type="text" id="findPatternFR" value={findPattern} onChange={e => setFindPattern(e.target.value)} />
                    </div>
                    <div className="option-group">
                        <label htmlFor="replaceTextFR">Replace with:</label>
                        <input type="text" id="replaceTextFR" value={replaceText} onChange={e => setReplaceText(e.target.value)} />
                    </div>
                    <div className="option-group">
                        <label className="checkbox-label-wrapper" htmlFor="useRegexBackupInput">
                          <input type="checkbox" id="useRegexBackupInput" checked={useRegexBackup} onChange={e => setUseRegexBackup(e.target.checked)} />
                           Use Regular Expressions
                        </label>
                    </div>
                    <div className="fr-match-display" role="status">{currentMatchDisplay}</div>
                    <div className="button-group">
                        <button className="btn btn-accent" onClick={handleFindPreviousMatch} disabled={!frData || (!findPattern && !useRegexBackup) }>Find Previous</button>
                        <button className="btn btn-accent" onClick={handleFindNextMatch} disabled={!frData || (!findPattern && !useRegexBackup)}>Find Next</button>
                    </div>
                     <div className="button-group">
                        <button className="btn btn-primary" onClick={handleReplaceMatch} disabled={!frMatchRef.current || !frData}>Replace This</button>
                        <button className="btn btn-primary" onClick={handleReplaceAllMatches} disabled={!frData || (!findPattern && !useRegexBackup)}>Replace All & Download</button>
                    </div>
                     <div className="button-group">
                         <button className="btn btn-accent" onClick={handleSaveFrChanges} disabled={!frData}>Save Changes (Download)</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const ZipToEpubTool: React.FC<ToolProps> = ({ showToast, toggleAppSpinner }) => {
    const [selectedZipFile, setSelectedZipFile] = useState<File | null>(null);
    const [zipFileName, setZipFileName] = useState('');
    const [epubTitle, setEpubTitle] = useState('My Novel');
    const [epubAuthor, setEpubAuthor] = useState('Unknown Author');
    const [epubLanguage, setEpubLanguage] = useState('en');
    const [selectedCoverFile, setSelectedCoverFile] = useState<File | null>(null);
    const [epubCoverFileName, setEpubCoverFileName] = useState('');
    const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [downloadFilename, setDownloadFilename] = useState<string>('');
    
    const zipUploadInputRef = useRef<HTMLInputElement>(null);
    const coverImageInputRef = useRef<HTMLInputElement>(null);

    const handleZipFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedZipFile(file);
            setZipFileName(`Selected ZIP: ${file.name}`);
            setStatusMessage(null); setDownloadUrl(null);
        }
    };
    const handleCoverFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setSelectedCoverFile(file);
            setEpubCoverFileName(`Cover: ${file.name}`);
        } else {
            setSelectedCoverFile(null);
            setEpubCoverFileName('');
        }
    };

    const handleCreateEpub = async () => {
        if (!selectedZipFile) {
            showToast("Please upload a ZIP file containing chapter .txt files.", true);
            return;
        }
        toggleAppSpinner(true);
        setStatusMessage(null); setDownloadUrl(null);
        try {
            const title = epubTitle.trim() || "Untitled EPUB";
            const author = epubAuthor.trim() || "Unknown Author";
            const language = epubLanguage.trim() || "en";
            const bookUUID = `urn:uuid:${generateUUID()}`;
            const epubZip = new JSZip();
            epubZip.file("mimetype", "application/epub+zip", { compression: "STORE" });
            const containerXML = `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
            epubZip.folder("META-INF")?.file("container.xml", containerXML);
            const oebps = epubZip.folder("OEBPS");
            oebps?.folder("css")?.file("style.css", `body { font-family: sans-serif; line-height: 1.5; margin: 1em; } h1, h2, h3 { text-align: center; } p { text-indent: 1.5em; margin-top: 0; margin-bottom: 0.5em; } .cover { text-align: center; margin-top: 20%; } .cover img { max-width: 80%; max-height: 80vh; }`);
            const textFolder = oebps?.folder("text");
            const imagesFolder = oebps?.folder("images");
            const contentZip = await JSZip.loadAsync(selectedZipFile);
            const chapterPromises: Promise<{ name: string, originalName: string, content: string }>[] = [];
            contentZip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.txt')) {
                    chapterPromises.push(zipEntry.async('string').then(text => ({ name: zipEntry.name, originalName: relativePath, content: text })));
                }
            });
            let chapters = await Promise.all(chapterPromises);
            if (chapters.length === 0) throw new Error("No .txt files found in the uploaded ZIP.");
            chapters.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

            const manifestItems: any[] = [ { id: "css", href: "css/style.css", "media-type": "text/css" }, { id: "nav", href: "nav.xhtml", "media-type": "application/xhtml+xml", properties: "nav" }];
            const spineItems: any[] = [];
            const navLiItems: string[] = [];
            const ncxNavPoints: string[] = [];
            let playOrder = 1;
            let coverImageFilename: string | null = null;
            let coverXHTMLAdded = false;

            if (selectedCoverFile && imagesFolder) {
                const coverExt = selectedCoverFile.name.split('.').pop()?.toLowerCase() || 'png';
                coverImageFilename = `cover.${coverExt}`;
                const coverMediaType = coverExt === 'jpg' || coverExt === 'jpeg' ? 'image/jpeg' : 'image/png';
                const coverImageData = await selectedCoverFile.arrayBuffer();
                imagesFolder.file(coverImageFilename, coverImageData);
                manifestItems.push({ id: "cover-image", href: `images/${coverImageFilename}`, "media-type": coverMediaType, properties: "cover-image" });
                const coverXHTMLContent = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}"><head><title>Cover</title><link rel="stylesheet" type="text/css" href="../css/style.css" /></head><body><section epub:type="cover" class="cover"><img src="../images/${coverImageFilename}" alt="Cover Image"/></section></body></html>`;
                textFolder?.file("cover.xhtml", coverXHTMLContent);
                manifestItems.push({ id: "cover-page", href: "text/cover.xhtml", "media-type": "application/xhtml+xml" });
                spineItems.push({ idref: "cover-page", linear: "no" });
                coverXHTMLAdded = true;
            }

            for (let i = 0; i < chapters.length; i++) {
                const chapter = chapters[i];
                const chapterBaseName = sanitizeForXML(chapter.name.replace(/\.txt$/i, '')) || `chapter_${i + 1}`;
                const chapterFilename = `${chapterBaseName}.xhtml`;
                const chapterTitle = chapter.name.replace(/\.txt$/i, '').replace(/_/g, ' ');
                const xhtmlContent = textToXHTML(chapter.content, chapterTitle, language);
                textFolder?.file(chapterFilename, xhtmlContent);
                const itemId = `chapter-${i + 1}`;
                manifestItems.push({ id: itemId, href: `text/${chapterFilename}`, "media-type": "application/xhtml+xml" });
                spineItems.push({ idref: itemId, linear: "yes" });
                navLiItems.push(`<li><a href="text/${chapterFilename}">${escapeHTML(chapterTitle)}</a></li>`);
                ncxNavPoints.push(`<navPoint id="navpoint-${playOrder}" playOrder="${playOrder}"><navLabel><text>${escapeHTML(chapterTitle)}</text></navLabel><content src="text/${chapterFilename}"/></navPoint>`);
                playOrder++;
            }
            const navXHTMLContent = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}"><head><title>Table of Contents</title><link rel="stylesheet" type="text/css" href="css/style.css"/></head><body><nav epub:type="toc" id="toc"><h1>Table of Contents</h1><ol>${navLiItems.join("\n      ")}</ol></nav><nav epub:type="landmarks" hidden="hidden"><ol>${coverXHTMLAdded ? '<li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>' : ''}<li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li><li><a epub:type="bodymatter" href="text/${sanitizeForXML(chapters[0].name.replace(/\.txt$/i, '')) || 'chapter_1'}.xhtml">Start Reading</a></li></ol></nav></body></html>`;
            oebps?.file("nav.xhtml", navXHTMLContent);
            const ncxContent = `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${bookUUID}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${escapeHTML(title)}</text></docTitle><navMap>${ncxNavPoints.join("\n    ")}</navMap></ncx>`;
            oebps?.file("toc.ncx", ncxContent);
            manifestItems.push({ id: "ncx", href: "toc.ncx", "media-type": "application/x-dtbncx+xml" });
            let manifestXML = manifestItems.map(item => `<item id="${item.id}" href="${item.href}" media-type="${item['media-type']}"${item.properties ? ` properties="${item.properties}"` : ''}/>`).join("\n    ");
            let spineXML = spineItems.map(item => `<itemref idref="${item.idref}"${item.linear ? ` linear="${item.linear}"` : ''}/>`).join("\n    ");
            
            const contentOPF = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:identifier id="BookId">${bookUUID}</dc:identifier><dc:title>${escapeHTML(title)}</dc:title><dc:language>${language}</dc:language><dc:creator id="creator">${escapeHTML(author)}</dc:creator><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>${selectedCoverFile ? '<meta name="cover" content="cover-image"/>' : ''}</metadata><manifest>${manifestXML}</manifest><spine toc="ncx">${spineXML}</spine></package>`;
            oebps?.file("content.opf", contentOPF);
            const epubBlob = await epubZip.generateAsync({ type: "blob", mimeType: "application/epub+zip", compression: "DEFLATE" });
            const newDownloadUrl = URL.createObjectURL(epubBlob);
            setDownloadUrl(newDownloadUrl);
            const safeFileName = sanitizeFilenameForZip(title) || 'generated_epub';
            setDownloadFilename(`${safeFileName}.epub`);
            setStatusMessage({ text: `EPUB "${title}" created successfully with ${chapters.length} chapter(s).`, type: 'success' });
            showToast("EPUB created successfully!");
        } catch (err: any) {
            console.error("ZIP to EPUB Error:", err);
            setStatusMessage({ text: `Error: ${err.message}`, type: 'error' });
            showToast(`Error: ${err.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };

    return (
        <div id="zipToEpubApp" className="card tool-section">
            <h1>ZIP to EPUB Converter</h1>
            <div className="upload-section">
                <label htmlFor="zipUploadForEpubInput" className="btn upload-btn">Upload ZIP File (.zip with .txt chapters)</label>
                <input type="file" id="zipUploadForEpubInput" className="hidden-file-input" accept=".zip" onChange={handleZipFileChange} ref={zipUploadInputRef} />
                <div className="file-name-display" aria-live="polite">{zipFileName}</div>
            </div>
            <div className="options-section">
                <div className="option-group">
                    <label htmlFor="epubTitleInput">EPUB Title:</label>
                    <input type="text" id="epubTitleInput" placeholder="Enter EPUB title" value={epubTitle} onChange={e => setEpubTitle(e.target.value)} />
                </div>
                <div className="option-group">
                    <label htmlFor="epubAuthorInput">Author:</label>
                    <input type="text" id="epubAuthorInput" placeholder="Enter author name" value={epubAuthor} onChange={e => setEpubAuthor(e.target.value)} />
                </div>
                <div className="option-group">
                    <label htmlFor="epubLanguageInput">Language Code (e.g., en, es):</label>
                    <input type="text" id="epubLanguageInput" placeholder="en" value={epubLanguage} onChange={e => setEpubLanguage(e.target.value)} />
                </div>
                <div className="option-group">
                    <label htmlFor="epubCoverImageInput" className="file-upload-label" style={{maxWidth: '300px', margin: '10px auto'}}>Cover Image (Optional, JPG/PNG)</label>
                    <input type="file" id="epubCoverImageInput" className="hidden-file-input" accept="image/jpeg,image/png" onChange={handleCoverFileChange} ref={coverImageInputRef}/>
                    <div className="file-name-display" aria-live="polite">{epubCoverFileName}</div>
                </div>
            </div>
            <button className="btn split-btn" onClick={handleCreateEpub} disabled={!selectedZipFile}>Create EPUB</button>
            {statusMessage && (<div className={`status-message ${statusMessage.type}`} role="status">{statusMessage.text}</div>)}
            {downloadUrl && (<div className="download-section"><a href={downloadUrl} download={downloadFilename} className="btn download-btn">Download EPUB</a></div>)}
        </div>
    );
};


const EpubToZipTool: React.FC<ToolProps> = ({ showToast, toggleAppSpinner }) => {
    const [selectedEpubFile, setSelectedEpubFile] = useState<File | null>(null);
    const [epubFileName, setEpubFileName] = useState('');
    const [enableRemoveLines, setEnableRemoveLines] = useState(false);
    const [linesToRemove, setLinesToRemove] = useState(1);
    const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [downloadFilename, setDownloadFilename] = useState<string>('');
    
    const epubUploadInputRef = useRef<HTMLInputElement>(null);
    
    const resolvePath = (relativePath: string, baseDirPath: string): string => {
        if (!relativePath) return '';
        if (!baseDirPath) return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
        try {
            const baseUrl = `file:///${baseDirPath}/`; 
            const resolvedUrl = new URL(relativePath, baseUrl);
            return decodeURIComponent(resolvedUrl.pathname.substring(1)); 
        } catch (e) {
            return (baseDirPath + '/' + relativePath).replace(/\/+/g, '/'); 
        }
    };

    const readFileFromZip = async (zip: any, path: string): Promise<{path: string, content: string} | null> => {
        const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
        const fileEntry = zip.file(normalizedPath);
        if (!fileEntry) { console.error(`File not found in EPUB: ${normalizedPath}`); return null; }
        try {
            const content = await fileEntry.async('string');
            return { path: normalizedPath, content: content };
        } catch (err) { console.error(`Error reading file "${normalizedPath}" from zip:`, err); return null; }
    };
    
    const findOpfPath = async (zip: any): Promise<{path: string, dir: string} | null> => {
        const containerPath = 'META-INF/container.xml';
        const containerContent = await readFileFromZip(zip, containerPath);
        if (!containerContent) return null;
        const containerDoc = parseXml(containerContent.content, 'container.xml');
        if (!containerDoc) return null;
        const rootfilePath = containerDoc.querySelector('rootfile[full-path]')?.getAttribute('full-path');
        if (!rootfilePath) { console.error('Cannot find rootfile in container.xml'); return null; }
        const opfDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/')) : '';
        return { path: rootfilePath, dir: opfDir };
    };

    const findTocHref = (opfDoc: Document): {href: string, type: 'nav' | 'ncx'} | null => {
        const navItem = opfDoc.querySelector('manifest > item[properties~="nav"]');
        if (navItem) {
            const href = navItem.getAttribute('href');
            if (href) return { href: href, type: 'nav' };
        }
        const spineTocAttr = opfDoc.querySelector('spine[toc]');
        if (spineTocAttr) {
            const ncxId = spineTocAttr.getAttribute('toc');
            if (ncxId) {
                const ncxItem = opfDoc.querySelector(`manifest > item[id="${ncxId}"]`);
                const href = ncxItem?.getAttribute('href');
                if (href) return { href: href, type: 'ncx' };
            }
        }
        return null;
    };

    const extractChaptersFromNcx = (ncxDoc: Document, baseDir: string): {title: string, href: string}[] => {
        const chapters: {title: string, href: string}[] = [];
        ncxDoc.querySelectorAll('navMap navPoint').forEach(point => {
            const label = point.querySelector('navLabel > text')?.textContent?.trim();
            const contentSrc = point.querySelector('content')?.getAttribute('src');
            if (label && contentSrc) chapters.push({ title: label, href: resolvePath(contentSrc.split('#')[0], baseDir) });
        });
        return chapters;
    };
    
    const extractChaptersFromNav = (navDoc: Document, baseDir: string): {title: string, href: string}[] => {
        const chapters: {title: string, href: string}[] = [];
        let tocList = navDoc.querySelector('nav[epub\\:type="toc"] ol, nav#toc ol, nav.toc ol');
        if (!tocList && navDoc.body) tocList = navDoc.body.querySelector('ol');
        if (tocList) {
            tocList.querySelectorAll(':scope > li > a[href]').forEach(link => {
                const label = link.textContent?.replace(/\s+/g, ' ').trim();
                const rawHref = link.getAttribute('href');
                if (label && rawHref) chapters.push({ title: label, href: resolvePath(rawHref.split('#')[0], baseDir) });
            });
        }
        return chapters;
    };
    
    const deduplicateChapters = (chapters: {title: string, href: string}[]): {title: string, href: string}[] => {
        const uniqueChapters: {title: string, href: string}[] = [];
        const seenHrefs = new Set<string>();
        for (const chapter of chapters) {
            if (chapter.href && !seenHrefs.has(chapter.href)) {
                uniqueChapters.push(chapter);
                seenHrefs.add(chapter.href);
            }
        }
        return uniqueChapters;
    };

    const getChapterListFromEpub = async (zip: any): Promise<{title: string, href: string}[]> => {
        const opfPathData = await findOpfPath(zip);
        if (!opfPathData) { setStatusMessage({text:"Error: Could not find EPUB's OPF file.", type: 'error'}); return [];}
        const opfContentFile = await readFileFromZip(zip, opfPathData.path);
        if (!opfContentFile) { setStatusMessage({text:`Error: Could not read OPF file at ${opfPathData.path}`, type: 'error'}); return [];}
        const opfDoc = parseXml(opfContentFile.content, opfContentFile.path);
        if (!opfDoc) { setStatusMessage({text:`Error: Could not parse OPF XML at ${opfPathData.path}`, type: 'error'}); return [];}
        const tocInfo = findTocHref(opfDoc);
        if (!tocInfo) { setStatusMessage({text:"Warning: No standard ToC (NAV/NCX) link found in OPF.", type: 'error'}); return [];}
        const tocFullPath = resolvePath(tocInfo.href, opfPathData.dir);
        const tocContentFile = await readFileFromZip(zip, tocFullPath);
        if (!tocContentFile) { setStatusMessage({text:`Error: ToC file not found at ${tocFullPath}`, type: 'error'}); return [];}
        let chapters;
        if (tocInfo.type === 'ncx') {
            const ncxDoc = parseXml(tocContentFile.content, tocContentFile.path);
            chapters = ncxDoc ? extractChaptersFromNcx(ncxDoc, opfPathData.dir) : [];
            if(!ncxDoc) setStatusMessage({text:`Error parsing NCX: ${tocContentFile.path}`, type:'error'});
        } else {
            const navDoc = parseHtml(tocContentFile.content, tocContentFile.path);
            chapters = navDoc ? extractChaptersFromNav(navDoc, opfPathData.dir) : [];
            if(!navDoc) setStatusMessage({text:`Error parsing NAV: ${tocContentFile.path}`, type:'error'});
        }
        return deduplicateChapters(chapters);
    };


    const handleEpubFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        setStatusMessage(null); setDownloadUrl(null);
        if (!file) { setSelectedEpubFile(null); setEpubFileName(''); return; }
        setSelectedEpubFile(file);
        setEpubFileName(`Selected: ${file.name}`);
        toggleAppSpinner(true);
        try {
            const arrayBuffer = await readFileAsArrayBuffer(file);
            const zip = await JSZip.loadAsync(arrayBuffer);
            const chapters = await getChapterListFromEpub(zip);
            if (chapters.length > 0) {
                setStatusMessage({ text: `Found ${chapters.length} chapters. Ready to extract.`, type: 'success' });
            } else if (!statusMessage?.text.toLowerCase().includes('error') && !statusMessage?.text.toLowerCase().includes('warning')) {
                setStatusMessage({ text: 'No chapters found or ToC unparsable.', type: 'error' });
            }
        } catch (err:any) {
            setStatusMessage({ text: `Error: ${err.message}`, type: 'error' });
        } finally {
            toggleAppSpinner(false);
        }
    };

    const handleExtractChapters = async () => {
        if (!selectedEpubFile) {
            showToast("Please select an EPUB file first.", true);
            return;
        }
        toggleAppSpinner(true);
        setStatusMessage({ text: 'Starting chapter extraction...', type: 'success' });
        try {
            const arrayBuffer = await readFileAsArrayBuffer(selectedEpubFile);
            const epubZip = await JSZip.loadAsync(arrayBuffer);
            const chapters = await getChapterListFromEpub(epubZip);

            if (chapters.length === 0) {
                throw new Error(statusMessage?.text.includes("Error") || statusMessage?.text.includes("Warning") ? statusMessage.text : "No chapters identified in the EPUB.");
            }

            const outputZip = new JSZip();
            let filesAdded = 0;
            for (let i = 0; i < chapters.length; i++) {
                const entry = chapters[i];
                const chapterFile = epubZip.file(entry.href);
                if (!chapterFile) { console.warn(`Chapter file not found: ${entry.href}`); continue; }
                
                const chapterBytes = await chapterFile.async("uint8array");
                let chapterHtml = "";
                try {
                    const decoder = new TextDecoder('utf-8', { fatal: false }); 
                    chapterHtml = decoder.decode(chapterBytes);
                } catch (e) {
                     setStatusMessage({text: `Warning: Could not decode chapter "${entry.title.substring(0,30)}".`, type: 'error'});
                     chapterHtml = new TextDecoder('latin1').decode(chapterBytes); 
                }

                let chapterText = extractTextFromHtml(chapterHtml);
                if (enableRemoveLines && linesToRemove > 0 && chapterText) {
                    const lines = chapterText.split('\n');
                    chapterText = lines.length > linesToRemove ? lines.slice(linesToRemove).join('\n') : '';
                }
                if (chapterText && chapterText.trim().length > 0) {
                    const txtFilename = `C${String(i + 1).padStart(2, '0')}.txt`;
                    outputZip.file(txtFilename, chapterText);
                    filesAdded++;
                }
            }

            if (filesAdded > 0) {
                const zipBlob = await outputZip.generateAsync({ type: "blob", compression: "DEFLATE" });
                const newDownloadUrl = URL.createObjectURL(zipBlob);
                setDownloadUrl(newDownloadUrl);
                const baseName = sanitizeFilenameForZip(selectedEpubFile.name.replace(/\.epub$/i, '')) || 'epub_content';
                setDownloadFilename(`${baseName}_chapters.zip`);
                setStatusMessage({ text: `Extracted ${filesAdded} chapters into ZIP.`, type: 'success' });
                showToast(`Download started for ${filesAdded} chapters.`);
            } else {
                setStatusMessage({ text: "No chapter content retrieved or all content was removed by line filter.", type: 'error' });
            }
        } catch (err: any) {
            setStatusMessage({ text: `Error: ${err.message}`, type: 'error' });
            showToast(`Extraction Error: ${err.message}`, true);
        } finally {
            toggleAppSpinner(false);
        }
    };

    return (
        <div id="epubToZipApp" className="card tool-section">
            <h1>EPUB to ZIP (TXT)</h1>
            <div className="upload-section">
                <label htmlFor="epubUploadForTxtInput" className="btn upload-btn">Upload EPUB File</label>
                <input type="file" id="epubUploadForTxtInput" className="hidden-file-input" accept=".epub" onChange={handleEpubFileChange} ref={epubUploadInputRef} />
                <div className="file-name-display" aria-live="polite">{epubFileName}</div>
            </div>
            <div className="options-section">
                <div className="option-group">
                    <label className="checkbox-label-wrapper" htmlFor="epubToZipEnableRemoveLinesInput">
                        <input type="checkbox" id="epubToZipEnableRemoveLinesInput" checked={enableRemoveLines} onChange={e => setEnableRemoveLines(e.target.checked)} />
                        Remove initial lines from chapters
                    </label>
                </div>
                {enableRemoveLines && (
                    <div className="option-group" id="epubToZipRemoveLinesOptionsGroup">
                        <label htmlFor="epubToZipLinesToRemoveInput">Number of lines to remove:</label>
                        <input type="number" id="epubToZipLinesToRemoveInput" min="0" value={linesToRemove} onChange={e => setLinesToRemove(parseInt(e.target.value, 10) || 0)} />
                    </div>
                )}
            </div>
            <button className="btn split-btn" onClick={handleExtractChapters} disabled={!selectedEpubFile}>Extract Chapters to ZIP</button>
            {statusMessage && (<div className={`status-message ${statusMessage.type}`} role="status">{statusMessage.text}</div>)}
            {downloadUrl && (<div className="download-section"><a href={downloadUrl} download={downloadFilename} className="btn download-btn">Download Chapter TXTs</a></div>)}
        </div>
    );
};

const toolDefinitions: ToolDefinition[] = [
  { id: 'epubSplitter', title: 'EPUB Splitter', icon: '✂️', description: 'Split EPUB files into chapters.', component: EpubSplitterTool },
  { id: 'backupUtility', title: 'Backup Utility', icon: '💾', description: 'Create, modify, and manage project backups.', component: BackupUtilityTool },
  { id: 'zipToEpub', title: 'ZIP to EPUB', icon: '📦📖', description: 'Convert a ZIP of .txt files to an EPUB.', component: ZipToEpubTool },
  { id: 'epubToZip', title: 'EPUB to ZIP (TXT)', icon: '📖📄', description: 'Extract chapters from an EPUB to .txt files in a ZIP.', component: EpubToZipTool },
];

// --- Dashboard Component ---
const Dashboard: React.FC<{
  tools: ToolDefinition[];
  navigateTo: (toolId: string) => void;
}> = ({ tools, navigateTo }) => {
  return (
    <div className="dashboard-container">
      <h1>Novelist Tools</h1>
      <p className="dashboard-intro">A collection of utilities for authors. All tools work offline after the first load.</p>
      <div className="tool-cards-grid">
        {tools.map(tool => (
          <div
            key={tool.id}
            className="tool-card"
            onClick={() => navigateTo(tool.id)}
            role="button"
            tabIndex={0}
            onKeyPress={(e) => e.key === 'Enter' && navigateTo(tool.id)}
            aria-label={`Launch ${tool.title}`}
          >
            <div className="tool-card-icon" aria-hidden="true">{tool.icon}</div>
            <h2>{tool.title}</h2>
            <p>{tool.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};


const App: React.FC = () => {
  const [currentView, setCurrentView] = useState<string>('dashboard'); 
  const [appSpinnerVisible, setAppSpinnerVisible] = useState(false);
  const [toastMessages, setToastMessages] = useState<ToastMessage[]>([]);
  const toastIdCounter = useRef(0);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);


  const showToast = useCallback((message: string, isError: boolean = false) => {
    const id = toastIdCounter.current++;
    setToastMessages(prev => [...prev, { id, message, isError }]);
    setTimeout(() => {
      setToastMessages(prev => prev.filter(toast => toast.id !== id));
    }, 3000);
  }, []);
  
  const { canInstall, handleInstallClick, updateAvailable, handleUpdateAndReload } = usePwa(showToast);

  const toggleAppSpinner = (show: boolean) => {
    setAppSpinnerVisible(show);
  };

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);


  const navigateTo = useCallback((viewId: string) => {
    const targetHash = viewId === 'dashboard' ? '#/dashboard' : `#/tool/${viewId}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      // If hash is already correct, just ensure state updates
      setCurrentView(viewId);
      if (viewId !== 'dashboard') {
        sessionStorage.setItem('lastActiveTool', viewId);
      } else {
        sessionStorage.removeItem('lastActiveTool');
      }
    }
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      let newView = 'dashboard';
      if (hash.startsWith('#/tool/')) {
        const toolId = hash.substring('#/tool/'.length);
        if (toolDefinitions.some(t => t.id === toolId)) {
          newView = toolId;
        }
      } else if (hash === '#/dashboard') {
        newView = 'dashboard';
      } // Default is 'dashboard' (from newView initialization)

      setCurrentView(newView);
      if (newView !== 'dashboard') {
        sessionStorage.setItem('lastActiveTool', newView);
      } else {
        sessionStorage.removeItem('lastActiveTool');
      }
    };

    // Initial load logic
    const initialHash = window.location.hash;
    if (initialHash.startsWith('#/tool/')) {
      const toolIdFromHash = initialHash.substring('#/tool/'.length);
      if (toolDefinitions.some(t => t.id === toolIdFromHash)) {
        setCurrentView(toolIdFromHash);
        sessionStorage.setItem('lastActiveTool', toolIdFromHash);
      } else {
        navigateTo('dashboard'); // Invalid tool ID in hash
      }
    } else if (initialHash === '#/dashboard') {
      setCurrentView('dashboard');
      sessionStorage.removeItem('lastActiveTool');
    } else {
      // No hash or unrecognized hash, check session storage
      const lastTool = sessionStorage.getItem('lastActiveTool');
      if (lastTool && toolDefinitions.some(t => t.id === lastTool)) {
         navigateTo(lastTool); // This will set the hash
      } else {
         navigateTo('dashboard'); // Default to dashboard, this sets the hash
      }
    }

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [navigateTo]); // navigateTo is stable due to useCallback

  useEffect(() => {
    const activeTool = toolDefinitions.find(t => t.id === currentView);
    document.title = activeTool ? activeTool.title : "Novelist Tools - Dashboard";
  }, [currentView]);


  const ActiveToolComponent = toolDefinitions.find(tool => tool.id === currentView)?.component;
  const activeToolTitle = toolDefinitions.find(tool => tool.id === currentView)?.title || "Novelist Tools";


  return (
    <>
      <OfflineIndicatorToast isOffline={isOffline} />
      {updateAvailable && <UpdateAvailableToast onReload={handleUpdateAndReload} />}
      <header>
        <div className="logo-area">
            <img src="./icons/icon-192.png" alt="Novelist Tools Icon" style={{height: '40px', marginRight: '10px'}} />
            <h1>{activeToolTitle}</h1> 
        </div>
        {canInstall && (
          <button className="btn install-btn" onClick={handleInstallClick} title="Install App">
            Install App
          </button>
        )}
      </header>
      <nav className="tool-nav">
        <button
            key="dashboard-nav"
            className={`nav-btn ${currentView === 'dashboard' ? 'active' : ''}`}
            onClick={() => navigateTo('dashboard')}
            aria-current={currentView === 'dashboard' ? 'page' : undefined}
            title="Return to Dashboard"
          >
            Dashboard
        </button>
        {toolDefinitions.map(tool => (
          <button
            key={tool.id}
            className={`nav-btn ${currentView === tool.id ? 'active' : ''}`}
            onClick={() => navigateTo(tool.id)}
            aria-current={currentView === tool.id ? 'page' : undefined}
            title={tool.description}
          >
            {tool.title}
          </button>
        ))}
      </nav>
      <main>
        <Spinner visible={appSpinnerVisible} className="app-spinner" />
        <AppToast messages={toastMessages} />
        {currentView === 'dashboard' && <Dashboard tools={toolDefinitions} navigateTo={navigateTo} />}
        {ActiveToolComponent && currentView !== 'dashboard' && (
          <ActiveToolComponent showToast={showToast} toggleAppSpinner={toggleAppSpinner} />
        )}
      </main>
      <footer>
        <p>&copy; {new Date().getFullYear()} Novelist Tools. All rights reserved.</p>
      </footer>
    </>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<React.StrictMode><App /></React.StrictMode>);
} else {
  console.error('Failed to find the root element');
}
