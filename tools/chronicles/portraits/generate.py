r"""Generate the portrait library on the HEARTH B70 image lane.

    python tools/chronicles/portraits/generate.py [--only p07,p23] [--reseed p07,p23] [--dry-run]
        [--raw E:\omen\chronicles-portraits\raw] [--jobs E:\omen\chronicles-portraits\jobs.json]

Drives the gateway through hearth.callers.client.HearthClient (HEARTH_ROOT, default
C:\work\commandcenter; key from HEARTH_KEY, default dev-local -- never commit a key).
The art session is the operator's to start and stop (start_image_session /
stop_image_session); this script only refuses to submit while the session is not
active. Every tile is submitted with an idempotency key of its id + seed, so a rerun
never produces a duplicate job. Raw renders are copied to <raw>/<id>.<seed>.png.
"""
from __future__ import annotations
import argparse, asyncio, hashlib, json, os, shutil, sys, time
from pathlib import Path

sys.path.insert(0, os.environ.get("HEARTH_ROOT", r"C:\work\commandcenter"))
sys.path.insert(0, str(Path(__file__).parent))
from hearth.callers.client import HearthClient  # noqa: E402
from prompts import tiles  # noqa: E402

def unwrap(res: dict) -> dict:
    """HearthClient flattens a tool result to {ok, text, structured}; the tool's own JSON
    is in `structured` (structuredContent) or, failing that, in `text`."""
    if isinstance(res, dict) and "text" in res and ("structured" in res or "ok" in res) and not res.get("job_id") and not res.get("session"):
        if isinstance(res.get("structured"), dict) and res["structured"]:
            return res["structured"]
        txt = res.get("text") or ""
        try:
            return json.loads(txt)
        except Exception:
            return res
    return res


async def call(client: HearthClient, tool: str, **args):
    return unwrap(await client.call(tool, **args))


TERMINAL = {"succeeded", "failed", "cancelled", "canceled", "timeout", "error", "rejected"}
RESEED_STEP = 1_000_000


def find_outputs(obj) -> list[str]:
    """Any 'outputs': [{'path': ...}] list anywhere in a status/receipt document."""
    found = []
    if isinstance(obj, dict):
        outs = obj.get("outputs")
        if isinstance(outs, list):
            for o in outs:
                p = o.get("path") if isinstance(o, dict) else None
                if p: found.append(p)
        for v in obj.values():
            found += find_outputs(v)
    elif isinstance(obj, list):
        for v in obj: found += find_outputs(v)
    return found


def find_artifacts(obj) -> list[dict]:
    found = []
    if isinstance(obj, dict):
        arts = obj.get("artifacts")
        if isinstance(arts, list):
            found += [x for x in arts if isinstance(x, dict) and x.get("artifact_id")]
        art = obj.get("artifact")
        if isinstance(art, dict) and art.get("artifact_id"):
            found.append(art)
        for v in obj.values():
            found += find_artifacts(v)
    elif isinstance(obj, list):
        for v in obj: found += find_artifacts(v)
    return found


async def resolve_output(client: HearthClient, status: dict) -> str | None:
    paths = find_outputs(status)
    if paths: return paths[0]
    for art in find_artifacts(status):
        if art.get("role") not in (None, "result"): continue
        try:
            got = await call(client, "get_execution_artifact", artifact_id=art["artifact_id"])
        except Exception:
            continue
        text = got.get("text") or got.get("content") or ""
        try:
            doc = json.loads(text) if isinstance(text, str) else text
        except Exception:
            continue
        paths = find_outputs(doc)
        if paths: return paths[0]
    return None


