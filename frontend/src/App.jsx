import React, { useState, useEffect, useRef, useCallback } from 'react';

// --- Configuration ---
const API_URL = 'http://localhost:8000'; 
// Generate a unique ID for the session/user (client-side only for API tracking)
const USER_ID = Math.random().toString(36).substring(2, 10); 

// --- Global State Management (Zustand replacement for simplicity) ---
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

// --- Update Handler (FIXED FOR MULTIPLE DOCUMENTS) ---
const updateDocumentState = (update) => {
  console.log('🔄 Updating document state:', update);
  const { documents } = documentStore.getState();
  const fileKey = update.file_name;
  
  if (!fileKey) {
    console.error('❌ No file_name in update:', update);
    return;
  }
  
  // Initialize document if it doesn't exist 
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
      file_data: null, // Store file data for image preview
    };
  }

  const currentDoc = documents[fileKey];
  console.log(`📊 Updating ${fileKey}: current stage=${currentDoc.stage}, new status=${update.status}, job_type=${update.job_type}`);

  // Update logic based on job status
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
    console.log(`✅ ${fileKey} moved to stage 3 (editing)`);
  } else if (update.job_type === 'format' && update.status === 'finished') {
    let result = {};
    try {
      // Result is a JSON string from worker.py containing formatted_text and summary_text
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
    console.log(`✅ ${fileKey} moved to stage 5 (completed)`);
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
    console.log(`❌ ${fileKey} failed at stage ${currentDoc.stage}`);
  } else {
    // For 'queued', 'started' updates
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
    console.log(`🔄 ${fileKey} status updated to: ${update.status}`);
  }
};

// --- WebSocket Hook (FIXED VERSION) ---
const useWebSocket = (url, onMessage) => {
  const connectionRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  
  // Update the ref when onMessage changes
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
    
    // Cleanup function: Close the WebSocket when the component unmounts
    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('🧹 Cleaning up WebSocket connection');
        ws.close();
      }
    };
  }, [connect]);
};

// --- Helper Components ---

const StatusBadge = ({ stage, status }) => {
  let color = 'bg-gray-200 text-gray-700';
  if (status === 'queued' || stage === 1) color = 'bg-blue-100 text-blue-600';
  if (status === 'started' || stage === 2 || stage === 4) color = 'bg-yellow-100 text-yellow-600 animate-pulse';
  if (status === 'editing' || stage === 3) color = 'bg-indigo-100 text-indigo-600';
  if (status === 'completed' || stage === 5) color = 'bg-green-500 text-white';
  if (status === 'failed') color = 'bg-red-500 text-white';

  const stageNames = {
    1: "Uploaded", 2: "Extracting", 3: "Review & Edit", 4: "Formatting", 5: "Completed"
  };
  
  return (
    <div className={`px-3 py-1 text-sm font-semibold rounded-full ${color}`}>
      {stageNames[stage] || status.toUpperCase()}
    </div>
  );
};

