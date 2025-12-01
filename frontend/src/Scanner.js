import React, { useState, useEffect, useRef, useCallback } from 'react';

// ==================== CONSTANTS & CONFIGURATION ====================
const getApiUrl = () => {
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL;
  }
  return `http://${window.location.hostname}:8000`;
};

const getWsUrl = () => {
  const baseUrl = getApiUrl().replace('http', 'ws');
  return `${baseUrl}/ws/status/${USER_ID}`;
};

const API_URL = getApiUrl();
const WS_BASE = getApiUrl().replace('http', 'ws');
const USER_ID = Math.random().toString(36).substring(2, 10);

// ==================== STORE MANAGEMENT ====================
const createStore = (initialState) => {
  let state = initialState;
  const listeners = new Set();
  
  const getState = () => state;
  const setState = (newState) => {
    state = { ...state, ...newState };
    listeners.forEach(listener => listener(state));
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { getState, setState, subscribe };
};

const documentStore = createStore({ documents: {} });

const useDocumentStore = () => {
  const [state, setState] = useState(documentStore.getState());
  useEffect(() => {
    const unsubscribe = documentStore.subscribe(setState);
    return unsubscribe;
  }, []);
  return state;
};

// ==================== DOCUMENT STATE UPDATER ====================
const updateDocumentState = (update) => {
  console.log('🔄 Updating document state:', update);
  const { documents } = documentStore.getState();
  const fileKey = update.file_name;
  
  if (!fileKey) {
    console.error('❌ No file_name in update:', update);
    return;
  }
  
  if (!documents[fileKey]) {
    console.log(`📄 Creating new document entry for: ${fileKey}`);
    documents[fileKey] = {
      file_name: fileKey,
      status: 'queued',
      stage: 1,
      extract_job_id: null,
      extracted_text: '',
      edited_text: '',
      formatted_text: '',
      summary_text: '',
      file_data: null,
    };
  }

  const currentDoc = documents[fileKey];
  
  if (update.job_type === 'extract' && update.status === 'finished') {
    documentStore.setState({ 
      documents: {
        ...documents,
        [fileKey]: {
          ...currentDoc,
          status: 'editing',
          stage: 3,
          extracted_text: update.result,
          edited_text: update.result,
          extract_job_id: update.job_id,
        }
      }
    });
  } else if (update.job_type === 'format' && update.status === 'finished') {
    let result = {};
    try {
      result = JSON.parse(update.result);
    } catch (e) {
      console.error("Failed to parse format result JSON:", e);
      result.formatted_text = "ERROR: Could not parse result.";
      result.summary_text = "ERROR: Could not parse result.";
    }
    
    documentStore.setState({
      documents: {
        ...documents,
        [fileKey]: {
          ...currentDoc,
          status: 'completed',
          stage: 5,
          formatted_text: result.formatted_text,
          summary_text: result.summary_text,
        }
      }
    });
  } else if (update.status === 'failed') {
    documentStore.setState({ 
      documents: {
        ...documents,
        [fileKey]: {
          ...currentDoc,
          status: 'failed',
          stage: update.stage || currentDoc.stage,
          extracted_text: update.result || currentDoc.extracted_text,
        }
      }
    });
  } else {
    documentStore.setState({ 
      documents: {
        ...documents,
        [fileKey]: {
          ...currentDoc,
          status: update.status,
          stage: update.stage || currentDoc.stage,
        }
      }
    });
  }
};

// ==================== WEB SOCKET HOOK ====================
const useWebSocket = (url, onMessage) => {
  const connectionRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    console.log('🔌 Attempting WebSocket connection to:', url);
    const ws = new WebSocket(url);
    connectionRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket connected for user:', USER_ID);
    };

    ws.onmessage = (event) => {
      console.log('📨 WebSocket message received:', event.data);
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current(data);
      } catch (e) {
        console.error('❌ Error parsing WebSocket message:', e);
      }
    };

    ws.onclose = (event) => {
      console.log('❌ WebSocket disconnected. Code:', event.code, 'Reason:', event.reason);
      console.log('🔄 Attempting to reconnect in 5s...');
      connectionRef.current = null;
      setTimeout(connect, 5000);
    };
    
    ws.onerror = (error) => {
      console.error('💥 WebSocket error:', error);
    };
    
    return ws;
  }, [url]);

  useEffect(() => {
    const ws = connect();
    
    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('🧹 Cleaning up WebSocket connection');
        ws.close();
      }
    };
  }, [connect]);
};

// ==================== UI COMPONENTS ====================