async def main_async(a) -> int:
    raw: Path = a.raw; raw.mkdir(parents=True, exist_ok=True)
    jobs = json.loads(a.jobs.read_text(encoding="utf-8")) if a.jobs.exists() else {}
    only = {x.strip() for x in a.only.split(",") if x.strip()}
    reseed = {x.strip() for x in a.reseed.split(",") if x.strip()}
    todo = []
    for t in tiles():
        if only and t["id"] not in only: continue
        attempt = jobs.get(t["id"], {}).get("attempt", 1)
        seed = t["seed"]
        if t["id"] in reseed:
            attempt = attempt + 1; seed = t["seed"] + (attempt - 1) * RESEED_STEP
        elif (raw / f"{t['id']}.{seed}.png").exists() and t["id"] not in only:
            continue  # already rendered
        todo.append({**t, "seed": seed, "attempt": attempt})
    if a.resolve:
        key = os.environ.get("HEARTH_KEY", "dev-local")
        async with HearthClient(key=key, task_id=os.environ.get("HEARTH_TASK_ID")) as client:
            for tid, j in jobs.items():
                if j.get("raw") or not j.get("job_id"): continue
                st = await call(client, "get_image_status", job_id=j["job_id"])
                if str(st.get("status")).lower() != "succeeded": print("not succeeded", tid, st.get("status")); continue
                src = await resolve_output(client, st)
                if src and Path(src).exists():
                    dst = raw / f"{tid}.{j['seed']}.png"; shutil.copyfile(src, dst)
                    j["raw"] = str(dst); j["sha256"] = hashlib.sha256(dst.read_bytes()).hexdigest(); j.pop("error", None)
                    print("resolved", tid, dst.name)
                else: print("still no output", tid)
            a.jobs.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
        return 0
    print(f"{len(todo)} tile(s) to render")
    if a.dry_run:
        for t in todo: print(t["id"], t["seed"], t["prompt"][:90] + "...")
        return 0
    key = os.environ.get("HEARTH_KEY", "dev-local")
    async with HearthClient(key=key, task_id=os.environ.get("HEARTH_TASK_ID")) as client:
        sess = await call(client, "get_image_session")
        state = (sess.get("session") or {}).get("state")
        if state != "imagegen":
            print(f"art session is '{state}', not 'imagegen' -- start it first"); return 2
        # submit everything; the pool queues across both lanes
        for t in todo:
            res = await call(client, "submit_image", workflow_id="z-image-turbo",
                parameters={"prompt": t["prompt"], "width": 1024, "height": 1024, "seed": t["seed"], "steps": 8},
                strategy="single", target_lane="any", priority="normal",
                idempotency_key=f"chronicles-portraits-v1-{t['id']}-{t['seed']}")
            if not res.get("ok") or not res.get("job_id"):
                print("submit failed", t["id"], res); continue
            jobs[t["id"]] = {"job_id": res["job_id"], "seed": t["seed"], "attempt": t["attempt"], "status": res.get("status")}
            print("queued", t["id"], res["job_id"])
        a.jobs.parent.mkdir(parents=True, exist_ok=True)
        a.jobs.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
        pending = {t["id"] for t in todo if t["id"] in jobs and jobs[t["id"]].get("job_id")}
        started = time.time()
        while pending and time.time() - started < a.timeout_s:
            for tid in sorted(pending):
                j = jobs[tid]
                st = await call(client, "get_image_status", job_id=j["job_id"])
                status = str(st.get("status") or (st.get("job") or {}).get("status") or "").lower()
                j["status"] = status
                if status in TERMINAL:
                    pending.discard(tid)
                    if status == "succeeded":
                        src = await resolve_output(client, st)
                        for _ in range(6):  # the receipt artifact lands a beat after the status flips
                            if src: break
                            await asyncio.sleep(2)
                            st = await call(client, "get_image_status", job_id=j["job_id"])
                            src = await resolve_output(client, st)
                        if src and Path(src).exists():
                            dst = raw / f"{tid}.{j['seed']}.png"
                            shutil.copyfile(src, dst)
                            j["raw"] = str(dst); j["sha256"] = hashlib.sha256(dst.read_bytes()).hexdigest()
                            print("done", tid, dst.name)
                        else:
                            j["error"] = f"no output path in status ({src})"; print("no output", tid, json.dumps(st)[:300])
                    else:
                        j["error"] = st.get("error") or st.get("detail") or status
                        print("failed", tid, j["error"])
                    a.jobs.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
            if pending: await asyncio.sleep(a.poll_s)
        if pending: print("timed out waiting for", sorted(pending)); return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=""); ap.add_argument("--reseed", default="")
    ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--resolve", action="store_true")
    ap.add_argument("--raw", type=Path, default=Path(r"E:\omen\chronicles-portraits\raw"))
    ap.add_argument("--jobs", type=Path, default=Path(r"E:\omen\chronicles-portraits\jobs.json"))
    ap.add_argument("--poll-s", type=float, default=4.0); ap.add_argument("--timeout-s", type=float, default=1800)
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