// Component for Stage 2 Extraction with Image Preview
const Stage2Extraction = React.memo(({ fileKey, fileData }) => {
  const [imageUrl, setImageUrl] = useState(null);
  const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');

  useEffect(() => {
    if (!isPDF && fileData && fileData.data_b64) {
      // Create object URL from base64 data for image preview
      const byteCharacters = atob(fileData.data_b64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: fileData.mime_type || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      setImageUrl(url);

      // Cleanup function
      return () => {
        URL.revokeObjectURL(url);
      };
    }
  }, [fileData, isPDF]);

  return (
    <div className="mt-4 p-4 bg-yellow-50 rounded-lg border border-yellow-200">
      <h4 className="text-xl font-semibold mb-3 text-yellow-700">🔍 Stage 2: Text Extraction in Progress</h4>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Image Preview or PDF Icon */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            {isPDF ? 'PDF Document' : 'Original Image'}
          </label>
          {isPDF ? (
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-white">
              <div className="text-6xl text-red-500 mb-2">📄</div>
              <p className="font-semibold text-gray-700">PDF Document</p>
              <p className="text-sm text-gray-500 mt-1">Text extraction in progress...</p>
              <p className="text-xs text-gray-400 mt-2">All pages will be processed</p>
            </div>
          ) : imageUrl ? (
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-2 bg-white">
              <img 
                src={imageUrl} 
                alt="Document being processed" 
                className="max-w-full h-auto rounded-lg shadow-sm max-h-80 object-contain mx-auto"
              />
              <p className="text-xs text-gray-500 text-center mt-2">
                {fileData?.name || fileKey}
              </p>
            </div>
          ) : (
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-white">
              <p className="text-gray-500">Loading preview...</p>
            </div>
          )}
        </div>
        
        {/* Extraction Status */}
        <div className="flex flex-col justify-center">
          <div className="text-center">
            <svg className="animate-spin h-12 w-12 text-yellow-500 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-lg font-semibold text-yellow-700 mb-2">
              {isPDF ? 'PDF Text Extraction' : 'AI Text Extraction'} in Progress
            </p>
            <p className="text-gray-600 mb-4">
              {isPDF 
                ? "We're extracting text from all pages of your PDF document. This may take a few moments..."
                : "We're using Gemini AI to extract text from your document. This usually takes a few seconds..."
              }
            </p>
            <div className="bg-white rounded-lg p-4 border border-yellow-200">
              <p className="text-sm text-gray-700">
                <span className="font-semibold">Processing:</span> {fileKey}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {isPDF 
                  ? "Compare the extracted text with your original PDF to verify accuracy"
                  : "Compare the extracted text with the original image to verify accuracy"
                }
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// Component for Stage 3 Interaction with Image Preview
const Stage3Editor = React.memo(({ fileKey, initialText, userId, fileData }) => {
    // Local state for editing the text before submitting to formatting
    const [editedText, setEditedText] = useState(initialText);
    const [isFormatting, setIsFormatting] = useState(false);
    const [imageUrl, setImageUrl] = useState(null);
    const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');

    // Update local state when initialText changes (e.g., when extraction completes)
    useEffect(() => {
        setEditedText(initialText);
    }, [initialText]);

    // Create image preview for non-PDF files
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

        return () => {
          URL.revokeObjectURL(url);
        };
      }
    }, [fileData, isPDF]);

    const handleFormat = async () => {
        setIsFormatting(true);
        
        try {
            console.log('📤 Submitting format job for:', fileKey);
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

            // Update local state and global store to indicate job started
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
        <div className="mt-4 p-4 bg-indigo-50 rounded-lg border border-indigo-200">
            <h4 className="text-xl font-semibold mb-3 text-indigo-700">✏️ Stage 3: Review & Edit</h4>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-4">
                {/* Image Preview or PDF Icon */}
                <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                        {isPDF ? 'PDF Document Reference' : 'Original Document'}
                    </label>
                    {isPDF ? (
                        <div className="border-2 border-gray-300 rounded-lg p-6 text-center bg-white">
                            <div className="text-5xl text-red-500 mb-3">📄</div>
                            <p className="font-semibold text-gray-700">PDF Document</p>
                            <p className="text-sm text-gray-500">Compare extracted text with original PDF</p>
                            <p className="text-xs text-gray-400 mt-2">All pages have been processed</p>
                        </div>
                    ) : imageUrl ? (
                        <div className="border-2 border-gray-300 rounded-lg p-2 bg-white">
                            <img 
                                src={imageUrl} 
                                alt="Document for reference" 
                                className="max-w-full h-auto rounded-lg shadow-sm max-h-80 object-contain mx-auto"
                            />
                            <p className="text-xs text-gray-500 text-center mt-2">
                                Compare with extracted text below
                            </p>
                        </div>
                    ) : (
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-white">
                            <p className="text-gray-500">Document preview not available</p>
                        </div>
                    )}
                </div>
                
                {/* Quick Tips */}
                <div className="bg-white rounded-lg p-4 border border-indigo-200">
                    <h5 className="font-semibold text-indigo-600 mb-2">💡 Editing Tips</h5>
                    <ul className="text-sm text-gray-600 space-y-1">
                        <li>• Correct any misread characters or words</li>
                        <li>• Fix line breaks and paragraph structure</li>
                        <li>• Verify numbers and special characters</li>
                        <li>• Check for missing or duplicated text</li>
                        {isPDF && <li>• Review text from all pages</li>}
                    </ul>
                </div>
            </div>

            <label className="block text-sm font-medium text-gray-700 mb-2">
                Extracted Text {isPDF ? '(from PDF)' : ''} (Edit if needed)
            </label>
            <textarea
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                rows="12"
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 text-sm resize-none"
                placeholder="Review and correct extracted text here..."
            />
            <button
                onClick={handleFormat}
                disabled={isFormatting}
                className={`mt-3 w-full font-semibold py-2 rounded-lg transition duration-150 ${
                    isFormatting
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                }`}
            >
                {isFormatting ? 'Submitting for Formatting...' : 'Start AI Formatting & Summarization'}
            </button>
        </div>
    );
});

// Component for Stage 5 Output
const Stage5Output = React.memo(({ fileKey, formattedText, summaryText, fileData }) => {
    const [formattedEdit, setFormattedEdit] = useState(formattedText);
    const [summaryEdit, setSummaryEdit] = useState(summaryText);
    const [imageUrl, setImageUrl] = useState(null);
    const isPDF = fileData?.mime_type === 'application/pdf' || fileKey?.toLowerCase().endsWith('.pdf');
    
    // Update local state if the main data changes (e.g., re-formatting)
    useEffect(() => {
        setFormattedEdit(formattedText);
        setSummaryEdit(summaryText);
    }, [formattedText, summaryText]);

    // Create image preview for non-PDF files
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

        return () => {
          URL.revokeObjectURL(url);
        };
      }
    }, [fileData, isPDF]);
    
    // Function to download content as a blob/PDF
    const downloadBlob = (content, filename, mimeType) => {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="mt-4 p-4 bg-green-50 rounded-xl border border-green-200">
            <h4 className="text-xl font-semibold mb-3 text-green-700">✅ Stage 5: Final Output</h4>
            
            {/* Original Document Reference */}
            <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                    Original Document Reference
                </label>
                {isPDF ? (
                    <div className="border-2 border-gray-300 rounded-lg p-4 bg-white max-w-md">
                        <div className="text-4xl text-red-500 text-center mb-2">📄</div>
                        <p className="text-center text-sm text-gray-700">Original PDF Reference</p>
                        <p className="text-center text-xs text-gray-500">All pages processed</p>
                    </div>
                ) : imageUrl ? (
                    <div className="border-2 border-gray-300 rounded-lg p-2 bg-white max-w-md">
                        <img 
                            src={imageUrl} 
                            alt="Original document" 
                            className="max-w-full h-auto rounded-lg shadow-sm max-h-60 object-contain mx-auto"
                        />
                    </div>
                ) : (
                    <p className="text-sm text-gray-500">Original document reference not available</p>
                )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                    <label className="block text-sm font-medium text-gray-700">Formatted Document</label>
                    <textarea 
                        value={formattedEdit} 
                        onChange={(e) => setFormattedEdit(e.target.value)} 
                        rows="10" 
                        className="w-full p-2 border border-gray-300 rounded-lg text-sm resize-none"
                    />
                    <button
                        onClick={() => downloadBlob(formattedEdit, `formatted_${fileKey}.txt`, 'text/plain')}
                        className="mt-2 w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition duration-150"
                    >
                        📥 Download Formatted Text
                    </button>
                </div>
                <div>
                    <label className="block text-sm font-medium text-gray-700">AI Summary</label>
                    <textarea 
                        value={summaryEdit} 
                        onChange={(e) => setSummaryEdit(e.target.value)} 
                        rows="10" 
                        className="w-full p-2 border border-gray-300 rounded-lg text-sm resize-none"
                    />
                    <button
                        onClick={() => downloadBlob(summaryEdit, `summary_${fileKey}.txt`, 'text/plain')}
                        className="mt-2 w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition duration-150"
                    >
                        📥 Download Summary Text
                    </button>
                </div>
            </div>
        </div>
    );
});

