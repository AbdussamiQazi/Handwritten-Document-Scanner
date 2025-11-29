# api.py - UPDATED CORS CONFIGURATION

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict, Any
import os
import json
import base64
import time
import uvicorn
import threading
from redis import Redis
from rq import Queue as RQ_Queue
from dotenv import load_dotenv
import asyncio
import nest_asyncio
import gunicorn

nest_asyncio.apply()

try:
    from worker import processJob  # Note: changed from process_job to processJob
except ImportError:
    # Placeholder for local testing if worker.py is not in the same location
    def processJob(*args, **kwargs):
        return json.dumps({"formatted_text": "MOCK FORMATTED RESULT", "summary_text": "MOCK SUMMARY RESULT"})

load_dotenv()

# --- Configuration ---
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis = Redis.from_url(REDIS_URL, decode_responses=False)

# Import queue manager
try:
    from queueManager import extractionQueue, formattingQueue, getQueueStats
    print("✅ Queue manager imported successfully")
except ImportError as e:
    print(f"❌ Failed to import queue manager: {e}")
    # Fallback to single queue
    extractionQueue = RQ_Queue(connection=redis, name='document_processing')
    formattingQueue = extractionQueue
    
    def getQueueStats():
        return {
            'extraction': extractionQueue.count,
            'formatting': 0,
            'fallback': 0,
            'total': extractionQueue.count
        }

app = FastAPI(title="Bolt AI Document API")

# --- FIXED CORS Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins_regex=".*",  # Specific React dev server
    allow_credentials=True,
    allow_methods=["*"],  # Allow all methods
    allow_headers=["*"],  # Allow all headers
)

# --- WebSocket Manager for Real-Time Push ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        print(f"✅ WS: Client {user_id} connected. Total: {len(self.active_connections)}")

    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
            print(f"❌ WS: Client {user_id} disconnected. Total: {len(self.active_connections)}")

    async def send_personal_message(self, message: str, user_id: str):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_text(message)
                print(f"📨 WS: Sent message to {user_id}")
            except Exception as e:
                print(f"❌ WS: Error sending to {user_id}: {e}")
                self.disconnect(user_id)


manager = ConnectionManager()

# --- Redis Pub/Sub Listener ---
def start_pubsub_listener():
    print("🔔 Starting PubSub listener for job completions...")
    pubsub_redis = Redis.from_url(REDIS_URL, decode_responses=True)
    pubsub = pubsub_redis.pubsub()
    pubsub.subscribe('job_completions')
    print("✅ PubSub: Listening for 'job_completions' channel...")
    
    for message in pubsub.listen():
        if message['type'] == 'message':
            try:
                data = json.loads(message['data'])
                
                user_id = data.get('user_id', 'unknown')
                job_id = data.get('job_id', 'unknown')
                job_type = data.get('job_type', 'unknown')
                file_name = data.get('file_name', 'unknown')
                success = data.get('success', False)
                result = data.get('result', '')
                
                print(f"📨 PubSub: Received completion - user_id={user_id}, job_id={job_id}, type={job_type}, success={success}")
                
                stage = 0
                status = "finished" if success else "failed"
                if job_type == 'extract':
                    stage = 3 if success else 2
                elif job_type == 'format':
                    stage = 5 if success else 4
                
                client_message = json.dumps({
                    "job_id": job_id,
                    "file_name": file_name,
                    "user_id": user_id,
                    "status": status,
                    "stage": stage,
                    "job_type": job_type,
                    "result": result
                })
                
                print(f"🔍 DEBUG PubSub: Sending WS message - user_id={user_id}, job_type={job_type}, status={status}, stage={stage}")
                #print(f"🔍 DEBUG PubSub: Full message: {client_message}")
                
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        asyncio.create_task(manager.send_personal_message(client_message, user_id))
                    else:
                        loop.run_until_complete(manager.send_personal_message(client_message, user_id))
                except Exception as e:
                    print(f"❌ PubSub: Error sending WS message: {e}")
                
            except Exception as e:
                print(f"❌ PubSub: Error processing message: {e}")
                import traceback
                print(traceback.format_exc())

