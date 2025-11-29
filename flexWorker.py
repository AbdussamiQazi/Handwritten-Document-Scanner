# flexWorker.py - Flexible worker for all queues (WINDOWS COMPATIBLE)
import os
import sys
import redis
from rq import Queue, Worker
from rq.worker import SimpleWorker
from datetime import datetime, UTC
import logging

logging.basicConfig(level=logging.INFO)

# Add current directory for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from queueManager import extractionQueue, formattingQueue, fallbackQueue

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

print(f"🔗 Connecting to Redis: {REDIS_URL}")

try:
    redis_conn = redis.from_url(REDIS_URL, decode_responses=False)
    redis_conn.ping()
    print("✅ Redis connection successful!")
except Exception as e:
    print(f"❌ Redis connection failed: {e}")
    exit(1)

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
            # Use correct parameter order
            result = job.func(*job.args, **job.kwargs)
                    # ---- FIX: Inject job_id into metadata ----
            if "metadata" in job.kwargs:
                meta = job.kwargs["metadata"]
                meta["job_id"] = job.id
                job.kwargs["metadata"] = meta
        # -------------------------------------------

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
    print("🚀 Starting Flexible Worker (all queues - Windows compatible)...")
    print("Press Ctrl+C to stop")

    worker = NoForkWorker([extractionQueue, formattingQueue, fallbackQueue], connection=redis_conn)

    try:
        worker.work(burst=False)  # burst=False = continuous
    except KeyboardInterrupt:
        print("\n🛑 Worker stopped by user.")
    except Exception as e:
        print(f"💥 Worker crashed: {e}")