// The main component that displays one document's workflow
const DocumentCard = React.memo(({ fileKey, documentData, fileData }) => {
    const { status, stage, extract_job_id, extracted_text, formatted_text, summary_text } = documentData;
    
    return (
        <div className="bg-white p-6 rounded-xl shadow-lg border-t-4 border-indigo-400 mb-6">
            <div className="flex justify-between items-start mb-4">
                <h3 className="text-xl font-bold text-gray-800 break-words pr-4">{fileKey}</h3>
                <StatusBadge stage={stage} status={status} />
            </div>

            <div className="space-y-2 text-sm text-gray-600 mb-4">
                <p>Status: <span className="font-medium">{status.toUpperCase()}</span></p>
                {extract_job_id && <p>Job ID: <span className="font-mono text-xs">{extract_job_id}</span></p>}
            </div>

            {/* Stage 2 Extraction with Image Preview */}
            {stage === 2 && (
                <Stage2Extraction 
                    fileKey={fileKey}
                    fileData={fileData}
                />
            )}

            {/* Stage 4 Loading Spinner */}
            {stage === 4 && (
                <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
                    <svg className="animate-spin h-8 w-8 text-indigo-500 mx-auto mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <p className="text-gray-600">AI Formatting and Summarization in progress...</p>
                </div>
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

            {/* Debug Info */}
            <div className="mt-4 p-2 bg-gray-100 rounded text-xs text-gray-600">
                <p>Stage: {stage} | Status: {status}</p>
            </div>
        </div>
    );
});

// --- Main Application Component ---
const App = () => {
    const { documents } = useDocumentStore();
    const [files, setFiles] = useState([]);
    const [fileDataMap, setFileDataMap] = useState({});
    const [isUploading, setIsUploading] = useState(false);
    
    // Construct the dynamic WebSocket URL
    const websocketUrl = `ws://localhost:8000/ws/status/${USER_ID}`;
    
    // WebSocket message handler
    const handleWsMessage = useCallback((update) => {
        console.log('🔄 Processing WebSocket update:', update);
        updateDocumentState(update);
    }, []);

    // Initialize the WebSocket connection
    useWebSocket(websocketUrl, handleWsMessage); 
    
    // --- File Upload Logic ---
    const handleUpload = async () => {
        if (files.length === 0) return;
        setIsUploading(true);
        
        // Store file data for image preview
        const newFileDataMap = { ...fileDataMap };
        
        // Create form data payload for the API
        const formData = new FormData();
        formData.append('user_id', USER_ID);
        
        // Read files and store data for preview
        for (const file of files) {
            formData.append('files', file);
            
            // Store file data for preview
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result.split(',')[1]; // Remove data:image/... prefix
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
            
            // Initialize state for each submitted job based on API response
            const newDocuments = { ...documents };
            results.job_submissions.forEach(job => {
                newDocuments[job.file_name] = {
                    file_name: job.file_name,
                    status: 'started',
                    stage: 2, // Start at stage 2 (extracting)
                    extract_job_id: job.job_id,
                    extracted_text: '',
                    edited_text: '',
                    formatted_text: '',
                    summary_text: '',
                };
                console.log(`📝 Created document state for: ${job.file_name}`);
            });
            
            documentStore.setState({ documents: newDocuments });
            setFiles([]); // Clear file input after submission
            
            console.log(`📊 Total documents in state: ${Object.keys(newDocuments).length}`);
            
        } catch (error) {
            console.error('❌ Error during upload:', error);
            alert('Error during upload. Check console for details.');
        } finally {
            setIsUploading(false);
        }
    };

    // Sort documents by stage to show completed ones at bottom
    const sortedDocuments = Object.entries(documents).sort(([,a], [,b]) => {
        // Show in-progress documents first, then completed
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
        <div className="min-h-screen bg-gray-50 p-8 font-sans">
            <div className="max-w-6xl mx-auto">
                <h1 className="text-4xl font-extrabold text-indigo-800 text-center mb-8">
                    Handwritten Document Processor
                </h1>

                {/* Upload Section */}
                <div className="bg-white p-6 rounded-xl shadow-md mb-8 border border-indigo-100">
                    <h2 className="text-2xl font-semibold mb-4 text-indigo-600">Stage 1: Upload Documents</h2>
                    
                    <input 
                        type="file" 
                        multiple 
                        onChange={(e) => setFiles(Array.from(e.target.files))} 
                        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                    />
                    
                    <div className="mt-3 text-sm text-gray-600">
                        {files.length > 0 ? `Selected ${files.length} files: ${files.map(f => f.name).join(', ')}` : 'Select PNG, JPG, or PDF files.'}
                    </div>
                    
                    <button
                        onClick={handleUpload}
                        disabled={files.length === 0 || isUploading}
                        className={`mt-4 w-full text-white font-semibold py-2 rounded-lg transition duration-150 ${
                            files.length === 0 || isUploading 
                                ? 'bg-gray-400 cursor-not-allowed' 
                                : 'bg-indigo-600 hover:bg-indigo-700'
                        }`}
                    >
                        {isUploading ? 'Uploading & Queuing Jobs...' : `Process ${files.length} Document(s)`}
                    </button>
                </div>
                
                {/* Document Dashboard */}
                <div className="flex justify-between items-center mb-6 mt-10">
                    <h2 className="text-3xl font-extrabold text-gray-700 border-b pb-2">
                        Document Processing Dashboard
                    </h2>
                    <div className="text-sm text-gray-500">
                        {Object.keys(documents).length} document(s) in queue
                    </div>
                </div>
                
                {DocumentCards.length > 0 ? (
                    <div className="space-y-4">
                        {DocumentCards}
                    </div>
                ) : (
                    <div className="text-center py-12 text-gray-500 bg-white rounded-xl shadow-inner">
                        Upload documents to begin processing.
                    </div>
                )}
                
                <footer className="text-center mt-10 pt-4 text-sm text-gray-400 border-t">
                    FastAPI & React with Real-Time WebSockets
                    <p className="mt-1">User ID: {USER_ID} | API Status: {API_URL}</p>
                </footer>
            </div>
        </div>
    );
};

export default App;