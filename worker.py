# worker.py - COMPLETE WORKER WITH EXTERNAL PROMPTS

import os
import sys
import time
import io
import base64
import math
import random
from datetime import timedelta
import threading
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from redis import Redis
from rq import Queue, get_current_job
from dotenv import load_dotenv

# image + pdf libs
import fitz
from PIL import Image

# Gemini
from google import genai
from google.genai import types

# Import prompts from separate file
from prompts import get_prompt

load_dotenv()

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# ---------- Configuration ----------
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
redis = Redis.from_url(REDIS_URL, decode_responses=False)
rq_queue = Queue(connection=redis)

# Use all 4 keys from your .env
API_KEYS = [
    os.getenv("GEMINI_API_KEY_1"), 
    os.getenv("GEMINI_API_KEY_2"), 
    os.getenv("GEMINI_API_KEY_3"),
    os.getenv("GEMINI_API_KEY_4")
]
API_KEYS = [k for k in API_KEYS if k]

# Tunables
PER_KEY_LIMIT = int(os.getenv("PER_KEY_LIMIT", 60))
WINDOW_SECONDS = int(os.getenv("WINDOW_SECONDS", 60))
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", 90))
CONCURRENCY_LIMIT = int(os.getenv("CONCURRENCY_LIMIT", 3))

# ---------- Redis-backed API manager ----------
class APIManagerRedis:
    def __init__(
        self,
        api_keys,
        per_key_limit=60,
        window_seconds=60,
        cooldown_seconds=90,
        concurrency_limit=3,
        key_prefix="handwritten"
    ):
        self.api_keys = [k for k in api_keys if k]
        self.per_key_limit = int(per_key_limit)
        self.window_seconds = int(window_seconds)
        self.cooldown_seconds = int(cooldown_seconds)
        self.semaphore = threading.Semaphore(int(concurrency_limit)) 
        self.key_prefix = key_prefix

    def _counter_bucket_key(self, key, bucket_ts):
        return f"{self.key_prefix}:cnt:{self._short_key(key)}:{bucket_ts}"
    
    def _cooldown_key(self, key):
        return f"{self.key_prefix}:cd:{self._short_key(key)}"
    
    def _short_key(self, key):
        return str(abs(hash(key)))[0:12]
    
    def _now_bucket(self):
        return int(time.time()) // self.window_seconds

    def try_acquire_key(self):
        if not self.api_keys:
            return None
        bucket = self._now_bucket()
        keys = list(self.api_keys)
        random.shuffle(keys)
        for key in keys:
            if redis.get(self._cooldown_key(key)):
                continue
            bucket_key = self._counter_bucket_key(key, bucket)
            count = redis.incr(bucket_key)
            redis.expire(bucket_key, self.window_seconds + 5)
            if int(count) <= self.per_key_limit:
                return key
            else:
                redis.set(self._cooldown_key(key), "1", ex=self.cooldown_seconds)
                continue
        return None
    
    def mark_key_cooldown(self, key, cooldown_seconds=None):
        ttl = int(cooldown_seconds) if cooldown_seconds else self.cooldown_seconds
        redis.set(self._cooldown_key(key), "1", ex=ttl)

    def all_keys_in_cooldown(self):
        if not self.api_keys:
            return True
        for key in self.api_keys:
            if not redis.get(self._cooldown_key(key)):
                return False
        return True

    def acquire_slot(self, timeout=None):
        return self.semaphore.acquire(timeout=timeout)

    def release_slot(self):
        try:
            self.semaphore.release()
        except Exception:
            pass
            
# Initialize API manager
api_manager = APIManagerRedis(
    api_keys=API_KEYS,
    per_key_limit=PER_KEY_LIMIT,
    window_seconds=WINDOW_SECONDS,
    cooldown_seconds=COOLDOWN_SECONDS,
    concurrency_limit=CONCURRENCY_LIMIT,
    key_prefix=os.getenv("API_KEY_PREFIX", "handwritten") 
)

# ---------- Utility helpers ----------
def b64_to_bytes(b64_string):
    return base64.b64decode(b64_string)

