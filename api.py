# api.py - FastAPI Server for React Frontend

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

nest_asyncio.apply()

try:
    from worker import process_job 
except ImportError:
    # Placeholder for local testing if worker.py is not in the same location
    def process_job(*args, **kwargs):
        return json.dumps({"formatted_text": "MOCK FORMATTED RESULT", "summary_text": "MOCK SUMMARY RESULT"})


load_dotenv()

# --- Configuration ---
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis = Redis.from_url(REDIS_URL, decode_responses=False)
rq_queue = RQ_Queue(connection=redis, name='document_processing')

app = FastAPI(title="Bolt AI Document API")

# --- CORS Middleware (Required for React to talk to FastAPI) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # WARNING: Use specific domains in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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

# --- Redis Pub/Sub Listener (FIXED VERSION) ---
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
                
                # Safe key access with defaults
                user_id = data.get('user_id', 'unknown')
                job_id = data.get('job_id', 'unknown')
                job_type = data.get('job_type', 'unknown')
                file_name = data.get('file_name', 'unknown')
                success = data.get('success', False)
                result = data.get('result', '')
                
                print(f"📨 PubSub: Received completion - user_id={user_id}, job_id={job_id}, type={job_type}, success={success}")
                
                # Update status/stage based on job type
                stage = 0
                status = "finished" if success else "failed"
                if job_type == 'extract':
                    stage = 3 if success else 2
                elif job_type == 'format':
                    stage = 5 if success else 4
                
                # Create message for WebSocket
                client_message = json.dumps({
                    "job_id": job_id,
                    "file_name": file_name,
                    "user_id": user_id,
                    "status": status,
                    "stage": stage,
                    "job_type": job_type,
                    "result": result
                })
                
                print(f"📤 PubSub: Sending WS message to {user_id}")
                
                # Use asyncio to run in existing event loop (FIXED)
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
    # Check Redis connection
    try:
        redis.ping()
        print("✅ Redis connection successful.")
    except Exception as e:
        print(f"❌ Redis connection failed: {e}. Check REDIS_URL environment variable.")

    # Start PubSub listener in background thread
    thread = threading.Thread(target=start_pubsub_listener, daemon=True)
    thread.start()
    print("🚀 Background PubSub listener started")


# --- API Routes ---

@app.post("/api/upload")
async def handle_upload(user_id: str = Form(...), files: List[UploadFile] = File(...)):
    """Handles file upload and submits extract jobs to RQ."""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    print(f"📤 Upload request from user {user_id} with {len(files)} files")
    
    job_submissions = []
    
    for file in files:
        print(f"📄 Processing file: {file.filename}")
        # Convert file to base64 for RQ payload
        file_bytes = await file.read()
        file_data = {
            "name": file.filename,
            "data_b64": base64.b64encode(file_bytes).decode('utf-8'),
            "mime_type": file.content_type
        }
        
        # Submit job to RQ
        job = rq_queue.enqueue(
            process_job,
            'extract',
            [file_data],
            {
                "user_id": user_id, 
                "job_type": 'extract', 
                "file_name": file.filename
            },  # metadata as kwarg
            job_timeout=600,
            result_ttl=3600
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
    """Submits the formatting and summarization job."""
    file_name = data.get("file_name")
    raw_text = data.get("raw_text")
    user_id = data.get("user_id", "default_user")

    if not raw_text or not file_name:
        raise HTTPException(status_code=400, detail="Missing text or file_name.")

    print(f"📝 Format request for {file_name} from user {user_id}")

    # Submit job to RQ
    job = rq_queue.enqueue(
        process_job,
        'format',
        raw_text,
        {
            "user_id": user_id, 
            "job_type": 'format', 
            "file_name": file_name
        },  # metadata as kwarg
        job_timeout=600,
        result_ttl=3600
    )

    print(f"✅ Enqueued formatting job {job.id} for {file_name}")
    
    return {"status": "success", "job_id": job.id, "file_name": file_name}


# --- WebSocket Endpoint ---
@app.websocket("/ws/status/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """Real-time status updates via WebSocket."""
    print(f"🔌 WebSocket connection attempt for user: {user_id}")
    
    # 1. Connect the client
    await manager.connect(websocket, user_id)
    print(f"✅ WebSocket connected for user: {user_id}")
    
    try:
        # 2. Loop to listen for messages from the client (keeps connection alive)
        while True:
            try:
                # We must await a receive operation to keep connection alive
                message = await websocket.receive_text()
                print(f"📥 Received from client {user_id}: {message}")
                # Optional: Add logic to process client-sent messages if needed
            except Exception as e:
                print(f"❌ WebSocket receive error for {user_id}: {e}")
                break
    
    except Exception as e:
        print(f"❌ WebSocket connection error for {user_id}: {e}")
        
    finally:
        # 3. Disconnect gracefully
        manager.disconnect(user_id)
        print(f"👋 WebSocket disconnected for user: {user_id}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")