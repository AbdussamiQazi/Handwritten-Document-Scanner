# worker.py - USING gemini-2.0-flash

import os
import sys
import time
import io
import base64
import random
import threading
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from redis import Redis
from rq import get_current_job
from dotenv import load_dotenv

# image + pdf libs
import fitz
from PIL import Image

# Gemini
from google import genai
from google.genai import types

# Import prompts and queue manager
from prompts import get_prompt
from queueManager import getNextExtractionKey, getNextFormattingKey, getFallbackKey, getQueueStats

load_dotenv()

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# ---------- Configuration ----------
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# FIXED: Create Redis connection with proper decoding
try:
    redis_conn = Redis.from_url(REDIS_URL, decode_responses=False)
    redis_conn.ping()
    logger.info("✅ Redis connection successful!")
except Exception as e:
    logger.error(f"❌ Redis connection failed: {e}")
    # Fallback to local Redis
    REDIS_URL = "redis://localhost:6379/0"
    redis_conn = Redis.from_url(REDIS_URL, decode_responses=False)

# Separate concurrency limits
EXTRACTION_CONCURRENCY = int(os.getenv("EXTRACTION_CONCURRENCY", 4))
FORMATTING_CONCURRENCY = int(os.getenv("FORMATTING_CONCURRENCY", 2))
FALLBACK_CONCURRENCY = int(os.getenv("FALLBACK_CONCURRENCY", 1))

# Rate limits
PER_KEY_LIMIT = int(os.getenv("PER_KEY_LIMIT", 85))
WINDOW_SECONDS = int(os.getenv("WINDOW_SECONDS", 60))
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", 75))

# Use gemini-2.5-flash (current available model)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
logger.info(f"🔧 Using Gemini model: {GEMINI_MODEL}")

# ---------- Enhanced API Manager with Queue Support ----------
class QueueAwareAPIManager:
    def __init__(self, queue_type):
        self.queue_type = queue_type
        self.semaphore = self._getSemaphore(queue_type)
        self.keyRotation = {
            'extraction': getNextExtractionKey,
            'formatting': getNextFormattingKey,
            'fallback': getFallbackKey
        }
        
    def _getSemaphore(self, queue_type):
        if queue_type == 'extraction':
            return threading.Semaphore(EXTRACTION_CONCURRENCY)
        elif queue_type == 'formatting':
            return threading.Semaphore(FORMATTING_CONCURRENCY)
        else:
            return threading.Semaphore(FALLBACK_CONCURRENCY)
    
    def getApiKey(self):
        key_func = self.keyRotation.get(self.queue_type)
        if key_func:
            key = key_func()
            if key:
                logger.info(f"🔑 Using key for {self.queue_type} queue")
                return key
        logger.error(f"❌ No API key function found for {self.queue_type}")
        return None
    
    def acquireSlot(self, timeout=10):
        return self.semaphore.acquire(timeout=timeout)
    
    def releaseSlot(self):
        try:
            self.semaphore.release()
        except:
            pass

    # Rate limiting methods
    def _counterBucketKey(self, key, bucket_ts):
        return f"handwritten:cnt:{self._shortKey(key)}:{bucket_ts}"
    
    def _cooldownKey(self, key):
        return f"handwritten:cd:{self._shortKey(key)}"
    
    def _shortKey(self, key):
        return str(abs(hash(key)))[0:12]
    
    def _nowBucket(self):
        return int(time.time()) // WINDOW_SECONDS

    def tryAcquireKey(self):
        key = self.getApiKey()
        if not key:
            logger.error(f"❌ No API key found for {self.queue_type} queue")
            return None
            
        bucket = self._nowBucket()
        if redis_conn.get(self._cooldownKey(key)):
            logger.warning(f"🔑 Key in cooldown for {self.queue_type} queue")
            return None
            
        bucket_key = self._counterBucketKey(key, bucket)
        count = redis_conn.incr(bucket_key)
        redis_conn.expire(bucket_key, WINDOW_SECONDS + 5)
        
        if int(count) <= PER_KEY_LIMIT:
            logger.info(f"✅ Using key for {self.queue_type} queue (count: {count})")
            return key
        else:
            redis_conn.set(self._cooldownKey(key), "1", ex=COOLDOWN_SECONDS)
            logger.warning(f"🔑 Rate limit exceeded for {self.queue_type} queue, cooling down")
            return None
    
    def markKeyCooldown(self, key):
        redis_conn.set(self._cooldownKey(key), "1", ex=COOLDOWN_SECONDS)