def resize_image_bytes(image_bytes, max_dim=1024, quality=85):
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        if image.mode in ("RGBA", "LA"):
            bg = Image.new("RGB", image.size, (255, 255, 255))
            bg.paste(image, mask=image.split()[-1])
            image = bg
        elif image.mode != "RGB":
            image = image.convert("RGB")
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=quality, optimize=True)
        return out.getvalue()
    except Exception as e:
        return image_bytes

def render_pdf_to_images(pdf_bytes, dpi=200):
    images = []
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        for i in range(len(doc)):
            page = doc.load_page(i)
            pix = page.get_pixmap(dpi=dpi)
            img_bytes = pix.tobytes("png")
            images.append((img_bytes, i+1))
        doc.close()
    except Exception as e:
        logger.error(f"PDF rendering failed: {e}")
        return []
    return images

# ---------- Pub/Sub Notification Function ----------
def notify_job_completion(job_id, job_type, user_id, file_name, success=True, result=None):
    """Notify FastAPI server that a job has completed by pushing to Redis Pub/Sub."""
    try:
        # Create a pub/sub connection
        pub_redis = Redis.from_url(REDIS_URL, decode_responses=True)
        
        # Publish completion event
        message = {
            'job_id': job_id,
            'job_type': job_type,
            'user_id': user_id,
            'file_name': file_name,
            'success': success,
            'result': result,
            'timestamp': time.time()
        }
        
        # The FastAPI server (api.py) subscribes to 'job_completions'
        pub_redis.publish('job_completions', json.dumps(message))
        logger.info(f"📢 Published job completion: {job_id} for {file_name} (success: {success})")
        
    except Exception as e:
        logger.error(f"❌ Failed to publish job completion: {e}")

# ---------- Gemini safe caller ----------
def call_gemini_safe(parts, max_retries=5, base_delay=1.0):
    attempt = 0
    while attempt < max_retries:
        attempt += 1
        if api_manager.all_keys_in_cooldown():
            wait = min(10, base_delay * (2 ** (attempt - 1))) + random.random()
            time.sleep(wait)
            continue
        if not api_manager.acquire_slot(timeout=10):
            time.sleep(0.5 + random.random())
            continue
        try:
            key = api_manager.try_acquire_key()
            if not key:
                api_manager.release_slot()
                time.sleep(0.5 + random.random())
                continue
            try:
                client = genai.Client(api_key=key)
                response = client.models.generate_content(
                    model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
                    contents=[types.Content(parts=parts)]
                )
                text = getattr(response, "text", None) or getattr(response, "output_text", None) or None
                if text:
                    return text
                else:
                    raise RuntimeError("Empty response from model")
            except Exception as exc:
                err = str(exc).lower()
                if "rate limit" in err or "quota" in err or "429" in err:
                    api_manager.mark_key_cooldown(key)
                wait = min(30, base_delay * (2 ** (attempt - 1))) + random.random()
                time.sleep(wait)
                continue
            finally:
                api_manager.release_slot()
        except Exception:
            pass 
    return None

# ---------- Extraction/Format/Summarize Functions (USING EXTERNAL PROMPTS) ----------
def extract_text_from_image_bytes(image_bytes):
    if len(image_bytes) > (5 * 1024 * 1024):
        image_bytes = resize_image_bytes(image_bytes, max_dim=1200)
    blob_b64 = base64.b64encode(image_bytes).decode("utf-8")
    parts = [
        types.Part(text=get_prompt("extraction")),  # Using external prompt
        types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=blob_b64))
    ]
    txt = call_gemini_safe(parts, max_retries=6)
    if txt is None:
        return "[UNREADABLE OR API FAILURE]"
    return txt

def format_document(raw_text):
    parts = [types.Part(text=get_prompt("formatting") + "\n\n" + raw_text)]  # Using external prompt
    return call_gemini_safe(parts, max_retries=4)

def summarize_document(raw_text):
    parts = [types.Part(text=get_prompt("summarization") + "\n\n" + raw_text)]  # Using external prompt
    return call_gemini_safe(parts, max_retries=4)

# ---------- RQ JOB ROUTER ----------
# worker.py - FIXED FUNCTION SIGNATURE

# ... (all your imports and other code remains the same)