# Start the listener thread on application startup
@app.on_event("startup")
async def startup_event():
    try:
        redis.ping()
        print("✅ Redis connection successful.")
    except Exception as e:
        print(f"❌ Redis connection failed: {e}. Check REDIS_URL environment variable.")

    thread = threading.Thread(target=start_pubsub_listener, daemon=True)
    thread.start()
    print("🚀 Background PubSub listener started")

# --- API Routes ---

@app.post("/api/upload")
async def handle_upload(user_id: str = Form(...), files: List[UploadFile] = File(...)):
    """Handles file upload and submits extract jobs to extraction queue."""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    print(f"📤 Upload request from user {user_id} with {len(files)} files")
    
    job_submissions = []
    
    for file in files:
        print(f"📄 Processing file: {file.filename}")
        file_bytes = await file.read()
        file_data = {
            "name": file.filename,
            "data_b64": base64.b64encode(file_bytes).decode('utf-8'),
            "mime_type": file.content_type
        }
        
        job = extractionQueue.enqueue(
            processJob,
            'extract',
            [file_data],
            {
                "user_id": user_id, 
                "job_type": 'extract', 
                "file_name": file.filename
            },
            job_timeout=300,
            result_ttl=1800,
            failure_ttl=3600
        )
        
        job_submissions.append({
            "job_id": job.id,
            "file_name": file.filename,
            "status": "queued"
        })
        
        print(f"✅ Enqueued extraction job {job.id} for {file.filename}")

    return {"status": "success", "job_submissions": job_submissions}

@app.post("/api/format")
async def handle_format(data: Dict[str, str]):
    """Submits the formatting and summarization job to formatting queue."""
    file_name = data.get("file_name")
    raw_text = data.get("raw_text")
    user_id = data.get("user_id", "default_user")

    if not raw_text or not file_name:
        raise HTTPException(status_code=400, detail="Missing text or file_name.")

    print(f"📝 Format request for {file_name} from user {user_id}")

    job = formattingQueue.enqueue(
        processJob,
        'format',
        raw_text,
        {
            "user_id": user_id, 
            "job_type": 'format', 
            "file_name": file_name
        },
        job_timeout=300,
        result_ttl=1800
    )

    print(f"✅ Enqueued formatting job {job.id} for {file_name}")
    
    return {"status": "success", "job_id": job.id, "file_name": file_name}

# --- Monitoring Endpoints ---
@app.get("/api/queue-stats")
async def get_queue_stats():
    """Get current queue statistics for monitoring"""
    try:
        stats = getQueueStats()
        return {
            "status": "success",
            "queues": stats,
            "timestamp": time.time(),
            "message": "Queue statistics retrieved successfully"
        }
    except Exception as e:
        print(f"❌ Error getting queue stats: {e}")
        return {
            "status": "error",
            "queues": {
                "extraction": 0,
                "formatting": 0,
                "fallback": 0,
                "total": 0
            },
            "timestamp": time.time(),
            "message": f"Error retrieving queue stats: {str(e)}"
        }

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    try:
        redis.ping()
        redis_status = "healthy"
    except:
        redis_status = "unhealthy"
    
    return {
        "status": "success",
        "redis": redis_status,
        "timestamp": time.time(),
        "version": "1.0"
    }

# --- WebSocket Endpoint ---
@app.websocket("/ws/status/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """Real-time status updates via WebSocket."""
    print(f"🔌 WebSocket connection attempt for user: {user_id}")
    
    await manager.connect(websocket, user_id)
    print(f"✅ WebSocket connected for user: {user_id}")
    
    try:
        while True:
            try:
                message = await websocket.receive_text()
                print(f"📥 Received from client {user_id}: {message}")
            except Exception as e:
                print(f"❌ WebSocket receive error for {user_id}: {e}")
                break
    
    except Exception as e:
        print(f"❌ WebSocket connection error for {user_id}: {e}")
        
    finally:
        manager.disconnect(user_id)
        print(f"👋 WebSocket disconnected for user: {user_id}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")