# Global API managers
extractionApiManager = QueueAwareAPIManager('extraction')
formattingApiManager = QueueAwareAPIManager('formatting')
fallbackApiManager = QueueAwareAPIManager('fallback')

def getApiManager(job_type):
    """Get the appropriate API manager for job type"""
    if job_type == 'extract':
        return extractionApiManager
    elif job_type == 'format':
        return formattingApiManager
    else:
        return fallbackApiManager

# ---------- Enhanced Gemini Caller with Queue Awareness ----------
def callGeminiSafe(parts, job_type, max_retries=5, base_delay=1.0):
    """Enhanced caller with queue-specific API management"""
    api_manager = getApiManager(job_type)
    attempt = 0
    
    while attempt < max_retries:
        attempt += 1
        logger.info(f"🔄 Attempt {attempt}/{max_retries} for {job_type}")
        
        if not api_manager.acquireSlot(timeout=10):
            logger.warning(f"⏳ No semaphore slot available for {job_type}, retrying...")
            time.sleep(0.5 + random.random())
            continue
            
        try:
            key = api_manager.tryAcquireKey()
            if not key:
                api_manager.releaseSlot()
                logger.warning(f"🔑 No available key for {job_type}, retrying...")
                time.sleep(0.5 + random.random())
                continue
                
            try:
                logger.info(f"🔑 Using API key for {job_type} request")
                client = genai.Client(api_key=key)
                response = client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=[types.Content(parts=parts)]
                )
                text = getattr(response, "text", None) or getattr(response, "output_text", None) or None
                if text:
                    logger.info(f"✅ {job_type} API call successful, got {len(text)} chars")
                    return text
                else:
                    logger.error("❌ Empty response from model")
                    raise RuntimeError("Empty response from model")
                    
            except Exception as exc:
                err = str(exc).lower()
                logger.error(f"❌ API call error: {exc}")
                if "rate limit" in err or "quota" in err or "429" in err:
                    logger.warning(f"🔑 Key rate limited in {job_type} queue")
                    api_manager.markKeyCooldown(key)
                elif "api key" in err or "401" in err or "403" in err:
                    logger.error(f"🔑 Invalid API key for {job_type} queue")
                    api_manager.markKeyCooldown(key)
                elif "not found" in err or "404" in err:
                    logger.error(f"🔑 Model {GEMINI_MODEL} not found, trying gemini-1.5-flash")
                    # Try fallback model
                    try:
                        client = genai.Client(api_key=key)
                        response = client.models.generate_content(
                            model="gemini-1.5-flash",
                            contents=[types.Content(parts=parts)]
                        )
                        text = getattr(response, "text", None)
                        if text:
                            logger.info("✅ Fallback to gemini-1.5-flash successful")
                            return text
                    except:
                        pass
                wait = min(30, base_delay * (2 ** (attempt - 1))) + random.random()
                logger.info(f"⏳ Waiting {wait:.1f}s before retry...")
                time.sleep(wait)
                continue
                
            finally:
                api_manager.releaseSlot()
                
        except Exception as e:
            logger.error(f"❌ Error in API call setup: {e}")
            pass 
            
    logger.error(f"💥 All {max_retries} attempts failed for {job_type}")
    return None