# ---------- RQ JOB ROUTER (FIXED SIGNATURE) ----------
def process_job(job_type, payload, metadata=None):
    """Main job processing function called by RQ worker"""
    # RQ automatically passes the job as first argument, so we need to adjust
    if metadata is None:
        metadata = {}
    
    # Get the current job from RQ context to access job_id
    job = get_current_job()
    job_id = job.id if job else "UNKNOWN_JOB"

    logger.info(f"🔧 Starting job {job_id}")
    logger.info(f"🔧 Job type: {job_type}, Metadata: {metadata}")
    
    final_result = None
    success = False
    user_id = metadata.get('user_id', 'unknown')
    file_name = metadata.get('file_name', 'unknown')

    try:
        logger.info(f"🚀 Starting {job_type.upper()} job {job_id} for {file_name} (user: {user_id})")
        
        if job_type == 'extract':
            files_serialized = payload
            if not files_serialized:
                final_result = "ERROR: No file data provided"
                success = False
            else:
                f = files_serialized[0]
                
                logger.info(f"🔧 Processing file: {file_name} for user: {user_id}")
                
                mime = f.get("mime_type", "image/png")
                data_b64 = f.get("data_b64")
                
                if not data_b64:
                    final_result = f"ERROR: No data for {file_name}"
                    success = False
                else:
                    raw_bytes = b64_to_bytes(data_b64)
                    overall_text = ""

                    if mime == "application/pdf" or file_name.lower().endswith(".pdf"):
                        logger.info(f"📄 Processing PDF: {file_name}")
                        pages = render_pdf_to_images(raw_bytes, dpi=200)
                        if not pages:
                            overall_text = f"--- {file_name} | PDF FAILURE: NO PAGES EXTRACTED ---\n\n"
                            success = False
                        else:
                            logger.info(f"📄 PDF has {len(pages)} pages")
                            for page_bytes, pno in pages:
                                logger.info(f"🔍 Extracting text from page {pno}")
                                txt = extract_text_from_image_bytes(page_bytes)
                                overall_text += f"--- {file_name} | page {pno} ---\n{txt}\n\n"
                                time.sleep(random.uniform(0.8, 1.5))
                            success = True
                    else:
                        logger.info(f"🖼️ Processing image: {file_name}")
                        txt = extract_text_from_image_bytes(raw_bytes)
                        overall_text = f"--- {file_name} ---\n{txt}\n\n"
                        time.sleep(random.uniform(0.8, 1.5))
                        success = True if not txt.startswith("[UNREADABLE") else False
                    
                    final_result = overall_text
        
        elif job_type == 'format':
            logger.info(f"📝 Formatting document: {file_name}")
            raw_text = payload
            formatted = format_document(raw_text) or raw_text
            summary = summarize_document(raw_text) or ""
            
            final_result = json.dumps({
                "formatted_text": formatted,
                "summary_text": summary
            })
            success = True
        
        else:
            final_result = json.dumps({"error": "unknown_job_type", "message": f"Job type '{job_type}' not recognized."})
            success = False
            logger.warning(f"⚠️ Job {job_id} received unknown job_type: {job_type}")

    except Exception as e:
        logger.error(f"❌ Job {job_id} failed with error: {e}", exc_info=True)
        final_result = f"FATAL_WORKER_ERROR: {str(e)}"
        success = False
        
        if api_manager.all_keys_in_cooldown():
            logger.warning("🔒 All API keys in cooldown - consider increasing limits")
    
    finally:
        # Always notify completion
        notify_job_completion(job_id, job_type, user_id, file_name, success, final_result)
        logger.info(f"✅ Finished {job_type.upper()} job {job_id}. Success: {success}")
        
        return final_result

# For testing directly
if __name__ == "__main__":
    print("🧪 Testing worker functions...")
    
    # Test with mock data
    test_metadata = {
        "user_id": "test_user",
        "job_type": "extract", 
        "file_name": "test.pdf"
    }
    
    # Test extraction with a small job
    try:
        result = process_job('extract', [], job_id='test_job', metadata=test_metadata)
        print(f"Test result: {result}")
    except Exception as e:
        print(f"Test failed: {e}")