// Status Badge Component
const StatusBadge = ({ stage, status }) => {
  const stageConfigs = {
    1: { color: 'from-blue-100 to-blue-50', icon: '📤', text: 'Uploaded' },
    2: { color: 'from-amber-100 to-amber-50', icon: '⚙️', text: 'Extracting Text' },
    3: { color: 'from-sky-100 to-sky-50', icon: '✏️', text: 'Ready to Review' },
    4: { color: 'from-indigo-100 to-indigo-50', icon: '✨', text: 'Formatting' },
    5: { color: 'from-emerald-100 to-emerald-50', icon: '✓', text: 'Complete' },
    failed: { color: 'from-red-100 to-red-50', icon: '✕', text: 'Failed' }
  };

  const config = stageConfigs[stage] || stageConfigs[status] || stageConfigs[1];
  
  return (
    <div className={`relative px-5 py-2.5 rounded-xl bg-gradient-to-r ${config.color} border border-white/30 shadow-lg backdrop-blur-sm flex items-center gap-3`}>
      <span className="text-lg">{config.icon}</span>
      <span className="font-bold text-gray-800">{config.text}</span>
      {/* AQ Easter Egg */}
      <div className="absolute -top-1 -right-1 text-[6px] font-mono text-blue-300/30">AQ</div>
    </div>
  );
};