# ---------- Utility helpers ----------
def b64ToBytes(b64_string):
    return base64.b64decode(b64_string)

def resizeImageBytes(image_bytes, max_dim=1024, quality=85):
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
        logger.error(f"❌ Image resize failed: {e}")
        return image_bytes

def renderPdfToImages(pdf_bytes, dpi=200):
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
        logger.error(f"❌ PDF rendering failed: {e}")
        return []
    return images

# ---------- Pub/Sub Notification Function ----------
def notifyJobCompletion(job_id, job_type, user_id, file_name, success=True, result=None):
    """Notify FastAPI server that a job has completed by pushing to Redis Pub/Sub."""
    try:
        # FIXED: Use the same Redis connection parameters
        pub_redis = Redis.from_url(REDIS_URL, decode_responses=True)
        
        message = {
            'job_id': job_id,
            'job_type': job_type,
            'user_id': user_id,
            'file_name': file_name,
            'success': success,
            'result': result,
            'timestamp': time.time()
        }
        
        pub_redis.publish('job_completions', json.dumps(message))
        logger.info(f"📢 Published {job_type} completion: {job_id} for {file_name}, success: {success}")
        
    except Exception as e:
        logger.error(f"❌ Failed to publish job completion: {e}")

# ---------- Extraction/Format/Summarize Functions ----------
def extractTextFromImageBytes(image_bytes):
    logger.info(f"🔍 Extracting text from image ({len(image_bytes)} bytes)")
    
    if len(image_bytes) > (5 * 1024 * 1024):
        logger.info("🖼️ Resizing large image...")
        image_bytes = resizeImageBytes(image_bytes, max_dim=1200)
    
    blob_b64 = base64.b64encode(image_bytes).decode("utf-8")
    logger.info(f"🖼️ Image encoded to base64 ({len(blob_b64)} chars)")
    
    parts = [
        types.Part(text=get_prompt("extraction")),
        types.Part(inline_data=types.Blob(mime_type="image/jpeg", data=blob_b64))
    ]
    
    logger.info("📤 Sending to Gemini API...")
    txt = callGeminiSafe(parts, 'extract', max_retries=6)
    
    if txt is None:
        logger.error("❌ Extraction failed - no response from API")
        return "[UNREADABLE OR API FAILURE]"
    elif txt.startswith("[UNREADABLE") or len(txt.strip()) < 10:
        logger.warning(f"⚠️ Extraction may have failed: {txt[:100]}...")
        return txt
    else:
        logger.info(f"✅ Extraction successful: {len(txt)} characters")
        return txt

def formatDocument(raw_text):
    logger.info(f"📝 Formatting document ({len(raw_text)} chars)")
    parts = [types.Part(text=get_prompt("formatting") + "\n\n" + raw_text)]
    return callGeminiSafe(parts, 'format', max_retries=4)

def summarizeDocument(raw_text):
    logger.info(f"📋 Summarizing document ({len(raw_text)} chars)")
    parts = [types.Part(text=get_prompt("summarization") + "\n\n" + raw_text)]
    return callGeminiSafe(parts, 'format', max_retries=4)

