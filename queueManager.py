# queueManager.py - Enhanced queue system with round-robin
import os
import redis
from rq import Queue
from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# FIXED: Create Redis connection with proper error handling
try:
    redis_conn = redis.from_url(REDIS_URL, decode_responses=False)
    redis_conn.ping()
    print("✅ Redis connection successful!")
except Exception as e:
    print(f"❌ Redis connection failed: {e}")
    # Fallback to local Redis
    REDIS_URL = "redis://localhost:6379"
    redis_conn = redis.from_url(REDIS_URL, decode_responses=False)

# Create separate queues
extractionQueue = Queue('extraction', connection=redis_conn)
formattingQueue = Queue('formatting', connection=redis_conn)
fallbackQueue = Queue('fallback', connection=redis_conn)

# API Key pools for round-robin
EXTRACTION_KEYS = [
    os.getenv("GEMINI_API_KEY_1"),
    os.getenv("GEMINI_API_KEY_2"), 
    os.getenv("GEMINI_API_KEY_3"),
    os.getenv("GEMINI_API_KEY_4")
]

FORMATTING_KEYS = [
    os.getenv("GEMINI_API_KEY_5"),
    os.getenv("GEMINI_API_KEY_6")
]

FALLBACK_KEY = os.getenv("GEMINI_API_KEY_7")

# Validate keys
print(f"🔑 Extraction keys: {len([k for k in EXTRACTION_KEYS if k])} valid")
print(f"🔑 Formatting keys: {len([k for k in FORMATTING_KEYS if k])} valid")
print(f"🔑 Fallback key: {'VALID' if FALLBACK_KEY else 'MISSING'}")

# Round-robin counters
extractionKeyIndex = 0
formattingKeyIndex = 0

def getNextExtractionKey():
    """Round-robin for extraction keys"""
    global extractionKeyIndex
    valid_keys = [k for k in EXTRACTION_KEYS if k]
    if not valid_keys:
        print("❌ No valid extraction keys available!")
        return None
    key = valid_keys[extractionKeyIndex % len(valid_keys)]
    extractionKeyIndex = (extractionKeyIndex + 1) % len(valid_keys)
    return key

def getNextFormattingKey():
    """Round-robin for formatting keys"""
    global formattingKeyIndex
    valid_keys = [k for k in FORMATTING_KEYS if k]
    if not valid_keys:
        print("❌ No valid formatting keys available!")
        return None
    key = valid_keys[formattingKeyIndex % len(valid_keys)]
    formattingKeyIndex = (formattingKeyIndex + 1) % len(valid_keys)
    return key

def getFallbackKey():
    """Get fallback key"""
    return FALLBACK_KEY

def getQueueStats():
    """Get queue lengths for monitoring"""
    try:
        return {
            'extraction': extractionQueue.count,
            'formatting': formattingQueue.count,
            'fallback': fallbackQueue.count,
            'total': extractionQueue.count + formattingQueue.count + fallbackQueue.count
        }
    except Exception as e:
        print(f"❌ Error getting queue stats: {e}")
        return {
            'extraction': 0,
            'formatting': 0, 
            'fallback': 0,
            'total': 0
        }