// Loading Spinner with AQ Easter Egg
const LoadingSpinner = ({ size = 16, color = 'text-blue-500', withAQ = true }) => (
  <div className="relative inline-block">
    <svg className={`animate-spin h-${size} w-${size} ${color}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
    {withAQ && (
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[6px] font-mono text-current opacity-10">AQ</span>
      </div>
    )}
  </div>
);

// Card Container Component
const Card = ({ children, className = '', gradient = 'from-white/90 to-blue-50/90' }) => (
  <div className={`relative rounded-2xl bg-gradient-to-br ${gradient} border border-white/40 shadow-xl backdrop-blur-sm overflow-hidden ${className}`}>
    {/* Decorative corner AQ */}
    <div className="absolute top-3 right-3 text-[8px] font-mono text-blue-200/20">AQ</div>
    {children}
  </div>
);

// Stage 2: Extraction Component
const Stage2Extraction = React.memo(({ fileKey, fileData }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');

  useEffect(() => {
    if (!isPDF && fileData && fileData.data_b64) {
      const byteCharacters = atob(fileData.data_b64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: fileData.mime_type || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      setImageUrl(url);

      return () => URL.revokeObjectURL(url);
    }
  }, [fileData, isPDF]);

  return (
    <Card gradient="from-amber-50/80 to-orange-50/80" className="mt-6 p-8">
      <div className="flex items-center gap-4 mb-8">
        <div className="text-3xl bg-gradient-to-br from-amber-400 to-orange-400 p-3 rounded-xl text-white shadow-lg">🔍</div>
        <div>
          <h4 className="text-2xl font-bold bg-gradient-to-r from-amber-800 to-orange-800 bg-clip-text text-transparent">
            Extracting Text from Your Document
          </h4>
          <p className="text-sm text-amber-600/80">AI is reading your document content</p>
        </div>
      </div>
      
      {/* Updated layout: Image on left, status on right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
        {/* Image Preview - Now larger and equal height */}
        <div className="flex flex-col h-full">
          <label className="block text-sm font-semibold text-gray-700 mb-3 px-1">
            {isPDF ? 'PDF Document Preview' : 'Original Document'}
          </label>
          <div className="flex-1 border-2 border-amber-300/40 rounded-2xl overflow-hidden bg-gradient-to-br from-white to-amber-50/50 backdrop-blur-sm shadow-inner">
            {isPDF ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                <div className="text-7xl text-red-400/80 mb-6 drop-shadow-sm">📄</div>
                <p className="font-bold text-gray-800 text-xl mb-2">PDF Document</p>
                <p className="text-sm text-gray-600 mb-4">Text extraction in progress...</p>
                <div className="text-xs text-gray-400 font-mono bg-amber-100/50 px-4 py-2 rounded-lg">AQ Processing</div>
              </div>
            ) : imageUrl ? (
              <div className="h-full flex items-center justify-center p-4">
                <img 
                  src={imageUrl} 
                  alt="Document being processed" 
                  className="max-h-[400px] w-auto object-contain rounded-lg"
                  style={{ maxWidth: '100%' }}
                />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center p-10">
                <LoadingSpinner size={12} color="text-amber-500" />
              </div>
            )}
          </div>
          {!isPDF && imageUrl && (
            <p className="text-xs text-gray-500 text-center mt-2 truncate">
              {fileData?.name || fileKey}
            </p>
          )}
        </div>
        
        {/* Processing Status - Now takes full height */}
        <div className="flex flex-col h-full">
          <label className="block text-sm font-semibold text-gray-700 mb-3 px-1">
            Processing Status
          </label>
          <div className="flex-1 flex flex-col justify-center bg-gradient-to-br from-white to-amber-50/50 backdrop-blur-sm border-2 border-amber-300/40 rounded-2xl p-8">
            <div className="text-center">
              <div className="inline-block mb-6">
                <LoadingSpinner size={20} color="text-amber-500" />
              </div>
              <p className="text-2xl font-bold bg-gradient-to-r from-amber-700 to-orange-700 bg-clip-text text-transparent mb-4">
                {isPDF ? 'Reading Your PDF' : 'Reading Your Document'}
              </p>
              <p className="text-gray-700 mb-6 text-base leading-relaxed">
                {isPDF
                  ? "Please wait while we extract text from all pages. This usually takes a few moments."
                  : "Our AI is reading the text from your document. This typically completes in seconds."
                }
              </p>
              
              {/* Document Info Card */}
              <div className="bg-white/70 border border-amber-200/50 rounded-xl p-5 mb-6 backdrop-blur-sm">
                <p className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <span className="text-amber-600">📄 Processing:</span> 
                  <span className="truncate">{fileKey}</span>
                </p>
                <p className="text-xs text-gray-600 leading-relaxed">
                  {isPDF 
                    ? "Compare the extracted text with your original PDF to verify accuracy"
                    : "Compare the extracted text with the original image to verify accuracy"
                  }
                </p>
              </div>
              
              {/* Progress indicator */}
              <div className="relative pt-1">
                <div className="flex mb-2 items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold inline-block py-1 px-2 uppercase rounded-full text-amber-600 bg-amber-200">
                      Extracting
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-semibold inline-block text-amber-600">
                      50%
                    </span>
                  </div>
                </div>
                <div className="overflow-hidden h-2 mb-4 text-xs flex rounded-full bg-amber-200">
                  <div 
                    style={{ width: "50%" }}
                    className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-gradient-to-r from-amber-500 to-orange-500 animate-pulse"
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
});

// Stage 3: Editor Component - Image on left, text on right (Improved visibility)
const Stage3Editor = React.memo(({ fileKey, initialText, userId, fileData }) => {
    const [editedText, setEditedText] = useState(initialText);
    const [isFormatting, setIsFormatting] = useState(false);
    const [imageUrl, setImageUrl] = useState(null);
    const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');

    useEffect(() => {
        setEditedText(initialText);
    }, [initialText]);

    useEffect(() => {
      if (!isPDF && fileData && fileData.data_b64) {
        const byteCharacters = atob(fileData.data_b64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: fileData.mime_type || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        setImageUrl(url);

        return () => URL.revokeObjectURL(url);
      }
    }, [fileData, isPDF]);

    const handleFormat = async () => {
        setIsFormatting(true);
        
        try {
            const response = await fetch(`${API_URL}/api/format`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    file_name: fileKey, 
                    raw_text: editedText,
                    user_id: userId
                }),
            });
            
            if (!response.ok) throw new Error('Formatting job submission failed.');

            const result = await response.json();
            console.log('✅ Format job submitted:', result);

            updateDocumentState({
                file_name: fileKey,
                status: 'started',
                stage: 4,
                job_type: 'format',
            });

        } catch (error) {
            console.error('❌ Error submitting format job:', error);
            alert('Error submitting format job. Check console.');
            updateDocumentState({ 
                file_name: fileKey, 
                status: 'failed', 
                stage: 3, 
                job_type: 'format', 
                result: 'Failed to submit job.' 
            });
        } finally {
            setIsFormatting(false);
        }
    };

    return (
        <Card gradient="from-sky-50/80 to-blue-50/80" className="mt-6 p-8">
            <div className="flex items-center gap-4 mb-6">
                <div className="text-3xl bg-gradient-to-br from-sky-500 to-blue-500 p-3 rounded-xl text-white shadow-lg">✏️</div>
                <div>
                    <h4 className="text-2xl font-bold bg-gradient-to-r from-sky-800 to-blue-800 bg-clip-text text-transparent">
                        Review and Edit Your Text
                    </h4>
                    <p className="text-sm text-sky-600/80">Compare the original image with extracted text and make corrections</p>
                </div>
            </div>
            
            {/* Main Comparison Area - Image on LEFT, Text on RIGHT */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                {/* LEFT COLUMN: Original Image */}
                <div className="flex flex-col">
                    <label className="block text-lg font-bold text-gray-800 mb-3 px-1">
                        📷 Original Document
                    </label>
                    <div className="border-2 border-sky-300/40 rounded-2xl overflow-hidden bg-gradient-to-br from-white to-sky-50/50 backdrop-blur-sm shadow-inner min-h-[400px] max-h-[600px]">
                        {isPDF ? (
                            <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                                <div className="text-7xl text-red-400/80 mb-6">📄</div>
                                <p className="font-bold text-gray-800 text-xl mb-2">PDF Document</p>
                                <p className="text-sm text-gray-600 mb-4">Compare extracted text with original PDF</p>
                                <div className="text-xs text-gray-400 font-mono bg-sky-100/50 px-4 py-2 rounded-lg">AQ Verified</div>
                            </div>
                        ) : imageUrl ? (
                            <div className="h-full flex items-center justify-center p-4">
                                <img 
                                    src={imageUrl} 
                                    alt="Original document for comparison" 
                                    className="max-h-[550px] max-w-full object-contain"
                                />
                            </div>
                        ) : (
                            <div className="h-full flex items-center justify-center p-10">
                                <p className="text-gray-500">Document preview not available</p>
                            </div>
                        )}
                    </div>
                    {!isPDF && imageUrl && (
                        <p className="text-xs text-gray-500 text-center mt-2 italic">
                            Compare with extracted text on the right →
                        </p>
                    )}
                </div>
                
                {/* RIGHT COLUMN: Extracted Text */}
                <div className="flex flex-col">
                    <div className="flex justify-between items-center mb-3">
                        <label className="block text-lg font-bold text-gray-800 px-1">
                            📝 Extracted Text
                        </label>
                        <div className="text-xs text-sky-600 font-medium bg-sky-100/50 px-3 py-1 rounded-full">
                            {editedText.length} characters
                        </div>
                    </div>
                    <div className="border-2 border-sky-300/40 rounded-2xl overflow-hidden bg-white/90 backdrop-blur-sm shadow-inner min-h-[400px] max-h-[600px]">
                        <textarea
                            value={editedText}
                            onChange={(e) => setEditedText(e.target.value)}
                            className="w-full h-full p-5 text-base resize-none border-none focus:ring-0 bg-transparent font-mono leading-relaxed"
                            placeholder="Review and correct the extracted text here..."
                            style={{ 
                                minHeight: '400px',
                                lineHeight: '1.6'
                            }}
                        />
                    </div>
                    <p className="text-sm text-gray-600 mt-2 px-1">
                        Edit text while looking at the original image on the left
                    </p>
                </div>
            </div>

            {/* Compact Tips Section - Smaller and less intrusive */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div className="bg-white/70 border border-sky-200/50 rounded-xl p-4 backdrop-blur-sm">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-sky-500 text-lg">✓</span>
                        <h6 className="font-semibold text-gray-800 text-sm">Check Accuracy</h6>
                    </div>
                    <p className="text-xs text-gray-600">Fix incorrect letters or words by comparing with the original</p>
                </div>
                
                <div className="bg-white/70 border border-sky-200/50 rounded-xl p-4 backdrop-blur-sm">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-sky-500 text-lg">↔️</span>
                        <h6 className="font-semibold text-gray-800 text-sm">Adjust Formatting</h6>
                    </div>
                    <p className="text-xs text-gray-600">Fix spacing, paragraphs, and line breaks as needed</p>
                </div>
                
                <div className="bg-white/70 border border-sky-200/50 rounded-xl p-4 backdrop-blur-sm">
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-sky-500 text-lg">🔢</span>
                        <h6 className="font-semibold text-gray-800 text-sm">Verify Details</h6>
                    </div>
                    <p className="text-xs text-gray-600">Double-check numbers, dates, and special symbols</p>
                </div>
            </div>

            {/* Document Info - Compact */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-6 p-4 bg-white/50 border border-sky-200/30 rounded-xl">
                <div className="flex items-center gap-3">
                    <span className="text-sky-500 bg-sky-100/70 p-2 rounded-lg">📄</span>
                    <div>
                        <p className="font-medium text-gray-800 text-sm">Processing: {fileKey}</p>
                        <p className="text-xs text-gray-600">{isPDF ? 'PDF Document' : 'Image File'}</p>
                    </div>
                </div>
                
                <div className="flex items-center gap-4">
                    <div className="text-center">
                        <p className="text-xs text-gray-500">Characters</p>
                        <p className="font-bold text-sky-600">{editedText.length}</p>
                    </div>
                    
                    <div className="text-center">
                        <p className="text-xs text-gray-500">Lines</p>
                        <p className="font-bold text-sky-600">{editedText.split('\n').length}</p>
                    </div>
                    
                    <div className="text-center">
                        <p className="text-xs text-gray-500">Status</p>
                        <p className="font-bold text-green-600 text-xs bg-green-100/50 px-3 py-1 rounded-full">Ready</p>
                    </div>
                </div>
            </div>

            {/* Format Button */}
            <button
                onClick={handleFormat}
                disabled={isFormatting}
                className={`relative w-full font-bold py-4 rounded-2xl transition-all duration-300 text-lg shadow-xl overflow-hidden group ${
                    isFormatting
                        ? 'bg-gradient-to-r from-gray-400 to-gray-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-700 hover:to-blue-700 text-white hover:shadow-2xl'
                }`}
            >
                {isFormatting ? (
                  <span className="flex items-center justify-center gap-3">
                    <LoadingSpinner size={6} color="text-white" />
                    Processing...
                  </span>
                ) : (
                  <>
                    <span className="relative z-10">✨ Format and Summarize My Document</span>
                    <div className="absolute inset-0 bg-gradient-to-r from-sky-500/0 via-white/10 to-sky-500/0 group-hover:translate-x-full transition-transform duration-1000"></div>
                  </>
                )}
            </button>
        </Card>
    );
});

// Stage 5: Output Component
const Stage5Output = React.memo(({ fileKey, formattedText, summaryText, fileData }) => {
    const [formattedEdit, setFormattedEdit] = useState(formattedText);
    const [summaryEdit, setSummaryEdit] = useState(summaryText);
    const [imageUrl, setImageUrl] = useState(null);
    const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');
    
    useEffect(() => {
        setFormattedEdit(formattedText);
        setSummaryEdit(summaryText);
    }, [formattedText, summaryText]);

    useEffect(() => {
      if (!isPDF && fileData && fileData.data_b64) {
        const byteCharacters = atob(fileData.data_b64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: fileData.mime_type || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        setImageUrl(url);

        return () => URL.revokeObjectURL(url);
      }
    }, [fileData, isPDF]);
    
    const downloadAsPDF = (content, filename, title) => {
        import('jspdf').then((jsPDFModule) => {
            const { jsPDF } = jsPDFModule;
            const doc = new jsPDF();
            
            doc.setProperties({
                title: title,
                subject: 'Processed Document',
                author: 'AQ Document Processor',
                keywords: 'generated, document, text',
                creator: 'AQ Document Processor'
            });

            doc.setFontSize(16);
            doc.setFont(undefined, 'bold');
            doc.text(title, 20, 10);
            
            doc.setFontSize(10);
            doc.setFont(undefined, 'normal');
            doc.text(`Generated by AQ Processor on: ${new Date().toLocaleDateString()}`, 20, 40);
            
            doc.setFontSize(11);
            const pageWidth = doc.internal.pageSize.getWidth();
            const margin = 10;
            const maxWidth = pageWidth - (2 * margin);
            
            const lines = doc.splitTextToSize(content, maxWidth - 10);
            
            let yPosition = 60;
            const lineHeight = 7;
            const pageHeight = doc.internal.pageSize.getHeight();
            
            for (let i = 0; i < lines.length; i++) {
                if (yPosition > pageHeight - 20) {
                    doc.addPage();
                    yPosition = 20;
                }
                doc.text(lines[i], margin, yPosition);
                yPosition += lineHeight;
            }
            
            doc.setFontSize(8);
            doc.text('Generated by AQ Document Processor • Powered by AI', margin, pageHeight - 10);
            
            doc.save(`${filename}.pdf`);
        }).catch(error => {
            console.error('Error generating PDF:', error);
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filename}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    };

    return (
        <Card gradient="from-emerald-50/80 to-green-50/80" className="mt-6 p-8">
            <div className="flex items-center gap-4 mb-8">
                <div className="text-3xl bg-gradient-to-br from-emerald-500 to-green-500 p-3 rounded-xl text-white shadow-lg">✅</div>
                <div>
                    <h4 className="text-2xl font-bold bg-gradient-to-r from-emerald-800 to-green-800 bg-clip-text text-transparent">
                        Your Documents are Ready!
                    </h4>
                    <p className="text-sm text-emerald-600/80">Download your formatted document and summary below</p>
                </div>
            </div>
            
            {/* Original Reference */}
            <div className="mb-10">
                <label className="block text-sm font-semibold text-gray-700 mb-4 px-1">
                    Original Document Reference
                </label>
                {isPDF ? (
                    <div className="inline-block border-2 border-emerald-300/40 rounded-2xl p-6 bg-gradient-to-br from-white to-emerald-50/50 backdrop-blur-sm">
                        <div className="text-5xl text-red-400/80 text-center mb-3">📄</div>
                        <p className="text-center text-base font-medium text-gray-800">Original PDF Reference</p>
                        <p className="text-center text-xs text-gray-500">All pages processed by AQ</p>
                    </div>
                ) : imageUrl ? (
                    <div className="inline-block border-2 border-emerald-300/40 rounded-2xl p-4 bg-gradient-to-br from-white to-emerald-50/50 backdrop-blur-sm">
                        <img 
                            src={imageUrl} 
                            alt="Original document" 
                            className="w-64 h-48 object-contain rounded-lg shadow-inner"
                        />
                    </div>
                ) : (
                    <p className="text-sm text-gray-500">Original document reference not available</p>
                )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                {/* Formatted Document */}
                <Card className="p-6">
                    <label className="block text-base font-bold text-gray-800 mb-3 flex items-center gap-3">
                        <span className="bg-gradient-to-br from-emerald-500 to-green-500 p-2 rounded-lg text-white shadow">📄</span>
                        Formatted Document
                    </label>
                    <p className="text-xs text-gray-600 mb-4">Your document, formatted and cleaned</p>
                    <textarea
                        value={formattedEdit}
                        onChange={(e) => setFormattedEdit(e.target.value)}
                        rows="10"
                        className="w-full p-4 border-2 border-gray-300/50 rounded-xl text-sm resize-none mb-5 focus:ring-3 focus:ring-emerald-500/30 focus:border-emerald-400 bg-white/90 backdrop-blur-sm shadow-inner"
                    />
                    <button
                        onClick={() => downloadAsPDF(formattedEdit, `formatted_${fileKey.replace('.pdf', '').replace('.jpg', '').replace('.png', '')}`, `Formatted Document - ${fileKey}`)}
                        className="relative w-full bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-700 hover:to-green-700 text-white font-bold py-4 rounded-xl transition-all duration-300 shadow-lg hover:shadow-2xl group overflow-hidden"
                    >
                        <span className="relative z-10">📥 Download Formatted Document</span>
                        <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-white/10 to-emerald-500/0 group-hover:translate-x-full transition-transform duration-1000"></div>
                    </button>
                </Card>
                
                {/* Summary */}
                <Card className="p-6">
                    <label className="block text-base font-bold text-gray-800 mb-3 flex items-center gap-3">
                        <span className="bg-gradient-to-br from-emerald-500 to-green-500 p-2 rounded-lg text-white shadow">📝</span>
                        Summary
                    </label>
                    <p className="text-xs text-gray-600 mb-4">Key points from your document</p>
                    <textarea
                        value={summaryEdit}
                        onChange={(e) => setSummaryEdit(e.target.value)}
                        rows="10"
                        className="w-full p-4 border-2 border-gray-300/50 rounded-xl text-sm resize-none mb-5 focus:ring-3 focus:ring-emerald-500/30 focus:border-emerald-400 bg-white/90 backdrop-blur-sm shadow-inner"
                    />
                    <button
                        onClick={() => downloadAsPDF(summaryEdit, `summary_${fileKey.replace('.pdf', '').replace('.jpg', '').replace('.png', '')}`, `Document Summary - ${fileKey}`)}
                        className="relative w-full bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-700 hover:to-green-700 text-white font-bold py-4 rounded-xl transition-all duration-300 shadow-lg hover:shadow-2xl group overflow-hidden"
                    >
                        <span className="relative z-10">📥 Download Summary</span>
                        <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/0 via-white/10 to-emerald-500/0 group-hover:translate-x-full transition-transform duration-1000"></div>
                    </button>
                </Card>
            </div>
            
            {/* AQ Easter Egg in footer */}
            <div className="text-center mt-8 pt-6 border-t border-emerald-200/50">
                <p className="text-xs text-gray-400 font-mono">Process completed with AQ intelligence</p>
            </div>
        </Card>
    );
});

// Main Document Card Component
const DocumentCard = React.memo(({ fileKey, documentData, fileData }) => {
    const { status, stage, extracted_text, formatted_text, summary_text } = documentData;
    
    return (
        <Card className="p-6 mb-8 hover:shadow-2xl transition-all duration-300 hover:border-blue-300/50">
            <div className="flex justify-between items-start mb-6 gap-6">
                <div className="flex-1 min-w-0">
                    <h3 className="text-xl font-bold text-gray-800 truncate mb-2">{fileKey}</h3>
                    <p className="text-sm text-gray-500">Document processing workflow</p>
                </div>
                <StatusBadge stage={stage} status={status} />
            </div>

            {/* Stage 2 Extraction */}
            {stage === 2 && (
                <Stage2Extraction 
                    fileKey={fileKey}
                    fileData={fileData}
                />
            )}

            {/* Stage 4 Loading */}
            {stage === 4 && (
                <Card gradient="from-sky-50/80 to-blue-50/80" className="py-12 text-center">
                    <div className="inline-block mb-6">
                        <LoadingSpinner size={20} color="text-sky-500" />
                    </div>
                    <p className="text-2xl font-bold bg-gradient-to-r from-sky-700 to-blue-700 bg-clip-text text-transparent mb-3">
                        Formatting Your Document
                    </p>
                    <p className="text-gray-600 max-w-md mx-auto">Our AI is polishing your document and creating a summary. Almost done!</p>
                    <div className="mt-6 text-xs text-gray-400 font-mono">AQ Processing...</div>
                </Card>
            )}
            
            {/* Stage 3 Editing */}
            {stage === 3 && (
                <Stage3Editor 
                    fileKey={fileKey} 
                    initialText={extracted_text} 
                    userId={USER_ID}
                    fileData={fileData}
                />
            )}
            
            {/* Stage 5 Final Output */}
            {stage === 5 && (
                <Stage5Output 
                    fileKey={fileKey} 
                    formattedText={formatted_text} 
                    summaryText={summary_text}
                    fileData={fileData}
                />
            )}
        </Card>
    );
});

// ==================== DOCUMENT SCANNER MAIN COMPONENT ====================
const Scanner = ({ onLogout }) => {
    const { documents } = useDocumentStore();
    const [files, setFiles] = useState([]);
    const [fileDataMap, setFileDataMap] = useState({});
    const [isUploading, setIsUploading] = useState(false);
    
    const websocketUrl = getWsUrl();
    
    const handleWsMessage = useCallback((update) => {
        console.log('🔄 Processing WebSocket update:', update);
        updateDocumentState(update);
    }, []);

    useWebSocket(websocketUrl, handleWsMessage);
    
    const handleUpload = async () => {
        if (files.length === 0) return;
        setIsUploading(true);
        
        const newFileDataMap = { ...fileDataMap };
        const formData = new FormData();
        formData.append('user_id', USER_ID);
        
        for (const file of files) {
            formData.append('files', file);
            
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result.split(',')[1];
                newFileDataMap[file.name] = {
                    name: file.name,
                    data_b64: base64,
                    mime_type: file.type
                };
                setFileDataMap(newFileDataMap);
            };
            reader.readAsDataURL(file);
        }

        try {
            console.log('📤 Uploading files:', files.map(f => f.name));
            const response = await fetch(`${API_URL}/api/upload`, {
                method: 'POST',
                body: formData,
            });
            
            if (!response.ok) throw new Error('Upload failed.');
            const results = await response.json();
            
            console.log('✅ Upload response:', results);
            
            const currentStoreState = documentStore.getState().documents;
        
            const newDocuments = { ...currentStoreState };
            results.job_submissions.forEach(job => {
                newDocuments[job.file_name] = {
                    file_name: job.file_name,
                    status: 'started',
                    stage: 2,
                    extract_job_id: job.job_id,
                    extracted_text: '',
                    edited_text: '',
                    formatted_text: '',
                    summary_text: '',
                };
            });
            
            documentStore.setState({ documents: newDocuments });
            setFiles([]);
            
        } catch (error) {
            console.error('❌ Error during upload:', error);
            alert('Error during upload. Check console for details.');
        } finally {
            setIsUploading(false);
        }
    };

    const sortedDocuments = Object.entries(documents).sort(([,a], [,b]) => {
        if (a.stage === 5 && b.stage !== 5) return 1;
        if (b.stage === 5 && a.stage !== 5) return -1;
        return 0;
    });

    const DocumentCards = sortedDocuments.map(([fileKey, data]) => (
        <DocumentCard 
            key={fileKey} 
            fileKey={fileKey} 
            documentData={data} 
            fileData={fileDataMap[fileKey]}
        />
    ));

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-600 to-white font-sans overflow-x-hidden">
            {/* Background decorative elements */}
            <div className="absolute inset-0 overflow-hidden">
                <div className="absolute -top-40 -right-40 w-80 h-80 bg-blue-400/10 rounded-full blur-3xl"></div>
                <div className="absolute top-1/4 -left-20 w-60 h-60 bg-sky-400/10 rounded-full blur-3xl"></div>
                <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-white/5 rounded-full blur-3xl"></div>
                {/* Hidden AQ pattern in background */}
                <div className="absolute inset-0 opacity-5">
                    <div className="absolute top-10 left-10 text-4xl font-mono text-white rotate-12">AQ</div>
                    <div className="absolute top-1/3 right-20 text-3xl font-mono text-white -rotate-12">AQ</div>
                    <div className="absolute bottom-20 left-1/4 text-5xl font-mono text-white rotate-45">AQ</div>
                </div>
            </div>

            <div className="relative max-w-7xl mx-auto px-4 sm:px-8 py-8">
                {/* Header with Logout Button */}
                <header className="text-center mb-16 pt-8">
                    <div className="flex justify-between items-center mb-6">
                        <div className="text-5xl bg-gradient-to-br from-white to-blue-100 p-4 rounded-2xl shadow-2xl">
                            📄✨
                        </div>
                        {onLogout && (
                            <button
                                onClick={onLogout}
                                className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 text-white font-bold py-2 px-6 rounded-xl transition-all duration-300 shadow-lg hover:shadow-xl"
                            >
                                Logout
                            </button>
                        )}
                    </div>
                    <h1 className="text-5xl sm:text-7xl font-black mb-6">
                        <span className="bg-gradient-to-r from-white via-blue-100 to-white bg-clip-text text-transparent">
                            Handwritten Document
                        </span>
                        <br />
                        <span className="bg-gradient-to-r from-blue-200 via-white to-blue-200 bg-clip-text text-transparent">
                            Processor
                        </span>
                    </h1>
                    <p className="text-xl text-white/90 max-w-2xl mx-auto mb-8 leading-relaxed">
                        Transform handwritten notes and PDFs into beautifully formatted digital text with AI-powered processing
                    </p>
                    {/* AQ Easter Egg in header */}
                    <div className="text-xs font-mono text-white/30 tracking-widest">ADVANCED QUALITY PROCESSING</div>
                </header>

                {/* Upload Section */}
                <Card className="p-10 mb-12">
                    <div className="flex items-center gap-6 mb-10">
                        <div className="text-4xl bg-gradient-to-br from-blue-500 to-sky-500 p-4 rounded-2xl text-white shadow-2xl">📤</div>
                        <div>
                            <h2 className="text-4xl font-black bg-gradient-to-r from-blue-800 to-sky-800 bg-clip-text text-transparent">
                                Upload Your Documents
                            </h2>
                            <p className="text-base text-gray-600 mt-2">Choose one or more image or PDF files to get started</p>
                        </div>
                    </div>
                    
                    <div className="relative mb-10">
                        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-sky-500/10 rounded-2xl blur-xl"></div>
                        <div className="relative border-3 border-dashed border-white/30 rounded-2xl p-10 text-center bg-gradient-to-br from-white/90 to-blue-50/90 backdrop-blur-sm">
                            <input
                                type="file"
                                multiple
                                accept=".png,.jpg,.jpeg,.pdf"
                                onChange={(e) => setFiles(prev=>[...prev, ...Array.from(e.target.files)])}
                                className="block w-full text-lg text-gray-700 file:mr-6 file:py-5 file:px-10 file:rounded-full file:border-0 file:text-lg file:font-bold file:bg-gradient-to-r file:from-blue-600 file:to-sky-600 file:text-white hover:file:from-blue-700 hover:file:to-sky-700 file:cursor-pointer cursor-pointer backdrop-blur-sm"
                            />
                            <p className="mt-6 text-sm text-gray-600">Supports: PNG, JPG, and PDF files</p>
                            {/* AQ Easter Egg */}
                            <div className="absolute -bottom-2 -right-2 text-[10px] font-mono text-blue-300/30 rotate-12">AQ</div>
                        </div>
                    </div>

                    {files.length > 0 && (
                        <Card gradient="from-blue-50 to-sky-50" className="mb-10 p-8">
                            <p className="font-bold text-gray-800 mb-4 text-lg">Selected files ({files.length}):</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {files.map((f, idx) => (
                                    <div key={idx} className="flex items-center gap-4 bg-white/80 p-4 rounded-xl border border-blue-200/50">
                                        <span className="text-blue-500 bg-blue-100 p-2 rounded-full">✓</span>
                                        <span className="font-medium truncate">{f.name}</span>
                                        <span className="text-xs text-gray-500 ml-auto">{Math.round(f.size / 1024)}KB</span>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}

                    <button
                        onClick={handleUpload}
                        disabled={files.length === 0 || isUploading}
                        className={`relative w-full text-white font-black py-6 rounded-2xl transition-all duration-300 text-xl shadow-2xl overflow-hidden group ${
                            files.length === 0 || isUploading
                                ? 'bg-gradient-to-r from-gray-400 to-gray-500 cursor-not-allowed'
                                : 'bg-gradient-to-r from-blue-600 to-sky-600 hover:from-blue-700 hover:to-sky-700 hover:shadow-3xl'
                        }`}
                    >
                        {isUploading ? (
                          <span className="flex items-center justify-center gap-4">
                            <LoadingSpinner size={8} color="text-white" />
                            Processing Your Files...
                          </span>
                        ) : files.length > 0 ? (
                          <>
                            <span className="relative z-10">✨ Process {files.length} Document{files.length > 1 ? 's' : ''}</span>
                            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/0 via-white/20 to-sky-500/0 group-hover:translate-x-full transition-transform duration-1000"></div>
                          </>
                        ) : '📤 Select Files to Begin'}
                        {/* AQ Easter Egg on button */}
                        <div className="absolute -bottom-1 -right-1 text-[8px] font-mono text-white/20">AQ</div>
                    </button>
                </Card>
                
                {/* Documents Dashboard */}
                {Object.keys(documents).length > 0 && (
                    <Card className="p-8 mb-10">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                            <div className="flex items-center gap-6">
                                <span className="text-4xl bg-gradient-to-br from-blue-500 to-purple-500 p-3 rounded-2xl text-white shadow-lg">📊</span>
                                <div>
                                    <h2 className="text-3xl font-black bg-gradient-to-r from-blue-800 to-purple-800 bg-clip-text text-transparent">
                                        Your Documents
                                    </h2>
                                    <p className="text-sm text-gray-600">Real-time processing dashboard</p>
                                </div>
                            </div>
                            <div className="bg-gradient-to-r from-blue-100 to-purple-100 text-blue-800 px-6 py-3 rounded-xl font-bold text-sm border border-blue-200/50 shadow-sm">
                                {Object.keys(documents).length} document{Object.keys(documents).length !== 1 ? 's' : ''}
                            </div>
                        </div>
                    </Card>
                )}
                
                {/* Document Cards */}
                {DocumentCards.length > 0 ? (
                    <div className="space-y-8">
                        {DocumentCards}
                    </div>
                ) : (
                    <Card className="text-center py-20">
                        <div className="text-8xl mb-8 bg-gradient-to-r from-gray-300 to-gray-400 bg-clip-text text-transparent">📄</div>
                        <p className="text-3xl font-black bg-gradient-to-r from-gray-500 to-gray-600 bg-clip-text text-transparent mb-4">
                            No Documents Yet
                        </p>
                        <p className="text-gray-600 max-w-md mx-auto text-lg">
                            Upload your first document above to begin the AI-powered transformation process
                        </p>
                        {/* AQ Easter Egg */}
                        <div className="mt-8 text-xs font-mono text-gray-400"> Ready • AI Powered • Real-time</div>
                    </Card>
                )}
                
                {/* Footer */}
                <footer className="text-center mt-20 pt-10 border-t border-white/20">
                    <div className="text-sm text-white/60 mb-2">
                        Powered by Advanced Quality AI • Real-time Processing
                    </div>
                    <div className="text-xs text-white/40 font-mono tracking-widest">
                        AQ DOCUMENT PROCESSOR v1.0
                    </div>
                </footer>
            </div>
        </div>
    );
};

export default Scanner;