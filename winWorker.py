# winworker.py - UPDATED FOR NEW FUNCTION SIGNATURE

import os
import sys
import redis
from rq import Queue, get_current_job
from rq.worker import SimpleWorker
from rq.job import Job
import time
from dotenv import load_dotenv
from datetime import datetime, UTC
import logging
logging.basicConfig(level=logging.INFO)

load_dotenv()

# === CONFIG ===
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
QUEUE_NAME = "document_processing"

# Add current directory for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

print(f"🔗 Connecting to Redis: {REDIS_URL}")

try:
    redis_conn = redis.from_url(REDIS_URL, decode_responses=False)
    redis_conn.ping()
    print("✅ Redis connection successful!")
except Exception as e:
    print(f"❌ Redis connection failed: {e}")
    exit(1)

# === Import your job function ===
try:
    from worker import process_job
    print("✅ Worker function 'process_job' imported successfully.")
except Exception as e:
    print(f"❌ Failed to import process_job: {e}")
    exit(1)

# === Create Queue ===
queue = Queue(QUEUE_NAME, connection=redis_conn)

# === Custom SimpleWorker that NEVER forks ===
class NoForkWorker(SimpleWorker):
    def execute_job(self, job, queue):
        """Override to run job in the same process"""
        print(f"🔧 Executing job {job.id} in main process (no fork)...")
        
        now = datetime.now(UTC) 
        job.started_at = now
        job.set_status('started')
        job.save()

        try:
            # FIXED: Use correct parameter order - RQ automatically passes job as self
            # The function signature should be: process_job(job_type, payload, metadata=None)
            result = process_job(*job.args, **job.kwargs)
            
            job._result = result
            job.set_status('finished')
            print(f"✅ Job {job.id} completed successfully")
        except Exception as e:
            import traceback
            job._exc_info = traceback.format_exc()
            job.set_status('failed')
            print(f"❌ Job {job.id} failed: {e}")
            raise
        finally:
            job.ended_at = datetime.now(UTC)
            job.save()

        return result

# === Main Worker Loop ===
if __name__ == '__main__':
    print("🚀 Starting Windows-compatible RQ worker (no fork)...")
    print("Press Ctrl+C to stop")

    worker = NoForkWorker([queue], connection=redis_conn)

    try:
        worker.work(burst=False)  # burst=False = continuous
    except KeyboardInterrupt:
        print("\n🛑 Worker stopped by user.")
    except Exception as e:
        print(f"💥 Worker crashed: {e}")