# ---------- RQ JOB ROUTER ----------
def processJob(job_type, payload, metadata=None):
    """Main job processing function called by RQ worker"""
    if metadata is None:
        metadata = {}
    
    # FIX: Get job ID properly
    job = get_current_job()
    if job:
        job_id = job.id
        logger.info(f"🔧 Starting {job_type} job {job_id}")
    else:
        job_id = "UNKNOWN_JOB"
        logger.warning(f"⚠️ Starting {job_type} job with unknown ID")
    
    final_result = None
    success = False
    user_id = metadata.get('user_id', 'unknown')
    file_name = metadata.get('file_name', 'unknown')
    metadata_job_type = metadata.get('job_type', job_type)

    try:
        logger.info(f"🚀 Processing {file_name} (user: {user_id})")
        
        if job_type == 'extract':
            files_serialized = payload
            if not files_serialized:
                final_result = "ERROR: No file data provided"
                success = False
                logger.error("❌ No files provided in payload")
            else:
                f = files_serialized[0]
                
                mime = f.get("mime_type", "image/png")
                data_b64 = f.get("data_b64")
                
                if not data_b64:
                    final_result = f"ERROR: No data for {file_name}"
                    success = False
                    logger.error(f"❌ No base64 data for {file_name}")
                else:
                    logger.info(f"📄 Processing {mime} file: {file_name}")
                    raw_bytes = b64ToBytes(data_b64)
                    overall_text = ""

                    if mime == "application/pdf" or file_name.lower().endswith(".pdf"):
                        logger.info(f"📄 Processing PDF: {file_name}")
                        pages = renderPdfToImages(raw_bytes, dpi=200)
                        if not pages:
                            overall_text = f"--- {file_name} | PDF FAILURE: NO PAGES EXTRACTED ---\n\n"
                            success = False
                            logger.error(f"❌ Failed to render PDF: {file_name}")
                        else:
                            logger.info(f"📄 PDF has {len(pages)} pages")
                            for page_bytes, pno in pages:
                                logger.info(f"🔍 Extracting text from page {pno}")
                                txt = extractTextFromImageBytes(page_bytes)
                                overall_text += f"--- {file_name} | page {pno} ---\n{txt}\n\n"
                                time.sleep(random.uniform(0.8, 1.5))
                            success = True
                            logger.info(f"✅ PDF extraction completed: {file_name}")
                    else:
                        logger.info(f"🖼️ Processing image: {file_name}")
                        txt = extractTextFromImageBytes(raw_bytes)
                        overall_text = f"--- {file_name} ---\n{txt}\n\n"
                        time.sleep(random.uniform(0.8, 1.5))
                        
                        # FIX: Better success detection
                        if txt and not txt.startswith("[UNREADABLE") and len(txt.strip()) > 10:
                            success = True
                            logger.info(f"✅ Image extraction successful: {file_name}")
                        else:
                            success = False
                            logger.warning(f"⚠️ Image extraction may have failed: {file_name}")
                    
                    final_result = overall_text
        
        elif job_type == 'format':
            logger.info(f"📝 Formatting document: {file_name}")
            raw_text = payload
            formatted = formatDocument(raw_text) or raw_text
            summary = summarizeDocument(raw_text) or ""
            
            final_result = json.dumps({
                "formatted_text": formatted,
                "summary_text": summary
            })
            success = True
        
        else:
            final_result = json.dumps({"error": "unknown_job_type"})
            success = False

    except Exception as e:
        logger.error(f"❌ Job {job_id} failed: {e}")
        import traceback
        logger.error(f"❌ Traceback: {traceback.format_exc()}")
        final_result = f"FATAL_WORKER_ERROR: {str(e)}"
        success = False
    
    finally:
        # Enhanced monitoring
        try:
            queue_stats = getQueueStats()
            logger.info(f"📊 Queue Stats: {queue_stats}")
        except Exception as e:
            logger.error(f"❌ Failed to get queue stats: {e}")
        
        # FIXED: Use metadata job_type and ensure success is properly set
        logger.info(f"📤 Notifying completion: job_id={job_id}, success={success}")
        notifyJobCompletion(job_id, metadata_job_type, user_id, file_name, success, final_result)
        logger.info(f"✅ Finished {job_type} job {job_id}. Success: {success}")
        
        return final_result

# For testing
if __name__ == "__main__":
    print("🧪 Testing worker functions...")
    
    test_metadata = {
        "user_id": "test_user",
        "job_type": "extract", 
        "file_name": "test.pdf"
    }
    
    try:
        result = processJob('extract', [], metadata=test_metadata)
        print(f"Test result: {result}")
    except Exception as e:
        print(f"Test failed: {e}")